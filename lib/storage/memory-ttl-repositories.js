"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { SourceContextStore } = require("../source-context");
const { MemoryManagementGenerationStore } = require("./memory-repositories");
const {
  assertActivationRetryToken,
  canonicalJsonClone,
} = require("./pairing-replay");
const {
  addDuration,
  assertBoundedString,
  assertIdentifier,
  assertJsonSize,
  assertPlainObject,
  assertPositiveInteger,
  cloneJson,
  codedError,
  readClock,
  stableScope,
} = require("./repository-utils");

const PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function assertManagementGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("management generation is invalid");
  }
  return value;
}

function normalizePairCode(value) {
  if (typeof value !== "string") throw new TypeError("pairing user code is invalid");
  const normalized = value
    .toUpperCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\s-]/g, "");
  if (normalized.length !== 8 || Array.from(normalized).some((char) => !PAIR_CODE_ALPHABET.includes(char))) {
    throw new TypeError("pairing user code is invalid");
  }
  return normalized;
}

function formatPairCode(value) {
  return value.slice(0, 4) + "-" + value.slice(4);
}

function normalizeRedisCompatibleJson(value, name, maximumBytes) {
  let encoded;
  let containsUnsafeNumber = false;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === "number" && !Number.isSafeInteger(item)) {
        containsUnsafeNumber = true;
        throw new TypeError("unsafe JSON number");
      }
      return item;
    });
  } catch (_error) {
    if (containsUnsafeNumber) throw new TypeError(name + " contains a non-safe integer");
    throw new TypeError(name + " is not JSON serializable");
  }
  if (encoded === undefined) throw new TypeError(name + " is not JSON serializable");
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new RangeError(name + " exceeds " + maximumBytes + " bytes");
  }
  return JSON.parse(encoded);
}

class MemoryPairingRepository {
  constructor(options = {}) {
    if (!options.tokenService || !options.envelopeCrypto) {
      throw new TypeError("tokenService and envelopeCrypto are required");
    }
    this._tokens = options.tokenService;
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._randomBytes = options.randomBytes || crypto.randomBytes;
    this._ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this._activationRetryTtlMs = options.activationRetryTtlMs ?? 10 * 60 * 1000;
    this._tombstoneTtlMs = options.tombstoneTtlMs ?? 10 * 60 * 1000;
    this._maxPairings = options.maxPairings ?? 4096;
    assertPositiveInteger(this._ttlMs, "pairing ttl", 60 * 60 * 1000);
    assertPositiveInteger(
      this._activationRetryTtlMs,
      "pairing activation retry ttl",
      60 * 60 * 1000
    );
    assertPositiveInteger(this._tombstoneTtlMs, "pairing tombstone ttl", 60 * 60 * 1000);
    assertPositiveInteger(this._maxPairings, "maxPairings", 100000);
    if (typeof this._randomBytes !== "function") throw new TypeError("randomBytes must be a function");
    this._records = new Map();
    this._userIndex = new Map();
    this._deviceIndex = new Map();
    this._retryIndex = new Map();
    this._activationRecords = new Map();
    this._deviceTombstones = new Map();
  }

