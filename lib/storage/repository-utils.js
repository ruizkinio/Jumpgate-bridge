"use strict";

const crypto = require("node:crypto");

const MAX_DATE_MS = 8640000000000000;
const MAX_MUTATION_FENCE = "9".repeat(128);
const MUTATION_FENCE_PATTERN = /^(?:0|[1-9][0-9]{0,127})$/;

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " must be a plain object");
  }
  return value;
}

function assertIdentifier(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertDisplayName(value, fieldName = "displayName") {
  const name = value === undefined ? "" : value;
  if (typeof name !== "string" || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new TypeError(fieldName + " is invalid");
  }
  return name.trim();
}

function assertRevision(value, allowUndefined = true) {
  if (allowUndefined && value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("expectedRevision is invalid");
  return value;
}

function assertMutationFence(value, name = "mutationFence") {
  if (typeof value !== "string" || !MUTATION_FENCE_PATTERN.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function compareMutationFences(left, right) {
  const safeLeft = assertMutationFence(left, "left mutation fence");
  const safeRight = assertMutationFence(right, "right mutation fence");
  if (safeLeft.length !== safeRight.length) return safeLeft.length < safeRight.length ? -1 : 1;
  if (safeLeft === safeRight) return 0;
  return safeLeft < safeRight ? -1 : 1;
}

function providerMutationFenceExhausted() {
  return codedError(
    "provider_mutation_fence_exhausted",
    "provider mutation fence allocator exhausted"
  );
}

function nextMutationFence(value) {
  const current = assertMutationFence(value, "stored provider mutation fence counter");
  if (current === MAX_MUTATION_FENCE) throw providerMutationFenceExhausted();
  return (BigInt(current) + 1n).toString(10);
}

function mutationFenceOption(options) {
  if (options === undefined) return "0";
  assertPlainObject(options, "options");
  for (const key of Object.keys(options)) {
    if (key !== "mutationFence") throw new TypeError("options contains an unknown field: " + key);
  }
  return options.mutationFence === undefined
    ? "0"
    : assertMutationFence(options.mutationFence);
}

function assertBoundedString(value, name, maximumLength, options = {}) {
  const minimumLength = options.minimumLength ?? 1;
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    (options.trimmed !== false && value.trim() !== value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  if (options.pattern && !options.pattern.test(value)) throw new TypeError(name + " is invalid");
  return value;
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + " is invalid");
  return value;
}

function assertPositiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function parseTimestamp(value, name) {
  const timestamp = typeof value === "string" ? Date.parse(value) : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_MS) {
    throw new TypeError(name + " is invalid");
  }
  return timestamp;
}

function readClock(clock) {
  return parseTimestamp(Number(clock()), "clock timestamp");
}

function addDuration(timestamp, duration, name = "duration") {
  const start = parseTimestamp(timestamp, "timestamp");
  if (!Number.isSafeInteger(duration) || duration < 1 || start > MAX_DATE_MS - duration) {
    throw new TypeError(name + " is invalid");
  }
  return start + duration;
}

function assertJsonSize(value, name, maximumBytes) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (_err) {
    throw new TypeError(name + " is not JSON serializable");
  }
  if (json === undefined) throw new TypeError(name + " is not JSON serializable");
  if (Buffer.byteLength(json, "utf8") > maximumBytes) {
    throw new RangeError(name + " exceeds " + maximumBytes + " bytes");
  }
  return value;
}

function stableScope(namespace, ...parts) {
  const name = assertBoundedString(namespace, "scope namespace", 64, {
    pattern: /^[a-z][a-z0-9-]*$/,
  });
  const hash = crypto.createHash("sha256");
  hash.update("jumpgate-scope:v1\u0000" + name, "utf8");
  for (const part of parts) {
    hash.update("\u0000", "utf8");
    hash.update(String(part), "utf8");
  }
  return hash.digest("hex");
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function revisionConflict() {
  return codedError("revision_conflict", "repository revision conflict");
}

function providerSnapshotStaleFence() {
  return codedError(
    "provider_snapshot_stale_fence",
    "provider snapshot mutation fence is stale"
  );
}

module.exports = {
  MAX_DATE_MS,
  MAX_MUTATION_FENCE,
  addDuration,
  assertBoundedString,
  assertDisplayName,
  assertIdentifier,
  assertJsonSize,
  assertMutationFence,
  assertNonNegativeInteger,
  assertPlainObject,
  assertPositiveInteger,
  assertRevision,
  cloneJson,
  codedError,
  compareMutationFences,
  mutationFenceOption,
  nextMutationFence,
  parseTimestamp,
  readClock,
  providerSnapshotStaleFence,
  providerMutationFenceExhausted,
  revisionConflict,
  stableScope,
};
