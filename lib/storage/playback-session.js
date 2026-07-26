"use strict";

const { isDeepStrictEqual, types } = require("node:util");
const { assertJsonValue } = require("./json-domain");
const {
  assertIdentifier,
  assertMutationFence,
  assertPositiveInteger,
  cloneJson,
  codedError,
  parseTimestamp,
} = require("./repository-utils");

const MAX_DISPATCH_PAYLOAD_BYTES = 64 * 1024;
const MAX_DISPATCH_LEASE_MS = 10 * 60 * 1000;
const PLAYBACK_GENERATION_PATTERN = /^g1:[A-Za-z0-9_-]{1,128}$/;
const PLAYBACK_STATES = new Set(["playing", "paused", "backgrounded", "released"]);
const DISPATCH_EVENTS = new Set(["start", "resume", "pause", "stop", "completion"]);
const ACTIVE_DISPATCH_STATES = new Set(["queued", "leased"]);

function strictObject(value, name, fields) {
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
  return value;
}

function assertPlaybackGeneration(value) {
  if (typeof value !== "string" || !PLAYBACK_GENERATION_PATTERN.test(value)) {
    throw new TypeError("playback generation is invalid");
  }
  return value;
}

function assertPlaybackState(value, options = {}) {
  if (!PLAYBACK_STATES.has(value) || (options.opening && value === "released")) {
    throw new TypeError("playback state is invalid");
  }
  return value;
}

function assertDispatchEvent(value) {
  if (!DISPATCH_EVENTS.has(value)) throw new TypeError("scrobble dispatch event is invalid");
  return value;
}

function requiredStateForEvent(event, state) {
  const scopedEvent = assertDispatchEvent(event);
  const scopedState = assertPlaybackState(state);
  if (
    ((scopedEvent === "start" || scopedEvent === "resume") && scopedState !== "playing") ||
    (scopedEvent === "pause" && scopedState !== "paused" && scopedState !== "backgrounded") ||
    ((scopedEvent === "stop" || scopedEvent === "completion") && scopedState !== "released")
  ) {
    throw codedError(
      "scrobble_dispatch_state_invalid",
      "scrobble dispatch does not match authoritative playback state"
    );
  }
  return scopedState;
}

const BINDING_FIELDS = new Set([
  "profileId",
  "profileRevision",
  "deviceId",
  "deviceGeneration",
  "sessionId",
  "contextId",
  "playbackGeneration",
  "contextRevision",
]);

function normalizeBinding(value, name = "playback binding") {
  strictObject(value, name, BINDING_FIELDS);
  return {
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
    sessionId: assertIdentifier(value.sessionId, "playback session id"),
    contextId: assertIdentifier(value.contextId, "source context id"),
    playbackGeneration: assertPlaybackGeneration(value.playbackGeneration),
    contextRevision: assertMutationFence(value.contextRevision, "source context revision"),
  };
}

function normalizeOpenInput(value) {
  strictObject(value, "playback session input", new Set([...BINDING_FIELDS, "state"]));
  return {
    ...normalizeBinding(Object.fromEntries(
      Array.from(BINDING_FIELDS, (field) => [field, value[field]])
    )),
    state: assertPlaybackState(value.state, { opening: true }),
  };
}

function normalizeTransitionInput(value) {
  strictObject(
    value,
    "playback transition input",
    new Set([...BINDING_FIELDS, "expectedRevision", "state"])
  );
  return {
    ...normalizeBinding(Object.fromEntries(
      Array.from(BINDING_FIELDS, (field) => [field, value[field]])
    )),
    expectedRevision: assertPositiveInteger(
      value.expectedRevision,
      "playback session revision",
      Number.MAX_SAFE_INTEGER
    ),
    state: assertPlaybackState(value.state),
  };
}

function normalizeDispatchInput(value, state) {
  strictObject(
    value,
    "scrobble dispatch input",
    new Set(["id", "event", "progress", "payload"])
  );
  const progress = value.progress;
  if (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0 || progress > 100) {
    throw new TypeError("scrobble dispatch progress is invalid");
  }
  const payload = assertJsonValue(
    value.payload,
    "scrobble dispatch payload",
    MAX_DISPATCH_PAYLOAD_BYTES
  );
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("scrobble dispatch payload is invalid");
  }
  const event = assertDispatchEvent(value.event);
  return {
    id: assertIdentifier(value.id, "scrobble dispatch id"),
    event,
    progress,
    payload,
    requiredState: requiredStateForEvent(event, state),
  };
}

function normalizeTransitionAndDispatchInput(value) {
  strictObject(
    value,
    "playback transition dispatch input",
    new Set([...BINDING_FIELDS, "expectedRevision", "state", "dispatch"])
  );
  const transition = normalizeTransitionInput(Object.fromEntries([
    ...Array.from(BINDING_FIELDS, (field) => [field, value[field]]),
    ["expectedRevision", value.expectedRevision],
    ["state", value.state],
  ]));
  return { ...transition, dispatch: normalizeDispatchInput(value.dispatch, transition.state) };
}

function normalizeClaimInput(value) {
  strictObject(value, "scrobble dispatch claim", new Set(["workerId", "leaseMs"]));
  return {
    workerId: assertIdentifier(value.workerId, "scrobble worker id"),
    leaseMs: assertPositiveInteger(value.leaseMs, "scrobble lease duration", MAX_DISPATCH_LEASE_MS),
  };
}

