"use strict";

const crypto = require("node:crypto");
const {
  assertBoundedString,
  assertIdentifier,
  assertJsonSize,
  assertPlainObject,
  assertPositiveInteger,
  codedError,
  stableScope,
} = require("../repository-utils");
const {
  assertActivationRetryToken,
  canonicalJsonClone,
} = require("../pairing-replay");
const { initializeRedisOptions, jsonParse, jsonStringify } = require("./base");
const { asArray, asInteger, asString } = require("./reply");

const PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_ISSUE_CLEANUP_BATCH_SIZE = 32;

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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
      .join(",") +
    "}"
  );
}

class RedisPairingRepository {
  constructor(options = {}) {
    const shared = initializeRedisOptions(options);
    if (!options.tokenService || !options.envelopeCrypto) {
      throw new TypeError("tokenService and envelopeCrypto are required");
    }
    this._client = shared.client;
    if (typeof this._client.get !== "function") throw new TypeError("Redis client must provide get()");
    this._keys = shared.keyspace;
    this._scripts = shared.scripts;
    this._tokens = options.tokenService;
    this._crypto = options.envelopeCrypto;
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
    if (typeof this._idFactory !== "function") throw new TypeError("idFactory must be a function");
    this._globalKey = this._keys.key("pairing-global-v2", "active");
    this._legacyGlobalKey = this._keys.key("pairing-global", "active");
  }

  async assertProtocol() {
    const reply = asArray(
      await this._scripts.run(
        "pairingProtocolGate",
        [this._legacyGlobalKey],
        ["pairing-replay-v2"]
      ),
      "pairingProtocolGate"
    );
    const status = asString(reply[0], "pairing protocol status");
    if (status === "ready") return true;
    if (status === "legacy_active") {
      throw codedError(
        "pairing_mixed_version",
        "active legacy pairings prevent the replay-safe protocol gate"
      );
    }
    throw codedError("pairing_protocol_gate", "Redis pairing protocol gate is invalid");
  }

