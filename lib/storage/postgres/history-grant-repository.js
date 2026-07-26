"use strict";

const crypto = require("node:crypto");

const { toHistoryDto } = require("../../history-service");
const {
  attachPreparedHttpResponse,
  encodePreparedHttpResponse,
  normalizePreparedHttpResponse,
  preparedHttpResponseEqual,
} = require("../../prepared-http-response");
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
const {
  affectedRows,
  dateParameter,
  firstRow,
  jsonValue,
  mapHistoryRow,
  requireDatabase,
  resultRows,
  toSafeInteger,
  toTimestamp,
} = require("./repository-helpers");

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const PLAYBACK_SESSION_TRANSITION_SQL = `UPDATE playback_sessions
    SET state = $3, revision = $4, updated_at = $5::timestamptz,
        invalidated_at = CASE
          WHEN $3 = 'released' THEN $5::timestamptz
          ELSE NULL
        END
  WHERE profile_id = $1 AND session_id = $2 AND revision = $6`;

function nullableTimestamp(value, name) {
  return value === null || value === undefined ? null : toTimestamp(value, name);
}

function mapHttpStatus(value, name) {
  const status = toSafeInteger(value, name, 100);
  if (status > 599) throw new RangeError(name + " is invalid");
  return status;
}

function mapPreparedResponse(status, headers, body, name) {
  const absent = status === null && headers === null && body === null;
  if (absent) return null;
  if (status === null || headers === null || body === null) {
    throw new TypeError(name + " is incomplete");
  }
  return normalizePreparedHttpResponse({
    status: mapHttpStatus(status, name + " status"),
    headers: jsonValue(headers, name + " headers"),
    body: Buffer.from(body),
  });
}

function mapGrantRow(row) {
  if (!row) return null;
  const profileId = assertIdentifier(row.profile_id, "stored history grant profile id");
  const deviceId = assertIdentifier(row.device_id, "stored history grant device id");
  const sessionId = assertIdentifier(row.session_id, "stored history grant session id");
  const profileRevision = toSafeInteger(row.profile_revision, "history grant profile revision", 1);
  const deviceGeneration = toSafeInteger(
    row.device_generation,
    "history grant device generation",
    1
  );
  const historyGeneration = toSafeInteger(
    row.history_generation,
    "history grant history generation",
    1
  );
  const playbackGeneration = assertPlaybackGeneration(row.playback_generation);
  const authority = row.claim_status === null || row.claim_status === undefined
    ? null
    : normalizeSourceAuthority({
        profileId,
        profileRevision,
        deviceId,
        deviceGeneration,
        historyGeneration,
        playbackGeneration,
        providerRevision: row.provider_revision,
        contextId: row.context_id,
        contextRevision: row.context_revision,
        sessionId,
        contentKey: row.content_key,
        canonicalIdentity: jsonValue(
          row.canonical_identity,
          "history grant canonical identity",
          true
        ),
        displaySnapshot: jsonValue(row.display_snapshot, "history grant display snapshot"),
        claimStatus: row.claim_status,
        traktEligible: row.trakt_eligible,
        supersededSessionId: row.superseded_session_id,
      });
  return {
    grantId: assertIdentifier(row.grant_id, "stored history grant id"),
    attemptId: String(row.attempt_id),
    requestDigest: String(row.request_digest).trim(),
    profileId,
    profileRevision,
    deviceId,
    deviceGeneration,
    historyGeneration,
    playbackGeneration,
    sessionId,
    tokenHash: String(row.token_hash).trim(),
    tokenEnvelope: jsonValue(row.token_envelope, "history grant token envelope"),
    status: assertGrantState(row.status),
    kind: row.kind === null ? null : assertGrantKind(row.kind),
    claimStatus: row.claim_status,
    authority,
    sessionState: row.session_state === null ? null : assertSessionState(row.session_state),
    sessionRevision: row.session_revision === null
      ? null
      : toSafeInteger(row.session_revision, "history grant session revision", 1),
    terminalReceiptId: row.terminal_receipt_id === null
      ? null
      : String(row.terminal_receipt_id),
    reservationExpiresAt: toTimestamp(
      row.reservation_expires_at,
      "history grant reservationExpiresAt"
    ),
    claimResponse: row.claim_response_status === null
      ? null
      : encodePreparedHttpResponse(mapPreparedResponse(
          row.claim_response_status,
          row.claim_response_headers,
          row.claim_response_body,
          "history claim response"
        )),
    createdAt: toTimestamp(row.created_at, "history grant createdAt"),
    finalizedAt: nullableTimestamp(row.finalized_at, "history grant finalizedAt"),
    releasedAt: nullableTimestamp(row.released_at, "history grant releasedAt"),
    revokedAt: nullableTimestamp(row.revoked_at, "history grant revokedAt"),
    supersededAt: nullableTimestamp(row.superseded_at, "history grant supersededAt"),
    revocationReason: row.revocation_reason,
  };
}

