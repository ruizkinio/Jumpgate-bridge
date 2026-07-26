"use strict";

const crypto = require("node:crypto");
const { types } = require("node:util");

const {
  applyDirectEventSemantics,
  bindCanonicalIdentity,
  mergeAfterConflict,
  nextLastPlayedAt,
  toHistoryDto,
} = require("../history-service");
const {
  attachPreparedHttpResponse,
  decodePreparedHttpResponse,
  encodePreparedHttpResponse,
  preparedHttpResponseEqual,
} = require("../prepared-http-response");
const { ProfileLifecycleCoordinator } = require("./lifecycle-invalidation");
const {
  DEFAULT_RESERVATION_RETENTION_MS,
  DEFAULT_RESERVATION_TTL_MS,
  MAX_RESERVATION_RETENTION_MS,
  MAX_RESERVATION_TTL_MS,
  assertPresentedGrantBinding,
  deriveGrantKind,
  dispatchEventForHistoryEvent,
  historyGrantError,
  isTerminalEvent,
  normalizeAbandonReservationInput,
  normalizeApplyEventInput,
  normalizeCommitClaimResponseInput,
  normalizeFinalizationInput,
  normalizeReleaseInput,
  normalizeReservationDuration,
  normalizeReservationInput,
  prepareHistoryEventResponse,
  publicDispatchIntent,
  publicGrant,
  publicReceipt,
  sameReservation,
  sameSourceAuthority,
  sessionStateForEvent,
  shouldSuppressPeriodicEvent,
} = require("./history-grant");
const { assertPlaybackGeneration } = require("./playback-session");
const {
  assertIdentifier,
  assertMutationFence,
  assertPositiveInteger,
  cloneJson,
  codedError,
  readClock,
  stableScope,
} = require("./repository-utils");

const HISTORY_WRITE_ATTEMPTS = 5;

function attemptKey(profileId, deviceId, attemptId) {
  return [profileId, deviceId, attemptId].join("\0");
}

function sessionKey(profileId, sessionId) {
  return profileId + "\0" + sessionId;
}

function deviceKey(profileId, deviceId, deviceGeneration) {
  return [profileId, deviceId, deviceGeneration].join("\0");
}

function generationKey(profileId, generation) {
  return profileId + "\0" + generation;
}

function sourceKey(value) {
  return [
    value.profileId,
    value.contextId,
    value.playbackGeneration,
    value.providerRevision,
    value.contextRevision,
  ].join("\0");
}

function receiptKey(grantId, idempotencyKey) {
  return grantId + "\0" + idempotencyKey;
}

function tokenPurpose(grantId) {
  return "history-grant-token:" + stableScope("history-grant", grantId).slice(0, 64);
}

function dispatchId(grantId, idempotencyKey) {
  return "hdi_" + crypto
    .createHash("sha256")
    .update("jumpgate-history-dispatch:v1\0", "utf8")
    .update(grantId, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "ascii")
    .digest("base64url");
}

function grantResponse(record, grantToken) {
  const response = { ...publicGrant(record), grantToken };
  if (record.claimResponse) {
    attachPreparedHttpResponse(response, decodePreparedHttpResponse(record.claimResponse));
  }
  return Object.freeze(response);
}

function isRetryableHistoryConflict(error) {
  return Boolean(error && (error.code === "revision_conflict" || error.code === "stale_history"));
}

function normalizeSourceRevocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError("history source revocation is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("history source revocation is invalid");
  }
  const allowed = new Set([
    "profileId",
    "contextId",
    "playbackGeneration",
    "providerRevision",
    "contextRevision",
  ]);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== allowed.size ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  ) {
    throw new TypeError("history source revocation is invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("history source revocation is invalid");
    }
  }
  return Object.freeze({
    profileId: assertIdentifier(value.profileId, "profile id"),
    contextId: assertIdentifier(value.contextId, "source context id"),
    playbackGeneration: assertPlaybackGeneration(value.playbackGeneration),
    providerRevision: assertMutationFence(value.providerRevision, "provider revision"),
    contextRevision: assertMutationFence(value.contextRevision, "source context revision"),
  });
}

