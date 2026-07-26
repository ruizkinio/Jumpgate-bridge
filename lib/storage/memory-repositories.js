"use strict";

const {
  codedError,
  assertIdentifier,
  addDuration,
  cloneJson,
  readClock,
  stableScope,
} = require("./repository-utils");
const {
  assertActivationRetryToken,
  assertSha256Digest,
  canonicalJsonClone,
} = require("./pairing-replay");
const {
  MemoryProfileRepository,
  MemoryProviderRepository,
} = require("./memory-profile-provider-repositories");

class MemoryManagementGenerationStore {
  constructor() {
    this._profiles = new Map();
  }

  read(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const record = this._profiles.get(id);
    return record
      ? Object.freeze({ generation: record.generation, revoked: record.revoked })
      : Object.freeze({ generation: 0, revoked: false });
  }

  isCurrent(profileId, generation) {
    const current = this.read(profileId);
    return !current.revoked && current.generation === generation;
  }

  revoke(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const current = this.read(id);
    if (current.revoked) return current;
    if (current.generation >= Number.MAX_SAFE_INTEGER) {
      throw new Error("management profile generation exhausted");
    }
    const revoked = {
      generation: current.generation + 1,
      revoked: true,
    };
    this._profiles.set(id, revoked);
    return Object.freeze({ ...revoked });
  }
}

class MemoryManagementSessionRepository {
  constructor(options = {}) {
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
    this._ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this._pairingReplayTtlMs = options.pairingReplayTtlMs ?? 10 * 60 * 1000;
    this._maxSessions = options.maxSessions ?? 4096;
    this._maxSessionsPerProfile = options.maxSessionsPerProfile ?? 8;
    this._isProfileActive = options.isProfileActive || (async () => true);
    this._generations = options.managementGenerations || new MemoryManagementGenerationStore();
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
    this._sessions = new Map();
    this._pairingReplays = new Map();
  }

  async issue(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const authority = this._generations.read(id);
    if (authority.revoked) {
      throw codedError("profile_inactive", "profile management access is revoked");
    }
    const generation = authority.generation;
    if (!(await this._isProfileActive(id))) {
      throw new Error("profile is inactive");
    }
    if (!this._generations.isCurrent(id, generation)) {
      throw codedError("profile_inactive", "profile generation changed during management session issuance");
    }
    const now = readClock(this._clock);
    this._prune(now);
    if (this._sessions.size >= this._maxSessions) {
      throw new Error("management session capacity reached");
    }
    let profileSessions = 0;
    for (const record of this._sessions.values()) {
      if (record.profileId === id) profileSessions += 1;
    }
    if (profileSessions >= this._maxSessionsPerProfile) {
      throw new Error("profile management session limit reached");
    }
    const session = this._tokens.issue("management-session", 32);
    const csrf = this._tokens.issue("management-csrf", 24);
    if (this._sessions.has(session.tokenHash)) throw new Error("management session token collision");
    const expiresAt = addDuration(now, this._ttlMs, "management session expiry");
    this._sessions.set(session.tokenHash, {
      profileId: id,
      managementGeneration: generation,
      csrfHash: csrf.tokenHash,
      createdAt: now,
      expiresAt,
    });
    return { sessionToken: session.token, csrfToken: csrf.token, expiresAt };
  }