function mapReceiptResponse(row) {
  if (!row) return null;
  const response = cloneJson(jsonValue(row.response, "history event receipt"));
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

class PostgresHistoryGrantRepository {
  constructor(options = {}) {
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
    this._grantIdFactory = options.grantIdFactory || (() => randomId("hgr"));
    this._sessionIdFactory = options.sessionIdFactory || (() => randomId("hgs"));
    if (typeof this._grantIdFactory !== "function" || typeof this._sessionIdFactory !== "function") {
      throw new TypeError("history grant id factories are invalid");
    }
  }

  async reserve(input) {
    const candidate = normalizeReservationInput(input);
    return this._db.transaction(async (transaction) => {
      await this._assertBindingCurrent(transaction, candidate);
      const existing = mapGrantRow(firstRow(await transaction.query(
        `SELECT * FROM history_grants
          WHERE profile_id = $1 AND device_id = $2 AND attempt_id = $3::uuid
          FOR UPDATE`,
        [candidate.profileId, candidate.deviceId, candidate.attemptId]
      )));
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
          await this._expireReservationInTransaction(
            transaction,
            existing.grantId,
            readClock(this._clock)
          );
          throw historyGrantError("history_grant_stale", "history grant reservation expired");
        }
        await this._assertGrantCurrent(transaction, existing, { bindingChecked: true });
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
      const row = firstRow(await transaction.query(
        `INSERT INTO history_grants (
           grant_id, attempt_id, request_digest, profile_id, profile_revision,
           device_id, device_generation, history_generation, playback_generation,
           session_id, token_hash, token_envelope, status, created_at,
           reservation_expires_at
         ) VALUES (
           $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'reserved', $13, $14
         ) RETURNING *`,
        [
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
          tokenEnvelope,
          dateParameter(now, "history grant createdAt"),
          dateParameter(now + this._reservationTtlMs, "history grant reservationExpiresAt"),
        ]
      ));
      return grantResponse(mapGrantRow(row), grantToken);
    });
  }

  async abandon(input) {
    const candidate = normalizeAbandonReservationInput(input);
    return this._db.transaction(async (transaction) => {
      const record = mapGrantRow(firstRow(await transaction.query(
        "SELECT * FROM history_grants WHERE grant_id = $1 FOR UPDATE",
        [candidate.grantId]
      )));
      if (!record) return false;
      if (!sameReservation(record, candidate)) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim abandonment does not match reserved request bytes"
        );
      }
      if (record.status !== "reserved") return false;
      await this._assertBindingCurrent(transaction, candidate);
      return this._expireReservationInTransaction(
        transaction,
        record.grantId,
        readClock(this._clock)
      );
    });
  }

  async commitClaimResponse(input) {
    const candidate = normalizeCommitClaimResponseInput(input);
    return this._db.transaction(async (transaction) => {
      const record = mapGrantRow(firstRow(await transaction.query(
        "SELECT * FROM history_grants WHERE grant_id = $1 FOR UPDATE",
        [candidate.grantId]
      )));
      if (!record) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
      if (record.requestDigest !== candidate.requestDigest) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim response does not match reserved request bytes"
        );
      }
      await this._assertGrantCurrent(transaction, record);
      if (record.status !== "active" && record.status !== "released") {
        throw historyGrantError("history_grant_stale", "history grant is not active");
      }
      if (record.claimResponse) {
        const storedRow = firstRow(await transaction.query(
          `SELECT claim_response_status, claim_response_headers, claim_response_body
             FROM history_grants WHERE grant_id = $1`,
          [record.grantId]
        ));
        const stored = mapPreparedResponse(
          storedRow.claim_response_status,
          storedRow.claim_response_headers,
          storedRow.claim_response_body,
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
      await transaction.query(
        `UPDATE history_grants
            SET claim_response_status = $2, claim_response_headers = $3::jsonb,
                claim_response_body = $4
          WHERE grant_id = $1 AND claim_response_status IS NULL`,
        [
          record.grantId,
          candidate.preparedResponse.status,
          candidate.preparedResponse.headers,
          candidate.preparedResponse.body,
        ]
      );
      return candidate.preparedResponse;
    });
  }

  async finalize(input) {
    const candidate = normalizeFinalizationInput(input);
    const initial = mapGrantRow(firstRow(await this._db.query(
      "SELECT * FROM history_grants WHERE grant_id = $1",
      [candidate.grantId]
    )));
    if (!initial) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);

    return this._db.transaction(async (transaction) => {
      await this._assertBindingCurrent(transaction, initial);
      const record = mapGrantRow(firstRow(await transaction.query(
        "SELECT * FROM history_grants WHERE grant_id = $1 FOR UPDATE",
        [candidate.grantId]
      )));
      if (!record) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
      if (record.requestDigest !== candidate.requestDigest) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim finalization does not match reserved request bytes"
        );
      }
      this._assertAuthorityBinding(record, candidate.authority);
      await this._assertGrantCurrent(transaction, record, { bindingChecked: true });
      await this._assertNoRevocations(transaction, record, candidate.authority);

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
        await this._supersedeInTransaction(
          transaction,
          record.profileId,
          record.deviceId,
          candidate.authority.supersededSessionId,
          record.sessionId,
          now
        );
      }
      const kind = deriveGrantKind(candidate.authority);
      if (kind === "canonical") {
        await transaction.query(
          `INSERT INTO playback_sessions (
             profile_id, session_id, profile_revision, device_id, device_generation,
             context_id, playback_generation, context_revision, state, revision,
             created_at, updated_at, invalidated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'playing', 1, $9, $9, NULL)`,
          [
            record.profileId,
            record.sessionId,
            record.profileRevision,
            record.deviceId,
            record.deviceGeneration,
            candidate.authority.contextId,
            record.playbackGeneration,
            candidate.authority.contextRevision,
            dateParameter(now, "history session createdAt"),
          ]
        );
      }
      const updated = mapGrantRow(firstRow(await transaction.query(
        `UPDATE history_grants
            SET status = 'active', kind = $2, claim_status = $3,
                provider_revision = $4, context_id = $5, context_revision = $6,
                content_key = $7, canonical_identity = $8, display_snapshot = $9,
                trakt_eligible = $10, superseded_session_id = $11,
                session_state = 'playing', session_revision = 1, finalized_at = $12
          WHERE grant_id = $1 AND status = 'reserved'
          RETURNING *`,
        [
          record.grantId,
          kind,
          candidate.authority.claimStatus,
          candidate.authority.providerRevision,
          candidate.authority.contextId,
          candidate.authority.contextRevision,
          candidate.authority.contentKey,
          candidate.authority.canonicalIdentity,
          candidate.authority.displaySnapshot,
          candidate.authority.traktEligible,
          candidate.authority.supersededSessionId,
          dateParameter(now, "history grant finalizedAt"),
        ]
      )));
      if (!updated) throw historyGrantError("history_grant_stale", "history grant is no longer current");
      return grantResponse(updated, this._recoverToken(updated));
    });
  }

  async applyEvent(input) {
    const candidate = normalizeApplyEventInput(input);
    const tokenHash = hashPresentedGrantToken(this._tokens, candidate.grantToken);
    const initial = mapGrantRow(firstRow(await this._db.query(
      "SELECT * FROM history_grants WHERE token_hash = $1",
      [tokenHash]
    )));
    if (!initial) throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
    assertPresentedGrantBinding(initial, candidate);

    return this._db.transaction(async (transaction) => {
      await this._assertBindingCurrent(transaction, initial);
      const record = mapGrantRow(firstRow(await transaction.query(
        "SELECT * FROM history_grants WHERE token_hash = $1 FOR UPDATE",
        [tokenHash]
      )));
      if (!record || record.tokenHash !== tokenHash) {
        throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
      }
      assertPresentedGrantBinding(record, candidate);

      // Currency is checked before receipt lookup so a stale capability cannot
      // replay an otherwise valid historical response.
      await this._assertGrantCurrent(transaction, record, { bindingChecked: true });
      const receipt = firstRow(await transaction.query(
        `SELECT * FROM history_event_receipts
          WHERE grant_id = $1 AND idempotency_key = $2::uuid FOR UPDATE`,
        [record.grantId, candidate.idempotencyKey]
      ));

      if (record.status === "released") {
        if (
          receipt &&
          record.terminalReceiptId === candidate.idempotencyKey &&
          String(receipt.request_digest).trim() === candidate.requestDigest
        ) {
          return mapReceiptResponse(receipt);
        }
        if (receipt && String(receipt.request_digest).trim() !== candidate.requestDigest) {
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
        if (String(receipt.request_digest).trim() !== candidate.requestDigest) {
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
        : await this._applyHistoryInTransaction(transaction, record, candidate.event);
      const now = readClock(this._clock);
      const dispatch = !suppressed && record.kind === "canonical"
        ? await this._enqueueDispatchInTransaction(
            transaction,
            record,
            candidate,
            targetState,
            nextRevision,
            now
          )
        : null;

      const terminal = isTerminalEvent(candidate.event.event);
      let updated = record;
      if (!suppressed) {
        updated = mapGrantRow(firstRow(await transaction.query(
          `UPDATE history_grants
              SET status = CASE WHEN $4 THEN 'released' ELSE status END,
                  session_state = $2, session_revision = $3,
                  terminal_receipt_id = CASE WHEN $4 THEN $5::uuid ELSE terminal_receipt_id END,
                  released_at = CASE WHEN $4 THEN $6 ELSE released_at END
            WHERE grant_id = $1 AND status = 'active' AND session_revision = $7
            RETURNING *`,
          [
            record.grantId,
            targetState,
            nextRevision,
            terminal,
            terminal ? candidate.idempotencyKey : null,
            terminal ? dateParameter(now, "history grant releasedAt") : null,
            record.sessionRevision,
          ]
        )));
        if (!updated) throw historyGrantError("history_session_stale", "history session is stale");
      }

      const response = eventResponse(
        updated,
        candidate,
        history,
        dispatch ? dispatch.publicIntent : null,
        suppressed ? "suppressed" : null
      );
      const prepared = prepareHistoryEventResponse(response);
      await transaction.query(
        `INSERT INTO history_event_receipts (
           grant_id, idempotency_key, request_digest, event, terminal, response, created_at,
           response_status, response_headers, response_body
         ) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
        [
          record.grantId,
          candidate.idempotencyKey,
          candidate.requestDigest,
          candidate.event.event,
          terminal,
          response,
          dateParameter(now, "history receipt createdAt"),
          prepared.status,
          prepared.headers,
          prepared.body,
        ]
      );
      const result = cloneJson(response);
      attachPreparedHttpResponse(result, prepared);
      return Object.freeze(result);
    });
  }

  async release(input) {
    const candidate = normalizeReleaseInput(input);
    const initial = mapGrantRow(firstRow(await this._db.query(
      "SELECT * FROM history_grants WHERE profile_id = $1 AND session_id = $2",
      [candidate.profileId, candidate.sessionId]
    )));
    if (!initial) return false;
    return this._db.transaction(async (transaction) => {
      await this._assertBindingCurrent(transaction, initial);
      const record = mapGrantRow(firstRow(await transaction.query(
        `SELECT * FROM history_grants
          WHERE profile_id = $1 AND session_id = $2 FOR UPDATE`,
        [candidate.profileId, candidate.sessionId]
      )));
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
      await this._assertGrantCurrent(transaction, record, { bindingChecked: true });
      const receipt = firstRow(await transaction.query(
        `SELECT terminal FROM history_event_receipts
          WHERE grant_id = $1 AND idempotency_key = $2::uuid`,
        [record.grantId, candidate.terminalReceiptId]
      ));
      if (
        record.status !== "released" ||
        record.terminalReceiptId !== candidate.terminalReceiptId ||
        !receipt ||
        receipt.terminal !== true
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
    return this._db.transaction(async (transaction) => {
      const profile = firstRow(await transaction.query(
        `SELECT status, history_generation FROM profiles
          WHERE id = $1 FOR UPDATE`,
        [id]
      ));
      if (!profile || profile.status !== "active") {
        throw codedError("profile_inactive", "profile is missing or inactive");
      }
      const generation = toSafeInteger(profile.history_generation, "history generation", 1);
      if (generation >= Number.MAX_SAFE_INTEGER) {
        throw codedError("history_generation_exhausted", "history generation exhausted");
      }
      const now = readClock(this._clock);
      const timestamp = dateParameter(now, "history clearedAt");
      const scopeHash = revocationScope("history", {
        profileId: id,
        historyGeneration: generation,
      });

      await transaction.query("DELETE FROM cloud_history WHERE profile_id = $1", [id]);
      await transaction.query(
        `INSERT INTO history_grant_revocations (
           profile_id, kind, scope_hash, replacement_session_id, revoked_at
         ) VALUES ($1, 'history', $2, NULL, $3)
         ON CONFLICT (profile_id, kind, scope_hash) DO NOTHING`,
        [id, scopeHash, timestamp]
      );
      const revoked = await transaction.query(
        `UPDATE history_grants
            SET status = 'revoked', revoked_at = $3, revocation_reason = 'history'
          WHERE profile_id = $1 AND history_generation = $2 AND status != 'revoked'`,
        [id, generation, timestamp]
      );
      await transaction.query(
        `UPDATE scrobble_dispatches
            SET status = 'revoked', revoked_at = $3, updated_at = $3,
                lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
          WHERE profile_id = $1 AND history_generation = $2
            AND status IN ('queued', 'leased')`,
        [id, generation, timestamp]
      );
      const released = await transaction.query(
        `UPDATE playback_sessions
            SET state = 'released',
                revision = CASE WHEN revision < 9007199254740991 THEN revision + 1 ELSE revision END,
                updated_at = $2, invalidated_at = $2
          WHERE profile_id = $1 AND state != 'released'`,
        [id, timestamp]
      );
      const advanced = await transaction.query(
        `UPDATE profiles
            SET history_generation = history_generation + 1, updated_at = $3
          WHERE id = $1 AND status = 'active' AND history_generation = $2
          RETURNING history_generation`,
        [id, generation, timestamp]
      );
      if (affectedRows(advanced) !== 1) {
        throw codedError("history_generation_changed", "history generation changed during clear");
      }
      return Object.freeze({
        previousGeneration: generation,
        historyGeneration: toSafeInteger(
          firstRow(advanced).history_generation,
          "history generation",
          1
        ),
        revokedGrants: affectedRows(revoked),
        releasedSessions: affectedRows(released),
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
    return this._db.transaction(async (transaction) => {
      if (!(await this._lockProfile(transaction, scopedProfileId))) return false;
      return this._supersedeInTransaction(
        transaction,
        scopedProfileId,
        scopedDeviceId,
        scopedSessionId,
        replacement,
        readClock(this._clock)
      );
    });
  }

  async getGrantBySession(profileId, sessionId) {
    const row = firstRow(await this._db.query(
      "SELECT * FROM history_grants WHERE profile_id = $1 AND session_id = $2",
      [
        assertIdentifier(profileId, "profile id"),
        assertIdentifier(sessionId, "history session id"),
      ]
    ));
    return publicGrant(mapGrantRow(row));
  }

  async prune() {
    const now = readClock(this._clock);
    return this._db.transaction(async (transaction) => {
      const expired = await transaction.query(
        `UPDATE history_grants
            SET status = 'revoked', revoked_at = $1, revocation_reason = 'playback'
          WHERE kind IS NULL AND status = 'reserved' AND reservation_expires_at <= $1`,
        [dateParameter(now, "history reservation prune time")]
      );
      const pruned = await transaction.query(
        `DELETE FROM history_grants
          WHERE kind IS NULL AND status = 'revoked' AND reservation_expires_at <= $1`,
        [
          dateParameter(
            Math.max(0, now - this._reservationRetentionMs),
            "history reservation retention cutoff"
          ),
        ]
      );
      return Object.freeze({
        expiredReservations: affectedRows(expired),
        prunedReservations: affectedRows(pruned),
      });
    });
  }

  async listDispatchIntents(profileId, sessionId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedSessionId = assertIdentifier(sessionId, "history session id");
    const rows = resultRows(await this._db.query(
      `SELECT d.*, g.grant_id, g.history_generation, g.provider_revision,
              g.canonical_identity
         FROM scrobble_dispatches d
         JOIN history_grants g
           ON g.profile_id = d.profile_id AND g.session_id = d.session_id
        WHERE d.profile_id = $1 AND d.session_id = $2
        ORDER BY d.created_at, d.id`,
      [scopedProfileId, scopedSessionId]
    ));
    return rows.map((row) => publicDispatchIntent({
      id: row.id,
      grantId: row.grant_id,
      profileId: row.profile_id,
      profileRevision: toSafeInteger(row.profile_revision, "dispatch profile revision", 1),
      deviceId: row.device_id,
      deviceGeneration: toSafeInteger(row.device_generation, "dispatch device generation", 1),
      historyGeneration: toSafeInteger(row.history_generation, "dispatch history generation", 1),
      sessionId: row.session_id,
      sessionRevision: toSafeInteger(row.session_revision, "dispatch session revision", 1),
      contextId: row.context_id,
      contextRevision: row.context_revision,
      playbackGeneration: row.playback_generation,
      providerRevision: row.provider_revision,
      event: row.event,
      progress: row.progress,
      canonicalIdentity: jsonValue(row.canonical_identity, "dispatch canonical identity"),
      status: row.status,
      createdAt: toTimestamp(row.created_at, "dispatch createdAt"),
      revokedAt: nullableTimestamp(row.revoked_at, "dispatch revokedAt"),
    }));
  }

  async eraseProfileInTransaction(transaction, profileId) {
    const id = assertIdentifier(profileId, "profile id");
    await transaction.query(
      `DELETE FROM scrobble_dispatches
        WHERE profile_id = $1 AND session_id IN (
          SELECT session_id FROM history_grants WHERE profile_id = $1
        )`,
      [id]
    );
    await transaction.query(
      `DELETE FROM playback_sessions
        WHERE profile_id = $1 AND session_id IN (
          SELECT session_id FROM history_grants WHERE profile_id = $1
        )`,
      [id]
    );
    await transaction.query("DELETE FROM history_grants WHERE profile_id = $1", [id]);
    await transaction.query("DELETE FROM history_grant_revocations WHERE profile_id = $1", [id]);
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

  async _applyHistoryInTransaction(transaction, record, event) {
    if (!record.authority.contentKey) return null;
    const storedRow = firstRow(await transaction.query(
      `SELECT * FROM cloud_history
        WHERE profile_id = $1 AND content_key = $2 FOR UPDATE`,
      [record.profileId, record.authority.contentKey]
    ));
    const writeState = storedRow ? mapHistoryRow(storedRow) : null;
    const current = writeState && writeState.deletedAt === null ? writeState : null;
    const entry = historyEntry(record, event, current, this._clock, writeState);
    const now = readClock(this._clock);
    let result;
    if (!storedRow) {
      result = await transaction.query(
        `INSERT INTO cloud_history (
           profile_id, content_key, schema_version, canonical_identity,
           display_snapshot, playback_snapshot, position_ms, duration_ms,
           watched_ms, completed, revision, last_played_at, updated_at, deleted_at
         ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, NULL)
         RETURNING *`,
        [
          record.profileId,
          entry.contentKey,
          entry.canonicalIdentity,
          entry.displaySnapshot,
          entry.playbackSnapshot,
          entry.positionMs,
          entry.durationMs,
          entry.watchedMs,
          entry.completed,
          dateParameter(entry.lastPlayedAt, "history lastPlayedAt"),
          dateParameter(now, "history updatedAt"),
        ]
      );
    } else {
      const revision = toSafeInteger(storedRow.revision, "history revision", 1);
      if (revision >= MAX_SAFE_INTEGER) {
        const error = new Error("history revision exhausted");
        error.code = "revision_exhausted";
        throw error;
      }
      result = await transaction.query(
        `UPDATE cloud_history
            SET canonical_identity = $4, display_snapshot = $5,
                playback_snapshot = $6, position_ms = $7, duration_ms = $8,
                watched_ms = $9, completed = $10, revision = revision + 1,
                change_seq = nextval('cloud_history_change_seq'),
                last_played_at = $11, updated_at = $12, deleted_at = NULL
          WHERE profile_id = $1 AND content_key = $2 AND revision = $3
          RETURNING *`,
        [
          record.profileId,
          entry.contentKey,
          revision,
          entry.canonicalIdentity,
          entry.displaySnapshot,
          entry.playbackSnapshot,
          entry.positionMs,
          entry.durationMs,
          entry.watchedMs,
          entry.completed,
          dateParameter(entry.lastPlayedAt, "history lastPlayedAt"),
          dateParameter(now, "history updatedAt"),
        ]
      );
    }
    const row = firstRow(result);
    if (!row) throw historyGrantError("history_session_stale", "history write was not applied");
    return toHistoryDto(mapHistoryRow(row));
  }

  async _enqueueDispatchInTransaction(
    transaction,
    record,
    candidate,
    targetState,
    nextRevision,
    now
  ) {
    const session = firstRow(await transaction.query(
      `SELECT * FROM playback_sessions
        WHERE profile_id = $1 AND session_id = $2 FOR UPDATE`,
      [record.profileId, record.sessionId]
    ));
    if (
      !session ||
      toSafeInteger(session.profile_revision, "playback profile revision", 1) !== record.profileRevision ||
      session.device_id !== record.deviceId ||
      toSafeInteger(session.device_generation, "playback device generation", 1) !== record.deviceGeneration ||
      session.context_id !== record.authority.contextId ||
      session.playback_generation !== record.playbackGeneration ||
      session.context_revision !== record.authority.contextRevision ||
      session.state !== record.sessionState ||
      toSafeInteger(session.revision, "playback session revision", 1) !== record.sessionRevision
    ) {
      throw historyGrantError("history_session_stale", "canonical playback session is stale");
    }
    if (nextRevision !== record.sessionRevision) {
      const transitioned = await transaction.query(
        PLAYBACK_SESSION_TRANSITION_SQL,
        [
          record.profileId,
          record.sessionId,
          targetState,
          nextRevision,
          dateParameter(now, "playback session updatedAt"),
          record.sessionRevision,
        ]
      );
      if (affectedRows(transitioned) !== 1) {
        throw historyGrantError("history_session_stale", "canonical playback session is stale");
      }
    }
    const dispatch = createDispatchIntent(record, candidate, nextRevision, now);
    await transaction.query(
       `INSERT INTO scrobble_dispatches (
          profile_id, id, profile_revision, device_id, device_generation,
          history_generation, session_id, context_id, playback_generation, context_revision,
          session_revision, event, progress, payload, required_state, status,
          attempt_count, next_attempt_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
          $14, $15, 'queued', 0, $16, $16, $16
       )`,
      [
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
        dispatch.payload,
        targetState,
        dateParameter(now, "history dispatch createdAt"),
      ]
    );
    return dispatch;
  }

  async _assertBindingCurrent(transaction, binding) {
    const profile = firstRow(await transaction.query(
      `SELECT status, revision, history_generation
         FROM profiles WHERE id = $1 FOR UPDATE`,
      [binding.profileId]
    ));
    if (
      !profile ||
      profile.status !== "active" ||
      toSafeInteger(profile.revision, "profile revision", 1) !== binding.profileRevision ||
      toSafeInteger(profile.history_generation, "history generation", 1) !== binding.historyGeneration
    ) {
      throw historyGrantError("history_grant_stale", "history grant profile binding is stale");
    }
    const now = readClock(this._clock);
    const device = firstRow(await transaction.query(
      `SELECT generation, revoked_at, expires_at FROM devices
        WHERE profile_id = $1 AND id = $2 FOR SHARE`,
      [binding.profileId, binding.deviceId]
    ));
    if (
      !device ||
      device.revoked_at !== null ||
      toSafeInteger(device.generation, "device generation", 1) !== binding.deviceGeneration ||
      toTimestamp(device.expires_at, "device expiresAt") <= now
    ) {
      throw historyGrantError("history_grant_stale", "history grant device binding is stale");
    }
    const scopes = [
      ["profile", revocationScope("profile", binding)],
      ["device", revocationScope("device", binding)],
      ["history", revocationScope("history", binding)],
      ["playback", revocationScope("playback", binding)],
    ];
    await this._assertScopesCurrent(transaction, binding.profileId, scopes);
  }

  async _assertGrantCurrent(transaction, record, options = {}) {
    if (record.status === "revoked" || record.status === "superseded") {
      throw historyGrantError("history_grant_stale", "history grant is no longer current");
    }
    if (!options.bindingChecked) await this._assertBindingCurrent(transaction, record);
    await this._assertNoRevocations(transaction, record, record.authority);
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

  _assertNoRevocations(transaction, record, authority) {
    return this._assertScopesCurrent(
      transaction,
      record.profileId,
      revocationScopes(record, authority)
    );
  }

  async _assertScopesCurrent(transaction, profileId, scopes) {
    const hashes = scopes.map(([, hash]) => hash);
    const rows = resultRows(await transaction.query(
      `SELECT kind, scope_hash::text AS scope_hash
         FROM history_grant_revocations
        WHERE profile_id = $1 AND scope_hash::text = ANY($2::text[])`,
      [profileId, hashes]
    ));
    const expected = new Set(scopes.map(([kind, hash]) => kind + "\0" + hash));
    if (rows.some((row) => expected.has(row.kind + "\0" + String(row.scope_hash).trim()))) {
      throw historyGrantError("history_grant_stale", "history grant authority was revoked");
    }
  }

  async _revoke(kind, binding, columns) {
    const profileId = binding.profileId;
    const scopeHash = revocationScope(kind, binding);
    return this._db.transaction(async (transaction) => {
      if (!(await this._lockProfile(transaction, profileId))) return 0;
      const now = readClock(this._clock);
      await transaction.query(
        `INSERT INTO history_grant_revocations (
           profile_id, kind, scope_hash, replacement_session_id, revoked_at
         ) VALUES ($1, $2, $3, NULL, $4)
         ON CONFLICT (profile_id, kind, scope_hash) DO NOTHING`,
        [profileId, kind, scopeHash, dateParameter(now, "history grant revokedAt")]
      );
      const predicate = this._predicate(columns, 2);
      const values = [profileId, ...Object.values(columns)];
      const nowIndex = values.length + 1;
      values.push(dateParameter(now, "history grant revokedAt"));
      const result = await transaction.query(
        `UPDATE history_grants
            SET status = 'revoked', revoked_at = $${nowIndex}, revocation_reason = '${kind}'
          WHERE profile_id = $1 AND ${predicate.sql} AND status != 'revoked'
          RETURNING session_id`,
        values
      );
      await this._revokeOutboxAndSessions(transaction, profileId, predicate.sql, values, nowIndex);
      return affectedRows(result);
    });
  }

  _predicate(columns, firstParameter) {
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
    let index = firstParameter;
    const clauses = [];
    for (const column of Object.keys(columns)) {
      if (!allowed.has(column)) throw new TypeError("history revocation predicate is invalid");
      clauses.push(column + " = $" + index);
      index += 1;
    }
    return { sql: clauses.join(" AND ") };
  }

  async _revokeOutboxAndSessions(transaction, profileId, predicate, values, nowIndex) {
    await transaction.query(
      `UPDATE scrobble_dispatches d
          SET status = 'revoked', revoked_at = $${nowIndex}, updated_at = $${nowIndex},
              lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE d.profile_id = $1 AND d.status IN ('queued', 'leased') AND d.session_id IN (
          SELECT g.session_id FROM history_grants g
           WHERE g.profile_id = $1 AND ${predicate.replaceAll(/\b([a-z_]+)\b/g, "g.$1")}
        )`,
      values
    );
    await transaction.query(
      `UPDATE playback_sessions p
          SET state = 'released',
              revision = CASE WHEN revision < 9007199254740991 THEN revision + 1 ELSE revision END,
              updated_at = $${nowIndex}, invalidated_at = $${nowIndex}
        WHERE p.profile_id = $1 AND p.state != 'released' AND p.session_id IN (
          SELECT g.session_id FROM history_grants g
           WHERE g.profile_id = $1 AND ${predicate.replaceAll(/\b([a-z_]+)\b/g, "g.$1")}
        )`,
      values
    );
  }

  async _supersedeInTransaction(
    transaction,
    profileId,
    deviceId,
    sessionId,
    replacementSessionId,
    now
  ) {
    const scopeHash = revocationScope("supersession", { profileId, sessionId });
    const existing = firstRow(await transaction.query(
      `SELECT replacement_session_id FROM history_grant_revocations
        WHERE profile_id = $1 AND kind = 'supersession' AND scope_hash = $2`,
      [profileId, scopeHash]
    ));
    if (existing) {
      if (existing.replacement_session_id !== replacementSessionId) {
        throw historyGrantError(
          "history_supersession_conflict",
          "history session has a different replacement"
        );
      }
      return false;
    }
    const record = mapGrantRow(firstRow(await transaction.query(
      `SELECT * FROM history_grants
        WHERE profile_id = $1 AND session_id = $2 FOR UPDATE`,
      [profileId, sessionId]
    )));
    if (record && record.deviceId !== deviceId) {
      throw historyGrantError(
        "history_supersession_conflict",
        "history session belongs to another device"
      );
    }
    await transaction.query(
      `INSERT INTO history_grant_revocations (
         profile_id, kind, scope_hash, replacement_session_id, revoked_at
       ) VALUES ($1, 'supersession', $2, $3, $4)`,
      [
        profileId,
        scopeHash,
        replacementSessionId,
        dateParameter(now, "history session supersededAt"),
      ]
    );
    if (!record) return false;
    await transaction.query(
      `UPDATE history_grants
          SET status = 'superseded', superseded_at = $3, revocation_reason = 'supersession'
        WHERE profile_id = $1 AND session_id = $2`,
      [profileId, sessionId, dateParameter(now, "history session supersededAt")]
    );
    await transaction.query(
      `UPDATE scrobble_dispatches
          SET status = 'revoked', revoked_at = $3, updated_at = $3,
              lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE profile_id = $1 AND session_id = $2 AND status IN ('queued', 'leased')`,
      [profileId, sessionId, dateParameter(now, "history session supersededAt")]
    );
    await transaction.query(
      `UPDATE playback_sessions
          SET state = 'released',
              revision = CASE WHEN revision < 9007199254740991 THEN revision + 1 ELSE revision END,
              updated_at = $3, invalidated_at = $3
        WHERE profile_id = $1 AND session_id = $2 AND state != 'released'`,
      [profileId, sessionId, dateParameter(now, "history session supersededAt")]
    );
    return true;
  }

  async _lockProfile(transaction, profileId) {
    return Boolean(firstRow(await transaction.query(
      "SELECT id FROM profiles WHERE id = $1 FOR UPDATE",
      [profileId]
    )));
  }

  async _expireReservationInTransaction(transaction, grantId, now) {
    const result = await transaction.query(
      `UPDATE history_grants
          SET status = 'revoked', revoked_at = $2, revocation_reason = 'playback'
        WHERE grant_id = $1 AND status = 'reserved'`,
      [grantId, dateParameter(now, "history reservation abandonedAt")]
    );
    return affectedRows(result) === 1;
  }

  _recoverToken(record) {
    return recoverGrantToken(record, this._tokens, this._crypto);
  }
}

module.exports = {
  PLAYBACK_SESSION_TRANSITION_SQL,
  PostgreSQLHistoryGrantRepository: PostgresHistoryGrantRepository,
  PostgresHistoryGrantRepository,
  mapGrantRow,
};
