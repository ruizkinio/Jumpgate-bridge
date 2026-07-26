"use strict";

const crypto = require("node:crypto");

const { toHistoryDto } = require("../../history-service");
const {
  attachPreparedHttpResponse,
  encodePreparedHttpResponse,
  normalizePreparedHttpResponse,
  preparedHttpResponseEqual,
} = require("../../prepared-http-response");
const { ProfileLifecycleCoordinator } = require("../lifecycle-invalidation");
const {
  createDispatchIntent,
  eventResponse,
  grantResponse,
  hashPresentedGrantToken,
  historyEntry,
  nextSessionRevision,
  normalizeSourceRevocation,
  recoverGrantToken,
  revocationScope,
  revocationScopes,
  tokenPurpose,
} = require("../durable-history-grant");
const {
  DEFAULT_RESERVATION_RETENTION_MS,
  DEFAULT_RESERVATION_TTL_MS,
  MAX_RESERVATION_RETENTION_MS,
  MAX_RESERVATION_TTL_MS,
  assertGrantKind,
  assertPresentedGrantBinding,
  assertGrantState,
  assertSessionState,
  deriveGrantKind,
  historyGrantError,
  isTerminalEvent,
  normalizeAbandonReservationInput,
  normalizeApplyEventInput,
  normalizeCommitClaimResponseInput,
  normalizeFinalizationInput,
  normalizeReleaseInput,
  normalizeReservationDuration,
  normalizeReservationInput,
  normalizeSourceAuthority,
  publicDispatchIntent,
  publicGrant,
  sameReservation,
  sameSourceAuthority,
  sessionStateForEvent,
  prepareHistoryEventResponse,
  shouldSuppressPeriodicEvent,
} = require("../history-grant");
const { assertPlaybackGeneration } = require("../playback-session");
const {
  assertIdentifier,
  assertPositiveInteger,
  cloneJson,
  codedError,
  readClock,
} = require("../repository-utils");
const { withImmediateTransaction, withReadTransaction } = require("./connection");
const {
  normalizeRepositoryOptions,
  parseJson,
  requireDatabase,
  stringifyJson,
} = require("./helpers");

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function parseNullableJson(value, name) {
  return value === null ? null : parseJson(value, name);
}

function mapPreparedResponse(status, headers, body, name) {
  const absent = status === null && headers === null && body === null;
  if (absent) return null;
  if (status === null || headers === null || body === null) {
    throw new TypeError(name + " is incomplete");
  }
  return normalizePreparedHttpResponse({
    status,
    headers: parseJson(headers, name + " headers"),
    body: Buffer.from(body),
  });
}

function mapGrant(row) {
  if (!row) return null;
  const profileId = assertIdentifier(row.profile_id, "stored history grant profile id");
  const deviceId = assertIdentifier(row.device_id, "stored history grant device id");
  const sessionId = assertIdentifier(row.session_id, "stored history grant session id");
  const authority = row.claim_status === null
    ? null
    : normalizeSourceAuthority({
        profileId,
        profileRevision: row.profile_revision,
        deviceId,
        deviceGeneration: row.device_generation,
        historyGeneration: row.history_generation,
        playbackGeneration: row.playback_generation,
        providerRevision: row.provider_revision,
        contextId: row.context_id,
        contextRevision: row.context_revision,
        sessionId,
        contentKey: row.content_key,
        canonicalIdentity: parseNullableJson(
          row.canonical_identity,
          "history grant canonical identity"
        ),
        displaySnapshot: parseJson(row.display_snapshot, "history grant display snapshot"),
        claimStatus: row.claim_status,
        traktEligible: row.trakt_eligible === 1,
        supersededSessionId: row.superseded_session_id,
      });
  return {
    grantId: assertIdentifier(row.grant_id, "stored history grant id"),
    attemptId: row.attempt_id,
    requestDigest: row.request_digest,
    profileId,
    profileRevision: row.profile_revision,
    deviceId,
    deviceGeneration: row.device_generation,
    historyGeneration: row.history_generation,
    playbackGeneration: assertPlaybackGeneration(row.playback_generation),
    sessionId,
    tokenHash: row.token_hash,
    tokenEnvelope: parseJson(row.token_envelope, "history grant token envelope"),
    status: assertGrantState(row.status),
    kind: row.kind === null ? null : assertGrantKind(row.kind),
    claimStatus: row.claim_status,
    authority,
    sessionState: row.session_state === null ? null : assertSessionState(row.session_state),
    sessionRevision: row.session_revision,
    terminalReceiptId: row.terminal_receipt_id,
    reservationExpiresAt: row.reservation_expires_at,
    claimResponse: row.claim_response_status === null
      ? null
      : encodePreparedHttpResponse(mapPreparedResponse(
          row.claim_response_status,
          row.claim_response_headers,
          row.claim_response_body,
          "history claim response"
        )),
    createdAt: row.created_at,
    finalizedAt: row.finalized_at,
    releasedAt: row.released_at,
    revokedAt: row.revoked_at,
    supersededAt: row.superseded_at,
    revocationReason: row.revocation_reason,
  };
}

