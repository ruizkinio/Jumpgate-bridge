"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { ClaimBoundHistoryService } = require("../lib/claim-bound-history-service");
const {
  HISTORY_GRANT_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  digestHistoryEventRequest,
  normalizeHistoryEventBody,
} = require("../lib/history-protocol");
const {
  EnvelopeCrypto,
  MemoryHistoryGrantRepository,
  MemoryHistoryRepository,
  REPOSITORY_CONTRACTS,
  REQUIRED_REPOSITORY_NAMES,
  TokenService,
  assertRepository,
  createMemoryDurableRepositories,
} = require("../lib/storage");

const PROFILE_ID = "profile_history_grants";
const DEVICE_ID = "device_history_grants";
const PLAYBACK_GENERATION = "g1:history-memory";

function deterministicRandom() {
  let counter = 0;
  return (size) => {
    counter += 1;
    const value = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) value[index] = (counter + index) & 0xff;
    return value;
  };
}

function uuid(number) {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function contentKey(number) {
  return sha256("history-content-" + number);
}

function createHarness() {
  let now = 10_000;
  let grantSequence = 0;
  let sessionSequence = 0;
  const randomBytes = deterministicRandom();
  const profile = {
    id: PROFILE_ID,
    status: "active",
    revision: 1,
    historyGeneration: 1,
  };
  const devices = new Map([[DEVICE_ID, { generation: 1, active: true }]]);
  const tokenService = new TokenService({ pepper: Buffer.alloc(32, 0x41), randomBytes });
  const envelopeCrypto = new EnvelopeCrypto({
    primaryKeyId: "history-grants",
    keys: { "history-grants": Buffer.alloc(32, 0x42) },
    randomBytes,
  });
  const history = new MemoryHistoryRepository({
    clock: () => now,
    isProfileActive: async (profileId) => profileId === profile.id && profile.status === "active",
    getGeneration: async (profileId) =>
      profileId === profile.id && profile.status === "active"
        ? profile.historyGeneration
        : null,
    isDeviceBindingActive: async (profileId, deviceId, generation) => {
      const device = devices.get(deviceId);
      return Boolean(
        profileId === profile.id &&
          device &&
          device.active &&
          device.generation === generation
      );
    },
  });
  const repository = new MemoryHistoryGrantRepository({
    tokenService,
    envelopeCrypto,
    historyRepository: history,
    clock: () => now,
    getProfileBinding: async (profileId) => (profileId === profile.id ? { ...profile } : null),
    isDeviceBindingActive: async (profileId, deviceId, generation) => {
      const device = devices.get(deviceId);
      return Boolean(
        profileId === profile.id &&
          device &&
          device.active &&
          device.generation === generation
      );
    },
    getHistoryGeneration: async (profileId) =>
      profileId === profile.id && profile.status === "active"
        ? profile.historyGeneration
        : null,
    grantIdFactory: () => `history_grant_${String(++grantSequence).padStart(6, "0")}`,
    sessionIdFactory: () => `history_session_${String(++sessionSequence).padStart(6, "0")}`,
  });
  return {
    devices,
    envelopeCrypto,
    history,
    profile,
    repository,
    tokenService,
    advance(milliseconds = 1) {
      now += milliseconds;
    },
  };
}

function binding(harness) {
  return {
    profileId: harness.profile.id,
    profileRevision: harness.profile.revision,
    deviceId: DEVICE_ID,
    deviceGeneration: harness.devices.get(DEVICE_ID).generation,
    historyGeneration: harness.profile.historyGeneration,
    playbackGeneration: PLAYBACK_GENERATION,
  };
}

function sourceAuthority(harness, reservation, kind, number) {
  const base = {
    ...binding(harness),
    providerRevision: kind === "negative" ? null : "7",
    contextId: kind === "negative" ? null : `context_history_${String(number).padStart(4, "0")}`,
    contextRevision: kind === "negative" ? null : "3",
    sessionId: reservation.sessionId,
    contentKey: kind === "negative" ? null : contentKey(number),
    canonicalIdentity:
      kind === "canonical"
        ? {
            provider: "imdb",
            id: "tt0133093",
            mediaType: "movie",
            provenance: "metadata-request",
            confidence: "canonical",
          }
        : null,
    displaySnapshot: kind === "negative" ? {} : { title: `History ${kind} ${number}`, year: 1999 },
    claimStatus: kind === "negative" ? "not_found" : "claimed",
    traktEligible: kind === "canonical",
    supersededSessionId: null,
  };
  return base;
}

async function reserveAndFinalize(harness, kind = "canonical", number = 1) {
  const requestDigest = sha256("claim-request-" + number);
  const reservation = await harness.repository.reserve({
    attemptId: uuid(number),
    requestDigest,
    ...binding(harness),
  });
  const authority = sourceAuthority(harness, reservation, kind, number);
  const grant = await harness.repository.finalize({
    grantId: reservation.grantId,
    requestDigest,
    authority,
  });
  return { authority, grant, requestDigest, reservation };
}

function eventBody(overrides = {}) {
  return {
    event: "start",
    sessionRevision: 1,
    positionMs: 20_000,
    durationMs: 100_000,
    watchedMs: 18_000,
    playbackPreferences: {
      subtitleTrackId: "subtitle_track_eng",
      audioTrackId: "audio_track_original",
      subtitlesEnabled: true,
      subtitleLanguages: ["eng"],
    },
    ...overrides,
  };
}

function eventInput(grant, idempotencyKey, body = eventBody()) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    profileId: grant.profileId,
    deviceId: grant.deviceId,
    grantToken: grant.grantToken,
    idempotencyKey,
    requestDigest: digestHistoryEventRequest(rawBody),
    event: normalizeHistoryEventBody(body),
  };
}