  async issue(input = {}) {
    await this.assertProtocol();
    const details = assertPlainObject(input, "pairing input");
    const allowedFields = new Set(["deviceId", "deviceName", "ttlMs", "validationScenario"]);
    if (Object.keys(details).some((key) => !allowedFields.has(key))) {
      throw new TypeError("pairing input contains an unknown field");
    }
    const pairingId = assertIdentifier(this._idFactory("pairing"), "pairing id");
    const deviceId = assertIdentifier(
      details.deviceId === undefined ? this._idFactory("device") : details.deviceId,
      "device id"
    );
    const deviceName =
      details.deviceName === undefined
        ? ""
        : assertBoundedString(details.deviceName, "deviceName", 128, { minimumLength: 0 });
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
    const recordKey = this._recordKey(pairingId);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const userCode = this._newUserCode();
      const deviceCode = this._tokens.issue("pair-device", 32);
      const userCodeHash = this._tokens.hashOpaque("pair-user", userCode, 8);
      const reply = asArray(
        await this._scripts.run(
          "pairingIssue",
          [recordKey, this._userKey(userCodeHash), this._deviceKey(deviceCode.tokenHash), this._globalKey],
          [
            pairingId,
            deviceId,
            deviceName,
            userCodeHash,
            deviceCode.tokenHash,
            ttlMs,
            this._tombstoneTtlMs,
            this._maxPairings,
            PAIRING_ISSUE_CLEANUP_BATCH_SIZE,
            validationScenario,
          ]
        ),
        "pairingIssue"
      );
      const status = asString(reply[0], "pairing issue status");
      if (status === "ok") {
        return {
          pairingId,
          deviceId,
          userCode: formatPairCode(userCode),
          deviceCode: deviceCode.token,
          expiresAt: asInteger(reply[1], "pairing expiry"),
        };
      }
      if (status === "id_collision") throw codedError("pairing_id_collision", "pairing id collision");
      if (status === "capacity") throw codedError("pairing_capacity", "pairing capacity reached");
      if (status !== "code_collision") throw new Error("unexpected pairing issue status: " + status);
    }
    throw codedError("pairing_code_collision", "could not allocate unique pairing codes");
  }

  async activate(userCode, activation, options = {}) {
    const code = normalizePairCode(userCode);
    const supplied = assertPlainObject(options, "pairing activation options");
    if (Object.keys(supplied).some((key) => key !== "activationRetryToken")) {
      throw new TypeError("pairing activation options contain an unknown field");
    }
    const retryToken = assertActivationRetryToken(supplied.activationRetryToken);
    const retryHash = this._tokens.hashToken("pair-activation-retry", retryToken);
    const { stableActivation, digest } = this._activationPayload(activation);
    const userCodeHash = this._tokens.hashOpaque("pair-user", code, 8);
    const userKey = this._userKey(userCodeHash);
    const pairingId = await this._readIndex(userKey);
    if (!pairingId) return this.recoverActivation(retryToken, stableActivation);
    const deviceToken = this._tokens.issue("device", 32).token;
    const storedActivation = { ...stableActivation, deviceToken };
    assertJsonSize(
      { ...storedActivation, profileId: "p".repeat(128) },
      "pairing activation",
      64 * 1024
    );
    const envelope = this._crypto.encryptJson(storedActivation, this._purpose(pairingId));
    const reply = asArray(
      await this._scripts.run(
        "pairingActivate",
        [userKey, this._retryKey(retryHash), this._recordKey(pairingId), this._globalKey],
        [
          pairingId,
          jsonStringify(envelope, "pairing activation envelope"),
          digest,
          this._tombstoneTtlMs,
          retryHash,
          this._activationRetryTtlMs,
        ]
      ),
      "pairingActivate"
    );
    return this._activationReply(reply, digest);
  }

  async recoverActivation(activationRetryToken, activation) {
    const retryToken = assertActivationRetryToken(activationRetryToken);
    const retryHash = this._tokens.hashToken("pair-activation-retry", retryToken);
    const { digest } = this._activationPayload(activation);
    const retryKey = this._retryKey(retryHash);
    const pairingId = await this._readIndex(retryKey);
    if (!pairingId) return { status: "not_found" };
    const reply = asArray(
      await this._scripts.run(
        "pairingRecover",
        [retryKey, this._recordKey(pairingId)],
        [pairingId, retryHash, digest]
      ),
      "pairingRecover"
    );
    return this._activationReply(reply, digest);
  }

  async completeActivation(pairingId, activationDigest, finalization) {
    const id = assertIdentifier(pairingId, "pairing id");
    const digest = assertBoundedString(activationDigest, "activation digest", 64, {
      pattern: /^[a-f0-9]{64}$/,
    });
    let profileId;
    if (finalization !== undefined) {
      const details = assertPlainObject(finalization, "pairing finalization");
      if (Object.keys(details).length !== 1 || !Object.hasOwn(details, "profileId")) {
        throw new TypeError("pairing finalization must contain only profileId");
      }
      profileId = assertIdentifier(details.profileId, "profile id");
    }

    const peek = asArray(
      await this._scripts.run(
        "pairingCompletePeek",
        [this._recordKey(id), this._globalKey],
        [id, digest, this._tombstoneTtlMs]
      ),
      "pairingCompletePeek"
    );
    const peekStatus = asString(peek[0], "pairing completion status");
    if (peekStatus === "conflict") {
      throw codedError("pairing_conflict", "pairing activation digest does not match");
    }
    if (peekStatus === "invalid_state") {
      throw codedError("pairing_state", "pairing is not awaiting durable activation");
    }
    if (peekStatus === "not_found" || peekStatus === "expired") return { status: peekStatus };
    if (peekStatus !== "ready") {
      throw new Error("unexpected pairing completion status: " + peekStatus);
    }
    const serializedEnvelope = asString(peek[3], "pairing envelope");
    const observedDigest = asString(peek[4], "pairing activation digest");
    if (observedDigest !== digest) throw new Error("Redis pairing activation digest changed");
    const activation = this._decryptActivation(serializedEnvelope, id, digest);
    const existingFinalizationHash = asString(peek[5], "pairing finalization hash");
    if (activation.profileId !== undefined) {
      const activationProfileHash = this._tokens.hashOpaque(
        "pair-profile",
        activation.profileId,
        128
      );
      if (existingFinalizationHash && existingFinalizationHash !== activationProfileHash) {
        throw new Error("Redis pairing finalization does not match its envelope");
      }
    } else if (existingFinalizationHash) {
      throw new Error("Redis pairing finalization is missing from its envelope");
    }

    let replacementEnvelope = serializedEnvelope;
    let requestedFinalizationHash = "";
    if (profileId !== undefined) {
      if (activation.profileId !== undefined && activation.profileId !== profileId) {
        throw codedError("pairing_conflict", "pairing is already finalized for another profile");
      }
      const finalizedActivation = { ...activation, profileId };
      assertJsonSize(finalizedActivation, "pairing activation", 64 * 1024);
      replacementEnvelope = jsonStringify(
        this._crypto.encryptJson(finalizedActivation, this._purpose(id)),
        "pairing activation envelope"
      );
      const verifiedReplacement = this._decryptActivation(replacementEnvelope, id, digest);
      if (verifiedReplacement.profileId !== profileId) {
        throw new Error("Redis pairing replacement finalization is invalid");
      }
      requestedFinalizationHash = this._tokens.hashOpaque("pair-profile", profileId, 128);
    }
    const reply = asArray(
      await this._scripts.run(
        "pairingComplete",
        [this._recordKey(id), this._globalKey],
        [
          id,
          digest,
          this._tombstoneTtlMs,
          serializedEnvelope,
          replacementEnvelope,
          requestedFinalizationHash,
        ]
      ),
      "pairingComplete"
    );
    const status = asString(reply[0], "pairing completion status");
    if (status === "conflict") throw codedError("pairing_conflict", "pairing activation digest does not match");
    if (status === "invalid_state") {
      throw codedError("pairing_state", "pairing is not awaiting durable activation");
    }
    if (status === "activated") {
      const authoritativeDigest = asString(reply[3], "pairing activation digest");
      if (authoritativeDigest !== digest) {
        throw new Error("Redis pairing activation digest changed during completion");
      }
      const authoritativeActivation = this._decryptActivation(
        asString(reply[2], "pairing envelope"),
        id,
        authoritativeDigest
      );
      if (profileId !== undefined && authoritativeActivation.profileId !== profileId) {
        throw new Error("Redis pairing finalization changed during completion");
      }
      return {
        status,
        pairingId: id,
        expiresAt: asInteger(reply[1], "pairing expiry"),
        activationRetryExpiresAt: asInteger(
          reply[4],
          "pairing activation retry expiry"
        ),
        activation: authoritativeActivation,
      };
    }
    if (status === "not_found" || status === "expired") return { status };
    throw new Error("unexpected pairing completion status: " + status);
  }

  async redeem(deviceCode) {
    let deviceCodeHash;
    try {
      deviceCodeHash = this._tokens.hashToken("pair-device", deviceCode);
    } catch (_error) {
      return { status: "not_found" };
    }
    const deviceKey = this._deviceKey(deviceCodeHash);
    const pairingId = await this._readIndex(deviceKey);
    if (!pairingId) return { status: "not_found" };
    const peek = asArray(
      await this._scripts.run(
        "pairingRedeemPeek",
        [deviceKey, this._recordKey(pairingId), this._globalKey],
        [pairingId, this._tombstoneTtlMs]
      ),
      "pairingRedeemPeek"
    );
    const status = asString(peek[0], "pairing redemption status");
    if (["not_found", "expired", "consumed", "cancelled"].includes(status)) return { status };
    if (status === "pending") {
      return {
        status,
        activationState: asString(peek[1], "pairing activation state"),
        pairingId: asString(peek[2], "pairing id"),
        expiresAt: asInteger(peek[3], "pairing expiry"),
      };
    }
    if (status === "ready" || status === "replay") {
      const id = asString(peek[1], "pairing id");
      const deviceId = asString(peek[2], "device id");
      if (id !== pairingId) throw new Error("Redis pairing redemption identity changed");
      const serializedEnvelope = asString(peek[3], "pairing envelope");
      const digest = asString(peek[4], "pairing activation digest");
      const activation = this._decryptActivation(serializedEnvelope, id, digest);
      if (status === "replay") {
        return { status: "redeemed", pairingId: id, deviceId, activation };
      }
      const reply = asArray(
        await this._scripts.run(
          "pairingRedeem",
          [deviceKey, this._recordKey(pairingId), this._globalKey],
          [pairingId, this._tombstoneTtlMs, serializedEnvelope, digest]
        ),
        "pairingRedeem"
      );
      const consumeStatus = asString(reply[0], "pairing redemption status");
      if (["not_found", "expired", "consumed", "cancelled"].includes(consumeStatus)) {
        return { status: consumeStatus };
      }
      if (consumeStatus === "pending") {
        return {
          status: consumeStatus,
          activationState: asString(reply[1], "pairing activation state"),
          pairingId: asString(reply[2], "pairing id"),
          expiresAt: asInteger(reply[3], "pairing expiry"),
        };
      }
      if (consumeStatus !== "redeemed") {
        throw new Error("unexpected pairing redemption status: " + consumeStatus);
      }
      const consumedId = asString(reply[1], "pairing id");
      const consumedDeviceId = asString(reply[2], "device id");
      if (consumedId !== id || consumedDeviceId !== deviceId) {
        throw new Error("Redis pairing redemption identity changed");
      }
      return {
        status: consumeStatus,
        pairingId: id,
        deviceId,
        activation,
      };
    }
    throw new Error("unexpected pairing redemption status: " + status);
  }

  async cancel(deviceCode) {
    let deviceCodeHash;
    try {
      deviceCodeHash = this._tokens.hashToken("pair-device", deviceCode);
    } catch (_error) {
      return false;
    }
    const deviceKey = this._deviceKey(deviceCodeHash);
    const pairingId = await this._readIndex(deviceKey);
    if (!pairingId) return false;
    const reply = asArray(
      await this._scripts.run(
        "pairingCancel",
        [deviceKey, this._recordKey(pairingId), this._globalKey],
        [pairingId, this._tombstoneTtlMs]
      ),
      "pairingCancel"
    );
    return asString(reply[0], "pairing cancellation status") === "cancelled";
  }

  async claimValidation(deviceCode) {
    let deviceCodeHash;
    try {
      deviceCodeHash = this._tokens.hashToken("pair-device", deviceCode);
    } catch (_error) {
      return null;
    }
    const deviceKey = this._deviceKey(deviceCodeHash);
    const pairingId = await this._readIndex(deviceKey);
    if (!pairingId) return null;
    const reply = asArray(
      await this._scripts.run(
        "pairingValidation",
        [deviceKey, this._recordKey(pairingId)],
        [pairingId]
      ),
      "pairingValidation"
    );
    const status = asString(reply[0], "pairing validation status");
    if (status === "none" || status === "not_found" || status === "expired") return null;
    if (status !== "scenario") throw new Error("unexpected pairing validation status: " + status);
    return {
      scenario: asString(reply[1], "pairing validation scenario"),
      rateLimitNow: asString(reply[2], "pairing validation rate-limit claim") === "1",
      expiresAt: asInteger(reply[3], "pairing expiry"),
    };
  }

  _activationReply(reply, expectedDigest) {
    const status = asString(reply[0], "pairing activation status");
    if (status === "conflict") throw codedError("pairing_conflict", "pairing is already activated with different data");
    if (status === "not_found" || status === "expired") return { status };
    if (status === "pending") return { status: "not_found" };
    if (status !== "activating" && status !== "activated") {
      throw new Error("unexpected pairing activation status: " + status);
    }
    const id = asString(reply[1], "pairing id");
    const digest = asString(reply[3], "pairing activation digest");
    if (digest !== expectedDigest) throw new Error("Redis pairing activation digest changed");
    return {
      status,
      pairingId: id,
      deviceId: asString(reply[2], "device id"),
      activationDigest: digest,
      expiresAt: asInteger(reply[4], "pairing expiry"),
      activationRetryExpiresAt: asInteger(
        reply[6],
        "pairing activation retry expiry"
      ),
      activation: this._decryptActivation(
        asString(reply[5], "pairing envelope"),
        id,
        digest
      ),
    };
  }

  _activationPayload(activation) {
    const stableActivation = canonicalJsonClone(activation, "pairing activation");
    delete stableActivation.deviceToken;
    delete stableActivation.profileId;
    return {
      stableActivation,
      digest: this._tokens.hashOpaque(
        "pair-activation",
        canonicalJson(stableActivation),
        64 * 1024
      ),
    };
  }

  _decryptActivation(serializedEnvelope, pairingId, expectedDigest) {
    const activation = this._crypto.decryptJson(
      jsonParse(serializedEnvelope, "pairing envelope"),
      this._purpose(pairingId)
    );
    assertPlainObject(activation, "pairing activation");
    assertJsonSize(activation, "pairing activation", 64 * 1024);
    this._tokens.hashToken("device", activation.deviceToken);
    if (activation.profileId !== undefined) assertIdentifier(activation.profileId, "profile id");
    const stableActivation = { ...activation };
    delete stableActivation.deviceToken;
    delete stableActivation.profileId;
    const actualDigest = this._tokens.hashOpaque(
      "pair-activation",
      canonicalJson(stableActivation),
      64 * 1024
    );
    if (actualDigest !== expectedDigest) {
      throw new Error("Redis pairing activation digest does not match its envelope");
    }
    return activation;
  }

  async _readIndex(key) {
    const value = await this._client.get(key);
    if (value === null || value === undefined) return null;
    return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  }

  _newUserCode() {
    const random = this._randomBytes(8);
    if (!Buffer.isBuffer(random) || random.length !== 8) {
      throw new TypeError("randomBytes returned an invalid pairing buffer");
    }
    try {
      let code = "";
      for (const byte of random) code += PAIR_CODE_ALPHABET[byte & 31];
      return code;
    } finally {
      random.fill(0);
    }
  }

  _recordKey(pairingId) {
    return this._keys.key("pairing-record-v2", pairingId);
  }

  _userKey(userCodeHash) {
    return this._keys.key("pairing-user-v2", userCodeHash);
  }

  _deviceKey(deviceCodeHash) {
    return this._keys.key("pairing-device-v2", deviceCodeHash);
  }

  _retryKey(activationRetryHash) {
    return this._keys.key("pairing-retry-v2", activationRetryHash);
  }

  _purpose(pairingId) {
    return "pair-activation:" + stableScope("pairing", pairingId);
  }
}

module.exports = {
  RedisPairingRepository,
  formatPairCode,
  normalizePairCode,
};
