"use strict";

const crypto = require("node:crypto");
const {
  SourceContextStore,
  fingerprintStream,
  mergeStoredContext,
  validateStoredContext,
} = require("../../source-context");
const {
  assertPlainObject,
  assertPositiveInteger,
  codedError,
} = require("../repository-utils");
const { initializeRedisOptions, jsonParse, jsonStringify } = require("./base");
const { asArray, asInteger, asString } = require("./reply");
const { RedisScriptRunner } = require("./script-runner");
const { CANONICAL_UUID_PATTERN } = require("../../history-protocol");

const MAX_DATE_MS = 8640000000000000;
const DEFAULT_PRUNE_BATCH_SIZE = 32;
const DEFAULT_PRUNE_ENTRY_BATCH_SIZE = 32;
const MAX_PRUNE_BATCH_SIZE = 256;
const MAX_PRUNE_DRAIN_PASSES = 64;
const INITIAL_PROFILE_GENERATION = "g1:0";
const PROFILE_GENERATION_PATTERN = /^g1:[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_PENDING_GENERATION_PATTERN = /^g1:w_([0-9]{1,16})_[A-Za-z0-9_-]{43}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,127})$/;
const MAX_RECORD_RETRIES = 16;
const MAX_CLAIM_RETRIES = 16;
const DEFAULT_PROVIDER_MUTATION_LEASE_MS = 30_000;
const DEFAULT_CLAIM_DISCLOSURE_LEASE_MS = 5_000;
const MAX_CLAIM_DISCLOSURE_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_CLAIM_LEASES_PER_ATTEMPT = 32;
const DEFAULT_WRITE_VERSION = "3";
const WRITE_VERSIONS = new Set(["3", "4"]);
const CLAIM_STATE_VERSION = "5";
const CLAIM_WRITER_PROTOCOL_V5 = "5";
const CLAIM_WRITER_PROTOCOL_V6 = "6";
const CLAIM_WRITER_ROLLOUT_ENV = "JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE";
const CLAIM_WRITER_ROLLOUT_MODES = new Set(["transition", "v6"]);
const CLAIM_ATTEMPT_FINGERPRINT_KEY_KIND = "playback-claim-attempt-fingerprint-v1";
const ISOLATED_CLAIM = Symbol("isolatedClaim");
const PLAYBACK_CLAIM_CLEANUP_OWNER = Symbol.for(
  "jumpgate.playbackClaimCleanupOwner"
);
const CLAIM_OPTION_KEYS = new Set([
  "generation",
  "deviceGeneration",
  "signal",
  "sessionId",
  "requestDigest",
]);

const PROFILE_KEY_INDEX = Object.freeze({
  root: 0,
  contexts: 1,
  contextExpiries: 2,
  contextOrder: 3,
  equivalences: 4,
  claims: 5,
  claimExpiries: 6,
  claimOrder: 7,
  tombstones: 8,
  tombstoneGlobals: 9,
  tombstoneOrder: 10,
  globalContexts: 11,
  globalClaims: 12,
  globalTombstones: 13,
  schedule: 14,
  generation: 15,
});

function assertPlaybackIdentifier(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertCanonicalAttemptId(value) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw new TypeError("attemptId must be a canonical UUID");
  }
  return value;
}

function assertGeneration(value) {
  if (typeof value !== "string" || !PROFILE_GENERATION_PATTERN.test(value)) {
    throw new TypeError("profile generation is invalid");
  }
  return value;
}

function assertWriteVersion(value) {
  const normalized = String(value);
  if (!WRITE_VERSIONS.has(normalized)) {
    throw new TypeError("playback writeVersion must be \"3\" or \"4\"");
  }
  return normalized;
}

function assertOptionalAbortSignal(signal) {
  if (signal === undefined) return null;
  if (
    !signal ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("playback claim signal is invalid");
  }
  return signal;
}

function abortReason(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const error = new Error("playback claim was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function providerPendingDeadline(generation) {
  const match = String(generation).match(PROVIDER_PENDING_GENERATION_PATTERN);
  if (!match) return null;
  const deadline = Number(match[1]);
  return Number.isSafeInteger(deadline) && deadline >= 0 && deadline <= MAX_DATE_MS
    ? deadline
    : null;
}

function parseLaunchTimestamp(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_MS) {
    throw new TypeError("launchedAt must be a valid timestamp");
  }
  return timestamp;
}

function parseDecimal(value, name, maximum = BigInt(Number.MAX_SAFE_INTEGER)) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  const parsed = BigInt(value);
  if (parsed > maximum) throw new TypeError(name + " is invalid");
  return Number(parsed);
}

function decimalString(value, name, fallback = undefined) {
  const candidate = value === undefined ? fallback : value;
  let normalized;
  if (typeof candidate === "bigint") normalized = candidate.toString();
  else if (typeof candidate === "number") {
    if (!Number.isSafeInteger(candidate) || candidate < 0) throw new TypeError(name + " is invalid");
    normalized = String(candidate);
  } else normalized = candidate;
  if (typeof normalized !== "string" || !DECIMAL_PATTERN.test(normalized)) {
    throw new TypeError(name + " is invalid");
  }
  return normalized;
}

function toIso(value, name) {
  const timestamp = typeof value === "string"
    ? parseDecimal(value, name, BigInt(MAX_DATE_MS))
    : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_MS) {
    throw new TypeError(name + " is invalid");
  }
  return new Date(timestamp).toISOString();
}

function assertDigest(value, name, allowEmpty = false) {
  if (allowEmpty && value === "") return value;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function claimLeaseHash(value) {
  const token = assertPlaybackIdentifier(value, "playback claim disclosure lease");
  return crypto
    .createHash("sha256")
    .update("jumpgate-playback-claim-lease:v1\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

function claimFingerprintBinding(fingerprintHashes) {
  const hash = crypto.createHash("sha256");
  hash.update("jumpgate-playback-claim-fingerprints:v1\0", "utf8");
  for (const value of fingerprintHashes) {
    assertDigest(value, "playback fingerprint hash");
    hash.update(String(Buffer.byteLength(value, "utf8")) + ":", "ascii");
    hash.update(value, "utf8");
    hash.update("\0", "ascii");
  }
  return hash.digest("hex");
}

function assertClaimWriterRolloutMode(value) {
  if (typeof value !== "string" || !CLAIM_WRITER_ROLLOUT_MODES.has(value)) {
    throw new TypeError("playback claim writer rollout mode is invalid");
  }
  return value;
}

function assertClaimOptions(value) {
  const options = assertPlainObject(value, "playback claim options");
  for (const key of Reflect.ownKeys(options)) {
    if (
      (typeof key === "string" && CLAIM_OPTION_KEYS.has(key)) ||
      key === ISOLATED_CLAIM
    ) {
      continue;
    }
    throw new TypeError("playback claim options contains an unknown field: " + String(key));
  }
  return options;
}

function assertIsolatedClaim(value) {
  if (value === undefined) return null;
  const isolated = assertPlainObject(value, "isolated playback claim options");
  const keys = Reflect.ownKeys(isolated);
  if (keys.length !== 1 || keys[0] !== "cleanupOwner") {
    throw new TypeError("isolated playback claim options are invalid");
  }
  return {
    cleanupOwner: assertPlaybackIdentifier(
      isolated.cleanupOwner,
      "playback cleanup owner"
    ),
  };
}

function assertStringArray(value, name, maximum = 32) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(name + " is invalid");
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || item.length < 1 || item.length > 512 || seen.has(item)) {
      throw new TypeError(name + " is invalid");
    }
    seen.add(item);
  }
  return value;
}

