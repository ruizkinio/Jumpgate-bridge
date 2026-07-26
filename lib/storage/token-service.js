"use strict";

const crypto = require("node:crypto");

const PURPOSE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/;

function assertPurpose(purpose) {
  if (typeof purpose !== "string" || !PURPOSE_PATTERN.test(purpose)) {
    throw new TypeError("token purpose is invalid");
  }
  return purpose;
}

function assertOpaqueValue(value, name, maximumLength) {
  if (typeof value !== "string" || !value || value.length > maximumLength) {
    throw new TypeError(name + " is invalid");
  }
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

class TokenService {
  constructor(options = {}) {
    const pepper = options.pepper;
    if (!Buffer.isBuffer(pepper) || pepper.length < 32) {
      throw new TypeError("token pepper must be a Buffer of at least 32 bytes");
    }
    this._pepper = Buffer.from(pepper);
    this._randomBytes = options.randomBytes || crypto.randomBytes;
    if (typeof this._randomBytes !== "function") throw new TypeError("randomBytes must be a function");
  }

  issue(purpose, byteLength = 32) {
    const scopedPurpose = assertPurpose(purpose);
    if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64) {
      throw new TypeError("token byte length must be between 16 and 64");
    }
    const random = this._randomBytes(byteLength);
    if (!Buffer.isBuffer(random) || random.length !== byteLength) {
      throw new TypeError("randomBytes returned an invalid token buffer");
    }
    try {
      const token = random.toString("base64url");
      return { token, tokenHash: this.hashToken(scopedPurpose, token) };
    } finally {
      random.fill(0);
    }
  }

  hashToken(purpose, token) {
    const scopedPurpose = assertPurpose(purpose);
    const value = assertOpaqueValue(token, "token", 512);
    if (!TOKEN_PATTERN.test(value)) throw new TypeError("token is invalid");
    return this._hash(scopedPurpose, value);
  }

  hashOpaque(purpose, value, maximumLength = 8192) {
    const scopedPurpose = assertPurpose(purpose);
    if (!Number.isSafeInteger(maximumLength) || maximumLength < 1 || maximumLength > 1024 * 1024) {
      throw new TypeError("maximumLength is invalid");
    }
    return this._hash(scopedPurpose, assertOpaqueValue(value, "opaque value", maximumLength));
  }

  matchesToken(purpose, token, expectedHash) {
    if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
    let actualHash;
    try {
      actualHash = this.hashToken(purpose, token);
    } catch (_err) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(actualHash, "hex"), Buffer.from(expectedHash, "hex"));
  }

  _hash(purpose, value) {
    return crypto
      .createHmac("sha256", this._pepper)
      .update("jumpgate-token:v1\u0000" + purpose + "\u0000" + value, "utf8")
      .digest("hex");
  }
}

module.exports = {
  TokenService,
};
