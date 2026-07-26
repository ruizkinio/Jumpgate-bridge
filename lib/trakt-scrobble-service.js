"use strict";

const crypto = require("node:crypto");

const EVENT_ACTIONS = Object.freeze({
  completion: "stop",
  pause: "pause",
  resume: "start",
  start: "start",
  stop: "stop",
});
const INPUT_KEYS = new Set([
  "backgrounded",
  "contextId",
  "dispatchId",
  "event",
  "paused",
  "progress",
  "sessionId",
  "sessionRevision",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PLAYBACK_GENERATION_PATTERN = /^g1:[A-Za-z0-9_-]{1,128}$/;
const IMDB_ID_PATTERN = /^tt\d{7,}$/;
const NUMERIC_ID_PATTERN = /^[1-9]\d{0,15}$/;
const DURABLE_STALE_CODES = new Set([
  "playback_device_stale",
  "playback_profile_stale",
  "playback_session_released",
  "playback_session_stale",
  "playback_source_revoked",
  "scrobble_dispatch_revoked",
]);
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_WORKER_BATCH_SIZE = 32;

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidRequest() {
  return codedError("invalid_scrobble_request", "Trakt scrobble request is invalid");
}

function staleClaim() {
  return codedError("scrobble_claim_stale", "Trakt scrobble claim is not active");
}

function traktUnavailable() {
  return codedError("trakt_scrobble_unavailable", "Trakt scrobble is temporarily unavailable");
}

function reauthorizationRequired() {
  return codedError("trakt_reauthorization_required", "Trakt reauthorization is required");
}

function assertPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRequest();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidRequest();
  return value;
}

function assertIdentifier(value) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) throw invalidRequest();
  return value;
}

function assertPositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidRequest();
  return value;
}

function validateBinding(binding) {
  const value = assertPlainObject(binding);
  if (
    !Number.isSafeInteger(value.profileRevision) ||
    value.profileRevision < 1 ||
    !Number.isSafeInteger(value.deviceGeneration) ||
    value.deviceGeneration < 1 ||
    typeof value.playbackGeneration !== "string" ||
    !PLAYBACK_GENERATION_PATTERN.test(value.playbackGeneration)
  ) {
    throw invalidRequest();
  }
  return Object.freeze({
    profileId: assertIdentifier(value.profileId),
    profileRevision: value.profileRevision,
    deviceId: assertIdentifier(value.deviceId),
    deviceGeneration: value.deviceGeneration,
    playbackGeneration: value.playbackGeneration,
  });
}

function validateInput(input) {
  const value = assertPlainObject(input);
  for (const key of Object.keys(value)) {
    if (!INPUT_KEYS.has(key)) throw invalidRequest();
  }
  if (!Object.prototype.hasOwnProperty.call(EVENT_ACTIONS, value.event)) throw invalidRequest();
  if (
    typeof value.progress !== "number" ||
    !Number.isFinite(value.progress) ||
    value.progress < 0 ||
    value.progress > 100 ||
    typeof value.paused !== "boolean" ||
    typeof value.backgrounded !== "boolean"
  ) {
    throw invalidRequest();
  }
  if (value.event === "pause" && !value.paused && !value.backgrounded) throw invalidRequest();
  return Object.freeze({
    sessionId: assertIdentifier(value.sessionId),
    contextId: assertIdentifier(value.contextId),
    event: value.event,
    progress: value.progress,
    paused: value.paused,
    backgrounded: value.backgrounded,
    dispatchId: value.dispatchId === undefined ? null : assertIdentifier(value.dispatchId),
    sessionRevision:
      value.sessionRevision === undefined ? null : assertPositiveInteger(value.sessionRevision),
  });
}

function canonicalIds(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const provider = identity.provider;
  const id = identity.id;
  if (provider === "imdb" && typeof id === "string" && IMDB_ID_PATTERN.test(id)) {
    return { imdb: id };
  }
  if (
    (provider === "tmdb" || provider === "tvdb" || provider === "trakt") &&
    typeof id === "string" &&
    NUMERIC_ID_PATTERN.test(id)
  ) {
    const numericId = Number(id);
    if (Number.isSafeInteger(numericId)) return { [provider]: numericId };
  }
  return null;
}

