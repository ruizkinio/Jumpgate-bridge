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
} = require("../playback-session");
const { ProfileLifecycleCoordinator } = require("../lifecycle-invalidation");
const {
  assertIdentifier,
  assertPositiveInteger,
  codedError,
  readClock,
} = require("../repository-utils");
const { withImmediateTransaction } = require("./connection");
const {
  normalizeRepositoryOptions,
  parseJson,
  requireDatabase,
  stringifyJson,
} = require("./helpers");

function mapSession(row) {
  if (!row) return null;
  return {
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    deviceId: row.device_id,
    deviceGeneration: row.device_generation,
    sessionId: row.session_id,
    contextId: row.context_id,
    playbackGeneration: row.playback_generation,
    contextRevision: row.context_revision,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    invalidatedAt: row.invalidated_at,
  };
}

function mapDispatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    deviceId: row.device_id,
    deviceGeneration: row.device_generation,
    historyGeneration: row.history_generation,
    sessionId: row.session_id,
    contextId: row.context_id,
    playbackGeneration: row.playback_generation,
    contextRevision: row.context_revision,
    sessionRevision: row.session_revision,
    event: row.event,
    progress: row.progress,
    payload: parseJson(row.payload, "scrobble dispatch payload"),
    requiredState: row.required_state,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseTokenHash: row.lease_token_hash,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    revokedAt: row.revoked_at,
  };
}

class SqlitePlaybackSessionRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._db = requireDatabase(options);
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();

    this._getSession = this._db.prepare(
      "SELECT * FROM playback_sessions WHERE profile_id = ? AND session_id = ?"
    );
    this._insertSession = this._db.prepare(`
      INSERT INTO playback_sessions (
        profile_id, session_id, profile_revision, device_id, device_generation,
        context_id, playback_generation, context_revision, state, revision,
        created_at, updated_at, invalidated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
    `);
    this._updateSessionState = this._db.prepare(`
      UPDATE playback_sessions
         SET state = ?, revision = revision + 1, updated_at = ?, invalidated_at = ?
       WHERE profile_id = ? AND session_id = ? AND revision = ?
         AND profile_revision = ? AND device_id = ? AND device_generation = ?
         AND context_id = ? AND playback_generation = ? AND context_revision = ?
    `);
    this._getProfileBinding = this._db.prepare(
      "SELECT status, revision, history_generation FROM profiles WHERE id = ?"
    );
    this._getDeviceBinding = this._db.prepare(`
      SELECT generation FROM devices
       WHERE profile_id = ? AND id = ? AND generation = ?
         AND revoked_at IS NULL AND expires_at > ?
    `);
    this._getSourceRevocation = this._db.prepare(`
      SELECT 1 AS present FROM playback_source_revocations
       WHERE profile_id = ? AND context_id = ?
         AND playback_generation = ? AND context_revision = ?
    `);
    this._insertSourceRevocation = this._db.prepare(`
      INSERT INTO playback_source_revocations (
        profile_id, context_id, playback_generation, context_revision, revoked_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (profile_id, context_id, playback_generation, context_revision)
      DO NOTHING
    `);
    this._getDispatch = this._db.prepare(
      "SELECT * FROM scrobble_dispatches WHERE profile_id = ? AND id = ?"
    );
    this._insertDispatch = this._db.prepare(`
      INSERT INTO scrobble_dispatches (
        profile_id, id, profile_revision, device_id, device_generation,
        history_generation, session_id,
        context_id, playback_generation, context_revision, session_revision,
        event, progress, payload, required_state, status, attempt_count,
        next_attempt_at, lease_token_hash, lease_owner, lease_expires_at,
        created_at, updated_at, delivered_at, revoked_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0,
        ?, NULL, NULL, NULL, ?, ?, NULL, NULL
      )
    `);
    this._candidateDispatch = this._db.prepare(`
      SELECT profile_id, id FROM scrobble_dispatches
       WHERE (status = 'queued' AND next_attempt_at <= ?)
          OR (status = 'leased' AND lease_expires_at <= ?)
       ORDER BY next_attempt_at, created_at, id
       LIMIT 1
    `);
    this._claimDispatch = this._db.prepare(`
      UPDATE scrobble_dispatches
         SET status = 'leased', attempt_count = attempt_count + 1,
             lease_token_hash = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE profile_id = ? AND id = ?
         AND ((status = 'queued' AND next_attempt_at <= ?)
           OR (status = 'leased' AND lease_expires_at <= ?))
    `);
    this._retryDispatch = this._db.prepare(`
      UPDATE scrobble_dispatches
         SET status = 'queued', next_attempt_at = ?, updated_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE profile_id = ? AND id = ? AND status = 'leased' AND lease_token_hash = ?
    `);
    this._deliverDispatch = this._db.prepare(`
      UPDATE scrobble_dispatches
         SET status = 'delivered', delivered_at = ?, updated_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE profile_id = ? AND id = ? AND status = 'leased' AND lease_token_hash = ?
    `);
    this._revokeDispatch = this._db.prepare(`
      UPDATE scrobble_dispatches
         SET status = 'revoked', revoked_at = ?, updated_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE profile_id = ? AND id = ? AND status IN ('queued', 'leased')
    `);
    this._revokeSessionDispatches = this._db.prepare(`
      UPDATE scrobble_dispatches
         SET status = 'revoked', revoked_at = ?, updated_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE profile_id = ? AND session_id = ? AND status IN ('queued', 'leased')
    `);
    this._releaseSession = this._db.prepare(`
      UPDATE playback_sessions
         SET state = 'released', revision = revision + 1,
             updated_at = ?, invalidated_at = ?
       WHERE profile_id = ? AND session_id = ? AND state != 'released'
    `);
    this._revokeProfileDispatches = this._db.prepare(`
      UPDATE scrobble_dispatches
         SET status = 'revoked', revoked_at = ?, updated_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE profile_id = ? AND profile_revision < ? AND status IN ('queued', 'leased')
    `);
    this._releaseProfileSessions = this._db.prepare(`
      UPDATE playback_sessions
         SET state = 'released', revision = revision + 1,
             updated_at = ?, invalidated_at = ?
       WHERE profile_id = ? AND profile_revision < ? AND state != 'released'
    `);
    this._revokeDeviceDispatches = this._db.prepare(`
      UPDATE scrobble_dispatches
         SET status = 'revoked', revoked_at = ?, updated_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE profile_id = ? AND device_id = ? AND device_generation < ?
         AND status IN ('queued', 'leased')
    `);
    this._releaseDeviceSessions = this._db.prepare(`
      UPDATE playback_sessions
         SET state = 'released', revision = revision + 1,
             updated_at = ?, invalidated_at = ?
       WHERE profile_id = ? AND device_id = ? AND device_generation < ?
         AND state != 'released'
    `);
    this._revokeSourceDispatches = this._db.prepare(`
      UPDATE scrobble_dispatches
         SET status = 'revoked', revoked_at = ?, updated_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
       WHERE profile_id = ? AND context_id = ? AND playback_generation = ?
         AND context_revision = ? AND status IN ('queued', 'leased')
    `);
    this._releaseSourceSessions = this._db.prepare(`
      UPDATE playback_sessions
         SET state = 'released', revision = revision + 1,
             updated_at = ?, invalidated_at = ?
       WHERE profile_id = ? AND context_id = ? AND playback_generation = ?
         AND context_revision = ? AND state != 'released'
    `);
    this._listDispatches = this._db.prepare(`
      SELECT * FROM scrobble_dispatches
       WHERE profile_id = ? AND session_id = ?
       ORDER BY created_at, id
    `);
    this._eraseDispatches = this._db.prepare(
      "DELETE FROM scrobble_dispatches WHERE profile_id = ?"
    );
    this._eraseSessions = this._db.prepare(
      "DELETE FROM playback_sessions WHERE profile_id = ?"
    );
    this._eraseSourceRevocations = this._db.prepare(
      "DELETE FROM playback_source_revocations WHERE profile_id = ?"
    );
  }

  async openSession(input) {
    const candidate = normalizeOpenInput(input);
    const row = await this._lifecycleCoordinator.run(candidate.profileId, async () =>
      withImmediateTransaction(this._db, () => {
        this._assertDurableBinding(candidate);
        if (this._sourceIsRevoked(candidate)) {
          throw codedError("playback_source_revoked", "source claim has been durably revoked");
        }
        const existing = this._getSession.get(candidate.profileId, candidate.sessionId);
        if (existing) {
          const mapped = mapSession(existing);
          if (mapped.state === "released") {
            throw codedError("playback_session_released", "playback session is terminal");
          }
          if (!sameBinding(mapped, candidate) || mapped.state !== candidate.state) {
            throw codedError("playback_session_stale", "playback session binding is stale");
          }
          return existing;
        }
        const now = readClock(this._clock);
        this._insertSession.run(
          candidate.profileId,
          candidate.sessionId,
          candidate.profileRevision,
          candidate.deviceId,
          candidate.deviceGeneration,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision,
          candidate.state,
          now,
          now
        );
        return this._getSession.get(candidate.profileId, candidate.sessionId);
      })
    );
    return publicSession(mapSession(row));
  }

  async getSession(profileId, sessionId) {
    const row = this._getSession.get(
      assertIdentifier(profileId, "profile id"),
      assertIdentifier(sessionId, "playback session id")
    );
    return publicSession(mapSession(row));
  }

  async transition(input) {
    const candidate = normalizeTransitionInput(input);
    const row = await this._lifecycleCoordinator.run(candidate.profileId, async () =>
      withImmediateTransaction(this._db, () => this._transitionInTransaction(candidate))
    );
    return publicSession(mapSession(row));
  }

  async transitionAndEnqueue(input) {
    const candidate = normalizeTransitionAndDispatchInput(input);
    const payloadText = stringifyJson(
      candidate.dispatch.payload,
      "scrobble dispatch payload",
      64 * 1024
    );
    const rows = await this._lifecycleCoordinator.run(candidate.profileId, async () =>
      withImmediateTransaction(this._db, () => {
        const profile = this._assertDurableBinding(candidate);
        const historyGeneration = profile.history_generation;
        const existing = this._getDispatch.get(candidate.profileId, candidate.dispatch.id);
        if (existing) {
          const mappedSession = mapSession(
            this._getSession.get(candidate.profileId, candidate.sessionId)
          );
          const mappedDispatch = mapDispatch(existing);
          if (
            mappedSession &&
            sameBinding(mappedSession, candidate) &&
            sameBinding(mappedDispatch, candidate) &&
            mappedDispatch.historyGeneration === historyGeneration &&
            mappedDispatch.sessionRevision === mappedSession.revision &&
            sameDispatch(mappedDispatch, candidate.dispatch)
          ) {
            return { session: this._getSession.get(candidate.profileId, candidate.sessionId), dispatch: existing };
          }
          throw codedError("scrobble_dispatch_conflict", "scrobble dispatch id is already bound");
        }
        const session = this._transitionInTransaction(candidate);
        const now = readClock(this._clock);
        this._insertDispatch.run(
          candidate.profileId,
          candidate.dispatch.id,
          candidate.profileRevision,
          candidate.deviceId,
          candidate.deviceGeneration,
          historyGeneration,
          candidate.sessionId,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision,
          session.revision,
          candidate.dispatch.event,
          candidate.dispatch.progress,
          payloadText,
          candidate.dispatch.requiredState,
          now,
          now,
          now
        );
        return {
          session,
          dispatch: this._getDispatch.get(candidate.profileId, candidate.dispatch.id),
        };
      })
    );
    return Object.freeze({
      session: publicSession(mapSession(rows.session)),
      dispatch: publicDispatch(mapDispatch(rows.dispatch)),
    });
  }

  async claimDispatch(input) {
    const claim = normalizeClaimInput(input);
    for (;;) {
      const now = readClock(this._clock);
      const candidate = this._candidateDispatch.get(now, now);
      if (!candidate) return null;
      const outcome = await this._lifecycleCoordinator.run(candidate.profile_id, async () =>
        withImmediateTransaction(this._db, () => {
          const current = this._getDispatch.get(candidate.profile_id, candidate.id);
          const currentNow = readClock(this._clock);
          if (!current || !this._claimable(current, currentNow)) return null;
          if (!this._isDispatchAuthoritative(current, currentNow)) {
            this._revokeDispatch.run(
              currentNow,
              currentNow,
              current.profile_id,
              current.id
            );
            return false;
          }
          const issued = this._tokens.issue("scrobble-dispatch-lease", 32);
          const result = this._claimDispatch.run(
            issued.tokenHash,
            claim.workerId,
            currentNow + claim.leaseMs,
            currentNow,
            current.profile_id,
            current.id,
            currentNow,
            currentNow
          );
          if (result.changes !== 1) return null;
          return {
            row: this._getDispatch.get(current.profile_id, current.id),
            leaseToken: issued.token,
          };
        })
      );
      if (outcome === false || outcome === null) continue;
      return Object.freeze({
        dispatch: publicDispatch(mapDispatch(outcome.row)),
        leaseToken: outcome.leaseToken,
      });
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
      const admittedRow = withImmediateTransaction(this._db, () => {
        const row = this._getDispatch.get(admission.profileId, admission.dispatchId);
        if (row && row.status === "revoked") {
          throw dispatchError("scrobble_dispatch_revoked", "scrobble dispatch was revoked");
        }
        const now = readClock(this._clock);
        if (
          !row ||
          row.status !== "leased" ||
          row.lease_token_hash !== leaseTokenHash ||
          row.lease_expires_at <= now
        ) {
          throw dispatchError("scrobble_dispatch_lease_lost", "scrobble dispatch lease is not owned");
        }
        if (!this._isDispatchAuthoritative(row, now)) {
          this._revokeDispatch.run(now, now, row.profile_id, row.id);
          throw dispatchError("scrobble_dispatch_revoked", "scrobble dispatch was revoked");
        }
        return row;
      });
      const result = await operation(publicDispatch(mapDispatch(admittedRow)));
      withImmediateTransaction(this._db, () => {
        const now = readClock(this._clock);
        const delivered = this._deliverDispatch.run(
          now,
          now,
          admission.profileId,
          admission.dispatchId,
          leaseTokenHash
        );
        if (delivered.changes !== 1) {
          throw dispatchError("scrobble_dispatch_lease_lost", "scrobble dispatch lease is not owned");
        }
      });
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
    return this._lifecycleCoordinator.run(retry.profileId, async () =>
      withImmediateTransaction(this._db, () => {
        const row = this._getDispatch.get(retry.profileId, retry.dispatchId);
        if (
          !row ||
          row.status !== "leased" ||
          row.lease_token_hash !== leaseTokenHash
        ) {
          return false;
        }
        const now = readClock(this._clock);
        if (!this._isDispatchAuthoritative(row, now)) {
          this._revokeDispatch.run(now, now, retry.profileId, retry.dispatchId);
          return false;
        }
        return this._retryDispatch.run(
          retry.nextAttemptAt,
          now,
          retry.profileId,
          retry.dispatchId,
          leaseTokenHash
        ).changes === 1;
      })
    );
  }

  async invalidateProfile(profileId, profileRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const revision = assertPositiveInteger(
      profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    );
    return this._lifecycleCoordinator.run(id, async () =>
      withImmediateTransaction(this._db, () =>
        this.invalidateProfileInTransaction(id, revision)
      )
    );
  }

  invalidateProfileInTransaction(profileId, profileRevision, now = readClock(this._clock)) {
    this._revokeProfileDispatches.run(now, now, profileId, profileRevision);
    return this._releaseProfileSessions.run(
      now,
      now,
      profileId,
      profileRevision
    ).changes;
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
      withImmediateTransaction(this._db, () =>
        this.invalidateDeviceInTransaction(
          scopedProfileId,
          scopedDeviceId,
          generation
        )
      )
    );
  }

  invalidateDeviceInTransaction(
    profileId,
    deviceId,
    deviceGeneration,
    now = readClock(this._clock)
  ) {
    this._revokeDeviceDispatches.run(
      now,
      now,
      profileId,
      deviceId,
      deviceGeneration
    );
    return this._releaseDeviceSessions.run(
      now,
      now,
      profileId,
      deviceId,
      deviceGeneration
    ).changes;
  }

  async invalidateSession(input) {
    const candidate = normalizeSessionInvalidation(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () =>
      withImmediateTransaction(this._db, () => {
        const row = this._getSession.get(candidate.profileId, candidate.sessionId);
        this._assertSession(row, candidate);
        if (row.state === "released") return false;
        const now = readClock(this._clock);
        this._revokeSessionDispatches.run(now, now, candidate.profileId, candidate.sessionId);
        this._releaseSession.run(now, now, candidate.profileId, candidate.sessionId);
        return true;
      })
    );
  }

  async invalidateSourceClaim(input) {
    const candidate = normalizeSourceInvalidation(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () =>
      withImmediateTransaction(this._db, () => {
        const now = readClock(this._clock);
        const inserted = this._insertSourceRevocation.run(
          candidate.profileId,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision,
          now
        );
        if (inserted.changes !== 1) return 0;
        this._revokeSourceDispatches.run(
          now,
          now,
          candidate.profileId,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision
        );
        return this._releaseSourceSessions.run(
          now,
          now,
          candidate.profileId,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision
        ).changes;
      })
    );
  }

  async listDispatches(profileId, sessionId) {
    const rows = this._listDispatches.all(
      assertIdentifier(profileId, "profile id"),
      assertIdentifier(sessionId, "playback session id")
    );
    return rows.map((row) => publicDispatch(mapDispatch(row)));
  }

  eraseProfileInTransaction(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    this._eraseDispatches.run(id);
    this._eraseSessions.run(id);
    this._eraseSourceRevocations.run(id);
  }

  _transitionInTransaction(candidate) {
    const row = this._getSession.get(candidate.profileId, candidate.sessionId);
    this._assertSession(row, candidate);
    if (row.state === "released" && candidate.state !== "released") {
      throw codedError("playback_session_released", "playback session is terminal");
    }
    this._assertDurableBinding(candidate);
    if (this._sourceIsRevoked(candidate)) {
      throw codedError("playback_source_revoked", "source claim has been durably revoked");
    }
    if (row.state === candidate.state) return row;
    if (row.revision >= Number.MAX_SAFE_INTEGER) {
      throw codedError("playback_session_revision_exhausted", "playback session revision exhausted");
    }
    const now = readClock(this._clock);
    this._revokeSessionDispatches.run(now, now, candidate.profileId, candidate.sessionId);
    const updated = this._updateSessionState.run(
      candidate.state,
      now,
      candidate.state === "released" ? now : null,
      candidate.profileId,
      candidate.sessionId,
      candidate.expectedRevision,
      candidate.profileRevision,
      candidate.deviceId,
      candidate.deviceGeneration,
      candidate.contextId,
      candidate.playbackGeneration,
      candidate.contextRevision
    );
    if (updated.changes !== 1) {
      throw codedError("playback_session_stale", "playback session binding is stale");
    }
    return this._getSession.get(candidate.profileId, candidate.sessionId);
  }

  _assertSession(row, candidate) {
    const mapped = mapSession(row);
    if (!mapped || !sameBinding(mapped, candidate) || mapped.revision !== candidate.expectedRevision) {
      throw codedError("playback_session_stale", "playback session binding is stale");
    }
  }

  _assertDurableBinding(binding, now = readClock(this._clock)) {
    const profile = this._getProfileBinding.get(binding.profileId);
    if (
      !profile ||
      profile.status !== "active" ||
      profile.revision !== binding.profileRevision
    ) {
      throw codedError("playback_profile_stale", "playback profile generation is stale");
    }
    if (!this._getDeviceBinding.get(
      binding.profileId,
      binding.deviceId,
      binding.deviceGeneration,
      now
    )) {
      throw codedError("playback_device_stale", "playback device generation is stale");
    }
    if (
      binding.historyGeneration !== undefined &&
      profile.history_generation !== binding.historyGeneration
    ) {
      throw codedError("history_generation_changed", "history generation changed before dispatch");
    }
    return profile;
  }

  _sourceIsRevoked(value) {
    return Boolean(this._getSourceRevocation.get(
      value.profileId,
      value.contextId,
      value.playbackGeneration,
      value.contextRevision
    ));
  }

  _claimable(row, now) {
    return Boolean(
      (row.status === "queued" && row.next_attempt_at <= now) ||
      (row.status === "leased" && row.lease_expires_at <= now)
    );
  }

  _isDispatchAuthoritative(row, now) {
    if (!ACTIVE_DISPATCH_STATES.has(row.status)) return false;
    const session = this._getSession.get(row.profile_id, row.session_id);
    if (
      !session ||
      session.profile_revision !== row.profile_revision ||
      session.device_id !== row.device_id ||
      session.device_generation !== row.device_generation ||
      session.context_id !== row.context_id ||
      session.playback_generation !== row.playback_generation ||
      session.context_revision !== row.context_revision ||
      session.revision !== row.session_revision ||
      session.state !== row.required_state ||
      this._sourceIsRevoked({
        profileId: row.profile_id,
        contextId: row.context_id,
        playbackGeneration: row.playback_generation,
        contextRevision: row.context_revision,
      })
    ) {
      return false;
    }
    try {
      this._assertDurableBinding({
        profileId: row.profile_id,
        profileRevision: row.profile_revision,
        deviceId: row.device_id,
        deviceGeneration: row.device_generation,
        historyGeneration: row.history_generation,
      }, now);
      return true;
    } catch (_error) {
      return false;
    }
  }
}

module.exports = {
  SqlitePlaybackSessionRepository,
  mapDispatch,
  mapSession,
};
