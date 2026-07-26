"use strict";

const {
  parseHistoryEventRequest,
  parsePlaybackClaimRequest,
} = require("./history-protocol");
const {
  attachPreparedHttpResponse,
  getPreparedHttpResponse,
  normalizePreparedHttpResponse,
} = require("./prepared-http-response");
const { assertPlaybackGeneration } = require("./storage/playback-session");
const {
  assertIdentifier,
  assertPositiveInteger,
  cloneJson,
} = require("./storage/repository-utils");

const NEGATIVE_CLAIM_STATUSES = new Set(["ambiguous", "expired", "not_found"]);
const RESERVED_CLAIMS = new WeakSet();
const CLAIM_RESULTS = new WeakMap();
const PLAYBACK_CLAIM_CLEANUP_OWNER = Symbol.for(
  "jumpgate.playbackClaimCleanupOwner"
);

function serviceError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeDeviceBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("device binding is invalid");
  }
  return Object.freeze({
    profileId: assertIdentifier(value.profileId, "profile id"),
    profileRevision: assertPositiveInteger(
      value.profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    ),
    deviceId: assertIdentifier(value.deviceId, "device id"),
    deviceGeneration: assertPositiveInteger(
      value.deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    ),
    historyGeneration: assertPositiveInteger(
      value.historyGeneration,
      "history generation",
      Number.MAX_SAFE_INTEGER
    ),
    playbackGeneration: assertPlaybackGeneration(value.playbackGeneration),
  });
}

function assertClaimResult(value, sessionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw serviceError("history_claim_authority_unavailable", "source claim result is invalid", 503);
  }
  if (
    value.status !== "claimed" &&
    !NEGATIVE_CLAIM_STATUSES.has(value.status)
  ) {
    throw serviceError("history_claim_authority_unavailable", "source claim status is invalid", 503);
  }
  if (value.sessionId !== sessionId) {
    throw serviceError(
      "history_claim_authority_unavailable",
      "source claim did not use the reserved session",
      503
    );
  }
  return value;
}

class ClaimBoundHistoryService {
  constructor(options = {}) {
    const historyGrants = options.historyGrants || options.repository;
    if (
      !historyGrants ||
      typeof historyGrants.reserve !== "function" ||
      typeof historyGrants.abandon !== "function" ||
      typeof historyGrants.finalize !== "function" ||
      typeof historyGrants.commitClaimResponse !== "function" ||
      typeof historyGrants.applyEvent !== "function" ||
      typeof historyGrants.release !== "function" ||
      typeof historyGrants.prune !== "function" ||
      typeof historyGrants.revokeSession !== "function"
    ) {
      throw new TypeError("history grant repository is required");
    }
    if (
      !options.playbackContexts ||
      typeof options.playbackContexts.claim !== "function" ||
      typeof options.playbackContexts.getActiveClaim !== "function"
    ) {
      throw new TypeError("playback context repository is required");
    }
    this._historyGrants = historyGrants;
    this._playbackContexts = options.playbackContexts;
    this._claimSource = options.claimSource || ((binding, request, claimOptions) =>
      this._playbackContexts.claim(
        binding.profileId,
        binding.deviceId,
        request,
        {
          generation: binding.playbackGeneration,
          deviceGeneration: binding.deviceGeneration,
          ...claimOptions,
        }
      ));
    if (typeof this._claimSource !== "function") {
      throw new TypeError("history claim source is invalid");
    }
  }

  async reserveClaim(deviceBinding, rawBody) {
    const binding = normalizeDeviceBinding(deviceBinding);
    const request = parsePlaybackClaimRequest(rawBody);
    const grant = await this._historyGrants.reserve({
      attemptId: request.attemptId,
      requestDigest: request.requestDigest,
      ...binding,
    });
    const reservation = Object.freeze({
      binding,
      request: request.body,
      attemptId: request.attemptId,
      requestDigest: request.requestDigest,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      sessionId: grant.sessionId,
      preparedResponse: getPreparedHttpResponse(grant),
    });
    RESERVED_CLAIMS.add(reservation);
    return reservation;
  }

  async finalizeClaim(reservation, rawClaimResult) {
    if (!reservation || !RESERVED_CLAIMS.has(reservation)) {
      throw new TypeError("history claim reservation is invalid");
    }
    const claimResult = assertClaimResult(rawClaimResult, reservation.sessionId);
    const authority = claimResult.status === "claimed"
      ? await this._canonicalSourceAuthority(reservation)
      : this._negativeSourceAuthority(reservation, claimResult.status);
    return this._historyGrants.finalize({
      grantId: reservation.grantId,
      requestDigest: reservation.requestDigest,
      authority,
    });
  }

