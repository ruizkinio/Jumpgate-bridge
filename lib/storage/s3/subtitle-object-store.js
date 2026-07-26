"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const {
  ObjectStoreError,
  OpaqueObjectKeyFactory,
  assertAbortSignal,
  objectStoreError,
} = require("../object-store");

const DEFAULT_MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const HARD_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const HARD_MAX_REQUEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RESPONSE_CHUNKS = 4096;
const HARD_MAX_RESPONSE_CHUNKS = 8192;
const MAX_PERMANENT_ERASURE_ROUNDS = 8;
const MAX_VERSION_PAGES_PER_SCAN = 64;
const MAX_VERSIONS_PER_SCAN = 4096;
const VERSION_PAGE_SIZE = 1000;
const PUT_ATTEMPT_NONCE_BYTES = 32;
const DEFAULT_ENDPOINT_ALLOWLIST = Object.freeze([
  "https://t3.storage.dev",
  "https://fly.storage.tigris.dev",
]);
const KEY_PREFIX = "subtitles/v1";
const METADATA = Object.freeze({
  contentLength: "jumpgate-content-length",
  putAttempt: "jumpgate-put-attempt",
  schema: "jumpgate-schema",
  sha256: "jumpgate-sha256",
});
const CONFIG_FIELDS = new Set([
  "allowInjectedClient",
  "allowPrivateEndpoint",
  "allowUnlistedEndpoint",
  "bucket",
  "client",
  "endpoint",
  "endpointAllowlist",
  "forcePathStyle",
  "keyHmacCurrentKeyId",
  "keyHmacKeyring",
  "maxObjectBytes",
  "maxResponseChunks",
  "region",
  "requestTimeoutMs",
  "serverSideEncryption",
  "sseResponsePolicy",
]);
const PUT_OPTION_FIELDS = new Set([
  "checksumSha256",
  "contentLength",
  "contentType",
  "signal",
]);
const READ_OPTION_FIELDS = new Set([
  "checksumSha256",
  "contentLength",
  "maxBytes",
  "signal",
  "versionId",
]);
const DELETE_OPTION_FIELDS = new Set(["checksumSha256", "contentLength", "signal"]);
const NAMESPACE_PURGE_OPTION_FIELDS = new Set(["signal"]);
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}(?:; charset=utf-8)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INTERRUPTION = Symbol("object-store-interruption");
const NON_PUBLIC_ENDPOINTS = new net.BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) {
  NON_PUBLIC_ENDPOINTS.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
]) {
  NON_PUBLIC_ENDPOINTS.addSubnet(network, prefix, "ipv6");
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertOnlyFields(value, allowed, name) {
  assertPlainObject(value, name);
  if (
    Reflect.ownKeys(value).some(
      (field) => typeof field !== "string" || !allowed.has(field)
    )
  ) {
    throw new TypeError(name + " contains unsupported fields");
  }
  return value;
}

function parseEndpoint(value, name = "object store endpoint") {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch (_error) {
    throw new TypeError(name + " is invalid");
  }
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw new TypeError(name + " is invalid");
  }
  return endpoint;
}

function endpointHostname(endpoint) {
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

function isNonPublicEndpoint(endpoint) {
  const hostname = endpointHostname(endpoint);
  const family = net.isIP(hostname);
  if (family === 4) return NON_PUBLIC_ENDPOINTS.check(hostname, "ipv4");
  if (family === 6) {
    if (hostname.startsWith("::")) return true;
    return NON_PUBLIC_ENDPOINTS.check(hostname, "ipv6");
  }
  return (
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  );
}

function validateBoolean(value, fallback, name) {
  const result = value ?? fallback;
  if (typeof result !== "boolean") throw new TypeError(name + " is invalid");
  return result;
}

function validateEndpointAllowlist(value) {
  const rawAllowlist = value ?? DEFAULT_ENDPOINT_ALLOWLIST;
  if (!Array.isArray(rawAllowlist) || rawAllowlist.length < 1 || rawAllowlist.length > 16) {
    throw new TypeError("object store endpoint allowlist is invalid");
  }
  const allowlist = new Set();
  for (const rawOrigin of rawAllowlist) {
    const origin = parseEndpoint(
      rawOrigin,
      "object store endpoint allowlist entry"
    ).origin;
    if (allowlist.has(origin)) {
      throw new TypeError("object store endpoint allowlist is invalid");
    }
    allowlist.add(origin);
  }
  return allowlist;
}

function validateEndpoint(value, options) {
  const endpoint = parseEndpoint(value);
  if (!options.allowPrivateEndpoint && isNonPublicEndpoint(endpoint)) {
    throw new TypeError("object store endpoint is not public");
  }
  if (!options.allowUnlistedEndpoint && !options.endpointAllowlist.has(endpoint.origin)) {
    throw new TypeError("object store endpoint is not trusted");
  }
  return endpoint.origin;
}

function validateBucket(value) {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 63 ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    value.includes("..") ||
    value.includes(".-") ||
    value.includes("-.") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  ) {
    throw new TypeError("object store bucket is invalid");
  }
  return value;
}

function validateRegion(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  ) {
    throw new TypeError("object store region is invalid");
  }
  return value;
}

function readPositiveInteger(value, fallback, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new TypeError(name + " is invalid");
  }
  return result;
}