class MemoryHistoryGrantRepository {
  constructor(options = {}) {
    if (!options.tokenService) throw new TypeError("tokenService is required");
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    if (!options.historyRepository) throw new TypeError("historyRepository is required");
    if (typeof options.getProfileBinding !== "function") {
      throw new TypeError("getProfileBinding is required");
    }
    if (typeof options.isDeviceBindingActive !== "function") {
      throw new TypeError("isDeviceBindingActive is required");
    }
    if (typeof options.getHistoryGeneration !== "function") {
      throw new TypeError("getHistoryGeneration is required");
    }
    this._tokens = options.tokenService;
    this._crypto = options.envelopeCrypto;
    this._history = options.historyRepository;
    this._playbackSessions = options.playbackSessions || null;
    if (
      this._playbackSessions &&
      typeof this._playbackSessions.invalidateHistoryNow !== "function"
    ) {
      throw new TypeError("playbackSessions must support history invalidation");
    }
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
    const historyCoordinator = this._history._lifecycleCoordinator;
    const playbackCoordinator = this._playbackSessions
      ? this._playbackSessions._lifecycleCoordinator
      : null;
    this._lifecycleCoordinator =
      options.lifecycleCoordinator ||
      historyCoordinator ||
      playbackCoordinator ||
      new ProfileLifecycleCoordinator();
    if (
      !this._lifecycleCoordinator ||
      typeof this._lifecycleCoordinator.run !== "function" ||
      (historyCoordinator && historyCoordinator !== this._lifecycleCoordinator) ||
      (playbackCoordinator && playbackCoordinator !== this._lifecycleCoordinator)
    ) {
      throw new TypeError("history, grants, and playback sessions must share a lifecycle coordinator");
    }
    this._getProfileBinding = options.getProfileBinding;
    this._isDeviceBindingActive = options.isDeviceBindingActive;
    this._getHistoryGeneration = options.getHistoryGeneration;
    this._grantIdFactory = options.grantIdFactory || (() => this._randomId("hgr"));
    this._sessionIdFactory = options.sessionIdFactory || (() => this._randomId("hgs"));
    if (typeof this._grantIdFactory !== "function" || typeof this._sessionIdFactory !== "function") {
      throw new TypeError("history grant id factories are invalid");
    }

    this._grants = new Map();
    this._attempts = new Map();
    this._tokensByHash = new Map();
    this._sessions = new Map();
    this._receipts = new Map();
    this._dispatchIntents = new Map();
    this._revokedProfiles = new Set();
    this._revokedDevices = new Set();
    this._revokedHistories = new Set();
    this._revokedPlaybacks = new Set();
    this._revokedSessions = new Set();
    this._revokedSources = new Set();
    this._supersededSessions = new Map();
  }

