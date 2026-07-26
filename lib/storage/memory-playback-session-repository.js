"use strict";

const {
  ACTIVE_DISPATCH_STATES,
  dispatchError,
  normalizeAdmissionInput,
  normalizeClaimInput,
  normalizeOpenInput,
  normalizeRetryInput,
  normalizeSessionInvalidation,
  normalizeSourceInvalidation,
  normalizeTransitionAndDispatchInput,
  normalizeTransitionInput,
  publicDispatch,
  publicSession,
  sameBinding,
  sameDispatch,
} = require("./playback-session");
const { ProfileLifecycleCoordinator } = require("./lifecycle-invalidation");
const {
  assertIdentifier,
  assertPositiveInteger,
  cloneJson,
  codedError,
  readClock,
} = require("./repository-utils");

function sessionKey(profileId, sessionId) {
  return profileId + "\0" + sessionId;
}

function dispatchKey(profileId, dispatchId) {
  return profileId + "\0" + dispatchId;
}

function sourceKey(profileId, contextId, playbackGeneration, contextRevision) {
  return [profileId, contextId, playbackGeneration, contextRevision].join("\0");
}

function deviceKey(profileId, deviceId) {
  return profileId + "\0" + deviceId;
}

function clearLease(record) {
  record.leaseTokenHash = null;
  record.leaseOwner = null;
  record.leaseExpiresAt = null;
}

class MemoryPlaybackSessionRepository {
  constructor(options = {}) {
    if (!options.tokenService) throw new TypeError("tokenService is required");
    if (typeof options.getProfileBinding !== "function") {
      throw new TypeError("getProfileBinding is required");
    }
    if (typeof options.isDeviceBindingActive !== "function") {
      throw new TypeError("isDeviceBindingActive is required");
    }
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();
    this._getProfileBinding = options.getProfileBinding;
    this._isDeviceBindingActive = options.isDeviceBindingActive;
    this._sessions = new Map();
    this._dispatches = new Map();
    this._sourceRevocations = new Set();
    this._profileInvalidations = new Map();
    this._deviceInvalidations = new Map();
  }