function canonicalPayload(identity, progress, event) {
  const ids = canonicalIds(identity);
  if (!ids || identity.confidence !== "canonical") return null;
  const payloadProgress = event === "completion" ? 100 : progress;
  if (identity.mediaType === "movie") {
    return { movie: { ids }, progress: payloadProgress };
  }
  if (
    identity.mediaType === "episode" &&
    Number.isSafeInteger(identity.season) &&
    identity.season >= 0 &&
    Number.isSafeInteger(identity.episode) &&
    identity.episode >= 0
  ) {
    return {
      episode: { season: identity.season, number: identity.episode, ids },
      progress: payloadProgress,
    };
  }
  return null;
}

function sameActiveClaim(claim, binding, input) {
  if (
    !claim ||
    claim.status !== "claimed" ||
    claim.sessionId !== input.sessionId ||
    !claim.context ||
    claim.context.profileId !== binding.profileId ||
    claim.context.contextId !== input.contextId ||
    !claim.deliveryBinding
  ) {
    return false;
  }
  const authority = claim.deliveryBinding;
  return (
    authority.profileId === binding.profileId &&
    authority.deviceId === binding.deviceId &&
    authority.sessionId === input.sessionId &&
    authority.generation === binding.playbackGeneration &&
    authority.contextId === input.contextId
  );
}

function sameDurableBinding(session, binding, input, claim) {
  return Boolean(
    session &&
    session.profileId === binding.profileId &&
    session.profileRevision === binding.profileRevision &&
    session.deviceId === binding.deviceId &&
    session.deviceGeneration === binding.deviceGeneration &&
    session.sessionId === input.sessionId &&
    session.contextId === input.contextId &&
    session.playbackGeneration === binding.playbackGeneration &&
    claim &&
    claim.deliveryBinding &&
    session.contextRevision === claim.deliveryBinding.contextRevision
  );
}

function sessionMutationInput(session, expectedRevision = session.revision) {
  return {
    profileId: session.profileId,
    profileRevision: session.profileRevision,
    deviceId: session.deviceId,
    deviceGeneration: session.deviceGeneration,
    sessionId: session.sessionId,
    contextId: session.contextId,
    playbackGeneration: session.playbackGeneration,
    contextRevision: session.contextRevision,
    expectedRevision,
  };
}

function validatePositiveOption(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(name + " is invalid");
  }
  return result;
}

function isCredential(value) {
  return Boolean(value && typeof value.access_token === "string" && value.access_token);
}