  async claim(deviceBinding, rawBody, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("history claim options are invalid");
    }
    const keys = Reflect.ownKeys(options);
    if (keys.some((key) => key !== "signal")) {
      throw new TypeError("history claim options contain an unknown field");
    }
    const reservation = await this.reserveClaim(deviceBinding, rawBody);
    let claimResult = null;
    let finalized;
    try {
      claimResult = await this._claimSource(
        reservation.binding,
        reservation.request,
        {
          ...(Object.prototype.hasOwnProperty.call(options, "signal")
            ? { signal: options.signal }
            : {}),
          sessionId: reservation.sessionId,
          requestDigest: reservation.requestDigest,
        }
      );
      finalized = await this.finalizeClaim(reservation, claimResult);
    } catch (error) {
      await this._cleanupFailedClaim(reservation, claimResult, error);
    }
    const response = {
      ...claimResult,
      sessionId: reservation.sessionId,
      historyGrant: finalized.grantToken,
      historyGrantKind: finalized.kind,
      sessionRevision: finalized.sessionRevision,
    };
    const cleanupOwner = claimResult[PLAYBACK_CLAIM_CLEANUP_OWNER];
    if (cleanupOwner !== undefined) {
      Object.defineProperty(response, PLAYBACK_CLAIM_CLEANUP_OWNER, {
        configurable: false,
        enumerable: false,
        value: cleanupOwner,
        writable: false,
      });
    }
    if (reservation.preparedResponse) {
      attachPreparedHttpResponse(response, reservation.preparedResponse);
    }
    const result = Object.freeze(response);
    CLAIM_RESULTS.set(result, Object.freeze({
      binding: reservation.binding,
      grantId: reservation.grantId,
      requestDigest: reservation.requestDigest,
    }));
    return result;
  }

  commitClaimResponse(claimResult, preparedResponse) {
    const metadata = claimResult && CLAIM_RESULTS.get(claimResult);
    if (!metadata) throw new TypeError("history claim result is invalid");
    const replay = getPreparedHttpResponse(claimResult);
    return this._historyGrants.commitClaimResponse({
      grantId: metadata.grantId,
      requestDigest: metadata.requestDigest,
      preparedResponse: replay || normalizePreparedHttpResponse(preparedResponse),
    });
  }

  async commitClaimDisclosure(deviceBinding, claimResult) {
    const binding = normalizeDeviceBinding(deviceBinding);
    const metadata = claimResult && CLAIM_RESULTS.get(claimResult);
    if (!metadata) throw new TypeError("history claim result is invalid");
    if (
      metadata.binding.profileId !== binding.profileId ||
      metadata.binding.deviceId !== binding.deviceId
    ) {
      throw new TypeError("history claim result binding is invalid");
    }
    const cleanupOwner = claimResult && claimResult[PLAYBACK_CLAIM_CLEANUP_OWNER];
    if (cleanupOwner === undefined) return true;
    if (typeof this._playbackContexts.commitClaimDisclosure !== "function") {
      throw new TypeError("playback claim disclosure is unavailable");
    }
    return this._playbackContexts.commitClaimDisclosure(
      binding.profileId,
      binding.deviceId,
      assertIdentifier(claimResult.sessionId, "history session id"),
      assertIdentifier(cleanupOwner, "playback claim disclosure lease")
    );
  }

  async abandonClaimDelivery(deviceBinding, claimResult) {
    const binding = normalizeDeviceBinding(deviceBinding);
    const metadata = claimResult && CLAIM_RESULTS.get(claimResult);
    if (!metadata) return false;
    if (
      metadata.binding.profileId !== binding.profileId ||
      metadata.binding.deviceId !== binding.deviceId
    ) {
      throw new TypeError("history claim result binding is invalid");
    }
    return this._abandonClaimDelivery(binding, claimResult);
  }

  async applyEvent(deviceBinding, headers, rawBody) {
    const binding = normalizeDeviceBinding(deviceBinding);
    const request = parseHistoryEventRequest(headers, rawBody);
    return this._historyGrants.applyEvent({
      profileId: binding.profileId,
      deviceId: binding.deviceId,
      grantToken: request.grantToken,
      idempotencyKey: request.idempotencyKey,
      requestDigest: request.requestDigest,
      event: request.event,
    });
  }

  release(deviceBinding, sessionId, terminalReceiptId) {
    const binding = normalizeDeviceBinding(deviceBinding);
    return this._historyGrants.release({
      ...binding,
      sessionId: assertIdentifier(sessionId, "history session id"),
      terminalReceiptId,
    });
  }

  prune() {
    return this._historyGrants.prune();
  }

  revokeProfile(...args) {
    return this._historyGrants.revokeProfile(...args);
  }

  revokeDevice(...args) {
    return this._historyGrants.revokeDevice(...args);
  }

  revokeHistory(...args) {
    return this._historyGrants.revokeHistory(...args);
  }

  revokePlayback(...args) {
    return this._historyGrants.revokePlayback(...args);
  }

  revokeSession(...args) {
    return this._historyGrants.revokeSession(...args);
  }

  revokeSource(...args) {
    return this._historyGrants.revokeSource(...args);
  }

  supersede(...args) {
    return this._historyGrants.supersede(...args);
  }

  async _canonicalSourceAuthority(reservation) {
    const binding = reservation.binding;
    const active = await this._playbackContexts.getActiveClaim(
      binding.profileId,
      binding.deviceId,
      reservation.sessionId
    );
    if (
      !active ||
      active.status !== "claimed" ||
      active.sessionId !== reservation.sessionId ||
      !active.context ||
      typeof active.context !== "object" ||
      !active.deliveryBinding ||
      typeof active.deliveryBinding !== "object"
    ) {
      throw serviceError(
        "history_claim_authority_unavailable",
        "active source authority is unavailable",
        503
      );
    }
    const source = active.deliveryBinding;
    if (
      source.profileId !== binding.profileId ||
      source.deviceId !== binding.deviceId ||
      source.sessionId !== reservation.sessionId ||
      source.generation !== binding.playbackGeneration
    ) {
      throw serviceError(
        "history_claim_authority_unavailable",
        "active source authority does not match the reservation",
        503
      );
    }
    return {
      ...binding,
      providerRevision: source.providerRevision,
      contextId: source.contextId,
      contextRevision: source.contextRevision,
      sessionId: reservation.sessionId,
      contentKey: active.context.contentKey === undefined ? null : active.context.contentKey,
      canonicalIdentity:
        active.context.canonicalIdentity === undefined
          ? null
          : cloneJson(active.context.canonicalIdentity),
      displaySnapshot: cloneJson(active.context.display || {}),
      claimStatus: "claimed",
      traktEligible: active.context.traktEligible === true,
      supersededSessionId: source.supersededSessionId || null,
    };
  }

  _negativeSourceAuthority(reservation, claimStatus) {
    return {
      ...reservation.binding,
      providerRevision: null,
      contextId: null,
      contextRevision: null,
      sessionId: reservation.sessionId,
      contentKey: null,
      canonicalIdentity: null,
      displaySnapshot: {},
      claimStatus,
      traktEligible: false,
      supersededSessionId: null,
    };
  }

  async _cleanupFailedClaim(reservation, claimResult, originalError) {
    const cleanupErrors = [];
    try {
      await this._historyGrants.abandon({
        grantId: reservation.grantId,
        attemptId: reservation.attemptId,
        requestDigest: reservation.requestDigest,
        ...reservation.binding,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this._abandonClaimDelivery(reservation.binding, claimResult);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [originalError, ...cleanupErrors],
        "history claim failed and reserved authority could not be fully abandoned"
      );
    }
    throw originalError;
  }

  async _abandonClaimDelivery(binding, claimResult) {
    const cleanupOwner = claimResult
      ? claimResult[PLAYBACK_CLAIM_CLEANUP_OWNER]
      : undefined;
    if (cleanupOwner === undefined) return false;
    if (typeof this._playbackContexts.releaseOwned !== "function") {
      throw new TypeError("playback claim abandonment is unavailable");
    }
    const sessionId = assertIdentifier(claimResult.sessionId, "history session id");
    const released = await this._playbackContexts.releaseOwned(
      binding.profileId,
      binding.deviceId,
      sessionId,
      assertIdentifier(cleanupOwner, "playback claim cleanup owner")
    );
    if (released) await this._historyGrants.revokeSession(binding.profileId, sessionId);
    return released;
  }
}

module.exports = {
  ClaimBoundHistoryService,
  normalizeDeviceBinding,
};
