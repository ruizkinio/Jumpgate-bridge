"use strict";

const crypto = require("node:crypto");
const { TextDecoder, types } = require("node:util");

const { normalizePlaybackSnapshot } = require("./history-service");

const PLAYBACK_CLAIM_METHOD = "POST";
const PLAYBACK_CLAIM_PATH = "/v1/playback/claim";
const PLAYBACK_CLAIM_DIGEST_DOMAIN = "jumpgate-playback-claim-request:v1";
const HISTORY_EVENT_METHOD = "POST";
const HISTORY_EVENT_PATH = "/v1/history/events";
const HISTORY_EVENT_DIGEST_DOMAIN = "jumpgate-history-event-request:v1";
const HISTORY_GRANT_HEADER = "x-jumpgate-history-grant";
const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const MAX_PLAYBACK_CLAIM_BYTES = 8 * 1024;
const MAX_HISTORY_EVENT_BYTES = 12 * 1024;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HISTORY_GRANT_TOKEN_PATTERN = /^hg1_[A-Za-z0-9_-]{22,128}$/;
const HISTORY_EVENTS = new Set([
  "start",
  "progress",
  "pause",
  "background",
  "resume",
  "stop",
  "completion",
]);
const HISTORY_EVENT_FIELDS = new Set([
  "event",
  "sessionRevision",
  "positionMs",
  "durationMs",
  "watchedMs",
  "playbackPreferences",
]);
const PLAYBACK_PREFERENCE_FIELDS = new Set([
  "subtitleTrackId",
  "audioTrackId",
  "videoTrackId",
  "subtitleLanguages",
  "audioLanguages",
  "subtitlesEnabled",
  "hearingImpaired",
  "forced",
  "playbackSpeed",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function protocolError(code, message, status = 400) {
  const error = new TypeError(message);
  error.code = code;
  error.status = status;
  return error;
}

function assertPlainObject(value, name, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw protocolError(code, name + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw protocolError(code, name + " must be a plain object");
  }
  return value;
}

function assertExactKeys(value, allowed, required, name, code) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw protocolError(code, name + " contains an unknown field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw protocolError(code, name + " contains an unsupported property");
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw protocolError(code, name + " is missing " + key);
    }
  }
}

function assertCanonicalUuid(value, name = "UUID", code = "invalid_uuid") {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw protocolError(code, name + " must be a canonical UUID");
  }
  return value;
}

function assertRawBody(rawBody, maximumBytes, name, code) {
  if (!Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array)) {
    throw protocolError(code, name + " must be raw bytes");
  }
  const bytes = Buffer.from(rawBody);
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw protocolError(code, name + " has an invalid size");
  }
  return bytes;
}

function parseRawJson(rawBody, maximumBytes, name, code) {
  const bytes = assertRawBody(rawBody, maximumBytes, name, code);
  let json;
  try {
    json = UTF8_DECODER.decode(bytes);
  } catch (_error) {
    throw protocolError(code, name + " is not valid UTF-8 JSON");
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_error) {
    throw protocolError(code, name + " is not valid JSON");
  }
  return { bytes, parsed: assertPlainObject(parsed, name, code) };
}

function digestRawRequest(domain, method, path, rawBody) {
  if (typeof domain !== "string" || !/^[a-z][a-z0-9:-]{0,127}$/.test(domain)) {
    throw new TypeError("request digest domain is invalid");
  }
  if (typeof method !== "string" || !/^[A-Z]{3,16}$/.test(method)) {
    throw new TypeError("request digest method is invalid");
  }
  if (typeof path !== "string" || !/^\/[A-Za-z0-9/_-]{1,255}$/.test(path)) {
    throw new TypeError("request digest path is invalid");
  }
  if (!Buffer.isBuffer(rawBody) && !(rawBody instanceof Uint8Array)) {
    throw new TypeError("request digest body must be raw bytes");
  }
  return crypto
    .createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(method, "ascii")
    .update("\0", "utf8")
    .update(path, "utf8")
    .update("\0", "utf8")
    .update(rawBody)
    .digest("hex");
}

function digestPlaybackClaimRequest(rawBody) {
  const bytes = assertRawBody(
    rawBody,
    MAX_PLAYBACK_CLAIM_BYTES,
    "playback claim body",
    "invalid_playback_claim"
  );
  return digestRawRequest(
    PLAYBACK_CLAIM_DIGEST_DOMAIN,
    PLAYBACK_CLAIM_METHOD,
    PLAYBACK_CLAIM_PATH,
    bytes
  );
}

function parsePlaybackClaimRequest(rawBody) {
  const { bytes, parsed } = parseRawJson(
    rawBody,
    MAX_PLAYBACK_CLAIM_BYTES,
    "playback claim body",
    "invalid_playback_claim"
  );
  const attemptId = assertCanonicalUuid(
    parsed.attemptId,
    "attemptId",
    "invalid_playback_claim"
  );
  return Object.freeze({
    attemptId,
    body: parsed,
    requestDigest: digestPlaybackClaimRequest(bytes),
  });
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw protocolError("invalid_history_event", name + " is invalid");
  }
  return value;
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw protocolError("invalid_history_event", name + " is invalid");
  }
  return value;
}