class TraktScrobbleService {
  constructor(options = {}) {
    if (
      !options.playbackContexts ||
      typeof options.playbackContexts.getActiveClaim !== "function"
    ) {
      throw new TypeError("playback-context authority is required");
    }
    if (typeof options.getCredential !== "function") {
      throw new TypeError("Trakt credential resolver is required");
    }
    if (typeof options.dispatch !== "function") {
      throw new TypeError("Trakt scrobble dispatcher is required");
    }
    this._playbackContexts = options.playbackContexts;
    this._getCredential = options.getCredential;
    this._dispatch = options.dispatch;
    this._playbackSessions = options.playbackSessions || null;
    this._legacyAdmit = options.admit;
    if (!this._playbackSessions && typeof this._legacyAdmit !== "function") {
      throw new TypeError("Trakt scrobble admission is required");
    }
    if (this._playbackSessions) {
      for (const method of [
        "openSession",
        "getSession",
        "transitionAndEnqueue",
        "claimDispatch",
        "withDispatchAdmission",
        "retryDispatch",
        "invalidateSession",
        "invalidateSourceClaim",
        "listDispatches",
      ]) {
        if (typeof this._playbackSessions[method] !== "function") {
          throw new TypeError("playbackSessions." + method + " is required");
        }
      }
    }

    this._clock = options.clock || Date.now;
    this._leaseMs = validatePositiveOption(options.leaseMs, DEFAULT_LEASE_MS, "leaseMs", 600_000);
    this._retryBaseMs = validatePositiveOption(
      options.retryBaseMs,
      DEFAULT_RETRY_BASE_MS,
      "retryBaseMs"
    );
    this._retryMaxMs = validatePositiveOption(
      options.retryMaxMs,
      DEFAULT_RETRY_MAX_MS,
      "retryMaxMs"
    );
    if (this._retryMaxMs < this._retryBaseMs) {
      throw new TypeError("Trakt retry policy is invalid");
    }
    this._workerIntervalMs = validatePositiveOption(
      options.workerIntervalMs,
      DEFAULT_WORKER_INTERVAL_MS,
      "workerIntervalMs"
    );
    this._workerBatchSize = validatePositiveOption(
      options.workerBatchSize,
      DEFAULT_WORKER_BATCH_SIZE,
      "workerBatchSize",
      1024
    );
    this._workerId = options.workerId || "trakt_worker_" + crypto.randomBytes(18).toString("base64url");
    assertIdentifier(this._workerId);
    this._idFactory = options.idFactory || ((identity) =>
      "dispatch_" + crypto
        .createHash("sha256")
        .update(JSON.stringify(identity), "utf8")
        .digest("base64url"));
    if (typeof this._idFactory !== "function") throw new TypeError("idFactory is invalid");
    this._dispatchInline = options.dispatchInline !== false;
    this._onWorkerError = typeof options.onWorkerError === "function" ? options.onWorkerError : null;
    this._timer = null;
    this._activeWorkerPass = null;
    if (options.autoStart === true) this.start();
  }

  async bindClaim(binding, claim) {
    if (!this._playbackSessions) throw new TypeError("durable playback sessions are required");
    const scopedBinding = validateBinding(binding);
    const candidate = claim && claim.context
      ? { sessionId: claim.sessionId, contextId: claim.context.contextId }
      : {};
    if (!sameActiveClaim(claim, scopedBinding, candidate)) throw staleClaim();
    const authority = claim.deliveryBinding;
    if (typeof authority.contextRevision !== "string" || !authority.contextRevision) {
      throw staleClaim();
    }

    if (
      typeof authority.supersededSessionId === "string" &&
      authority.supersededSessionId !== claim.sessionId
    ) {
      await this._releaseExactSession(scopedBinding, authority.supersededSessionId, {
        revokeSource: false,
      });
    }

    try {
      return await this._playbackSessions.openSession({
        profileId: scopedBinding.profileId,
        profileRevision: scopedBinding.profileRevision,
        deviceId: scopedBinding.deviceId,
        deviceGeneration: scopedBinding.deviceGeneration,
        sessionId: assertIdentifier(claim.sessionId),
        contextId: assertIdentifier(claim.context.contextId),
        playbackGeneration: scopedBinding.playbackGeneration,
        contextRevision: authority.contextRevision,
        state: "playing",
      });
    } catch (error) {
      throw this._mapDurableError(error);
    }
  }

  async releaseSession(binding, sessionId) {
    if (!this._playbackSessions) throw new TypeError("durable playback sessions are required");
    const scopedBinding = validateBinding(binding);
    return this._releaseExactSession(scopedBinding, assertIdentifier(sessionId));
  }

  async scrobble(binding, request) {
    const scopedBinding = validateBinding(binding);
    const input = validateInput(request);
    if (this._playbackSessions) return this._scrobbleDurable(scopedBinding, input);
    return this._legacyAdmit(
      scopedBinding,
      () => this._scrobbleLegacyAdmitted(scopedBinding, input)
    );
  }