function normalizeAdmissionInput(value) {
  strictObject(
    value,
    "scrobble dispatch admission",
    new Set(["profileId", "dispatchId", "leaseToken"])
  );
  if (typeof value.leaseToken !== "string" || value.leaseToken.length < 16 || value.leaseToken.length > 1024) {
    throw new TypeError("scrobble dispatch lease token is invalid");
  }
  return {
    profileId: assertIdentifier(value.profileId, "profile id"),
    dispatchId: assertIdentifier(value.dispatchId, "scrobble dispatch id"),
    leaseToken: value.leaseToken,
  };
}

function normalizeRetryInput(value) {
  strictObject(
    value,
    "scrobble dispatch retry",
    new Set(["profileId", "dispatchId", "leaseToken", "nextAttemptAt"])
  );
  const admission = normalizeAdmissionInput({
    profileId: value.profileId,
    dispatchId: value.dispatchId,
    leaseToken: value.leaseToken,
  });
  return {
    ...admission,
    nextAttemptAt: parseTimestamp(value.nextAttemptAt, "scrobble retry timestamp"),
  };
}

function normalizeSessionInvalidation(value) {
  strictObject(
    value,
    "playback session invalidation",
    new Set([...BINDING_FIELDS, "expectedRevision"])
  );
  return {
    ...normalizeBinding(Object.fromEntries(
      Array.from(BINDING_FIELDS, (field) => [field, value[field]])
    )),
    expectedRevision: assertPositiveInteger(
      value.expectedRevision,
      "playback session revision",
      Number.MAX_SAFE_INTEGER
    ),
  };
}

function normalizeSourceInvalidation(value) {
  strictObject(
    value,
    "source claim invalidation",
    new Set(["profileId", "contextId", "playbackGeneration", "contextRevision"])
  );
  return {
    profileId: assertIdentifier(value.profileId, "profile id"),
    contextId: assertIdentifier(value.contextId, "source context id"),
    playbackGeneration: assertPlaybackGeneration(value.playbackGeneration),
    contextRevision: assertMutationFence(value.contextRevision, "source context revision"),
  };
}

function sameBinding(left, right) {
  return Boolean(
    left && right &&
    left.profileId === right.profileId &&
    left.profileRevision === right.profileRevision &&
    left.deviceId === right.deviceId &&
    left.deviceGeneration === right.deviceGeneration &&
    left.sessionId === right.sessionId &&
    left.contextId === right.contextId &&
    left.playbackGeneration === right.playbackGeneration &&
    left.contextRevision === right.contextRevision
  );
}

function sameDispatch(left, right) {
  return Boolean(
    left && right &&
    left.id === right.id &&
    left.event === right.event &&
    left.progress === right.progress &&
    left.requiredState === right.requiredState &&
    isDeepStrictEqual(left.payload, right.payload)
  );
}

function publicSession(record) {
  if (!record) return null;
  return Object.freeze({
    profileId: record.profileId,
    profileRevision: record.profileRevision,
    deviceId: record.deviceId,
    deviceGeneration: record.deviceGeneration,
    sessionId: record.sessionId,
    contextId: record.contextId,
    playbackGeneration: record.playbackGeneration,
    contextRevision: record.contextRevision,
    state: record.state,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    invalidatedAt: record.invalidatedAt,
  });
}

function publicDispatch(record) {
  if (!record) return null;
  return Object.freeze({
    id: record.id,
    profileId: record.profileId,
    profileRevision: record.profileRevision,
    deviceId: record.deviceId,
    deviceGeneration: record.deviceGeneration,
    historyGeneration: record.historyGeneration,
    sessionId: record.sessionId,
    contextId: record.contextId,
    playbackGeneration: record.playbackGeneration,
    contextRevision: record.contextRevision,
    sessionRevision: record.sessionRevision,
    event: record.event,
    progress: record.progress,
    payload: cloneJson(record.payload),
    requiredState: record.requiredState,
    status: record.status,
    attemptCount: record.attemptCount,
    nextAttemptAt: record.nextAttemptAt,
    leaseOwner: record.leaseOwner,
    leaseExpiresAt: record.leaseExpiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deliveredAt: record.deliveredAt,
    revokedAt: record.revokedAt,
  });
}

function dispatchError(code, message) {
  return codedError(code, message);
}

module.exports = {
  ACTIVE_DISPATCH_STATES,
  DISPATCH_EVENTS,
  MAX_DISPATCH_LEASE_MS,
  MAX_DISPATCH_PAYLOAD_BYTES,
  PLAYBACK_GENERATION_PATTERN,
  PLAYBACK_STATES,
  assertPlaybackGeneration,
  assertPlaybackState,
  dispatchError,
  normalizeAdmissionInput,
  normalizeBinding,
  normalizeClaimInput,
  normalizeOpenInput,
  normalizeRetryInput,
  normalizeSessionInvalidation,
  normalizeSourceInvalidation,
  normalizeTransitionAndDispatchInput,
  normalizeTransitionInput,
  publicDispatch,
  publicSession,
  requiredStateForEvent,
  sameBinding,
  sameDispatch,
};
