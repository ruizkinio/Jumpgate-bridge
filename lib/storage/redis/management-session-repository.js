"use strict";

const {
  assertIdentifier,
  codedError,
  stableScope,
} = require("../repository-utils");
const {
  assertActivationRetryToken,
  assertSha256Digest,
  canonicalJsonClone,
} = require("../pairing-replay");
const { initializeRedisOptions, jsonParse, jsonStringify } = require("./base");
const { asArray, asInteger, asString } = require("./reply");

class RedisManagementSessionRepository {
  constructor(options = {}) {
    const shared = initializeRedisOptions(options);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._keys = shared.keyspace;
    this._scripts = shared.scripts;
    this._tokens = options.tokenService;
    this._crypto = options.envelopeCrypto;
    this._ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this._pairingReplayTtlMs = options.pairingReplayTtlMs ?? 10 * 60 * 1000;
    this._maxSessions = options.maxSessions ?? 4096;
    this._maxSessionsPerProfile = options.maxSessionsPerProfile ?? 8;
    this._isProfileActive = options.isProfileActive || (async () => true);
    if (typeof this._isProfileActive !== "function") {
      throw new TypeError("isProfileActive must be a function");
    }
    if (!Number.isSafeInteger(this._ttlMs) || this._ttlMs < 1000 || this._ttlMs > 24 * 60 * 60 * 1000) {
      throw new TypeError("session ttl is invalid");
    }
    if (
      !Number.isSafeInteger(this._pairingReplayTtlMs) ||
      this._pairingReplayTtlMs < 1000 ||
      this._pairingReplayTtlMs > 60 * 60 * 1000
    ) {
      throw new TypeError("pairing replay ttl is invalid");
    }
    if (!Number.isSafeInteger(this._maxSessions) || this._maxSessions < 1 || this._maxSessions > 100000) {
      throw new TypeError("maxSessions is invalid");
    }
    if (
      !Number.isSafeInteger(this._maxSessionsPerProfile) ||
      this._maxSessionsPerProfile < 1 ||
      this._maxSessionsPerProfile > this._maxSessions
    ) {
      throw new TypeError("maxSessionsPerProfile is invalid");
    }
    this._globalKey = this._keys.key("management-global", "sessions");
  }

  async issue(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const generationReply = asArray(
      await this._scripts.run("managementGeneration", [this._profileGenerationKey(id)]),
      "managementGeneration"
    );
    const generationStatus = asString(generationReply[0], "management generation status");
    if (generationStatus === "revoked") {
      throw codedError("profile_inactive", "profile management access is revoked");
    }
    if (generationStatus !== "generation") throw new Error("unexpected management generation status");
    const generation = asInteger(generationReply[1], "management profile generation");
    if (!(await this._isProfileActive(id))) {
      throw new Error("profile is inactive");
    }
    const session = this._tokens.issue("management-session", 32);
    const csrf = this._tokens.issue("management-csrf", 24);
    const reply = asArray(
      await this._scripts.run(
        "managementIssue",
        [
          this._sessionKey(session.tokenHash),
          this._globalKey,
          this._profileKey(id),
          this._profileGenerationKey(id),
        ],
        [
          id,
          csrf.tokenHash,
          this._ttlMs,
          this._maxSessions,
          this._maxSessionsPerProfile,
          String(generation),
        ]
      ),
      "managementIssue"
    );
    const status = asString(reply[0], "management issue status");
    if (status === "global_capacity") throw new Error("management session capacity reached");
    if (status === "profile_capacity") throw new Error("profile management session limit reached");
    if (status === "collision") throw new Error("management session token collision");
    if (status === "profile_changed") {
      throw codedError("profile_inactive", "profile changed during management session issuance");
    }
    if (status !== "ok") throw new Error("unexpected management issue status: " + status);
    return {
      sessionToken: session.token,
      csrfToken: csrf.token,
      expiresAt: asInteger(reply[1], "management session expiry"),
    };
  }