  async issue(input = {}) {
    const details = assertPlainObject(input, "pairing input");
    const allowedFields = new Set(["deviceId", "deviceName", "ttlMs", "validationScenario"]);
    if (Object.keys(details).some((key) => !allowedFields.has(key))) {
      throw new TypeError("pairing input contains an unknown field");
    }
    const now = readClock(this._clock);
    this._prune(now);
    if (this._records.size >= this._maxPairings) {
      throw codedError("pairing_capacity", "pairing capacity reached");
    }
    const pairingId = assertIdentifier(this._idFactory("pairing"), "pairing id");
    if (this._records.has(pairingId)) throw codedError("pairing_id_collision", "pairing id collision");
    const deviceId = assertIdentifier(
      details.deviceId === undefined ? this._idFactory("device") : details.deviceId,
      "device id"
    );
    const userCode = this._issueUserCode();
    const deviceCode = this._issueDeviceCode();
    const ttlMs =
      details.ttlMs === undefined
        ? this._ttlMs
        : assertPositiveInteger(details.ttlMs, "pairing ttl override", this._ttlMs);
    const validationScenario =
      details.validationScenario === undefined
        ? ""
        : assertBoundedString(details.validationScenario, "validation scenario", 32, {
            minimumLength: 1,
            pattern: /^[a-z][a-z-]+$/,
          });
    const expiresAt = addDuration(now, ttlMs, "pairing expiry");
    const record = {
      schemaVersion: 2,
      pairingId,
      deviceId,
      deviceName:
        details.deviceName === undefined
          ? ""
          : assertBoundedString(details.deviceName, "deviceName", 128, { minimumLength: 0 }),
      userCodeHash: this._tokens.hashOpaque("pair-user", userCode, 8),
      deviceCodeHash: deviceCode.tokenHash,
      state: "pending",
      activationEnvelope: null,
      activationDigest: null,
      activationRetryHash: null,
      activationRetryExpiresAt: null,
      activationState: null,
      createdAt: now,
      activationStartedAt: null,
      activatedAt: null,
      expiresAt,
    };
    if (validationScenario) {
      record.validationScenario = validationScenario;
      record.validationRateLimitClaimed = false;
    }
    this._records.set(pairingId, record);
    this._userIndex.set(record.userCodeHash, pairingId);
    this._deviceIndex.set(record.deviceCodeHash, pairingId);
    return {
      pairingId,
      deviceId,
      userCode: formatPairCode(userCode),
      deviceCode: deviceCode.token,
      expiresAt,
    };
  }

  async activate(userCode, activation, options = {}) {
    const code = normalizePairCode(userCode);
    const supplied = assertPlainObject(options, "pairing activation options");
    if (Object.keys(supplied).some((key) => key !== "activationRetryToken")) {
      throw new TypeError("pairing activation options contain an unknown field");
    }
    const retryToken = assertActivationRetryToken(supplied.activationRetryToken);
    const retryHash = this._tokens.hashToken("pair-activation-retry", retryToken);
    const payload = this._stableActivationPayload(activation);
    const now = readClock(this._clock);
    this._prune(now);

    const retryRecord = this._retryIndex.get(retryHash);
    if (retryRecord) return this._activationResult(retryRecord, retryHash, payload, now);

    const userCodeHash = this._tokens.hashOpaque("pair-user", code, 8);
    const pairingId = this._userIndex.get(userCodeHash);
    const record = pairingId ? this._records.get(pairingId) : null;
    if (!record) return { status: "not_found" };
    if (record.expiresAt <= now) {
      this._expire(record, now);
      return { status: "expired" };
    }
    if (record.activationEnvelope) {
      return { status: "not_found" };
    }
    const issuedDeviceToken = this._tokens.issue("device", 32);
    const storedPayload = { ...payload, deviceToken: issuedDeviceToken.token };
    assertJsonSize(storedPayload, "pairing activation", 64 * 1024);
    const envelope = this._crypto.encryptJson(storedPayload, this._purpose(record.pairingId));
    const activationDigest = this._tokens.hashOpaque(
      "pair-activation",
      JSON.stringify(payload),
      64 * 1024
    );
    record.activationEnvelope = envelope;
    record.activationDigest = activationDigest;
    record.activationRetryHash = retryHash;
    record.activationRetryExpiresAt = addDuration(
      now,
      this._activationRetryTtlMs,
      "pairing activation retry expiry"
    );
    record.activationState = "activating";
    record.state = "activating";
    record.activationStartedAt = now;
    this._userIndex.delete(record.userCodeHash);
    this._retryIndex.set(retryHash, record);
    this._activationRecords.set(record.pairingId, record);
    return {
      status: "activating",
      pairingId: record.pairingId,
      deviceId: record.deviceId,
      activationDigest,
      activation: cloneJson(storedPayload),
      expiresAt: record.expiresAt,
      activationRetryExpiresAt: record.activationRetryExpiresAt,
    };
  }

