"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { PairingCoordinator } = require("../lib/pairing-coordinator");
const {
  deriveProfileIdentityHash,
  hashConfigBlob,
} = require("../lib/profile-provisioner");
const { EnvelopeCrypto } = require("../lib/storage/envelope-crypto");
const { TokenService } = require("../lib/storage/token-service");
const {
  RedisLeaseRepository,
  RedisKeyspace,
  RedisManagementSessionRepository,
  RedisOAuthStateRepository,
  RedisPairingRepository,
  RedisPlaybackContextRepository,
  RedisRateLimitRepository,
  RedisSubtitleDeliveryRepository,
  createRedisTtlRepositories,
} = require("../lib/storage/redis");
const {
  materializeResponse,
  parseMetadata,
} = require("../lib/storage/redis/playback-context-repository");
const { fingerprintExactUrl, hashOpaqueValue } = require("../lib/source-context");
const { assertRepository } = require("../lib/storage/contracts");
const { stableScope } = require("../lib/storage/repository-utils");

const PROFILE = "profile_redis_0001";
const DEVICE = "device_redis_0001";
const PLAYBACK_CLAIM_CLEANUP_OWNER = Symbol.for(
  "jumpgate.playbackClaimCleanupOwner"
);
const ACTIVATION_RETRY_TOKEN = Buffer.alloc(32, 0x71).toString("base64url");
const ACTIVATION_RETRY_EXPIRES_AT = "601000";
const PARENT_V3_CONTEXT_FIELDS = Object.freeze([
  "createdAtMs",
  "envelope",
  "equivalenceHash",
  "expiresAtMs",
  "fingerprintHashes",
  "fingerprintIndexKeys",
  "generation",
  "globalMember",
  "ref",
  "revision",
  "tombstoneMembers",
  "v",
]);

class FakeScripts {
  constructor(now = 1000) {
    this.now = now;
    this.calls = [];
    this.timeCalls = 0;
    this.timeSignals = [];
    this.queues = new Map();
    this.generations = new Map();
  }

  enqueue(name, reply) {
    const queue = this.queues.get(name) || [];
    queue.push(reply);
    this.queues.set(name, queue);
  }

  async run(name, keys = [], args = [], options = {}) {
    const call = { name, keys: keys.slice(), args: args.slice() };
    if (options.signal !== undefined) call.signal = options.signal;
    this.calls.push(call);
    const queue = this.queues.get(name) || [];
    if (name === "playbackGetOrInitializeGeneration" && queue.length === 0) {
      if (!this.generations.has(keys[0])) this.generations.set(keys[0], args[0]);
      return ["generation", this.generations.get(keys[0])];
    }
    if (name === "playbackAttemptBegin" && queue.length === 0) return ["begun"];
    if (name === "playbackAttemptAbandon" && queue.length === 0) return ["not_found"];
    if (name === "playbackAttemptDisclose" && queue.length === 0) return ["disclosed"];
    if (name === "playbackAttemptReconcile" && queue.length === 0) {
      return ["reconciled", "0", "0", "0"];
    }
    assert.ok(queue.length > 0, "unexpected script call: " + name);
    const reply = queue.shift();
    const resolved = typeof reply === "function" ? reply(call) : reply;
    if (
      name === "playbackRecord" &&
      keys.length >= 16 &&
      [
        "invalidated",
        "snapshot_begun",
        "snapshot_completed",
        "snapshot_released",
        "snapshot_recovery_completed",
        "snapshot_state",
      ].includes(resolved[0]) &&
      typeof resolved[1] === "string"
    ) {
      this.generations.set(keys[15], resolved[1]);
    }
    return resolved;
  }

  async timeMs(options = {}) {
    this.timeCalls += 1;
    if (options.signal !== undefined) this.timeSignals.push(options.signal);
    return this.now;
  }
}

function playbackRequestDigest(request) {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

function playbackClaimOptions(sessionId, request, overrides = {}) {
  return { sessionId, requestDigest: playbackRequestDigest(request), ...overrides };
}

function tokenService(onIssue) {
  let sequence = 0;
  const service = new TokenService({
    pepper: Buffer.alloc(32, 0x5a),
    randomBytes: (length) => {
      sequence += 1;
      return Buffer.alloc(length, sequence & 0xff);
    },
  });
  if (onIssue) {
    const issue = service.issue.bind(service);
    service.issue = (purpose, ...args) => {
      onIssue(purpose);
      return issue(purpose, ...args);
    };
  }
  return service;
}

function envelopeCrypto() {
  return new EnvelopeCrypto({
    keys: { k1: Buffer.alloc(32, 0x6b) },
    primaryKeyId: "k1",
    randomBytes: (length) => Buffer.alloc(length, 0x11),
  });
}

function fakeClient(indexValue = null) {
  return {
    async get() {
      return indexValue;
    },
    async eval() {
      throw new Error("direct eval should be replaced by FakeScripts");
    },
  };
}

test("abortable playback claims destroy an isolated Redis socket only", async () => {
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const controller = new AbortController();
  let duplicates = 0;
  let isolatedDestroys = 0;
  let sharedDestroys = 0;
  const isolated = {
    isOpen: false,
    async connect() {
      this.isOpen = true;
    },
    destroy() {
      isolatedDestroys += 1;
      this.isOpen = false;
    },
    async quit() {
      this.isOpen = false;
    },
    async eval() {},
  };
  const client = {
    duplicate() {
      duplicates += 1;
      return isolated;
    },
    destroy() {
      sharedDestroys += 1;
    },
    async eval() {},
  };
  const scripts = new FakeScripts(1000);
  scripts.enqueue("playbackClaimV6", async (call) => {
    assert.equal(call.args[5], "session_isolated_deadline_0001");
    assert.equal(call.args[20], "5");
    assert.equal(call.args[25], playbackRequestDigest(request));
    assert.equal(call.args[26], request.attemptId);
    markEntered();
    await new Promise((_resolve, reject) => {
      if (call.signal) {
        call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true });
      }
    });
  });
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client,
    isolatedScriptRunnerFactory: () => scripts,
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    sourceContextOptions: {
      idFactory: (kind) => kind + "_isolated_deadline_0001",
    },
  });
  const request = {
    attemptId: randomUUID(),
    fingerprints: [fingerprintExactUrl("https://media.example/isolated-deadline.mkv")],
    intentUrlHash: hashOpaqueValue("https://media.example/isolated-deadline.mkv"),
    launchedAt: 1000,
  };
  const pending = repository.claim(
    PROFILE,
    DEVICE,
    request,
    playbackClaimOptions("session_isolated_deadline_0001", request, {
      generation: "g1:isolated_deadline",
      deviceGeneration: 1,
      signal: controller.signal,
    })
  );
  await entered;
  controller.abort();

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(duplicates, 1);
  assert.equal(isolatedDestroys, 1);
  assert.equal(sharedDestroys, 0);
});

test("abortable playback claims propagate durable cleanup failures", async () => {
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const controller = new AbortController();
  const isolated = {
    isOpen: false,
    async connect() {
      this.isOpen = true;
    },
    destroy() {
      this.isOpen = false;
    },
    async quit() {
      this.isOpen = false;
    },
    async eval() {},
  };
  const client = {
    duplicate() {
      return isolated;
    },
    async eval() {},
  };
  const isolatedScripts = new FakeScripts(1000);
  isolatedScripts.enqueue("playbackClaimV6", async () => {
    markEntered();
    await new Promise(() => {});
  });
  const cleanupFailure = new Error("injected attempt abandonment failure");
  const sharedScripts = new FakeScripts(1000);
  sharedScripts.enqueue("playbackAttemptAbandon", () => {
    throw cleanupFailure;
  });
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client,
    isolatedScriptRunnerFactory: () => isolatedScripts,
    scriptRunner: sharedScripts,
    envelopeCrypto: envelopeCrypto(),
  });
  const request = {
    attemptId: randomUUID(),
    fingerprints: [fingerprintExactUrl("https://media.example/cleanup-failure.mkv")],
    intentUrlHash: hashOpaqueValue("https://media.example/cleanup-failure.mkv"),
    launchedAt: 1000,
  };
  const pending = repository.claim(
    PROFILE,
    DEVICE,
    request,
    playbackClaimOptions("session_cleanup_failure_0001", request, {
      generation: "g1:cleanup_failure",
      deviceGeneration: 1,
      signal: controller.signal,
    })
  );
  await entered;
  controller.abort();

  await assert.rejects(
    pending,
    (error) =>
      error instanceof AggregateError &&
      error.code === "claim_cleanup_failed" &&
      error.errors.length === 2 &&
      error.errors[0].name === "AbortError" &&
      error.errors[1] === cleanupFailure
  );
  assert.equal(
    sharedScripts.calls.filter((call) => call.name === "playbackAttemptAbandon").length,
    1
  );
});

test("playback claim authority is strict before any Redis evaluation", async () => {
  const scripts = new FakeScripts(1000);
  const repository = new RedisPlaybackContextRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
  });
  const request = {
    attemptId: randomUUID(),
    fingerprints: [fingerprintExactUrl("https://media.example/strict-authority.mkv")],
    intentUrlHash: hashOpaqueValue("https://media.example/strict-authority.mkv"),
    launchedAt: 1000,
  };

  for (const options of [
    {},
    { sessionId: "session_strict_authority_0001" },
    {
      sessionId: "session_strict_authority_0001",
      requestDigest: "A".repeat(64),
    },
    {
      ...playbackClaimOptions("session_strict_authority_0001", request),
      ipAddress: "127.0.0.1",
    },
    null,
  ]) {
    await assert.rejects(repository.claim(PROFILE, DEVICE, request, options), TypeError);
  }
  assert.equal(scripts.timeCalls, 0);
  assert.deepEqual(scripts.calls, []);
});

test("playback v5 response parsing rejects legacy and extended shapes", () => {
  const sessionId = "session_strict_v5_shape_0001";
  assert.deepEqual(
    materializeResponse(
      ["claimed", "not_found", sessionId],
      envelopeCrypto(),
      "unused",
      PROFILE,
      DEVICE,
      sessionId
    ),
    { status: "not_found", sessionId }
  );
  assert.throws(
    () => materializeResponse(
      ["claimed", "not_found", sessionId, "unexpected"],
      envelopeCrypto(),
      "unused",
      PROFILE,
      DEVICE,
      sessionId
    ),
    /Redis playback claim is invalid/
  );
  assert.throws(
    () => materializeResponse(
      ["claimed", "claimed", sessionId, "{}", "1000", "2000"],
      envelopeCrypto(),
      "unused",
      PROFILE,
      DEVICE,
      sessionId
    ),
    /Redis playback claim is invalid/
  );
});

