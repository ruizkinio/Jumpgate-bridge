"use strict";

const { assertJsonSize, assertPlainObject } = require("./repository-utils");

const ACTIVATION_RETRY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function assertActivationRetryToken(value) {
  if (typeof value !== "string" || !ACTIVATION_RETRY_TOKEN_PATTERN.test(value)) {
    throw new TypeError("activation retry token is invalid");
  }
  const decoded = Buffer.from(value, "base64url");
  try {
    if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
      throw new TypeError("activation retry token is invalid");
    }
  } finally {
    decoded.fill(0);
  }
  return value;
}

function assertSha256Digest(value, name) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError((name || "digest") + " is invalid");
  }
  return value;
}

function canonicalJsonClone(value, name, maximumBytes = 64 * 1024) {
  const label = name || "value";
  const input = assertPlainObject(value, label);
  let encoded;
  let unsafeNumber = false;
  try {
    encoded = JSON.stringify(input, (_key, item) => {
      if (typeof item === "number" && !Number.isSafeInteger(item)) {
        unsafeNumber = true;
        throw new TypeError("unsafe JSON number");
      }
      return item;
    });
  } catch (_error) {
    if (unsafeNumber) throw new TypeError(label + " contains a non-safe integer");
    throw new TypeError(label + " is not JSON serializable");
  }
  if (encoded === undefined) throw new TypeError(label + " is not JSON serializable");
  const cloned = JSON.parse(encoded);
  assertJsonSize(cloned, label, maximumBytes);
  return cloned;
}

module.exports = {
  ACTIVATION_RETRY_TOKEN_PATTERN,
  assertActivationRetryToken,
  assertSha256Digest,
  canonicalJsonClone,
};