  async recoverActivation(activationRetryToken, activation) {
    const retryToken = assertActivationRetryToken(activationRetryToken);
    const retryHash = this._tokens.hashToken("pair-activation-retry", retryToken);
    const payload = this._stableActivationPayload(activation);
    const now = readClock(this._clock);
    this._prune(now);
    const record = this._retryIndex.get(retryHash);
    if (!record) return { status: "not_found" };
    return this._activationResult(record, retryHash, payload, now);
  }

  async completeActivation(pairingId, activationDigest, finalization = {}) {
    const id = assertIdentifier(pairingId, "pairing id");
    const digest = assertBoundedString(activationDigest, "activation digest", 64, {
      pattern: /^[a-f0-9]{64}$/,
    });
    const finalFields = assertPlainObject(finalization, "pairing finalization");
    for (const key of Object.keys(finalFields)) {
      if (key !== "profileId") throw new TypeError("pairing finalization contains an unknown field");
    }
    const profileId =
      finalFields.profileId === undefined
        ? null
        : assertIdentifier(finalFields.profileId, "profile id");
    const now = readClock(this._clock);
    const record = this._records.get(id) || this._activationRecords.get(id);
    if (!record) return { status: "not_found" };
    const activationDeadline = record.activationRetryExpiresAt || record.expiresAt;
    if (activationDeadline <= now) {
      this._removeRetry(record);
      return { status: "expired" };
    }
    if (!record.activationEnvelope || record.activationDigest !== digest) {
      throw codedError("pairing_conflict", "pairing activation digest does not match");
    }
    const activation = this._crypto.decryptJson(record.activationEnvelope, this._purpose(record.pairingId));
    if (profileId && activation.profileId && activation.profileId !== profileId) {
      throw codedError("pairing_conflict", "pairing profile finalization conflicts");
    }
    const activationState = record.activationState || record.state;
    if (activationState === "activated") {
      if (profileId && !activation.profileId) {
        activation.profileId = profileId;
        record.activationEnvelope = this._crypto.encryptJson(
          activation,
          this._purpose(record.pairingId)
        );
      }
      return {
        status: "activated",
        pairingId: id,
        activation: cloneJson(activation),
        expiresAt: record.expiresAt,
        activationRetryExpiresAt: record.activationRetryExpiresAt,
      };
    }
    if (activationState !== "activating") {
      throw codedError("pairing_state", "pairing is not awaiting durable activation");
    }
    if (profileId && !activation.profileId) {
      activation.profileId = profileId;
      record.activationEnvelope = this._crypto.encryptJson(
        activation,
        this._purpose(record.pairingId)
      );
    }
    record.activationState = "activated";
    if (this._records.has(id)) record.state = "activated";
    record.activatedAt = now;
    return {
      status: "activated",
      pairingId: id,
      activation: cloneJson(activation),
      expiresAt: record.expiresAt,
      activationRetryExpiresAt: record.activationRetryExpiresAt,
    };
  }

  async redeem(deviceCode) {
    const now = readClock(this._clock);
    this._prune(now);
    let deviceCodeHash;
    try {
      deviceCodeHash = this._tokens.hashToken("pair-device", deviceCode);
    } catch (_err) {
      return { status: "not_found" };
    }
    const pairingId = this._deviceIndex.get(deviceCodeHash);
    const record = pairingId ? this._records.get(pairingId) : null;
    if (!record) {
      const tombstone = this._deviceTombstones.get(deviceCodeHash);
      if (tombstone && tombstone.status === "redeemed") {
        return {
          status: "redeemed",
          pairingId: tombstone.pairingId,
          deviceId: tombstone.deviceId,
          activation: this._crypto.decryptJson(
            tombstone.activationEnvelope,
            this._purpose(tombstone.pairingId)
          ),
        };
      }
      return { status: tombstone ? tombstone.status : "not_found" };
    }
    if (record.state !== "activated" || !record.activationEnvelope) {
      return {
        status: "pending",
        activationState: record.state,
        pairingId: record.pairingId,
        expiresAt: record.expiresAt,
      };
    }
    const activation = this._crypto.decryptJson(record.activationEnvelope, this._purpose(record.pairingId));
    if (!activation.profileId) {
      return {
        status: "pending",
        activationState: "awaiting_profile_finalization",
        pairingId: record.pairingId,
        expiresAt: record.expiresAt,
      };
    }
    this._remove(record);
    this._deviceTombstones.set(deviceCodeHash, {
      status: "redeemed",
      pairingId: record.pairingId,
      deviceId: record.deviceId,
      activationEnvelope: cloneJson(record.activationEnvelope),
      expiresAt: addDuration(now, this._tombstoneTtlMs, "pairing tombstone expiry"),
    });
    return {
      status: "redeemed",
      pairingId: record.pairingId,
      deviceId: record.deviceId,
      activation,
    };
  }