function validateClient(value, allowInjectedClient) {
  if (value === undefined) return null;
  if (!allowInjectedClient) {
    throw new TypeError("object store injected S3 client is not enabled");
  }
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError("object store S3 client is invalid");
  }
  try {
    if (typeof value.send !== "function") {
      throw new TypeError("object store S3 client is invalid");
    }
  } catch (_error) {
    throw new TypeError("object store S3 client is invalid");
  }
  return value;
}

function validateConfig(rawOptions) {
  const options = assertOnlyFields(rawOptions, CONFIG_FIELDS, "object store config");
  const allowInjectedClient = validateBoolean(
    options.allowInjectedClient,
    false,
    "object store injected-client opt-in"
  );
  const allowPrivateEndpoint = validateBoolean(
    options.allowPrivateEndpoint,
    false,
    "object store private-endpoint opt-in"
  );
  const allowUnlistedEndpoint = validateBoolean(
    options.allowUnlistedEndpoint,
    false,
    "object store unlisted-endpoint opt-in"
  );
  const endpointAllowlist = validateEndpointAllowlist(options.endpointAllowlist);
  const forcePathStyle = validateBoolean(
    options.forcePathStyle,
    false,
    "object store forcePathStyle"
  );
  const serverSideEncryption = Object.prototype.hasOwnProperty.call(
    options,
    "serverSideEncryption"
  )
    ? options.serverSideEncryption
    : "AES256";
  if (serverSideEncryption !== null && serverSideEncryption !== "AES256") {
    throw new TypeError("object store server-side encryption is invalid");
  }
  const sseResponsePolicy = options.sseResponsePolicy ?? "required";
  if (!new Set(["allow-missing", "disabled", "required"]).has(sseResponsePolicy)) {
    throw new TypeError("object store SSE response policy is invalid");
  }
  if (
    (serverSideEncryption === null && sseResponsePolicy !== "disabled") ||
    (serverSideEncryption !== null && sseResponsePolicy === "disabled")
  ) {
    throw new TypeError("object store SSE configuration is inconsistent");
  }
  return {
    bucket: validateBucket(options.bucket),
    client: validateClient(options.client, allowInjectedClient),
    endpoint: validateEndpoint(options.endpoint, {
      allowPrivateEndpoint,
      allowUnlistedEndpoint,
      endpointAllowlist,
    }),
    forcePathStyle,
    keyHmacCurrentKeyId: options.keyHmacCurrentKeyId,
    keyHmacKeyring: options.keyHmacKeyring,
    maxObjectBytes: readPositiveInteger(
      options.maxObjectBytes,
      DEFAULT_MAX_OBJECT_BYTES,
      HARD_MAX_OBJECT_BYTES,
      "object store maximum object bytes"
    ),
    maxResponseChunks: readPositiveInteger(
      options.maxResponseChunks,
      DEFAULT_MAX_RESPONSE_CHUNKS,
      HARD_MAX_RESPONSE_CHUNKS,
      "object store maximum response chunks"
    ),
    region: validateRegion(options.region),
    requestTimeoutMs: readPositiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      HARD_MAX_REQUEST_TIMEOUT_MS,
      "object store request timeout"
    ),
    serverSideEncryption,
    sseResponsePolicy,
  };
}

function readOperationOptions(rawOptions, allowed, name) {
  if (rawOptions === undefined) return {};
  return assertOnlyFields(rawOptions, allowed, name);
}

function validateContentType(value) {
  const contentType = value ?? "application/octet-stream";
  if (
    typeof contentType !== "string" ||
    contentType.length > 128 ||
    !CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw new TypeError("object store content type is invalid");
  }
  return contentType;
}

function validateChecksum(value, optional = false) {
  if (optional && value === undefined) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError("object store SHA-256 checksum is invalid");
  }
  return value;
}

function validateContentLength(value, optional = false) {
  if (optional && value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > HARD_MAX_OBJECT_BYTES) {
    throw new TypeError("object store content length is invalid");
  }
  return value;
}

function validateBody(value, maximumBytes) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("object store body must be bytes");
  }
  if (value.byteLength < 1) throw new TypeError("object store body must not be empty");
  if (value.byteLength > maximumBytes) {
    throw objectStoreError("object_store_too_large", "put");
  }
  return Buffer.from(value);
}

function checksumHex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function checksumBase64(hex) {
  return Buffer.from(hex, "hex").toString("base64");
}

function createPutAttemptNonce() {
  try {
    return crypto.randomBytes(PUT_ATTEMPT_NONCE_BYTES).toString("base64url");
  } catch (_error) {
    throw objectStoreError("object_store_unavailable", "put");
  }
}

function integrityError(operation) {
  return objectStoreError("object_store_integrity", operation);
}

function isObjectStoreError(error, code) {
  try {
    return error instanceof ObjectStoreError && (code === undefined || error.code === code);
  } catch (_error) {
    return false;
  }
}

function assertExpectedRecord(record, options, operation) {
  const expectedLength = validateContentLength(options.contentLength, true);
  const expectedChecksum = validateChecksum(options.checksumSha256, true);
  if (
    (expectedLength !== null && record.contentLength !== expectedLength) ||
    (expectedChecksum !== null && record.checksumSha256 !== expectedChecksum)
  ) {
    throw integrityError(operation);
  }
}

