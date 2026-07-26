"use strict";

const { isDeepStrictEqual, types } = require("node:util");

const {
  assertContentKey,
  normalizeCanonicalIdentity,
  normalizeDisplaySnapshot,
} = require("../history-service");
const {
  HISTORY_GRANT_TOKEN_PATTERN,
  assertCanonicalUuid,
  normalizeHistoryEventBody,
} = require("../history-protocol");
const {
  attachPreparedHttpResponse,
  decodePreparedHttpResponse,
  normalizePreparedHttpResponse,
  preparedJsonResponse,
} = require("../prepared-http-response");
const { assertPlaybackGeneration } = require("./playback-session");
const {
  assertIdentifier,
  assertMutationFence,
  assertPositiveInteger,
  cloneJson,
} = require("./repository-utils");

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HISTORY_GRANT_KINDS = new Set(["canonical", "local", "negative"]);
const HISTORY_GRANT_STATES = new Set([
  "reserved",
  "active",
  "released",
  "revoked",
  "superseded",
]);
const NEGATIVE_CLAIM_STATUSES = new Set(["ambiguous", "expired", "not_found"]);
const CLAIM_STATUSES = new Set(["claimed", ...NEGATIVE_CLAIM_STATUSES]);
const SESSION_STATES = new Set(["playing", "paused", "backgrounded", "released"]);
const DEFAULT_RESERVATION_TTL_MS = 2 * 60 * 1000;
const DEFAULT_RESERVATION_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RESERVATION_TTL_MS = 10 * 60 * 1000;
const MAX_RESERVATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const RESERVATION_FIELDS = new Set([
  "attemptId",
  "requestDigest",
  "profileId",
  "profileRevision",
  "deviceId",
  "deviceGeneration",
  "historyGeneration",
  "playbackGeneration",
]);
const SOURCE_AUTHORITY_FIELDS = new Set([
  "profileId",
  "profileRevision",
  "deviceId",
  "deviceGeneration",
  "historyGeneration",
  "playbackGeneration",
  "providerRevision",
  "contextId",
  "contextRevision",
  "sessionId",
  "contentKey",
  "canonicalIdentity",
  "displaySnapshot",
  "claimStatus",
  "traktEligible",
  "supersededSessionId",
]);
const FINALIZATION_FIELDS = new Set(["grantId", "requestDigest", "authority"]);
const ABANDON_RESERVATION_FIELDS = new Set(["grantId", ...RESERVATION_FIELDS]);
const COMMIT_CLAIM_RESPONSE_FIELDS = new Set([
  "grantId",
  "requestDigest",
  "preparedResponse",
]);
const APPLY_EVENT_FIELDS = new Set([
  "profileId",
  "deviceId",
  "grantToken",
  "idempotencyKey",
  "requestDigest",
  "event",
]);
const RELEASE_FIELDS = new Set([
  "profileId",
  "profileRevision",
  "deviceId",
  "deviceGeneration",
  "historyGeneration",
  "playbackGeneration",
  "sessionId",
  "terminalReceiptId",
]);

function historyGrantError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function strictObject(value, name, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(name + " is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " is invalid");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.has(key)) {
      throw new TypeError(name + " contains an unknown field: " + String(key));
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(name + " contains an unsupported property");
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(name + " is missing " + key);
    }
  }
  return value;
}