  async issueForPairing(input = {}) {
    if (!this._crypto) throw new TypeError("envelopeCrypto is required for pairing replay");
    const details = this._pairingInput(input, true);
    const authority = this._generations.read(details.profileId);
    if (authority.revoked) {
      throw codedError("profile_inactive", "profile management access is revoked");
    }
    const generation = authority.generation;
    if (!(await this._isProfileActive(details.profileId))) {
      throw codedError("profile_inactive", "profile is inactive");
    }
    if (!this._generations.isCurrent(details.profileId, generation)) {
      throw codedError("profile_inactive", "profile changed during pairing session issuance");
    }

    const now = readClock(this._clock);
    this._prune(now);
    const existing = this._pairingReplays.get(details.retryHash);
    if (existing) return this._pairingReplayResult(existing, details, now, "replayed");
    if (details.activationRetryExpiresAt <= now) return { status: "denied" };

    if (this._sessions.size >= this._maxSessions) {
      throw new Error("management session capacity reached");
    }
    let profileSessions = 0;
    for (const record of this._sessions.values()) {
      if (record.profileId === details.profileId) profileSessions += 1;
    }
    if (profileSessions >= this._maxSessionsPerProfile) {
      throw new Error("profile management session limit reached");
    }

    const session = this._tokens.issue("management-session", 32);
    const csrf = this._tokens.issue("management-csrf", 24);
    if (this._sessions.has(session.tokenHash)) throw new Error("management session token collision");
    const expiresAt = addDuration(now, this._ttlMs, "management session expiry");
    const denialExpiresAt = Math.min(
      details.activationRetryExpiresAt,
      addDuration(now, this._pairingReplayTtlMs, "pairing replay denial expiry")
    );
    const replayExpiresAt = Math.min(denialExpiresAt, expiresAt);
    if (replayExpiresAt <= now) return { status: "denied" };

    const envelope = this._crypto.encryptJson(
      {
        schemaVersion: 1,
        pairingId: details.pairingId,
        profileId: details.profileId,
        configHash: details.configHash,
        sessionToken: session.token,
        csrfToken: csrf.token,
        authority: cloneJson(details.authority),
      },
      this._pairingPurpose(details.pairingId)
    );
    this._sessions.set(session.tokenHash, {
      profileId: details.profileId,
      managementGeneration: generation,
      csrfHash: csrf.tokenHash,
      pairingRetryHash: details.retryHash,
      createdAt: now,
      expiresAt,
    });
    const replay = {
      status: "issued",
      pairingHash: details.pairingHash,
      configHash: details.configHash,
      sessionHash: session.tokenHash,
      authorityEnvelope: envelope,
      replayExpiresAt,
      denialExpiresAt,
    };
    this._pairingReplays.set(details.retryHash, replay);
    return this._pairingReplayResult(replay, details, now, "issued");
  }

  async recoverPairing(input = {}) {
    if (!this._crypto) throw new TypeError("envelopeCrypto is required for pairing replay");
    const details = this._pairingInput(input, false);
    const now = readClock(this._clock);
    this._prune(now);
    let replay = this._pairingReplays.get(details.retryHash);
    if (!replay) return { status: "not_found" };
    const initial = this._pairingReplayResult(replay, details, now, "replayed");
    if (initial.status !== "replayed") return initial;
    const session = this._sessions.get(replay.sessionHash);
    if (
      !session ||
      session.expiresAt <= now ||
      !this._generations.isCurrent(session.profileId, session.managementGeneration)
    ) {
      this._denyPairingReplay(details.retryHash, replay, now);
      return { status: "denied" };
    }
    if (!(await this._isProfileActive(session.profileId))) {
      this._denyPairingReplay(details.retryHash, replay, now);
      return { status: "denied" };
    }
    replay = this._pairingReplays.get(details.retryHash);
    const currentSession = replay && replay.sessionHash
      ? this._sessions.get(replay.sessionHash)
      : null;
    if (
      !replay ||
      replay.status !== "issued" ||
      !currentSession ||
      currentSession.expiresAt <= readClock(this._clock) ||
      !this._generations.isCurrent(
        currentSession.profileId,
        currentSession.managementGeneration
      )
    ) {
      if (replay) this._denyPairingReplay(details.retryHash, replay, readClock(this._clock));
      return { status: "denied" };
    }
    return this._pairingReplayResult(replay, details, readClock(this._clock), "replayed");
  }

  async revokePairing(input = {}) {
    const details = this._pairingInput(input, false);
    const now = readClock(this._clock);
    this._prune(now);
    const replay = this._pairingReplays.get(details.retryHash);
    if (!replay) return { status: "not_found" };
    const checked = this._pairingReplayResult(replay, details, now, "replayed");
    if (checked.status === "not_found") return checked;
    this._denyPairingReplay(details.retryHash, replay, now);
    return { status: "revoked" };
  }

  async authenticate(sessionToken, csrfToken) {
    const now = readClock(this._clock);
    this._prune(now);
    let sessionHash;
    try {
      sessionHash = this._tokens.hashToken("management-session", sessionToken);
    } catch (_err) {
      return null;
    }
    const record = this._sessions.get(sessionHash);
    if (!record || !this._tokens.matchesToken("management-csrf", csrfToken, record.csrfHash)) return null;
    if (!this._generations.isCurrent(record.profileId, record.managementGeneration)) {
      this._sessions.delete(sessionHash);
      return null;
    }
    if (!(await this._isProfileActive(record.profileId))) {
      this._sessions.delete(sessionHash);
      return null;
    }
    if (!this._generations.isCurrent(record.profileId, record.managementGeneration)) {
      this._sessions.delete(sessionHash);
      return null;
    }
    return {
      profileId: record.profileId,
      managementGeneration: record.managementGeneration,
      expiresAt: record.expiresAt,
    };
  }