  async openSession(input) {
    const candidate = normalizeOpenInput(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      await this._assertDurableBinding(candidate);
      if (this._sourceRevocations.has(this._sourceKey(candidate))) {
        throw codedError("playback_source_revoked", "source claim has been durably revoked");
      }
      const key = sessionKey(candidate.profileId, candidate.sessionId);
      const existing = this._sessions.get(key);
      if (existing) {
        if (existing.state === "released") {
          throw codedError("playback_session_released", "playback session is terminal");
        }
        if (!sameBinding(existing, candidate) || existing.state !== candidate.state) {
          throw codedError("playback_session_stale", "playback session binding is stale");
        }
        return publicSession(existing);
      }
      const now = readClock(this._clock);
      const record = {
        ...candidate,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        invalidatedAt: null,
      };
      this._sessions.set(key, record);
      return publicSession(record);
    });
  }

  async getSession(profileId, sessionId) {
    return publicSession(this._sessions.get(sessionKey(
      assertIdentifier(profileId, "profile id"),
      assertIdentifier(sessionId, "playback session id")
    )));
  }

  async transition(input) {
    const candidate = normalizeTransitionInput(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () =>
      publicSession(await this._transitionNow(candidate))
    );
  }

  async transitionAndEnqueue(input) {
    const candidate = normalizeTransitionAndDispatchInput(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      const profile = await this._assertDurableBinding(candidate);
      const historyGeneration = assertPositiveInteger(
        profile.historyGeneration,
        "history generation",
        Number.MAX_SAFE_INTEGER
      );
      const existingDispatch = this._dispatches.get(
        dispatchKey(candidate.profileId, candidate.dispatch.id)
      );
      if (existingDispatch) {
        const session = this._sessions.get(sessionKey(candidate.profileId, candidate.sessionId));
        if (
          session &&
          sameBinding(session, candidate) &&
          sameBinding(existingDispatch, candidate) &&
          existingDispatch.historyGeneration === historyGeneration &&
          existingDispatch.sessionRevision === session.revision &&
          sameDispatch(existingDispatch, candidate.dispatch)
        ) {
          return Object.freeze({
            session: publicSession(session),
            dispatch: publicDispatch(existingDispatch),
          });
        }
        throw codedError("scrobble_dispatch_conflict", "scrobble dispatch id is already bound");
      }

      const session = await this._transitionNow(candidate);
      const now = readClock(this._clock);
      const record = {
        ...candidate,
        ...candidate.dispatch,
        historyGeneration,
        sessionRevision: session.revision,
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: now,
        leaseTokenHash: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
        deliveredAt: null,
        revokedAt: null,
      };
      delete record.dispatch;
      delete record.expectedRevision;
      delete record.state;
      this._dispatches.set(dispatchKey(record.profileId, record.id), record);
      return Object.freeze({ session: publicSession(session), dispatch: publicDispatch(record) });
    });
  }

  async claimDispatch(input) {
    const claim = normalizeClaimInput(input);
    for (;;) {
      const now = readClock(this._clock);
      const candidate = Array.from(this._dispatches.values())
        .filter((record) => this._claimable(record, now))
        .sort((left, right) =>
          left.nextAttemptAt - right.nextAttemptAt ||
          left.createdAt - right.createdAt ||
          left.id.localeCompare(right.id)
        )[0];
      if (!candidate) return null;

      const outcome = await this._lifecycleCoordinator.run(candidate.profileId, async () => {
        const current = this._dispatches.get(dispatchKey(candidate.profileId, candidate.id));
        const currentNow = readClock(this._clock);
        if (!current || !this._claimable(current, currentNow)) return null;
        if (!(await this._isDispatchAuthoritative(current))) {
          this._revokeDispatch(current, currentNow);
          return false;
        }
        const issued = this._tokens.issue("scrobble-dispatch-lease", 32);
        current.status = "leased";
        current.attemptCount += 1;
        current.leaseTokenHash = issued.tokenHash;
        current.leaseOwner = claim.workerId;
        current.leaseExpiresAt = currentNow + claim.leaseMs;
        current.updatedAt = currentNow;
        return Object.freeze({ dispatch: publicDispatch(current), leaseToken: issued.token });
      });
      if (outcome === false || outcome === null) continue;
      return outcome;
    }
  }

  async withDispatchAdmission(input, operation) {
    const admission = normalizeAdmissionInput(input);
    if (typeof operation !== "function") {
      throw new TypeError("scrobble dispatch operation is required");
    }
    let leaseTokenHash;
    try {
      leaseTokenHash = this._tokens.hashToken("scrobble-dispatch-lease", admission.leaseToken);
    } catch (_error) {
      throw dispatchError("scrobble_dispatch_lease_lost", "scrobble dispatch lease is not owned");
    }
    return this._lifecycleCoordinator.run(admission.profileId, async () => {
      const record = this._dispatches.get(dispatchKey(admission.profileId, admission.dispatchId));
      if (record && record.status === "revoked") {
        throw dispatchError("scrobble_dispatch_revoked", "scrobble dispatch was revoked");
      }
      const now = readClock(this._clock);
      if (
        !record ||
        record.status !== "leased" ||
        record.leaseTokenHash !== leaseTokenHash ||
        record.leaseExpiresAt <= now
      ) {
        throw dispatchError("scrobble_dispatch_lease_lost", "scrobble dispatch lease is not owned");
      }
      if (!(await this._isDispatchAuthoritative(record))) {
        this._revokeDispatch(record, now);
        throw dispatchError("scrobble_dispatch_revoked", "scrobble dispatch was revoked");
      }

      const result = await operation(publicDispatch(record));
      if (record.status !== "leased" || record.leaseTokenHash !== leaseTokenHash) {
        throw dispatchError("scrobble_dispatch_lease_lost", "scrobble dispatch lease is not owned");
      }
      record.status = "delivered";
      record.deliveredAt = readClock(this._clock);
      record.updatedAt = record.deliveredAt;
      clearLease(record);
      return result;
    });
  }

  async retryDispatch(input) {
    const retry = normalizeRetryInput(input);
    let leaseTokenHash;
    try {
      leaseTokenHash = this._tokens.hashToken("scrobble-dispatch-lease", retry.leaseToken);
    } catch (_error) {
      return false;
    }
    return this._lifecycleCoordinator.run(retry.profileId, async () => {
      const record = this._dispatches.get(dispatchKey(retry.profileId, retry.dispatchId));
      if (
        !record ||
        record.status !== "leased" ||
        record.leaseTokenHash !== leaseTokenHash
      ) {
        return false;
      }
      if (!(await this._isDispatchAuthoritative(record))) {
        this._revokeDispatch(record, readClock(this._clock));
        return false;
      }
      record.status = "queued";
      record.nextAttemptAt = retry.nextAttemptAt;
      record.updatedAt = readClock(this._clock);
      clearLease(record);
      return true;
    });
  }

  async invalidateProfile(profileId, profileRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const revision = assertPositiveInteger(
      profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    );
    return this._lifecycleCoordinator.run(id, async () =>
      this.invalidateProfileNow(id, revision)
    );
  }

  invalidateProfileNow(profileId, profileRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const revision = assertPositiveInteger(
      profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    );
    const previous = this._profileInvalidations.get(id) || 0;
    if (revision <= previous) return 0;
    this._profileInvalidations.set(id, revision);
    return this._releaseMatching(
      (record) => record.profileId === id && record.profileRevision < revision
    );
  }

  async invalidateDevice(profileId, deviceId, deviceGeneration) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedDeviceId = assertIdentifier(deviceId, "device id");
    const generation = assertPositiveInteger(
      deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    return this._lifecycleCoordinator.run(scopedProfileId, async () =>
      this.invalidateDeviceNow(scopedProfileId, scopedDeviceId, generation)
    );
  }

  invalidateDeviceNow(profileId, deviceId, deviceGeneration) {
    const key = deviceKey(profileId, deviceId);
    const previous = this._deviceInvalidations.get(key) || 0;
    if (deviceGeneration <= previous) return 0;
    this._deviceInvalidations.set(key, deviceGeneration);
    return this._releaseMatching((record) =>
      record.profileId === profileId &&
      record.deviceId === deviceId &&
      record.deviceGeneration < deviceGeneration
    );
  }

  async invalidateSession(input) {
    const candidate = normalizeSessionInvalidation(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      const record = this._sessions.get(sessionKey(candidate.profileId, candidate.sessionId));
      this._assertSession(record, candidate);
      if (record.state === "released") return false;
      this._releaseSession(record, readClock(this._clock));
      return true;
    });
  }

  async invalidateSourceClaim(input) {
    const candidate = normalizeSourceInvalidation(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      const key = this._sourceKey(candidate);
      if (this._sourceRevocations.has(key)) return 0;
      this._sourceRevocations.add(key);
      return this._releaseMatching((record) =>
        record.profileId === candidate.profileId &&
        record.contextId === candidate.contextId &&
        record.playbackGeneration === candidate.playbackGeneration &&
        record.contextRevision === candidate.contextRevision
      );
    });
  }

  async listDispatches(profileId, sessionId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedSessionId = assertIdentifier(sessionId, "playback session id");
    return Array.from(this._dispatches.values())
      .filter((record) =>
        record.profileId === scopedProfileId && record.sessionId === scopedSessionId
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(publicDispatch);
  }

  snapshotProfileNow(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return {
      sessions: Array.from(this._sessions, ([key, record]) => [key, cloneJson(record)])
        .filter(([, record]) => record.profileId === id),
      dispatches: Array.from(this._dispatches, ([key, record]) => [key, cloneJson(record)])
        .filter(([, record]) => record.profileId === id),
      sourceRevocations: Array.from(this._sourceRevocations)
        .filter((key) => key.startsWith(id + "\0")),
      hasProfileInvalidation: this._profileInvalidations.has(id),
      profileInvalidation: this._profileInvalidations.get(id),
      deviceInvalidations: Array.from(this._deviceInvalidations)
        .filter(([key]) => key.startsWith(id + "\0")),
    };
  }

  restoreProfileNow(profileId, snapshot) {
    const id = assertIdentifier(profileId, "profile id");
    this.eraseProfileNow(id);
    for (const [key, record] of snapshot.sessions) {
      this._sessions.set(key, cloneJson(record));
    }
    for (const [key, record] of snapshot.dispatches) {
      this._dispatches.set(key, cloneJson(record));
    }
    for (const key of snapshot.sourceRevocations) this._sourceRevocations.add(key);
    if (snapshot.hasProfileInvalidation) {
      this._profileInvalidations.set(id, snapshot.profileInvalidation);
    }
    for (const [key, generation] of snapshot.deviceInvalidations) {
      this._deviceInvalidations.set(key, generation);
    }
  }

  eraseProfileNow(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    for (const [key, record] of this._dispatches) {
      if (record.profileId === id) this._dispatches.delete(key);
    }
    for (const [key, record] of this._sessions) {
      if (record.profileId === id) this._sessions.delete(key);
    }
    for (const key of this._sourceRevocations) {
      if (key.startsWith(id + "\0")) this._sourceRevocations.delete(key);
    }
    this._profileInvalidations.delete(id);
    for (const key of this._deviceInvalidations.keys()) {
      if (key.startsWith(id + "\0")) this._deviceInvalidations.delete(key);
    }
  }

  invalidateHistoryNow(profileId, historyGeneration) {
    const id = assertIdentifier(profileId, "profile id");
    const generation = assertPositiveInteger(
      historyGeneration,
      "history generation",
      Number.MAX_SAFE_INTEGER
    );
    const now = readClock(this._clock);
    for (const dispatch of this._dispatches.values()) {
      if (
        dispatch.profileId === id &&
        dispatch.historyGeneration === generation &&
        ACTIVE_DISPATCH_STATES.has(dispatch.status)
      ) {
        this._revokeDispatch(dispatch, now);
      }
    }
    return this._releaseMatching((session) => session.profileId === id);
  }

  storageSnapshot() {
    return {
      sessions: Array.from(this._sessions.values(), publicSession),
      dispatches: Array.from(this._dispatches.values(), publicDispatch),
      sourceRevocations: Array.from(this._sourceRevocations).sort(),
    };
  }

  async _transitionNow(candidate) {
    const record = this._sessions.get(sessionKey(candidate.profileId, candidate.sessionId));
    this._assertSession(record, candidate);
    if (record.state === "released" && candidate.state !== "released") {
      throw codedError("playback_session_released", "playback session is terminal");
    }
    await this._assertDurableBinding(candidate);
    if (this._sourceRevocations.has(this._sourceKey(candidate))) {
      throw codedError("playback_source_revoked", "source claim has been durably revoked");
    }
    if (record.state !== candidate.state) {
      if (record.revision >= Number.MAX_SAFE_INTEGER) {
        throw codedError("playback_session_revision_exhausted", "playback session revision exhausted");
      }
      record.state = candidate.state;
      record.revision += 1;
      record.updatedAt = readClock(this._clock);
      if (record.state === "released") record.invalidatedAt = record.updatedAt;
      this._revokeSessionDispatches(record.profileId, record.sessionId, record.updatedAt);
    }
    return record;
  }

  _assertSession(record, candidate) {
    if (!record || !sameBinding(record, candidate) || record.revision !== candidate.expectedRevision) {
      throw codedError("playback_session_stale", "playback session binding is stale");
    }
  }

  async _assertDurableBinding(binding) {
    const invalidatedRevision = this._profileInvalidations.get(binding.profileId) || 0;
    const invalidatedGeneration =
      this._deviceInvalidations.get(deviceKey(binding.profileId, binding.deviceId)) || 0;
    const profile = await this._getProfileBinding(binding.profileId);
    if (
      invalidatedRevision > binding.profileRevision ||
      !profile ||
      profile.status !== "active" ||
      profile.revision !== binding.profileRevision
    ) {
      throw codedError("playback_profile_stale", "playback profile generation is stale");
    }
    if (
      invalidatedGeneration > binding.deviceGeneration ||
      !(await this._isDeviceBindingActive(
        binding.profileId,
        binding.deviceId,
        binding.deviceGeneration
      ))
    ) {
      throw codedError("playback_device_stale", "playback device generation is stale");
    }
    if (
      binding.historyGeneration !== undefined &&
      profile.historyGeneration !== binding.historyGeneration
    ) {
      throw codedError("history_generation_changed", "history generation changed before dispatch");
    }
    return profile;
  }

  _claimable(record, now) {
    return Boolean(
      (record.status === "queued" && record.nextAttemptAt <= now) ||
      (record.status === "leased" && record.leaseExpiresAt <= now)
    );
  }

  async _isDispatchAuthoritative(record) {
    const session = this._sessions.get(sessionKey(record.profileId, record.sessionId));
    if (
      !session ||
      !sameBinding(session, record) ||
      session.revision !== record.sessionRevision ||
      session.state !== record.requiredState ||
      this._sourceRevocations.has(this._sourceKey(record))
    ) {
      return false;
    }
    try {
      await this._assertDurableBinding(record);
      return true;
    } catch (_error) {
      return false;
    }
  }

  _sourceKey(value) {
    return sourceKey(
      value.profileId,
      value.contextId,
      value.playbackGeneration,
      value.contextRevision
    );
  }

  _revokeDispatch(record, now) {
    if (!ACTIVE_DISPATCH_STATES.has(record.status)) return false;
    record.status = "revoked";
    record.revokedAt = now;
    record.updatedAt = now;
    clearLease(record);
    return true;
  }

  _revokeSessionDispatches(profileId, sessionId, now) {
    for (const record of this._dispatches.values()) {
      if (record.profileId === profileId && record.sessionId === sessionId) {
        this._revokeDispatch(record, now);
      }
    }
  }

  _releaseSession(record, now) {
    if (record.state !== "released") {
      record.state = "released";
      record.revision += 1;
      record.updatedAt = now;
      record.invalidatedAt = now;
    }
    this._revokeSessionDispatches(record.profileId, record.sessionId, now);
  }

  _releaseMatching(predicate) {
    const now = readClock(this._clock);
    let released = 0;
    for (const record of this._sessions.values()) {
      if (!predicate(record)) continue;
      if (record.state !== "released") released += 1;
      this._releaseSession(record, now);
    }
    return released;
  }
}

module.exports = {
  MemoryPlaybackSessionRepository,
};