  async issueForPairing(input = {}) {
    if (!this._crypto) throw new TypeError("envelopeCrypto is required for pairing replay");
    const details = this._pairingInput(input, true);
    const generation = await this._managementGeneration(details.profileId);
    if (!(await this._isProfileActive(details.profileId))) {
      throw codedError("profile_inactive", "profile is inactive");
    }
    const session = this._tokens.issue("management-session", 32);
    const csrf = this._tokens.issue("management-csrf", 24);
    const envelope = this._crypto.encryptJson(
      {
        schemaVersion: 1,
        pairingId: details.pairingId,
        profileId: details.profileId,
        configHash: details.configHash,
        sessionToken: session.token,
        csrfToken: csrf.token,
        authority: details.authority,
      },
      this._pairingPurpose(details.pairingId)
    );
    const reply = asArray(
      await this._scripts.run(
        "managementPairingIssue",
        [
          this._sessionKey(session.tokenHash),
          this._globalKey,
          this._profileKey(details.profileId),
          this._profileGenerationKey(details.profileId),
          this._pairingReplayKey(details.retryHash),
        ],
        [
          details.profileId,
          csrf.tokenHash,
          this._ttlMs,
          this._maxSessions,
          this._maxSessionsPerProfile,
          String(generation),
          details.pairingHash,
          details.configHash,
          jsonStringify(envelope, "pairing replay envelope"),
          this._pairingReplayTtlMs,
          details.activationRetryExpiresAt,
        ]
      ),
      "managementPairingIssue"
    );
    return this._pairingReply(reply, details);
  }

  async recoverPairing(input = {}) {
    if (!this._crypto) throw new TypeError("envelopeCrypto is required for pairing replay");
    const details = this._pairingInput(input, false);
    const reply = asArray(
      await this._scripts.run(
        "managementPairingRecover",
        [this._pairingReplayKey(details.retryHash), this._globalKey],
        [details.pairingHash, details.configHash]
      ),
      "managementPairingRecover"
    );
    const result = this._pairingReply(reply, details);
    if (result.status !== "replayed") return result;
    if (!(await this._isProfileActive(details.profileId))) {
      await this.revokePairing(input);
      return { status: "denied" };
    }
    const confirmed = asArray(
      await this._scripts.run(
        "managementPairingRecover",
        [this._pairingReplayKey(details.retryHash), this._globalKey],
        [details.pairingHash, details.configHash]
      ),
      "managementPairingRecover"
    );
    return this._pairingReply(confirmed, details);
  }

  async revokePairing(input = {}) {
    const details = this._pairingInput(input, false);
    const reply = asArray(
      await this._scripts.run(
        "managementPairingRevoke",
        [this._pairingReplayKey(details.retryHash), this._globalKey],
        [details.pairingHash, details.configHash]
      ),
      "managementPairingRevoke"
    );
    const status = asString(reply[0], "management pairing revoke status");
    if (status === "revoked" || status === "denied" || status === "not_found") {
      return { status };
    }
    if (status === "conflict") {
      throw codedError("pairing_conflict", "pairing configuration changed");
    }
    throw new Error("unexpected management pairing revoke status: " + status);
  }

  async authenticate(sessionToken, csrfToken) {
    let sessionHash;
    let csrfHash;
    try {
      sessionHash = this._tokens.hashToken("management-session", sessionToken);
      csrfHash = this._tokens.hashToken("management-csrf", csrfToken);
    } catch (_error) {
      return null;
    }
    const reply = asArray(
      await this._scripts.run(
        "managementAuthenticate",
        [this._sessionKey(sessionHash), this._globalKey],
        [csrfHash]
      ),
      "managementAuthenticate"
    );
    const status = asString(reply[0], "management authentication status");
    if (status === "not_found" || status === "csrf_mismatch") return null;
    if (status !== "authenticated") throw new Error("unexpected management authentication status: " + status);
    const profileId = asString(reply[1], "management profile id");
    if (!(await this._isProfileActive(profileId))) {
      await this.revoke(sessionToken);
      return null;
    }
    return {
      profileId,
      expiresAt: asInteger(reply[2], "management session expiry"),
      managementGeneration: asInteger(reply[3], "management profile generation"),
    };
  }

  async revoke(sessionToken) {
    let sessionHash;
    try {
      sessionHash = this._tokens.hashToken("management-session", sessionToken);
    } catch (_error) {
      return false;
    }
    const reply = asArray(
      await this._scripts.run("managementRevoke", [this._sessionKey(sessionHash), this._globalKey]),
      "managementRevoke"
    );
    return asString(reply[0], "management revoke status") === "revoked";
  }