test("playback fake binds exact retry races and rejects changed replay authority", async () => {
  const scripts = new FakeScripts(1000);
  const repository = new RedisPlaybackContextRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
  });
  const request = {
    attemptId: randomUUID(),
    fingerprints: [fingerprintExactUrl("https://media.example/replay-authority.mkv")],
    intentUrlHash: hashOpaqueValue("https://media.example/replay-authority.mkv"),
    launchedAt: 1000,
  };
  const authority = playbackClaimOptions("session_replay_authority_0001", request);
  scripts.enqueue("playbackClaimV6", ["claimed", "not_found", authority.sessionId]);
  scripts.enqueue("playbackClaimV6", ["claimed", "not_found", authority.sessionId]);

  const raced = await Promise.all([
    repository.claim(PROFILE, DEVICE, request, authority),
    repository.claim(PROFILE, DEVICE, request, authority),
  ]);
  assert.deepEqual(raced, [
    { status: "not_found", sessionId: authority.sessionId },
    { status: "not_found", sessionId: authority.sessionId },
  ]);
  for (const result of raced) {
    assert.equal(result[PLAYBACK_CLAIM_CLEANUP_OWNER], undefined);
    assert.deepEqual(Object.getOwnPropertySymbols(result), []);
  }

  const changedFingerprint = {
    ...request,
    fingerprints: [fingerprintExactUrl("https://media.example/replay-authority-other.mkv")],
  };
  const changedDigestAuthority = playbackClaimOptions(
    authority.sessionId,
    changedFingerprint
  );
  scripts.enqueue("playbackAttemptBegin", ["claim_request_conflict"]);
  await assert.rejects(
    repository.claim(PROFILE, DEVICE, changedFingerprint, changedDigestAuthority),
    (error) => error.code === "claim_request_conflict"
  );

  const changedSessionAuthority = {
    ...authority,
    sessionId: "session_replay_authority_0002",
  };
  scripts.enqueue("playbackAttemptBegin", ["claim_request_conflict"]);
  await assert.rejects(
    repository.claim(PROFILE, DEVICE, request, changedSessionAuthority),
    (error) => error.code === "claim_request_conflict"
  );

  const distinctRequest = { ...request, attemptId: randomUUID() };
  const distinctAuthority = playbackClaimOptions(
    "session_replay_authority_0003",
    distinctRequest
  );
  scripts.enqueue("playbackClaimV6", ["claimed", "not_found", distinctAuthority.sessionId]);
  assert.deepEqual(
    await repository.claim(PROFILE, DEVICE, distinctRequest, distinctAuthority),
    { status: "not_found", sessionId: distinctAuthority.sessionId }
  );

  const claimCalls = scripts.calls.filter((call) => call.name === "playbackClaimV6");
  assert.equal(claimCalls.length, 3);
  assert.equal(claimCalls[0].args[5], authority.sessionId);
  assert.equal(claimCalls[0].args[20], "5");
  assert.equal(claimCalls[0].args[25], authority.requestDigest);
  assert.equal(claimCalls[1].args[25], authority.requestDigest);
  assert.equal(claimCalls[0].args[26], request.attemptId);
  assert.equal(claimCalls[2].args[26], distinctRequest.attemptId);
  const beginCalls = scripts.calls.filter((call) => call.name === "playbackAttemptBegin");
  assert.equal(beginCalls.length, 5);
  assert.equal(beginCalls[0].args[4], authority.requestDigest);
  assert.equal(beginCalls[1].args[4], authority.requestDigest);
  assert.equal(beginCalls[2].args[4], changedDigestAuthority.requestDigest);
  assert.equal(beginCalls[2].args[5], authority.sessionId);
  assert.equal(beginCalls[3].args[4], authority.requestDigest);
  assert.equal(beginCalls[3].args[5], changedSessionAuthority.sessionId);
  assert.equal(beginCalls[0].args[14], request.attemptId);
  assert.equal(beginCalls[4].args[14], distinctRequest.attemptId);
  assert.equal(beginCalls[0].keys[0], beginCalls[1].keys[0]);
  assert.equal(beginCalls[0].keys[0], beginCalls[2].keys[0]);
  assert.equal(beginCalls[0].keys[0], beginCalls[3].keys[0]);
  assert.notEqual(beginCalls[0].keys[0], beginCalls[4].keys[0]);
  assert.equal(claimCalls[0].keys[20], beginCalls[0].keys[0]);
  assert.equal(claimCalls[2].keys[20], beginCalls[4].keys[0]);
});

test("playback fake preserves ownership in both abandon-disclose orderings", async () => {
  const scripts = new FakeScripts(1000);
  const repository = new RedisPlaybackContextRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
  });
  const sessionId = "session_settlement_order_0001";
  const abandonFirst = "cleanup_abandon_first_0001";
  const discloseSecond = "cleanup_disclose_second_0001";
  scripts.enqueue("playbackAttemptAbandon", ["retained"]);
  scripts.enqueue("playbackAttemptDisclose", ["disclosed"]);
  assert.equal(
    await repository.releaseOwned(PROFILE, DEVICE, sessionId, abandonFirst),
    false
  );
  assert.equal(
    await repository.commitClaimDisclosure(PROFILE, DEVICE, sessionId, discloseSecond),
    true
  );

  const discloseFirst = "cleanup_disclose_first_0001";
  const abandonSecond = "cleanup_abandon_second_0001";
  scripts.enqueue("playbackAttemptDisclose", ["disclosed"]);
  scripts.enqueue("playbackAttemptAbandon", ["retained"]);
  assert.equal(
    await repository.commitClaimDisclosure(PROFILE, DEVICE, sessionId, discloseFirst),
    true
  );
  assert.equal(
    await repository.releaseOwned(PROFILE, DEVICE, sessionId, abandonSecond),
    false
  );

  const settlements = scripts.calls.filter((call) =>
    call.name === "playbackAttemptAbandon" || call.name === "playbackAttemptDisclose"
  );
  assert.deepEqual(
    settlements.map((call) => call.name),
    [
      "playbackAttemptAbandon",
      "playbackAttemptDisclose",
      "playbackAttemptDisclose",
      "playbackAttemptAbandon",
    ]
  );
  for (const call of settlements) {
    assert.match(call.args[3], /^[a-f0-9]{64}$/);
    assert.equal(call.args.some((value) => value.startsWith("cleanup_")), false);
  }
  assert.equal(new Set(settlements.map((call) => call.args[3])).size, 4);
});

test("playback fake drains bounded attempt reconciliation", async () => {
  const scripts = new FakeScripts(1000);
  const repository = new RedisPlaybackContextRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    pruneBatchSize: 2,
  });
  scripts.enqueue("playbackAttemptReconcile", ["reconciled", "2", "1", "1"]);
  scripts.enqueue("playbackAttemptReconcile", ["reconciled", "1", "1", "0"]);

  assert.deepEqual(await repository.reconcileClaimAttempts(), {
    examined: 3,
    released: 2,
    hasMore: false,
  });
  const calls = scripts.calls.filter((call) => call.name === "playbackAttemptReconcile");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.args[0], "2");
    assert.equal(call.args[1], repository._keys.prefix + ":playback-claim-attempt-v2:");
  }
});

function assertHashedKeys(call) {
  assert.ok(call.keys.length > 0);
  for (const key of call.keys) assert.match(key, /^jg:v1:[a-z0-9-]+:[a-f0-9]{64}$/);
}

test("Redis pairing protocol gate fails closed for active legacy writers", async () => {
  const scripts = new FakeScripts();
  const repository = new RedisPairingRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });
  scripts.enqueue("pairingProtocolGate", ["legacy_active"]);
  await assert.rejects(
    repository.assertProtocol(),
    (error) => error.code === "pairing_mixed_version"
  );
  scripts.enqueue("pairingProtocolGate", ["state_collision"]);
  await assert.rejects(
    repository.assertProtocol(),
    (error) => error.code === "pairing_protocol_gate"
  );
});

test("pairing original-expiry failures survive recovery and the completion peek-commit race", async () => {
  const scripts = new FakeScripts();
  const tokens = tokenService();
  const envelopes = envelopeCrypto();
  const pairingId = "pairing_expiry_boundary_0001";
  const stableActivation = { installId: "install_expiry_boundary_0001" };
  const digest = tokens.hashOpaque(
    "pair-activation",
    JSON.stringify(stableActivation),
    64 * 1024
  );
  const activation = {
    ...stableActivation,
    deviceToken: tokens.issue("device", 32).token,
  };
  const serializedEnvelope = JSON.stringify(
    envelopes.encryptJson(
      activation,
      "pair-activation:" + stableScope("pairing", pairingId)
    )
  );
  const repository = new RedisPairingRepository({
    client: fakeClient(pairingId),
    scriptRunner: scripts,
    tokenService: tokens,
    envelopeCrypto: envelopes,
  });

  scripts.enqueue("pairingCompletePeek", ["expired"]);
  assert.deepEqual(
    await repository.completeActivation(pairingId, digest),
    { status: "expired" }
  );

  scripts.enqueue("pairingCompletePeek", [
    "ready",
    "activating",
    "2000",
    serializedEnvelope,
    digest,
    "",
    "2000",
  ]);
  scripts.enqueue("pairingComplete", ["expired"]);
  assert.deepEqual(
    await repository.completeActivation(pairingId, digest),
    { status: "expired" }
  );

  scripts.enqueue("pairingRecover", ["expired"]);
  assert.deepEqual(
    await repository.recoverActivation(ACTIVATION_RETRY_TOKEN, stableActivation),
    { status: "expired" }
  );

  scripts.enqueue("pairingActivate", ["expired"]);
  assert.deepEqual(
    await repository.activate("AAAA-AAAA", stableActivation, {
      activationRetryToken: ACTIVATION_RETRY_TOKEN,
    }),
    { status: "expired" }
  );
  assert.deepEqual(
    scripts.calls.map((call) => call.name),
    [
      "pairingCompletePeek",
      "pairingCompletePeek",
      "pairingComplete",
      "pairingRecover",
      "pairingActivate",
    ]
  );
});