function parseMetadata(raw) {
  const metadata = jsonParse(asString(raw, "playback context metadata"), "playback context metadata");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("Redis playback context metadata is invalid");
  }
  const common = [
    "v",
    "ref",
    "globalMember",
    "equivalenceHash",
    "fingerprintHashes",
    "fingerprintIndexKeys",
    "tombstoneMembers",
    "generation",
    "revision",
    "createdAtMs",
    "expiresAtMs",
    "envelope",
  ];
  const expected = metadata.v === "3"
    ? common
    : metadata.v === "4"
      ? [...common.slice(0, 9), "providerRevision", ...common.slice(9)]
      : [];
  if (
    Object.keys(metadata).length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(metadata, key))
  ) {
    throw new TypeError("Redis playback context metadata is invalid");
  }
  assertDigest(metadata.ref, "playback context ref");
  assertDigest(metadata.globalMember, "playback global context member");
  assertDigest(metadata.equivalenceHash, "playback equivalence hash", true);
  assertGeneration(metadata.generation);
  if (typeof metadata.revision !== "string" || !DECIMAL_PATTERN.test(metadata.revision)) {
    throw new TypeError("playback context revision is invalid");
  }
  if (metadata.v === "4") {
    decimalString(metadata.providerRevision, "playback provider revision");
  }
  const createdAtMs = parseDecimal(
    metadata.createdAtMs,
    "playback context creation time",
    BigInt(MAX_DATE_MS)
  );
  const expiresAtMs = parseDecimal(
    metadata.expiresAtMs,
    "playback context expiry",
    BigInt(MAX_DATE_MS)
  );
  if (expiresAtMs <= createdAtMs) throw new TypeError("playback context expiry is invalid");
  for (const name of ["fingerprintHashes", "tombstoneMembers"]) {
    assertStringArray(metadata[name], name);
    for (const value of metadata[name]) assertDigest(value, name + " item");
  }
  assertStringArray(metadata.fingerprintIndexKeys, "fingerprintIndexKeys");
  if (
    metadata.fingerprintHashes.length < 1 ||
    metadata.fingerprintHashes.length !== metadata.fingerprintIndexKeys.length ||
    metadata.fingerprintHashes.length !== metadata.tombstoneMembers.length ||
    typeof metadata.envelope !== "string" ||
    metadata.envelope.length < 2 ||
    metadata.envelope.length > 2 * 1024 * 1024
  ) {
    throw new TypeError("Redis playback context metadata is invalid");
  }
  return metadata;
}

function materializeContext(metadata, envelopeCrypto, purpose, expected = {}) {
  const stored = typeof metadata === "string" ? parseMetadata(metadata) : metadata;
  if (!envelopeCrypto || typeof envelopeCrypto.decryptJson !== "function") {
    throw new TypeError("envelopeCrypto is required to materialize a Redis playback context");
  }
  const privateRecord = envelopeCrypto.decryptJson(
    jsonParse(stored.envelope, "playback context envelope"),
    purpose
  );
  if (stored.v === "3") {
    return validateStoredContext(privateRecord, {
      ...expected,
      createdAt: toIso(stored.createdAtMs, "playback context creation time"),
      expiresAt: toIso(stored.expiresAtMs, "playback context expiry"),
    });
  }
  const privateKeys = ["context", "generation", "providerRevision", "revision", "v"];
  if (
    !privateRecord ||
    typeof privateRecord !== "object" ||
    Array.isArray(privateRecord) ||
    Object.keys(privateRecord).sort().some((key, index) => key !== privateKeys[index]) ||
    Object.keys(privateRecord).length !== privateKeys.length ||
    privateRecord.v !== 1 ||
    privateRecord.generation !== stored.generation ||
    privateRecord.revision !== stored.revision ||
    privateRecord.providerRevision !== stored.providerRevision
  ) {
    throw new TypeError("Redis playback context private binding is invalid");
  }
  return validateStoredContext(privateRecord.context, {
    ...expected,
    createdAt: toIso(stored.createdAtMs, "playback context creation time"),
    expiresAt: toIso(stored.expiresAtMs, "playback context expiry"),
  });
}

function sameStringArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function privateClaimPurpose(profileId, deviceId, sessionId) {
  const hash = crypto.createHash("sha256");
  for (const value of [profileId, deviceId, sessionId]) {
    hash.update(String(Buffer.byteLength(value, "utf8")) + ":", "ascii");
    hash.update(value, "utf8");
    hash.update("\0", "ascii");
  }
  return "playback-claim:v1:" + hash.digest("hex");
}

function sealPrivateClaimState(
  envelopeCrypto,
  profileId,
  deviceId,
  sessionId,
  supersededSessionId
) {
  return jsonStringify(
    envelopeCrypto.encryptJson(
      {
        v: 1,
        profileId,
        deviceId,
        sessionId,
        supersededSessionId,
      },
      privateClaimPurpose(profileId, deviceId, sessionId)
    ),
    "playback claim private state"
  );
}

function materializePrivateClaimState(
  raw,
  envelopeCrypto,
  profileId,
  deviceId,
  sessionId
) {
  const state = envelopeCrypto.decryptJson(
    jsonParse(asString(raw, "playback claim private state"), "playback claim private state"),
    privateClaimPurpose(profileId, deviceId, sessionId)
  );
  const expectedKeys = ["deviceId", "profileId", "sessionId", "supersededSessionId", "v"];
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    Object.keys(state).sort().some((key, index) => key !== expectedKeys[index]) ||
    Object.keys(state).length !== expectedKeys.length ||
    state.v !== 1 ||
    state.profileId !== profileId ||
    state.deviceId !== deviceId ||
    state.sessionId !== sessionId
  ) {
    throw new TypeError("Redis playback claim private binding is invalid");
  }
  if (state.supersededSessionId !== null) {
    assertPlaybackIdentifier(state.supersededSessionId, "superseded playback session id");
    if (state.supersededSessionId === sessionId) {
      throw new TypeError("Redis playback claim private binding is invalid");
    }
  }
  return Object.freeze(state);
}

function hasExpectedMetadataIdentity(metadata, context, profileId, keyspace) {
  const fingerprintHashes = context.fingerprints.map((fingerprint) =>
    keyspace.member("playback-fingerprint", fingerprint)
  );
  const expectedRef = keyspace.member("playback-context", profileId, context.contextId);
  const expectedGlobalMember = keyspace.member(
    "playback-global-context",
    profileId,
    context.contextId
  );
  const expectedFingerprintIndexKeys = fingerprintHashes.map((hash) =>
    keyspace.key("playback-fingerprint-index", profileId, hash)
  );
  const expectedTombstoneMembers = fingerprintHashes.map((hash) =>
    keyspace.member("playback-global-tombstone", profileId, hash)
  );
  const expectedEquivalenceHash =
    context.contentKey === null
      ? ""
      : keyspace.member(
          "playback-equivalence",
          context.contentKey,
          ...fingerprintHashes.slice().sort()
        );
  return (
    metadata.ref === expectedRef &&
    metadata.globalMember === expectedGlobalMember &&
    metadata.equivalenceHash === expectedEquivalenceHash &&
    sameStringArray(metadata.fingerprintHashes, fingerprintHashes) &&
    sameStringArray(metadata.fingerprintIndexKeys, expectedFingerprintIndexKeys) &&
    sameStringArray(metadata.tombstoneMembers, expectedTombstoneMembers)
  );
}

function materializeResponse(
  reply,
  envelopeCrypto,
  purpose,
  profileId,
  deviceId,
  expectedSessionId
) {
  const status = asString(reply[1], "playback claim result");
  const sessionId = assertPlaybackIdentifier(asString(reply[2], "sessionId"), "sessionId");
  if (sessionId !== expectedSessionId) {
    throw new TypeError("Redis playback claim session authority is invalid");
  }
  if (status !== "claimed") {
    if (reply.length !== 3 || !["ambiguous", "expired", "not_found"].includes(status)) {
      throw new TypeError("Redis playback claim is invalid");
    }
    return { status, sessionId };
  }
  if (reply.length !== 7) {
    throw new TypeError("Redis playback claim is invalid");
  }
  materializePrivateClaimState(
    reply[6],
    envelopeCrypto,
    profileId,
    deviceId,
    sessionId
  );
  return {
    status: "claimed",
    sessionId,
    context: materializeContext(asString(reply[3], "playback context metadata"), envelopeCrypto, purpose),
    claimedAt: toIso(asString(reply[4], "playback claim time"), "playback claim time"),
    expiresAt: toIso(asString(reply[5], "playback claim expiry"), "playback claim expiry"),
  };
}