  async revoke(sessionToken) {
    let sessionHash;
    try {
      sessionHash = this._tokens.hashToken("management-session", sessionToken);
    } catch (_err) {
      return false;
    }
    const record = this._sessions.get(sessionHash);
    if (!record) return false;
    this._sessions.delete(sessionHash);
    if (record.pairingRetryHash) {
      const replay = this._pairingReplays.get(record.pairingRetryHash);
      if (replay) this._denyPairingReplay(record.pairingRetryHash, replay, readClock(this._clock));
    }
    return true;
  }

  async revokeProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    this._generations.revoke(id);
    let revoked = 0;
    for (const [sessionHash, record] of this._sessions) {
      if (record.profileId !== id) continue;
      this._sessions.delete(sessionHash);
      if (record.pairingRetryHash) {
        const replay = this._pairingReplays.get(record.pairingRetryHash);
        if (replay) {
          this._denyPairingReplay(record.pairingRetryHash, replay, readClock(this._clock));
        }
      }
      revoked += 1;
    }
    return revoked;
  }

  storageSnapshot() {
    return Array.from(this._sessions.entries(), ([sessionHash, record]) => ({
      sessionHash,
      ...cloneJson(record),
    }));
  }

  pairingReplaySnapshot() {
    return Array.from(this._pairingReplays.entries(), ([retryHash, record]) => ({
      retryHash,
      ...cloneJson(record),
    }));
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
    const activationRetryExpiresAt = details.activationRetryExpiresAt;
    if (
      !Number.isSafeInteger(activationRetryExpiresAt) ||
      activationRetryExpiresAt < 0
    ) {
      throw new TypeError("pairing activation retry expiry is invalid");
    }
    const authority = requireAuthority
      ? canonicalJsonClone(details.authority, "pairing response authority")
      : null;
    return {
      pairingId,
      pairingHash: this._tokens.hashOpaque("management-pairing-id", pairingId, 200),
      profileId,
      retryHash: this._tokens.hashToken("pair-activation-retry", retryToken),
      configHash,
      activationRetryExpiresAt,
      authority,
    };
  }

  _pairingReplayResult(replay, details, now, status) {
    if (replay.pairingHash !== details.pairingHash) return { status: "not_found" };
    if (replay.configHash !== details.configHash) {
      throw codedError("pairing_conflict", "pairing configuration changed");
    }
    if (replay.status !== "issued" || replay.replayExpiresAt <= now) {
      return { status: "denied" };
    }
    if (!replay.authorityEnvelope || !replay.sessionHash) return { status: "denied" };
    const value = this._crypto.decryptJson(
      replay.authorityEnvelope,
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
    const sessionHash = this._tokens.hashToken("management-session", value.sessionToken);
    const csrfHash = this._tokens.hashToken("management-csrf", value.csrfToken);
    const session = this._sessions.get(sessionHash);
    if (
      sessionHash !== replay.sessionHash ||
      !session ||
      session.csrfHash !== csrfHash ||
      session.profileId !== details.profileId
    ) {
      return { status: "denied" };
    }
    return {
      status,
      sessionToken: value.sessionToken,
      csrfToken: value.csrfToken,
      expiresAt: session.expiresAt,
      replayExpiresAt: replay.replayExpiresAt,
      authority: cloneJson(value.authority),
    };
  }

  _denyPairingReplay(retryHash, replay, now, options = {}) {
    if (!replay) return;
    if (options.revokeSession !== false && replay.sessionHash) {
      this._sessions.delete(replay.sessionHash);
    }
    replay.status = "denied";
    replay.sessionHash = null;
    replay.authorityEnvelope = null;
    replay.deniedAt = now;
    if (replay.denialExpiresAt <= now) this._pairingReplays.delete(retryHash);
  }

  _pairingPurpose(pairingId) {
    return "management-pairing-replay:" + stableScope("pairing-management", pairingId);
  }

  _prune(now) {
    for (const [key, record] of this._sessions) {
      if (!record || record.expiresAt <= now) {
        this._sessions.delete(key);
        if (record && record.pairingRetryHash) {
          const replay = this._pairingReplays.get(record.pairingRetryHash);
          if (replay) this._denyPairingReplay(record.pairingRetryHash, replay, now);
        }
      }
    }
    for (const [retryHash, replay] of this._pairingReplays) {
      if (replay.denialExpiresAt <= now) {
        this._pairingReplays.delete(retryHash);
      } else if (replay.status === "issued" && replay.replayExpiresAt <= now) {
        this._denyPairingReplay(retryHash, replay, now, { revokeSession: false });
      }
    }
  }
}

module.exports = {
  MemoryManagementGenerationStore,
  MemoryManagementSessionRepository,
  MemoryProfileRepository,
  MemoryProviderRepository,
};