test("pairing fake contract recovers server-managed token and profile finalization", async () => {
  const scripts = new FakeScripts();
  const client = fakeClient("pairing_redis_0001");
  const issuedPurposes = [];
  const tokens = tokenService((purpose) => issuedPurposes.push(purpose));
  const envelopes = envelopeCrypto();
  const repository = new RedisPairingRepository({
    client,
    scriptRunner: scripts,
    tokenService: tokens,
    envelopeCrypto: envelopes,
    idFactory: (kind) => (kind === "pairing" ? "pairing_redis_0001" : "device_redis_0001"),
    randomBytes: () => Buffer.alloc(8, 0),
    ttlMs: 1000,
    tombstoneTtlMs: 1000,
  });
  scripts.enqueue("pairingProtocolGate", ["ready"]);
  scripts.enqueue("pairingIssue", ["ok", "2000"]);
  const issued = await repository.issue({ deviceName: "Living room" });
  assert.equal(issued.userCode, "AAAA-AAAA");
  assert.equal(issued.expiresAt, 2000);

  const activation = {
    profileId: "profile_caller_ignored",
    installId: "install_redis_0001",
  };
  let storedEnvelope;
  let activationDigest;
  scripts.enqueue("pairingActivate", (call) => {
    storedEnvelope = call.args[1];
    activationDigest = call.args[2];
    return [
      "activating",
      "pairing_redis_0001",
      "device_redis_0001",
      activationDigest,
      "2000",
      storedEnvelope,
      ACTIVATION_RETRY_EXPIRES_AT,
    ];
  });
  const activating = await repository.activate(issued.userCode, activation, {
    activationRetryToken: ACTIVATION_RETRY_TOKEN,
  });
  assert.equal(activating.status, "activating");
  assert.equal(activating.activation.installId, activation.installId);
  assert.equal(Object.hasOwn(activating.activation, "profileId"), false);
  assert.match(activating.activation.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(issuedPurposes, ["pair-device", "device"]);

  scripts.enqueue("pairingActivate", [
    "activating",
    "pairing_redis_0001",
    "device_redis_0001",
    activationDigest,
    "2000",
    storedEnvelope,
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  const inProgressRetry = await repository.activate(
    issued.userCode,
    {
      ...activation,
      profileId: "profile_other_ignored",
      deviceToken: "caller-supplied-token-is-not-a-stable-field",
    },
    { activationRetryToken: ACTIVATION_RETRY_TOKEN }
  );
  assert.deepEqual(inProgressRetry, activating);

  const finalizationHash = tokens.hashOpaque("pair-profile", PROFILE, 128);
  let finalizedEnvelope;
  scripts.enqueue("pairingCompletePeek", [
    "ready",
    "activating",
    "2000",
    storedEnvelope,
    activationDigest,
    "",
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  scripts.enqueue("pairingComplete", (call) => {
    assert.equal(call.args[3], storedEnvelope);
    finalizedEnvelope = call.args[4];
    assert.equal(call.args[5], finalizationHash);
    return [
      "activated",
      "2000",
      finalizedEnvelope,
      activationDigest,
      ACTIVATION_RETRY_EXPIRES_AT,
    ];
  });
  const completed = await repository.completeActivation(
    activating.pairingId,
    activating.activationDigest,
    { profileId: PROFILE }
  );
  assert.equal(completed.status, "activated");
  assert.equal(completed.activation.profileId, PROFILE);
  assert.equal(completed.activation.deviceToken, activating.activation.deviceToken);

  scripts.enqueue("pairingCompletePeek", [
    "ready",
    "activated",
    "2000",
    finalizedEnvelope,
    activationDigest,
    finalizationHash,
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  scripts.enqueue("pairingComplete", [
    "activated",
    "2000",
    finalizedEnvelope,
    activationDigest,
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  const completedAgain = await repository.completeActivation(
    activating.pairingId,
    activating.activationDigest,
    { profileId: PROFILE }
  );
  assert.deepEqual(completedAgain.activation, completed.activation);

  scripts.enqueue("pairingCompletePeek", [
    "ready",
    "activated",
    "2000",
    finalizedEnvelope,
    activationDigest,
    finalizationHash,
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  await assert.rejects(
    () =>
      repository.completeActivation(activating.pairingId, activating.activationDigest, {
        profileId: "profile_redis_0002",
      }),
    (error) => error.code === "pairing_conflict"
  );

  scripts.enqueue("pairingActivate", [
    "activated",
    "pairing_redis_0001",
    "device_redis_0001",
    activationDigest,
    "2000",
    finalizedEnvelope,
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  const completedRetry = await repository.activate(
    issued.userCode,
    {
      ...activation,
      profileId: "profile_other_ignored",
    },
    { activationRetryToken: ACTIVATION_RETRY_TOKEN }
  );
  assert.equal(completedRetry.status, "activated");
  assert.equal(completedRetry.activation.deviceToken, activating.activation.deviceToken);
  assert.equal(completedRetry.activation.profileId, PROFILE);

  scripts.enqueue("pairingActivate", ["conflict"]);
  await assert.rejects(
    () =>
      repository.activate(
        issued.userCode,
        { ...activation, installId: "install_redis_0002" },
        { activationRetryToken: ACTIVATION_RETRY_TOKEN }
      ),
    (error) => error.code === "pairing_conflict"
  );

  scripts.enqueue("pairingRedeemPeek", [
    "ready",
    "pairing_redis_0001",
    "device_redis_0001",
    finalizedEnvelope,
    activationDigest,
    "2000",
  ]);
  scripts.enqueue("pairingRedeem", [
    "redeemed",
    "pairing_redis_0001",
    "device_redis_0001",
  ]);
  const firstRedemption = await repository.redeem(issued.deviceCode);
  assert.deepEqual(firstRedemption.activation, completedRetry.activation);
  scripts.enqueue("pairingRedeemPeek", [
    "replay",
    "pairing_redis_0001",
    "device_redis_0001",
    finalizedEnvelope,
    activationDigest,
    "2000",
  ]);
  assert.deepEqual(await repository.redeem(issued.deviceCode), firstRedemption);
  scripts.enqueue("pairingRedeemPeek", ["not_found"]);
  assert.equal((await repository.redeem(issued.deviceCode)).status, "not_found");
  scripts.enqueue("pairingCancel", ["cancelled"]);
  assert.equal(await repository.cancel(issued.deviceCode), true);

  for (const call of scripts.calls) {
    assertHashedKeys(call);
    assert.equal(call.keys.some((key) => key.includes(PROFILE)), false);
  }
  assert.deepEqual(
    scripts.calls.map((call) => call.name),
    [
      "pairingProtocolGate",
      "pairingIssue",
      "pairingActivate",
      "pairingActivate",
      "pairingCompletePeek",
      "pairingComplete",
      "pairingCompletePeek",
      "pairingComplete",
      "pairingCompletePeek",
      "pairingActivate",
      "pairingActivate",
      "pairingRedeemPeek",
      "pairingRedeem",
      "pairingRedeemPeek",
      "pairingRedeemPeek",
      "pairingCancel",
    ]
  );
  const consume = scripts.calls.find((call) => call.name === "pairingRedeem");
  assert.equal(consume.args[2], finalizedEnvelope);
  assert.equal(consume.args[3], activationDigest);
  assert.equal(scripts.calls.some((call) => call.args.includes(PROFILE)), false);
});

test("pairing completion without a profile remains later-finalizable and blocks early redemption", async () => {
  const scripts = new FakeScripts();
  const tokens = tokenService();
  const envelopes = envelopeCrypto();
  const pairingId = "pairing_redis_0001";
  const repository = new RedisPairingRepository({
    client: fakeClient(pairingId),
    scriptRunner: scripts,
    tokenService: tokens,
    envelopeCrypto: envelopes,
    tombstoneTtlMs: 1000,
  });
  const stableActivation = { installId: "install_redis_0001" };
  const activation = {
    ...stableActivation,
    deviceToken: tokens.issue("device", 32).token,
  };
  const digest = tokens.hashOpaque(
    "pair-activation",
    JSON.stringify(stableActivation),
    64 * 1024
  );
  const purpose = "pair-activation:" + stableScope("pairing", pairingId);
  const serializedEnvelope = JSON.stringify(envelopes.encryptJson(activation, purpose));
  scripts.enqueue("pairingCompletePeek", [
    "ready",
    "activating",
    "2000",
    serializedEnvelope,
    digest,
    "",
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  scripts.enqueue("pairingComplete", [
    "activated",
    "2000",
    serializedEnvelope,
    digest,
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);

  const legacyCompletion = await repository.completeActivation(pairingId, digest);
  assert.equal(legacyCompletion.status, "activated");
  assert.deepEqual(legacyCompletion.activation, activation);
  assert.deepEqual(scripts.calls[1].args, [
    pairingId,
    digest,
    1000,
    serializedEnvelope,
    serializedEnvelope,
    "",
  ]);

  scripts.enqueue("pairingRedeemPeek", ["pending", "activated", pairingId, "2000"]);
  assert.deepEqual(await repository.redeem("A".repeat(43)), {
    status: "pending",
    activationState: "activated",
    pairingId,
    expiresAt: 2000,
  });
  assert.equal(scripts.calls.some((call) => call.name === "pairingRedeem"), false);

  const profileHash = tokens.hashOpaque("pair-profile", PROFILE, 128);
  let finalizedEnvelope;
  scripts.enqueue("pairingCompletePeek", [
    "ready",
    "activated",
    "2000",
    serializedEnvelope,
    digest,
    "",
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  scripts.enqueue("pairingComplete", (call) => {
    finalizedEnvelope = call.args[4];
    assert.equal(call.args[5], profileHash);
    return [
      "activated",
      "2000",
      finalizedEnvelope,
      digest,
      ACTIVATION_RETRY_EXPIRES_AT,
    ];
  });
  const finalized = await repository.completeActivation(pairingId, digest, {
    profileId: PROFILE,
  });
  assert.equal(finalized.activation.profileId, PROFILE);
  assert.equal(finalized.activation.deviceToken, activation.deviceToken);

  scripts.enqueue("pairingCompletePeek", [
    "ready",
    "activated",
    "2000",
    finalizedEnvelope,
    digest,
    profileHash,
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  await assert.rejects(
    repository.completeActivation(pairingId, digest, { profileId: "profile_redis_0002" }),
    (error) => error.code === "pairing_conflict"
  );
});

test("pairing completion verifies exact stable activation fields before state transition", async () => {
  const scripts = new FakeScripts();
  const tokens = tokenService();
  const envelopes = envelopeCrypto();
  const pairingId = "pairing_redis_0001";
  const repository = new RedisPairingRepository({
    client: fakeClient(pairingId),
    scriptRunner: scripts,
    tokenService: tokens,
    envelopeCrypto: envelopes,
  });
  const digest = tokens.hashOpaque(
    "pair-activation",
    JSON.stringify({ installId: "install_expected_0001" }),
    64 * 1024
  );
  const mismatchedEnvelope = JSON.stringify(
    envelopes.encryptJson(
      {
        installId: "install_changed_0001",
        deviceToken: tokens.issue("device", 32).token,
      },
      "pair-activation:" + stableScope("pairing", pairingId)
    )
  );
  scripts.enqueue("pairingCompletePeek", [
    "ready",
    "activating",
    "2000",
    mismatchedEnvelope,
    digest,
    "",
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);

  await assert.rejects(
    repository.completeActivation(pairingId, digest),
    /activation digest does not match its envelope/
  );
  assert.deepEqual(scripts.calls.map((call) => call.name), ["pairingCompletePeek"]);
});

test("PairingCoordinator completes through Redis and receives the verified finalized activation", async () => {
  const scripts = new FakeScripts();
  const tokens = tokenService();
  const envelopes = envelopeCrypto();
  const pairingId = "pairing_redis_0001";
  const deviceId = "device_redis_0001";
  const profileId = "profile_redis_0001";
  const pairings = new RedisPairingRepository({
    client: fakeClient(pairingId),
    scriptRunner: scripts,
    tokenService: tokens,
    envelopeCrypto: envelopes,
    idFactory: (kind) => (kind === "pairing" ? pairingId : deviceId),
    randomBytes: () => Buffer.alloc(8, 0),
  });
  const configBlob = "R".repeat(64);
  const config = {
    profileId: "configured_profile_redis_0001",
    name: "Redis living room",
    settings: { subtitles_enabled: true },
  };
  let storedEnvelope;
  let digest;
  scripts.enqueue("pairingProtocolGate", ["ready"]);
  scripts.enqueue("pairingIssue", ["ok", "2000"]);
  scripts.enqueue("pairingActivate", (call) => {
    storedEnvelope = call.args[1];
    digest = call.args[2];
    return [
      "activating",
      pairingId,
      deviceId,
      digest,
      "2000",
      storedEnvelope,
      ACTIVATION_RETRY_EXPIRES_AT,
    ];
  });
  scripts.enqueue("pairingCompletePeek", () => [
    "ready",
    "activating",
    "2000",
    storedEnvelope,
    digest,
    "",
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);
  scripts.enqueue("pairingComplete", (call) => [
    "activated",
    "2000",
    call.args[4],
    digest,
    ACTIVATION_RETRY_EXPIRES_AT,
  ]);

  let registeredToken;
  const coordinator = new PairingCoordinator({
    pairings,
    managementSessions: {
      async issue() {
        throw new Error("generic management issuance must not be used for pairing");
      },
      async issueForPairing(input) {
        return {
          status: "issued",
          sessionToken: "m".repeat(43),
          csrfToken: "c".repeat(32),
          expiresAt: 901000,
          authority: input.authority,
        };
      },
      async recoverPairing() {
        return { status: "not_found" };
      },
      async revokePairing() {
        return { status: "not_found" };
      },
      async authenticate() {
        return null;
      },
      async revoke() {
        return false;
      },
      async revokeProfile() {
        return 0;
      },
    },
    devices: {
      async register(registeredProfileId, input) {
        registeredToken = input.deviceToken;
        return {
          device: { id: input.deviceId, profileId: registeredProfileId, generation: 1 },
          deviceToken: input.deviceToken,
        };
      },
      async authenticate() {
        return null;
      },
      async list() {
        return [];
      },
      async getGeneration() {
        return 1;
      },
      async isActiveBinding() {
        return true;
      },
      async revoke() {
        return false;
      },
      async revokeWithInvalidation() {
        return { revoked: false, invalidation: null };
      },
      async commitDisclosure(_profileId, _deviceId, _profileRevision, _generation, emitSync) {
        return emitSync();
      },
      async withClaimAdmission(_profileId, _deviceId, _profileRevision, _generation, operation) {
        return operation();
      },
    },
    profiles: {
      async getById(id) {
        return id === profileId ? { id, status: "active", revision: 1 } : null;
      },
    },
    profileProvisioner: {
      async provision() {
        return {
          profile: { id: profileId, displayName: config.name, revision: 1 },
          installToken: "install_token_redis_0001",
          identityHash: deriveProfileIdentityHash(config, configBlob),
          configHash: hashConfigBlob(configBlob),
        };
      },
    },
    decryptConfig: () => JSON.parse(JSON.stringify(config)),
    allowInsecureLoopback: true,
  });

  const issued = await coordinator.issue({ deviceName: "Redis TV" });
  const activated = await coordinator.activate({
    userCode: issued.userCode,
    configBlob,
    bridgeBaseUrl: "http://127.0.0.1:7515/_c/" + configBlob,
    activationRetryToken: ACTIVATION_RETRY_TOKEN,
  });
  assert.equal(activated.status, "activated");
  assert.equal(activated.profileId, profileId);
  assert.equal(activated.deviceId, deviceId);
  assert.match(registeredToken, /^[A-Za-z0-9_-]{43}$/);
});

test("pairing decrypts and validates before compare-and-consume", async () => {
  const scripts = new FakeScripts();
  const tokens = tokenService();
  const envelopes = envelopeCrypto();
  const repository = new RedisPairingRepository({
    client: fakeClient("pairing_redis_0001"),
    scriptRunner: scripts,
    tokenService: tokens,
    envelopeCrypto: envelopes,
  });
  const stableActivation = { installId: "install_redis_0001" };
  const activation = {
    ...stableActivation,
    deviceToken: tokens.issue("device", 32).token,
    profileId: PROFILE,
  };
  const purpose = "pair-activation:" + stableScope("pairing", "pairing_redis_0001");
  const validEnvelope = envelopes.encryptJson(activation, purpose);
  const missingKeyEnvelope = { ...validEnvelope, kid: "missing" };
  const corruptEnvelope = {
    ...validEnvelope,
    ct: (validEnvelope.ct.startsWith("A") ? "B" : "A") + validEnvelope.ct.slice(1),
  };
  const digest = tokens.hashOpaque(
    "pair-activation",
    JSON.stringify(stableActivation),
    64 * 1024
  );

  scripts.enqueue("pairingRedeemPeek", [
    "ready",
    "pairing_redis_0001",
    "device_redis_0001",
    JSON.stringify(missingKeyEnvelope),
    digest,
    "2000",
  ]);
  await assert.rejects(() => repository.redeem("A".repeat(43)), /key is unavailable/);
  assert.deepEqual(scripts.calls.map((call) => call.name), ["pairingRedeemPeek"]);

  scripts.enqueue("pairingRedeemPeek", [
    "ready",
    "pairing_redis_0001",
    "device_redis_0001",
    JSON.stringify(corruptEnvelope),
    digest,
    "2000",
  ]);
  await assert.rejects(() => repository.redeem("A".repeat(43)), /authentication failed/);
  assert.deepEqual(
    scripts.calls.map((call) => call.name),
    ["pairingRedeemPeek", "pairingRedeemPeek"]
  );

  scripts.enqueue("pairingRedeemPeek", [
    "ready",
    "pairing_redis_0001",
    "device_redis_0001",
    JSON.stringify(validEnvelope),
    digest,
    "2000",
  ]);
  scripts.enqueue("pairingRedeem", ["redeemed", "pairing_redis_0001", "device_redis_0001"]);
  const redeemed = await repository.redeem("A".repeat(43));
  assert.deepEqual(redeemed.activation, activation);
  assert.deepEqual(
    scripts.calls.map((call) => call.name),
    ["pairingRedeemPeek", "pairingRedeemPeek", "pairingRedeemPeek", "pairingRedeem"]
  );

  scripts.enqueue("pairingRedeemPeek", ["expired"]);
  assert.equal((await repository.redeem("A".repeat(43))).status, "expired");
  scripts.enqueue("pairingRedeemPeek", ["cancelled"]);
  assert.equal((await repository.redeem("A".repeat(43))).status, "cancelled");
});

test("OAuth decrypts before exact compare-and-consume without burning corrupt state", async () => {
  const scripts = new FakeScripts();
  const tokens = tokenService();
  const envelopes = envelopeCrypto();
  const repository = new RedisOAuthStateRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    tokenService: tokens,
    envelopeCrypto: envelopes,
    ttlMs: 1000,
  });
  scripts.enqueue("oauthIssue", (call) => {
    assert.equal(call.keys.length, 3);
    assert.equal(call.args.at(-1), "0");
    return ["ok", "2000"];
  });
  const issued = await repository.issue(
    PROFILE,
    { nonce: "browser-bound" },
    { managementGeneration: 0 }
  );
  const stateHash = tokens.hashToken("oauth-state", issued.stateToken);
  const envelope = envelopes.encryptJson({ nonce: "browser-bound" }, "oauth-state:" + stateHash);
  const missingKeyEnvelope = { ...envelope, kid: "missing" };
  const corruptEnvelope = {
    ...envelope,
    ct: (envelope.ct.startsWith("A") ? "B" : "A") + envelope.ct.slice(1),
  };
  const bindingHash = tokens.hashToken("oauth-binding", issued.browserBindingToken);

  scripts.enqueue("oauthConsumePeek", [
    "ready",
    PROFILE,
    JSON.stringify(missingKeyEnvelope),
    "1000",
    "2000",
    "0",
  ]);
  await assert.rejects(
    repository.consume(issued.stateToken, issued.browserBindingToken),
    /key is unavailable/
  );
  assert.deepEqual(scripts.calls.map((call) => call.name), ["oauthIssue", "oauthConsumePeek"]);

  scripts.enqueue("oauthConsumePeek", [
    "ready",
    PROFILE,
    JSON.stringify(corruptEnvelope),
    "1000",
    "2000",
    "0",
  ]);
  await assert.rejects(
    repository.consume(issued.stateToken, issued.browserBindingToken),
    /authentication failed/
  );
  assert.equal(scripts.calls.some((call) => call.name === "oauthConsume"), false);

  const serializedEnvelope = JSON.stringify(envelope);
  scripts.enqueue("oauthConsumePeek", [
    "ready",
    PROFILE,
    serializedEnvelope,
    "1000",
    "2000",
    "0",
  ]);
  scripts.enqueue("oauthConsume", ["consumed"]);
  const consumed = await repository.consume(issued.stateToken, issued.browserBindingToken);

  assert.deepEqual(consumed.payload, { nonce: "browser-bound" });
  const peekCall = scripts.calls.at(-2);
  const consumeCall = scripts.calls.at(-1);
  assert.equal(peekCall.name, "oauthConsumePeek");
  assert.deepEqual(peekCall.args, [bindingHash]);
  assert.equal(consumeCall.name, "oauthConsume");
  assert.equal(consumeCall.keys.length, 3);
  assert.deepEqual(consumeCall.args, [
    bindingHash,
    serializedEnvelope,
    PROFILE,
    1000,
    2000,
    "0",
  ]);
  assert.notEqual(bindingHash, issued.browserBindingToken);
  assertHashedKeys(peekCall);
  assertHashedKeys(consumeCall);

  scripts.enqueue("oauthConsumePeek", [
    "ready",
    PROFILE,
    serializedEnvelope,
    "1000",
    "2000",
    "0",
  ]);
  scripts.enqueue("oauthConsume", ["not_found"]);
  assert.equal(await repository.consume(issued.stateToken, issued.browserBindingToken), null);
});

test("Redis JSON inputs reject unsafe integers before encryption or Lua", async () => {
  const oauthScripts = new FakeScripts();
  const oauth = new RedisOAuthStateRepository({
    client: fakeClient(),
    scriptRunner: oauthScripts,
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });
  await assert.rejects(
    oauth.issue(PROFILE, { nested: { revision: Number.MAX_SAFE_INTEGER + 1 } }),
    /non-safe integer/
  );
  await assert.rejects(oauth.issue(PROFILE, { progress: 1.5 }), /non-safe integer/);
  assert.equal(oauthScripts.calls.length, 0);

  const playbackScripts = new FakeScripts();
  const playback = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: fakeClient(),
    scriptRunner: playbackScripts,
    envelopeCrypto: envelopeCrypto(),
    sourceContextOptions: { idFactory: () => "context_unsafe_0001", ttlMs: 1000 },
  });
  await assert.rejects(
    playback.record(PROFILE, {
      source: {
        url: "https://cdn.example/unsafe.mkv",
        ignoredSequence: Number.MAX_SAFE_INTEGER + 1,
      },
    }),
    /non-safe integer/
  );
  assert.equal(playbackScripts.calls.length, 0);
});

test("management, lease, and rate-limit fakes preserve rejection and token contracts", async () => {
  const tokens = tokenService();

  const managementScripts = new FakeScripts();
  const management = new RedisManagementSessionRepository({
    client: fakeClient(),
    scriptRunner: managementScripts,
    tokenService: tokens,
    ttlMs: 1000,
    maxSessions: 2,
    maxSessionsPerProfile: 1,
  });
  managementScripts.enqueue("managementGeneration", ["generation", "0"]);
  managementScripts.enqueue("managementIssue", ["ok", "2000"]);
  const session = await management.issue(PROFILE);
  managementScripts.enqueue("managementAuthenticate", ["authenticated", PROFILE, "2000", "0"]);
  assert.deepEqual(await management.authenticate(session.sessionToken, session.csrfToken), {
    profileId: PROFILE,
    expiresAt: 2000,
    managementGeneration: 0,
  });
  managementScripts.enqueue("managementGeneration", ["generation", "0"]);
  managementScripts.enqueue("managementIssue", ["profile_capacity"]);
  await assert.rejects(() => management.issue(PROFILE), /profile management session limit/);

  const leaseScripts = new FakeScripts();
  const leases = new RedisLeaseRepository({
    client: fakeClient(),
    scriptRunner: leaseScripts,
    tokenService: tokens,
  });
  leaseScripts.enqueue("leaseAcquire", ["acquired", "2000"]);
  const lease = await leases.acquire("refresh", PROFILE, "instance_0001", 1000);
  leaseScripts.enqueue("leaseRenew", ["renewed", "2500"]);
  assert.deepEqual(await leases.renew("refresh", PROFILE, lease.leaseToken, 1000), {
    renewed: true,
    expiresAt: 2500,
  });
  leaseScripts.enqueue("leaseRelease", ["released"]);
  assert.equal(await leases.release("refresh", PROFILE, lease.leaseToken), true);

  const limitScripts = new FakeScripts();
  const limits = new RedisRateLimitRepository({
    client: fakeClient(),
    scriptRunner: limitScripts,
    tokenService: tokens,
  });
  limitScripts.enqueue("rateLimitConsume", ["consumed", "1", "1", "2000"]);
  assert.deepEqual(await limits.consume("pair", "profile-or-network", 2, 1000), {
    allowed: true,
    remaining: 1,
    resetAt: 2000,
  });
  limitScripts.enqueue("rateLimitConsume", ["policy_mismatch"]);
  await assert.rejects(
    () => limits.consume("pair", "profile-or-network", 3, 1000),
    (error) => error.code === "rate_limit_policy_mismatch"
  );

  for (const call of [...managementScripts.calls, ...leaseScripts.calls, ...limitScripts.calls]) {
    assertHashedKeys(call);
  }
});

test("Redis pairing management replays one encrypted authority and revokes atomically", async () => {
  const scripts = new FakeScripts();
  const retryToken = Buffer.alloc(32, 0x76).toString("base64url");
  const repository = new RedisManagementSessionRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
    isProfileActive: async () => true,
  });
  const input = {
    pairingId: "pairing_management_redis_0001",
    profileId: PROFILE,
    configHash: "a".repeat(64),
    activationRetryToken: retryToken,
    activationRetryExpiresAt: 601000,
    authority: { schemaVersion: 1, profileId: PROFILE, installToken: "private-install" },
  };
  let encryptedReplay;
  scripts.enqueue("managementGeneration", ["generation", "0"]);
  scripts.enqueue("managementPairingIssue", (call) => {
    encryptedReplay = call.args[8];
    return ["issued", encryptedReplay, "901000", "601000"];
  });
  const issued = await repository.issueForPairing(input);
  assert.equal(encryptedReplay.includes(retryToken), false);
  assert.equal(encryptedReplay.includes(issued.sessionToken), false);
  assert.equal(encryptedReplay.includes(issued.csrfToken), false);

  scripts.enqueue("managementGeneration", ["generation", "0"]);
  scripts.enqueue("managementPairingIssue", [
    "replayed",
    encryptedReplay,
    "901000",
    "601000",
  ]);
  const replayedIssue = await repository.issueForPairing(input);
  assert.deepEqual(replayedIssue, { ...issued, status: "replayed" });

  scripts.enqueue("managementPairingRecover", [
    "replayed",
    encryptedReplay,
    "901000",
    "601000",
  ]);
  scripts.enqueue("managementPairingRecover", [
    "replayed",
    encryptedReplay,
    "901000",
    "601000",
  ]);
  assert.deepEqual(await repository.recoverPairing(input), {
    ...issued,
    status: "replayed",
  });

  scripts.enqueue("managementPairingRecover", ["conflict"]);
  await assert.rejects(
    repository.recoverPairing({ ...input, configHash: "b".repeat(64) }),
    (error) => error.code === "pairing_conflict"
  );
  scripts.enqueue("managementPairingRevoke", ["revoked"]);
  assert.deepEqual(await repository.revokePairing(input), { status: "revoked" });

  const rawCalls = JSON.stringify(scripts.calls);
  assert.equal(rawCalls.includes(retryToken), false);
  assert.equal(rawCalls.includes(issued.sessionToken), false);
  assert.equal(rawCalls.includes(issued.csrfToken), false);
  for (const call of scripts.calls) assertHashedKeys(call);
});

test("Redis management sessions reject inactive profiles and revoke every profile session", async () => {
  let active = false;
  const scripts = new FakeScripts();
  const repository = new RedisManagementSessionRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    tokenService: tokenService(),
    ttlMs: 1000,
    maxSessions: 8,
    maxSessionsPerProfile: 2,
    isProfileActive: async (profileId) => {
      assert.equal(profileId, PROFILE);
      return active;
    },
  });

  scripts.enqueue("managementGeneration", ["generation", "0"]);
  await assert.rejects(() => repository.issue(PROFILE), /profile is inactive/);
  assert.equal(scripts.calls.length, 1);

  active = true;
  scripts.enqueue("managementGeneration", ["generation", "0"]);
  scripts.enqueue("managementIssue", ["ok", "2000"]);
  const session = await repository.issue(PROFILE);
  active = false;
  scripts.enqueue("managementAuthenticate", ["authenticated", PROFILE, "2000", "0"]);
  scripts.enqueue("managementRevoke", ["revoked"]);
  assert.equal(await repository.authenticate(session.sessionToken, session.csrfToken), null);
  assert.deepEqual(
    scripts.calls.slice(-2).map((call) => call.name),
    ["managementAuthenticate", "managementRevoke"]
  );

  scripts.enqueue("managementRevokeProfile", (call) => {
    assertHashedKeys(call);
    assert.equal(call.keys.length, 3);
    assert.deepEqual(call.args, [PROFILE, 2]);
    return ["revoked", "2", "1"];
  });
  assert.equal(await repository.revokeProfile(PROFILE), 2);
});

test("Redis management issuance is generation-fenced against a stale active-profile check", async () => {
  const entered = {};
  entered.promise = new Promise((resolve) => {
    entered.resolve = resolve;
  });
  const release = {};
  release.promise = new Promise((resolve) => {
    release.resolve = resolve;
  });
  const scripts = new FakeScripts();
  const repository = new RedisManagementSessionRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    tokenService: tokenService(),
    isProfileActive: async () => {
      entered.resolve();
      await release.promise;
      return true;
    },
  });

  scripts.enqueue("managementGeneration", ["generation", "0"]);
  const issuing = repository.issue(PROFILE);
  await entered.promise;
  scripts.enqueue("managementRevokeProfile", ["revoked", "0", "1"]);
  await repository.revokeProfile(PROFILE);
  scripts.enqueue("managementIssue", ["profile_changed"]);
  release.resolve();

  await assert.rejects(issuing, /profile.*changed|inactive/i);
  assert.deepEqual(
    scripts.calls.map((call) => call.name),
    ["managementGeneration", "managementRevokeProfile", "managementIssue"]
  );
  assert.equal(scripts.calls[2].keys.length, 4);
  assert.equal(scripts.calls[2].args.at(-1), "0");
});

test("Redis device revocation invalidates exact playback and subtitle bindings", async () => {
  const playbackScripts = new FakeScripts();
  const playbackClient = fakeClient();
  const isolatedClient = {
    isOpen: false,
    async connect() { this.isOpen = true; },
    async quit() { this.isOpen = false; },
    destroy() { this.isOpen = false; },
    async eval() {},
  };
  playbackClient.duplicate = () => isolatedClient;
  const playback = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: playbackClient,
    scriptRunner: playbackScripts,
    isolatedScriptRunnerFactory: () => playbackScripts,
    envelopeCrypto: envelopeCrypto(),
  });
  const generation = await playback.getProfileGeneration(PROFILE);
  playbackScripts.enqueue("playbackInvalidateDevice", (call) => {
    assertHashedKeys(call);
    assert.equal(call.keys.length, 18);
    assert.equal(call.args[0], playback._profileTag(PROFILE));
    assert.equal(call.args[1], playback._keys.member("playback-device", PROFILE, DEVICE));
    assert.equal(call.args[7], generation);
    assert.equal(call.keys[16], playback._deviceGenerationKey(PROFILE, DEVICE));
    assert.equal(call.keys[17], playback._deviceGenerationIndexKey(PROFILE));
    assert.equal(call.args[8], "2");
    assert.equal(call.args[9], String(playback._deviceGenerationTtlMs));
    return ["invalidated", "1"];
  });
  assert.equal(await playback.invalidateDevice(PROFILE, DEVICE, 2), true);

  const staleUrl = "https://media.example/stale-device-generation";
  const staleRequest = {
    attemptId: randomUUID(),
    fingerprints: [fingerprintExactUrl(staleUrl)],
    intentUrlHash: hashOpaqueValue(staleUrl),
    launchedAt: 1000,
  };
  const claimAbort = new AbortController();
  playbackScripts.enqueue("playbackAttemptBegin", (call) => {
    assertHashedKeys(call);
    assert.equal(call.keys.length, 12);
    assert.equal(call.keys[6], playback._deviceGenerationKey(PROFILE, DEVICE));
    assert.equal(
      call.keys[10],
      playback._claimAttemptFingerprintKey(PROFILE, DEVICE, staleRequest.attemptId)
    );
    assert.equal(call.keys[11], playback._globalClaimAttemptFingerprintsKey);
    assert.equal(call.args[7], "1");
    assert.equal(call.signal, undefined);
    return ["device_generation_changed"];
  });
  await assert.rejects(
    () => playback.claim(
      PROFILE,
      DEVICE,
      staleRequest,
      playbackClaimOptions("session_stale_device_0001", staleRequest, {
        generation,
        deviceGeneration: 1,
        signal: claimAbort.signal,
      })
    ),
    (error) => error.code === "device_generation_changed"
  );
  assert.deepEqual(playbackScripts.timeSignals, []);

  const subtitleScripts = new FakeScripts();
  const subtitles = new RedisSubtitleDeliveryRepository({
    client: fakeClient(),
    scriptRunner: subtitleScripts,
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });
  subtitleScripts.enqueue("subtitleInvalidate", (call) => {
    assertHashedKeys(call);
    assert.equal(call.keys.length, 12);
    assert.equal(call.args[0], subtitles._keys.member("playback-profile", PROFILE));
    assert.equal(call.args[1], "device");
    assert.equal(call.args[2], subtitles._keys.member("playback-device", PROFILE, DEVICE));
    assert.equal(call.args[3], "");
    return ["invalidated", "2"];
  });
  assert.equal(await subtitles.invalidateDevice(PROFILE, DEVICE), 2);
});

test("playback defaults safely to v3 and initializes one high-entropy generation atomically", async () => {
  const scripts = new FakeScripts(1000);
  const repository = new RedisPlaybackContextRepository({
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
  });

  assert.equal(repository._writeVersion, "3");
  assert.throws(
    () => new RedisPlaybackContextRepository({
      writeVersion: "5",
      client: fakeClient(),
      scriptRunner: new FakeScripts(),
      envelopeCrypto: envelopeCrypto(),
    }),
    /writeVersion/
  );

  const first = await repository.getProfileGeneration(PROFILE);
  const second = await repository.getProfileGeneration(PROFILE);
  assert.match(first, /^g1:[A-Za-z0-9_-]{43}$/);
  assert.equal(second, first);
  const calls = scripts.calls.filter(
    (call) => call.name === "playbackGetOrInitializeGeneration"
  );
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].args[0], calls[1].args[0]);
});

test("playback preserves the exact c801f38 v3 fixture and v4 readers fail closed", async () => {
  const scripts = new FakeScripts(1000);
  const envelopes = envelopeCrypto();
  const generation = "g1:parent_c801f38";
  let sequence = 0;
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "3",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopes,
    generationFactory: () => generation,
    sourceContextOptions: {
      idFactory: (kind) => kind + "_parent_" + String(++sequence).padStart(4, "0"),
      ttlMs: 1000,
    },
  });
  const url = "https://cdn.example/parent-v3.mkv";
  let metadataRaw;
  scripts.enqueue("playbackRecord", (call) => {
    metadataRaw = call.args[3];
    return ["recorded"];
  });

  const recorded = await repository.record(
    PROFILE,
    {
      source: { url },
      display: { title: "Parent v3" },
      inlineSubtitles: [],
    },
    { providerRevision: "17" }
  );
  const metadata = JSON.parse(metadataRaw);
  assert.deepEqual(Object.keys(metadata).sort(), PARENT_V3_CONTEXT_FIELDS);
  assert.equal(metadata.v, "3");
  assert.equal(Object.hasOwn(metadata, "providerRevision"), false);
  assert.deepEqual(
    envelopes.decryptJson(
      JSON.parse(metadata.envelope),
      "playback-context:v1:" + metadata.ref
    ),
    recorded
  );
  assert.equal(parseMetadata(metadataRaw).v, "3");
  assert.throws(
    () => parseMetadata(JSON.stringify({ ...metadata, providerRevision: "17" })),
    /metadata is invalid/
  );
  assert.throws(
    () => parseMetadata(JSON.stringify({ ...metadata, v: "4" })),
    /metadata is invalid/
  );

  scripts.enqueue("playbackClaimV6", (call) => {
    assert.notEqual(call.args[18], "");
    assert.equal(call.args[19], generation);
    assert.equal(call.args[20], "5");
    return [
      "claimed",
      "claimed",
      "session_parent_0002",
      metadataRaw,
      "1000",
      "2000",
      call.args[18],
    ];
  });
  const parentClaimRequest = {
    attemptId: randomUUID(),
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: 1000,
  };
  const claim = await repository.claim(
    PROFILE,
    DEVICE,
    parentClaimRequest,
    playbackClaimOptions("session_parent_0002", parentClaimRequest)
  );
  assert.equal(typeof claim[PLAYBACK_CLAIM_CLEANUP_OWNER], "string");
  assert.equal(Object.prototype.propertyIsEnumerable.call(
    claim,
    PLAYBACK_CLAIM_CLEANUP_OWNER
  ), false);
  const parentClaimCall = scripts.calls.find((call) => call.name === "playbackClaimV6");
  scripts.enqueue(
    "playbackGetActiveClaim",
    ["active", metadataRaw, "1000", "2000", parentClaimCall.args[18]]
  );
  const active = await repository.getActiveClaim(PROFILE, DEVICE, claim.sessionId);
  assert.deepEqual(active, claim);
  assert.equal(Object.hasOwn(active, "deliveryBinding"), false);

  const v4Reader = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopes,
    generationFactory: () => generation,
  });
  scripts.enqueue(
    "playbackGetActiveClaim",
    ["active", metadataRaw, "1000", "2000", parentClaimCall.args[18]]
  );
  const readByV4 = await v4Reader.getActiveClaim(PROFILE, DEVICE, claim.sessionId);
  assert.deepEqual(readByV4, claim);
  assert.equal(Object.hasOwn(readByV4, "deliveryBinding"), false);
});

test("playback v3-mode writers never downgrade an existing v4 context", async () => {
  const scripts = new FakeScripts(1000);
  const envelopes = envelopeCrypto();
  const generation = "g1:mixed_fixture";
  const input = {
    contentKey: hashOpaqueValue("movie:mixed-fixture"),
    source: { url: "https://cdn.example/mixed-fixture.mkv", provider: "mixed" },
    display: {},
    inlineSubtitles: [],
  };
  let v4Raw;
  const v4Writer = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopes,
    generationFactory: () => generation,
    sourceContextOptions: { idFactory: () => "context_mixed_v4", ttlMs: 1000 },
  });
  scripts.enqueue("playbackRecord", (call) => {
    v4Raw = call.args[3];
    return ["recorded"];
  });
  await v4Writer.record(PROFILE, input, { providerRevision: "9" });
  assert.equal(JSON.parse(v4Raw).v, "4");

  const v3Writer = new RedisPlaybackContextRepository({
    writeVersion: "3",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopes,
    generationFactory: () => generation,
    sourceContextOptions: { idFactory: () => "context_mixed_v3", ttlMs: 1000 },
  });
  scripts.enqueue("playbackRecord", ["existing", v4Raw]);
  scripts.enqueue("playbackRecord", (call) => {
    const updated = JSON.parse(call.args[3]);
    assert.equal(updated.v, "4");
    assert.equal(updated.providerRevision, "9");
    assert.equal(updated.revision, "2");
    return ["recorded"];
  });
  await v3Writer.record(PROFILE, input, { providerRevision: "9" });
});

test("playback fake stores only opaque metadata and recovers exact allowed secret context", async () => {
  const scripts = new FakeScripts(1000);
  const envelopes = envelopeCrypto();
  let sequence = 0;
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopes,
    generationFactory: () => "g1:opaque_fixture_0001",
    sourceContextOptions: {
      idFactory: (kind) => kind + "_opaque_" + String(++sequence).padStart(4, "0"),
      ttlMs: 1000,
    },
  });
  const mediaUrl = "https://cdn.example/movie.mkv?token=media-secret";
  const subtitleUrl = "https://subs.example/movie.vtt?sig=subtitle-secret";
  const input = {
    contentKey: hashOpaqueValue("movie:opaque"),
    canonicalIdentity: null,
    traktEligible: false,
    request: { type: "movie", metaId: "opaque" },
    display: {
      exactInteger: Number.MAX_SAFE_INTEGER,
      signedArtwork: "https://images.example/poster?token=art-secret",
      authorization: "Bearer display-secret",
    },
    source: { type: "url", provider: "opaque-provider" },
    fingerprints: [fingerprintExactUrl(mediaUrl)],
    inlineSubtitles: [{
      id: "inline-secret",
      url: subtitleUrl,
      headers: { Authorization: "Bearer subtitle-header-secret" },
      token: "inline-token-secret",
    }],
  };

  let metadataRaw;
  scripts.enqueue("playbackRecord", (call) => {
    assertHashedKeys(call);
    metadataRaw = call.args[3];
    const metadata = JSON.parse(metadataRaw);
    assert.deepEqual(Object.keys(metadata).sort(), [
      ...PARENT_V3_CONTEXT_FIELDS,
      "providerRevision",
    ].sort());
    assert.equal(metadata.v, "4");
    assert.equal(metadata.generation, "g1:opaque_fixture_0001");
    assert.equal(metadata.revision, "1");
    assert.equal(metadata.providerRevision, "0");
    assert.equal(metadata.createdAtMs, "1000");
    assert.equal(metadata.expiresAtMs, "2000");
    assert.equal(call.keys.length, 16 + metadata.fingerprintIndexKeys.length);
    for (const secret of [
      mediaUrl,
      subtitleUrl,
      "media-secret",
      "subtitle-secret",
      "subtitle-header-secret",
      "inline-token-secret",
      "display-secret",
      "art-secret",
      String(Number.MAX_SAFE_INTEGER),
    ]) {
      assert.equal(metadataRaw.includes(secret), false, secret);
      assert.equal(JSON.stringify(call.keys).includes(secret), false, secret);
    }
    return ["recorded"];
  });

  const recorded = await repository.record(PROFILE, input);
  assert.equal(recorded.display.exactInteger, Number.MAX_SAFE_INTEGER);
  assert.equal(recorded.inlineSubtitles[0].headers.Authorization, "Bearer subtitle-header-secret");

  let claimPrivateEnvelope;
  scripts.enqueue("playbackClaimV6", (call) => {
    assertHashedKeys(call);
    assert.equal(JSON.stringify(call.args).includes("secret"), false);
    assert.equal(call.args[17], "");
    claimPrivateEnvelope = call.args[18];
    return [
      "claimed",
      "claimed",
      "session_opaque_0002",
      metadataRaw,
      "1000",
      "2000",
      claimPrivateEnvelope,
    ];
  });
  const opaqueClaimRequest = {
    attemptId: randomUUID(),
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(mediaUrl),
    launchedAt: 1000,
  };
  const claimed = await repository.claim(
    PROFILE,
    DEVICE,
    opaqueClaimRequest,
    playbackClaimOptions("session_opaque_0002", opaqueClaimRequest)
  );
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.context.display.exactInteger, Number.MAX_SAFE_INTEGER);
  assert.equal(claimed.context.display.authorization, "Bearer display-secret");
  assert.equal(claimed.context.inlineSubtitles[0].url, subtitleUrl);
  assert.equal(
    claimed.context.inlineSubtitles[0].headers.Authorization,
    "Bearer subtitle-header-secret"
  );
  assert.equal(claimed.context.inlineSubtitles[0].token, "inline-token-secret");

  scripts.enqueue("playbackGetActiveClaim", (call) => {
    assertHashedKeys(call);
    assert.equal(call.keys.length, 17);
    assert.equal(call.args[2], claimed.sessionId);
    assert.equal(JSON.stringify(call).includes("secret"), false);
    return ["active", metadataRaw, "1000", "2000", claimPrivateEnvelope];
  });
  const firstActive = await repository.getActiveClaim(PROFILE, DEVICE, claimed.sessionId);
  const { deliveryBinding, ...activeClaim } = firstActive;
  assert.deepEqual(activeClaim, claimed);
  assert.deepEqual(deliveryBinding, {
    profileId: PROFILE,
    deviceId: DEVICE,
    sessionId: claimed.sessionId,
    generation: "g1:opaque_fixture_0001",
    contextId: claimed.context.contextId,
    contextRevision: "1",
    providerRevision: "0",
  });
  assert.equal(Object.isFrozen(firstActive), true);
  assert.equal(Object.isFrozen(firstActive.context), true);
  assert.equal(Object.isFrozen(firstActive.deliveryBinding), true);
  assert.equal(firstActive.context.inlineSubtitles[0].url, subtitleUrl);
  assert.equal(
    firstActive.context.inlineSubtitles[0].headers.Authorization,
    "Bearer subtitle-header-secret"
  );
  assert.equal(firstActive.context.inlineSubtitles[0].token, "inline-token-secret");

  scripts.enqueue("playbackGetActiveClaim", [
    "active",
    metadataRaw,
    "1000",
    "2000",
    claimPrivateEnvelope,
  ]);
  assert.deepEqual(await repository.getActiveClaim(PROFILE, DEVICE, claimed.sessionId), firstActive);

  let replacementPrivateEnvelope;
  scripts.enqueue("playbackClaimV6", ["retry", claimed.sessionId, "5", claimPrivateEnvelope]);
  scripts.enqueue("playbackClaimV6", (call) => {
    assert.equal(call.args[17], claimed.sessionId);
    replacementPrivateEnvelope = call.args[18];
    return [
      "claimed",
      "claimed",
      "session_opaque_0003",
      metadataRaw,
      "1001",
      "2000",
      replacementPrivateEnvelope,
    ];
  });
  const replacementRequest = {
    attemptId: randomUUID(),
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(mediaUrl + "#replacement"),
    launchedAt: 1001,
  };
  const replacement = await repository.claim(
    PROFILE,
    DEVICE,
    replacementRequest,
    playbackClaimOptions("session_opaque_0003", replacementRequest)
  );
  assert.equal(Object.hasOwn(replacement, "supersededSessionId"), false);
  scripts.enqueue("playbackGetActiveClaim", [
    "active",
    metadataRaw,
    "1001",
    "2000",
    replacementPrivateEnvelope,
  ]);
  const replacementActive = await repository.getActiveClaim(
    PROFILE,
    DEVICE,
    replacement.sessionId
  );
  assert.equal(replacementActive.deliveryBinding.supersededSessionId, claimed.sessionId);

  const tamperedPrivateState = JSON.parse(replacementPrivateEnvelope);
  tamperedPrivateState.tag =
    (tamperedPrivateState.tag[0] === "A" ? "B" : "A") + tamperedPrivateState.tag.slice(1);
  scripts.enqueue("playbackGetActiveClaim", [
    "active",
    metadataRaw,
    "1001",
    "2000",
    JSON.stringify(tamperedPrivateState),
  ]);
  assert.equal(
    await repository.getActiveClaim(PROFILE, DEVICE, replacement.sessionId),
    null
  );

  scripts.enqueue("playbackClaimV6", [
    "retry",
    replacement.sessionId,
    "5",
    JSON.stringify(tamperedPrivateState),
  ]);
  const tamperedRequest = {
    attemptId: randomUUID(),
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(mediaUrl + "#tamper"),
    launchedAt: 1002,
  };
  await assert.rejects(
    repository.claim(
      PROFILE,
      DEVICE,
      tamperedRequest,
      playbackClaimOptions("session_opaque_0004", tamperedRequest)
    ),
    /authentication failed/
  );

  const parsedMetadata = JSON.parse(metadataRaw);
  const purpose = "playback-context:v1:" + parsedMetadata.ref;
  const crossProfileContext = JSON.parse(JSON.stringify(claimed.context));
  crossProfileContext.profileId = "profile_redis_cross_profile";
  const crossProfileMetadata = {
    ...parsedMetadata,
    envelope: JSON.stringify(envelopes.encryptJson(crossProfileContext, purpose)),
  };
  scripts.enqueue("playbackGetActiveClaim", [
    "active",
    JSON.stringify(crossProfileMetadata),
    "1000",
    "2000",
    claimPrivateEnvelope,
  ]);
  assert.equal(await repository.getActiveClaim(PROFILE, DEVICE, claimed.sessionId), null);

  const mismatchedRef = "f".repeat(64);
  const refMismatchedMetadata = {
    ...parsedMetadata,
    ref: mismatchedRef,
    envelope: JSON.stringify(
      envelopes.encryptJson(claimed.context, "playback-context:v1:" + mismatchedRef)
    ),
  };
  scripts.enqueue("playbackGetActiveClaim", [
    "active",
    JSON.stringify(refMismatchedMetadata),
    "1000",
    "2000",
    claimPrivateEnvelope,
  ]);
  assert.equal(await repository.getActiveClaim(PROFILE, DEVICE, claimed.sessionId), null);

  const fingerprintMismatchedContext = JSON.parse(JSON.stringify(claimed.context));
  fingerprintMismatchedContext.fingerprints = [
    fingerprintExactUrl("https://cdn.example/fingerprint-mismatch.mkv"),
  ];
  const fingerprintMismatchedMetadata = {
    ...parsedMetadata,
    envelope: JSON.stringify(envelopes.encryptJson(fingerprintMismatchedContext, purpose)),
  };
  scripts.enqueue("playbackGetActiveClaim", [
    "active",
    JSON.stringify(fingerprintMismatchedMetadata),
    "1000",
    "2000",
    claimPrivateEnvelope,
  ]);
  assert.equal(await repository.getActiveClaim(PROFILE, DEVICE, claimed.sessionId), null);

  const differentDigest = (value) => (value[0] === "0" ? "1" : "0") + value.slice(1);
  const protectedMetadataCorruptions = {
    generation: "g1:tampered",
    providerRevision: "1",
    revision: "2",
    equivalenceHash: differentDigest(parsedMetadata.equivalenceHash),
    globalMember: differentDigest(parsedMetadata.globalMember),
    fingerprintHashes: parsedMetadata.fingerprintHashes.map((value, index) =>
      index === 0 ? differentDigest(value) : value
    ),
    fingerprintIndexKeys: parsedMetadata.fingerprintIndexKeys.map((value, index) =>
      index === 0 ? value + ":corrupt" : value
    ),
    tombstoneMembers: parsedMetadata.tombstoneMembers.map((value, index) =>
      index === 0 ? differentDigest(value) : value
    ),
  };
  for (const [field, value] of Object.entries(protectedMetadataCorruptions)) {
    const corruptedMetadata = { ...parsedMetadata, [field]: value };
    scripts.enqueue("playbackGetActiveClaim", [
      "active",
      JSON.stringify(corruptedMetadata),
      "1000",
      "2000",
      claimPrivateEnvelope,
    ]);
    assert.equal(
      await repository.getActiveClaim(PROFILE, DEVICE, claimed.sessionId),
      null,
      field
    );
  }

  for (const [profileId, deviceId, sessionId] of [
    ["profile_redis_other", DEVICE, claimed.sessionId],
    [PROFILE, "device_redis_other", claimed.sessionId],
    [PROFILE, DEVICE, "session_redis_wrong"],
    [PROFILE, DEVICE, claimed.sessionId],
    [PROFILE, DEVICE, claimed.sessionId],
    [PROFILE, DEVICE, claimed.sessionId],
  ]) {
    scripts.enqueue("playbackGetActiveClaim", ["not_found"]);
    assert.equal(await repository.getActiveClaim(profileId, deviceId, sessionId), null);
  }
  assert.equal(metadataRaw.includes("secret"), false);
});