function materializeActiveClaim(reply, sessionId, profileId, deviceId, keyspace, envelopeCrypto) {
  const status = asString(reply[0], "active playback claim status");
  if (status === "not_found") return reply.length === 1 ? null : null;
  if (status !== "active" || (reply.length !== 4 && reply.length !== 5)) return null;
  try {
    const raw = asString(reply[1], "active playback context metadata");
    const metadata = parseMetadata(raw);
    const context = materializeContext(
      metadata,
      envelopeCrypto,
      "playback-context:v1:" + metadata.ref,
      { profileId }
    );
    if (!hasExpectedMetadataIdentity(metadata, context, profileId, keyspace)) return null;
    const claimedAt = toIso(asString(reply[2], "active playback claim time"), "playback claim time");
    const expiresAt = toIso(asString(reply[3], "active playback claim expiry"), "playback claim expiry");
    const privateState = reply.length === 5
      ? materializePrivateClaimState(
          reply[4],
          envelopeCrypto,
          profileId,
          deviceId,
          sessionId
        )
      : null;
    const active = {
      status: "claimed",
      sessionId,
      context,
      claimedAt,
      expiresAt,
    };
    if (metadata.v === "4" && privateState) {
      active.deliveryBinding = {
        profileId,
        deviceId,
        sessionId,
        generation: metadata.generation,
        contextId: context.contextId,
        contextRevision: metadata.revision,
        providerRevision: metadata.providerRevision,
        ...(privateState.supersededSessionId
          ? { supersededSessionId: privateState.supersededSessionId }
          : {}),
      };
    }
    return deepFreeze(active);
  } catch (_error) {
    return null;
  }
}

class RedisPlaybackContextRepository {
  constructor(options = {}) {
    const shared = initializeRedisOptions(options);
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    this._client = shared.client;
    this._keys = shared.keyspace;
    this._scripts = shared.scripts;
    this._isolatedScriptRunnerFactory =
      options.isolatedScriptRunnerFactory || ((client) => new RedisScriptRunner(client));
    if (typeof this._isolatedScriptRunnerFactory !== "function") {
      throw new TypeError("isolatedScriptRunnerFactory must be a function");
    }
    this._cleanupOwnerFactory =
      options.cleanupOwnerFactory || (() => crypto.randomBytes(32).toString("base64url"));
    if (typeof this._cleanupOwnerFactory !== "function") {
      throw new TypeError("cleanupOwnerFactory must be a function");
    }
    this._crypto = options.envelopeCrypto;
    this._writeVersion = assertWriteVersion(options.writeVersion ?? DEFAULT_WRITE_VERSION);
    this._claimWriterRolloutMode = assertClaimWriterRolloutMode(
      options.claimWriterRolloutMode ?? process.env[CLAIM_WRITER_ROLLOUT_ENV] ?? "v6"
    );
    this._claimWriterProtocolRequirement =
      this._claimWriterRolloutMode === "transition" || process.env.NODE_ENV === "production"
        ? "required"
        : "allow_missing";

    const sourceOptions = options.sourceContextOptions || options;
    const idFactory = sourceOptions.idFactory || (() => crypto.randomUUID());
    if (typeof idFactory !== "function") throw new TypeError("idFactory must be a function");
    this._idFactory = idFactory;
    this._generationFactory = options.generationFactory ||
      (() => "g1:" + crypto.randomBytes(32).toString("base64url"));
    if (typeof this._generationFactory !== "function") {
      throw new TypeError("generationFactory must be a function");
    }
    this._sourceOptions = { ...sourceOptions };
    for (const key of [
      "clock",
      "now",
      "idFactory",
      "generationFactory",
      "writeVersion",
      "claimWriterRolloutMode",
      "envelopeCrypto",
      "pruneBatchSize",
      "pruneEntryBatchSize",
    ]) {
      delete this._sourceOptions[key];
    }

    const probe = new SourceContextStore({
      ...this._sourceOptions,
      clock: () => 0,
      idFactory: () => "validation-id",
    });
    this._ttlMs = probe._ttlMs;
    this._tombstoneTtlMs = probe._tombstoneTtlMs;
    this._deviceGenerationTtlMs = probe._deviceGenerationTtlMs;
    this._maxDeviceGenerationsPerProfile = probe._maxDeviceGenerationsPerProfile;
    this._maxContexts = probe._maxContexts;
    this._maxContextsPerProfile = probe._maxContextsPerProfile;
    this._maxClaims = probe._maxClaims;
    this._maxClaimsPerProfile = probe._maxClaimsPerProfile;
    this._maxClaimAttempts = probe._maxClaimAttempts;
    this._maxClaimAttemptsPerProfile = probe._maxClaimAttemptsPerProfile;
    this._maxTombstones = probe._maxTombstones;
    this._maxTombstonesPerProfile = probe._maxTombstonesPerProfile;
    this._maxLaunchAgeMs = probe._maxLaunchAgeMs;
    this._maxFutureLaunchSkewMs = probe._maxFutureLaunchSkewMs;
    this._maxContextAfterLaunchMs = probe._maxContextAfterLaunchMs;
    this._providerMutationLeaseMs =
      probe._providerMutationLeaseMs ?? DEFAULT_PROVIDER_MUTATION_LEASE_MS;
    this._claimDisclosureLeaseMs = options.claimDisclosureLeaseMs ??
      Math.min(DEFAULT_CLAIM_DISCLOSURE_LEASE_MS, this._ttlMs);
    assertPositiveInteger(
      this._claimDisclosureLeaseMs,
      "playback claim disclosure lease",
      Math.min(MAX_CLAIM_DISCLOSURE_LEASE_MS, this._ttlMs)
    );
    this._maxClaimLeasesPerAttempt = options.maxClaimLeasesPerAttempt ??
      DEFAULT_MAX_CLAIM_LEASES_PER_ATTEMPT;
    assertPositiveInteger(
      this._maxClaimLeasesPerAttempt,
      "playback claim leases per attempt",
      64
    );
    this._pruneBatchSize = options.pruneBatchSize ?? DEFAULT_PRUNE_BATCH_SIZE;
    assertPositiveInteger(
      this._pruneBatchSize,
      "playback prune batch size",
      MAX_PRUNE_BATCH_SIZE
    );
    this._pruneEntryBatchSize =
      options.pruneEntryBatchSize ?? DEFAULT_PRUNE_ENTRY_BATCH_SIZE;
    assertPositiveInteger(
      this._pruneEntryBatchSize,
      "playback prune entry batch size",
      MAX_PRUNE_BATCH_SIZE
    );

    this._globalContextsKey = this._keys.key("playback-global", "contexts");
    this._globalClaimsKey = this._keys.key("playback-global", "claims");
    this._globalTombstonesKey = this._keys.key("playback-global", "tombstones");
    this._scheduleKey = this._keys.key("playback-global", "profile-schedule");
    this._globalClaimAttemptsKey = this._keys.key("playback-global", "claim-attempts-v2");
    this._claimAttemptReconcileKey = this._keys.key(
      "playback-global",
      "claim-attempt-reconcile-v2"
    );
    this._globalClaimAttemptFingerprintsKey = this._keys.key(
      "playback-global",
      "claim-attempt-fingerprints-v1"
    );
    this._claimWriterProtocolKey = this._keys.key(
      "playback-claim-writer-protocol",
      "global"
    );
  }