test("memory reservation is concurrent-idempotent and persists only token hash plus envelope", async () => {
  const harness = createHarness();
  const input = {
    attemptId: uuid(1),
    requestDigest: sha256("exact raw claim bytes"),
    ...binding(harness),
  };
  const [first, second] = await Promise.all([
    harness.repository.reserve(input),
    harness.repository.reserve(input),
  ]);
  assert.deepEqual(second, first);
  assert.match(first.grantToken, /^hg1_/);
  assert.equal(first.sessionId, second.sessionId);

  await assert.rejects(
    () => harness.repository.reserve({ ...input, requestDigest: sha256("changed raw claim bytes") }),
    (error) => error.code === "history_claim_conflict" && error.status === 409
  );

  const snapshot = harness.repository.storageSnapshot();
  assert.equal(snapshot.grants.length, 1);
  assert.match(snapshot.grants[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(typeof snapshot.grants[0].tokenEnvelope.ct, "string");
  assert.equal(JSON.stringify(snapshot).includes(first.grantToken), false);
});

test("canonical events atomically converge concurrent retries and reject changed duplicate bytes", async () => {
  const harness = createHarness();
  const { authority, grant } = await reserveAndFinalize(harness, "canonical", 2);
  const idempotencyKey = uuid(102);
  const input = eventInput(grant, idempotencyKey);
  const [first, concurrentReplay] = await Promise.all([
    harness.repository.applyEvent(input),
    harness.repository.applyEvent(input),
  ]);
  assert.deepEqual(concurrentReplay, first);
  assert.equal(first.status, "applied");
  assert.equal(first.grantKind, "canonical");
  assert.equal(first.sessionRevision, 1);
  assert.equal(first.history.contentKey, authority.contentKey);
  assert.deepEqual(first.history.canonicalIdentity, authority.canonicalIdentity);
  assert.equal(first.dispatchIntent.event, "start");
  assert.deepEqual(await harness.repository.applyEvent(input), first);

  const changed = eventInput(
    grant,
    idempotencyKey,
    eventBody({ positionMs: 21_000, watchedMs: 19_000 })
  );
  await assert.rejects(
    () => harness.repository.applyEvent(changed),
    (error) => error.code === "history_event_idempotency_conflict"
  );

  const stored = await harness.history.get(harness.profile.id, authority.contentKey);
  assert.equal(stored.revision, 1);
  const snapshot = harness.repository.storageSnapshot();
  assert.equal(snapshot.receipts.length, 1);
  assert.equal(snapshot.dispatchIntents.length, 1);
});

test("canonical, local, and negative grants isolate cloud history and Trakt intent behavior", async () => {
  const harness = createHarness();
  const canonical = await reserveAndFinalize(harness, "canonical", 10);
  const local = await reserveAndFinalize(harness, "local", 11);
  const negative = await reserveAndFinalize(harness, "negative", 12);

  const canonicalResult = await harness.repository.applyEvent(
    eventInput(canonical.grant, uuid(210))
  );
  const localResult = await harness.repository.applyEvent(eventInput(local.grant, uuid(211)));
  const negativeResult = await harness.repository.applyEvent(
    eventInput(negative.grant, uuid(212))
  );

  assert.equal(canonical.grant.kind, "canonical");
  assert.equal(local.grant.kind, "local");
  assert.equal(negative.grant.kind, "negative");
  assert.ok(canonicalResult.history);
  assert.ok(canonicalResult.dispatchIntent);
  assert.ok(localResult.history);
  assert.equal(localResult.history.canonicalIdentity, null);
  assert.equal(localResult.dispatchIntent, null);
  assert.equal(negativeResult.status, "local_only");
  assert.equal(negativeResult.history, null);
  assert.equal(negativeResult.dispatchIntent, null);
  assert.equal(await harness.history.get(harness.profile.id, canonical.authority.contentKey) !== null, true);
  assert.equal(await harness.history.get(harness.profile.id, local.authority.contentKey) !== null, true);
  assert.equal(harness.repository.storageSnapshot().dispatchIntents.length, 1);
});

test("session transitions are revision-bound and released grants replay only the terminal receipt", async () => {
  const harness = createHarness();
  const { grant } = await reserveAndFinalize(harness, "canonical", 20);
  const startInput = eventInput(grant, uuid(320));
  const start = await harness.repository.applyEvent(startInput);
  assert.equal(start.sessionRevision, 1);
  assert.equal(start.sessionState, "playing");

  const pauseInput = eventInput(
    grant,
    uuid(321),
    eventBody({ event: "pause", sessionRevision: 1 })
  );
  const paused = await harness.repository.applyEvent(pauseInput);
  assert.equal(paused.sessionRevision, 2);
  assert.equal(paused.sessionState, "paused");
  assert.deepEqual(await harness.repository.applyEvent(startInput), start);

  const resumed = await harness.repository.applyEvent(
    eventInput(grant, uuid(322), eventBody({ event: "resume", sessionRevision: 2 }))
  );
  assert.equal(resumed.sessionRevision, 3);
  assert.equal(resumed.sessionState, "playing");

  const stopKey = uuid(323);
  const stopInput = eventInput(
    grant,
    stopKey,
    eventBody({ event: "stop", sessionRevision: 3 })
  );
  const stopped = await harness.repository.applyEvent(stopInput);
  assert.equal(stopped.sessionRevision, 4);
  assert.equal(stopped.sessionState, "released");
  assert.deepEqual(await harness.repository.applyEvent(stopInput), stopped);
  await assert.rejects(
    () => harness.repository.applyEvent(startInput),
    (error) => error.code === "history_grant_released"
  );
  await assert.rejects(
    () =>
      harness.repository.applyEvent(
        eventInput(
          grant,
          stopKey,
          eventBody({ event: "completion", sessionRevision: 3, positionMs: 100_000, watchedMs: 100_000 })
        )
      ),
    (error) => error.code === "history_event_idempotency_conflict"
  );
});

test("presented profile and device are checked before terminal receipt replay", async () => {
  const harness = createHarness();
  const { grant } = await reserveAndFinalize(harness, "canonical", 25);
  const terminal = eventInput(
    grant,
    uuid(425),
    eventBody({ event: "stop", sessionRevision: 1 })
  );
  const stopped = await harness.repository.applyEvent(terminal);

  for (const mismatch of [
    { profileId: "profile_history_grants_other" },
    { deviceId: "device_history_grants_other" },
  ]) {
    await assert.rejects(
      () => harness.repository.applyEvent({ ...terminal, ...mismatch }),
      (error) => error.code === "history_grant_invalid" && error.status === 401
    );
  }
  assert.deepEqual(await harness.repository.applyEvent(terminal), stopped);
});

test("grant freshness is validated before exact receipt replay", async () => {
  const harness = createHarness();
  const { grant } = await reserveAndFinalize(harness, "canonical", 30);
  const input = eventInput(grant, uuid(430));
  await harness.repository.applyEvent(input);
  await harness.repository.revokeHistory(harness.profile.id, harness.profile.historyGeneration);

  await assert.rejects(
    () => harness.repository.applyEvent(input),
    (error) => error.code === "history_grant_stale"
  );
  assert.equal(harness.repository.storageSnapshot().receipts.length, 1);
});

test("all profile, device, history, playback, session, source, and supersession revocations fence events", async (t) => {
  const cases = [
    ["profile", async (harness, grant) => harness.repository.revokeProfile(harness.profile.id, grant.authority.profileRevision)],
    ["device", async (harness, grant) => harness.repository.revokeDevice(harness.profile.id, DEVICE_ID, grant.authority.deviceGeneration)],
    ["history", async (harness, grant) => harness.repository.revokeHistory(harness.profile.id, grant.authority.historyGeneration)],
    ["playback", async (harness, grant) => harness.repository.revokePlayback(harness.profile.id, grant.authority.playbackGeneration)],
    ["session", async (harness, grant) => harness.repository.revokeSession(harness.profile.id, grant.grant.sessionId)],
    ["source", async (harness, grant) => harness.repository.revokeSource({
      profileId: harness.profile.id,
      contextId: grant.authority.contextId,
      playbackGeneration: grant.authority.playbackGeneration,
      providerRevision: grant.authority.providerRevision,
      contextRevision: grant.authority.contextRevision,
    })],
    ["supersession", async (harness, grant) => harness.repository.supersede(
      harness.profile.id,
      DEVICE_ID,
      grant.grant.sessionId,
      "history_session_replacement"
    )],
  ];

  let number = 40;
  for (const [name, revoke] of cases) {
    await t.test(name, async () => {
      number += 1;
      const harness = createHarness();
      const grant = await reserveAndFinalize(harness, "canonical", number);
      await revoke(harness, grant);
      await assert.rejects(
        () => harness.repository.applyEvent(eventInput(grant.grant, uuid(500 + number))),
        (error) => error.code === "history_grant_stale"
      );
    });
  }
});

test("claim-bound service reserves durably before source claim and finalizes only active server authority", async () => {
  const harness = createHarness();
  let observedReserved = false;
  let capturedOptions = null;
  const playbackContexts = {
    async claim(profileId, deviceId, request, options) {
      capturedOptions = { profileId, deviceId, request, options };
      const grant = harness.repository.storageSnapshot().grants.find(
        (item) => item.sessionId === options.sessionId
      );
      observedReserved = Boolean(grant && grant.status === "reserved");
      return { status: "claimed", sessionId: options.sessionId };
    },
    async getActiveClaim(profileId, deviceId, sessionId) {
      return {
        status: "claimed",
        sessionId,
        context: {
          contentKey: contentKey(60),
          canonicalIdentity: {
            provider: "imdb",
            id: "tt0133093",
            mediaType: "movie",
            provenance: "metadata-request",
            confidence: "canonical",
          },
          display: { title: "The Matrix", year: 1999 },
          traktEligible: true,
        },
        deliveryBinding: {
          profileId,
          deviceId,
          sessionId,
          generation: PLAYBACK_GENERATION,
          providerRevision: "9",
          contextId: "context_history_service",
          contextRevision: "4",
        },
      };
    },
  };
  const service = new ClaimBoundHistoryService({
    historyGrants: harness.repository,
    playbackContexts,
  });
  const rawClaim = Buffer.from(JSON.stringify({
    attemptId: uuid(60),
    fingerprints: ["sha256:" + "1".repeat(64)],
    intentUrlHash: "2".repeat(64),
    launchedAt: 10_000,
  }));
  const result = await service.claim(binding(harness), rawClaim);
  assert.equal(observedReserved, true);
  assert.equal(result.historyGrantKind, "canonical");
  assert.match(result.historyGrant, /^hg1_/);
  assert.equal(capturedOptions.options.sessionId, result.sessionId);
  assert.equal(capturedOptions.options.requestDigest, sha256([
    "jumpgate-playback-claim-request:v1",
    "POST",
    "/v1/playback/claim",
  ].join("\0") + "\0" + rawClaim.toString("utf8")));

  const rawEvent = Buffer.from(JSON.stringify(eventBody()));
  const applied = await service.applyEvent(
    binding(harness),
    {
      [HISTORY_GRANT_HEADER]: result.historyGrant,
      [IDEMPOTENCY_KEY_HEADER]: uuid(160),
    },
    rawEvent
  );
  assert.equal(applied.history.contentKey, contentKey(60));
  assert.equal(applied.dispatchIntent.canonicalIdentity.id, "tt0133093");
});

test("memory factory exposes the required atomic history grant contract", () => {
  const randomBytes = deterministicRandom();
  const repositories = createMemoryDurableRepositories({
    tokenService: new TokenService({ pepper: Buffer.alloc(32, 0x51), randomBytes }),
    envelopeCrypto: new EnvelopeCrypto({
      primaryKeyId: "factory-history",
      keys: { "factory-history": Buffer.alloc(32, 0x52) },
      randomBytes,
    }),
  });
  assert.equal(REQUIRED_REPOSITORY_NAMES.includes("historyGrants"), true);
  assert.equal(REPOSITORY_CONTRACTS.historyGrants.includes("applyEvent"), true);
  assert.equal(REPOSITORY_CONTRACTS.historyGrants.includes("abandon"), true);
  assert.equal(REPOSITORY_CONTRACTS.historyGrants.includes("commitClaimResponse"), true);
  assert.equal(REPOSITORY_CONTRACTS.historyGrants.includes("prune"), true);
  assert.equal(REPOSITORY_CONTRACTS.historyGrants.includes("clearHistory"), true);
  assert.equal(assertRepository("historyGrants", repositories.historyGrants), repositories.historyGrants);
  const missingAtomicClear = Object.create(repositories.historyGrants);
  missingAtomicClear.clearHistory = undefined;
  assert.throws(
    () => assertRepository("historyGrants", missingAtomicClear),
    /historyGrants repository must implement clearHistory\(\)/
  );
  assert.equal(
    repositories.historyGrants._lifecycleCoordinator,
    repositories.playbackSessions._lifecycleCoordinator
  );
});