test("playback fake performs encrypted CAS merges with exact decimal revisions", async () => {
  const scripts = new FakeScripts(1000);
  let sequence = 0;
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    sourceContextOptions: {
      idFactory: (kind) => kind + "_cas_" + String(++sequence).padStart(4, "0"),
      ttlMs: 1000,
    },
  });
  const fingerprint = fingerprintExactUrl("https://cdn.example/cas.mkv?token=cas-secret");
  const context = (provider, subtitle) => ({
    contentKey: hashOpaqueValue("movie:cas"),
    canonicalIdentity: null,
    traktEligible: false,
    request: { type: "movie", streamProvider: provider },
    display: { exactInteger: Number.MAX_SAFE_INTEGER },
    source: { type: "url", provider },
    fingerprints: [fingerprint],
    inlineSubtitles: [{ id: subtitle, url: "https://subs.example/" + subtitle + "?token=secret" }],
  });

  let firstRaw;
  scripts.enqueue("playbackRecord", (call) => {
    firstRaw = call.args[3];
    return ["recorded"];
  });
  const first = await repository.record(PROFILE, context("provider-a", "a"));

  scripts.enqueue("playbackRecord", () => ["existing", firstRaw]);
  scripts.enqueue("playbackRecord", (call) => {
    assert.equal(call.args[2], "update");
    assert.equal(call.args[4], firstRaw);
    const metadata = JSON.parse(call.args[3]);
    assert.equal(metadata.revision, "2");
    assert.equal(metadata.ref, JSON.parse(firstRaw).ref);
    assert.equal(call.args[3].includes("cas-secret"), false);
    return ["recorded"];
  });
  const refreshed = await repository.record(PROFILE, context("provider-b", "b"));
  assert.equal(refreshed.contextId, first.contextId);
  assert.equal(refreshed.display.exactInteger, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(refreshed.source.providers, ["provider-a", "provider-b"]);
  assert.deepEqual(refreshed.inlineSubtitles.map((subtitle) => subtitle.id), ["a", "b"]);
});