  start() {
    if (!this._playbackSessions || this._timer) return false;
    this._runScheduledPass();
    this._timer = setInterval(() => this._runScheduledPass(), this._workerIntervalMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
    return true;
  }

  async stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._activeWorkerPass) await this._activeWorkerPass.catch(() => {});
  }

  async runWorkerPass() {
    if (!this._playbackSessions) {
      return Object.freeze({ claimed: 0, delivered: 0, retried: 0, ambiguous: 0, stale: 0 });
    }
    const summary = { claimed: 0, delivered: 0, retried: 0, ambiguous: 0, stale: 0 };
    for (let index = 0; index < this._workerBatchSize; index += 1) {
      const claimed = await this._playbackSessions.claimDispatch({
        workerId: this._workerId,
        leaseMs: this._leaseMs,
      });
      if (!claimed) break;
      summary.claimed += 1;
      const outcome = await this._processClaimedDispatch(claimed, null);
      if (outcome.status === "delivered") summary.delivered += 1;
      else if (outcome.status === "retried" || outcome.status === "reauthorization") {
        summary.retried += 1;
      }
      else if (outcome.status === "ambiguous") summary.ambiguous += 1;
      else summary.stale += 1;
    }
    return Object.freeze(summary);
  }

  async _scrobbleDurable(binding, input) {
    const claim = await this._readActiveClaim(binding, input);
    let session = await this._playbackSessions.getSession(binding.profileId, input.sessionId);
    if (!sameDurableBinding(session, binding, input, claim) || session.state === "released") {
      throw staleClaim();
    }
    const context = claim.context;
    if (context.traktEligible !== true || context.canonicalIdentity === null) {
      throw codedError("trakt_ineligible", "Playback is not eligible for Trakt");
    }
    const payload = canonicalPayload(context.canonicalIdentity, input.progress, input.event);
    if (!payload) throw codedError("trakt_ineligible", "Playback is not eligible for Trakt");

    if (
      (input.event === "start" || input.event === "resume") &&
      (input.paused || input.backgrounded)
    ) {
      return this._suppressed(input.event, session.revision);
    }

    const transition = this._authoritativeTransition(session, input);
    if (transition.suppressed) return this._suppressed(input.event, session.revision);

    const dispatchId = input.dispatchId || assertIdentifier(this._idFactory({
      profileId: binding.profileId,
      profileRevision: binding.profileRevision,
      deviceId: binding.deviceId,
      deviceGeneration: binding.deviceGeneration,
      sessionId: session.sessionId,
      contextId: session.contextId,
      playbackGeneration: session.playbackGeneration,
      contextRevision: session.contextRevision,
      sessionRevision: session.revision,
      event: input.event,
      progress: input.progress,
    }));
    let queued;
    try {
      queued = await this._playbackSessions.transitionAndEnqueue({
        ...sessionMutationInput(session),
        state: transition.state,
        dispatch: {
          id: dispatchId,
          event: input.event,
          progress: input.progress,
          payload,
        },
      });
    } catch (error) {
      throw this._mapDurableError(error);
    }

    session = queued.session;
    if (!this._dispatchInline) {
      return Object.freeze({
        ok: true,
        status: "queued",
        event: input.event,
        sessionRevision: session.revision,
      });
    }

    const outcome = await this._deliverInline(
      binding.profileId,
      input.sessionId,
      dispatchId,
      null
    );
    if (outcome === "delivered") {
      return Object.freeze({
        ok: true,
        status: "scrobbled",
        event: input.event,
        sessionRevision: session.revision,
      });
    }
    if (outcome === "stale") throw staleClaim();
    if (outcome === "reauthorization") throw reauthorizationRequired();
    throw traktUnavailable();
  }

  _authoritativeTransition(session, input) {
    if (session.state === "released") throw staleClaim();
    if (input.event === "start") {
      if (session.state === "paused" || session.state === "backgrounded") {
        return { suppressed: true };
      }
      return { state: "playing" };
    }
    if (input.event === "resume") {
      if (session.state === "playing" || input.sessionRevision !== session.revision) {
        return { suppressed: true };
      }
      return { state: "playing" };
    }
    if (input.event === "pause") {
      if (input.sessionRevision !== null && input.sessionRevision !== session.revision) {
        return { suppressed: true };
      }
      const state = input.backgrounded ? "backgrounded" : "paused";
      return session.state === state ? { suppressed: true } : { state };
    }
    if (input.sessionRevision !== null && input.sessionRevision !== session.revision) {
      throw staleClaim();
    }
    return { state: "released" };
  }

  _suppressed(event, sessionRevision) {
    return Object.freeze({ ok: true, status: "suppressed", event, sessionRevision });
  }

  async _deliverInline(profileId, sessionId, dispatchId, credential) {
    for (let index = 0; index < this._workerBatchSize; index += 1) {
      const claimed = await this._playbackSessions.claimDispatch({
        workerId: this._workerId,
        leaseMs: this._leaseMs,
      });
      if (!claimed) break;
      const override =
        claimed.dispatch.profileId === profileId && claimed.dispatch.id === dispatchId
          ? credential
          : null;
      const outcome = await this._processClaimedDispatch(claimed, override);
      if (claimed.dispatch.profileId === profileId && claimed.dispatch.id === dispatchId) {
        return outcome.status;
      }
    }

    const records = await this._playbackSessions.listDispatches(profileId, sessionId);
    const record = records.find((item) => item.id === dispatchId);
    if (!record || record.status === "revoked") return "stale";
    if (record.status === "delivered") return "delivered";
    return "retried";
  }

  async _processClaimedDispatch(claimed, credentialOverride) {
    const dispatchRecord = claimed.dispatch;
    const admission = {
      profileId: dispatchRecord.profileId,
      dispatchId: dispatchRecord.id,
      leaseToken: claimed.leaseToken,
    };

    // An expired lease means a previous process may have reached Trakt. Replaying it
    // cannot be made exactly-once, so fail closed and consume it without another call.
    if (this._isRecoveredAmbiguousLease(dispatchRecord)) {
      try {
        await this._playbackSessions.withDispatchAdmission(admission, async () => null);
        return { status: "ambiguous", dispatch: dispatchRecord };
      } catch (error) {
        return { status: this._isAdmissionFenceError(error) ? "stale" : "ambiguous" };
      }
    }

    let credential = credentialOverride;
    if (!credential) {
      try {
        credential = await this._resolveCredential(dispatchRecord.profileId);
      } catch (_error) {
        const retried = await this._retryClaimedDispatch(claimed);
        return {
          status: retried ? "reauthorization" : "stale",
          dispatch: dispatchRecord,
        };
      }
    }

    let ambiguous = false;
    try {
      await this._playbackSessions.withDispatchAdmission(admission, async (authoritative) => {
        try {
          const result = await this._dispatch({
            action: EVENT_ACTIONS[authoritative.event],
            accessToken: credential.access_token,
            payload: authoritative.payload,
          });
          if (
            !result ||
            !Number.isInteger(result.status) ||
            result.status < 200 ||
            result.status >= 300
          ) {
            ambiguous = true;
          }
        } catch (error) {
          if (error && error.preEffect === true) throw error;
          ambiguous = true;
        }
        return null;
      });
    } catch (error) {
      if (this._isAdmissionFenceError(error)) {
        return { status: "stale", dispatch: dispatchRecord };
      }
      if (error && error.preEffect === true) {
        const retried = await this._retryClaimedDispatch(claimed);
        return { status: retried ? "retried" : "stale", dispatch: dispatchRecord };
      }
      return { status: "ambiguous", dispatch: dispatchRecord };
    }
    return { status: ambiguous ? "ambiguous" : "delivered", dispatch: dispatchRecord };
  }

  _isRecoveredAmbiguousLease(dispatchRecord) {
    if (dispatchRecord.attemptCount <= 1) return false;
    // Exactly one second claim is safe only when retryDispatch durably moved the
    // original next-at timestamp after a proven pre-effect failure. Any later
    // claim, or a second claim with the original timestamp, may be lease recovery.
    return !(
      dispatchRecord.attemptCount === 2 &&
      dispatchRecord.nextAttemptAt > dispatchRecord.createdAt
    );
  }

  async _retryClaimedDispatch(claimed) {
    const exponent = Math.min(Math.max(0, claimed.dispatch.attemptCount - 1), 30);
    const delay = Math.min(this._retryMaxMs, this._retryBaseMs * (2 ** exponent));
    return this._playbackSessions.retryDispatch({
      profileId: claimed.dispatch.profileId,
      dispatchId: claimed.dispatch.id,
      leaseToken: claimed.leaseToken,
      nextAttemptAt: this._readNow() + delay,
    });
  }

  async _resolveCredential(profileId) {
    let credential;
    try {
      credential = await this._getCredential(profileId);
    } catch (_error) {
      throw reauthorizationRequired();
    }
    if (!isCredential(credential)) throw reauthorizationRequired();
    return credential;
  }

  async _releaseExactSession(binding, sessionId, options = {}) {
    const revokeSource = options.revokeSource !== false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const session = await this._playbackSessions.getSession(binding.profileId, sessionId);
      if (!session) return false;
      if (
        session.profileRevision !== binding.profileRevision ||
        session.deviceId !== binding.deviceId ||
        session.deviceGeneration !== binding.deviceGeneration ||
        session.playbackGeneration !== binding.playbackGeneration
      ) {
        return false;
      }
      const sourceInvalidation = {
        profileId: session.profileId,
        contextId: session.contextId,
        playbackGeneration: session.playbackGeneration,
        contextRevision: session.contextRevision,
      };
      if (session.state === "released") {
        return false;
      }
      try {
        const released = await this._playbackSessions.invalidateSession(sessionMutationInput(session));
        if (revokeSource) {
          await this._playbackSessions.invalidateSourceClaim(sourceInvalidation);
        }
        return released;
      } catch (error) {
        if (error && error.code === "playback_session_stale") continue;
        throw this._mapDurableError(error);
      }
    }
    throw staleClaim();
  }

  _runScheduledPass() {
    if (this._activeWorkerPass) return;
    this._activeWorkerPass = this.runWorkerPass()
      .catch((error) => {
        if (this._onWorkerError) this._onWorkerError(error);
      })
      .finally(() => {
        this._activeWorkerPass = null;
      });
  }

  _readNow() {
    const value = this._clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("clock is invalid");
    return value;
  }

  _isAdmissionFenceError(error) {
    return Boolean(
      error &&
      (error.code === "scrobble_dispatch_lease_lost" ||
        error.code === "scrobble_dispatch_revoked")
    );
  }

  _mapDurableError(error) {
    if (error && DURABLE_STALE_CODES.has(error.code)) return staleClaim();
    if (error && error.code === "scrobble_dispatch_lease_lost") return traktUnavailable();
    if (error && error.code === "scrobble_dispatch_conflict") return invalidRequest();
    return error;
  }

  async _scrobbleLegacyAdmitted(binding, input) {
    let claim = await this._readActiveClaim(binding, input);
    const context = claim.context;
    if (context.traktEligible !== true || context.canonicalIdentity === null) {
      throw codedError("trakt_ineligible", "Playback is not eligible for Trakt");
    }
    const payload = canonicalPayload(context.canonicalIdentity, input.progress, input.event);
    if (!payload) throw codedError("trakt_ineligible", "Playback is not eligible for Trakt");

    if (
      (input.event === "start" || input.event === "resume") &&
      (input.paused || input.backgrounded)
    ) {
      return Object.freeze({ ok: true, status: "suppressed", event: input.event });
    }

    const credential = await this._resolveCredential(binding.profileId);
    claim = await this._readActiveClaim(binding, input);
    if (claim.context.contextId !== context.contextId) throw staleClaim();

    try {
      const result = await this._dispatch({
        action: EVENT_ACTIONS[input.event],
        accessToken: credential.access_token,
        payload,
      });
      if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300) {
        throw new Error("Trakt rejected scrobble");
      }
    } catch (_error) {
      throw traktUnavailable();
    }

    claim = await this._readActiveClaim(binding, input);
    if (claim.context.contextId !== context.contextId) throw staleClaim();
    return Object.freeze({ ok: true, status: "scrobbled", event: input.event });
  }

  async _readActiveClaim(binding, input) {
    const claim = await this._playbackContexts.getActiveClaim(
      binding.profileId,
      binding.deviceId,
      input.sessionId
    );
    if (!sameActiveClaim(claim, binding, input)) throw staleClaim();
    return claim;
  }
}

module.exports = {
  TraktScrobbleService,
  canonicalPayload,
};