  async reserve(input) {
    const candidate = normalizeReservationInput(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      await this._assertBindingCurrent(candidate);
      const key = attemptKey(candidate.profileId, candidate.deviceId, candidate.attemptId);
      const existingId = this._attempts.get(key);
      if (existingId) {
        const existing = this._grants.get(existingId);
        if (!existing || !sameReservation(existing, candidate)) {
          throw historyGrantError(
            "history_claim_conflict",
            "playback claim attempt is already bound to different request bytes"
          );
        }
        if (
          existing.status === "reserved" &&
          existing.reservationExpiresAt <= readClock(this._clock)
        ) {
          this._expireReservation(existing, readClock(this._clock));
          throw historyGrantError("history_grant_stale", "history grant reservation expired");
        }
        await this._assertGrantCurrent(existing);
        if (existing.status !== "reserved" && existing.status !== "active") {
          throw historyGrantError("history_grant_stale", "history grant is no longer current");
        }
        return grantResponse(existing, this._recoverToken(existing));
      }

      const grantId = this._uniqueId(this._grantIdFactory, this._grants, "history grant id");
      const sessionId = this._uniqueId(
        this._sessionIdFactory,
        this._sessions,
        "history session id",
        candidate.profileId
      );
      const issued = this._tokens.issue("history-grant", 32);
      const grantToken = "hg1_" + issued.token;
      const tokenHash = this._tokens.hashToken("history-grant", grantToken);
      if (this._tokensByHash.has(tokenHash)) {
        throw new Error("history grant token collision");
      }
      const now = readClock(this._clock);
      const record = {
        ...candidate,
        grantId,
        sessionId,
        tokenHash,
        tokenEnvelope: this._crypto.encryptJson({ token: grantToken }, tokenPurpose(grantId)),
        status: "reserved",
        kind: null,
        claimStatus: null,
        authority: null,
        sessionState: null,
        sessionRevision: null,
        terminalReceiptId: null,
        claimResponse: null,
        createdAt: now,
        reservationExpiresAt: now + this._reservationTtlMs,
        finalizedAt: null,
        releasedAt: null,
        revokedAt: null,
        supersededAt: null,
        revocationReason: null,
      };
      this._grants.set(grantId, record);
      this._attempts.set(key, grantId);
      this._tokensByHash.set(tokenHash, grantId);
      this._sessions.set(sessionKey(candidate.profileId, sessionId), grantId);
      return grantResponse(record, grantToken);
    });
  }

  async abandon(input) {
    const candidate = normalizeAbandonReservationInput(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      const record = this._grants.get(candidate.grantId);
      if (!record) return false;
      if (!sameReservation(record, candidate)) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim abandonment does not match reserved request bytes"
        );
      }
      if (record.status !== "reserved") return false;
      await this._assertBindingCurrent(candidate);
      this._expireReservation(record, readClock(this._clock));
      return true;
    });
  }

  async commitClaimResponse(input) {
    const candidate = normalizeCommitClaimResponseInput(input);
    const initial = this._grants.get(candidate.grantId);
    if (!initial) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
    return this._lifecycleCoordinator.run(initial.profileId, async () => {
      const record = this._grants.get(candidate.grantId);
      if (!record) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
      if (record.requestDigest !== candidate.requestDigest) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim response does not match reserved request bytes"
        );
      }
      await this._assertGrantCurrent(record);
      if (record.status !== "active" && record.status !== "released") {
        throw historyGrantError("history_grant_stale", "history grant is not active");
      }
      if (record.claimResponse) {
        const stored = decodePreparedHttpResponse(record.claimResponse);
        if (!preparedHttpResponseEqual(stored, candidate.preparedResponse)) {
          throw historyGrantError(
            "history_claim_conflict",
            "playback claim response bytes changed during retry"
          );
        }
        return stored;
      }
      record.claimResponse = encodePreparedHttpResponse(candidate.preparedResponse);
      return decodePreparedHttpResponse(record.claimResponse);
    });
  }

  async finalize(input) {
    const candidate = normalizeFinalizationInput(input);
    const initial = this._grants.get(candidate.grantId);
    if (!initial) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
    return this._lifecycleCoordinator.run(initial.profileId, async () => {
      const record = this._grants.get(candidate.grantId);
      if (!record) throw historyGrantError("history_grant_invalid", "history grant is invalid", 404);
      if (record.requestDigest !== candidate.requestDigest) {
        throw historyGrantError(
          "history_claim_conflict",
          "playback claim finalization does not match reserved request bytes"
        );
      }
      this._assertAuthorityBinding(record, candidate.authority);
      await this._assertGrantCurrent(record);
      this._assertAuthorityNotRevoked(candidate.authority);

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

      const kind = deriveGrantKind(candidate.authority);
      record.authority = candidate.authority;
      record.kind = kind;
      record.claimStatus = candidate.authority.claimStatus;
      record.status = "active";
      record.sessionState = "playing";
      record.sessionRevision = 1;
      record.finalizedAt = readClock(this._clock);
      if (candidate.authority.supersededSessionId) {
        this._supersedeNow(
          candidate.authority.profileId,
          candidate.authority.deviceId,
          candidate.authority.supersededSessionId,
          candidate.authority.sessionId
        );
      }
      return grantResponse(record, this._recoverToken(record));
    });
  }

  async applyEvent(input) {
    const candidate = normalizeApplyEventInput(input);
    const tokenHash = this._hashPresentedToken(candidate.grantToken);
    const initialId = this._tokensByHash.get(tokenHash);
    const initial = initialId ? this._grants.get(initialId) : null;
    if (!initial) throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
    assertPresentedGrantBinding(initial, candidate);

    return this._lifecycleCoordinator.run(initial.profileId, async () => {
      const grantId = this._tokensByHash.get(tokenHash);
      const record = grantId ? this._grants.get(grantId) : null;
      if (!record || record.tokenHash !== tokenHash) {
        throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
      }
      assertPresentedGrantBinding(record, candidate);

      // Authority is always checked before looking at receipts. A revoked grant
      // must not become usable merely because the request was once successful.
      await this._assertGrantCurrent(record);
      const key = receiptKey(record.grantId, candidate.idempotencyKey);
      const existingReceipt = this._receipts.get(key);

      if (record.status === "released") {
        if (
          existingReceipt &&
          record.terminalReceiptId === candidate.idempotencyKey &&
          existingReceipt.requestDigest === candidate.requestDigest
        ) {
          return publicReceipt(existingReceipt);
        }
        if (existingReceipt && existingReceipt.requestDigest !== candidate.requestDigest) {
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

      if (existingReceipt) {
        if (existingReceipt.requestDigest !== candidate.requestDigest) {
          throw historyGrantError(
            "history_event_idempotency_conflict",
            "Idempotency-Key is already bound to different event bytes"
          );
        }
        return publicReceipt(existingReceipt);
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
        : this._nextSessionRevision(record.sessionRevision);
      const history = suppressed || record.kind === "negative"
        ? null
        : await this._applyHistory(record, candidate.event);
      const now = readClock(this._clock);
      const intent = !suppressed && record.kind === "canonical"
        ? this._createDispatchIntent(record, candidate, nextRevision, now)
        : null;

      if (!suppressed) {
        record.sessionState = targetState;
        record.sessionRevision = nextRevision;
      }
      if (!suppressed && targetState === "released") {
        record.status = "released";
        record.releasedAt = now;
        record.terminalReceiptId = candidate.idempotencyKey;
      }

      const response = Object.freeze({
        ok: true,
        status: suppressed
          ? "suppressed"
          : record.kind === "negative"
            ? "local_only"
            : "applied",
        grantKind: record.kind,
        event: candidate.event.event,
        sessionId: record.sessionId,
        sessionState: record.sessionState,
        sessionRevision: record.sessionRevision,
        history,
        dispatchIntent: intent,
      });
      const receipt = {
        grantId: record.grantId,
        idempotencyKey: candidate.idempotencyKey,
        requestDigest: candidate.requestDigest,
        event: candidate.event.event,
        terminal: isTerminalEvent(candidate.event.event),
        response: cloneJson(response),
        preparedResponse: encodePreparedHttpResponse(prepareHistoryEventResponse(response)),
        createdAt: now,
      };
      this._receipts.set(key, receipt);
      return publicReceipt(receipt);
    });
  }

  async release(input) {
    const candidate = normalizeReleaseInput(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      const record = this._grantForSession(candidate.profileId, candidate.sessionId);
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
      await this._assertGrantCurrent(record);
      const receipt = this._receipts.get(
        receiptKey(record.grantId, candidate.terminalReceiptId)
      );
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

  async revokeProfile(profileId, profileRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const revision = assertPositiveInteger(
      profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    );
    return this._lifecycleCoordinator.run(id, async () => {
      this._revokedProfiles.add(generationKey(id, revision));
      return this._revokeMatching(
        (record) => record.profileId === id && record.profileRevision === revision,
        "profile"
      );
    });
  }

  async revokeDevice(profileId, deviceId, deviceGeneration) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedDeviceId = assertIdentifier(deviceId, "device id");
    const generation = assertPositiveInteger(
      deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    return this._lifecycleCoordinator.run(scopedProfileId, async () => {
      this._revokedDevices.add(deviceKey(scopedProfileId, scopedDeviceId, generation));
      return this._revokeMatching(
        (record) =>
          record.profileId === scopedProfileId &&
          record.deviceId === scopedDeviceId &&
          record.deviceGeneration === generation,
        "device"
      );
    });
  }

  async revokeHistory(profileId, historyGeneration) {
    const id = assertIdentifier(profileId, "profile id");
    const generation = assertPositiveInteger(
      historyGeneration,
      "history generation",
      Number.MAX_SAFE_INTEGER
    );
    return this._lifecycleCoordinator.run(id, async () => {
      this._revokedHistories.add(generationKey(id, generation));
      return this._revokeMatching(
        (record) => record.profileId === id && record.historyGeneration === generation,
        "history"
      );
    });
  }

  async clearHistory(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    if (!this._playbackSessions) {
      throw new TypeError("playbackSessions are required for atomic history clear");
    }
    return this._lifecycleCoordinator.run(id, async () => {
      const generation = await this._getHistoryGeneration(id);
      if (generation === null) {
        throw codedError("profile_inactive", "profile is missing or inactive");
      }
      assertPositiveInteger(generation, "history generation", Number.MAX_SAFE_INTEGER);
      if (generation >= Number.MAX_SAFE_INTEGER) {
        throw codedError("history_generation_exhausted", "history generation exhausted");
      }
      const historySnapshot = this._history.snapshotProfileNow(id);
      const grantSnapshot = this._snapshotProfileNow(id);
      const playbackSnapshot = this._playbackSessions.snapshotProfileNow(id);
      try {
        this._history.deleteProfileEntriesNow(id);
        this._revokedHistories.add(generationKey(id, generation));
        const revokedGrants = this._revokeMatching(
          (record) => record.profileId === id && record.historyGeneration === generation,
          "history"
        );
        const releasedSessions = this._playbackSessions.invalidateHistoryNow(id, generation);
        const result = Object.freeze({
          previousGeneration: generation,
          historyGeneration: generation + 1,
          revokedGrants,
          releasedSessions,
        });

        // Profile generation is the commit point. No fallible work follows it.
        await this._history.advanceGenerationNow(id, generation);
        return result;
      } catch (error) {
        this._playbackSessions.restoreProfileNow(id, playbackSnapshot);
        this._restoreProfileNow(id, grantSnapshot);
        this._history.restoreProfileNow(id, historySnapshot);
        throw error;
      }
    });
  }

  async revokePlayback(profileId, playbackGeneration) {
    const id = assertIdentifier(profileId, "profile id");
    const generation = assertPlaybackGeneration(playbackGeneration);
    return this._lifecycleCoordinator.run(id, async () => {
      this._revokedPlaybacks.add(generationKey(id, generation));
      return this._revokeMatching(
        (record) => record.profileId === id && record.playbackGeneration === generation,
        "playback"
      );
    });
  }

  async revokeSession(profileId, sessionId) {
    const id = assertIdentifier(profileId, "profile id");
    const scopedSessionId = assertIdentifier(sessionId, "history session id");
    return this._lifecycleCoordinator.run(id, async () => {
      this._revokedSessions.add(sessionKey(id, scopedSessionId));
      return this._revokeMatching(
        (record) => record.profileId === id && record.sessionId === scopedSessionId,
        "session"
      );
    });
  }

  async revokeSource(input) {
    const candidate = normalizeSourceRevocation(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      this._revokedSources.add(sourceKey(candidate));
      return this._revokeMatching(
        (record) => record.authority && sourceKey(record.authority) === sourceKey(candidate),
        "source"
      );
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
    return this._lifecycleCoordinator.run(scopedProfileId, async () =>
      this._supersedeNow(
        scopedProfileId,
        scopedDeviceId,
        scopedSessionId,
        replacement
      )
    );
  }

  async getGrantBySession(profileId, sessionId) {
    return publicGrant(this._grantForSession(
      assertIdentifier(profileId, "profile id"),
      assertIdentifier(sessionId, "history session id")
    ));
  }

  async prune() {
    const now = readClock(this._clock);
    let expiredReservations = 0;
    let prunedReservations = 0;
    for (const record of Array.from(this._grants.values())) {
      if (record.kind !== null) continue;
      if (record.status === "reserved" && record.reservationExpiresAt <= now) {
        this._expireReservation(record, now);
        expiredReservations += 1;
      }
      if (
        record.status === "revoked" &&
        record.reservationExpiresAt + this._reservationRetentionMs <= now
      ) {
        this._deleteGrantNow(record);
        prunedReservations += 1;
      }
    }
    return Object.freeze({ expiredReservations, prunedReservations });
  }

  async listDispatchIntents(profileId, sessionId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedSessionId = assertIdentifier(sessionId, "history session id");
    return Array.from(this._dispatchIntents.values())
      .filter(
        (record) =>
          record.profileId === scopedProfileId && record.sessionId === scopedSessionId
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map(publicDispatchIntent);
  }

  _snapshotProfileNow(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const grants = Array.from(this._grants, ([key, record]) => [key, cloneJson(record)])
      .filter(([, record]) => record.profileId === id);
    const grantIds = new Set(grants.map(([grantId]) => grantId));
    const scopedSet = (set) => Array.from(set).filter((key) => key.startsWith(id + "\0"));
    return {
      grants,
      attempts: Array.from(this._attempts).filter(([, grantId]) => grantIds.has(grantId)),
      tokensByHash: Array.from(this._tokensByHash).filter(([, grantId]) => grantIds.has(grantId)),
      sessions: Array.from(this._sessions).filter(([, grantId]) => grantIds.has(grantId)),
      receipts: Array.from(this._receipts, ([key, record]) => [key, cloneJson(record)])
        .filter(([, record]) => grantIds.has(record.grantId)),
      dispatchIntents: Array.from(
        this._dispatchIntents,
        ([key, record]) => [key, cloneJson(record)]
      ).filter(([, record]) => grantIds.has(record.grantId)),
      revokedProfiles: scopedSet(this._revokedProfiles),
      revokedDevices: scopedSet(this._revokedDevices),
      revokedHistories: scopedSet(this._revokedHistories),
      revokedPlaybacks: scopedSet(this._revokedPlaybacks),
      revokedSessions: scopedSet(this._revokedSessions),
      revokedSources: scopedSet(this._revokedSources),
      supersededSessions: Array.from(this._supersededSessions)
        .filter(([key]) => key.startsWith(id + "\0")),
    };
  }

  _restoreProfileNow(profileId, snapshot) {
    const id = assertIdentifier(profileId, "profile id");
    this.eraseProfileNow(id);
    for (const [key, record] of snapshot.grants) this._grants.set(key, cloneJson(record));
    for (const [key, grantId] of snapshot.attempts) this._attempts.set(key, grantId);
    for (const [key, grantId] of snapshot.tokensByHash) this._tokensByHash.set(key, grantId);
    for (const [key, grantId] of snapshot.sessions) this._sessions.set(key, grantId);
    for (const [key, record] of snapshot.receipts) this._receipts.set(key, cloneJson(record));
    for (const [key, record] of snapshot.dispatchIntents) {
      this._dispatchIntents.set(key, cloneJson(record));
    }
    for (const key of snapshot.revokedProfiles) this._revokedProfiles.add(key);
    for (const key of snapshot.revokedDevices) this._revokedDevices.add(key);
    for (const key of snapshot.revokedHistories) this._revokedHistories.add(key);
    for (const key of snapshot.revokedPlaybacks) this._revokedPlaybacks.add(key);
    for (const key of snapshot.revokedSessions) this._revokedSessions.add(key);
    for (const key of snapshot.revokedSources) this._revokedSources.add(key);
    for (const [key, replacement] of snapshot.supersededSessions) {
      this._supersededSessions.set(key, replacement);
    }
  }

  eraseProfileNow(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const grantIds = new Set();
    for (const [grantId, record] of this._grants) {
      if (record.profileId !== id) continue;
      grantIds.add(grantId);
      this._grants.delete(grantId);
      this._tokensByHash.delete(record.tokenHash);
    }
    for (const [key, grantId] of this._attempts) {
      if (grantIds.has(grantId)) this._attempts.delete(key);
    }
    for (const [key, grantId] of this._sessions) {
      if (grantIds.has(grantId)) this._sessions.delete(key);
    }
    for (const [key, receipt] of this._receipts) {
      if (grantIds.has(receipt.grantId)) this._receipts.delete(key);
    }
    for (const [key, intent] of this._dispatchIntents) {
      if (grantIds.has(intent.grantId)) this._dispatchIntents.delete(key);
    }
    this._deleteScoped(this._revokedProfiles, id);
    this._deleteScoped(this._revokedDevices, id);
    this._deleteScoped(this._revokedHistories, id);
    this._deleteScoped(this._revokedPlaybacks, id);
    this._deleteScoped(this._revokedSessions, id);
    this._deleteScoped(this._revokedSources, id);
    for (const key of this._supersededSessions.keys()) {
      if (key.startsWith(id + "\0")) this._supersededSessions.delete(key);
    }
  }

  storageSnapshot() {
    return {
      grants: Array.from(this._grants.values(), (record) => ({
        ...cloneJson(record),
        authority: cloneJson(record.authority),
      })),
      receipts: Array.from(this._receipts.values(), (record) => cloneJson(record)),
      dispatchIntents: Array.from(this._dispatchIntents.values(), (record) => cloneJson(record)),
    };
  }

  // Compatibility names match the lifecycle repositories used elsewhere.
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

  async _assertBindingCurrent(binding) {
    const profile = await this._getProfileBinding(binding.profileId);
    if (
      !profile ||
      profile.status !== "active" ||
      profile.revision !== binding.profileRevision ||
      this._revokedProfiles.has(generationKey(binding.profileId, binding.profileRevision))
    ) {
      throw historyGrantError("history_grant_stale", "history grant profile binding is stale");
    }
    if (
      this._revokedDevices.has(
        deviceKey(binding.profileId, binding.deviceId, binding.deviceGeneration)
      ) ||
      !(await this._isDeviceBindingActive(
        binding.profileId,
        binding.deviceId,
        binding.deviceGeneration
      ))
    ) {
      throw historyGrantError("history_grant_stale", "history grant device binding is stale");
    }
    const historyGeneration = await this._getHistoryGeneration(binding.profileId);
    if (
      historyGeneration !== binding.historyGeneration ||
      this._revokedHistories.has(
        generationKey(binding.profileId, binding.historyGeneration)
      )
    ) {
      throw historyGrantError("history_grant_stale", "history grant history binding is stale");
    }
    if (
      this._revokedPlaybacks.has(
        generationKey(binding.profileId, binding.playbackGeneration)
      )
    ) {
      throw historyGrantError("history_grant_stale", "history grant playback binding is stale");
    }
  }

  async _assertGrantCurrent(record) {
    if (record.status === "revoked" || record.status === "superseded") {
      throw historyGrantError("history_grant_stale", "history grant is no longer current");
    }
    await this._assertBindingCurrent(record);
    const scopedSessionKey = sessionKey(record.profileId, record.sessionId);
    if (
      this._revokedSessions.has(scopedSessionKey) ||
      this._supersededSessions.has(scopedSessionKey)
    ) {
      throw historyGrantError("history_grant_stale", "history grant session is stale");
    }
    if (record.authority && this._revokedSources.has(sourceKey(record.authority))) {
      throw historyGrantError("history_grant_stale", "history grant source is stale");
    }
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

  _assertAuthorityNotRevoked(authority) {
    if (
      this._revokedSessions.has(sessionKey(authority.profileId, authority.sessionId)) ||
      this._supersededSessions.has(sessionKey(authority.profileId, authority.sessionId)) ||
      (authority.contextId && this._revokedSources.has(sourceKey(authority)))
    ) {
      throw historyGrantError("history_grant_stale", "source authority was revoked");
    }
  }

  async _applyHistory(record, event) {
    if (!record.authority.contentKey) return null;
    const input = {
      canonicalIdentity: cloneJson(record.authority.canonicalIdentity),
      displaySnapshot: cloneJson(record.authority.displaySnapshot),
      playbackSnapshot: cloneJson(event.playbackPreferences),
      positionMs: event.positionMs,
      durationMs: event.durationMs,
      watchedMs: event.watchedMs,
      completed: event.event === "completion",
    };

    for (let attempt = 0; attempt < HISTORY_WRITE_ATTEMPTS; attempt += 1) {
      await this._assertGrantCurrent(record);
      const writeState = await this._history.getForWrite(
        record.profileId,
        record.authority.contentKey
      );
      const current = writeState && writeState.deletedAt === null ? writeState : null;
      const bound = bindCanonicalIdentity(input, current);
      const direct = applyDirectEventSemantics(bound, current);
      const effective = mergeAfterConflict(direct, current);
      const entry = {
        contentKey: record.authority.contentKey,
        ...effective,
        lastPlayedAt: nextLastPlayedAt(this._clock, writeState),
      };
      try {
        const stored = await this._history.upsertNow(
          record.profileId,
          entry,
          writeState ? writeState.revision : 0,
          {
            generation: record.historyGeneration,
            deviceId: record.deviceId,
            deviceGeneration: record.deviceGeneration,
          }
        );
        return toHistoryDto(stored);
      } catch (error) {
        if (!isRetryableHistoryConflict(error) || attempt + 1 >= HISTORY_WRITE_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw codedError("history_conflict", "history changed too many times");
  }

  _createDispatchIntent(record, candidate, sessionRevision, now) {
    const id = dispatchId(record.grantId, candidate.idempotencyKey);
    const existing = this._dispatchIntents.get(id);
    if (existing) {
      throw historyGrantError(
        "history_event_idempotency_conflict",
        "history dispatch intent already exists without a receipt"
      );
    }
    const progress = candidate.event.event === "completion"
      ? 100
      : candidate.event.durationMs === 0
        ? 0
        : Number(((candidate.event.positionMs / candidate.event.durationMs) * 100).toFixed(3));
    const intent = {
      id,
      grantId: record.grantId,
      profileId: record.profileId,
      profileRevision: record.profileRevision,
      deviceId: record.deviceId,
      deviceGeneration: record.deviceGeneration,
      historyGeneration: record.historyGeneration,
      sessionId: record.sessionId,
      sessionRevision,
      contextId: record.authority.contextId,
      contextRevision: record.authority.contextRevision,
      playbackGeneration: record.playbackGeneration,
      providerRevision: record.authority.providerRevision,
      event: dispatchEventForHistoryEvent(candidate.event.event),
      progress,
      canonicalIdentity: cloneJson(record.authority.canonicalIdentity),
      status: "queued",
      createdAt: now,
      revokedAt: null,
    };
    this._dispatchIntents.set(id, intent);
    return publicDispatchIntent(intent);
  }

  _hashPresentedToken(token) {
    try {
      return this._tokens.hashToken("history-grant", token);
    } catch (_error) {
      throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
    }
  }

  _recoverToken(record) {
    let authority;
    let recoveredHash;
    try {
      authority = this._crypto.decryptJson(record.tokenEnvelope, tokenPurpose(record.grantId));
      if (
        !authority ||
        typeof authority !== "object" ||
        Array.isArray(authority) ||
        Object.keys(authority).length !== 1 ||
        typeof authority.token !== "string"
      ) {
        throw new Error("history grant token authority is malformed");
      }
      recoveredHash = this._tokens.hashToken("history-grant", authority.token);
    } catch (_error) {
      throw historyGrantError(
        "history_grant_authority_unavailable",
        "history grant retry authority is unavailable",
        503
      );
    }
    if (
      recoveredHash !== record.tokenHash
    ) {
      throw historyGrantError(
        "history_grant_authority_unavailable",
        "history grant retry authority is invalid",
        503
      );
    }
    return authority.token;
  }

  _grantForSession(profileId, sessionId) {
    const grantId = this._sessions.get(sessionKey(profileId, sessionId));
    return grantId ? this._grants.get(grantId) || null : null;
  }

  _nextSessionRevision(current) {
    if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
      throw historyGrantError(
        "history_session_revision_exhausted",
        "history session revision is exhausted"
      );
    }
    return current + 1;
  }

  _supersedeNow(profileId, deviceId, sessionId, replacementSessionId) {
    const key = sessionKey(profileId, sessionId);
    const existingReplacement = this._supersededSessions.get(key);
    if (existingReplacement) {
      if (existingReplacement !== replacementSessionId) {
        throw historyGrantError(
          "history_supersession_conflict",
          "history session has a different replacement"
        );
      }
      return false;
    }
    const record = this._grantForSession(profileId, sessionId);
    if (record && record.deviceId !== deviceId) {
      throw historyGrantError(
        "history_supersession_conflict",
        "history session belongs to another device"
      );
    }
    this._supersededSessions.set(key, replacementSessionId);
    if (!record) return false;
    const now = readClock(this._clock);
    record.status = "superseded";
    record.supersededAt = now;
    record.revocationReason = "supersession";
    this._revokeDispatchIntents(record.grantId, now);
    return true;
  }

  _revokeMatching(predicate, reason) {
    const now = readClock(this._clock);
    let revoked = 0;
    for (const record of this._grants.values()) {
      if (!predicate(record)) continue;
      if (record.status !== "revoked") revoked += 1;
      record.status = "revoked";
      record.revokedAt = now;
      record.revocationReason = reason;
      this._revokeDispatchIntents(record.grantId, now);
    }
    return revoked;
  }

  _revokeDispatchIntents(grantId, now) {
    for (const intent of this._dispatchIntents.values()) {
      if (intent.grantId !== grantId || intent.status !== "queued") continue;
      intent.status = "revoked";
      intent.revokedAt = now;
    }
  }

  _expireReservation(record, now) {
    if (!record || record.status !== "reserved") return false;
    record.status = "revoked";
    record.revokedAt = now;
    record.revocationReason = "playback";
    return true;
  }

  _deleteGrantNow(record) {
    if (!record || !this._grants.has(record.grantId)) return false;
    this._grants.delete(record.grantId);
    this._tokensByHash.delete(record.tokenHash);
    for (const [key, grantId] of this._attempts) {
      if (grantId === record.grantId) this._attempts.delete(key);
    }
    for (const [key, grantId] of this._sessions) {
      if (grantId === record.grantId) this._sessions.delete(key);
    }
    for (const [key, receipt] of this._receipts) {
      if (receipt.grantId === record.grantId) this._receipts.delete(key);
    }
    for (const [key, intent] of this._dispatchIntents) {
      if (intent.grantId === record.grantId) this._dispatchIntents.delete(key);
    }
    return true;
  }

  _uniqueId(factory, index, name, profileId = null) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = assertIdentifier(factory(), name);
      const key = profileId === null ? id : sessionKey(profileId, id);
      if (!index.has(key)) return id;
    }
    throw new Error(name + " factory produced repeated collisions");
  }

  _randomId(prefix) {
    return prefix + "_" + crypto.randomBytes(24).toString("base64url");
  }

  _deleteScoped(set, profileId) {
    for (const key of set) {
      if (key.startsWith(profileId + "\0")) set.delete(key);
    }
  }
}

module.exports = {
  HISTORY_WRITE_ATTEMPTS,
  MemoryHistoryGrantRepository,
};