test("playback fake maps atomic overlap, capacity, and stale generation statuses", async () => {
  const scripts = new FakeScripts(1000);
  let sequence = 0;
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    sourceContextOptions: {
      idFactory: (kind) => kind + "_status_" + String(++sequence).padStart(4, "0"),
      ttlMs: 1000,
    },
  });
  const makeContext = (suffix) => ({
    source: { url: "https://cdn.example/" + suffix + ".mkv" },
    display: {},
    inlineSubtitles: [],
  });

  for (const [status, code] of [
    ["overlap", "context_overlap"],
    ["capacity", "context_capacity"],
    ["generation_changed", "profile_generation_changed"],
  ]) {
    scripts.enqueue("playbackRecord", [status]);
    await assert.rejects(
      repository.record(PROFILE, makeContext(status), { generation: "g1:0" }),
      (error) => error.code === code
    );
  }
});

test("playback fake consumes bounded profile-prune continuations before mutations", async () => {
  const scripts = new FakeScripts(1000);
  let sequence = 0;
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    pruneEntryBatchSize: 2,
    sourceContextOptions: {
      idFactory: (kind) => kind + "_prune_retry_" + String(++sequence).padStart(4, "0"),
      ttlMs: 1000,
    },
  });
  const url = "https://cdn.example/prune-retry.mkv";

  scripts.enqueue("playbackRecord", ["prune_pending"]);
  scripts.enqueue("playbackRecord", ["recorded"]);
  const recorded = await repository.record(PROFILE, {
    source: { url },
    display: {},
    inlineSubtitles: [],
  });
  const recordCalls = scripts.calls.filter((call) => call.name === "playbackRecord");
  assert.equal(recordCalls.length, 2);
  assert.equal(recordCalls[0].args.at(-1), "2");
  assert.deepEqual(recordCalls[1], recordCalls[0]);

  scripts.enqueue("playbackClaimV6", ["prune_pending"]);
  scripts.enqueue("playbackClaimV6", ["claimed", "not_found", "session_prune_claim_0001"]);
  const pruneClaimRequest = {
    attemptId: randomUUID(),
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: 1000,
  };
  assert.deepEqual(
    await repository.claim(
      PROFILE,
      DEVICE,
      pruneClaimRequest,
      playbackClaimOptions("session_prune_claim_0001", pruneClaimRequest)
    ),
    { status: "not_found", sessionId: "session_prune_claim_0001" }
  );
  const claimCalls = scripts.calls.filter((call) => call.name === "playbackClaimV6");
  assert.equal(claimCalls.length, 2);
  assert.equal(claimCalls[0].args[16], "2");
  assert.deepEqual(claimCalls[1], claimCalls[0]);

  scripts.enqueue("playbackRelease", ["prune_pending"]);
  scripts.enqueue("playbackRelease", ["not_found"]);
  assert.equal(await repository.release(PROFILE, DEVICE, "session_prune_retry_0001"), false);
  const releaseCalls = scripts.calls.filter((call) => call.name === "playbackRelease");
  assert.equal(releaseCalls.length, 2);
  assert.equal(releaseCalls[0].args[6], "2");
  assert.match(releaseCalls[0].args[7], /^g1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(releaseCalls[1], releaseCalls[0]);

  scripts.enqueue("playbackGetActiveClaim", ["prune_pending"]);
  scripts.enqueue("playbackGetActiveClaim", ["not_found"]);
  assert.equal(
    await repository.getActiveClaim(PROFILE, DEVICE, "session_prune_retry_0001"),
    null
  );
  const activeCalls = scripts.calls.filter((call) => call.name === "playbackGetActiveClaim");
  assert.equal(activeCalls.length, 2);
  assert.equal(activeCalls[0].args[6], "2");
  assert.equal(activeCalls[0].args[7], releaseCalls[0].args[7]);
  assert.deepEqual(activeCalls[1], activeCalls[0]);
});

