"use strict";

const crypto = require("node:crypto");

const OBJECT_STORE_METHODS = Object.freeze(["createKey", "put", "head", "get", "delete"]);
const OBJECT_STORE_OPERATIONS = new Set(["put", "head", "get", "delete"]);
const OBJECT_STORE_ERROR_MESSAGES = Object.freeze({
  object_store_aborted: "object storage operation canceled",
  object_store_integrity: "object storage integrity verification failed",
  object_store_not_found: "object storage object was not found",
  object_store_timeout: "object storage operation timed out",
  object_store_too_large: "object storage object exceeds the byte limit",
  object_store_unavailable: "object storage operation failed",
});
const KEY_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,31}\/v[1-9][0-9]*$/;
const KEY_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const OPAQUE_COMPONENT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_MAX_KEY_COMPONENTS = 8;
const MAX_HMAC_KEYS = 8;
const MAX_KEY_COMPONENT_BYTES = 1024;
const KEY_FACTORY_FIELDS = new Set(["currentKeyId", "keyring", "maximumComponents", "prefix"]);
const KEYRING_ENTRY_FIELDS = new Set(["id", "secret"]);

class ObjectStoreError extends Error {
  constructor(code, operation) {
    const message = OBJECT_STORE_ERROR_MESSAGES[code];
    if (!message) throw new TypeError("object store error code is invalid");
    if (operation !== undefined && !OBJECT_STORE_OPERATIONS.has(operation)) {
      throw new TypeError("object store operation is invalid");
    }
    super(message);
    this.name = "ObjectStoreError";
    this.code = code;
    if (operation !== undefined) this.operation = operation;
    this.retryable = code === "object_store_timeout" || code === "object_store_unavailable";
  }
}

function objectStoreError(code, operation) {
  return new ObjectStoreError(code, operation);
}

function assertObjectStore(store) {
  if (!store || (typeof store !== "object" && typeof store !== "function")) {
    throw new TypeError("object store is required");
  }
  for (const method of OBJECT_STORE_METHODS) {
    if (typeof store[method] !== "function") {
      throw new TypeError("object store must implement " + method + "()");
    }
  }
  return store;
}

function assertAbortSignal(signal) {
  if (signal === undefined) return null;
  if (
    !signal ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("object store signal is invalid");
  }
  return signal;
}

function assertKeyPrefix(value) {
  if (typeof value !== "string" || !KEY_PREFIX_PATTERN.test(value)) {
    throw new TypeError("object key prefix is invalid");
  }
  return value;
}

function assertMaximumComponents(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_KEY_COMPONENTS) {
    throw new TypeError("object key component limit is invalid");
  }
  return value;
}

function assertOnlyFields(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " is invalid");
  }
  if (
    Reflect.ownKeys(value).some(
      (field) => typeof field !== "string" || !fields.has(field)
    )
  ) {
    throw new TypeError(name + " contains unsupported fields");
  }
  return value;
}

function assertKeyId(value) {
  if (typeof value !== "string" || !KEY_ID_PATTERN.test(value)) {
    throw new TypeError("object key HMAC key id is invalid");
  }
  return value;
}

function copyHmacSecret(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("object key HMAC secret is invalid");
  }
  const secret = Buffer.from(value);
  if (secret.length < 32 || secret.length > 64) {
    secret.fill(0);
    throw new TypeError("object key HMAC secret is invalid");
  }
  return secret;
}

function copyHmacKeyring(value, currentKeyId) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_HMAC_KEYS) {
    throw new TypeError("object key HMAC keyring is invalid");
  }
  const keys = new Map();
  try {
    for (const rawEntry of value) {
      const entry = assertOnlyFields(
        rawEntry,
        KEYRING_ENTRY_FIELDS,
        "object key HMAC keyring entry"
      );
      const id = assertKeyId(entry.id);
      if (keys.has(id)) throw new TypeError("object key HMAC keyring is invalid");
      keys.set(id, copyHmacSecret(entry.secret));
    }
    if (!keys.has(currentKeyId)) {
      throw new TypeError("object key current HMAC key is missing");
    }
    return keys;
  } catch (error) {
    for (const secret of keys.values()) secret.fill(0);
    throw error;
  }
}

function componentBytes(value) {
  let bytes;
  if (typeof value === "string") {
    bytes = Buffer.from(value, "utf8");
    if (bytes.toString("utf8") !== value) {
      throw new TypeError("object key component is invalid");
    }
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    bytes = Buffer.from(value);
  } else {
    throw new TypeError("object key component is invalid");
  }
  if (bytes.length < 1 || bytes.length > MAX_KEY_COMPONENT_BYTES) {
    bytes.fill(0);
    throw new TypeError("object key component is invalid");
  }
  return bytes;
}