  async cancel(deviceCode) {
    const now = readClock(this._clock);
    this._prune(now);
    let deviceCodeHash;
    try {
      deviceCodeHash = this._tokens.hashToken("pair-device", deviceCode);
    } catch (_err) {
      return false;
    }
    const pairingId = this._deviceIndex.get(deviceCodeHash);
    const record = pairingId ? this._records.get(pairingId) : null;
    if (!record) return false;
    this._remove(record, { dropRetry: true });
    this._deviceTombstones.set(deviceCodeHash, {
      status: "cancelled",
      expiresAt: addDuration(now, this._tombstoneTtlMs, "pairing tombstone expiry"),
    });
    return true;
  }

  async claimValidation(deviceCode) {
    const now = readClock(this._clock);
    this._prune(now);
    let deviceCodeHash;
    try {
      deviceCodeHash = this._tokens.hashToken("pair-device", deviceCode);
    } catch (_error) {
      return null;
    }
    const pairingId = this._deviceIndex.get(deviceCodeHash);
    const record = pairingId ? this._records.get(pairingId) : null;
    if (!record || !record.validationScenario) return null;
    const rateLimitNow =
      record.validationScenario === "rate-limit" && !record.validationRateLimitClaimed;
    if (rateLimitNow) record.validationRateLimitClaimed = true;
    return {
      scenario: record.validationScenario,
      rateLimitNow,
      expiresAt: record.expiresAt,
    };
  }

  storageSnapshot() {
    return {
      records: Array.from(this._records.values(), (record) => cloneJson(record)),
      tombstones: Array.from(this._deviceTombstones.entries(), ([deviceCodeHash, value]) => ({
        deviceCodeHash,
        ...cloneJson(value),
      })),
      activationRetries: Array.from(this._retryIndex.entries(), ([activationRetryHash, record]) => ({
        activationRetryHash,
        pairingId: record.pairingId,
        activationDigest: record.activationDigest,
        activationEnvelope: cloneJson(record.activationEnvelope),
        activationState: record.activationState,
        expiresAt: record.activationRetryExpiresAt,
      })),
    };
  }

  _stableActivationPayload(activation) {
    const payload = canonicalJsonClone(activation, "pairing activation");
    delete payload.deviceToken;
    delete payload.profileId;
    return payload;
  }

  _activationResult(record, retryHash, payload, now) {
    if (
      record.activationRetryHash !== retryHash ||
      !Number.isSafeInteger(record.activationRetryExpiresAt)
    ) {
      return { status: "not_found" };
    }
    if (record.activationRetryExpiresAt <= now) {
      this._removeRetry(record);
      return { status: "expired" };
    }
    if (!record.activationEnvelope || !record.activationDigest) return { status: "not_found" };
    const current = this._crypto.decryptJson(
      record.activationEnvelope,
      this._purpose(record.pairingId)
    );
    const stableCurrent = { ...current };
    delete stableCurrent.deviceToken;
    delete stableCurrent.profileId;
    if (!isDeepStrictEqual(stableCurrent, payload)) {
      throw codedError("pairing_conflict", "pairing is already activated with different data");
    }
    const status = record.activationState || record.state;
    if (status !== "activating" && status !== "activated") return { status: "not_found" };
    return {
      status,
      pairingId: record.pairingId,
      deviceId: record.deviceId,
      activationDigest: record.activationDigest,
      activation: cloneJson(current),
      expiresAt: record.expiresAt,
      activationRetryExpiresAt: record.activationRetryExpiresAt,
    };
  }