function normalizeMetadata(rawMetadata, operation) {
  if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    throw integrityError(operation);
  }
  const metadata = new Map();
  for (const [name, value] of Object.entries(rawMetadata)) {
    const normalizedName = String(name).toLowerCase();
    if (metadata.has(normalizedName) || typeof value !== "string") {
      throw integrityError(operation);
    }
    metadata.set(normalizedName, value);
  }
  return metadata;
}

function assertSseConfirmation(response, options) {
  if (!options.serverSideEncryption) return;
  const actual = response && response.ServerSideEncryption;
  if (actual === options.serverSideEncryption) return;
  if (actual === undefined && options.sseResponsePolicy === "allow-missing") return;
  throw integrityError(options.operation);
}

function readStoredRecord(response, options) {
  const operation = options.operation;
  const versionId = normalizeResponseVersionId(
    response && response.VersionId,
    "response version id",
    operation
  );
  if (options.versionId !== null && versionId !== options.versionId) {
    throw integrityError(operation);
  }
  const contentLength = response && response.ContentLength;
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    throw integrityError(operation);
  }
  if (contentLength > options.maximumBytes) {
    throw objectStoreError("object_store_too_large", operation);
  }
  const metadata = normalizeMetadata(response.Metadata, operation);
  const metadataLength = metadata.get(METADATA.contentLength);
  const storedChecksum = metadata.get(METADATA.sha256);
  if (
    metadata.get(METADATA.schema) !== "1" ||
    typeof metadataLength !== "string" ||
    !/^[1-9][0-9]*$/.test(metadataLength) ||
    Number(metadataLength) !== contentLength ||
    typeof storedChecksum !== "string" ||
    !SHA256_PATTERN.test(storedChecksum)
  ) {
    throw integrityError(operation);
  }
  const contentType = response.ContentType;
  if (
    typeof contentType !== "string" ||
    contentType.length > 128 ||
    !CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw integrityError(operation);
  }
  if (
    response.ChecksumSHA256 !== undefined &&
    response.ChecksumSHA256 !== checksumBase64(storedChecksum)
  ) {
    throw integrityError(operation);
  }
  assertSseConfirmation(response, options);
  return Object.freeze({
    checksumSha256: storedChecksum,
    contentLength,
    contentType,
    ...(options.putAttemptNonce === undefined
      ? {}
      : { putAttemptMatched: metadata.get(METADATA.putAttempt) === options.putAttemptNonce }),
    ...(versionId === null ? {} : { versionId }),
  });
}

function recreateObjectStoreError(error, operation, fallbackCode) {
  try {
    if (error instanceof ObjectStoreError) return objectStoreError(error.code, operation);
  } catch (_error) {
    // Never trust mutable properties on errors received across the client boundary.
  }
  return objectStoreError(fallbackCode, operation);
}

function parseStoredRecord(response, options) {
  try {
    return readStoredRecord(response, options);
  } catch (error) {
    throw recreateObjectStoreError(error, options.operation, "object_store_integrity");
  }
}

function serviceErrorNames(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return new Set();
  try {
    return new Set(
      [error.name, error.code, error.Code]
        .filter((value) => typeof value === "string")
        .map((value) => value.toLowerCase())
    );
  } catch (_error) {
    return new Set();
  }
}

function responseStatus(error) {
  try {
    const status = error && error.$metadata && error.$metadata.httpStatusCode;
    return Number.isSafeInteger(status) ? status : null;
  } catch (_error) {
    return null;
  }
}

function isCanonicalExactVersionHeadNotFound(
  error,
  operation,
  options,
  names,
  status
) {
  if (
    operation !== "head" ||
    options.exactVersion !== true ||
    status !== 404 ||
    !names.has("notfound")
  ) {
    return false;
  }
  try {
    return (
      error instanceof Error &&
      error.name === "NotFound" &&
      [error.code, error.Code].every(
        (alias) => alias === undefined || alias === "NotFound"
      )
    );
  } catch (_error) {
    return false;
  }
}

function isChecksumFailure(error, names) {
  if (
    names.has("baddigest") ||
    names.has("invaliddigest") ||
    names.has("checksummismatch")
  ) {
    return true;
  }
  try {
    const message = error && error.message;
    return (
      typeof message === "string" &&
      message.length <= 4096 &&
      (/\bchecksum mismatch\b/i.test(message) ||
        /\bchecksum validation (?:failed|failure)\b/i.test(message) ||
        /\bchecksum\b.{0,80}\bdid not match\b/i.test(message))
    );
  } catch (_error) {
    return false;
  }
}

function normalizeServiceError(error, operation, options = {}) {
  try {
    if (error instanceof ObjectStoreError) {
      return recreateObjectStoreError(error, operation, "object_store_unavailable");
    }
  } catch (_error) {
    return objectStoreError("object_store_unavailable", operation);
  }
  const names = serviceErrorNames(error);
  const status = responseStatus(error);
  if (names.has("aborterror") || names.has("requestabortederror")) {
    return objectStoreError("object_store_aborted", operation);
  }
  if (isChecksumFailure(error, names)) return integrityError(operation);
  if (
    names.has("nosuchkey") ||
    (options.exactVersion === true &&
      (operation === "head" || operation === "get") &&
      names.has("nosuchversion")) ||
    isCanonicalExactVersionHeadNotFound(
      error,
      operation,
      options,
      names,
      status
    )
  ) {
    return objectStoreError("object_store_not_found", operation);
  }
  if (names.has("preconditionfailed") || status === 412) {
    return integrityError(operation);
  }
  if (
    names.has("entitytoolarge") ||
    names.has("requestentitytoolarge") ||
    status === 413
  ) {
    return objectStoreError("object_store_too_large", operation);
  }
  return objectStoreError("object_store_unavailable", operation);
}

