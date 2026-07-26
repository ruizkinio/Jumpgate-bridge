"use strict";

const {
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
} = require("../playback-session");
const {
  assertIdentifier,
  assertPositiveInteger,
  codedError,
  readClock,
} = require("../repository-utils");
const {
  affectedRows,
  dateParameter,
  firstRow,
  requireDatabase,
  toSafeInteger,
  toTimestamp,
} = require("./repository-helpers");

function mapSessionRow(row) {
  if (!row) return null;
  return {
    profileId: row.profile_id,
    profileRevision: toSafeInteger(row.profile_revision, "profile revision", 1),
    deviceId: row.device_id,
    deviceGeneration: toSafeInteger(row.device_generation, "device generation", 1),
    sessionId: row.session_id,
    contextId: row.context_id,
    playbackGeneration: row.playback_generation,
    contextRevision: row.context_revision,
    state: row.state,
    revision: toSafeInteger(row.revision, "playback session revision", 1),
    createdAt: toTimestamp(row.created_at, "playback session createdAt"),
    updatedAt: toTimestamp(row.updated_at, "playback session updatedAt"),
    invalidatedAt: row.invalidated_at === null
      ? null
      : toTimestamp(row.invalidated_at, "playback session invalidatedAt"),
  };
}

function mapDispatchRow(row) {
  if (!row) return null;
  let payload = row.payload;
  if (typeof payload === "string") payload = JSON.parse(payload);
  return {
    id: row.id,
    profileId: row.profile_id,
    profileRevision: toSafeInteger(row.profile_revision, "profile revision", 1),
    deviceId: row.device_id,
    deviceGeneration: toSafeInteger(row.device_generation, "device generation", 1),
    historyGeneration: toSafeInteger(row.history_generation, "history generation", 1),
    sessionId: row.session_id,
    contextId: row.context_id,
    playbackGeneration: row.playback_generation,
    contextRevision: row.context_revision,
    sessionRevision: toSafeInteger(row.session_revision, "playback session revision", 1),
    event: row.event,
    progress: Number(row.progress),
    payload,
    requiredState: row.required_state,
    status: row.status,
    attemptCount: toSafeInteger(row.attempt_count, "scrobble dispatch attempt count"),
    nextAttemptAt: toTimestamp(row.next_attempt_at, "scrobble dispatch nextAttemptAt"),
    leaseTokenHash: row.lease_token_hash === null ? null : String(row.lease_token_hash).trim(),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at === null
      ? null
      : toTimestamp(row.lease_expires_at, "scrobble dispatch leaseExpiresAt"),
    createdAt: toTimestamp(row.created_at, "scrobble dispatch createdAt"),
    updatedAt: toTimestamp(row.updated_at, "scrobble dispatch updatedAt"),
    deliveredAt: row.delivered_at === null
      ? null
      : toTimestamp(row.delivered_at, "scrobble dispatch deliveredAt"),
    revokedAt: row.revoked_at === null
      ? null
      : toTimestamp(row.revoked_at, "scrobble dispatch revokedAt"),
  };
}

function leaseHash(row) {
  return row.lease_token_hash === null ? null : String(row.lease_token_hash).trim();
}

function rawSessionMatches(row, candidate) {
  return Boolean(
    row &&
    row.profile_id === candidate.profileId &&
    toSafeInteger(row.profile_revision, "profile revision", 1) === candidate.profileRevision &&
    row.device_id === candidate.deviceId &&
    toSafeInteger(row.device_generation, "device generation", 1) === candidate.deviceGeneration &&
    row.session_id === candidate.sessionId &&
    row.context_id === candidate.contextId &&
    row.playback_generation === candidate.playbackGeneration &&
    row.context_revision === candidate.contextRevision
  );
}

class PostgresPlaybackSessionRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
  }

  async openSession(input) {
    const candidate = normalizeOpenInput(input);
    const row = await this._db.transaction(async (transaction) => {
      await this._assertDurableBinding(transaction, candidate, { lockProfile: true });
      if (await this._sourceIsRevoked(transaction, candidate)) {
        throw codedError("playback_source_revoked", "source claim has been durably revoked");
      }
      const existing = firstRow(await transaction.query(
        `SELECT * FROM playback_sessions
          WHERE profile_id = $1 AND session_id = $2 FOR UPDATE`,
        [candidate.profileId, candidate.sessionId]
      ));
      if (existing) {
        if (existing.state === "released") {
          throw codedError("playback_session_released", "playback session is terminal");
        }
        if (!rawSessionMatches(existing, candidate) || existing.state !== candidate.state) {
          throw codedError("playback_session_stale", "playback session binding is stale");
        }
        return existing;
      }
      const now = readClock(this._clock);
      return firstRow(await transaction.query(
        `INSERT INTO playback_sessions (
           profile_id, session_id, profile_revision, device_id, device_generation,
           context_id, playback_generation, context_revision, state, revision,
           created_at, updated_at, invalidated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $10, NULL)
         RETURNING *`,
        [
          candidate.profileId,
          candidate.sessionId,
          candidate.profileRevision,
          candidate.deviceId,
          candidate.deviceGeneration,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision,
          candidate.state,
          dateParameter(now, "playback session createdAt"),
        ]
      ));
    });
    return publicSession(mapSessionRow(row));
  }

  async getSession(profileId, sessionId) {
    const row = firstRow(await this._db.query(
      "SELECT * FROM playback_sessions WHERE profile_id = $1 AND session_id = $2",
      [
        assertIdentifier(profileId, "profile id"),
        assertIdentifier(sessionId, "playback session id"),
      ]
    ));
    return publicSession(mapSessionRow(row));
  }

  async transition(input) {
    const candidate = normalizeTransitionInput(input);
    const row = await this._db.transaction((transaction) =>
      this._transitionInTransaction(transaction, candidate)
    );
    return publicSession(mapSessionRow(row));
  }

  async transitionAndEnqueue(input) {
    const candidate = normalizeTransitionAndDispatchInput(input);
    const rows = await this._db.transaction(async (transaction) => {
      const currentSession = await this._lockSessionInTransaction(transaction, candidate);
      const profile = firstRow(await transaction.query(
        "SELECT history_generation FROM profiles WHERE id = $1",
        [candidate.profileId]
      ));
      if (!profile) throw codedError("playback_profile_stale", "playback profile generation is stale");
      const historyGeneration = toSafeInteger(
        profile.history_generation,
        "history generation",
        1
      );
      const existing = firstRow(await transaction.query(
        `SELECT d.*,
                (d.profile_revision = $3 AND d.device_id = $4 AND
                 d.device_generation = $5 AND d.session_id = $6 AND
                 d.context_id = $7 AND d.playback_generation = $8 AND
                 d.context_revision = $9 AND d.session_revision = $10 AND
                 d.event = $11 AND d.progress = $12 AND
                 d.payload = $13::jsonb AND d.required_state = $14 AND
                 d.history_generation = $15) AS exact_retry
           FROM scrobble_dispatches d
          WHERE d.profile_id = $1 AND d.id = $2 FOR UPDATE`,
        [
          candidate.profileId,
          candidate.dispatch.id,
          candidate.profileRevision,
          candidate.deviceId,
          candidate.deviceGeneration,
          candidate.sessionId,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision,
          currentSession
            ? toSafeInteger(currentSession.revision, "playback session revision", 1)
            : 0,
          candidate.dispatch.event,
          candidate.dispatch.progress,
          candidate.dispatch.payload,
          candidate.dispatch.requiredState,
          historyGeneration,
        ]
      ));
      if (existing) {
        if (rawSessionMatches(currentSession, candidate) && existing.exact_retry === true) {
          return { session: currentSession, dispatch: existing };
        }
        throw codedError("scrobble_dispatch_conflict", "scrobble dispatch id is already bound");
      }
      const session = await this._transitionLockedInTransaction(
        transaction,
        candidate,
        currentSession
      );
      const now = readClock(this._clock);
      const dispatch = firstRow(await transaction.query(
         `INSERT INTO scrobble_dispatches (
           profile_id, id, profile_revision, device_id, device_generation,
           history_generation, session_id, context_id, playback_generation,
           context_revision, session_revision, event, progress, payload,
           required_state, status, attempt_count,
           next_attempt_at, lease_token_hash, lease_owner, lease_expires_at,
           created_at, updated_at, delivered_at, revoked_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, 'queued', 0,
           $16, NULL, NULL, NULL, $16, $16, NULL, NULL
         ) RETURNING *`,
        [
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
          toSafeInteger(session.revision, "playback session revision", 1),
          candidate.dispatch.event,
          candidate.dispatch.progress,
          candidate.dispatch.payload,
          candidate.dispatch.requiredState,
          dateParameter(now, "scrobble dispatch createdAt"),
        ]
      ));
      return { session, dispatch };
    });
    return Object.freeze({
      session: publicSession(mapSessionRow(rows.session)),
      dispatch: publicDispatch(mapDispatchRow(rows.dispatch)),
    });
  }

  async claimDispatch(input) {
    const claim = normalizeClaimInput(input);
    const issued = this._tokens.issue("scrobble-dispatch-lease", 32);
    const now = readClock(this._clock);
    const expiresAt = now + claim.leaseMs;
    const row = firstRow(await this._db.query(
      `WITH candidate AS (
         SELECT d.profile_id, d.id
           FROM scrobble_dispatches d
           JOIN playback_sessions s
             ON s.profile_id = d.profile_id AND s.session_id = d.session_id
           JOIN profiles p ON p.id = d.profile_id
           JOIN devices v ON v.profile_id = d.profile_id AND v.id = d.device_id
          WHERE (
              (d.status = 'queued' AND d.next_attempt_at <= $1) OR
              (d.status = 'leased' AND d.lease_expires_at <= $1)
            )
             AND p.status = 'active' AND p.revision = d.profile_revision
             AND p.history_generation = d.history_generation
            AND v.revoked_at IS NULL AND v.expires_at > $1
            AND v.generation = d.device_generation
            AND s.profile_revision = d.profile_revision
            AND s.device_id = d.device_id
            AND s.device_generation = d.device_generation
            AND s.context_id = d.context_id
            AND s.playback_generation = d.playback_generation
            AND s.context_revision = d.context_revision
            AND s.revision = d.session_revision
            AND s.state = d.required_state
            AND NOT EXISTS (
              SELECT 1 FROM playback_source_revocations r
               WHERE r.profile_id = d.profile_id AND r.context_id = d.context_id
                 AND r.playback_generation = d.playback_generation
                 AND r.context_revision = d.context_revision
            )
          ORDER BY d.next_attempt_at, d.created_at, d.id
          FOR UPDATE OF d SKIP LOCKED
          LIMIT 1
       )
       UPDATE scrobble_dispatches d
          SET status = 'leased', attempt_count = d.attempt_count + 1,
              lease_token_hash = $2, lease_owner = $3, lease_expires_at = $4,
              updated_at = $1
         FROM candidate c
        WHERE d.profile_id = c.profile_id AND d.id = c.id
       RETURNING d.*`,
      [
        dateParameter(now, "scrobble claim timestamp"),
        issued.tokenHash,
        claim.workerId,
        dateParameter(expiresAt, "scrobble lease expiry"),
      ]
    ));
    if (!row) return null;
    return Object.freeze({ dispatch: publicDispatch(mapDispatchRow(row)), leaseToken: issued.token });
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

    const preloadedRow = firstRow(await this._db.query(
      "SELECT * FROM scrobble_dispatches WHERE profile_id = $1 AND id = $2",
      [admission.profileId, admission.dispatchId]
    ));
    const preloaded = preloadedRow ? publicDispatch(mapDispatchRow(preloadedRow)) : null;
    if (!preloaded) {
      throw dispatchError("scrobble_dispatch_lease_lost", "scrobble dispatch lease is not owned");
    }

    return this._db.transaction(async (transaction) => {
      const profile = firstRow(await transaction.query(
        "SELECT status, revision, history_generation FROM profiles WHERE id = $1 FOR UPDATE",
        [admission.profileId]
      ));
      const session = firstRow(await transaction.query(
        `SELECT * FROM playback_sessions
          WHERE profile_id = $1 AND session_id = $2 FOR UPDATE`,
        [admission.profileId, preloaded.sessionId]
      ));
      const device = firstRow(await transaction.query(
        `SELECT generation, revoked_at, expires_at FROM devices
          WHERE profile_id = $1 AND id = $2 FOR SHARE`,
        [admission.profileId, preloaded.deviceId]
      ));
      const row = firstRow(await transaction.query(
        `SELECT * FROM scrobble_dispatches
          WHERE profile_id = $1 AND id = $2 FOR UPDATE`,
        [admission.profileId, admission.dispatchId]
      ));
      if (row && row.status === "revoked") {
        throw dispatchError("scrobble_dispatch_revoked", "scrobble dispatch was revoked");
      }
      const now = readClock(this._clock);
      if (
        !row ||
        row.status !== "leased" ||
        leaseHash(row) !== leaseTokenHash ||
        toTimestamp(row.lease_expires_at, "scrobble dispatch leaseExpiresAt") <= now
      ) {
        throw dispatchError("scrobble_dispatch_lease_lost", "scrobble dispatch lease is not owned");
      }
      if (
        !profile ||
        profile.status !== "active" ||
        toSafeInteger(profile.revision, "profile revision", 1) !== preloaded.profileRevision ||
        toSafeInteger(profile.history_generation, "history generation", 1) !==
          preloaded.historyGeneration ||
        !device ||
        device.revoked_at !== null ||
        toSafeInteger(device.generation, "device generation", 1) !== preloaded.deviceGeneration ||
        toTimestamp(device.expires_at, "device expiresAt") <= now ||
        !session ||
        toSafeInteger(session.profile_revision, "profile revision", 1) !== preloaded.profileRevision ||
        session.device_id !== preloaded.deviceId ||
        toSafeInteger(session.device_generation, "device generation", 1) !== preloaded.deviceGeneration ||
        session.context_id !== preloaded.contextId ||
        session.playback_generation !== preloaded.playbackGeneration ||
        session.context_revision !== preloaded.contextRevision ||
        toSafeInteger(session.revision, "playback session revision", 1) !== preloaded.sessionRevision ||
        session.state !== preloaded.requiredState ||
        await this._sourceIsRevoked(transaction, preloaded)
      ) {
        await this._revokeDispatchInTransaction(
          transaction,
          admission.profileId,
          admission.dispatchId,
          now
        );
        throw dispatchError("scrobble_dispatch_revoked", "scrobble dispatch was revoked");
      }

      const result = await operation(preloaded);
      const deliveredAt = readClock(this._clock);
      const delivered = await transaction.query(
        `UPDATE scrobble_dispatches
            SET status = 'delivered', delivered_at = $3, updated_at = $3,
                lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
          WHERE profile_id = $1 AND id = $2 AND status = 'leased'
            AND lease_token_hash = $4`,
        [
          admission.profileId,
          admission.dispatchId,
          dateParameter(deliveredAt, "scrobble dispatch deliveredAt"),
          leaseTokenHash,
        ]
      );
      if (affectedRows(delivered) !== 1) {
        throw dispatchError("scrobble_dispatch_lease_lost", "scrobble dispatch lease is not owned");
      }
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
    return this._db.transaction(async (transaction) => {
      const profile = firstRow(await transaction.query(
        "SELECT status, history_generation FROM profiles WHERE id = $1 FOR UPDATE",
        [retry.profileId]
      ));
      const row = firstRow(await transaction.query(
        `SELECT * FROM scrobble_dispatches
          WHERE profile_id = $1 AND id = $2 FOR UPDATE`,
        [retry.profileId, retry.dispatchId]
      ));
      if (
        !row ||
        row.status !== "leased" ||
        leaseHash(row) !== leaseTokenHash
      ) {
        return false;
      }
      const now = readClock(this._clock);
      if (
        !profile ||
        profile.status !== "active" ||
        toSafeInteger(profile.history_generation, "history generation", 1) !==
          toSafeInteger(row.history_generation, "dispatch history generation", 1)
      ) {
        await this._revokeDispatchInTransaction(
          transaction,
          retry.profileId,
          retry.dispatchId,
          now
        );
        return false;
      }
      const result = await transaction.query(
        `UPDATE scrobble_dispatches
            SET status = 'queued', next_attempt_at = $3, updated_at = $4,
                lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
          WHERE profile_id = $1 AND id = $2 AND status = 'leased'
            AND lease_token_hash = $5`,
        [
          retry.profileId,
          retry.dispatchId,
          dateParameter(retry.nextAttemptAt, "scrobble retry timestamp"),
          dateParameter(now, "scrobble retry updatedAt"),
          leaseTokenHash,
        ]
      );
      return affectedRows(result) === 1;
    });
  }

  async invalidateProfile(profileId, profileRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const revision = assertPositiveInteger(
      profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    );
    return this._db.transaction(async (transaction) => {
      await transaction.query("SELECT id FROM profiles WHERE id = $1 FOR UPDATE", [id]);
      return this.invalidateProfileInTransaction(transaction, id, revision);
    });
  }

  async invalidateProfileInTransaction(
    transaction,
    profileId,
    profileRevision,
    now = readClock(this._clock)
  ) {
    await transaction.query(
      `UPDATE scrobble_dispatches
          SET status = 'revoked', revoked_at = $3, updated_at = $3,
              lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE profile_id = $1 AND profile_revision < $2
          AND status IN ('queued', 'leased')`,
      [
        profileId,
        profileRevision,
        dateParameter(now, "playback profile invalidatedAt"),
      ]
    );
    const result = await transaction.query(
      `UPDATE playback_sessions
          SET state = 'released', revision = revision + 1,
              updated_at = $3, invalidated_at = $3
        WHERE profile_id = $1 AND profile_revision < $2 AND state != 'released'`,
      [
        profileId,
        profileRevision,
        dateParameter(now, "playback profile invalidatedAt"),
      ]
    );
    return affectedRows(result);
  }

  async invalidateDevice(profileId, deviceId, deviceGeneration) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedDeviceId = assertIdentifier(deviceId, "device id");
    const generation = assertPositiveInteger(
      deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    return this._db.transaction(async (transaction) => {
      await transaction.query(
        "SELECT id FROM profiles WHERE id = $1 FOR UPDATE",
        [scopedProfileId]
      );
      await transaction.query(
        "SELECT id FROM devices WHERE profile_id = $1 AND id = $2 FOR UPDATE",
        [scopedProfileId, scopedDeviceId]
      );
      return this.invalidateDeviceInTransaction(
        transaction,
        scopedProfileId,
        scopedDeviceId,
        generation
      );
    });
  }

  async invalidateDeviceInTransaction(
    transaction,
    profileId,
    deviceId,
    deviceGeneration,
    now = readClock(this._clock)
  ) {
    await transaction.query(
      `UPDATE scrobble_dispatches
          SET status = 'revoked', revoked_at = $4, updated_at = $4,
              lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE profile_id = $1 AND device_id = $2 AND device_generation < $3
          AND status IN ('queued', 'leased')`,
      [
        profileId,
        deviceId,
        deviceGeneration,
        dateParameter(now, "playback device invalidatedAt"),
      ]
    );
    const result = await transaction.query(
      `UPDATE playback_sessions
          SET state = 'released', revision = revision + 1,
              updated_at = $4, invalidated_at = $4
        WHERE profile_id = $1 AND device_id = $2 AND device_generation < $3
          AND state != 'released'`,
      [
        profileId,
        deviceId,
        deviceGeneration,
        dateParameter(now, "playback device invalidatedAt"),
      ]
    );
    return affectedRows(result);
  }

  async invalidateSession(input) {
    const candidate = normalizeSessionInvalidation(input);
    return this._db.transaction(async (transaction) => {
      await transaction.query(
        "SELECT id FROM profiles WHERE id = $1 FOR UPDATE",
        [candidate.profileId]
      );
      const row = firstRow(await transaction.query(
        `SELECT * FROM playback_sessions
          WHERE profile_id = $1 AND session_id = $2 FOR UPDATE`,
        [candidate.profileId, candidate.sessionId]
      ));
      this._assertSession(row, candidate);
      if (row.state === "released") return false;
      const now = readClock(this._clock);
      await this._revokeSessionDispatchesInTransaction(
        transaction,
        candidate.profileId,
        candidate.sessionId,
        now
      );
      await transaction.query(
        `UPDATE playback_sessions
            SET state = 'released', revision = revision + 1,
                updated_at = $3, invalidated_at = $3
          WHERE profile_id = $1 AND session_id = $2 AND state != 'released'`,
        [
          candidate.profileId,
          candidate.sessionId,
          dateParameter(now, "playback session invalidatedAt"),
        ]
      );
      return true;
    });
  }

  async invalidateSourceClaim(input) {
    const candidate = normalizeSourceInvalidation(input);
    return this._db.transaction(async (transaction) => {
      await transaction.query(
        "SELECT id FROM profiles WHERE id = $1 FOR UPDATE",
        [candidate.profileId]
      );
      const now = readClock(this._clock);
      const inserted = firstRow(await transaction.query(
        `INSERT INTO playback_source_revocations (
           profile_id, context_id, playback_generation, context_revision, revoked_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (profile_id, context_id, playback_generation, context_revision)
         DO NOTHING RETURNING profile_id`,
        [
          candidate.profileId,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision,
          dateParameter(now, "source claim revokedAt"),
        ]
      ));
      if (!inserted) return 0;
      await transaction.query(
        `UPDATE scrobble_dispatches
            SET status = 'revoked', revoked_at = $5, updated_at = $5,
                lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
          WHERE profile_id = $1 AND context_id = $2 AND playback_generation = $3
            AND context_revision = $4 AND status IN ('queued', 'leased')`,
        [
          candidate.profileId,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision,
          dateParameter(now, "source claim revokedAt"),
        ]
      );
      const result = await transaction.query(
        `UPDATE playback_sessions
            SET state = 'released', revision = revision + 1,
                updated_at = $5, invalidated_at = $5
          WHERE profile_id = $1 AND context_id = $2 AND playback_generation = $3
            AND context_revision = $4 AND state != 'released'`,
        [
          candidate.profileId,
          candidate.contextId,
          candidate.playbackGeneration,
          candidate.contextRevision,
          dateParameter(now, "source claim revokedAt"),
        ]
      );
      return affectedRows(result);
    });
  }

  async listDispatches(profileId, sessionId) {
    const result = await this._db.query(
      `SELECT * FROM scrobble_dispatches
        WHERE profile_id = $1 AND session_id = $2 ORDER BY created_at, id`,
      [
        assertIdentifier(profileId, "profile id"),
        assertIdentifier(sessionId, "playback session id"),
      ]
    );
    return (result.rows || []).map((row) => publicDispatch(mapDispatchRow(row)));
  }

  async eraseProfileInTransaction(transaction, profileId) {
    const id = assertIdentifier(profileId, "profile id");
    await transaction.query("DELETE FROM scrobble_dispatches WHERE profile_id = $1", [id]);
    await transaction.query("DELETE FROM playback_sessions WHERE profile_id = $1", [id]);
    await transaction.query(
      "DELETE FROM playback_source_revocations WHERE profile_id = $1",
      [id]
    );
  }

  async _transitionInTransaction(transaction, candidate) {
    const row = await this._lockSessionInTransaction(transaction, candidate);
    return this._transitionLockedInTransaction(transaction, candidate, row);
  }

  async _lockSessionInTransaction(transaction, candidate) {
    await transaction.query(
      "SELECT id FROM profiles WHERE id = $1 FOR UPDATE",
      [candidate.profileId]
    );
    return firstRow(await transaction.query(
      `SELECT * FROM playback_sessions
        WHERE profile_id = $1 AND session_id = $2 FOR UPDATE`,
      [candidate.profileId, candidate.sessionId]
    ));
  }

  async _transitionLockedInTransaction(transaction, candidate, row) {
    this._assertSession(row, candidate);
    if (row.state === "released" && candidate.state !== "released") {
      throw codedError("playback_session_released", "playback session is terminal");
    }
    await this._assertDurableBinding(transaction, candidate, { profileAlreadyLocked: true });
    if (await this._sourceIsRevoked(transaction, candidate)) {
      throw codedError("playback_source_revoked", "source claim has been durably revoked");
    }
    if (row.state === candidate.state) return row;
    if (toSafeInteger(row.revision, "playback session revision", 1) >= Number.MAX_SAFE_INTEGER) {
      throw codedError("playback_session_revision_exhausted", "playback session revision exhausted");
    }
    const now = readClock(this._clock);
    await this._revokeSessionDispatchesInTransaction(
      transaction,
      candidate.profileId,
      candidate.sessionId,
      now
    );
    const result = await transaction.query(
      `UPDATE playback_sessions
          SET state = $3::text, revision = revision + 1, updated_at = $4::timestamptz,
              invalidated_at = CASE
                WHEN $3::text = 'released' THEN $4::timestamptz ELSE NULL
              END
        WHERE profile_id = $1 AND session_id = $2 AND revision = $5
          AND profile_revision = $6 AND device_id = $7 AND device_generation = $8
          AND context_id = $9 AND playback_generation = $10 AND context_revision = $11
       RETURNING *`,
      [
        candidate.profileId,
        candidate.sessionId,
        candidate.state,
        dateParameter(now, "playback session updatedAt"),
        candidate.expectedRevision,
        candidate.profileRevision,
        candidate.deviceId,
        candidate.deviceGeneration,
        candidate.contextId,
        candidate.playbackGeneration,
        candidate.contextRevision,
      ]
    );
    const updated = firstRow(result);
    if (!updated) throw codedError("playback_session_stale", "playback session binding is stale");
    return updated;
  }

  _assertSession(row, candidate) {
    if (
      !rawSessionMatches(row, candidate) ||
      toSafeInteger(row.revision, "playback session revision", 1) !== candidate.expectedRevision
    ) {
      throw codedError("playback_session_stale", "playback session binding is stale");
    }
  }

  async _assertDurableBinding(transaction, binding, options = {}) {
    let profile = null;
    if (!options.profileAlreadyLocked) {
      profile = firstRow(await transaction.query(
        `SELECT status, revision, history_generation FROM profiles WHERE id = $1 ${
          options.lockProfile ? "FOR UPDATE" : "FOR SHARE"
        }`,
        [binding.profileId]
      ));
    } else {
      profile = firstRow(await transaction.query(
        "SELECT status, revision, history_generation FROM profiles WHERE id = $1",
        [binding.profileId]
      ));
    }
    if (
      !profile ||
      profile.status !== "active" ||
      toSafeInteger(profile.revision, "profile revision", 1) !== binding.profileRevision
    ) {
      throw codedError("playback_profile_stale", "playback profile generation is stale");
    }
    const device = firstRow(await transaction.query(
      `SELECT generation, revoked_at, expires_at FROM devices
        WHERE profile_id = $1 AND id = $2 FOR SHARE`,
      [binding.profileId, binding.deviceId]
    ));
    if (
      !device ||
      device.revoked_at !== null ||
      toSafeInteger(device.generation, "device generation", 1) !== binding.deviceGeneration ||
      toTimestamp(device.expires_at, "device expiresAt") <= readClock(this._clock)
    ) {
      throw codedError("playback_device_stale", "playback device generation is stale");
    }
    if (
      binding.historyGeneration !== undefined &&
      toSafeInteger(profile.history_generation, "history generation", 1) !==
        binding.historyGeneration
    ) {
      throw codedError("history_generation_changed", "history generation changed before dispatch");
    }
    return profile;
  }

  async _sourceIsRevoked(queryTarget, value) {
    return Boolean(firstRow(await queryTarget.query(
      `SELECT 1 AS present FROM playback_source_revocations
        WHERE profile_id = $1 AND context_id = $2
          AND playback_generation = $3 AND context_revision = $4`,
      [
        value.profileId,
        value.contextId,
        value.playbackGeneration,
        value.contextRevision,
      ]
    )));
  }

  async _revokeSessionDispatchesInTransaction(transaction, profileId, sessionId, now) {
    await transaction.query(
      `UPDATE scrobble_dispatches
          SET status = 'revoked', revoked_at = $3, updated_at = $3,
              lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE profile_id = $1 AND session_id = $2 AND status IN ('queued', 'leased')`,
      [
        profileId,
        sessionId,
        dateParameter(now, "playback session invalidatedAt"),
      ]
    );
  }

  async _revokeDispatchInTransaction(transaction, profileId, dispatchId, now) {
    await transaction.query(
      `UPDATE scrobble_dispatches
          SET status = 'revoked', revoked_at = $3, updated_at = $3,
              lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE profile_id = $1 AND id = $2 AND status IN ('queued', 'leased')`,
      [profileId, dispatchId, dateParameter(now, "scrobble dispatch revokedAt")]
    );
  }
}

module.exports = {
  PostgresPlaybackSessionRepository,
  mapDispatchRow,
  mapSessionRow,
};