  _issueUserCode() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const random = this._randomBytes(8);
      if (!Buffer.isBuffer(random) || random.length !== 8) {
        throw new TypeError("randomBytes returned an invalid pairing buffer");
      }
      let code = "";
      try {
        for (const byte of random) code += PAIR_CODE_ALPHABET[byte & 31];
      } finally {
        random.fill(0);
      }
      if (!this._userIndex.has(this._tokens.hashOpaque("pair-user", code, 8))) return code;
    }
    throw codedError("pairing_code_collision", "could not allocate a unique pairing user code");
  }

  _issueDeviceCode() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const issued = this._tokens.issue("pair-device", 32);
      if (!this._deviceIndex.has(issued.tokenHash) && !this._deviceTombstones.has(issued.tokenHash)) {
        return issued;
      }
    }
    throw codedError("pairing_code_collision", "could not allocate a unique pairing device code");
  }

  _purpose(pairingId) {
    return "pair-activation:" + stableScope("pairing", pairingId);
  }

  _expire(record, now) {
    this._remove(record);
    this._deviceTombstones.set(record.deviceCodeHash, {
      status: "expired",
      expiresAt: addDuration(now, this._tombstoneTtlMs, "pairing tombstone expiry"),
    });
  }

  _remove(record, options = {}) {
    this._records.delete(record.pairingId);
    this._userIndex.delete(record.userCodeHash);
    this._deviceIndex.delete(record.deviceCodeHash);
    if (options.dropRetry === true) this._removeRetry(record);
  }

  _removeRetry(record) {
    if (!record) return;
    if (
      record.activationRetryHash &&
      this._retryIndex.get(record.activationRetryHash) === record
    ) {
      this._retryIndex.delete(record.activationRetryHash);
    }
    if (this._activationRecords.get(record.pairingId) === record) {
      this._activationRecords.delete(record.pairingId);
    }
  }

  _prune(now) {
    for (const record of Array.from(this._records.values())) {
      if (record.expiresAt <= now) this._expire(record, now);
    }
    for (const [key, tombstone] of this._deviceTombstones) {
      if (tombstone.expiresAt <= now) this._deviceTombstones.delete(key);
    }
    for (const record of new Set(this._retryIndex.values())) {
      if (record.activationRetryExpiresAt <= now) this._removeRetry(record);
    }
  }
}

class MemoryOAuthStateRepository {
  constructor(options = {}) {
    if (!options.tokenService || !options.envelopeCrypto) {
      throw new TypeError("tokenService and envelopeCrypto are required");
    }
    this._tokens = options.tokenService;
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
    this._ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this._maxStates = options.maxStates ?? 4096;
    this._generations = options.managementGenerations || new MemoryManagementGenerationStore();
    assertPositiveInteger(this._ttlMs, "OAuth state ttl", 60 * 60 * 1000);
    assertPositiveInteger(this._maxStates, "maxStates", 100000);
    this._states = new Map();
  }

  async issue(profileId, payload, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const supplied = assertPlainObject(options || {}, "OAuth state options");
    const authority = this._generations.read(scopedProfileId);
    const managementGeneration = supplied.managementGeneration === undefined
      ? authority.generation
      : assertManagementGeneration(supplied.managementGeneration);
    if (authority.revoked || authority.generation !== managementGeneration) {
      throw codedError("profile_inactive", "management generation changed before OAuth issuance");
    }
    const value = normalizeRedisCompatibleJson(
      assertPlainObject(payload, "OAuth state payload"),
      "OAuth state payload",
      64 * 1024
    );
    const now = readClock(this._clock);
    this._prune(now);
    if (this._states.size >= this._maxStates) throw codedError("oauth_state_capacity", "OAuth state capacity reached");
    const state = this._tokens.issue("oauth-state", 32);
    const binding = this._tokens.issue("oauth-binding", 32);
    if (this._states.has(state.tokenHash)) throw codedError("oauth_state_collision", "OAuth state collision");
    const expiresAt = addDuration(now, this._ttlMs, "OAuth state expiry");
    this._states.set(state.tokenHash, {
      schemaVersion: 1,
      profileId: scopedProfileId,
      managementGeneration,
      bindingHash: binding.tokenHash,
      payloadEnvelope: this._crypto.encryptJson(value, this._purpose(state.tokenHash)),
      createdAt: now,
      expiresAt,
    });
    return { stateToken: state.token, browserBindingToken: binding.token, expiresAt };
  }