test("playback fake exposes exact prune continuation state and bounded arguments", async () => {
  const scripts = new FakeScripts(1000);
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client: fakeClient(),
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    pruneBatchSize: 7,
    pruneEntryBatchSize: 3,
    sourceContextOptions: {
      tombstoneTtlMs: 2000,
      maxTombstones: 19,
      maxTombstonesPerProfile: 7,
    },
  });
  scripts.enqueue("playbackPrune", ["pruned", "4", "5", "6", "1"]);

  assert.deepEqual(await repository.prune(), {
    contexts: 4,
    claims: 5,
    tombstones: 6,
    hasMore: true,
  });
  assert.deepEqual(scripts.calls.at(-1).args, ["2000", "19", "7", "7", "3"]);
});

test("playback fake provider mutation fence owns the durable commit boundary", async () => {
  const scripts = new FakeScripts(1000);
  let generation = "g1:fence_1";
  let sequence = 0;
  const client = fakeClient();
  client.get = async () => generation;
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client,
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    generationFactory: () => "g1:fence_" + String(++sequence),
    sourceContextOptions: {
      providerMutationLeaseMs: 10,
    },
  });

  scripts.enqueue("playbackRecord", (call) => {
    assertHashedKeys(call);
    assert.equal(call.keys.length, 19);
    assert.deepEqual(call.args.slice(2), ["snapshot_state", generation]);
    return ["snapshot_state", generation, "0"];
  });
  scripts.enqueue("playbackRecord", (call) => {
    assert.equal(call.keys.length, 19);
    assert.equal(call.args[2], "snapshot_begin");
    assert.equal(call.args[3], "g1:fence_1");
    assert.equal(call.args[4], "1010");
    generation = call.args[1];
    return ["snapshot_begun", generation, "0"];
  });
  const token = await repository.beginProviderSnapshotMutation(PROFILE);

  scripts.enqueue("playbackRecord", (call) => {
    assert.equal(call.args[2], "snapshot_renew");
    assert.equal(call.args[3], token);
    return ["snapshot_renewed", "1010", "1"];
  });
  assert.deepEqual(await repository.renewProviderSnapshotMutation(PROFILE, token), {
    renewed: true,
    expiresAt: 1010,
  });

  scripts.enqueue("playbackRecord", (call) => {
    assert.equal(call.args[2], "snapshot_fence");
    assert.equal(call.args[3], token);
    assert.equal(call.args[4], "1");
    return ["snapshot_fenced", "1"];
  });
  assert.deepEqual(await repository.fenceProviderSnapshotMutation(PROFILE, token, "1"), {
    token,
    fence: "1",
  });

  scripts.enqueue("playbackRecord", (call) => {
    assert.equal(call.args[2], "snapshot_complete");
    assert.equal(call.args[3], token);
    generation = call.args[1];
    return ["snapshot_completed", generation];
  });
  const stable = await repository.completeProviderSnapshotMutation(PROFILE, token);
  assert.equal(stable, "g1:fence_3");

  scripts.enqueue("playbackRecord", ["snapshot_changed", stable]);
  assert.deepEqual(await repository.renewProviderSnapshotMutation(PROFILE, token), {
    renewed: false,
  });
  assert.equal(await repository.releaseProviderSnapshotMutation(PROFILE, token), false);
  scripts.enqueue("playbackRecord", ["snapshot_changed", stable]);
  await assert.rejects(
    repository.fenceProviderSnapshotMutation(PROFILE, token, "2"),
    (error) => error.code === "provider_snapshot_changed"
  );
});