  async revokeProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const reply = asArray(
      await this._scripts.run(
        "managementRevokeProfile",
        [this._globalKey, this._profileKey(id), this._profileGenerationKey(id)],
        [id, this._maxSessionsPerProfile]
      ),
      "managementRevokeProfile"
    );
    const status = asString(reply[0], "management profile revoke status");
    if (status !== "revoked") {
      throw new Error("unexpected management profile revoke status: " + status);
    }
    return asInteger(reply[1], "management revoked session count");
  }

  async _managementGeneration(profileId) {
    const generationReply = asArray(
      await this._scripts.run(
        "managementGeneration",
        [this._profileGenerationKey(profileId)]
      ),
      "managementGeneration"
    );
    const generationStatus = asString(
      generationReply[0],
      "management generation status"
    );
    if (generationStatus === "revoked") {
      throw codedError("profile_inactive", "profile management access is revoked");
    }
    if (generationStatus !== "generation") {
      throw new Error("unexpected management generation status");
    }
    return asInteger(generationReply[1], "management profile generation");
  }

  _pairingInput(input, requireAuthority) {
    const details = canonicalJsonClone(input, "pairing management input");
    const allowed = new Set([
      "activationRetryExpiresAt",
      "activationRetryToken",
      "authority",
      "configHash",
      "pairingId",
      "profileId",
    ]);
    if (Object.keys(details).some((key) => !allowed.has(key))) {
      throw new TypeError("pairing management input contains an unknown field");
    }
    const pairingId = assertIdentifier(details.pairingId, "pairing id");
    const profileId = assertIdentifier(details.profileId, "profile id");
    const retryToken = assertActivationRetryToken(details.activationRetryToken);
    const configHash = assertSha256Digest(details.configHash, "pairing config hash");
    if (
      !Number.isSafeInteger(details.activationRetryExpiresAt) ||
      details.activationRetryExpiresAt < 0
    ) {
      throw new TypeError("pairing activation retry expiry is invalid");
    }
    return {
      pairingId,
      pairingHash: this._tokens.hashOpaque("management-pairing-id", pairingId, 200),
      profileId,
      retryHash: this._tokens.hashToken("pair-activation-retry", retryToken),
      configHash,
      activationRetryExpiresAt: details.activationRetryExpiresAt,
      authority: requireAuthority
        ? canonicalJsonClone(details.authority, "pairing response authority")
        : null,
    };
  }

  _pairingReply(reply, details) {
    const status = asString(reply[0], "management pairing status");
    if (status === "not_found" || status === "denied") return { status };
    if (status === "conflict") {
      throw codedError("pairing_conflict", "pairing configuration changed");
    }
    if (status === "global_capacity") throw new Error("management session capacity reached");
    if (status === "profile_capacity") throw new Error("profile management session limit reached");
    if (status === "collision") throw new Error("management session token collision");
    if (status === "profile_changed") {
      throw codedError("profile_inactive", "profile changed during management session issuance");
    }
    if (status !== "issued" && status !== "replayed") {
      throw new Error("unexpected management pairing status: " + status);
    }
    const value = this._crypto.decryptJson(
      jsonParse(asString(reply[1], "pairing replay envelope"), "pairing replay envelope"),
      this._pairingPurpose(details.pairingId)
    );
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.pairingId !== details.pairingId ||
      value.profileId !== details.profileId ||
      value.configHash !== details.configHash ||
      typeof value.sessionToken !== "string" ||
      typeof value.csrfToken !== "string"
    ) {
      throw new Error("pairing replay authority is invalid");
    }
    this._tokens.hashToken("management-session", value.sessionToken);
    this._tokens.hashToken("management-csrf", value.csrfToken);
    return {
      status,
      sessionToken: value.sessionToken,
      csrfToken: value.csrfToken,
      expiresAt: asInteger(reply[2], "management session expiry"),
      replayExpiresAt: asInteger(reply[3], "management pairing replay expiry"),
      authority: value.authority,
    };
  }

  _sessionKey(sessionHash) {
    return this._keys.key("management-session", sessionHash);
  }

  _profileKey(profileId) {
    return this._keys.key("management-profile", profileId);
  }

  _profileGenerationKey(profileId) {
    return this._keys.key("management-profile-generation", profileId);
  }

  _pairingReplayKey(retryHash) {
    return this._keys.key("management-pairing-replay", retryHash);
  }

  _pairingPurpose(pairingId) {
    return "management-pairing-replay:" + stableScope("pairing-management", pairingId);
  }
}

module.exports = {
  RedisManagementSessionRepository,
};
