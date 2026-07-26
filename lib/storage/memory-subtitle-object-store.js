"use strict";

const crypto = require("node:crypto");
const {
  OpaqueObjectKeyFactory,
  assertAbortSignal,
  objectStoreError,
} = require("./object-store");

const DEFAULT_MAX_OBJECT_BYTES = 12 * 1024 * 1024;
const HARD_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:; charset=utf-8)?$/;
const CONSTRUCTOR_FIELDS = new Set(["maxObjectBytes", "objectKeyFactory"]);
const PUT_FIELDS = new Set(["checksumSha256", "contentLength", "contentType", "signal"]);
const READ_FIELDS = new Set(["checksumSha256", "contentLength", "maxBytes", "signal"]);
const DELETE_FIELDS = new Set(["checksumSha256", "contentLength", "signal"]);

function assertPlainOptions(value, allowed, name) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " must be a plain object");
  }
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string" || !allowed.has(field)) {
      throw new TypeError(name + " contains an unsupported field");
    }
  }
  return value;
}

function positiveInteger(value, fallback, maximum, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(name + " is invalid");
  }
  return resolved;
}

function contentLength(value, optional = false) {
  if (optional && value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_OBJECT_BYTES) {
    throw new TypeError("object store content length is invalid");
  }
  return value;
}

function checksum(value, optional = false) {
  if (optional && value === undefined) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError("object store SHA-256 checksum is invalid");
  }
  return value;
}

function contentType(value) {
  const resolved = value ?? "application/octet-stream";
  if (
    typeof resolved !== "string" ||
    resolved.length > 128 ||
    !CONTENT_TYPE_PATTERN.test(resolved)
  ) {
    throw new TypeError("object store content type is invalid");
  }
  return resolved;
}

function bodyBytes(value, maximumBytes) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("object store body must be bytes");
  }
  if (value.byteLength < 1) throw new TypeError("object store body must not be empty");
  if (value.byteLength > maximumBytes) {
    throw objectStoreError("object_store_too_large", "put");
  }
  return Buffer.from(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal, operation) {
  const safeSignal = assertAbortSignal(signal);
  if (safeSignal && safeSignal.aborted) {
    throw objectStoreError("object_store_aborted", operation);
  }
  return safeSignal;
}

function assertExpected(record, options, operation) {
  const expectedLength = contentLength(options.contentLength, true);
  const expectedChecksum = checksum(options.checksumSha256, true);
  if (
    (expectedLength !== null && expectedLength !== record.contentLength) ||
    (expectedChecksum !== null && expectedChecksum !== record.checksumSha256)
  ) {
    throw objectStoreError("object_store_integrity", operation);
  }
}

function publicRecord(key, record, additions = {}) {
  return Object.freeze({
    ...additions,
    checksumSha256: record.checksumSha256,
    contentLength: record.contentLength,
    contentType: record.contentType,
    key,
  });
}

class MemorySubtitleObjectStore {
  #keys;
  #maxObjectBytes;
  #objects = new Map();

  constructor(rawOptions = {}) {
    const options = assertPlainOptions(
      rawOptions,
      CONSTRUCTOR_FIELDS,
      "memory subtitle object store options"
    );
    if (!(options.objectKeyFactory instanceof OpaqueObjectKeyFactory)) {
      throw new TypeError("objectKeyFactory must be an OpaqueObjectKeyFactory");
    }
    this.#keys = options.objectKeyFactory;
    this.#maxObjectBytes = positiveInteger(
      options.maxObjectBytes,
      DEFAULT_MAX_OBJECT_BYTES,
      HARD_MAX_OBJECT_BYTES,
      "memory subtitle object byte limit"
    );
  }

  createKey(components) {
    return this.#keys.create(components);
  }

  async put(key, body, rawOptions) {
    const safeKey = this.#keys.assert(key);
    const options = assertPlainOptions(rawOptions, PUT_FIELDS, "object store put options");
    throwIfAborted(options.signal, "put");
    const bytes = bodyBytes(body, this.#maxObjectBytes);
    const record = {
      body: bytes,
      checksumSha256: sha256(bytes),
      contentLength: bytes.length,
      contentType: contentType(options.contentType),
    };
    assertExpected(record, options, "put");
    const existing = this.#objects.get(safeKey);
    if (existing) {
      const same =
        existing.checksumSha256 === record.checksumSha256 &&
        existing.contentLength === record.contentLength &&
        existing.contentType === record.contentType &&
        crypto.timingSafeEqual(existing.body, record.body);
      record.body.fill(0);
      if (!same) throw objectStoreError("object_store_integrity", "put");
      return publicRecord(safeKey, existing);
    }
    throwIfAborted(options.signal, "put");
    this.#objects.set(safeKey, record);
    return publicRecord(safeKey, record);
  }

  async head(key, rawOptions) {
    return this.#read(key, rawOptions, "head", false);
  }

  async get(key, rawOptions) {
    return this.#read(key, rawOptions, "get", true);
  }

  async delete(key, rawOptions) {
    const safeKey = this.#keys.assert(key);
    const options = assertPlainOptions(rawOptions, DELETE_FIELDS, "object store delete options");
    throwIfAborted(options.signal, "delete");
    const record = this.#objects.get(safeKey);
    if (record) {
      assertExpected(record, options, "delete");
      this.#objects.delete(safeKey);
      record.body.fill(0);
    } else {
      contentLength(options.contentLength, true);
      checksum(options.checksumSha256, true);
    }
    return Object.freeze({ deleted: true, key: safeKey });
  }

  #read(key, rawOptions, operation, includeBody) {
    const safeKey = this.#keys.assert(key);
    const options = assertPlainOptions(
      rawOptions,
      READ_FIELDS,
      "object store " + operation + " options"
    );
    throwIfAborted(options.signal, operation);
    const maximumBytes = positiveInteger(
      options.maxBytes,
      this.#maxObjectBytes,
      HARD_MAX_OBJECT_BYTES,
      "object store read byte limit"
    );
    const record = this.#objects.get(safeKey);
    if (!record) throw objectStoreError("object_store_not_found", operation);
    if (record.contentLength > maximumBytes) {
      throw objectStoreError("object_store_too_large", operation);
    }
    assertExpected(record, options, operation);
    return publicRecord(
      safeKey,
      record,
      includeBody ? { body: Buffer.from(record.body) } : {}
    );
  }
}

module.exports = {
  DEFAULT_MEMORY_SUBTITLE_OBJECT_BYTES: DEFAULT_MAX_OBJECT_BYTES,
  HARD_MEMORY_SUBTITLE_OBJECT_BYTES: HARD_MAX_OBJECT_BYTES,
  MemorySubtitleObjectStore,
};