  async consume(stateToken, browserBindingToken) {
    const now = readClock(this._clock);
    this._prune(now);
    let stateHash;
    try {
      stateHash = this._tokens.hashToken("oauth-state", stateToken);
    } catch (_err) {
      return null;
    }
    const record = this._states.get(stateHash);
    if (
      !record ||
      !this._tokens.matchesToken("oauth-binding", browserBindingToken, record.bindingHash)
    ) {
      return null;
    }
    if (!this._generations.isCurrent(record.profileId, record.managementGeneration)) {
      this._states.delete(stateHash);
      return null;
    }
    const payload = normalizeRedisCompatibleJson(
      assertPlainObject(
        this._crypto.decryptJson(record.payloadEnvelope, this._purpose(stateHash)),
        "OAuth state payload"
      ),
      "OAuth state payload",
      64 * 1024
    );
    if (
      this._states.get(stateHash) !== record ||
      !this._generations.isCurrent(record.profileId, record.managementGeneration)
    ) {
      this._states.delete(stateHash);
      return null;
    }
    this._states.delete(stateHash);
    return {
      profileId: record.profileId,
      payload,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }

  async cancel(stateToken) {
    let stateHash;
    try {
      stateHash = this._tokens.hashToken("oauth-state", stateToken);
    } catch (_err) {
      return false;
    }
    return this._states.delete(stateHash);
  }

  storageSnapshot() {
    return Array.from(this._states.entries(), ([stateHash, record]) => ({
      stateHash,
      ...cloneJson(record),
    }));
  }

  _purpose(stateHash) {
    return "oauth-state:" + stateHash;
  }

  _prune(now) {
    for (const [key, record] of this._states) {
      if (record.expiresAt <= now) this._states.delete(key);
    }
  }
}

class MemoryLeaseRepository {
  constructor(options = {}) {
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._maxLeases = options.maxLeases ?? 10000;
    assertPositiveInteger(this._maxLeases, "maxLeases", 1000000);
    this._leases = new Map();
  }

  async acquire(scope, key, owner, ttlMs) {
    const scopedScope = assertBoundedString(scope, "lease scope", 128);
    const scopedKey = assertBoundedString(key, "lease key", 512);
    const scopedOwner = assertIdentifier(owner, "lease owner");
    const duration = assertPositiveInteger(ttlMs, "lease ttl", 5 * 60 * 1000);
    const now = readClock(this._clock);
    this._prune(now);
    const keyHash = this._keyHash(scopedScope, scopedKey);
    const existing = this._leases.get(keyHash);
    if (existing) return { acquired: false, expiresAt: existing.expiresAt };
    if (this._leases.size >= this._maxLeases) throw codedError("lease_capacity", "lease capacity reached");
    const issued = this._issueLeaseToken();
    const expiresAt = addDuration(now, duration, "lease expiry");
    this._leases.set(keyHash, {
      owner: scopedOwner,
      leaseTokenHash: issued.tokenHash,
      createdAt: now,
      expiresAt,
    });
    return { acquired: true, leaseToken: issued.token, expiresAt };
  }

  async release(scope, key, leaseToken) {
    const scopedScope = assertBoundedString(scope, "lease scope", 128);
    const scopedKey = assertBoundedString(key, "lease key", 512);
    const now = readClock(this._clock);
    this._prune(now);
    const keyHash = this._keyHash(scopedScope, scopedKey);
    const record = this._leases.get(keyHash);
    if (!record || !this._tokens.matchesToken("lease", leaseToken, record.leaseTokenHash)) return false;
    return this._leases.delete(keyHash);
  }