function cancelBody(body) {
  try {
    if (body && typeof body.destroy === "function") {
      body.destroy();
      return Promise.resolve();
    }
    if (body && typeof body.cancel === "function") {
      return Promise.resolve(body.cancel()).catch(() => {});
    }
  } catch (_error) {
    // Cancellation is best-effort; the bounded operation error remains authoritative.
  }
  return Promise.resolve();
}

async function cancelResponseBody(response) {
  let body;
  try {
    body = response && response.Body;
  } catch (_error) {
    return;
  }
  await cancelBody(body);
}

async function collectBoundedBody(
  body,
  expectedLength,
  expectedChecksum,
  maximumChunks,
  signal,
  operation
) {
  if (!body) throw integrityError(operation);
  const output = Buffer.allocUnsafe(expectedLength);
  const hash = crypto.createHash("sha256");
  let total = 0;
  let chunkCount = 0;
  let reader = null;
  let iterator = null;
  let cancellation = null;
  const cancel = () => {
    if (cancellation) return cancellation;
    const pending = [];
    try {
      if (reader && typeof reader.cancel === "function") {
        pending.push(Promise.resolve(reader.cancel()).catch(() => {}));
      }
    } catch (_error) {
      // Continue with the remaining cancellation paths.
    }
    try {
      if (iterator && typeof iterator.return === "function") {
        pending.push(Promise.resolve(iterator.return()).catch(() => {}));
      }
    } catch (_error) {
      // Continue with the body-level cancellation path.
    }
    pending.push(cancelBody(body));
    cancellation = Promise.allSettled(pending).then(() => undefined);
    return cancellation;
  };
  const append = (value) => {
    chunkCount += 1;
    if (chunkCount > maximumChunks) {
      cancel();
      throw objectStoreError("object_store_too_large", operation);
    }
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      cancel();
      throw integrityError(operation);
    }
    const length = value.byteLength;
    if (!Number.isSafeInteger(length) || total > expectedLength - length) {
      cancel();
      throw integrityError(operation);
    }
    if (length === 0) return;
    const source = Buffer.isBuffer(value)
      ? value
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    source.copy(output, total);
    hash.update(output.subarray(total, total + length));
    total += length;
  };
  const onAbort = () => {
    cancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      append(body);
    } else if (typeof body.getReader === "function") {
      reader = body.getReader();
      while (true) {
        if (signal.aborted) throw INTERRUPTION;
        const result = await reader.read();
        if (result.done) break;
        append(result.value);
      }
    } else if (typeof body[Symbol.asyncIterator] === "function") {
      iterator = body[Symbol.asyncIterator]();
      if (!iterator || typeof iterator.next !== "function") {
        throw integrityError(operation);
      }
      while (true) {
        if (signal.aborted) throw INTERRUPTION;
        const result = await iterator.next();
        if (!result || typeof result !== "object") throw integrityError(operation);
        if (result.done) break;
        append(result.value);
      }
    } else {
      throw integrityError(operation);
    }
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (reader) {
      try {
        reader.releaseLock();
      } catch (_error) {
        // A failed read may already have released or invalidated the reader.
      }
    }
  }
  if (total !== expectedLength) {
    await cancel();
    throw integrityError(operation);
  }
  const receivedChecksum = hash.digest("hex");
  if (receivedChecksum !== expectedChecksum) {
    await cancel();
    throw integrityError(operation);
  }
  return {
    body: output,
    checksumSha256: receivedChecksum,
    contentLength: total,
  };
}

function validatePutResponse(response, options) {
  try {
    if (
      response &&
      response.ChecksumSHA256 !== undefined &&
      response.ChecksumSHA256 !== checksumBase64(options.checksumSha256)
    ) {
      throw integrityError("put");
    }
    assertSseConfirmation(response, {
      operation: "put",
      serverSideEncryption: options.serverSideEncryption,
      sseResponsePolicy: options.sseResponsePolicy,
    });
    return normalizeResponseVersionId(
      response && response.VersionId,
      "put version id",
      "put"
    );
  } catch (error) {
    throw recreateObjectStoreError(error, "put", "object_store_integrity");
  }
}

function putResult(key, record, versionId = null) {
  return Object.freeze({
    checksumSha256: record.checksumSha256,
    contentLength: record.contentLength,
    contentType: record.contentType,
    key,
    ...(versionId === null ? {} : { versionId }),
  });
}

function validateVersionField(
  value,
  name,
  optional = false,
  operation = "delete",
  allowNullVersion = true
) {
  if (optional && value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (!allowNullVersion && value === "null")
  ) {
    throw integrityError(operation);
  }
  return value;
}

function normalizeResponseVersionId(value, name, operation) {
  const versionId = validateVersionField(value, name, true, operation);
  return versionId === "null" ? null : versionId;
}

function parseVersionEntries(value, field, key, seenVersionIds, targets) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw integrityError("delete");
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw integrityError("delete");
    }
    const entryKey = validateVersionField(entry.Key, field + " key");
    if (entryKey !== key) continue;
    const versionId = validateVersionField(entry.VersionId, field + " version id");
    if (seenVersionIds.has(versionId)) throw integrityError("delete");
    seenVersionIds.add(versionId);
    targets.push(Object.freeze({
      etag: validateVersionField(entry.ETag, field + " ETag", true),
      kind: field,
      versionId,
    }));
    if (targets.length > MAX_VERSIONS_PER_SCAN) throw integrityError("delete");
  }
}

