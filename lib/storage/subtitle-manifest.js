"use strict";

const {
  assertBoundedString,
  assertIdentifier,
  assertPlainObject,
  assertPositiveInteger,
  assertRevision,
  cloneJson,
} = require("./repository-utils");

const MAX_PARTS = 2;
const MAX_LEASE_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + " is invalid");
  return value;
}

function decimal(value, name) {
  const text = assertBoundedString(value, name, 128, { pattern: /^\d+$/ });
  if (text.length > 1 && text.startsWith("0")) throw new TypeError(name + " is invalid");
  return text;
}

function normalizeParts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTS) {
    throw new TypeError("subtitle manifest parts are invalid");
  }
  const objectKeys = new Set();
  return value.map((raw, index) => {
    const part = assertPlainObject(raw, "subtitle manifest part");
    const partNumber = assertPositiveInteger(part.partNumber, "subtitle part number", MAX_PARTS);
    if (partNumber !== index + 1) throw new TypeError("subtitle manifest parts are not ordered");
    const objectKey = assertBoundedString(part.objectKey, "subtitle object key", 1024);
    if (objectKeys.has(objectKey)) throw new TypeError("subtitle object key is duplicated");
    objectKeys.add(objectKey);
    return {
      partNumber,
      objectKey,
      sizeBytes: assertPositiveInteger(part.sizeBytes, "subtitle object size", 64 * 1024 * 1024),
      checksum: assertBoundedString(part.checksum, "subtitle object checksum", 64, {
        pattern: /^[a-f0-9]{64}$/,
      }),
      mediaType: assertBoundedString(part.mediaType, "subtitle object media type", 128),
    };
  });
}

function normalizeManifest(input) {
  const value = assertPlainObject(input, "subtitle manifest");
  const expiresAt = timestamp(value.expiresAt, "subtitle manifest expiry");
  const uploadSettlementDeadline = timestamp(
    value.uploadSettlementDeadline,
    "subtitle upload settlement deadline"
  );
  return {
    profileId: assertIdentifier(value.profileId, "profile id"),
    profileRevision: assertRevision(value.profileRevision, false),
    deviceId: assertIdentifier(value.deviceId, "device id"),
    deviceGeneration: assertPositiveInteger(
      value.deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    ),
    artifactId: assertIdentifier(value.artifactId, "artifact id"),
    sessionId: assertIdentifier(value.sessionId, "session id"),
    playbackGeneration: assertBoundedString(
      value.playbackGeneration,
      "playback generation",
      256
    ),
    contextRevision: decimal(value.contextRevision, "context revision"),
    providerRevision: decimal(value.providerRevision, "provider revision"),
    expiresAt,
    uploadSettlementDeadline,
    parts: normalizeParts(value.parts),
  };
}

function normalizeReason(value, fallback) {
  return assertBoundedString(value === undefined ? fallback : value, "subtitle deletion reason", 64);
}

function normalizeDeletionClaim(options) {
  const value = assertPlainObject(options, "subtitle manifest deletion claim");
  return {
    workerId: assertBoundedString(value.workerId, "subtitle deletion worker id", 256),
    leaseMs: assertPositiveInteger(value.leaseMs, "subtitle deletion lease", MAX_LEASE_MS),
  };
}

function normalizeAbsence(input) {
  const value = assertPlainObject(input, "subtitle deletion absence");
  return {
    artifactId: assertIdentifier(value.artifactId, "artifact id"),
    deletionToken: assertBoundedString(value.deletionToken, "subtitle deletion token", 1024),
    secondPassDelayMs: assertPositiveInteger(
      value.secondPassDelayMs,
      "subtitle deletion second pass delay",
      MAX_DELAY_MS
    ),
    verifiedAbsent: value.verifiedAbsent === true,
  };
}

function normalizeRetry(input) {
  const value = assertPlainObject(input, "subtitle deletion retry");
  return {
    artifactId: assertIdentifier(value.artifactId, "artifact id"),
    deletionToken: assertBoundedString(value.deletionToken, "subtitle deletion token", 1024),
    retryDelayMs: assertPositiveInteger(
      value.retryDelayMs,
      "subtitle deletion retry",
      MAX_DELAY_MS
    ),
  };
}

function normalizeConfirmation(input) {
  const value = assertPlainObject(input, "subtitle deletion confirmation");
  return {
    artifactId: assertIdentifier(value.artifactId, "artifact id"),
    deletionToken: assertBoundedString(value.deletionToken, "subtitle deletion token", 1024),
    verifiedAbsent: value.verifiedAbsent === true,
  };
}

function sameManifest(record, candidate) {
  for (const field of [
    "profileId",
    "profileRevision",
    "deviceId",
    "deviceGeneration",
    "artifactId",
    "sessionId",
    "playbackGeneration",
    "contextRevision",
    "providerRevision",
    "expiresAt",
    "uploadSettlementDeadline",
  ]) {
    if (record[field] !== candidate[field]) return false;
  }
  if (!Array.isArray(record.parts) || record.parts.length !== candidate.parts.length) return false;
  return candidate.parts.every((part, index) => {
    const stored = record.parts[index];
    return stored &&
      stored.partNumber === part.partNumber &&
      stored.objectKey === part.objectKey &&
      stored.sizeBytes === part.sizeBytes &&
      stored.checksum === part.checksum &&
      stored.mediaType === part.mediaType;
  });
}

function publicManifest(record) {
  const copy = cloneJson(record);
  delete copy.leaseTokenHash;
  return Object.freeze(copy);
}

module.exports = {
  MAX_DELAY_MS,
  MAX_LEASE_MS,
  normalizeAbsence,
  normalizeConfirmation,
  normalizeDeletionClaim,
  normalizeManifest,
  normalizeReason,
  normalizeRetry,
  publicManifest,
  sameManifest,
  timestamp,
};