  async getProfileGeneration(profileId, options = {}) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const supplied = assertPlainObject(options || {}, "playback generation options");
    const signal = assertOptionalAbortSignal(supplied.signal);
    const candidate = this._nextStableGeneration(id, INITIAL_PROFILE_GENERATION);
    const reply = asArray(
      await this._scripts.run(
        "playbackGetOrInitializeGeneration",
        [this._generationKey(id)],
        [candidate],
        signal ? { signal } : {}
      ),
      "playbackGetOrInitializeGeneration"
    );
    const status = asString(reply[0], "playback generation status");
    if (status === "profile_collision") throw new Error("Redis playback generation key collision");
    if (status !== "generation" || reply.length !== 2) {
      throw new Error("unexpected playback generation status: " + status);
    }
    return assertGeneration(asString(reply[1], "profile generation"));
  }

  async getProviderSnapshotState(profileId) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const observed = await this.getProfileGeneration(id);
    const recovery =
      providerPendingDeadline(observed) === null
        ? observed
        : this._nextStableGeneration(id, observed);
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [this._profileTag(id), recovery, "snapshot_state", observed]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot recovery status");
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_state") {
      throw new Error("unexpected provider snapshot recovery status: " + status);
    }
    const current = assertGeneration(asString(reply[1], "provider snapshot generation"));
    const pending = asString(reply[2], "provider snapshot pending state");
    if (pending !== "0" && pending !== "1") {
      throw new TypeError("provider snapshot state is invalid");
    }
    return Object.freeze({ generation: current, pending: pending === "1" });
  }

  async beginProviderSnapshotMutation(profileId) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const state = await this.getProviderSnapshotState(id);
    if (state.pending) {
      throw codedError("provider_snapshot_busy", "provider snapshot mutation is active");
    }
    const now = await this._scripts.timeMs();
    const deadline = now + this._providerMutationLeaseMs;
    if (!Number.isSafeInteger(deadline) || deadline > MAX_DATE_MS) {
      throw new RangeError("provider snapshot mutation deadline is invalid");
    }
    const seed = this._nextGeneration(id, state.generation);
    const digest = crypto
      .createHash("sha256")
      .update(id + "\0" + state.generation + "\0" + seed, "utf8")
      .digest("base64url");
    const pending = assertGeneration("g1:w_" + deadline + "_" + digest);
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [this._profileTag(id), pending, "snapshot_begin", state.generation, String(deadline)]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot begin status");
    if (status === "snapshot_busy" || status === "snapshot_changed") {
      throw codedError("provider_snapshot_busy", "provider snapshot mutation is active");
    }
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_begun") {
      throw new Error("unexpected provider snapshot begin status: " + status);
    }
    return assertGeneration(asString(reply[1], "provider snapshot mutation token"));
  }

  async renewProviderSnapshotMutation(profileId, token) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const expected = assertGeneration(token);
    if (providerPendingDeadline(expected) === null) {
      throw new TypeError("provider snapshot mutation token is invalid");
    }
    const now = await this._scripts.timeMs();
    const deadline = now + this._providerMutationLeaseMs;
    if (!Number.isSafeInteger(deadline) || deadline > MAX_DATE_MS) {
      throw new RangeError("provider snapshot mutation deadline is invalid");
    }
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [this._profileTag(id), "", "snapshot_renew", expected, String(deadline)]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot renewal status");
    if (status === "snapshot_changed") return Object.freeze({ renewed: false });
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_renewed") {
      throw new Error("unexpected provider snapshot renewal status: " + status);
    }
    return Object.freeze({
      renewed: true,
      expiresAt: asInteger(reply[1], "provider snapshot lease expiry"),
    });
  }

  async fenceProviderSnapshotMutation(profileId, token, mutationFence) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const expected = assertGeneration(token);
    if (providerPendingDeadline(expected) === null) {
      throw new TypeError("provider snapshot mutation token is invalid");
    }
    const fence = decimalString(mutationFence, "provider snapshot fence");
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [this._profileTag(id), "", "snapshot_fence", expected, fence]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot fence status");
    if (status === "snapshot_changed") {
      throw codedError("provider_snapshot_changed", "provider snapshot mutation was superseded");
    }
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_fenced") {
      throw new Error("unexpected provider snapshot fence status: " + status);
    }
    return Object.freeze({
      token: expected,
      fence: decimalString(
        asString(reply[1], "provider snapshot fence"),
        "provider snapshot fence"
      ),
    });
  }

  async probeProviderSnapshotRecovery(profileId) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const expected = await this.getProfileGeneration(id);
    if (providerPendingDeadline(expected) === null) return null;
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [this._profileTag(id), "", "snapshot_recover_probe", expected]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot recovery probe status");
    if (status === "snapshot_recovery_unavailable" || status === "snapshot_changed") return null;
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_recovery_ready") {
      throw new Error("unexpected provider snapshot recovery probe status: " + status);
    }
    const tokenValue = assertGeneration(
      asString(reply[1], "provider snapshot recovery probe token")
    );
    if (tokenValue !== expected) {
      throw new TypeError("provider snapshot recovery probe token is invalid");
    }
    return Object.freeze({
      token: tokenValue,
      fence: decimalString(
        asString(reply[2], "provider snapshot recovery probe fence"),
        "provider snapshot recovery probe fence"
      ),
      phase: (() => {
        const phase = asString(reply[3], "provider snapshot recovery probe phase");
        if (phase !== "fenced" && phase !== "recovering") {
          throw new TypeError("provider snapshot recovery probe phase is invalid");
        }
        return phase;
      })(),
    });
  }

  async beginProviderSnapshotRecovery(profileId, candidateFence, expectedRecoveryFence) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const expected = await this.getProfileGeneration(id);
    if (providerPendingDeadline(expected) === null) return null;
    const candidate = decimalString(
      candidateFence,
      "provider snapshot recovery candidate fence"
    );
    const expectedRecovery = expectedRecoveryFence === undefined
      ? ""
      : decimalString(
          expectedRecoveryFence,
          "expected provider snapshot recovery fence"
        );
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [
          this._profileTag(id),
          "",
          "snapshot_recover_begin",
          expected,
          candidate,
          expectedRecovery,
        ]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot recovery begin status");
    if (status === "snapshot_recovery_unavailable" || status === "snapshot_changed") return null;
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_recovery_begun") {
      throw new Error("unexpected provider snapshot recovery begin status: " + status);
    }
    const tokenValue = assertGeneration(
      asString(reply[1], "provider snapshot recovery token")
    );
    if (tokenValue !== expected) {
      throw new TypeError("provider snapshot recovery token is invalid");
    }
    return Object.freeze({
      token: tokenValue,
      fence: decimalString(
        asString(reply[2], "provider snapshot recovery fence"),
        "provider snapshot recovery fence"
      ),
    });
  }

  async completeProviderSnapshotRecovery(profileId, token, recoveryFence) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const expected = assertGeneration(token);
    if (providerPendingDeadline(expected) === null) {
      throw new TypeError("provider snapshot recovery token is invalid");
    }
    const fence = decimalString(recoveryFence, "provider snapshot recovery fence");
    const generation = this._nextStableGeneration(id, expected);
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [
          this._profileTag(id),
          generation,
          "snapshot_recover_complete",
          expected,
          fence,
        ]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot recovery completion status");
    if (status === "snapshot_changed") {
      throw codedError("provider_snapshot_changed", "provider snapshot recovery was superseded");
    }
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_recovery_completed") {
      throw new Error("unexpected provider snapshot recovery completion status: " + status);
    }
    return assertGeneration(asString(reply[1], "provider snapshot generation"));
  }

  async releaseProviderSnapshotMutation(profileId, token) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const expected = assertGeneration(token);
    if (providerPendingDeadline(expected) === null) return false;
    if ((await this.getProfileGeneration(id)) !== expected) return false;
    const generation = this._nextStableGeneration(id, expected);
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [this._profileTag(id), generation, "snapshot_release", expected]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot release status");
    if (status === "snapshot_changed") return false;
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_released") {
      throw new Error("unexpected provider snapshot release status: " + status);
    }
    return true;
  }

  async completeProviderSnapshotMutation(profileId, token) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const expected = assertGeneration(token);
    if (providerPendingDeadline(expected) === null) {
      throw new TypeError("provider snapshot mutation token is invalid");
    }
    const generation = this._nextStableGeneration(id, expected);
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [this._profileTag(id), generation, "snapshot_complete", expected]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "provider snapshot completion status");
    if (status === "snapshot_changed") {
      throw codedError("provider_snapshot_changed", "provider snapshot mutation was superseded");
    }
    if (status === "snapshot_unfenced") {
      throw codedError("provider_snapshot_unfenced", "provider snapshot mutation is not fenced");
    }
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "snapshot_completed") {
      throw new Error("unexpected provider snapshot completion status: " + status);
    }
    return assertGeneration(asString(reply[1], "provider snapshot generation"));
  }

  async invalidateProfile(profileId) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const state = await this.getProviderSnapshotState(id);
    if (state.pending) {
      throw codedError("provider_snapshot_busy", "provider snapshot mutation is active");
    }
    const previous = state.generation;
    const generation = this._nextStableGeneration(id, previous);
    const reply = asArray(
      await this._scripts.run(
        "playbackRecord",
        this._providerSnapshotKeys(id),
        [this._profileTag(id), generation, "snapshot_invalidate", previous]
      ),
      "playbackRecord"
    );
    const status = asString(reply[0], "playback invalidation status");
    if (status === "snapshot_busy" || status === "snapshot_changed") {
      throw codedError("provider_snapshot_busy", "provider snapshot mutation is active");
    }
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "invalidated") throw new Error("unexpected playback invalidation status: " + status);
    return assertGeneration(asString(reply[1], "profile generation"));
  }

  async invalidateDevice(profileId, deviceId, deviceGeneration) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const scopedDeviceId = assertPlaybackIdentifier(deviceId, "device id");
    const nextDeviceGeneration = assertPositiveInteger(
      deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    const generation = await this.getProfileGeneration(id);
    const reply = await this._runWithBoundedProfilePruning(
      "playbackInvalidateDevice",
      [
        ...this._profileKeys(id),
        this._deviceGenerationKey(id, scopedDeviceId),
        this._deviceGenerationIndexKey(id),
      ],
      [
        this._profileTag(id),
        this._keys.member("playback-device", id, scopedDeviceId),
        String(this._tombstoneTtlMs),
        String(this._maxTombstones),
        String(this._maxTombstonesPerProfile),
        String(this._pruneEntryBatchSize),
        "",
        generation,
        String(nextDeviceGeneration),
        String(this._deviceGenerationTtlMs),
        String(this._maxDeviceGenerationsPerProfile),
      ]
    );
    const status = asString(reply[0], "playback device invalidation status");
    if (status === "generation_changed") {
      throw codedError("profile_generation_changed", "profile generation changed before device invalidation");
    }
    if (status === "device_generation_changed") {
      throw codedError("device_generation_changed", "device generation changed before invalidation");
    }
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status !== "invalidated") {
      throw new Error("unexpected playback device invalidation status: " + status);
    }
    return asInteger(reply[1], "invalidated playback device count") === 1;
  }

  async record(profileId, context, options = {}) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const recordOptions = assertPlainObject(options || {}, "playback record options");
    const explicitGeneration = recordOptions.generation === undefined
      ? null
      : assertGeneration(recordOptions.generation);
    const providerRevision = decimalString(
      recordOptions.providerRevision,
      "provider revision",
      "0"
    );
    const now = await this._scripts.timeMs();
    const contextId = assertPlaybackIdentifier(this._idFactory("context"), "context id");
    const normalized = this._validator(now, () => contextId).record(id, context);
    const generation = explicitGeneration || await this.getProfileGeneration(id);
    if (providerPendingDeadline(generation) !== null) {
      throw codedError("provider_snapshot_busy", "provider snapshot mutation is active");
    }
    const candidate = this._metadataForContext(
      id,
      normalized,
      generation,
      "1",
      providerRevision,
      null,
      this._writeVersion
    );

    let mode = "insert";
    let expectedRaw = "";
    let pendingContext = normalized;
    let pendingMetadata = candidate;
    for (let attempt = 0; attempt < MAX_RECORD_RETRIES; attempt += 1) {
      const raw = jsonStringify(pendingMetadata, "playback context metadata");
      const reply = await this._runWithBoundedProfilePruning(
        "playbackRecord",
        [...this._profileKeys(id), ...pendingMetadata.fingerprintIndexKeys],
        [
          this._profileTag(id),
          generation,
          mode,
          raw,
          expectedRaw,
          String(this._ttlMs),
          String(this._tombstoneTtlMs),
          String(this._maxContexts),
          String(this._maxContextsPerProfile),
          String(this._maxTombstones),
          String(this._maxTombstonesPerProfile),
          String(this._pruneEntryBatchSize),
        ]
      );
      const status = asString(reply[0], "playback record status");
      if (status === "recorded") return validateStoredContext(pendingContext);
      if (status === "existing" || status === "changed") {
        const existingRaw = asString(reply[1], "existing playback context metadata");
        const existingMetadata = parseMetadata(existingRaw);
        if (
          existingMetadata.v === "4" &&
          BigInt(existingMetadata.providerRevision) > BigInt(providerRevision)
        ) {
          throw codedError(
            "provider_revision_changed",
            "provider revision changed before context record"
          );
        }
        const existingContext = materializeContext(
          existingMetadata,
          this._crypto,
          this._purpose(existingMetadata.ref)
        );
        pendingContext = mergeStoredContext(existingContext, normalized);
        pendingMetadata = this._metadataForContext(
          id,
          pendingContext,
          generation,
          (BigInt(existingMetadata.revision) + 1n).toString(),
          providerRevision,
          existingMetadata,
          existingMetadata.v === "4" ? "4" : this._writeVersion
        );
        mode = "update";
        expectedRaw = existingRaw;
        continue;
      }
      if (status === "capacity") throw codedError("context_capacity", "context capacity reached");
      if (status === "overlap") throw codedError("context_overlap", "playback source is already reserved");
      if (status === "generation_changed") {
        throw codedError("profile_generation_changed", "profile generation changed before context record");
      }
      if (status === "id_collision") throw new Error("idFactory produced a duplicate context id");
      if (status === "profile_collision") throw new Error("Redis playback profile key collision");
      if (status === "snapshot_busy") {
        throw codedError("provider_snapshot_busy", "provider snapshot mutation is active");
      }
      if (status === "metadata_invalid") throw new TypeError("Redis playback context metadata is invalid");
      throw new Error("unexpected playback record status: " + status);
    }
    throw codedError("context_contention", "playback context record contention limit reached");
  }

  async claim(profileId, deviceId, request, options = {}) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const scopedDeviceId = assertPlaybackIdentifier(deviceId, "device id");
    const claimOptions = assertClaimOptions(options);
    const sessionId = assertPlaybackIdentifier(claimOptions.sessionId, "session id");
    const requestDigest = assertDigest(claimOptions.requestDigest, "playback request digest");
    const explicitGeneration = claimOptions.generation === undefined
      ? null
      : assertGeneration(claimOptions.generation);
    const deviceGeneration = assertPositiveInteger(
      claimOptions.deviceGeneration ?? 1,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    const signal = assertOptionalAbortSignal(claimOptions.signal);
    const isolatedClaim = assertIsolatedClaim(claimOptions[ISOLATED_CLAIM]);
    if (signal && !isolatedClaim) {
      if (signal.aborted) throw abortReason(signal);
      const cleanupOwner = assertPlaybackIdentifier(
        this._cleanupOwnerFactory(),
        "playback cleanup owner"
      );
      const isolatedOptions = {
        ...(explicitGeneration === null ? {} : { generation: explicitGeneration }),
        deviceGeneration,
        sessionId,
        requestDigest,
        [ISOLATED_CLAIM]: { cleanupOwner },
      };
      try {
        return await this._runIsolatedClaim(signal, (repository) =>
          repository.claim(id, scopedDeviceId, request, isolatedOptions)
        );
      } catch (error) {
        try {
          await this.releaseOwned(id, scopedDeviceId, sessionId, cleanupOwner);
        } catch (cleanupError) {
          const combined = new AggregateError(
            [error, cleanupError],
            "playback claim failed and its delivery lease could not be abandoned"
          );
          combined.code = "claim_cleanup_failed";
          throw combined;
        }
        throw error;
      }
    }
    const attemptId = assertCanonicalAttemptId(request && request.attemptId);
    const now = await this._scripts.timeMs();
    this._validator(now, () => "validation-session").claim(
      id,
      scopedDeviceId,
      request,
      { deviceGeneration, sessionId, requestDigest }
    );
    const fingerprints = fingerprintStream({}, request.fingerprints);
    const fingerprintHashes = fingerprints.map((fingerprint) =>
      this._keys.member("playback-fingerprint", fingerprint)
    );
    const fingerprintBinding = claimFingerprintBinding(fingerprintHashes);
    const fingerprintIndexKeys = this._fingerprintIndexKeys(id, fingerprintHashes);
    const launchedAtMs = parseLaunchTimestamp(request.launchedAt);
    const cleanupOwner = isolatedClaim
      ? isolatedClaim.cleanupOwner
      : assertPlaybackIdentifier(this._cleanupOwnerFactory(), "playback cleanup owner");
    const deviceRef = this._keys.member("playback-device", id, scopedDeviceId);
    const claimMember = this._keys.member("playback-global-claim", id, deviceRef);
    const sessionKey = this._keys.key("playback-session", sessionId);
    const generation = explicitGeneration || await this.getProfileGeneration(
      id,
      signal ? { signal } : {}
    );
    if (providerPendingDeadline(generation) !== null) {
      throw codedError("provider_snapshot_busy", "provider snapshot mutation is active");
    }
    const leaseHash = claimLeaseHash(cleanupOwner);
    const attemptKey = this._claimAttemptKey(
      id,
      scopedDeviceId,
      attemptId
    );
    const attemptFingerprintKey = this._claimAttemptFingerprintKey(
      id,
      scopedDeviceId,
      attemptId
    );
    const attemptPointerKey = this._claimAttemptPointerKey(id, scopedDeviceId, sessionId);
    const profileAttemptIndexKey = this._claimAttemptProfileIndexKey(id);
    const profileKeys = this._profileKeys(id);
    const beginReply = asArray(
      await this._scripts.run(
        "playbackAttemptBegin",
        [
          attemptKey,
          attemptPointerKey,
          this._globalClaimAttemptsKey,
          profileAttemptIndexKey,
          this._claimAttemptReconcileKey,
          this._generationKey(id),
          this._deviceGenerationKey(id, scopedDeviceId),
          profileKeys[PROFILE_KEY_INDEX.claims],
          sessionKey,
          profileKeys[PROFILE_KEY_INDEX.root],
          attemptFingerprintKey,
          this._globalClaimAttemptFingerprintsKey,
        ],
        [
          this._profileTag(id),
          deviceRef,
          request.intentUrlHash,
          String(launchedAtMs),
          requestDigest,
          sessionId,
          generation,
          String(deviceGeneration),
          leaseHash,
          String(this._claimDisclosureLeaseMs),
          String(this._ttlMs),
          String(this._maxClaimAttempts),
          String(this._maxClaimAttemptsPerProfile),
          String(this._maxClaimLeasesPerAttempt),
          attemptId,
          fingerprintBinding,
        ]
      ),
      "playbackAttemptBegin"
    );
    const beginStatus = asString(beginReply[0], "playback claim attempt status");
    if (beginReply.length !== 1) throw new TypeError("Redis playback claim attempt is invalid");
    if (beginStatus === "generation_changed") {
      throw codedError("profile_generation_changed", "profile generation changed before claim");
    }
    if (beginStatus === "device_generation_changed") {
      throw codedError(
        "device_generation_changed",
        "device generation changed before playback claim"
      );
    }
    if (beginStatus === "claim_request_conflict") {
      throw codedError(
        "claim_request_conflict",
        "playback claim replay authority does not match the reserved request"
      );
    }
    if (beginStatus === "attempt_capacity") {
      throw codedError("claim_attempt_capacity", "playback claim attempt capacity reached");
    }
    if (beginStatus === "session_collision") {
      throw new Error("reserved playback session id is already in use");
    }
    if (beginStatus === "profile_collision") {
      throw new Error("Redis playback claim attempt key collision");
    }
    if (beginStatus === "abandoned") {
      return { status: "not_found", sessionId };
    }
    if (!["begun", "retry", "disclosed"].includes(beginStatus)) {
      throw new Error("unexpected playback claim attempt status: " + beginStatus);
    }
    const leaseRegistered = beginStatus !== "disclosed";
    let expectedPreviousSessionId = null;
    let privateSupersededSessionId = null;
    let writerProtocol = await this._readClaimWriterProtocol();
    for (let attempt = 0; attempt < MAX_CLAIM_RETRIES; attempt += 1) {
      const privateStateEnvelope = sealPrivateClaimState(
        this._crypto,
        id,
        scopedDeviceId,
        sessionId,
        privateSupersededSessionId
      );
      let reply;
      try {
        const scriptName = writerProtocol === CLAIM_WRITER_PROTOCOL_V5
          ? "playbackClaimV5Fenced"
          : "playbackClaimV6";
        const attemptKeys = writerProtocol === CLAIM_WRITER_PROTOCOL_V6
          ? [
              attemptKey,
              attemptFingerprintKey,
              this._globalClaimAttemptsKey,
              profileAttemptIndexKey,
              this._claimAttemptReconcileKey,
            ]
          : [
              attemptKey,
              this._globalClaimAttemptsKey,
              profileAttemptIndexKey,
              this._claimAttemptReconcileKey,
            ];
        reply = await this._runWithBoundedProfilePruning(
          scriptName,
          [
            ...profileKeys,
            this._deviceGenerationKey(id, scopedDeviceId),
            this._deviceGenerationIndexKey(id),
            sessionKey,
            ...fingerprintIndexKeys,
            ...attemptKeys,
            ...(writerProtocol === CLAIM_WRITER_PROTOCOL_V6
              ? [this._activeClaimAttemptKey(id, scopedDeviceId)]
              : []),
            this._claimWriterProtocolKey,
          ],
          [
            this._profileTag(id),
            deviceRef,
            request.intentUrlHash,
            String(launchedAtMs),
            jsonStringify(fingerprintHashes, "playback fingerprint hashes"),
            sessionId,
            claimMember,
            String(this._ttlMs),
            String(this._tombstoneTtlMs),
            String(this._maxLaunchAgeMs),
            String(this._maxFutureLaunchSkewMs),
            String(this._maxContextAfterLaunchMs),
            String(this._maxClaims),
            String(this._maxClaimsPerProfile),
            String(this._maxTombstones),
            String(this._maxTombstonesPerProfile),
            String(this._pruneEntryBatchSize),
            expectedPreviousSessionId || "",
            privateStateEnvelope,
            generation,
            CLAIM_STATE_VERSION,
            String(deviceGeneration),
            String(this._deviceGenerationTtlMs),
            String(this._maxDeviceGenerationsPerProfile),
            leaseHash,
            requestDigest,
            attemptId,
            ...(writerProtocol === CLAIM_WRITER_PROTOCOL_V6
              ? [fingerprintBinding, this._claimWriterProtocolRequirement]
              : []),
          ],
          {}
        );
      } catch (error) {
        throw error;
      }
      const status = asString(reply[0], "playback claim status");
      if (status === "writer_protocol_changed") {
        if (this._claimWriterRolloutMode !== "transition") {
          throw codedError(
            "claim_writer_protocol_changed",
            "playback claim writer protocol is not enabled"
          );
        }
        writerProtocol = await this._readClaimWriterProtocol();
        continue;
      }
      if (status === "retry") {
        if (reply.length !== 4) throw new TypeError("Redis playback claim retry is invalid");
        const current = asString(reply[1], "superseded playback session id");
        if (current === "") {
          if (asString(reply[2], "superseded playback claim version") !== "" ||
              asString(reply[3], "superseded playback private state") !== "") {
            throw new TypeError("Redis playback claim retry is invalid");
          }
          expectedPreviousSessionId = null;
          privateSupersededSessionId = null;
          continue;
        }
        const validated = assertPlaybackIdentifier(current, "superseded playback session id");
        const previousVersion = asString(reply[2], "superseded playback claim version");
        if (previousVersion === "4" || previousVersion === CLAIM_STATE_VERSION) {
          materializePrivateClaimState(
            reply[3],
            this._crypto,
            id,
            scopedDeviceId,
            validated
          );
          privateSupersededSessionId = validated;
        } else if (previousVersion === "3" &&
                   asString(reply[3], "superseded playback private state") === "") {
          privateSupersededSessionId = null;
        } else {
          throw new TypeError("Redis playback claim retry is invalid");
        }
        expectedPreviousSessionId = validated;
        continue;
      }
      if (status === "snapshot_busy") {
        throw codedError("provider_snapshot_busy", "provider snapshot mutation is active");
      }
      if (status === "device_generation_changed") {
        throw codedError(
          "device_generation_changed",
          "device generation changed before playback claim"
        );
      }
      if (status === "capacity") throw codedError("claim_capacity", "claim capacity reached");
      if (status === "claim_request_conflict") {
        throw codedError(
          "claim_request_conflict",
          "playback claim replay authority does not match the reserved request"
        );
      }
      if (status === "claim_attempt_changed") {
        throw codedError(
          "claim_attempt_changed",
          "playback claim attempt authority changed before completion"
        );
      }
      if (status === "attempt_abandoned") {
        return { status: "not_found", sessionId };
      }
      if (status === "session_collision") {
        throw new Error("reserved playback session id is already in use");
      }
      if (status === "profile_collision") throw new Error("Redis playback profile key collision");
      if (status === "generation_changed") {
        throw codedError("profile_generation_changed", "profile generation changed before claim");
      }
      if (status === "future") throw new TypeError("launchedAt is too far in the future");
      if (status === "too_old") throw new TypeError("launchedAt is too old");
      if (status !== "claimed") throw new Error("unexpected playback claim status: " + status);
      const result = materializeResponse(
        reply,
        this._crypto,
        reply[1] === "claimed"
          ? this._purpose(parseMetadata(asString(reply[3], "playback context metadata")).ref)
          : "playback-context:v1:" + "0".repeat(64),
        id,
        scopedDeviceId,
        sessionId
      );
      if (leaseRegistered && result.status === "claimed") {
        Object.defineProperty(result, PLAYBACK_CLAIM_CLEANUP_OWNER, {
          configurable: false,
          enumerable: false,
          value: cleanupOwner,
          writable: false,
        });
      }
      return result;
    }
    throw codedError("claim_contention", "playback claim contention limit reached");
  }

  async getActiveClaim(profileId, deviceId, sessionId) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const scopedDeviceId = assertPlaybackIdentifier(deviceId, "device id");
    const scopedSessionId = assertPlaybackIdentifier(sessionId, "sessionId");
    const deviceRef = this._keys.member("playback-device", id, scopedDeviceId);
    const generation = await this.getProfileGeneration(id);
    const reply = await this._runWithBoundedProfilePruning(
      "playbackGetActiveClaim",
      [...this._profileKeys(id), this._keys.key("playback-session", scopedSessionId)],
      [
        this._profileTag(id),
        deviceRef,
        scopedSessionId,
        String(this._tombstoneTtlMs),
        String(this._maxTombstones),
        String(this._maxTombstonesPerProfile),
        String(this._pruneEntryBatchSize),
        generation,
      ]
    );
    const status = asString(reply[0], "active playback claim status");
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status === "generation_changed") return null;
    if (status !== "active" && status !== "not_found") {
      throw new Error("unexpected active playback claim status: " + status);
    }
    return materializeActiveClaim(
      reply,
      scopedSessionId,
      id,
      scopedDeviceId,
      this._keys,
      this._crypto
    );
  }

  async release(profileId, deviceId, sessionId) {
    return this._release(profileId, deviceId, sessionId, "");
  }

  async releaseOwned(profileId, deviceId, sessionId, cleanupOwner) {
    return this._settleClaimAttempt(
      "playbackAttemptAbandon",
      profileId,
      deviceId,
      sessionId,
      assertPlaybackIdentifier(cleanupOwner, "playback cleanup owner")
    );
  }

  async commitClaimDisclosure(profileId, deviceId, sessionId, cleanupOwner) {
    return this._settleClaimAttempt(
      "playbackAttemptDisclose",
      profileId,
      deviceId,
      sessionId,
      assertPlaybackIdentifier(cleanupOwner, "playback disclosure lease")
    );
  }

  async _settleClaimAttempt(name, profileId, deviceId, sessionId, cleanupOwner) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const scopedDeviceId = assertPlaybackIdentifier(deviceId, "device id");
    const scopedSessionId = assertPlaybackIdentifier(sessionId, "sessionId");
    const reply = asArray(
      await this._scripts.run(
        name,
        [
          this._claimAttemptPointerKey(id, scopedDeviceId, scopedSessionId),
          this._claimAttemptReconcileKey,
          this._generationKey(id),
          this._deviceGenerationKey(id, scopedDeviceId),
        ],
        [
          this._profileTag(id),
          this._keys.member("playback-device", id, scopedDeviceId),
          scopedSessionId,
          claimLeaseHash(cleanupOwner),
        ]
      ),
      name
    );
    const status = asString(reply[0], name + " status");
    if (reply.length !== 1) throw new TypeError("Redis playback claim attempt result is invalid");
    if (status === "profile_collision") {
      throw new Error("Redis playback claim attempt key collision");
    }
    if (status === "generation_changed" || status === "device_generation_changed") return false;
    if (name === "playbackAttemptDisclose") {
      if (status !== "disclosed" && status !== "not_found") {
        throw new Error("unexpected playback claim disclosure status: " + status);
      }
      return status === "disclosed";
    }
    if (!["released", "retained", "abandoned", "not_found"].includes(status)) {
      throw new Error("unexpected playback claim abandonment status: " + status);
    }
    return status === "released";
  }

  async _release(profileId, deviceId, sessionId, cleanupOwner) {
    const id = assertPlaybackIdentifier(profileId, "profile id");
    const scopedDeviceId = assertPlaybackIdentifier(deviceId, "device id");
    const scopedSessionId = assertPlaybackIdentifier(sessionId, "sessionId");
    const deviceRef = this._keys.member("playback-device", id, scopedDeviceId);
    const generation = await this.getProfileGeneration(id);
    const reply = await this._runWithBoundedProfilePruning(
      "playbackRelease",
      [...this._profileKeys(id), this._keys.key("playback-session", scopedSessionId)],
      [
        this._profileTag(id),
        deviceRef,
        scopedSessionId,
        String(this._tombstoneTtlMs),
        String(this._maxTombstones),
        String(this._maxTombstonesPerProfile),
        String(this._pruneEntryBatchSize),
        generation,
        cleanupOwner,
      ]
    );
    const status = asString(reply[0], "playback release status");
    if (status === "profile_collision") throw new Error("Redis playback profile key collision");
    if (status === "generation_changed") {
      throw codedError("profile_generation_changed", "profile generation changed before release");
    }
    if (status !== "released" && status !== "not_found") {
      throw new Error("unexpected playback release status: " + status);
    }
    return status === "released";
  }

  async _runIsolatedClaim(signal, operation) {
    if (typeof this._client.duplicate !== "function") {
      throw new TypeError("Redis client must provide duplicate() for abortable playback claims");
    }
    const isolatedClient = this._client.duplicate();
    if (
      !isolatedClient ||
      typeof isolatedClient !== "object" ||
      typeof isolatedClient.connect !== "function" ||
      typeof isolatedClient.destroy !== "function"
    ) {
      throw new TypeError("Redis duplicate client must provide connect() and destroy()");
    }
    let destroyed = false;
    const destroy = () => {
      if (destroyed) return;
      destroyed = true;
      try {
        isolatedClient.destroy();
      } catch (_error) {
        // Destruction is best-effort after the socket is no longer trusted.
      }
    };
    const onError = () => {};
    if (typeof isolatedClient.on === "function") isolatedClient.on("error", onError);
    let rejectAborted;
    const aborted = new Promise((_resolve, reject) => {
      rejectAborted = () => reject(abortReason(signal));
      signal.addEventListener("abort", rejectAborted, { once: true });
    });
    const onAbort = () => destroy();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal.aborted) throw abortReason(signal);
      await Promise.race([Promise.resolve().then(() => isolatedClient.connect()), aborted]);
      if (signal.aborted) throw abortReason(signal);
      const isolatedRepository = Object.create(this);
      isolatedRepository._client = isolatedClient;
      isolatedRepository._scripts = this._isolatedScriptRunnerFactory(isolatedClient);
      return await Promise.race([
        Promise.resolve().then(() => operation(isolatedRepository)),
        aborted,
      ]);
    } finally {
      signal.removeEventListener("abort", rejectAborted);
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) {
        destroy();
      } else if (!destroyed && isolatedClient.isOpen === true &&
                 typeof isolatedClient.quit === "function") {
        try {
          await isolatedClient.quit();
        } catch (_error) {
          destroy();
        }
      } else {
        destroy();
      }
      if (typeof isolatedClient.off === "function") isolatedClient.off("error", onError);
    }
  }

  async reconcileClaimAttempts() {
    let examined = 0;
    let released = 0;
    for (let pass = 0; pass < MAX_PRUNE_DRAIN_PASSES; pass += 1) {
      const reply = asArray(
        await this._scripts.run(
          "playbackAttemptReconcile",
          [
            this._globalClaimAttemptsKey,
            this._claimAttemptReconcileKey,
            this._globalClaimAttemptFingerprintsKey,
          ],
          [
            String(this._pruneBatchSize),
            this._keys.prefix + ":playback-claim-attempt-v2:",
            this._keys.prefix + ":" + CLAIM_ATTEMPT_FINGERPRINT_KEY_KIND + ":",
          ]
        ),
        "playbackAttemptReconcile"
      );
      const status = asString(reply[0], "playback claim reconciliation status");
      if (status === "profile_collision") {
        throw new Error("Redis playback claim attempt key collision");
      }
      if (status !== "reconciled" || reply.length !== 4) {
        throw new Error("unexpected playback claim reconciliation status: " + status);
      }
      examined += asInteger(reply[1], "playback claim reconciliation count");
      released += asInteger(reply[2], "playback claim reconciliation release count");
      const hasMore = asString(reply[3], "playback claim reconciliation continuation");
      if (hasMore !== "0" && hasMore !== "1") {
        throw new TypeError("Redis playback claim reconciliation continuation is invalid");
      }
      if (hasMore === "0") return Object.freeze({ examined, released, hasMore: false });
    }
    return Object.freeze({ examined, released, hasMore: true });
  }

  async prune() {
    await this.reconcileClaimAttempts();
    const reply = asArray(
      await this._scripts.run(
        "playbackPrune",
        [this._globalContextsKey, this._globalClaimsKey, this._globalTombstonesKey, this._scheduleKey],
        [
          String(this._tombstoneTtlMs),
          String(this._maxTombstones),
          String(this._maxTombstonesPerProfile),
          String(this._pruneBatchSize),
          String(this._pruneEntryBatchSize),
        ]
      ),
      "playbackPrune"
    );
    if (asString(reply[0], "playback prune status") !== "pruned") {
      throw new Error("unexpected playback prune status");
    }
    const hasMore = asString(reply[4], "playback prune continuation");
    if (hasMore !== "0" && hasMore !== "1") {
      throw new TypeError("Redis playback prune continuation is invalid");
    }
    return {
      contexts: asInteger(reply[1], "playback context count"),
      claims: asInteger(reply[2], "playback claim count"),
      tombstones: asInteger(reply[3], "playback tombstone count"),
      hasMore: hasMore === "1",
    };
  }

  async _runWithBoundedProfilePruning(name, keys, args, options = {}) {
    for (let pass = 0; pass < MAX_PRUNE_DRAIN_PASSES; pass += 1) {
      const reply = asArray(await this._scripts.run(name, keys, args, options), name);
      if (asString(reply[0], name + " status") !== "prune_pending") return reply;
    }
    throw codedError(
      "playback_prune_pending",
      "playback profile pruning remains pending after the bounded retry limit"
    );
  }

  async _readClaimWriterProtocol() {
    if (this._claimWriterRolloutMode !== "transition") {
      return CLAIM_WRITER_PROTOCOL_V6;
    }
    if (typeof this._client.get !== "function") {
      throw new TypeError("Redis client must provide get() for claim writer rollout fencing");
    }
    const protocol = await this._client.get(this._claimWriterProtocolKey);
    if (protocol === CLAIM_WRITER_PROTOCOL_V5 || protocol === CLAIM_WRITER_PROTOCOL_V6) {
      return protocol;
    }
    throw codedError(
      "claim_writer_protocol_unavailable",
      "playback claim writer protocol gate is unavailable"
    );
  }

  _metadataForContext(
    profileId,
    context,
    generation,
    revision,
    providerRevision,
    existing = null,
    version = this._writeVersion
  ) {
    const writeVersion = assertWriteVersion(version);
    const validated = validateStoredContext(context);
    const contextId = validated.contextId;
    const fingerprintHashes = validated.fingerprints.map((fingerprint) =>
      this._keys.member("playback-fingerprint", fingerprint)
    );
    const ref = existing
      ? existing.ref
      : this._keys.member("playback-context", profileId, contextId);
    const metadata = {
      v: writeVersion,
      ref,
      globalMember: existing
        ? existing.globalMember
        : this._keys.member("playback-global-context", profileId, contextId),
      equivalenceHash:
        validated.contentKey === null
          ? ""
          : this._keys.member(
              "playback-equivalence",
              validated.contentKey,
              ...fingerprintHashes.slice().sort()
            ),
      fingerprintHashes,
      fingerprintIndexKeys: this._fingerprintIndexKeys(profileId, fingerprintHashes),
      tombstoneMembers: fingerprintHashes.map((hash) =>
        this._keys.member("playback-global-tombstone", profileId, hash)
      ),
      generation: assertGeneration(generation),
      revision: decimalString(revision, "playback context revision"),
      createdAtMs: existing
        ? existing.createdAtMs
        : String(parseLaunchTimestamp(validated.createdAt)),
      expiresAtMs: String(parseLaunchTimestamp(validated.expiresAt)),
      envelope: "",
    };
    if (writeVersion === "4") {
      metadata.providerRevision = decimalString(providerRevision, "provider revision");
    }
    metadata.envelope = jsonStringify(
      this._crypto.encryptJson(
        writeVersion === "3"
          ? validated
          : {
              v: 1,
              generation: metadata.generation,
              revision: metadata.revision,
              providerRevision: metadata.providerRevision,
              context: validated,
            },
        this._purpose(ref)
      ),
      "playback context envelope"
    );
    parseMetadata(jsonStringify(metadata, "playback context metadata"));
    return metadata;
  }

  _validator(now, idFactory) {
    return new SourceContextStore({
      ...this._sourceOptions,
      clock: () => now,
      idFactory,
    });
  }

  _nextGeneration(profileId, previous) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generation = assertGeneration(this._generationFactory(profileId, previous));
      if (generation !== previous) return generation;
    }
    throw codedError(
      "profile_generation_collision",
      "generationFactory did not produce a new profile generation"
    );
  }

  _nextStableGeneration(profileId, previous) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generation = assertGeneration(this._generationFactory(profileId, previous));
      if (generation !== previous && providerPendingDeadline(generation) === null) {
        return generation;
      }
    }
    throw codedError(
      "profile_generation_collision",
      "generationFactory did not produce a new stable profile generation"
    );
  }

  _profileTag(profileId) {
    return this._keys.member("playback-profile", profileId);
  }

  _generationKey(profileId) {
    return this._keys.key("playback-profile-generation", profileId);
  }

  _deviceGenerationKey(profileId, deviceId) {
    return this._keys.key("playback-device-generation", profileId, deviceId);
  }

  _deviceGenerationIndexKey(profileId) {
    return this._keys.key("playback-device-generations", profileId);
  }

  _claimAttemptKey(profileId, deviceId, attemptId) {
    return this._keys.key(
      "playback-claim-attempt-v2",
      profileId,
      deviceId,
      attemptId
    );
  }

  _claimAttemptFingerprintKey(profileId, deviceId, attemptId) {
    return this._keys.key(
      CLAIM_ATTEMPT_FINGERPRINT_KEY_KIND,
      profileId,
      deviceId,
      attemptId
    );
  }

  _claimAttemptPointerKey(profileId, deviceId, sessionId) {
    return this._keys.key("playback-claim-attempt-session-v2", profileId, deviceId, sessionId);
  }

  _activeClaimAttemptKey(profileId, deviceId) {
    return this._keys.key("playback-active-claim-attempt-v2", profileId, deviceId);
  }

  _claimAttemptProfileIndexKey(profileId) {
    return this._keys.key("playback-claim-attempts-v2", profileId);
  }

  _providerSnapshotStateKey(profileId) {
    return this._keys.key("playback-provider-snapshot-state", profileId);
  }

  _providerSnapshotFenceKey(profileId) {
    return this._keys.key("playback-provider-snapshot-fence", profileId);
  }

  _providerSnapshotKeys(profileId) {
    return [
      ...this._profileKeys(profileId),
      this._providerSnapshotStateKey(profileId),
      this._providerSnapshotFenceKey(profileId),
      this._deviceGenerationIndexKey(profileId),
    ];
  }

  _fingerprintIndexKeys(profileId, fingerprintHashes) {
    return fingerprintHashes.map((hash) =>
      this._keys.key("playback-fingerprint-index", profileId, hash)
    );
  }

  _purpose(ref) {
    return "playback-context:v1:" + assertDigest(ref, "playback context ref");
  }

  _profileKeys(profileId) {
    return [
      this._keys.key("playback-profile-v3", profileId),
      this._keys.key("playback-context-data", profileId),
      this._keys.key("playback-context-expiries", profileId),
      this._keys.key("playback-context-order", profileId),
      this._keys.key("playback-equivalences", profileId),
      this._keys.key("playback-claim-data", profileId),
      this._keys.key("playback-claim-expiries", profileId),
      this._keys.key("playback-claim-order", profileId),
      this._keys.key("playback-tombstones", profileId),
      this._keys.key("playback-tombstone-globals", profileId),
      this._keys.key("playback-tombstone-order", profileId),
      this._globalContextsKey,
      this._globalClaimsKey,
      this._globalTombstonesKey,
      this._scheduleKey,
      this._generationKey(profileId),
    ];
  }
}

module.exports = {
  PROFILE_KEY_INDEX,
  RedisPlaybackContextRepository,
  materializeContext,
  materializeResponse,
  parseMetadata,
};