function normalizePlaybackPreferences(value) {
  if (value === undefined) return {};
  const preferences = assertPlainObject(
    value,
    "playbackPreferences",
    "invalid_history_event"
  );
  assertExactKeys(
    preferences,
    PLAYBACK_PREFERENCE_FIELDS,
    [],
    "playbackPreferences",
    "invalid_history_event"
  );
  try {
    return normalizePlaybackSnapshot(preferences);
  } catch (_error) {
    throw protocolError("invalid_history_event", "playbackPreferences is invalid");
  }
}

function normalizeHistoryEventBody(value) {
  const body = assertPlainObject(value, "history event body", "invalid_history_event");
  assertExactKeys(
    body,
    HISTORY_EVENT_FIELDS,
    ["event", "sessionRevision", "positionMs", "durationMs", "watchedMs"],
    "history event body",
    "invalid_history_event"
  );
  if (!HISTORY_EVENTS.has(body.event)) {
    throw protocolError("invalid_history_event", "history event is invalid");
  }
  const positionMs = assertNonNegativeInteger(body.positionMs, "positionMs");
  const durationMs = assertNonNegativeInteger(body.durationMs, "durationMs");
  const watchedMs = assertNonNegativeInteger(body.watchedMs, "watchedMs");
  if (
    (durationMs === 0 && (positionMs !== 0 || watchedMs !== 0)) ||
    (durationMs > 0 && (positionMs > durationMs || watchedMs > durationMs))
  ) {
    throw protocolError("invalid_history_event", "history event progress is invalid");
  }
  return Object.freeze({
    event: body.event,
    sessionRevision: assertPositiveInteger(body.sessionRevision, "sessionRevision"),
    positionMs,
    durationMs,
    watchedMs,
    playbackPreferences: Object.freeze(normalizePlaybackPreferences(body.playbackPreferences)),
  });
}

function digestHistoryEventRequest(rawBody) {
  const bytes = assertRawBody(
    rawBody,
    MAX_HISTORY_EVENT_BYTES,
    "history event body",
    "invalid_history_event"
  );
  return digestRawRequest(
    HISTORY_EVENT_DIGEST_DOMAIN,
    HISTORY_EVENT_METHOD,
    HISTORY_EVENT_PATH,
    bytes
  );
}

function readHeader(headers, name) {
  if (
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    types.isProxy(headers)
  ) {
    return null;
  }
  const matches = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue;
    matches.push(headers[key]);
  }
  return matches.length === 1 && typeof matches[0] === "string" ? matches[0] : null;
}

function readHistoryGrantHeader(headers) {
  const token = readHeader(headers, HISTORY_GRANT_HEADER);
  if (!token || !HISTORY_GRANT_TOKEN_PATTERN.test(token)) {
    throw protocolError("history_grant_required", "history grant is required", 401);
  }
  return token;
}

function readIdempotencyKey(headers) {
  return assertCanonicalUuid(
    readHeader(headers, IDEMPOTENCY_KEY_HEADER),
    "Idempotency-Key",
    "invalid_idempotency_key"
  );
}

function parseHistoryEventRequest(headers, rawBody) {
  const { bytes, parsed } = parseRawJson(
    rawBody,
    MAX_HISTORY_EVENT_BYTES,
    "history event body",
    "invalid_history_event"
  );
  return Object.freeze({
    grantToken: readHistoryGrantHeader(headers),
    idempotencyKey: readIdempotencyKey(headers),
    requestDigest: digestHistoryEventRequest(bytes),
    event: normalizeHistoryEventBody(parsed),
  });
}

module.exports = {
  CANONICAL_UUID_PATTERN,
  HISTORY_EVENT_DIGEST_DOMAIN,
  HISTORY_EVENT_METHOD,
  HISTORY_EVENT_PATH,
  HISTORY_EVENTS,
  HISTORY_GRANT_HEADER,
  HISTORY_GRANT_TOKEN_PATTERN,
  IDEMPOTENCY_KEY_HEADER,
  MAX_HISTORY_EVENT_BYTES,
  MAX_PLAYBACK_CLAIM_BYTES,
  PLAYBACK_CLAIM_DIGEST_DOMAIN,
  PLAYBACK_CLAIM_METHOD,
  PLAYBACK_CLAIM_PATH,
  PLAYBACK_PREFERENCE_FIELDS,
  assertCanonicalUuid,
  digestHistoryEventRequest,
  digestPlaybackClaimRequest,
  digestRawRequest,
  normalizeHistoryEventBody,
  parseHistoryEventRequest,
  parsePlaybackClaimRequest,
  readHistoryGrantHeader,
  readIdempotencyKey,
};
