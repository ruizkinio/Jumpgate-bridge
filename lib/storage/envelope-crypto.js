"use strict";

const crypto = require("node:crypto");

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PURPOSE_PATTERN = /^[a-z][a-z0-9:-]{0,127}$/;
const ENVELOPE_VERSION = 1;
const ENVELOPE_ALGORITHM = "A256GCM";

function decodeBase64Url(value, name, expectedLength, maximumLength) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(name + " is malformed");
  }
  const decoded = Buffer.from(value, "base64url");
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new TypeError(name + " has an invalid length");
  }
  if (maximumLength !== undefined && decoded.length > maximumLength) {
    throw new RangeError(name + " exceeds the maximum length");
  }
  return decoded;
}

function assertPurpose(purpose) {
  if (typeof purpose !== "string" || !PURPOSE_PATTERN.test(purpose)) {
    throw new TypeError("envelope purpose is invalid");
  }
  return purpose;
}

function decodeEnvelope(envelope, maximumCiphertextBytes) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("envelope is malformed");
  }
  if (envelope.v !== ENVELOPE_VERSION || envelope.alg !== ENVELOPE_ALGORITHM) {
    throw new TypeError("envelope version or algorithm is unsupported");
  }
  const keyId = String(envelope.kid || "");
  if (!KEY_ID_PATTERN.test(keyId)) throw new TypeError("envelope key id is malformed");
  return {
    keyId,
    iv: decodeBase64Url(envelope.iv, "envelope iv", 12),
    tag: decodeBase64Url(envelope.tag, "envelope tag", 16),
    ciphertext: decodeBase64Url(
      envelope.ct,
      "envelope ciphertext",
      undefined,
      maximumCiphertextBytes
    ),
  };
}

function validateEnvelope(envelope, maximumCiphertextBytes = 16 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximumCiphertextBytes) || maximumCiphertextBytes < 1) {
    throw new TypeError("maximumCiphertextBytes is invalid");
  }
  decodeEnvelope(envelope, maximumCiphertextBytes);
  return envelope;
}

class EnvelopeCrypto {
  constructor(options = {}) {
    const sourceKeys = options.keys instanceof Map ? options.keys : new Map(Object.entries(options.keys || {}));
    this._keys = new Map();
    for (const [keyId, key] of sourceKeys) {
      if (!KEY_ID_PATTERN.test(String(keyId)) || !Buffer.isBuffer(key) || key.length !== 32) {
        throw new TypeError("envelope keys must be named 32-byte Buffers");
      }
      this._keys.set(String(keyId), Buffer.from(key));
    }

    this._primaryKeyId = String(options.primaryKeyId || "");
    if (!this._keys.has(this._primaryKeyId)) throw new TypeError("primary envelope key is unavailable");
    this._randomBytes = options.randomBytes || crypto.randomBytes;
    if (typeof this._randomBytes !== "function") throw new TypeError("randomBytes must be a function");
    this._maxPlaintextBytes = options.maxPlaintextBytes ?? 4 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this._maxPlaintextBytes) ||
      this._maxPlaintextBytes < 1024 ||
      this._maxPlaintextBytes > 16 * 1024 * 1024
    ) {
      throw new TypeError("maxPlaintextBytes is invalid");
    }
  }

  encryptJson(value, purpose) {
    const scopedPurpose = assertPurpose(purpose);
    let json;
    try {
      json = JSON.stringify(value);
    } catch (_err) {
      throw new TypeError("value is not JSON serializable");
    }
    if (json === undefined) throw new TypeError("value is not JSON serializable");

    const plaintext = Buffer.from(json, "utf8");
    if (plaintext.length > this._maxPlaintextBytes) {
      plaintext.fill(0);
      throw new RangeError("envelope plaintext exceeds the maximum length");
    }

    try {
      const iv = this._randomBytes(12);
      if (!Buffer.isBuffer(iv) || iv.length !== 12) throw new TypeError("randomBytes returned an invalid IV");
      const key = this._keys.get(this._primaryKeyId);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(this._aad(scopedPurpose, this._primaryKeyId));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        v: ENVELOPE_VERSION,
        alg: ENVELOPE_ALGORITHM,
        kid: this._primaryKeyId,
        iv: iv.toString("base64url"),
        tag: tag.toString("base64url"),
        ct: ciphertext.toString("base64url"),
      };
    } finally {
      plaintext.fill(0);
    }
  }

  decryptJson(envelope, purpose) {
    const scopedPurpose = assertPurpose(purpose);
    const decoded = decodeEnvelope(envelope, this._maxPlaintextBytes);
    const keyId = decoded.keyId;
    const key = this._keys.get(keyId);
    if (!key) throw new Error("envelope key is unavailable");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, decoded.iv);
    decipher.setAAD(this._aad(scopedPurpose, keyId));
    decipher.setAuthTag(decoded.tag);

    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(decoded.ciphertext), decipher.final()]);
    } catch (_err) {
      throw new Error("envelope authentication failed");
    }
    if (plaintext.length > this._maxPlaintextBytes) {
      plaintext.fill(0);
      throw new RangeError("envelope plaintext exceeds the maximum length");
    }

    try {
      return JSON.parse(plaintext.toString("utf8"));
    } catch (_err) {
      throw new Error("envelope plaintext is invalid JSON");
    } finally {
      plaintext.fill(0);
    }
  }

  needsRotation(envelope) {
    return (
      !envelope ||
      envelope.v !== ENVELOPE_VERSION ||
      envelope.alg !== ENVELOPE_ALGORITHM ||
      envelope.kid !== this._primaryKeyId
    );
  }

  reencryptJson(envelope, purpose) {
    const value = this.decryptJson(envelope, purpose);
    return this.encryptJson(value, purpose);
  }

  _aad(purpose, keyId) {
    return Buffer.from("jumpgate-envelope:v1\u0000" + purpose + "\u0000" + keyId, "utf8");
  }
}

module.exports = {
  EnvelopeCrypto,
  validateEnvelope,
};