function assertSha256(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertGrantToken(value) {
  if (typeof value !== "string" || !HISTORY_GRANT_TOKEN_PATTERN.test(value)) {
    throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
  }
  return value;
}

function normalizeReservationInput(value) {
  const input = strictObject(value, "history grant reservation", RESERVATION_FIELDS);
  return Object.freeze({
    attemptId: assertCanonicalUuid(input.attemptId, "attemptId", "invalid_playback_claim"),
    requestDigest: assertSha256(input.requestDigest, "playback claim request digest"),
    profileId: assertIdentifier(input.profileId, "profile id"),
    profileRevision: assertPositiveInteger(
      input.profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    ),
    deviceId: assertIdentifier(input.deviceId, "device id"),
    deviceGeneration: assertPositiveInteger(
      input.deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    ),
    historyGeneration: assertPositiveInteger(
      input.historyGeneration,
      "history generation",
      Number.MAX_SAFE_INTEGER
    ),
    playbackGeneration: assertPlaybackGeneration(input.playbackGeneration),
  });
}

function normalizeCanonical(value) {
  try {
    return normalizeCanonicalIdentity(value);
  } catch (_error) {
    throw new TypeError("source canonical identity is invalid");
  }
}

function normalizeDisplay(value, canonicalIdentity) {
  try {
    return normalizeDisplaySnapshot(value, canonicalIdentity);
  } catch (_error) {
    throw new TypeError("source display snapshot is invalid");
  }
}

function normalizeContentKey(value) {
  if (value === null) return null;
  try {
    return assertContentKey(value);
  } catch (_error) {
    throw new TypeError("source content key is invalid");
  }
}

function normalizeNullableIdentifier(value, name) {
  return value === null ? null : assertIdentifier(value, name);
}

function normalizeNullableFence(value, name) {
  return value === null ? null : assertMutationFence(value, name);
}

function normalizeSourceAuthority(value) {
  const input = strictObject(value, "history source authority", SOURCE_AUTHORITY_FIELDS);
  if (!CLAIM_STATUSES.has(input.claimStatus)) {
    throw new TypeError("source claim status is invalid");
  }
  if (typeof input.traktEligible !== "boolean") {
    throw new TypeError("source Trakt eligibility is invalid");
  }

  const canonicalIdentity = normalizeCanonical(input.canonicalIdentity);
  const authority = {
    profileId: assertIdentifier(input.profileId, "profile id"),
    profileRevision: assertPositiveInteger(
      input.profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    ),
    deviceId: assertIdentifier(input.deviceId, "device id"),
    deviceGeneration: assertPositiveInteger(
      input.deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    ),
    historyGeneration: assertPositiveInteger(
      input.historyGeneration,
      "history generation",
      Number.MAX_SAFE_INTEGER
    ),
    playbackGeneration: assertPlaybackGeneration(input.playbackGeneration),
    providerRevision: normalizeNullableFence(input.providerRevision, "provider revision"),
    contextId: normalizeNullableIdentifier(input.contextId, "source context id"),
    contextRevision: normalizeNullableFence(input.contextRevision, "source context revision"),
    sessionId: assertIdentifier(input.sessionId, "history session id"),
    contentKey: normalizeContentKey(input.contentKey),
    canonicalIdentity,
    displaySnapshot: normalizeDisplay(input.displaySnapshot, canonicalIdentity),
    claimStatus: input.claimStatus,
    traktEligible: input.traktEligible,
    supersededSessionId: normalizeNullableIdentifier(
      input.supersededSessionId,
      "superseded history session id"
    ),
  };

  if (authority.claimStatus === "claimed") {
    if (
      authority.providerRevision === null ||
      authority.contextId === null ||
      authority.contextRevision === null
    ) {
      throw new TypeError("claimed source authority is incomplete");
    }
    if (authority.traktEligible && (!authority.contentKey || !authority.canonicalIdentity)) {
      throw new TypeError("Trakt-eligible source authority is not canonical");
    }
  } else if (
    authority.providerRevision !== null ||
    authority.contextId !== null ||
    authority.contextRevision !== null ||
    authority.contentKey !== null ||
    authority.canonicalIdentity !== null ||
    Object.keys(authority.displaySnapshot).length !== 0 ||
    authority.traktEligible ||
    authority.supersededSessionId !== null
  ) {
    throw new TypeError("negative source authority must not contain source identity");
  }
  return Object.freeze({
    ...authority,
    displaySnapshot: Object.freeze(authority.displaySnapshot),
    canonicalIdentity: authority.canonicalIdentity
      ? Object.freeze(authority.canonicalIdentity)
      : null,
  });
}

function deriveGrantKind(authority) {
  const source = normalizeSourceAuthority(authority);
  if (NEGATIVE_CLAIM_STATUSES.has(source.claimStatus)) return "negative";
  if (source.traktEligible && source.contentKey && source.canonicalIdentity) return "canonical";
  return "local";
}

function normalizeFinalizationInput(value) {
  const input = strictObject(value, "history grant finalization", FINALIZATION_FIELDS);
  return Object.freeze({
    grantId: assertIdentifier(input.grantId, "history grant id"),
    requestDigest: assertSha256(input.requestDigest, "playback claim request digest"),
    authority: normalizeSourceAuthority(input.authority),
  });
}

function normalizeAbandonReservationInput(value) {
  const input = strictObject(
    value,
    "history grant abandonment",
    ABANDON_RESERVATION_FIELDS
  );
  const reservation = normalizeReservationInput(
    Object.fromEntries(Array.from(RESERVATION_FIELDS, (key) => [key, input[key]]))
  );
  return Object.freeze({
    grantId: assertIdentifier(input.grantId, "history grant id"),
    ...reservation,
  });
}

function normalizeCommitClaimResponseInput(value) {
  const input = strictObject(
    value,
    "history claim response",
    COMMIT_CLAIM_RESPONSE_FIELDS
  );
  return Object.freeze({
    grantId: assertIdentifier(input.grantId, "history grant id"),
    requestDigest: assertSha256(input.requestDigest, "playback claim request digest"),
    preparedResponse: normalizePreparedHttpResponse(input.preparedResponse),
  });
}

function normalizeApplyEventInput(value) {
  const input = strictObject(value, "history grant event", APPLY_EVENT_FIELDS);
  return Object.freeze({
    profileId: assertIdentifier(input.profileId, "profile id"),
    deviceId: assertIdentifier(input.deviceId, "device id"),
    grantToken: assertGrantToken(input.grantToken),
    idempotencyKey: assertCanonicalUuid(
      input.idempotencyKey,
      "Idempotency-Key",
      "invalid_idempotency_key"
    ),
    requestDigest: assertSha256(input.requestDigest, "history event request digest"),
    event: normalizeHistoryEventBody(input.event),
  });
}

function normalizeReleaseInput(value) {
  const input = strictObject(value, "history grant release", RELEASE_FIELDS);
  return Object.freeze({
    profileId: assertIdentifier(input.profileId, "profile id"),
    profileRevision: assertPositiveInteger(
      input.profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    ),
    deviceId: assertIdentifier(input.deviceId, "device id"),
    deviceGeneration: assertPositiveInteger(
      input.deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    ),
    historyGeneration: assertPositiveInteger(
      input.historyGeneration,
      "history generation",
      Number.MAX_SAFE_INTEGER
    ),
    playbackGeneration: assertPlaybackGeneration(input.playbackGeneration),
    sessionId: assertIdentifier(input.sessionId, "history session id"),
    terminalReceiptId: assertCanonicalUuid(
      input.terminalReceiptId,
      "terminal history receipt id",
      "history_terminal_receipt_required"
    ),
  });
}

function normalizeReservationDuration(value, name, fallback, maximum) {
  const duration = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > maximum) {
    throw new TypeError(name + " is invalid");
  }
  return duration;
}