function parseVersionPage(response, key, seenVersionIds, targets) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw integrityError("delete");
  }
  parseVersionEntries(response.Versions, "version", key, seenVersionIds, targets);
  parseVersionEntries(
    response.DeleteMarkers,
    "delete-marker",
    key,
    seenVersionIds,
    targets
  );
  if (response.IsTruncated !== true && response.IsTruncated !== false) {
    throw integrityError("delete");
  }
  if (!response.IsTruncated) return null;
  return Object.freeze({
    keyMarker: validateVersionField(response.NextKeyMarker, "next key marker"),
    versionIdMarker: validateVersionField(
      response.NextVersionIdMarker,
      "next version id marker",
      true
    ),
  });
}

function parseNamespaceVersionEntries(value, field, prefix, keys, seenTargets, targets) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw integrityError("delete");
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw integrityError("delete");
    }
    const entryKey = validateVersionField(entry.Key, field + " key");
    if (!entryKey.startsWith(prefix)) throw integrityError("delete");
    try {
      keys.assert(entryKey);
    } catch (_error) {
      throw integrityError("delete");
    }
    const versionId = validateVersionField(entry.VersionId, field + " version id");
    const identity = entryKey + "\0" + versionId;
    if (seenTargets.has(identity)) throw integrityError("delete");
    seenTargets.add(identity);
    targets.push(Object.freeze({
      etag: validateVersionField(entry.ETag, field + " ETag", true),
      key: entryKey,
      kind: field,
      versionId,
    }));
    if (targets.length > MAX_VERSIONS_PER_SCAN) throw integrityError("delete");
  }
}

function parseNamespaceVersionPage(response, prefix, keys, seenTargets, targets) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw integrityError("delete");
  }
  parseNamespaceVersionEntries(
    response.Versions,
    "version",
    prefix,
    keys,
    seenTargets,
    targets
  );
  parseNamespaceVersionEntries(
    response.DeleteMarkers,
    "delete-marker",
    prefix,
    keys,
    seenTargets,
    targets
  );
  if (response.IsTruncated !== true && response.IsTruncated !== false) {
    throw integrityError("delete");
  }
  if (!response.IsTruncated) return null;
  return Object.freeze({
    keyMarker: validateVersionField(response.NextKeyMarker, "next key marker"),
    versionIdMarker: validateVersionField(
      response.NextVersionIdMarker,
      "next version id marker",
      true
    ),
  });
}

class SubtitleObjectStore {
  #bucket;
  #client;
  #keys;
  #maxObjectBytes;
  #maxResponseChunks;
  #requestTimeoutMs;
  #serverSideEncryption;
  #sseResponsePolicy;