  async renew(scope, key, leaseToken, ttlMs) {
    const scopedScope = assertBoundedString(scope, "lease scope", 128);
    const scopedKey = assertBoundedString(key, "lease key", 512);
    const duration = assertPositiveInteger(ttlMs, "lease ttl", 5 * 60 * 1000);
    const now = readClock(this._clock);
    this._prune(now);
    const record = this._leases.get(this._keyHash(scopedScope, scopedKey));
    if (!record || !this._tokens.matchesToken("lease", leaseToken, record.leaseTokenHash)) {
      return { renewed: false };
    }
    record.expiresAt = addDuration(now, duration, "lease expiry");
    return { renewed: true, expiresAt: record.expiresAt };
  }

  storageSnapshot() {
    return Array.from(this._leases.entries(), ([keyHash, record]) => ({ keyHash, ...cloneJson(record) }));
  }

  _keyHash(scope, key) {
    return this._tokens.hashOpaque("lease-key", JSON.stringify([scope, key]), 1024);
  }

  _issueLeaseToken() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const issued = this._tokens.issue("lease", 24);
      let collision = false;
      for (const record of this._leases.values()) {
        if (record.leaseTokenHash === issued.tokenHash) {
          collision = true;
          break;
        }
      }
      if (!collision) return issued;
    }
    throw codedError("lease_token_collision", "could not allocate a unique lease token");
  }

  _prune(now) {
    for (const [key, record] of this._leases) {
      if (record.expiresAt <= now) this._leases.delete(key);
    }
  }
}

class MemoryRateLimitRepository {
  constructor(options = {}) {
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._maxEntries = options.maxEntries ?? 100000;
    assertPositiveInteger(this._maxEntries, "max rate limit entries", 1000000);
    this._entries = new Map();
  }

  async consume(scope, key, limit, windowMs, cost = 1) {
    const scopedScope = assertBoundedString(scope, "rate limit scope", 128);
    const scopedKey = assertBoundedString(key, "rate limit key", 512);
    const boundedLimit = assertPositiveInteger(limit, "rate limit", 1000000);
    const boundedWindow = assertPositiveInteger(windowMs, "rate limit window", 24 * 60 * 60 * 1000);
    const boundedCost = assertPositiveInteger(cost, "rate limit cost", boundedLimit);
    const now = readClock(this._clock);
    this._prune(now);
    const keyHash = this._keyHash(scopedScope, scopedKey);
    let record = this._entries.get(keyHash);
    if (!record) {
      if (this._entries.size >= this._maxEntries) {
        throw codedError("rate_limit_capacity", "rate limit capacity reached");
      }
      record = {
        count: 0,
        limit: boundedLimit,
        windowMs: boundedWindow,
        resetAt: addDuration(now, boundedWindow, "rate limit reset"),
      };
      this._entries.set(keyHash, record);
    } else if (record.limit !== boundedLimit || record.windowMs !== boundedWindow) {
      throw codedError("rate_limit_policy_mismatch", "rate limit policy changed inside an active window");
    }
    record.count = Math.min(Number.MAX_SAFE_INTEGER, record.count + boundedCost);
    const allowed = record.count <= record.limit;
    return {
      allowed,
      remaining: Math.max(0, record.limit - record.count),
      resetAt: record.resetAt,
    };
  }

  async reset(scope, key) {
    const scopedScope = assertBoundedString(scope, "rate limit scope", 128);
    const scopedKey = assertBoundedString(key, "rate limit key", 512);
    return this._entries.delete(this._keyHash(scopedScope, scopedKey));
  }

  storageSnapshot() {
    return Array.from(this._entries.entries(), ([keyHash, record]) => ({ keyHash, ...cloneJson(record) }));
  }

  _keyHash(scope, key) {
    return this._tokens.hashOpaque("rate-limit-key", JSON.stringify([scope, key]), 1024);
  }

  _prune(now) {
    for (const [key, record] of this._entries) {
      if (record.resetAt <= now) this._entries.delete(key);
    }
  }
}