function assertPresentedGrantBinding(record, candidate) {
  if (
    !record ||
    record.profileId !== candidate.profileId ||
    record.deviceId !== candidate.deviceId
  ) {
    throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
  }
  return record;
}

function sameReservation(left, right) {
  return Boolean(
    left &&
      right &&
      left.attemptId === right.attemptId &&
      left.requestDigest === right.requestDigest &&
      left.profileId === right.profileId &&
      left.profileRevision === right.profileRevision &&
      left.deviceId === right.deviceId &&
      left.deviceGeneration === right.deviceGeneration &&
      left.historyGeneration === right.historyGeneration &&
      left.playbackGeneration === right.playbackGeneration
  );
}

function sameSourceAuthority(left, right) {
  return isDeepStrictEqual(left, right);
}

function sessionStateForEvent(event) {
  if (event === "pause") return "paused";
  if (event === "background") return "backgrounded";
  if (event === "stop" || event === "completion") return "released";
  return "playing";
}

function dispatchEventForHistoryEvent(event) {
  if (event === "progress") return "start";
  if (event === "background") return "pause";
  return event;
}

function isTerminalEvent(event) {
  return event === "stop" || event === "completion";
}

function shouldSuppressPeriodicEvent(sessionState, event) {
  return (
    (sessionState === "paused" || sessionState === "backgrounded") &&
    (event === "start" || event === "progress")
  );
}