  constructor(rawOptions = {}) {
    const options = validateConfig(rawOptions);
    this.#bucket = options.bucket;
    this.#maxObjectBytes = options.maxObjectBytes;
    this.#maxResponseChunks = options.maxResponseChunks;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#serverSideEncryption = options.serverSideEncryption;
    this.#sseResponsePolicy = options.sseResponsePolicy;
    this.#keys = new OpaqueObjectKeyFactory({
      currentKeyId: options.keyHmacCurrentKeyId,
      keyring: options.keyHmacKeyring,
      prefix: KEY_PREFIX,
    });
    this.#client =
      options.client ||
      new S3Client({
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle,
        maxAttempts: 2,
        region: options.region,
        requestChecksumCalculation: "WHEN_SUPPORTED",
        responseChecksumValidation: "WHEN_SUPPORTED",
      });
  }

  createKey(components) {
    return this.#keys.create(components);
  }

  async #execute(operation, externalSignal, work, errorOptions) {
    const signal = assertAbortSignal(externalSignal);
    if (signal && signal.aborted) {
      throw objectStoreError("object_store_aborted", operation);
    }
    const controller = new AbortController();
    let externallyAborted = false;
    let timedOut = false;
    const onExternalAbort = () => {
      if (controller.signal.aborted) return;
      externallyAborted = true;
      controller.abort();
    };
    let removeInterruption = () => {};
    if (signal) signal.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, this.#requestTimeoutMs);
    const interruption = new Promise((_resolve, reject) => {
      const rejectInterruption = () => reject(INTERRUPTION);
      controller.signal.addEventListener("abort", rejectInterruption, { once: true });
      removeInterruption = () =>
        controller.signal.removeEventListener("abort", rejectInterruption);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => work(controller.signal)),
        interruption,
      ]);
    } catch (error) {
      if (externallyAborted) throw objectStoreError("object_store_aborted", operation);
      if (timedOut) throw objectStoreError("object_store_timeout", operation);
      if (error === INTERRUPTION) throw objectStoreError("object_store_aborted", operation);
      throw normalizeServiceError(error, operation, errorOptions);
    } finally {
      clearTimeout(timeout);
      removeInterruption();
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }

  async #reconcilePut(key, record, putAttemptNonce, signal, originalError) {
    if (signal && signal.aborted) {
      throw objectStoreError("object_store_aborted", "put");
    }
    let existing;
    try {
      const response = await this.#execute("head", signal, (operationSignal) =>
        this.#client.send(
          new HeadObjectCommand({
            Bucket: this.#bucket,
            ChecksumMode: "ENABLED",
            Key: key,
          }),
          { abortSignal: operationSignal }
        )
      );
      existing = parseStoredRecord(response, {
        maximumBytes: record.contentLength,
        operation: "head",
        putAttemptNonce,
        serverSideEncryption: this.#serverSideEncryption,
        sseResponsePolicy: this.#sseResponsePolicy,
        versionId: null,
      });
      assertExpectedRecord(existing, record, "head");
    } catch (error) {
      if (isObjectStoreError(error, "object_store_aborted")) {
        throw objectStoreError("object_store_aborted", "put");
      }
      if (
        isObjectStoreError(error, "object_store_integrity") ||
        isObjectStoreError(error, "object_store_too_large")
      ) {
        throw integrityError("put");
      }
      throw recreateObjectStoreError(originalError, "put", "object_store_unavailable");
    }
    if (existing.contentType !== record.contentType) throw integrityError("put");
    return putResult(
      key,
      record,
      existing.putAttemptMatched === true ? existing.versionId : null
    );
  }

  async put(key, body, rawOptions) {
    const safeKey = this.#keys.assert(key);
    const options = readOperationOptions(rawOptions, PUT_OPTION_FIELDS, "object store put options");
    const signal = options.signal;
    assertAbortSignal(signal);
    const bytes = validateBody(body, this.#maxObjectBytes);
    const record = {
      checksumSha256: checksumHex(bytes),
      contentLength: bytes.length,
      contentType: validateContentType(options.contentType),
    };
    const expectedLength = validateContentLength(options.contentLength, true);
    const expectedChecksum = validateChecksum(options.checksumSha256, true);
    if (
      (expectedLength !== null && expectedLength !== record.contentLength) ||
      (expectedChecksum !== null && expectedChecksum !== record.checksumSha256)
    ) {
      throw integrityError("put");
    }
    const putAttemptNonce = createPutAttemptNonce();
    const input = {
      Body: bytes,
      Bucket: this.#bucket,
      CacheControl: "private, no-store",
      ChecksumSHA256: checksumBase64(record.checksumSha256),
      ContentLength: record.contentLength,
      ContentType: record.contentType,
      IfNoneMatch: "*",
      Key: safeKey,
      Metadata: {
        [METADATA.contentLength]: String(record.contentLength),
        [METADATA.putAttempt]: putAttemptNonce,
        [METADATA.schema]: "1",
        [METADATA.sha256]: record.checksumSha256,
      },
    };
    if (this.#serverSideEncryption) {
      input.ServerSideEncryption = this.#serverSideEncryption;
    }
    let response;
    try {
      response = await this.#execute("put", signal, (operationSignal) =>
        this.#client.send(new PutObjectCommand(input), { abortSignal: operationSignal })
      );
    } catch (error) {
      if (
        !isObjectStoreError(error) ||
        !new Set([
          "object_store_integrity",
          "object_store_timeout",
          "object_store_unavailable",
        ]).has(error.code)
      ) {
        throw error;
      }
      return this.#reconcilePut(safeKey, record, putAttemptNonce, signal, error);
    }
    const versionId = validatePutResponse(response, {
      checksumSha256: record.checksumSha256,
      serverSideEncryption: this.#serverSideEncryption,
      sseResponsePolicy: this.#sseResponsePolicy,
    });
    return putResult(safeKey, record, versionId);
  }

  async head(key, rawOptions) {
    const safeKey = this.#keys.assert(key);
    const options = readOperationOptions(rawOptions, READ_OPTION_FIELDS, "object store head options");
    const versionId = validateVersionField(
      options.versionId,
      "object store head version id",
      true,
      "head",
      false
    );
    const signal = options.signal;
    assertAbortSignal(signal);
    const maximumBytes = readPositiveInteger(
      options.maxBytes,
      this.#maxObjectBytes,
      this.#maxObjectBytes,
      "object store read byte limit"
    );
    const response = await this.#execute(
      "head",
      signal,
      (operationSignal) =>
        this.#client.send(
          new HeadObjectCommand({
            Bucket: this.#bucket,
            ChecksumMode: "ENABLED",
            Key: safeKey,
            ...(versionId === null ? {} : { VersionId: versionId }),
          }),
          { abortSignal: operationSignal }
        ),
      { exactVersion: versionId !== null }
    );
    const record = parseStoredRecord(response, {
      maximumBytes,
      operation: "head",
      serverSideEncryption: this.#serverSideEncryption,
      sseResponsePolicy: this.#sseResponsePolicy,
      versionId,
    });
    assertExpectedRecord(record, options, "head");
    return Object.freeze({ key: safeKey, ...record });
  }

  async get(key, rawOptions) {
    const safeKey = this.#keys.assert(key);
    const options = readOperationOptions(rawOptions, READ_OPTION_FIELDS, "object store get options");
    const versionId = validateVersionField(
      options.versionId,
      "object store get version id",
      true,
      "get",
      false
    );
    const signal = options.signal;
    assertAbortSignal(signal);
    const maximumBytes = readPositiveInteger(
      options.maxBytes,
      this.#maxObjectBytes,
      this.#maxObjectBytes,
      "object store read byte limit"
    );
    return this.#execute(
      "get",
      signal,
      async (operationSignal) => {
        const response = await this.#client.send(
          new GetObjectCommand({
            Bucket: this.#bucket,
            ChecksumMode: "ENABLED",
            Key: safeKey,
            ...(versionId === null ? {} : { VersionId: versionId }),
          }),
          { abortSignal: operationSignal }
        );
        let record;
        try {
          record = parseStoredRecord(response, {
            maximumBytes,
            operation: "get",
            serverSideEncryption: this.#serverSideEncryption,
            sseResponsePolicy: this.#sseResponsePolicy,
            versionId,
          });
          assertExpectedRecord(record, options, "get");
        } catch (error) {
          await cancelResponseBody(response);
          throw error;
        }
        let body;
        try {
          body = response.Body;
          const collected = await collectBoundedBody(
            body,
            record.contentLength,
            record.checksumSha256,
            this.#maxResponseChunks,
            operationSignal,
            "get"
          );
          return Object.freeze({
            body: collected.body,
            checksumSha256: record.checksumSha256,
            contentLength: record.contentLength,
            contentType: record.contentType,
            key: safeKey,
            ...(record.versionId === undefined ? {} : { versionId: record.versionId }),
          });
        } catch (error) {
          await cancelBody(body);
          throw error;
        }
      },
      { exactVersion: versionId !== null }
    );
  }

  async delete(key, rawOptions) {
    const safeKey = this.#keys.assert(key);
    const options = readOperationOptions(
      rawOptions,
      DELETE_OPTION_FIELDS,
      "object store delete options"
    );
    const signal = options.signal;
    assertAbortSignal(signal);
    validateChecksum(options.checksumSha256, true);
    validateContentLength(options.contentLength, true);

    let consecutiveEmptyScans = 0;
    for (let round = 0; round < MAX_PERMANENT_ERASURE_ROUNDS; round += 1) {
      const targets = await this.#listExactVersions(safeKey, signal);
      if (targets.length === 0) {
        await this.#assertNoLiveObject(safeKey, signal);
        consecutiveEmptyScans += 1;
        if (consecutiveEmptyScans === 2) {
          return Object.freeze({ deleted: true, key: safeKey });
        }
        continue;
      }

      consecutiveEmptyScans = 0;
      await this.#deleteVersionTargets(
        targets.map((target) => ({ ...target, key: safeKey })),
        signal
      );
    }
    throw integrityError("delete");
  }

  async deleteVersion(key, versionId, rawOptions) {
    const safeKey = this.#keys.assert(key);
    const safeVersionId = validateVersionField(
      versionId,
      "attested version id",
      false,
      "delete",
      false
    );
    const options = readOperationOptions(
      rawOptions,
      NAMESPACE_PURGE_OPTION_FIELDS,
      "object store version delete options"
    );
    const signal = options.signal;
    assertAbortSignal(signal);

    let targets = await this.#listExactVersions(safeKey, signal);
    const initialTarget = targets.find(
      (target) => target.kind === "version" && target.versionId === safeVersionId
    );
    if (!initialTarget) {
      await this.#assertExactVersionAbsent(safeKey, safeVersionId, signal);
      const confirmation = await this.#listExactVersions(safeKey, signal);
      const appeared = confirmation.some(
        (target) => target.kind === "version" && target.versionId === safeVersionId
      );
      if (appeared) throw integrityError("delete");
      await this.#assertExactVersionAbsent(safeKey, safeVersionId, signal);
      return Object.freeze({
        deleted: true,
        key: safeKey,
        observed: false,
        versionId: safeVersionId,
      });
    }

    let consecutiveAbsentScans = 0;
    let firstDeleteFailure = null;
    for (let round = 0; round < MAX_PERMANENT_ERASURE_ROUNDS; round += 1) {
      const mismatchedTarget = targets.find(
        (target) => target.kind !== "version" && target.versionId === safeVersionId
      );
      if (mismatchedTarget) throw integrityError("delete");
      const target = targets.find(
        (candidate) =>
          candidate.kind === "version" && candidate.versionId === safeVersionId
      );
      if (!target) {
        await this.#assertExactVersionAbsent(safeKey, safeVersionId, signal);
        consecutiveAbsentScans += 1;
        if (consecutiveAbsentScans === 2) {
          return Object.freeze({
            deleted: true,
            key: safeKey,
            observed: true,
            versionId: safeVersionId,
          });
        }
      } else {
        consecutiveAbsentScans = 0;
        try {
          await this.#deleteVersionTargets([{ ...target, key: safeKey }], signal);
        } catch (error) {
          if (isObjectStoreError(error, "object_store_aborted")) throw error;
          if (!firstDeleteFailure) {
            firstDeleteFailure = recreateObjectStoreError(
              error,
              "delete",
              "object_store_unavailable"
            );
          }
          // A lost delete response may still have removed the exact version.
        }
      }
      targets = await this.#listExactVersions(safeKey, signal);
    }
    if (signal && signal.aborted) {
      throw objectStoreError("object_store_aborted", "delete");
    }
    const targetRemains = targets.some(
      (target) => target.kind === "version" && target.versionId === safeVersionId
    );
    if (targetRemains && firstDeleteFailure) throw firstDeleteFailure;
    throw integrityError("delete");
  }

  async purgeNamespace(components, rawOptions) {
    const prefixes = this.#keys.namespacePrefixes(components);
    const options = readOperationOptions(
      rawOptions,
      NAMESPACE_PURGE_OPTION_FIELDS,
      "object store namespace purge options"
    );
    const signal = options.signal;
    assertAbortSignal(signal);

    let consecutiveEmptyScans = 0;
    for (let round = 0; round < MAX_PERMANENT_ERASURE_ROUNDS; round += 1) {
      const targets = [];
      const seenTargets = new Set();
      for (const prefix of prefixes) {
        await this.#listNamespaceVersions(prefix, signal, seenTargets, targets);
      }
      if (targets.length === 0) {
        consecutiveEmptyScans += 1;
        if (consecutiveEmptyScans === 2) return Object.freeze({ deleted: true });
        continue;
      }
      consecutiveEmptyScans = 0;
      await this.#deleteVersionTargets(targets, signal);
    }
    throw integrityError("delete");
  }

  async #listExactVersions(key, signal) {
    const targets = [];
    const seenVersionIds = new Set();
    const seenMarkers = new Set();
    let keyMarker = null;
    let versionIdMarker = null;
    for (let page = 0; page < MAX_VERSION_PAGES_PER_SCAN; page += 1) {
      const input = {
        Bucket: this.#bucket,
        MaxKeys: VERSION_PAGE_SIZE,
        Prefix: key,
        ...(keyMarker === null ? {} : { KeyMarker: keyMarker }),
        ...(versionIdMarker === null ? {} : { VersionIdMarker: versionIdMarker }),
      };
      const response = await this.#execute("delete", signal, (operationSignal) =>
        this.#client.send(new ListObjectVersionsCommand(input), {
          abortSignal: operationSignal,
        })
      );
      const next = parseVersionPage(response, key, seenVersionIds, targets);
      if (!next) return targets;
      const markerIdentity = next.keyMarker + "\0" + (next.versionIdMarker || "");
      if (seenMarkers.has(markerIdentity)) throw integrityError("delete");
      seenMarkers.add(markerIdentity);
      keyMarker = next.keyMarker;
      versionIdMarker = next.versionIdMarker;
    }
    throw integrityError("delete");
  }

  async #listNamespaceVersions(prefix, signal, seenTargets, targets) {
    const seenMarkers = new Set();
    let keyMarker = null;
    let versionIdMarker = null;
    for (let page = 0; page < MAX_VERSION_PAGES_PER_SCAN; page += 1) {
      const input = {
        Bucket: this.#bucket,
        MaxKeys: VERSION_PAGE_SIZE,
        Prefix: prefix,
        ...(keyMarker === null ? {} : { KeyMarker: keyMarker }),
        ...(versionIdMarker === null ? {} : { VersionIdMarker: versionIdMarker }),
      };
      const response = await this.#execute("delete", signal, (operationSignal) =>
        this.#client.send(new ListObjectVersionsCommand(input), {
          abortSignal: operationSignal,
        })
      );
      const next = parseNamespaceVersionPage(
        response,
        prefix,
        this.#keys,
        seenTargets,
        targets
      );
      if (!next) return;
      const markerIdentity = next.keyMarker + "\0" + (next.versionIdMarker || "");
      if (seenMarkers.has(markerIdentity)) throw integrityError("delete");
      seenMarkers.add(markerIdentity);
      keyMarker = next.keyMarker;
      versionIdMarker = next.versionIdMarker;
    }
    throw integrityError("delete");
  }

  async #deleteVersionTargets(targets, signal) {
    let firstFailure = null;
    for (const target of targets) {
      try {
        await this.#execute("delete", signal, (operationSignal) =>
          this.#client.send(
            new DeleteObjectCommand({
              Bucket: this.#bucket,
              Key: target.key,
              VersionId: target.versionId,
            }),
            { abortSignal: operationSignal }
          )
        );
      } catch (error) {
        if (isObjectStoreError(error, "object_store_not_found")) continue;
        if (!firstFailure) firstFailure = error;
      }
    }
    if (firstFailure) throw firstFailure;
  }

  async #assertExactVersionAbsent(key, versionId, signal) {
    try {
      await this.#execute(
        "head",
        signal,
        (operationSignal) =>
          this.#client.send(
            new HeadObjectCommand({
              Bucket: this.#bucket,
              ChecksumMode: "ENABLED",
              Key: key,
              VersionId: versionId,
            }),
            { abortSignal: operationSignal }
          ),
        { exactVersion: true }
      );
    } catch (error) {
      if (isObjectStoreError(error, "object_store_not_found")) return;
      if (isObjectStoreError(error, "object_store_aborted")) {
        throw objectStoreError("object_store_aborted", "delete");
      }
      throw recreateObjectStoreError(error, "delete", "object_store_unavailable");
    }
    throw integrityError("delete");
  }

  async #assertNoLiveObject(key, signal) {
    try {
      await this.head(key, signal ? { signal } : undefined);
    } catch (error) {
      if (isObjectStoreError(error, "object_store_not_found")) return;
      throw recreateObjectStoreError(error, "delete", "object_store_unavailable");
    }
    throw integrityError("delete");
  }
}

module.exports = {
  DEFAULT_ENDPOINT_ALLOWLIST,
  DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_MAX_RESPONSE_CHUNKS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  HARD_MAX_OBJECT_BYTES,
  HARD_MAX_REQUEST_TIMEOUT_MS,
  MAX_PERMANENT_ERASURE_ROUNDS,
  SubtitleObjectStore,
};