function mapHistory(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    profileId: row.profile_id,
    contentKey: row.content_key,
    canonicalIdentity: parseNullableJson(row.canonical_identity, "history canonical identity"),
    displaySnapshot: parseJson(row.display_snapshot, "history display snapshot"),
    playbackSnapshot: parseJson(row.playback_snapshot, "history playback snapshot"),
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    watchedMs: row.watched_ms,
    completed: row.completed === 1,
    revision: row.revision,
    changeSequence: row.change_sequence,
    lastPlayedAt: row.last_played_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function mapReceiptResponse(row) {
  if (!row) return null;
  const response = cloneJson(parseJson(row.response, "history event receipt"));
  attachPreparedHttpResponse(
    response,
    mapPreparedResponse(
      row.response_status,
      row.response_headers,
      row.response_body,
      "history event prepared response"
    )
  );
  return Object.freeze(response);
}

function randomId(prefix) {
  return prefix + "_" + crypto.randomBytes(24).toString("base64url");
}

class SqliteHistoryGrantRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    this._db = requireDatabase(options);
    this._tokens = options.tokenService;
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
    this._reservationTtlMs = normalizeReservationDuration(
      options.reservationTtlMs,
      "history reservation TTL",
      DEFAULT_RESERVATION_TTL_MS,
      MAX_RESERVATION_TTL_MS
    );
    this._reservationRetentionMs = normalizeReservationDuration(
      options.reservationRetentionMs,
      "history reservation retention",
      DEFAULT_RESERVATION_RETENTION_MS,
      MAX_RESERVATION_RETENTION_MS
    );
    this._lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();
    this._grantIdFactory = options.grantIdFactory || (() => randomId("hgr"));
    this._sessionIdFactory = options.sessionIdFactory || (() => randomId("hgs"));
    if (typeof this._grantIdFactory !== "function" || typeof this._sessionIdFactory !== "function") {
      throw new TypeError("history grant id factories are invalid");
    }
  }

  async reserve(input) {
    const candidate = normalizeReservationInput(input);
    return this._write(candidate.profileId, () => {
      this._assertBindingCurrent(candidate);
      const existing = mapGrant(this._db.prepare(`
        SELECT * FROM history_grants
         WHERE profile_id = ? AND device_id = ? AND attempt_id = ?
      `).get(candidate.profileId, candidate.deviceId, candidate.attemptId));
      if (existing) {
        if (!sameReservation(existing, candidate)) {
          throw historyGrantError(
            "history_claim_conflict",
            "playback claim attempt is already bound to different request bytes"
          );
        }
        if (
          existing.status === "reserved" &&
          existing.reservationExpiresAt <= readClock(this._clock)
        ) {
          this._expireReservationNow(existing.grantId, readClock(this._clock));
          throw historyGrantError("history_grant_stale", "history grant reservation expired");
        }
        this._assertGrantCurrent(existing, { bindingChecked: true });
        if (existing.status !== "reserved" && existing.status !== "active") {
          throw historyGrantError("history_grant_stale", "history grant is no longer current");
        }
        return grantResponse(existing, this._recoverToken(existing));
      }

      const grantId = assertIdentifier(this._grantIdFactory(), "history grant id");
      const sessionId = assertIdentifier(this._sessionIdFactory(), "history session id");
      const issued = this._tokens.issue("history-grant", 32);
      const grantToken = "hg1_" + issued.token;
      const tokenHash = this._tokens.hashToken("history-grant", grantToken);
      const tokenEnvelope = this._crypto.encryptJson({ token: grantToken }, tokenPurpose(grantId));
      const now = readClock(this._clock);
      this._db.prepare(`
        INSERT INTO history_grants (
          grant_id, attempt_id, request_digest, profile_id, profile_revision,
          device_id, device_generation, history_generation, playback_generation,
          session_id, token_hash, token_envelope, status, created_at,
          reservation_expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      `).run(
        grantId,
        candidate.attemptId,
        candidate.requestDigest,
        candidate.profileId,
        candidate.profileRevision,
        candidate.deviceId,
        candidate.deviceGeneration,
        candidate.historyGeneration,
        candidate.playbackGeneration,
        sessionId,
        tokenHash,
        stringifyJson(tokenEnvelope, "history grant token envelope", 4096),
        now,
        now + this._reservationTtlMs
      );
      return grantResponse(mapGrant(this._grantById(grantId)), grantToken);
    });
  }

  async abandon(input) {
    const candidate = normalizeAbandonReservationInput(input);
    return this._write(candidate.profileId, () => {
      const record = mapGrant(this._grantById(candidate.grantId));
      if (!record) return false;
      if (!sameReservation(record, candidate)) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim abandonment does not match reserved request bytes"
        );
      }
      if (record.status !== "reserved") return false;
      this._assertBindingCurrent(candidate);
      return this._expireReservationNow(record.grantId, readClock(this._clock));
    });
  }

  async commitClaimResponse(input) {
    const candidate = normalizeCommitClaimResponseInput(input);
    const initial = mapGrant(this._grantById(candidate.grantId));
    if (!initial) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
    return this._write(initial.profileId, () => {
      const record = mapGrant(this._grantById(candidate.grantId));
      if (!record) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
      if (record.requestDigest !== candidate.requestDigest) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim response does not match reserved request bytes"
        );
      }
      this._assertGrantCurrent(record);
      if (record.status !== "active" && record.status !== "released") {
        throw historyGrantError("history_grant_stale", "history grant is not active");
      }
      if (record.claimResponse) {
        const stored = mapPreparedResponse(
          this._grantById(record.grantId).claim_response_status,
          this._grantById(record.grantId).claim_response_headers,
          this._grantById(record.grantId).claim_response_body,
          "history claim response"
        );
        if (!preparedHttpResponseEqual(stored, candidate.preparedResponse)) {
          throw historyGrantError(
            "history_claim_conflict",
            "playback claim response bytes changed during retry"
          );
        }
        return stored;
      }
      this._db.prepare(`
        UPDATE history_grants
           SET claim_response_status = ?, claim_response_headers = ?, claim_response_body = ?
         WHERE grant_id = ? AND claim_response_status IS NULL
      `).run(
        candidate.preparedResponse.status,
        stringifyJson(candidate.preparedResponse.headers, "history claim response headers", 16384),
        candidate.preparedResponse.body,
        record.grantId
      );
      return candidate.preparedResponse;
    });
  }

  async finalize(input) {
    const candidate = normalizeFinalizationInput(input);
    const initial = mapGrant(this._grantById(candidate.grantId));
    if (!initial) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
    return this._write(initial.profileId, () => {
      const record = mapGrant(this._grantById(candidate.grantId));
      if (!record) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
      this._assertBindingCurrent(record);
      if (record.requestDigest !== candidate.requestDigest) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim finalization does not match reserved request bytes"
        );
      }
      this._assertAuthorityBinding(record, candidate.authority);
      this._assertGrantCurrent(record, { bindingChecked: true });
      this._assertNoRevocations(record, candidate.authority);
      if (record.status === "active") {
        if (!sameSourceAuthority(record.authority, candidate.authority)) {
          throw historyGrantError(
            "history_claim_conflict",
            "playback claim finalization authority changed"
          );
        }
        return grantResponse(record, this._recoverToken(record));
      }
      if (record.status !== "reserved") {
        throw historyGrantError("history_grant_stale", "history grant is no longer current");
      }
      if (candidate.authority.supersededSessionId === record.sessionId) {
        throw historyGrantError(
          "history_supersession_conflict",
          "history session cannot supersede itself"
        );
      }

      const now = readClock(this._clock);
      if (candidate.authority.supersededSessionId) {
        this._supersedeInTransaction(
          record.profileId,
          record.deviceId,
          candidate.authority.supersededSessionId,
          record.sessionId,
          now
        );
      }
      const kind = deriveGrantKind(candidate.authority);
      if (kind === "canonical") {
        this._db.prepare(`
          INSERT INTO playback_sessions (
            profile_id, session_id, profile_revision, device_id, device_generation,
            context_id, playback_generation, context_revision, state, revision,
            created_at, updated_at, invalidated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'playing', 1, ?, ?, NULL)
        `).run(
          record.profileId,
          record.sessionId,
          record.profileRevision,
          record.deviceId,
          record.deviceGeneration,
          candidate.authority.contextId,
          record.playbackGeneration,
          candidate.authority.contextRevision,
          now,
          now
        );
      }
      const result = this._db.prepare(`
        UPDATE history_grants SET
          status = 'active', kind = ?, claim_status = ?, provider_revision = ?,
          context_id = ?, context_revision = ?, content_key = ?, canonical_identity = ?,
          display_snapshot = ?, trakt_eligible = ?, superseded_session_id = ?,
          session_state = 'playing', session_revision = 1, finalized_at = ?
        WHERE grant_id = ? AND status = 'reserved'
      `).run(
        kind,
        candidate.authority.claimStatus,
        candidate.authority.providerRevision,
        candidate.authority.contextId,
        candidate.authority.contextRevision,
        candidate.authority.contentKey,
        candidate.authority.canonicalIdentity === null
          ? null
          : stringifyJson(
              candidate.authority.canonicalIdentity,
              "history grant canonical identity",
              64 * 1024
            ),
        stringifyJson(
          candidate.authority.displaySnapshot,
          "history grant display snapshot",
          64 * 1024
        ),
        candidate.authority.traktEligible ? 1 : 0,
        candidate.authority.supersededSessionId,
        now,
        record.grantId
      );
      if (result.changes !== 1) {
        throw historyGrantError("history_grant_stale", "history grant is no longer current");
      }
      const updated = mapGrant(this._grantById(record.grantId));
      return grantResponse(updated, this._recoverToken(updated));
    });
  }

  async applyEvent(input) {
    const candidate = normalizeApplyEventInput(input);
    const tokenHash = hashPresentedGrantToken(this._tokens, candidate.grantToken);
    const initial = mapGrant(this._db.prepare(
      "SELECT * FROM history_grants WHERE token_hash = ?"
    ).get(tokenHash));
    if (!initial) throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
    assertPresentedGrantBinding(initial, candidate);
    return this._write(initial.profileId, () => {
      const record = mapGrant(this._db.prepare(
        "SELECT * FROM history_grants WHERE token_hash = ?"
      ).get(tokenHash));
      if (!record || record.tokenHash !== tokenHash) {
        throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
      }
      assertPresentedGrantBinding(record, candidate);

      // Currency precedes receipt lookup, including exact retries.
      this._assertGrantCurrent(record);
      const receipt = this._db.prepare(`
        SELECT * FROM history_event_receipts
         WHERE grant_id = ? AND idempotency_key = ?
      `).get(record.grantId, candidate.idempotencyKey);
      if (record.status === "released") {
        if (
          receipt &&
          record.terminalReceiptId === candidate.idempotencyKey &&
          receipt.request_digest === candidate.requestDigest
        ) {
          return mapReceiptResponse(receipt);
        }
        if (receipt && receipt.request_digest !== candidate.requestDigest) {
          throw historyGrantError(
            "history_event_idempotency_conflict",
            "Idempotency-Key is already bound to different event bytes"
          );
        }
        throw historyGrantError("history_grant_released", "history grant is terminal");
      }
      if (record.status !== "active") {
        throw historyGrantError("history_grant_stale", "history grant is not active");
      }
      if (receipt) {
        if (receipt.request_digest !== candidate.requestDigest) {
          throw historyGrantError(
            "history_event_idempotency_conflict",
            "Idempotency-Key is already bound to different event bytes"
          );
        }
        return mapReceiptResponse(receipt);
      }
      if (candidate.event.sessionRevision !== record.sessionRevision) {
        throw historyGrantError(
          "history_session_stale",
          "history event session revision is stale"
        );
      }

      const suppressed = shouldSuppressPeriodicEvent(
        record.sessionState,
        candidate.event.event
      );
      const targetState = suppressed
        ? record.sessionState
        : sessionStateForEvent(candidate.event.event);
      const nextRevision = targetState === record.sessionState
        ? record.sessionRevision
        : nextSessionRevision(record.sessionRevision);
      const history = suppressed || record.kind === "negative"
        ? null
        : this._applyHistoryInTransaction(record, candidate.event);
      const now = readClock(this._clock);
      const dispatch = !suppressed && record.kind === "canonical"
        ? this._enqueueDispatchInTransaction(
            record,
            candidate,
            targetState,
            nextRevision,
            now
          )
        : null;
      const terminal = isTerminalEvent(candidate.event.event);
      if (!suppressed) {
        const updated = this._db.prepare(`
          UPDATE history_grants SET
            status = CASE WHEN ? THEN 'released' ELSE status END,
            session_state = ?, session_revision = ?,
            terminal_receipt_id = CASE WHEN ? THEN ? ELSE terminal_receipt_id END,
            released_at = CASE WHEN ? THEN ? ELSE released_at END
          WHERE grant_id = ? AND status = 'active' AND session_revision = ?
        `).run(
          terminal ? 1 : 0,
          targetState,
          nextRevision,
          terminal ? 1 : 0,
          terminal ? candidate.idempotencyKey : null,
          terminal ? 1 : 0,
          terminal ? now : null,
          record.grantId,
          record.sessionRevision
        );
        if (updated.changes !== 1) {
          throw historyGrantError("history_session_stale", "history session is stale");
        }
      }
      const updatedRecord = mapGrant(this._grantById(record.grantId));
      const response = eventResponse(
        updatedRecord,
        candidate,
        history,
        dispatch ? dispatch.publicIntent : null,
        suppressed ? "suppressed" : null
      );
      const prepared = prepareHistoryEventResponse(response);
      this._db.prepare(`
        INSERT INTO history_event_receipts (
          grant_id, idempotency_key, request_digest, event, terminal, response, created_at,
          response_status, response_headers, response_body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.grantId,
        candidate.idempotencyKey,
        candidate.requestDigest,
        candidate.event.event,
        terminal ? 1 : 0,
        stringifyJson(response, "history event receipt", 256 * 1024),
        now,
        prepared.status,
        stringifyJson(prepared.headers, "history event response headers", 16384),
        prepared.body
      );
      const result = cloneJson(response);
      attachPreparedHttpResponse(result, prepared);
      return Object.freeze(result);
    });
  }

  async release(input) {
    const candidate = normalizeReleaseInput(input);
    return this._write(candidate.profileId, () => {
      const record = mapGrant(this._db.prepare(`
        SELECT * FROM history_grants WHERE profile_id = ? AND session_id = ?
      `).get(candidate.profileId, candidate.sessionId));
      if (!record) return false;
      assertPresentedGrantBinding(record, candidate);
      if (
        record.profileRevision !== candidate.profileRevision ||
        record.deviceGeneration !== candidate.deviceGeneration ||
        record.historyGeneration !== candidate.historyGeneration ||
        record.playbackGeneration !== candidate.playbackGeneration
      ) {
        throw historyGrantError("history_grant_stale", "history grant binding is stale");
      }
      this._assertGrantCurrent(record);
      const receipt = this._db.prepare(`
        SELECT terminal FROM history_event_receipts
         WHERE grant_id = ? AND idempotency_key = ?
      `).get(record.grantId, candidate.terminalReceiptId);
      if (
        record.status !== "released" ||
        record.terminalReceiptId !== candidate.terminalReceiptId ||
        !receipt ||
        receipt.terminal !== 1
      ) {
        throw historyGrantError(
          "history_terminal_receipt_required",
          "matching terminal history receipt is required"
        );
      }
      return true;
    });
  }

  revokeProfile(profileId, profileRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const revision = assertPositiveInteger(profileRevision, "profile revision", MAX_SAFE_INTEGER);
    return this._revoke("profile", { profileId: id, profileRevision: revision }, {
      profile_revision: revision,
    });
  }

  revokeDevice(profileId, deviceId, deviceGeneration) {
    const binding = {
      profileId: assertIdentifier(profileId, "profile id"),
      deviceId: assertIdentifier(deviceId, "device id"),
      deviceGeneration: assertPositiveInteger(
        deviceGeneration,
        "device generation",
        MAX_SAFE_INTEGER
      ),
    };
    return this._revoke("device", binding, {
      device_id: binding.deviceId,
      device_generation: binding.deviceGeneration,
    });
  }

  revokeHistory(profileId, historyGeneration) {
    const binding = {
      profileId: assertIdentifier(profileId, "profile id"),
      historyGeneration: assertPositiveInteger(
        historyGeneration,
        "history generation",
        MAX_SAFE_INTEGER
      ),
    };
    return this._revoke("history", binding, {
      history_generation: binding.historyGeneration,
    });
  }

  async clearHistory(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return this._write(id, () => {
      const profile = this._db.prepare(`
        SELECT status, history_generation FROM profiles WHERE id = ?
      `).get(id);
      if (!profile || profile.status !== "active") {
        throw codedError("profile_inactive", "profile is missing or inactive");
      }
      const generation = assertPositiveInteger(
        profile.history_generation,
        "history generation",
        Number.MAX_SAFE_INTEGER
      );
      if (generation >= Number.MAX_SAFE_INTEGER) {
        throw codedError("history_generation_exhausted", "history generation exhausted");
      }
      const now = readClock(this._clock);
      const scopeHash = revocationScope("history", {
        profileId: id,
        historyGeneration: generation,
      });

      this._db.prepare("DELETE FROM cloud_history WHERE profile_id = ?").run(id);
      this._db.prepare(`
        INSERT OR IGNORE INTO history_grant_revocations (
          profile_id, kind, scope_hash, replacement_session_id, revoked_at
        ) VALUES (?, 'history', ?, NULL, ?)
      `).run(id, scopeHash, now);
      const revokedGrants = this._db.prepare(`
        UPDATE history_grants SET
          status = 'revoked', revoked_at = ?, revocation_reason = 'history'
        WHERE profile_id = ? AND history_generation = ? AND status != 'revoked'
      `).run(now, id, generation).changes;
      this._db.prepare(`
        UPDATE scrobble_dispatches SET
          status = 'revoked', revoked_at = ?, updated_at = ?,
          lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE profile_id = ? AND history_generation = ?
          AND status IN ('queued', 'leased')
      `).run(now, now, id, generation);
      const releasedSessions = this._db.prepare(`
        UPDATE playback_sessions SET
          state = 'released',
          revision = CASE WHEN revision < 9007199254740991 THEN revision + 1 ELSE revision END,
          updated_at = ?, invalidated_at = ?
        WHERE profile_id = ? AND state != 'released'
      `).run(now, now, id).changes;
      const advanced = this._db.prepare(`
        UPDATE profiles SET history_generation = history_generation + 1, updated_at = ?
        WHERE id = ? AND status = 'active' AND history_generation = ?
      `).run(now, id, generation);
      if (advanced.changes !== 1) {
        throw codedError("history_generation_changed", "history generation changed during clear");
      }
      return Object.freeze({
        previousGeneration: generation,
        historyGeneration: generation + 1,
        revokedGrants,
        releasedSessions,
      });
    });
  }

  revokePlayback(profileId, playbackGeneration) {
    const binding = {
      profileId: assertIdentifier(profileId, "profile id"),
      playbackGeneration: assertPlaybackGeneration(playbackGeneration),
    };
    return this._revoke("playback", binding, {
      playback_generation: binding.playbackGeneration,
    });
  }

  revokeSession(profileId, sessionId) {
    const binding = {
      profileId: assertIdentifier(profileId, "profile id"),
      sessionId: assertIdentifier(sessionId, "history session id"),
    };
    return this._revoke("session", binding, { session_id: binding.sessionId });
  }

  revokeSource(input) {
    const binding = normalizeSourceRevocation(input);
    return this._revoke("source", binding, {
      context_id: binding.contextId,
      playback_generation: binding.playbackGeneration,
      provider_revision: binding.providerRevision,
      context_revision: binding.contextRevision,
    });
  }

  async supersede(profileId, deviceId, sessionId, replacementSessionId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedDeviceId = assertIdentifier(deviceId, "device id");
    const scopedSessionId = assertIdentifier(sessionId, "history session id");
    const replacement = assertIdentifier(replacementSessionId, "replacement history session id");
    if (scopedSessionId === replacement) {
      throw new TypeError("history session cannot supersede itself");
    }
    return this._write(scopedProfileId, () =>
      this._supersedeInTransaction(
        scopedProfileId,
        scopedDeviceId,
        scopedSessionId,
        replacement,
        readClock(this._clock)
      )
    );
  }

  async getGrantBySession(profileId, sessionId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedSessionId = assertIdentifier(sessionId, "history session id");
    return withReadTransaction(this._db, () => publicGrant(mapGrant(this._db.prepare(`
      SELECT * FROM history_grants WHERE profile_id = ? AND session_id = ?
    `).get(scopedProfileId, scopedSessionId))));
  }

  async prune() {
    const now = readClock(this._clock);
    return withImmediateTransaction(this._db, () => {
      const expired = this._db.prepare(`
        UPDATE history_grants
           SET status = 'revoked', revoked_at = ?, revocation_reason = 'playback'
         WHERE kind IS NULL AND status = 'reserved' AND reservation_expires_at <= ?
      `).run(now, now);
      const pruned = this._db.prepare(`
        DELETE FROM history_grants
         WHERE kind IS NULL AND status = 'revoked' AND reservation_expires_at <= ?
      `).run(now - this._reservationRetentionMs);
      return Object.freeze({
        expiredReservations: expired.changes,
        prunedReservations: pruned.changes,
      });
    });
  }

  async listDispatchIntents(profileId, sessionId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedSessionId = assertIdentifier(sessionId, "history session id");
    return withReadTransaction(this._db, () => this._db.prepare(`
      SELECT d.*, g.grant_id, g.history_generation, g.provider_revision,
             g.canonical_identity
        FROM scrobble_dispatches d
        JOIN history_grants g
          ON g.profile_id = d.profile_id AND g.session_id = d.session_id
       WHERE d.profile_id = ? AND d.session_id = ?
       ORDER BY d.created_at, d.id
    `).all(scopedProfileId, scopedSessionId).map((row) => publicDispatchIntent({
      id: row.id,
      grantId: row.grant_id,
      profileId: row.profile_id,
      profileRevision: row.profile_revision,
      deviceId: row.device_id,
      deviceGeneration: row.device_generation,
      historyGeneration: row.history_generation,
      sessionId: row.session_id,
      sessionRevision: row.session_revision,
      contextId: row.context_id,
      contextRevision: row.context_revision,
      playbackGeneration: row.playback_generation,
      providerRevision: row.provider_revision,
      event: row.event,
      progress: row.progress,
      canonicalIdentity: parseJson(row.canonical_identity, "dispatch canonical identity"),
      status: row.status,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    })));
  }

  eraseProfileInTransaction(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    this._db.prepare(`
      DELETE FROM scrobble_dispatches
       WHERE profile_id = ? AND session_id IN (
         SELECT session_id FROM history_grants WHERE profile_id = ?
       )
    `).run(id, id);
    this._db.prepare(`
      DELETE FROM playback_sessions
       WHERE profile_id = ? AND session_id IN (
         SELECT session_id FROM history_grants WHERE profile_id = ?
       )
    `).run(id, id);
    this._db.prepare("DELETE FROM history_grants WHERE profile_id = ?").run(id);
    this._db.prepare("DELETE FROM history_grant_revocations WHERE profile_id = ?").run(id);
  }

  storageSnapshot() {
    return withReadTransaction(this._db, () => ({
      grants: this._db.prepare("SELECT * FROM history_grants ORDER BY created_at, grant_id")
        .all()
        .map((row) => cloneJson(mapGrant(row))),
      receipts: this._db.prepare(
        "SELECT * FROM history_event_receipts ORDER BY created_at, grant_id, idempotency_key"
      ).all().map((row) => ({
        grantId: row.grant_id,
        idempotencyKey: row.idempotency_key,
        requestDigest: row.request_digest,
        event: row.event,
        terminal: row.terminal === 1,
        response: parseJson(row.response, "history event receipt"),
        createdAt: row.created_at,
      })),
    }));
  }

  invalidateProfile(...args) {
    return this.revokeProfile(...args);
  }

  invalidateDevice(...args) {
    return this.revokeDevice(...args);
  }

  invalidateHistory(...args) {
    return this.revokeHistory(...args);
  }

  invalidatePlayback(...args) {
    return this.revokePlayback(...args);
  }

  invalidateSession(...args) {
    return this.revokeSession(...args);
  }

  invalidateSourceClaim(...args) {
    return this.revokeSource(...args);
  }

  supersedeSession(...args) {
    return this.supersede(...args);
  }

  _applyHistoryInTransaction(record, event) {
    if (!record.authority.contentKey) return null;
    const stored = this._db.prepare(`
      SELECT * FROM cloud_history WHERE profile_id = ? AND content_key = ?
    `).get(record.profileId, record.authority.contentKey);
    const writeState = mapHistory(stored);
    const current = writeState && writeState.deletedAt === null ? writeState : null;
    const entry = historyEntry(record, event, current, this._clock, writeState);
    const now = readClock(this._clock);
    const changeSequence = this._nextChangeSequence();
    const canonicalText = entry.canonicalIdentity === null
      ? null
      : stringifyJson(entry.canonicalIdentity, "history canonical identity", 64 * 1024);
    const displayText = stringifyJson(entry.displaySnapshot, "history display snapshot", 64 * 1024);
    const playbackText = stringifyJson(
      entry.playbackSnapshot,
      "history playback snapshot",
      64 * 1024
    );
    if (!stored) {
      this._db.prepare(`
        INSERT INTO cloud_history (
          profile_id, content_key, schema_version, canonical_identity,
          display_snapshot, playback_snapshot, position_ms, duration_ms,
          watched_ms, completed, revision, change_sequence, last_played_at,
          updated_at, deleted_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)
      `).run(
        record.profileId,
        entry.contentKey,
        canonicalText,
        displayText,
        playbackText,
        entry.positionMs,
        entry.durationMs,
        entry.watchedMs,
        entry.completed ? 1 : 0,
        changeSequence,
        entry.lastPlayedAt,
        now
      );
    } else {
      if (stored.revision >= MAX_SAFE_INTEGER) {
        const error = new Error("history revision exhausted");
        error.code = "revision_exhausted";
        throw error;
      }
      const result = this._db.prepare(`
        UPDATE cloud_history SET
          canonical_identity = ?, display_snapshot = ?, playback_snapshot = ?,
          position_ms = ?, duration_ms = ?, watched_ms = ?, completed = ?,
          revision = revision + 1, change_sequence = ?, last_played_at = ?,
          updated_at = ?, deleted_at = NULL
        WHERE profile_id = ? AND content_key = ? AND revision = ?
      `).run(
        canonicalText,
        displayText,
        playbackText,
        entry.positionMs,
        entry.durationMs,
        entry.watchedMs,
        entry.completed ? 1 : 0,
        changeSequence,
        entry.lastPlayedAt,
        now,
        record.profileId,
        entry.contentKey,
        stored.revision
      );
      if (result.changes !== 1) {
        throw historyGrantError("history_session_stale", "history write was not applied");
      }
    }
    return toHistoryDto(mapHistory(this._db.prepare(`
      SELECT * FROM cloud_history WHERE profile_id = ? AND content_key = ?
    `).get(record.profileId, entry.contentKey)));
  }

  _enqueueDispatchInTransaction(record, candidate, targetState, nextRevision, now) {
    const session = this._db.prepare(`
      SELECT * FROM playback_sessions WHERE profile_id = ? AND session_id = ?
    `).get(record.profileId, record.sessionId);
    if (
      !session ||
      session.profile_revision !== record.profileRevision ||
      session.device_id !== record.deviceId ||
      session.device_generation !== record.deviceGeneration ||
      session.context_id !== record.authority.contextId ||
      session.playback_generation !== record.playbackGeneration ||
      session.context_revision !== record.authority.contextRevision ||
      session.state !== record.sessionState ||
      session.revision !== record.sessionRevision
    ) {
      throw historyGrantError("history_session_stale", "canonical playback session is stale");
    }
    if (nextRevision !== record.sessionRevision) {
      const result = this._db.prepare(`
        UPDATE playback_sessions SET
          state = ?, revision = ?, updated_at = ?,
          invalidated_at = CASE WHEN ? = 'released' THEN ? ELSE NULL END
        WHERE profile_id = ? AND session_id = ? AND revision = ?
      `).run(
        targetState,
        nextRevision,
        now,
        targetState,
        now,
        record.profileId,
        record.sessionId,
        record.sessionRevision
      );
      if (result.changes !== 1) {
        throw historyGrantError("history_session_stale", "canonical playback session is stale");
      }
    }
    const dispatch = createDispatchIntent(record, candidate, nextRevision, now);
    this._db.prepare(`
      INSERT INTO scrobble_dispatches (
        profile_id, id, profile_revision, device_id, device_generation,
        history_generation, session_id, context_id, playback_generation, context_revision,
        session_revision, event, progress, payload, required_state, status,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(
      record.profileId,
      dispatch.intent.id,
      record.profileRevision,
      record.deviceId,
      record.deviceGeneration,
      record.historyGeneration,
      record.sessionId,
      record.authority.contextId,
      record.playbackGeneration,
      record.authority.contextRevision,
      nextRevision,
      dispatch.intent.event,
      dispatch.intent.progress,
      stringifyJson(dispatch.payload, "history dispatch payload", 64 * 1024),
      targetState,
      now,
      now,
      now
    );
    return dispatch;
  }

  _assertBindingCurrent(binding) {
    const profile = this._db.prepare(`
      SELECT status, revision, history_generation FROM profiles WHERE id = ?
    `).get(binding.profileId);
    if (
      !profile ||
      profile.status !== "active" ||
      profile.revision !== binding.profileRevision ||
      profile.history_generation !== binding.historyGeneration
    ) {
      throw historyGrantError("history_grant_stale", "history grant profile binding is stale");
    }
    const device = this._db.prepare(`
      SELECT generation, revoked_at, expires_at FROM devices
       WHERE profile_id = ? AND id = ?
    `).get(binding.profileId, binding.deviceId);
    if (
      !device ||
      device.revoked_at !== null ||
      device.generation !== binding.deviceGeneration ||
      device.expires_at <= readClock(this._clock)
    ) {
      throw historyGrantError("history_grant_stale", "history grant device binding is stale");
    }
    this._assertScopesCurrent(binding.profileId, [
      ["profile", revocationScope("profile", binding)],
      ["device", revocationScope("device", binding)],
      ["history", revocationScope("history", binding)],
      ["playback", revocationScope("playback", binding)],
    ]);
  }

  _assertGrantCurrent(record, options = {}) {
    if (record.status === "revoked" || record.status === "superseded") {
      throw historyGrantError("history_grant_stale", "history grant is no longer current");
    }
    if (!options.bindingChecked) this._assertBindingCurrent(record);
    this._assertNoRevocations(record, record.authority);
  }

  _assertAuthorityBinding(record, authority) {
    if (
      record.profileId !== authority.profileId ||
      record.profileRevision !== authority.profileRevision ||
      record.deviceId !== authority.deviceId ||
      record.deviceGeneration !== authority.deviceGeneration ||
      record.historyGeneration !== authority.historyGeneration ||
      record.playbackGeneration !== authority.playbackGeneration ||
      record.sessionId !== authority.sessionId
    ) {
      throw historyGrantError(
        "history_claim_conflict",
        "source authority does not match reserved history grant"
      );
    }
  }

  _assertNoRevocations(record, authority) {
    this._assertScopesCurrent(record.profileId, revocationScopes(record, authority));
  }

  _assertScopesCurrent(profileId, scopes) {
    const statement = this._db.prepare(`
      SELECT 1 AS present FROM history_grant_revocations
       WHERE profile_id = ? AND kind = ? AND scope_hash = ?
    `);
    if (scopes.some(([kind, hash]) => statement.get(profileId, kind, hash))) {
      throw historyGrantError("history_grant_stale", "history grant authority was revoked");
    }
  }

  _revoke(kind, binding, columns) {
    return this._write(binding.profileId, () => {
      if (!this._profileExists(binding.profileId)) return 0;
      const now = readClock(this._clock);
      this._db.prepare(`
        INSERT OR IGNORE INTO history_grant_revocations (
          profile_id, kind, scope_hash, replacement_session_id, revoked_at
        ) VALUES (?, ?, ?, NULL, ?)
      `).run(binding.profileId, kind, revocationScope(kind, binding), now);
      const predicate = this._predicate(columns);
      const columnValues = Object.values(columns);
      const changed = this._db.prepare(`
        UPDATE history_grants SET
          status = 'revoked', revoked_at = ?, revocation_reason = '${kind}'
        WHERE profile_id = ? AND ${predicate} AND status != 'revoked'
      `).run(now, binding.profileId, ...columnValues).changes;
      const scopedPredicate = this._qualifyPredicate(predicate);
      this._db.prepare(`
        UPDATE scrobble_dispatches SET
          status = 'revoked', revoked_at = ?, updated_at = ?,
          lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE profile_id = ? AND status IN ('queued', 'leased') AND session_id IN (
          SELECT g.session_id FROM history_grants g
           WHERE g.profile_id = ? AND ${scopedPredicate}
        )
      `).run(now, now, binding.profileId, binding.profileId, ...columnValues);
      this._db.prepare(`
        UPDATE playback_sessions SET
          state = 'released',
          revision = CASE WHEN revision < 9007199254740991 THEN revision + 1 ELSE revision END,
          updated_at = ?, invalidated_at = ?
        WHERE profile_id = ? AND state != 'released' AND session_id IN (
          SELECT g.session_id FROM history_grants g
           WHERE g.profile_id = ? AND ${scopedPredicate}
        )
      `).run(now, now, binding.profileId, binding.profileId, ...columnValues);
      return changed;
    });
  }

  _predicate(columns) {
    const allowed = new Set([
      "profile_revision",
      "device_id",
      "device_generation",
      "history_generation",
      "playback_generation",
      "session_id",
      "context_id",
      "provider_revision",
      "context_revision",
    ]);
    return Object.keys(columns).map((column) => {
      if (!allowed.has(column)) throw new TypeError("history revocation predicate is invalid");
      return column + " = ?";
    }).join(" AND ");
  }

  _qualifyPredicate(predicate) {
    return predicate.replaceAll(/\b([a-z_]+)\b/g, "g.$1");
  }

  _supersedeInTransaction(profileId, deviceId, sessionId, replacementSessionId, now) {
    if (!this._profileExists(profileId)) return false;
    const scopeHash = revocationScope("supersession", { profileId, sessionId });
    const existing = this._db.prepare(`
      SELECT replacement_session_id FROM history_grant_revocations
       WHERE profile_id = ? AND kind = 'supersession' AND scope_hash = ?
    `).get(profileId, scopeHash);
    if (existing) {
      if (existing.replacement_session_id !== replacementSessionId) {
        throw historyGrantError(
          "history_supersession_conflict",
          "history session has a different replacement"
        );
      }
      return false;
    }
    const record = mapGrant(this._db.prepare(`
      SELECT * FROM history_grants WHERE profile_id = ? AND session_id = ?
    `).get(profileId, sessionId));
    if (record && record.deviceId !== deviceId) {
      throw historyGrantError(
        "history_supersession_conflict",
        "history session belongs to another device"
      );
    }
    this._db.prepare(`
      INSERT INTO history_grant_revocations (
        profile_id, kind, scope_hash, replacement_session_id, revoked_at
      ) VALUES (?, 'supersession', ?, ?, ?)
    `).run(profileId, scopeHash, replacementSessionId, now);
    if (!record) return false;
    this._db.prepare(`
      UPDATE history_grants SET
        status = 'superseded', superseded_at = ?, revocation_reason = 'supersession'
      WHERE profile_id = ? AND session_id = ?
    `).run(now, profileId, sessionId);
    this._db.prepare(`
      UPDATE scrobble_dispatches SET
        status = 'revoked', revoked_at = ?, updated_at = ?,
        lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
      WHERE profile_id = ? AND session_id = ? AND status IN ('queued', 'leased')
    `).run(now, now, profileId, sessionId);
    this._db.prepare(`
      UPDATE playback_sessions SET
        state = 'released',
        revision = CASE WHEN revision < 9007199254740991 THEN revision + 1 ELSE revision END,
        updated_at = ?, invalidated_at = ?
      WHERE profile_id = ? AND session_id = ? AND state != 'released'
    `).run(now, now, profileId, sessionId);
    return true;
  }

  _nextChangeSequence() {
    const result = this._db.prepare(`
      UPDATE history_sequence SET value = value + 1
       WHERE singleton = 1 AND value < 9007199254740991
    `).run();
    if (result.changes !== 1) {
      const error = new Error("history change sequence exhausted");
      error.code = "history_sequence_exhausted";
      throw error;
    }
    const row = this._db.prepare("SELECT value FROM history_sequence WHERE singleton = 1").get();
    if (!row || !Number.isSafeInteger(row.value) || row.value < 1) {
      const error = new Error("history change sequence exhausted");
      error.code = "history_sequence_exhausted";
      throw error;
    }
    return row.value;
  }

  _grantById(grantId) {
    return this._db.prepare("SELECT * FROM history_grants WHERE grant_id = ?").get(grantId);
  }

  _expireReservationNow(grantId, now) {
    return this._db.prepare(`
      UPDATE history_grants
         SET status = 'revoked', revoked_at = ?, revocation_reason = 'playback'
       WHERE grant_id = ? AND status = 'reserved'
    `).run(now, grantId).changes === 1;
  }

  _profileExists(profileId) {
    return Boolean(this._db.prepare("SELECT 1 AS present FROM profiles WHERE id = ?").get(profileId));
  }

  _recoverToken(record) {
    return recoverGrantToken(record, this._tokens, this._crypto);
  }

  _write(profileId, operation) {
    return this._lifecycleCoordinator.run(profileId, () =>
      withImmediateTransaction(this._db, operation)
    );
  }
}

module.exports = {
  SQLiteHistoryGrantRepository: SqliteHistoryGrantRepository,
  SqliteHistoryGrantRepository,
  mapGrant,
};