function prepareHistoryEventResponse(payload) {
  return preparedJsonResponse(200, payload, {
    "cache-control": "no-store",
    pragma: "no-cache",
  });
}

function publicGrant(record) {
  if (!record) return null;
  const result = {
    grantId: record.grantId,
    attemptId: record.attemptId,
    requestDigest: record.requestDigest,
    profileId: record.profileId,
    deviceId: record.deviceId,
    sessionId: record.sessionId,
    status: record.status,
    kind: record.kind,
    claimStatus: record.claimStatus,
    sessionState: record.sessionState,
    sessionRevision: record.sessionRevision,
    createdAt: record.createdAt,
    finalizedAt: record.finalizedAt,
    releasedAt: record.releasedAt,
    revokedAt: record.revokedAt,
    supersededAt: record.supersededAt,
  };
  if (record.claimResponse) {
    attachPreparedHttpResponse(result, decodePreparedHttpResponse(record.claimResponse));
  }
  return Object.freeze(result);
}

function publicReceipt(record) {
  if (!record) return null;
  const result = cloneJson(record.response);
  if (record.preparedResponse) {
    attachPreparedHttpResponse(result, decodePreparedHttpResponse(record.preparedResponse));
  }
  return Object.freeze(result);
}

function publicDispatchIntent(record) {
  if (!record) return null;
  return Object.freeze({
    id: record.id,
    grantId: record.grantId,
    profileId: record.profileId,
    profileRevision: record.profileRevision,
    deviceId: record.deviceId,
    deviceGeneration: record.deviceGeneration,
    historyGeneration: record.historyGeneration,
    sessionId: record.sessionId,
    sessionRevision: record.sessionRevision,
    contextId: record.contextId,
    contextRevision: record.contextRevision,
    playbackGeneration: record.playbackGeneration,
    providerRevision: record.providerRevision,
    event: record.event,
    progress: record.progress,
    canonicalIdentity: cloneJson(record.canonicalIdentity),
    status: record.status,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
  });
}

function assertGrantState(value) {
  if (!HISTORY_GRANT_STATES.has(value)) throw new TypeError("history grant state is invalid");
  return value;
}

function assertGrantKind(value) {
  if (!HISTORY_GRANT_KINDS.has(value)) throw new TypeError("history grant kind is invalid");
  return value;
}

function assertSessionState(value) {
  if (!SESSION_STATES.has(value)) throw new TypeError("history session state is invalid");
  return value;
}

module.exports = {
  ABANDON_RESERVATION_FIELDS,
  APPLY_EVENT_FIELDS,
  CLAIM_STATUSES,
  COMMIT_CLAIM_RESPONSE_FIELDS,
  DEFAULT_RESERVATION_RETENTION_MS,
  DEFAULT_RESERVATION_TTL_MS,
  FINALIZATION_FIELDS,
  HISTORY_GRANT_KINDS,
  HISTORY_GRANT_STATES,
  MAX_RESERVATION_RETENTION_MS,
  MAX_RESERVATION_TTL_MS,
  NEGATIVE_CLAIM_STATUSES,
  RELEASE_FIELDS,
  RESERVATION_FIELDS,
  SESSION_STATES,
  SHA256_PATTERN,
  SOURCE_AUTHORITY_FIELDS,
  assertGrantKind,
  assertPresentedGrantBinding,
  assertGrantState,
  assertGrantToken,
  assertSessionState,
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
  normalizeSourceAuthority,
  prepareHistoryEventResponse,
  publicDispatchIntent,
  publicGrant,
  publicReceipt,
  sameReservation,
  sameSourceAuthority,
  sessionStateForEvent,
  shouldSuppressPeriodicEvent,
};