test("playback fake provider recovery raises its durable candidate and completes exactly", async () => {
  const scripts = new FakeScripts(1020);
  const token = "g1:w_1010_" + "a".repeat(43);
  let generation = token;
  const client = fakeClient();
  client.get = async () => generation;
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client,
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    generationFactory: () => "g1:recovered",
  });
  scripts.generations.set(repository._generationKey(PROFILE), token);

  scripts.enqueue("playbackRecord", (call) => {
    assert.equal(call.args[1], "");
    assert.equal(call.args[2], "snapshot_recover_probe");
    assert.equal(call.args[3], token);
    return ["snapshot_recovery_ready", token, "1", "fenced"];
  });
  assert.deepEqual(await repository.probeProviderSnapshotRecovery(PROFILE), {
    token,
    fence: "1",
    phase: "fenced",
  });

  for (const candidate of ["2", "3"]) {
    scripts.enqueue("playbackRecord", (call) => {
      assert.equal(call.args[1], "");
      assert.equal(call.args[2], "snapshot_recover_begin");
      assert.equal(call.args[3], token);
      assert.equal(call.args[4], candidate);
      return ["snapshot_recovery_begun", token, candidate];
    });
    assert.deepEqual(await repository.beginProviderSnapshotRecovery(PROFILE, candidate), {
      token,
      fence: candidate,
    });
  }

  scripts.enqueue("playbackRecord", (call) => {
    assert.equal(call.args[1], "g1:recovered");
    assert.equal(call.args[2], "snapshot_recover_complete");
    assert.equal(call.args[3], token);
    assert.equal(call.args[4], "3");
    generation = call.args[1];
    return ["snapshot_recovery_completed", generation];
  });
  assert.equal(
    await repository.completeProviderSnapshotRecovery(PROFILE, token, "3"),
    "g1:recovered"
  );
  assert.equal(await repository.probeProviderSnapshotRecovery(PROFILE), null);
});