function digestComponent(secret, prefix, keyId, index, value) {
  const bytes = componentBytes(value);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  try {
    return crypto
      .createHmac("sha256", secret)
      .update("jumpgate-object-key:component:v2\0", "utf8")
      .update(prefix, "ascii")
      .update("\0", "ascii")
      .update(keyId, "ascii")
      .update("\0", "ascii")
      .update(Buffer.from([index]))
      .update(length)
      .update(bytes)
      .digest("base64url");
  } finally {
    bytes.fill(0);
    length.fill(0);
  }
}

function digestKeyTag(secret, prefix, keyId, components) {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update("jumpgate-object-key:tag:v2\0", "utf8")
    .update(prefix, "ascii")
    .update("\0", "ascii")
    .update(keyId, "ascii")
    .update("\0", "ascii")
    .update(Buffer.from([components.length]));
  for (const component of components) hmac.update(component, "ascii");
  return hmac.digest("base64url");
}

function parseOpaqueKey(value, prefix, maximumComponents) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f\\%]/.test(value)
  ) {
    throw new TypeError("object key is invalid");
  }
  const segments = value.split("/");
  const prefixSegments = prefix.split("/");
  if (
    segments.length < prefixSegments.length + 3 ||
    segments.length > prefixSegments.length + maximumComponents + 2 ||
    prefixSegments.some((segment, index) => segments[index] !== segment)
  ) {
    throw new TypeError("object key is invalid");
  }
  const keyId = segments[prefixSegments.length];
  if (!KEY_ID_PATTERN.test(keyId)) throw new TypeError("object key is invalid");
  const opaque = segments.slice(prefixSegments.length + 1);
  if (opaque.some((component) => !OPAQUE_COMPONENT_PATTERN.test(component))) {
    throw new TypeError("object key is invalid");
  }
  return { keyId, opaque };
}

class OpaqueObjectKeyFactory {
  #currentKeyId;
  #keys;
  #maximumComponents;
  #prefix;

  constructor(options = {}) {
    assertOnlyFields(options, KEY_FACTORY_FIELDS, "object key options");
    this.#prefix = assertKeyPrefix(options.prefix);
    this.#maximumComponents = assertMaximumComponents(
      options.maximumComponents ?? DEFAULT_MAX_KEY_COMPONENTS
    );
    this.#currentKeyId = assertKeyId(options.currentKeyId);
    this.#keys = copyHmacKeyring(options.keyring, this.#currentKeyId);
  }

  create(components) {
    if (
      !Array.isArray(components) ||
      components.length < 1 ||
      components.length > this.#maximumComponents
    ) {
      throw new TypeError("object key components are invalid");
    }
    const secret = this.#keys.get(this.#currentKeyId);
    const opaque = components.map((component, index) =>
      digestComponent(secret, this.#prefix, this.#currentKeyId, index, component)
    );
    const tag = digestKeyTag(secret, this.#prefix, this.#currentKeyId, opaque);
    return this.#prefix + "/" + this.#currentKeyId + "/" + opaque.concat(tag).join("/");
  }

  namespacePrefixes(components) {
    if (
      !Array.isArray(components) ||
      components.length < 1 ||
      components.length >= this.#maximumComponents
    ) {
      throw new TypeError("object key namespace components are invalid");
    }
    const prefixes = [];
    for (const [keyId, secret] of this.#keys) {
      const opaque = components.map((component, index) =>
        digestComponent(secret, this.#prefix, keyId, index, component)
      );
      prefixes.push(this.#prefix + "/" + keyId + "/" + opaque.join("/") + "/");
    }
    return Object.freeze(prefixes);
  }

  assert(value) {
    const { keyId, opaque } = parseOpaqueKey(value, this.#prefix, this.#maximumComponents);
    const secret = this.#keys.get(keyId);
    if (!secret) throw new TypeError("object key is invalid");
    const components = opaque.slice(0, -1);
    const encodedTag = opaque[opaque.length - 1];
    const actualTag = Buffer.from(encodedTag, "base64url");
    const expectedTag = Buffer.from(
      digestKeyTag(secret, this.#prefix, keyId, components),
      "base64url"
    );
    const valid =
      actualTag.toString("base64url") === encodedTag &&
      actualTag.length === expectedTag.length &&
      crypto.timingSafeEqual(actualTag, expectedTag);
    actualTag.fill(0);
    expectedTag.fill(0);
    if (!valid) throw new TypeError("object key is invalid");
    return value;
  }
}

module.exports = {
  OBJECT_STORE_METHODS,
  ObjectStoreError,
  OpaqueObjectKeyFactory,
  assertAbortSignal,
  assertObjectStore,
  objectStoreError,
};