class MemoryPlaybackContextRepository {
  constructor(options = {}) {
    this._store = options.store || new SourceContextStore(options.sourceContextOptions || options);
    if (
      !this._store ||
      typeof this._store.record !== "function" ||
      typeof this._store.getProfileGeneration !== "function" ||
      typeof this._store.getProviderSnapshotState !== "function" ||
      typeof this._store.beginProviderSnapshotMutation !== "function" ||
      typeof this._store.renewProviderSnapshotMutation !== "function" ||
      typeof this._store.fenceProviderSnapshotMutation !== "function" ||
      typeof this._store.completeProviderSnapshotMutation !== "function" ||
      typeof this._store.releaseProviderSnapshotMutation !== "function" ||
      typeof this._store.beginProviderSnapshotRecovery !== "function" ||
      typeof this._store.completeProviderSnapshotRecovery !== "function" ||
      typeof this._store.invalidateProfile !== "function" ||
      typeof this._store.invalidateDevice !== "function" ||
      typeof this._store.claim !== "function" ||
      typeof this._store.getActiveClaim !== "function" ||
      typeof this._store.release !== "function" ||
      typeof this._store.prune !== "function"
    ) {
      throw new TypeError("source context store is invalid");
    }
  }

  async getProfileGeneration(profileId) {
    return this._store.getProfileGeneration(profileId);
  }

  async getProviderSnapshotState(profileId) {
    return this._store.getProviderSnapshotState(profileId);
  }

  async beginProviderSnapshotMutation(profileId) {
    return this._store.beginProviderSnapshotMutation(profileId);
  }

  async renewProviderSnapshotMutation(profileId, token) {
    return this._store.renewProviderSnapshotMutation(profileId, token);
  }

  async fenceProviderSnapshotMutation(profileId, token, mutationFence) {
    return this._store.fenceProviderSnapshotMutation(profileId, token, mutationFence);
  }

  async completeProviderSnapshotMutation(profileId, token) {
    return this._store.completeProviderSnapshotMutation(profileId, token);
  }

  async releaseProviderSnapshotMutation(profileId, token) {
    return this._store.releaseProviderSnapshotMutation(profileId, token);
  }

  async probeProviderSnapshotRecovery(profileId) {
    return this._store.probeProviderSnapshotRecovery(profileId);
  }

  async beginProviderSnapshotRecovery(profileId, candidateFence, expectedRecoveryFence) {
    return this._store.beginProviderSnapshotRecovery(
      profileId,
      candidateFence,
      expectedRecoveryFence
    );
  }

  async completeProviderSnapshotRecovery(profileId, token, recoveryFence) {
    return this._store.completeProviderSnapshotRecovery(profileId, token, recoveryFence);
  }

  async invalidateProfile(profileId) {
    return this._store.invalidateProfile(profileId);
  }

  async invalidateDevice(profileId, deviceId, generation) {
    return this._store.invalidateDevice(profileId, deviceId, generation);
  }

  async record(profileId, context, options) {
    return this._store.record(profileId, context, options);
  }

  async claim(profileId, deviceId, request, options) {
    const supplied = options || {};
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
      throw new TypeError("playback claim options are invalid");
    }
    const signal = supplied.signal;
    if (signal !== undefined) {
      if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean") {
        throw new TypeError("playback claim signal is invalid");
      }
      if (signal.aborted) {
        if (signal.reason instanceof Error) throw signal.reason;
        const error = new Error("playback claim was aborted");
        error.name = "AbortError";
        throw error;
      }
    }
    const storeOptions = { ...supplied };
    delete storeOptions.signal;
    return this._store.claim(profileId, deviceId, request, storeOptions);
  }

  async getActiveClaim(profileId, deviceId, sessionId) {
    return this._store.getActiveClaim(profileId, deviceId, sessionId);
  }

  async release(profileId, deviceId, sessionId) {
    return this._store.release(profileId, deviceId, sessionId);
  }

  async prune() {
    this._store.prune();
    return typeof this._store.getStats === "function" ? this._store.getStats() : null;
  }
}

module.exports = {
  MemoryLeaseRepository,
  MemoryOAuthStateRepository,
  MemoryPairingRepository,
  MemoryPlaybackContextRepository,
  MemoryRateLimitRepository,
};