test("playback fake invalidation advances repository-visible generation atomically", async () => {
  const scripts = new FakeScripts(1000);
  let generation = "g1:0";
  const client = fakeClient();
  client.get = async () => generation;
  const repository = new RedisPlaybackContextRepository({
    writeVersion: "4",
    client,
    scriptRunner: scripts,
    envelopeCrypto: envelopeCrypto(),
    generationFactory: () => "g1:next",
    sourceContextOptions: {
      idFactory: () => "context_generation_fake_0001",
      ttlMs: 1000,
    },
  });

  scripts.enqueue("playbackRecord", (call) => {
    assertHashedKeys(call);
    assert.equal(call.keys.length, 19);
    assert.equal(call.args[2], "snapshot_state");
    return ["snapshot_state", generation, "0"];
  });
  scripts.enqueue("playbackRecord", (call) => {
    assertHashedKeys(call);
    assert.equal(call.keys.length, 19);
    assert.equal(call.args[1], "g1:next");
    assert.equal(call.args[2], "snapshot_invalidate");
    generation = call.args[1];
    return ["invalidated", generation];
  });
  assert.equal(await repository.invalidateProfile(PROFILE), "g1:next");
  assert.equal(await repository.getProfileGeneration(PROFILE), "g1:next");

  scripts.enqueue("playbackRecord", ["generation_changed"]);
  await assert.rejects(
    repository.record(
      PROFILE,
      { source: { url: "https://cdn.example/stale-generation.mkv" }, display: {} },
      { generation: "g1:0" }
    ),
    (error) => error.code === "profile_generation_changed"
  );
});
test("playback prune batch is conservatively bounded at construction", () => {
  const options = {
    client: fakeClient(),
    scriptRunner: new FakeScripts(),
    envelopeCrypto: envelopeCrypto(),
  };
  assert.throws(
    () => new RedisPlaybackContextRepository({ ...options, pruneBatchSize: 0 }),
    /playback prune batch size/
  );
  assert.throws(
    () => new RedisPlaybackContextRepository({ ...options, pruneBatchSize: 257 }),
    /playback prune batch size/
  );
  assert.throws(
    () => new RedisPlaybackContextRepository({ ...options, pruneEntryBatchSize: 0 }),
    /playback prune entry batch size/
  );
  assert.throws(
    () => new RedisPlaybackContextRepository({ ...options, pruneEntryBatchSize: 257 }),
    /playback prune entry batch size/
  );
});

test("factory exposes the complete TTL repository contract with one injected client", () => {
  const scripts = new FakeScripts();
  const options = {
    client: fakeClient(),
    scriptRunner: scripts,
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  };
  const repositories = createRedisTtlRepositories(options);
  for (const [name, repository] of Object.entries(repositories)) assert.equal(assertRepository(name, repository), repository);
});

test("factory allowlists nested options without replacing shared Redis dependencies", () => {
  const scripts = new FakeScripts();
  const tokens = tokenService();
  const envelopes = envelopeCrypto();
  const keyspace = new RedisKeyspace("jg:v7");
  const options = {
    client: fakeClient(),
    scriptRunner: scripts,
    tokenService: tokens,
    envelopeCrypto: envelopes,
    keyspace,
    ttlMs: 2000,
    pairings: { ttlMs: 1000 },
    playbackContexts: { pruneBatchSize: 7, pruneEntryBatchSize: 3 },
  };
  const repositories = createRedisTtlRepositories(options);

  for (const repository of Object.values(repositories)) {
    assert.equal(repository._keys, keyspace);
    assert.equal(repository._scripts, scripts);
  }
  assert.equal(repositories.pairings._tokens, tokens);
  assert.equal(repositories.pairings._crypto, envelopes);
  assert.equal(repositories.pairings._ttlMs, 1000);
  assert.equal(repositories.oauthStates._ttlMs, 2000);
  assert.equal(repositories.playbackContexts._pruneBatchSize, 7);
  assert.equal(repositories.playbackContexts._pruneEntryBatchSize, 3);

  for (const optionName of [
    "client",
    "tokenService",
    "envelopeCrypto",
    "keyspace",
    "keyPrefix",
    "scriptRunner",
  ]) {
    assert.throws(
      () =>
        createRedisTtlRepositories({
          ...options,
          pairings: { [optionName]: {} },
        }),
      new RegExp("may not override shared " + optionName)
    );
  }
  assert.throws(
    () => createRedisTtlRepositories({ ...options, pairings: { unsupported: true } }),
    /Redis option is not supported: unsupported/
  );
});
