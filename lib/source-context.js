"use strict";

const { createHash, randomUUID } = require("node:crypto");

const SCHEMA_VERSION = 1;
const MAX_EXACT_VALUE_LENGTH = 8192;
const MAX_FINGERPRINT_VALUE_LENGTH = 512;
const MAX_FINGERPRINTS = 32;
const MAX_ID_LENGTH = 256;
const MAX_CONTEXT_STRING_LENGTH = 8192;
const MAX_CONTEXT_ARRAY_LENGTH = 64;
const MAX_CONTEXT_OBJECT_KEYS = 64;
const MAX_CONTEXT_DEPTH = 6;
const MAX_CONTEXT_NODES = 2048;
const MAX_CONTEXT_TOTAL_BYTES = 256 * 1024;
const MAX_FILE_INDEX = 65535;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8640000000000000;
const INITIAL_PROFILE_GENERATION = "g1:0";
const PROFILE_GENERATION_PATTERN = /^g1:[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_PENDING_GENERATION_PATTERN = /^g1:w_([0-9]{1,16})_[A-Za-z0-9_-]{43}$/;
const PRIVATE_REVISION_PATTERN = /^(?:0|[1-9][0-9]{0,127})$/;
const LOWERCASE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_PROVIDER_SNAPSHOT_LEASE_MS = 30_000;
const MAX_PROVIDER_SNAPSHOT_ATTEMPTS = 16;
const PROVIDER_SNAPSHOT_AUTHORITY_METHODS = Object.freeze([
  "getProviderSnapshotState",
  "beginProviderSnapshotMutation",
  "renewProviderSnapshotMutation",
  "fenceProviderSnapshotMutation",
  "completeProviderSnapshotMutation",
  "releaseProviderSnapshotMutation",
  "probeProviderSnapshotRecovery",
  "beginProviderSnapshotRecovery",
  "completeProviderSnapshotRecovery",
]);

const CANONICAL_FINGERPRINT_PATTERNS = [
  /^v1:(?:url|external-url|android-tv-url|tizen-url|webos-url|player-frame-url|yt-id|proxy-source|archive-(?:rar|zip|7zip|tgz|tar)|nzb-source|opaque):sha256:[a-f0-9]{64}$/,
  /^v1:info-hash:[a-f0-9]{40}:file-idx:(?:(?:0|[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])|-1(?::file-must-include:sha256:[a-f0-9]{64})?)$/,
];

const ARCHIVE_SOURCE_FIELDS = Object.freeze([
  Object.freeze({ field: "rarUrls", type: "archive-rar" }),
  Object.freeze({ field: "zipUrls", type: "archive-zip" }),
  Object.freeze({ field: "7zipUrls", type: "archive-7zip" }),
  Object.freeze({ field: "tgzUrls", type: "archive-tgz" }),
  Object.freeze({ field: "tarUrls", type: "archive-tar" }),
]);

const STORED_CONTEXT_KEYS = new Set([
  "schemaVersion",
  "contextId",
  "profileId",
  "contentKey",
  "canonicalIdentity",
  "traktEligible",
  "request",
  "display",
  "source",
  "fingerprints",
  "inlineSubtitles",
  "createdAt",
  "expiresAt",
]);

const STORED_SOURCE_KEYS = new Set(["type", "provider", "providers"]);
const STORED_REQUEST_KEYS = new Set([
  "resource",
  "type",
  "metaId",
  "videoId",
  "metaProvider",
  "streamProvider",
  "streamProviders",
  "videoHash",
  "videoSize",
  "filename",
]);

const FORBIDDEN_IP_KEYS = new Set([
  "ip",
  "ipaddress",
  "clientip",
  "client_ip",
  "remoteaddress",
  "remote_address",
  "x-forwarded-for",
]);

const CLAIM_OPTION_KEYS = new Set([
  "generation",
  "deviceGeneration",
  "sessionId",
  "requestDigest",
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function assertPlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " must be a plain object");
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " must be a plain object");
  }
  return value;
}

function assertBoundedString(value, name, maxLength, options = {}) {
  const { allowEmpty = false, rejectControls = false, requireTrimmed = false } = options;
  if (typeof value !== "string") throw new TypeError(name + " must be a string");
  if (!allowEmpty && value.length === 0) throw new TypeError(name + " must not be empty");
  if (value.length > maxLength || Buffer.byteLength(value, "utf8") > maxLength * 4) {
    throw new RangeError(name + " exceeds the maximum length");
  }
  if (rejectControls && /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(name + " contains control characters");
  }
  if (requireTrimmed && value.trim() !== value) {
    throw new TypeError(name + " must not contain surrounding whitespace");
  }
  return value;
}

function assertIdentifier(value, name) {
  return assertBoundedString(value, name, MAX_ID_LENGTH, {
    rejectControls: true,
    requireTrimmed: true,
  });
}

function assertCanonicalAttemptId(value) {
  if (typeof value !== "string" || !CANONICAL_UUID_PATTERN.test(value)) {
    throw new TypeError("attemptId must be a lowercase canonical UUID");
  }
  return value;
}

function assertLowercaseSha256(value, name) {
  if (typeof value !== "string" || !LOWERCASE_SHA256_PATTERN.test(value)) {
    throw new TypeError(name + " must be a lowercase SHA-256 digest");
  }
  return value;
}

function assertExactObjectKeys(value, allowed, name) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(name + " contains an unknown field: " + String(key));
    }
  }
  return value;
}

function hashOpaqueValue(value) {
  assertBoundedString(value, "value", MAX_EXACT_VALUE_LENGTH, { rejectControls: true });
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fingerprintTypedExactValue(type, value) {
  return "v1:" + type + ":sha256:" + hashOpaqueValue(value);
}

function fingerprintExactUrl(url) {
  return fingerprintTypedExactValue("url", url);
}

function fingerprintTorrentFilters(values) {
  const hash = createHash("sha256");
  hash.update("jumpgate-info-hash-file-must-include:v1\0", "utf8");
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value, "utf8")) + ":", "utf8");
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableSerialize(value[key]))
      .join(",") +
    "}"
  );
}

function fingerprintCanonicalSource(type, value) {
  const cloned = validateAndClone(value, type + " source");
  const serialized = stableSerialize(cloned);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_TOTAL_BYTES) {
    throw new RangeError(type + " source exceeds the maximum total byte size");
  }
  return "v1:" + type + ":sha256:" + createHash("sha256").update(serialized, "utf8").digest("hex");
}

function normalizeFileIndex(value) {
  let normalized = value;
  if (typeof value === "string") {
    if (!/^(?:-1|0|[1-9]\d{0,4})$/.test(value)) {
      throw new TypeError("fileIdx must be -1 or an unsigned 16-bit integer");
    }
    normalized = Number(value);
  }

  if (!Number.isSafeInteger(normalized) || normalized < -1 || normalized > MAX_FILE_INDEX) {
    throw new TypeError("fileIdx must be -1 or an unsigned 16-bit integer");
  }
  return normalized;
}

function normalizeProvidedFingerprint(value) {
  assertBoundedString(value, "fingerprint", MAX_FINGERPRINT_VALUE_LENGTH, {
    rejectControls: true,
  });

  if (CANONICAL_FINGERPRINT_PATTERNS.some((pattern) => pattern.test(value))) {
    return value;
  }
  return fingerprintTypedExactValue("opaque", value);
}

function readOptionalExactString(object, key, name = key) {
  if (!hasOwn(object, key) || object[key] === null) return null;
  return assertBoundedString(object[key], name, MAX_EXACT_VALUE_LENGTH, {
    rejectControls: true,
  });
}

function asciiLower(value) {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32)
  );
}

function compareAsciiOrdinal(left, right) {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function normalizeHeaderName(value, name) {
  const normalized = assertBoundedString(value, name, 256, {
    rejectControls: true,
    requireTrimmed: true,
  });
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(normalized)) {
    throw new TypeError(name + " must be an ASCII HTTP token");
  }
  return normalized;
}

function normalizeHeaderMap(value, name) {
  if (value === undefined || value === null) return [];
  const headers = assertPlainObject(value, name);
  const keys = Object.keys(headers);
  if (keys.length > MAX_CONTEXT_ARRAY_LENGTH) {
    throw new RangeError(name + " exceeds the maximum header count");
  }

  const entries = keys.map((key) => {
    const originalName = normalizeHeaderName(key, name + " name");
    return {
      lowerName: asciiLower(originalName),
      originalName,
      value: assertBoundedString(headers[key], name + " value", MAX_EXACT_VALUE_LENGTH, {
        allowEmpty: true,
        rejectControls: true,
      }),
    };
  });
  entries.sort(
    (left, right) =>
      compareAsciiOrdinal(left.lowerName, right.lowerName) ||
      compareAsciiOrdinal(left.originalName, right.originalName)
  );

  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].lowerName === entries[index].lowerName) {
      throw new TypeError(name + " contains duplicate case-insensitive header names");
    }
  }
  return entries.map((entry) => [entry.lowerName, entry.value]);
}

function normalizeProxySource(stream, url) {
  if (!hasOwn(stream, "behaviorHints") || stream.behaviorHints === null) return null;
  const hints = assertPlainObject(stream.behaviorHints, "behaviorHints");
  if (!hasOwn(hints, "proxyHeaders") || hints.proxyHeaders === null) return null;
  const proxy = assertPlainObject(hints.proxyHeaders, "behaviorHints.proxyHeaders");
  return {
    url,
    request: normalizeHeaderMap(proxy.request, "proxy request header"),
    response: normalizeHeaderMap(proxy.response, "proxy response header"),
  };
}

function normalizeArchiveUrls(value, name) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTEXT_ARRAY_LENGTH) {
    throw new TypeError(name + " must be a non-empty bounded array");
  }
  return value.map((entry, index) => {
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 2) {
      throw new TypeError(name + "[" + index + "] must be [url] or [url, bytes]");
    }
    const url = assertBoundedString(entry[0], name + " url", MAX_EXACT_VALUE_LENGTH, {
      rejectControls: true,
    });
    if (entry.length === 1 || entry[1] === null) return [url];
    if (!Number.isSafeInteger(entry[1]) || entry[1] < 0) {
      throw new TypeError(name + " bytes must be a non-negative safe integer");
    }
    return [url, entry[1]];
  });
}

function normalizeStringArray(value, name, options = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_ARRAY_LENGTH) {
    throw new TypeError(name + " must be a bounded array");
  }
  if (options.nonEmpty && value.length === 0) throw new TypeError(name + " must not be empty");
  return value.map((item) =>
    assertBoundedString(item, name + " item", MAX_EXACT_VALUE_LENGTH, {
      allowEmpty: options.allowEmpty === true,
      rejectControls: true,
    })
  );
}

function normalizeOptionalSourceFileIndex(stream) {
  if (!hasOwn(stream, "fileIdx") || stream.fileIdx === null) return null;
  return normalizeFileIndex(stream.fileIdx);
}

function fingerprintStream(stream, extraFingerprints) {
  assertPlainObject(stream, "stream");
  const candidates = [];

  const url = readOptionalExactString(stream, "url");
  if (url !== null) {
    const proxySource = normalizeProxySource(stream, url);
    // Stremio may hand an external player either the raw URL or its local
    // proxy URL. Keep both exact candidates when proxy headers are present.
    candidates.push(fingerprintExactUrl(url));
    if (proxySource) candidates.push(fingerprintCanonicalSource("proxy-source", proxySource));
  } else if (hasOwn(stream, "ytId")) {
    candidates.push(
      fingerprintTypedExactValue("yt-id", readOptionalExactString(stream, "ytId"))
    );
  } else {
    const archive = ARCHIVE_SOURCE_FIELDS.find((entry) => hasOwn(stream, entry.field));
    if (archive) {
      candidates.push(
        fingerprintCanonicalSource(archive.type, {
          urls: normalizeArchiveUrls(stream[archive.field], archive.field),
          fileIdx: normalizeOptionalSourceFileIndex(stream),
          fileMustInclude: normalizeStringArray(stream.fileMustInclude, "fileMustInclude"),
        })
      );
    } else if (hasOwn(stream, "nzbUrl") || hasOwn(stream, "nzbUrls") || hasOwn(stream, "servers")) {
      const nzbUrl = readOptionalExactString(stream, "nzbUrl");
      const nzbUrls = normalizeStringArray(stream.nzbUrls, "nzbUrls");
      const servers = normalizeStringArray(stream.servers, "servers", { nonEmpty: true });
      const fileIdx = normalizeOptionalSourceFileIndex(stream);
      const fileMustInclude = normalizeStringArray(stream.fileMustInclude, "fileMustInclude");
      if (nzbUrl === null && nzbUrls.length === 0) {
        throw new TypeError("nzb source requires nzbUrl or nzbUrls");
      }
      candidates.push(
        fingerprintCanonicalSource("nzb-source", {
          nzbUrl,
          nzbUrls,
          servers,
          fileIdx,
          fileMustInclude,
        })
      );
    } else if (hasOwn(stream, "infoHash")) {
      const infoHash = assertBoundedString(stream.infoHash, "infoHash", 40, {
        rejectControls: true,
        requireTrimmed: true,
      });
      if (!/^[a-fA-F0-9]{40}$/.test(infoHash)) {
        throw new TypeError("infoHash must be a 40 character hexadecimal hash");
      }
      const selectedFileIdx = normalizeOptionalSourceFileIndex(stream);
      const fileIdx = selectedFileIdx === null ? -1 : selectedFileIdx;
      let selector = ":file-idx:" + fileIdx;
      if (fileIdx === -1) {
        // Stremio Core forwards ordered fileMustInclude values as repeated f
        // parameters for unselected (-1) torrent packs.
        const filters = normalizeStringArray(stream.fileMustInclude, "fileMustInclude");
        if (filters.length > 0) {
          selector += ":file-must-include:sha256:" + fingerprintTorrentFilters(filters);
        }
      }
      candidates.push(
        "v1:info-hash:" + infoHash.toLowerCase() + selector
      );
    } else if (hasOwn(stream, "playerFrameUrl")) {
      candidates.push(
        fingerprintTypedExactValue(
          "player-frame-url",
          readOptionalExactString(stream, "playerFrameUrl")
        )
      );
    } else {
      for (const [field, type] of [
        ["externalUrl", "external-url"],
        ["androidTvUrl", "android-tv-url"],
        ["tizenUrl", "tizen-url"],
        ["webosUrl", "webos-url"],
      ]) {
        const value = readOptionalExactString(stream, field);
        if (value !== null) candidates.push(fingerprintTypedExactValue(type, value));
      }
    }
  }

  if (
    candidates.length === 0 &&
    hasOwn(stream, "fileIdx") &&
    stream.fileIdx !== null
  ) {
    throw new TypeError("fileIdx requires an infoHash, archive, or NZB source");
  }

  // External sources can expose multiple platform URLs; other variants add one.
  if (candidates.length > MAX_FINGERPRINTS) {
    throw new RangeError("fingerprint candidate count exceeds the maximum");
  }

  const provided = extraFingerprints === undefined ? [] : extraFingerprints;
  if (!Array.isArray(provided)) throw new TypeError("extraFingerprints must be an array");
  if (provided.length > MAX_FINGERPRINTS) {
    throw new RangeError("extraFingerprints exceeds the maximum item count");
  }
  for (const fingerprint of provided) {
    candidates.push(normalizeProvidedFingerprint(fingerprint));
  }

  const unique = Array.from(new Set(candidates));
  if (unique.length === 0) {
    throw new TypeError("stream requires at least one playable-source fingerprint");
  }
  if (unique.length > MAX_FINGERPRINTS) {
    throw new RangeError("fingerprint candidate count exceeds the maximum");
  }
  return unique;
}

/*
 * Keep source fingerprint construction above self-contained. Context cloning
 * starts here and applies a larger aggregate budget to non-source metadata.
 */
function cloneBounded(value, name, state, depth) {
  state.nodes += 1;
  if (state.nodes > MAX_CONTEXT_NODES) {
    throw new RangeError(name + " exceeds the maximum value count");
  }
  if (depth > MAX_CONTEXT_DEPTH) {
    throw new RangeError(name + " exceeds the maximum nesting depth");
  }

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(name + " contains a non-safe integer");
    return value;
  }
  if (typeof value === "string") {
    const cloned = assertBoundedString(value, name, MAX_CONTEXT_STRING_LENGTH, { allowEmpty: true });
    state.bytes += Buffer.byteLength(cloned, "utf8");
    if (state.bytes > MAX_CONTEXT_TOTAL_BYTES) {
      throw new RangeError(name + " exceeds the maximum total byte size");
    }
    return cloned;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTEXT_ARRAY_LENGTH) {
      throw new RangeError(name + " exceeds the maximum array length");
    }
    return value.map((item) => cloneBounded(item, name, state, depth + 1));
  }

  assertPlainObject(value, name);
  const keys = Object.keys(value);
  if (keys.length > MAX_CONTEXT_OBJECT_KEYS) {
    throw new RangeError(name + " exceeds the maximum object key count");
  }

  const clone = {};
  for (const key of keys) {
    assertBoundedString(key, "object key", 128, { allowEmpty: false, rejectControls: true });
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError(name + " contains a forbidden object key");
    }
    state.bytes += Buffer.byteLength(key, "utf8");
    if (state.bytes > MAX_CONTEXT_TOTAL_BYTES) {
      throw new RangeError(name + " exceeds the maximum total byte size");
    }
    clone[key] = cloneBounded(value[key], name, state, depth + 1);
  }
  return clone;
}

function validateAndClone(value, name) {
  return cloneBounded(value, name, { nodes: 0, bytes: 0 }, 0);
}

function validateCanonicalIdentity(identity) {
  if (identity === null) return;
  assertPlainObject(identity, "canonicalIdentity");

  const provider = assertIdentifier(identity.provider, "canonicalIdentity.provider");
  if (!new Set(["imdb", "tmdb", "tvdb", "trakt"]).has(provider)) {
    throw new TypeError("canonicalIdentity.provider is not supported");
  }

  const id = assertIdentifier(identity.id, "canonicalIdentity.id");
  if (provider === "imdb" && !/^tt\d{7,}$/.test(id)) {
    throw new TypeError("canonicalIdentity.id must be an exact IMDb id");
  }

  if (identity.mediaType !== "movie" && identity.mediaType !== "episode") {
    throw new TypeError("canonicalIdentity.mediaType must be movie or episode");
  }
  if (identity.confidence !== "canonical") {
    throw new TypeError("canonicalIdentity.confidence must be canonical");
  }
  if (identity.provenance !== "metadata-request" && identity.provenance !== "verified-external-id") {
    throw new TypeError("canonicalIdentity.provenance is not canonical");
  }

  if (identity.mediaType === "episode") {
    if (!Number.isSafeInteger(identity.season) || identity.season < 0) {
      throw new TypeError("canonicalIdentity.season must be a non-negative integer");
    }
    if (!Number.isSafeInteger(identity.episode) || identity.episode < 0) {
      throw new TypeError("canonicalIdentity.episode must be a non-negative integer");
    }
  }
}

function deepClone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const clone = {};
  for (const key of Object.keys(value)) clone[key] = deepClone(value[key]);
  return clone;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function projectStoredFields(value, allowedKeys) {
  const projected = {};
  for (const key of allowedKeys) {
    if (hasOwn(value, key)) projected[key] = deepClone(value[key]);
  }
  return projected;
}

function assertStoredFields(value, allowedKeys, name) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(name + " contains a non-persistable field");
  }
}

function readProvenanceFields(value, singularKey, pluralKey) {
  const source = assertPlainObject(value, singularKey + " provenance");
  const values = [];
  const append = (value) => {
    if (value === undefined || value === null) return;
    const normalized = assertIdentifier(value, pluralKey + " item");
    if (!values.includes(normalized)) values.push(normalized);
  };
  append(source[singularKey]);
  if (source[pluralKey] !== undefined) {
    if (!Array.isArray(source[pluralKey])) throw new TypeError(pluralKey + " must be an array");
    for (const item of source[pluralKey]) append(item);
  }
  return values;
}

function validateProvenanceFields(value, singularKey, pluralKey) {
  readProvenanceFields(value, singularKey, pluralKey);
}

function mergeProvenanceFields(previous, current, singularKey, pluralKey) {
  const result = deepClone(current);
  const values = [];
  for (const value of [
    ...readProvenanceFields(previous, singularKey, pluralKey),
    ...readProvenanceFields(current, singularKey, pluralKey),
  ]) {
    if (!values.includes(value)) values.push(value);
  }
  if (values.length > MAX_CONTEXT_ARRAY_LENGTH) {
    throw new RangeError(pluralKey + " exceeds the maximum array length");
  }
  if (values.length) {
    if (!result[singularKey]) result[singularKey] = values[0];
    result[pluralKey] = values;
  }
  return result;
}

function mergeUniqueContextArray(previous, current) {
  const result = [];
  const seen = new Set();
  for (const item of [...previous, ...current]) {
    const key = stableSerialize(item);
    if (seen.has(key)) continue;
    seen.add(key);
    if (result.length >= MAX_CONTEXT_ARRAY_LENGTH) {
      throw new RangeError("inlineSubtitles exceeds the maximum array length");
    }
    result.push(deepClone(item));
  }
  return result;
}

function parseContextIsoTimestamp(value, name) {
  assertBoundedString(value, name, 64, {
    rejectControls: true,
    requireTrimmed: true,
  });
  const timestamp = Date.parse(value);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_DATE_MS ||
    toIsoString(timestamp) !== value
  ) {
    throw new TypeError(name + " must be a canonical ISO timestamp");
  }
  return timestamp;
}

function validateStoredContext(context, expected = {}) {
  const input = validateAndClone(assertPlainObject(context, "context"), "context");
  for (const key of Object.keys(input)) {
    if (!STORED_CONTEXT_KEYS.has(key)) throw new TypeError("context contains an unknown field");
  }
  if (input.schemaVersion !== SCHEMA_VERSION) throw new TypeError("context schemaVersion must be 1");
  const contextId = assertIdentifier(input.contextId, "contextId");
  if (hasOwn(expected, "contextId") && contextId !== expected.contextId) {
    throw new TypeError("contextId does not match the stored context");
  }
  const profileId = assertIdentifier(input.profileId, "profileId");
  if (hasOwn(expected, "profileId") && profileId !== expected.profileId) {
    throw new TypeError("context profileId does not match the record scope");
  }

  const source = assertPlainObject(input.source, "source");
  const request = assertPlainObject(input.request, "request");
  assertPlainObject(input.display, "display");
  assertStoredFields(source, STORED_SOURCE_KEYS, "source");
  assertStoredFields(request, STORED_REQUEST_KEYS, "request");
  validateProvenanceFields(source, "provider", "providers");
  validateProvenanceFields(request, "streamProvider", "streamProviders");

  if (!Array.isArray(input.fingerprints) || input.fingerprints.length === 0) {
    throw new TypeError("context requires at least one playable-source fingerprint");
  }
  const fingerprints = fingerprintStream(source, input.fingerprints);
  if (
    fingerprints.length !== input.fingerprints.length ||
    fingerprints.some((fingerprint, index) => fingerprint !== input.fingerprints[index]) ||
    (hasOwn(expected, "fingerprints") &&
      (fingerprints.length !== expected.fingerprints.length ||
        fingerprints.some((fingerprint, index) => fingerprint !== expected.fingerprints[index])))
  ) {
    throw new TypeError("context fingerprints are not canonical");
  }

  const canonicalIdentity =
    input.canonicalIdentity === null
      ? null
      : assertPlainObject(input.canonicalIdentity, "canonicalIdentity");
  validateCanonicalIdentity(canonicalIdentity);
  if (typeof input.traktEligible !== "boolean") {
    throw new TypeError("traktEligible must be a boolean");
  }
  if (input.traktEligible && canonicalIdentity === null) {
    throw new TypeError("traktEligible requires a canonicalIdentity");
  }
  if (!Array.isArray(input.inlineSubtitles)) throw new TypeError("inlineSubtitles must be an array");

  const contentKey = input.contentKey === null ? null : input.contentKey;
  if (contentKey !== null) {
    assertBoundedString(contentKey, "contentKey", MAX_FINGERPRINT_VALUE_LENGTH, {
      rejectControls: true,
      requireTrimmed: true,
    });
  }
  if (hasOwn(expected, "contentKey") && contentKey !== expected.contentKey) {
    throw new TypeError("context contentKey changed during merge");
  }

  const createdAtMs = parseContextIsoTimestamp(input.createdAt, "createdAt");
  const expiresAtMs = parseContextIsoTimestamp(input.expiresAt, "expiresAt");
  if (expiresAtMs <= createdAtMs) throw new TypeError("context expiry must follow creation time");
  if (
    (hasOwn(expected, "createdAt") && input.createdAt !== expected.createdAt) ||
    (hasOwn(expected, "expiresAt") && input.expiresAt !== expected.expiresAt)
  ) {
    throw new TypeError("context timestamps changed during merge");
  }
  return input;
}

function readPositiveInteger(value, name, fallback, maximum) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new TypeError(name + " must be a bounded positive integer");
  }
  return resolved;
}

function addMilliseconds(timestamp, duration) {
  if (timestamp > MAX_DATE_MS - duration) throw new RangeError("clock value is out of range");
  return timestamp + duration;
}

function toIsoString(timestamp) {
  return new Date(timestamp).toISOString();
}

function parseLaunchedAt(value) {
  let timestamp;
  if (typeof value === "number") {
    timestamp = value;
  } else if (typeof value === "string") {
    assertBoundedString(value, "launchedAt", 64, {
      rejectControls: true,
      requireTrimmed: true,
    });
    timestamp = Date.parse(value);
  } else {
    throw new TypeError("launchedAt must be a timestamp or ISO date string");
  }

  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_DATE_MS) {
    throw new TypeError("launchedAt must be a valid timestamp");
  }
  return timestamp;
}

function assertNoIpInputs(request) {
  const objects = [request];
  if (request.client !== undefined) {
    assertPlainObject(request.client, "client");
    objects.push(request.client);
  }

  for (const object of objects) {
    for (const key of Object.keys(object)) {
      if (FORBIDDEN_IP_KEYS.has(key.toLowerCase())) {
        throw new TypeError("IP inputs are not accepted by source-context claims");
      }
    }
  }
}

function contextMapKey(profileId, fingerprint) {
  return JSON.stringify([profileId, fingerprint]);
}

function claimAttemptMapKey(profileId, deviceId, attemptId) {
  return JSON.stringify([profileId, deviceId, attemptId]);
}

function sameNormalizedFingerprints(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((fingerprint, index) => fingerprint === right[index])
  );
}

function sameClaimAttemptBinding(attempt, binding) {
  return Boolean(
    attempt &&
      attempt.attemptId === binding.attemptId &&
      sameNormalizedFingerprints(attempt.fingerprints, binding.fingerprints) &&
      attempt.intentUrlHash === binding.intentUrlHash &&
      attempt.launchedAtMs === binding.launchedAtMs &&
      attempt.requestDigest === binding.requestDigest &&
      attempt.sessionId === binding.sessionId &&
      attempt.generation === binding.generation &&
      attempt.deviceGeneration === binding.deviceGeneration
  );
}

function memoryContextEquivalenceIdentity(contentKey, fingerprints) {
  if (contentKey === null) return null;
  const hash = createHash("sha256");
  hash.update("jumpgate-memory-playback-equivalence:v1\0", "utf8");
  for (const value of [contentKey, ...fingerprints.slice().sort()]) {
    hash.update(String(Buffer.byteLength(value, "utf8")) + ":", "utf8");
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

function createStoredContextIdentity(
  profileId,
  contextId,
  contentKey,
  fingerprints,
  createdAtMs,
  expiresAtMs,
  generation,
  revision,
  providerRevision
) {
  const canonicalFingerprints = Object.freeze(fingerprints.slice());
  return Object.freeze({
    profileId,
    contextId,
    ref: contextId,
    contentKey,
    fingerprints: canonicalFingerprints,
    createdAtMs,
    expiresAtMs,
    createdAt: toIsoString(createdAtMs),
    expiresAt: toIsoString(expiresAtMs),
    equivalenceIdentity: memoryContextEquivalenceIdentity(contentKey, canonicalFingerprints),
    generation: assertProfileGeneration(generation),
    revision: privateRevision(revision, "playback context revision"),
    providerRevision: privateRevision(providerRevision, "provider revision"),
  });
}

function capacityError(kind) {
  const error = new Error(kind + " capacity reached");
  error.code = kind + "_capacity";
  return error;
}

function codedContextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertProfileGeneration(value) {
  if (typeof value !== "string" || !PROFILE_GENERATION_PATTERN.test(value)) {
    throw new TypeError("profile generation is invalid");
  }
  return value;
}

function providerPendingDeadline(generation) {
  const match = String(generation).match(PROVIDER_PENDING_GENERATION_PATTERN);
  if (!match) return null;
  const deadline = Number(match[1]);
  return Number.isSafeInteger(deadline) && deadline >= 0 && deadline <= MAX_DATE_MS
    ? deadline
    : null;
}

function providerSnapshotAuthority(repository) {
  if (!repository || typeof repository !== "object") return null;
  for (const method of PROVIDER_SNAPSHOT_AUTHORITY_METHODS) {
    if (typeof repository[method] !== "function") return null;
  }
  return repository;
}

function assertProviderSnapshotAuthority(repository) {
  if (!providerSnapshotAuthority(repository)) {
    throw new TypeError("provider snapshot authority is unavailable");
  }
  return repository;
}

async function recoverProviderSnapshotMutation(providers, authority, profileId) {
  if (
    !providers ||
    typeof providers.allocateMutationFence !== "function" ||
    typeof providers.advanceMutationFence !== "function" ||
    !authority ||
    typeof authority.probeProviderSnapshotRecovery !== "function" ||
    typeof authority.beginProviderSnapshotRecovery !== "function" ||
    typeof authority.completeProviderSnapshotRecovery !== "function"
  ) {
    return false;
  }
  let available = await authority.probeProviderSnapshotRecovery(profileId);
  if (available === null) return false;
  for (let attempt = 0; attempt < MAX_PROVIDER_SNAPSHOT_ATTEMPTS; attempt += 1) {
    if (
      !available ||
      typeof available !== "object" ||
      Array.isArray(available) ||
      typeof available.token !== "string" ||
      (available.phase !== "fenced" && available.phase !== "recovering")
    ) {
      throw new TypeError("provider snapshot recovery is invalid");
    }
    let recovery = {
      token: assertProfileGeneration(available.token),
      fence: privateRevision(available.fence, "provider snapshot recovery fence"),
      phase: available.phase,
    };
    if (providerPendingDeadline(recovery.token) === null) {
      throw new TypeError("provider snapshot recovery is invalid");
    }
    let profileInactive = false;
    if (recovery.phase === "fenced") {
      let candidateFence = "0";
      try {
        candidateFence = privateRevision(
          await providers.allocateMutationFence(profileId),
          "allocated provider snapshot recovery fence"
        );
      } catch (error) {
        if (!error || error.code !== "profile_inactive") throw error;
        profileInactive = true;
      }
      const begun = await authority.beginProviderSnapshotRecovery(
        profileId,
        candidateFence,
        recovery.fence
      );
      if (begun === null) return false;
      recovery = {
        token: assertProfileGeneration(begun.token),
        fence: privateRevision(begun.fence, "provider snapshot recovery fence"),
        phase: "recovering",
      };
    }
    if (!profileInactive) {
      try {
        await providers.advanceMutationFence(profileId, recovery.fence);
      } catch (error) {
        if (error && error.code === "provider_snapshot_stale_fence") {
          const candidateFence = privateRevision(
            await providers.allocateMutationFence(profileId),
            "allocated provider snapshot recovery fence"
          );
          const replacement = await authority.beginProviderSnapshotRecovery(
            profileId,
            candidateFence,
            recovery.fence
          );
          if (replacement === null) return false;
          const replacementFence = privateRevision(
            replacement.fence,
            "provider snapshot recovery fence"
          );
          if (replacementFence === recovery.fence) {
            throw codedContextError(
              "provider_snapshot_contention",
              "provider snapshot recovery did not supersede a stale fence"
            );
          }
          available = {
            token: assertProfileGeneration(replacement.token),
            fence: replacementFence,
            phase: "recovering",
          };
          continue;
        }
        if (!error || error.code !== "profile_inactive") throw error;
        profileInactive = true;
      }
    }
    try {
      await authority.completeProviderSnapshotRecovery(
        profileId,
        recovery.token,
        recovery.fence
      );
      return true;
    } catch (error) {
      if (!error || error.code !== "provider_snapshot_changed") throw error;
      const state = await authority.getProviderSnapshotState(profileId);
      if (state && state.pending === false) return true;
      available = await authority.probeProviderSnapshotRecovery(profileId);
      if (available === null) return false;
    }
  }
  throw codedContextError(
    "provider_snapshot_contention",
    "provider snapshot recovery contention limit reached"
  );
}

function normalizeProviderSnapshotState(state) {
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    typeof state.pending !== "boolean"
  ) {
    throw new TypeError("provider snapshot state is invalid");
  }
  const generation = assertProfileGeneration(state.generation);
  if (state.pending !== (providerPendingDeadline(generation) !== null)) {
    throw new TypeError("provider snapshot state is invalid");
  }
  return Object.freeze({ generation, pending: state.pending });
}

async function readProviderSnapshotState(playbackContexts, profileId, providers = null) {
  const id = assertIdentifier(profileId, "profileId");
  const authority = assertProviderSnapshotAuthority(playbackContexts);
  let state = normalizeProviderSnapshotState(await authority.getProviderSnapshotState(id));
  if (state.pending && providers) {
    const recovered = await recoverProviderSnapshotMutation(providers, authority, id);
    if (recovered) {
      state = normalizeProviderSnapshotState(await authority.getProviderSnapshotState(id));
    }
  }
  return state;
}

async function readProviderCollectionSnapshot(
  providers,
  playbackContexts,
  profileId,
  options = {}
) {
  if (!providers || typeof providers.list !== "function") {
    throw new TypeError("providers repository is invalid");
  }
  if (!playbackContexts || typeof playbackContexts.getProfileGeneration !== "function") {
    throw new TypeError("playback context snapshot coordinator is invalid");
  }
  assertProviderSnapshotAuthority(playbackContexts);
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("provider snapshot read options are invalid");
  }
  const id = assertIdentifier(profileId, "profileId");
  for (let attempt = 0; attempt < MAX_PROVIDER_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await readProviderSnapshotState(playbackContexts, id, providers);
    if (before.pending) {
      await Promise.resolve();
      continue;
    }
    const collection = await providers.list(id, options);
    const after = await readProviderSnapshotState(playbackContexts, id, providers);
    if (!after.pending && after.generation === before.generation) {
      return Object.freeze({ collection, generation: after.generation });
    }
    await Promise.resolve();
  }
  throw codedContextError(
    "provider_snapshot_contention",
    "provider snapshot did not stabilize within the retry limit"
  );
}

async function runProviderSnapshotMutation(
  providers,
  authority,
  profileId,
  operation,
  returnCompletedGeneration = false
) {
  if (
    typeof providers.allocateMutationFence !== "function" ||
    typeof authority.fenceProviderSnapshotMutation !== "function" ||
    typeof authority.releaseProviderSnapshotMutation !== "function"
  ) {
    throw new TypeError("provider snapshot mutation fencing is unavailable");
  }
  let token = null;
  for (let attempt = 0; attempt < MAX_PROVIDER_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      token = await authority.beginProviderSnapshotMutation(profileId);
      break;
    } catch (error) {
      if (!error || error.code !== "provider_snapshot_busy") throw error;
      await recoverProviderSnapshotMutation(providers, authority, profileId);
      await Promise.resolve();
    }
  }
  if (token === null) {
    throw codedContextError(
      "provider_snapshot_contention",
      "provider snapshot mutation contention limit reached"
    );
  }

  let value;
  let failure = null;
  let fenced = false;
  try {
    const allocatedFence = privateRevision(
      await providers.allocateMutationFence(profileId),
      "allocated provider snapshot fence"
    );
    const fence = await authority.fenceProviderSnapshotMutation(
      profileId,
      token,
      allocatedFence
    );
    if (privateRevision(fence.fence, "provider snapshot fence") !== allocatedFence) {
      throw new TypeError("provider snapshot authority returned a different mutation fence");
    }
    fenced = true;
    value = await operation(allocatedFence);
  } catch (error) {
    failure = error;
  }
  let completedGeneration;
  try {
    if (fenced) {
      completedGeneration = await authority.completeProviderSnapshotMutation(profileId, token);
    } else {
      await authority.releaseProviderSnapshotMutation(profileId, token);
    }
  } catch (error) {
    if (failure === null) failure = error;
  }
  if (failure !== null) throw failure;
  return returnCompletedGeneration ? completedGeneration : value;
}

async function withProviderSnapshotMutation(providers, playbackContexts, profileId, operation) {
  if (typeof operation !== "function") throw new TypeError("provider mutation is invalid");
  const id = assertIdentifier(profileId, "profileId");
  const authority = providerSnapshotAuthority(playbackContexts);
  if (!authority) {
    throw new TypeError("provider snapshot mutation fencing is unavailable");
  }
  return runProviderSnapshotMutation(providers, authority, id, operation);
}

function replaceProviderCollection(
  providers,
  playbackContexts,
  profileId,
  descriptors,
  expectedRevision
) {
  if (!providers || typeof providers.replaceAll !== "function") {
    throw new TypeError("providers repository is invalid");
  }
  return withProviderSnapshotMutation(providers, playbackContexts, profileId, (mutationFence) =>
    providers.replaceAll(
      profileId,
      descriptors,
      expectedRevision,
      { mutationFence }
    )
  );
}

async function invalidateProviderSnapshot(playbackContexts, providers, profileId) {
  const id = assertIdentifier(profileId, "profileId");
  await readProviderSnapshotState(playbackContexts, id, providers);
  return playbackContexts.invalidateProfile(id);
}

function privateRevision(value, name, fallback = undefined) {
  const candidate = value === undefined ? fallback : value;
  let normalized;
  if (typeof candidate === "bigint") normalized = candidate.toString();
  else if (typeof candidate === "number") {
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      throw new TypeError(name + " is invalid");
    }
    normalized = String(candidate);
  } else normalized = candidate;
  if (typeof normalized !== "string" || !PRIVATE_REVISION_PATTERN.test(normalized)) {
    throw new TypeError(name + " is invalid");
  }
  return normalized;
}

function incrementPrivateRevision(value, name) {
  const next = (BigInt(privateRevision(value, name)) + 1n).toString();
  if (!PRIVATE_REVISION_PATTERN.test(next)) {
    throw codedContextError("context_revision_exhausted", "playback context revision exhausted");
  }
  return next;
}

function maximumPrivateRevision(left, right, name) {
  const safeLeft = privateRevision(left, name);
  const safeRight = privateRevision(right, name);
  if (safeLeft.length !== safeRight.length) {
    return safeLeft.length > safeRight.length ? safeLeft : safeRight;
  }
  return safeLeft >= safeRight ? safeLeft : safeRight;
}

function sameFingerprintSet(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === right.length && right.every((fingerprint) => expected.has(fingerprint));
}

function mergeStoredContext(previousContext, candidateContext) {
  const previous = validateStoredContext(previousContext);
  const candidate = validateStoredContext(candidateContext);
  if (
    previous.profileId !== candidate.profileId ||
    previous.contentKey !== candidate.contentKey ||
    !sameFingerprintSet(previous.fingerprints, candidate.fingerprints)
  ) {
    throw new TypeError("playback contexts are not equivalent");
  }

  const merged = {
    ...deepClone(candidate),
    contextId: previous.contextId,
    canonicalIdentity: deepClone(previous.canonicalIdentity),
    traktEligible: previous.traktEligible === true,
    request: mergeProvenanceFields(
      previous.request,
      candidate.request,
      "streamProvider",
      "streamProviders"
    ),
    source: mergeProvenanceFields(previous.source, candidate.source, "provider", "providers"),
    inlineSubtitles: mergeUniqueContextArray(previous.inlineSubtitles, candidate.inlineSubtitles),
    createdAt: previous.createdAt,
  };
  return validateStoredContext(merged, {
    contextId: previous.contextId,
    profileId: previous.profileId,
    contentKey: previous.contentKey,
    fingerprints: candidate.fingerprints,
    createdAt: previous.createdAt,
    expiresAt: candidate.expiresAt,
  });
}

class SourceContextStore {
  constructor(options = {}) {
    assertPlainObject(options, "options");

    const suppliedClock = options.clock === undefined ? options.now : options.clock;
    if (suppliedClock === undefined) {
      this._clock = Date.now;
    } else if (typeof suppliedClock === "function") {
      this._clock = suppliedClock;
    } else if (suppliedClock && typeof suppliedClock.now === "function") {
      this._clock = () => suppliedClock.now();
    } else {
      throw new TypeError("clock must be a function or expose now()");
    }

    this._idFactory = options.idFactory === undefined ? () => randomUUID() : options.idFactory;
    if (typeof this._idFactory !== "function") throw new TypeError("idFactory must be a function");
    this._generationFactory =
      options.generationFactory === undefined
        ? () => "g1:" + randomUUID()
        : options.generationFactory;
    if (typeof this._generationFactory !== "function") {
      throw new TypeError("generationFactory must be a function");
    }

    this._ttlMs = readPositiveInteger(options.ttlMs, "ttlMs", 120000, MAX_TTL_MS);
    this._tombstoneTtlMs = readPositiveInteger(
      options.tombstoneTtlMs,
      "tombstoneTtlMs",
      120000,
      MAX_TTL_MS
    );
    this._maxContexts = readPositiveInteger(options.maxContexts, "maxContexts", 2048, 100000);
    this._maxContextsPerProfile = readPositiveInteger(
      options.maxContextsPerProfile,
      "maxContextsPerProfile",
      128,
      100000
    );
    this._maxClaims = readPositiveInteger(options.maxClaims, "maxClaims", 2048, 100000);
    this._maxClaimsPerProfile = readPositiveInteger(
      options.maxClaimsPerProfile,
      "maxClaimsPerProfile",
      128,
      100000
    );
    this._maxClaimAttempts = readPositiveInteger(
      options.maxClaimAttempts,
      "maxClaimAttempts",
      Math.min(100000, this._maxClaims * 4),
      100000
    );
    this._maxClaimAttemptsPerProfile = readPositiveInteger(
      options.maxClaimAttemptsPerProfile,
      "maxClaimAttemptsPerProfile",
      Math.min(100000, this._maxClaimsPerProfile * 4),
      100000
    );
    this._maxTombstones = readPositiveInteger(
      options.maxTombstones,
      "maxTombstones",
      8192,
      200000
    );
    this._maxTombstonesPerProfile = readPositiveInteger(
      options.maxTombstonesPerProfile,
      "maxTombstonesPerProfile",
      512,
      200000
    );
    this._maxLaunchAgeMs = readPositiveInteger(
      options.maxLaunchAgeMs,
      "maxLaunchAgeMs",
      Math.min(MAX_TTL_MS, this._ttlMs + 30000),
      MAX_TTL_MS
    );
    this._maxFutureLaunchSkewMs = readPositiveInteger(
      options.maxFutureLaunchSkewMs,
      "maxFutureLaunchSkewMs",
      30000,
      MAX_TTL_MS
    );
    this._maxContextAfterLaunchMs = readPositiveInteger(
      options.maxContextAfterLaunchMs,
      "maxContextAfterLaunchMs",
      15000,
      MAX_TTL_MS
    );
    this._providerMutationLeaseMs = readPositiveInteger(
      options.providerMutationLeaseMs,
      "providerMutationLeaseMs",
      DEFAULT_PROVIDER_SNAPSHOT_LEASE_MS,
      MAX_TTL_MS
    );
    this._deviceGenerationTtlMs = readPositiveInteger(
      options.deviceGenerationTtlMs,
      "deviceGenerationTtlMs",
      MAX_TTL_MS,
      MAX_TTL_MS
    );
    this._maxDeviceGenerationsPerProfile = readPositiveInteger(
      options.maxDeviceGenerationsPerProfile,
      "maxDeviceGenerationsPerProfile",
      1024,
      100000
    );

    this._contexts = new Map();
    this._claims = new Map();
    this._claimAttempts = new Map();
    this._tombstones = new Map();
    this._profileGenerations = new Map();
    this._deviceGenerations = new Map();
    this._providerSnapshotMutations = new Map();
    this._lastNow = 0;
  }

  getProfileGeneration(profileId) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    return this._profileGenerations.get(scopedProfileId) || INITIAL_PROFILE_GENERATION;
  }

  getProviderSnapshotState(profileId) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const generation = this.getProfileGeneration(scopedProfileId);
    const deadline = providerPendingDeadline(generation);
    if (deadline === null) {
      this._providerSnapshotMutations.delete(scopedProfileId);
      return Object.freeze({ generation, pending: false });
    }
    const mutation = this._providerSnapshotMutations.get(scopedProfileId);
    if (mutation && mutation.token === generation) {
      if (mutation.phase === "fenced" || mutation.phase === "recovering") {
        return Object.freeze({ generation, pending: true });
      }
      if (mutation.phase !== "leased") {
        throw new TypeError("provider snapshot mutation state is invalid");
      }
      const now = this._readNow();
      if (mutation.expiresAtMs > now) {
        return Object.freeze({ generation, pending: true });
      }
      return Object.freeze({
        generation: this._recoverProviderSnapshotMutation(scopedProfileId, generation),
        pending: false,
      });
    }
    const now = this._readNow();
    if (deadline > now) return Object.freeze({ generation, pending: true });
    return Object.freeze({
      generation: this._recoverProviderSnapshotMutation(scopedProfileId, generation),
      pending: false,
    });
  }

  beginProviderSnapshotMutation(profileId) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const state = this.getProviderSnapshotState(scopedProfileId);
    if (state.pending) {
      throw codedContextError("provider_snapshot_busy", "provider snapshot mutation is active");
    }
    const now = this._readNow();
    const deadline = addMilliseconds(now, this._providerMutationLeaseMs);
    const seed = this._nextProfileGeneration(scopedProfileId, state.generation);
    const digest = createHash("sha256")
      .update(scopedProfileId + "\0" + state.generation + "\0" + seed, "utf8")
      .digest("base64url");
    const pending = assertProfileGeneration("g1:w_" + deadline + "_" + digest);
    this._clearProfileState(scopedProfileId);
    this._profileGenerations.set(scopedProfileId, pending);
    this._providerSnapshotMutations.set(scopedProfileId, {
      token: pending,
      phase: "leased",
      expiresAtMs: deadline,
      fence: "0",
    });
    return pending;
  }

  renewProviderSnapshotMutation(profileId, token) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const expected = assertProfileGeneration(token);
    if (providerPendingDeadline(expected) === null) {
      throw new TypeError("provider snapshot mutation token is invalid");
    }
    const mutation = this._providerSnapshotMutations.get(scopedProfileId);
    const now = this._readNow();
    if (
      this.getProfileGeneration(scopedProfileId) !== expected ||
      !mutation ||
      mutation.token !== expected ||
      mutation.phase !== "leased"
    ) {
      return Object.freeze({ renewed: false });
    }
    if (mutation.expiresAtMs <= now) {
      this._recoverProviderSnapshotMutation(scopedProfileId, expected);
      return Object.freeze({ renewed: false });
    }
    mutation.expiresAtMs = addMilliseconds(now, this._providerMutationLeaseMs);
    return Object.freeze({ renewed: true, expiresAt: mutation.expiresAtMs });
  }

  fenceProviderSnapshotMutation(profileId, token, mutationFence) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const expected = assertProfileGeneration(token);
    if (providerPendingDeadline(expected) === null) {
      throw new TypeError("provider snapshot mutation token is invalid");
    }
    const fence = privateRevision(mutationFence, "provider snapshot fence");
    const mutation = this._providerSnapshotMutations.get(scopedProfileId);
    if (
      this.getProfileGeneration(scopedProfileId) !== expected ||
      !mutation ||
      mutation.token !== expected
    ) {
      throw codedContextError("provider_snapshot_changed", "provider snapshot mutation was superseded");
    }
    if (mutation.phase === "fenced") {
      if (mutation.fence !== fence) {
        throw codedContextError("provider_snapshot_changed", "provider snapshot mutation was superseded");
      }
      return Object.freeze({ token: expected, fence: mutation.fence });
    }
    if (mutation.phase === "recovering") {
      throw codedContextError("provider_snapshot_changed", "provider snapshot mutation was superseded");
    }
    if (mutation.phase !== "leased") {
      throw new TypeError("provider snapshot mutation state is invalid");
    }
    if (mutation.expiresAtMs <= this._readNow()) {
      this._recoverProviderSnapshotMutation(scopedProfileId, expected);
      throw codedContextError("provider_snapshot_changed", "provider snapshot mutation was superseded");
    }
    mutation.fence = fence;
    mutation.phase = "fenced";
    return Object.freeze({ token: expected, fence: mutation.fence });
  }

  probeProviderSnapshotRecovery(profileId) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const generation = this.getProfileGeneration(scopedProfileId);
    if (providerPendingDeadline(generation) === null) return null;
    const mutation = this._providerSnapshotMutations.get(scopedProfileId);
    if (!mutation || mutation.token !== generation) return null;
    if (mutation.phase === "recovering") {
      return Object.freeze({ token: generation, fence: mutation.fence, phase: "recovering" });
    }
    if (mutation.phase !== "fenced" || mutation.expiresAtMs > this._readNow()) return null;
    return Object.freeze({ token: generation, fence: mutation.fence, phase: "fenced" });
  }

  beginProviderSnapshotRecovery(profileId, candidateFence, expectedRecoveryFence) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const candidate = privateRevision(candidateFence, "provider snapshot recovery candidate fence");
    const available = this.probeProviderSnapshotRecovery(scopedProfileId);
    if (available === null) return null;
    const mutation = this._providerSnapshotMutations.get(scopedProfileId);
    const expected = expectedRecoveryFence === undefined
      ? null
      : privateRevision(expectedRecoveryFence, "expected provider snapshot recovery fence");
    if (
      mutation.phase === "recovering" &&
      (expected === null || mutation.fence !== expected)
    ) {
      return Object.freeze({ token: available.token, fence: mutation.fence });
    }
    if (expected !== null && mutation.fence !== expected) {
      return Object.freeze({ token: available.token, fence: mutation.fence });
    }
    const fenceRevision =
      maximumPrivateRevision(
        incrementPrivateRevision(mutation.fence, "provider snapshot recovery fence"),
        candidate,
        "provider snapshot recovery fence"
      );
    mutation.phase = "recovering";
    mutation.fence = fenceRevision;
    return Object.freeze({ token: available.token, fence: fenceRevision });
  }

  completeProviderSnapshotRecovery(profileId, token, recoveryFence) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const expected = assertProfileGeneration(token);
    const fence = privateRevision(recoveryFence, "provider snapshot recovery fence");
    const mutation = this._providerSnapshotMutations.get(scopedProfileId);
    if (
      providerPendingDeadline(expected) === null ||
      this.getProfileGeneration(scopedProfileId) !== expected ||
      !mutation ||
      mutation.token !== expected ||
      mutation.phase !== "recovering" ||
      mutation.fence !== fence
    ) {
      throw codedContextError("provider_snapshot_changed", "provider snapshot recovery was superseded");
    }
    const generation = this._nextStableGeneration(scopedProfileId, expected);
    this._profileGenerations.set(scopedProfileId, generation);
    this._providerSnapshotMutations.delete(scopedProfileId);
    return generation;
  }

  releaseProviderSnapshotMutation(profileId, token) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const expected = assertProfileGeneration(token);
    if (providerPendingDeadline(expected) === null) return false;
    const mutation = this._providerSnapshotMutations.get(scopedProfileId);
    if (
      this.getProfileGeneration(scopedProfileId) !== expected ||
      !mutation ||
      mutation.token !== expected ||
      mutation.phase !== "leased"
    ) {
      return false;
    }
    if (mutation.expiresAtMs <= this._readNow()) {
      this._recoverProviderSnapshotMutation(scopedProfileId, expected);
      return false;
    }
    this._recoverProviderSnapshotMutation(scopedProfileId, expected);
    return true;
  }

  completeProviderSnapshotMutation(profileId, token) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const expected = assertProfileGeneration(token);
    if (providerPendingDeadline(expected) === null) {
      throw new TypeError("provider snapshot mutation token is invalid");
    }
    const mutation = this._providerSnapshotMutations.get(scopedProfileId);
    if (
      this.getProfileGeneration(scopedProfileId) !== expected ||
      !mutation ||
      mutation.token !== expected
    ) {
      throw codedContextError("provider_snapshot_changed", "provider snapshot mutation was superseded");
    }
    if (mutation.phase === "recovering") {
      throw codedContextError("provider_snapshot_changed", "provider snapshot mutation was superseded");
    }
    if (mutation.phase !== "fenced") {
      throw codedContextError("provider_snapshot_unfenced", "provider snapshot mutation is not fenced");
    }
    const generation = this._nextStableGeneration(scopedProfileId, expected);
    this._profileGenerations.set(scopedProfileId, generation);
    this._providerSnapshotMutations.delete(scopedProfileId);
    return generation;
  }

  invalidateProfile(profileId) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const state = this.getProviderSnapshotState(scopedProfileId);
    if (state.pending) {
      throw codedContextError("provider_snapshot_busy", "provider snapshot mutation is active");
    }
    const previous = state.generation;
    const generation = this._nextStableGeneration(scopedProfileId, previous);
    this._clearProfileState(scopedProfileId);
    this._profileGenerations.set(scopedProfileId, generation);
    return generation;
  }

  invalidateDevice(profileId, deviceId, generation) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const scopedDeviceId = assertIdentifier(deviceId, "deviceId");
    const nextGeneration = readPositiveInteger(
      generation,
      "deviceGeneration",
      undefined,
      Number.MAX_SAFE_INTEGER
    );
    const now = this._readNow();
    this._purge(now);
    const key = contextMapKey(scopedProfileId, scopedDeviceId);
    const current = this._deviceGenerations.get(key);
    if (current && nextGeneration < current.generation) {
      throw codedContextError(
        "device_generation_changed",
        "device generation changed before invalidation"
      );
    }
    this._setDeviceGeneration(key, scopedProfileId, scopedDeviceId, nextGeneration, now);
    const removed = this._claims.delete(key);
    for (const [attemptKey, attempt] of this._claimAttempts) {
      if (attempt.profileId === scopedProfileId && attempt.deviceId === scopedDeviceId) {
        this._claimAttempts.delete(attemptKey);
      }
    }
    return removed;
  }

  clearProfile(profileId) {
    return this.invalidateProfile(profileId);
  }

  record(profileId, context, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    assertPlainObject(options, "record options");
    const generation = assertProfileGeneration(
      options.generation === undefined
        ? this.getProfileGeneration(scopedProfileId)
        : options.generation
    );
    if (providerPendingDeadline(generation) !== null) {
      throw codedContextError(
        "provider_snapshot_busy",
        "provider snapshot mutation is active"
      );
    }
    const providerRevision = privateRevision(
      options.providerRevision,
      "provider revision",
      "0"
    );
    const input = validateAndClone(assertPlainObject(context, "context"), "context");
    if (input.schemaVersion !== undefined && input.schemaVersion !== SCHEMA_VERSION) {
      throw new TypeError("context schemaVersion must be 1");
    }
    if (input.profileId !== undefined && input.profileId !== scopedProfileId) {
      throw new TypeError("context profileId does not match the record scope");
    }

    const sourceInput = input.source === undefined ? {} : assertPlainObject(input.source, "source");
    const source = projectStoredFields(sourceInput, STORED_SOURCE_KEYS);
    validateProvenanceFields(source, "provider", "providers");
    const extraFingerprints = input.fingerprints === undefined ? [] : input.fingerprints;
    const fingerprints = fingerprintStream(sourceInput, extraFingerprints);
    if (fingerprints.length === 0) {
      throw new TypeError("context requires at least one playable-source fingerprint");
    }

    const requestInput = input.request === undefined ? {} : assertPlainObject(input.request, "request");
    const request = projectStoredFields(requestInput, STORED_REQUEST_KEYS);
    validateProvenanceFields(request, "streamProvider", "streamProviders");
    const display = input.display === undefined ? {} : assertPlainObject(input.display, "display");
    const canonicalIdentity =
      input.canonicalIdentity === undefined || input.canonicalIdentity === null
        ? null
        : assertPlainObject(input.canonicalIdentity, "canonicalIdentity");
    validateCanonicalIdentity(canonicalIdentity);
    const inlineSubtitles = input.inlineSubtitles === undefined ? [] : input.inlineSubtitles;
    if (!Array.isArray(inlineSubtitles)) throw new TypeError("inlineSubtitles must be an array");

    if (input.traktEligible !== undefined && typeof input.traktEligible !== "boolean") {
      throw new TypeError("traktEligible must be a boolean");
    }
    if (input.traktEligible === true && canonicalIdentity === null) {
      throw new TypeError("traktEligible requires a canonicalIdentity");
    }
    const contentKey = input.contentKey === undefined || input.contentKey === null ? null : input.contentKey;
    if (contentKey !== null) {
      assertBoundedString(contentKey, "contentKey", MAX_FINGERPRINT_VALUE_LENGTH, {
        rejectControls: true,
        requireTrimmed: true,
      });
    }

    const now = this._readNow();
    this._purge(now);
    if (providerPendingDeadline(this.getProfileGeneration(scopedProfileId)) !== null) {
      throw codedContextError(
        "provider_snapshot_busy",
        "provider snapshot mutation is active"
      );
    }
    const expiresAtMs = addMilliseconds(now, this._ttlMs);
    const equivalent = this._findEquivalentContext(scopedProfileId, contentKey, fingerprints);
    if (generation !== this.getProfileGeneration(scopedProfileId)) {
      throw codedContextError(
        "profile_generation_changed",
        "profile generation changed before context record"
      );
    }
    if (!equivalent) {
      if (this._findOverlappingContext(scopedProfileId, fingerprints)) {
        throw codedContextError("context_overlap", "playback source is already reserved");
      }
      if (
        this._contexts.size >= this._maxContexts ||
        this._countForProfile(this._contexts, scopedProfileId) >= this._maxContextsPerProfile
      ) {
        throw capacityError("context");
      }
    } else if (
      BigInt(providerRevision) <
      BigInt(privateRevision(equivalent.providerRevision, "stored provider revision"))
    ) {
      throw codedContextError(
        "provider_revision_changed",
        "provider revision changed before context record"
      );
    }
    const contextId = equivalent ? equivalent.identity.contextId : this._nextId("context");
    const createdAtMs = equivalent ? equivalent.identity.createdAtMs : now;
    if (!equivalent && this._contexts.has(contextId)) {
      throw new Error("idFactory produced a duplicate context id");
    }
    const previousContext = equivalent
      ? validateStoredContext(equivalent.context, equivalent.identity)
      : null;
    let storedContext = {
      schemaVersion: SCHEMA_VERSION,
      contextId,
      profileId: scopedProfileId,
      contentKey,
      canonicalIdentity: previousContext
        ? deepClone(previousContext.canonicalIdentity)
        : deepClone(canonicalIdentity),
      traktEligible: previousContext
        ? previousContext.traktEligible === true
        : input.traktEligible === true,
      request: previousContext
        ? mergeProvenanceFields(
            previousContext.request,
            request,
            "streamProvider",
            "streamProviders"
          )
        : deepClone(request),
      display: deepClone(display),
      source: previousContext
        ? mergeProvenanceFields(previousContext.source, source, "provider", "providers")
        : deepClone(source),
      fingerprints: fingerprints.slice(),
      inlineSubtitles: previousContext
        ? mergeUniqueContextArray(previousContext.inlineSubtitles, inlineSubtitles)
        : deepClone(inlineSubtitles),
      createdAt: toIsoString(createdAtMs),
      expiresAt: toIsoString(expiresAtMs),
    };

    storedContext = validateStoredContext(storedContext, {
      contextId,
      profileId: scopedProfileId,
      contentKey,
      fingerprints,
      createdAt: toIsoString(createdAtMs),
      expiresAt: toIsoString(expiresAtMs),
    });

    if (previousContext) storedContext = mergeStoredContext(previousContext, storedContext);

    const revision = equivalent
      ? incrementPrivateRevision(equivalent.revision, "stored playback context revision")
      : "1";

    const identity = createStoredContextIdentity(
      scopedProfileId,
      contextId,
      contentKey,
      fingerprints,
      createdAtMs,
      expiresAtMs,
      generation,
      revision,
      providerRevision
    );
    storedContext = validateStoredContext(storedContext, identity);

    if (equivalent) this._contexts.delete(contextId);
    this._contexts.set(contextId, {
      identity,
      profileId: scopedProfileId,
      generation,
      revision,
      providerRevision,
      fingerprints: new Set(fingerprints),
      context: storedContext,
      createdAtMs,
      expiresAtMs,
    });
    return deepClone(storedContext);
  }

  claim(profileId, deviceId, request, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const scopedDeviceId = assertIdentifier(deviceId, "deviceId");
    const input = validateAndClone(assertPlainObject(request, "request"), "request");
    const claimOptions = assertExactObjectKeys(
      assertPlainObject(options, "claim options"),
      CLAIM_OPTION_KEYS,
      "claim options"
    );
    const reservedSessionId = assertIdentifier(claimOptions.sessionId, "sessionId");
    const requestDigest = assertLowercaseSha256(
      claimOptions.requestDigest,
      "requestDigest"
    );
    const expectedGeneration = claimOptions.generation === undefined
      ? null
      : assertProfileGeneration(claimOptions.generation);
    const expectedDeviceGeneration = readPositiveInteger(
      claimOptions.deviceGeneration,
      "deviceGeneration",
      1,
      Number.MAX_SAFE_INTEGER
    );
    assertNoIpInputs(input);
    const attemptId = assertCanonicalAttemptId(input.attemptId);

    if (!Array.isArray(input.fingerprints) || input.fingerprints.length === 0) {
      throw new TypeError("fingerprints must be a non-empty array");
    }
    const fingerprints = fingerprintStream({}, input.fingerprints);
    if (fingerprints.length === 0) throw new TypeError("fingerprints must be a non-empty array");

    const intentUrlHash = assertBoundedString(input.intentUrlHash, "intentUrlHash", 64, {
      rejectControls: true,
      requireTrimmed: true,
    });
    if (!LOWERCASE_SHA256_PATTERN.test(intentUrlHash)) {
      throw new TypeError("intentUrlHash must be a lowercase SHA-256 digest");
    }
    const launchedAtMs = parseLaunchedAt(input.launchedAt);

    const now = this._readNow();
    this._purge(now);
    const currentGeneration = this.getProfileGeneration(scopedProfileId);
    const boundGeneration = expectedGeneration === null
      ? currentGeneration
      : expectedGeneration;
    const claimKey = contextMapKey(scopedProfileId, scopedDeviceId);
    const attemptKey = claimAttemptMapKey(scopedProfileId, scopedDeviceId, attemptId);
    const attemptBinding = {
      attemptId,
      fingerprints,
      intentUrlHash,
      launchedAtMs,
      requestDigest,
      sessionId: reservedSessionId,
      generation: boundGeneration,
      deviceGeneration: expectedDeviceGeneration,
    };
    const priorAttempt = this._claimAttempts.get(attemptKey);
    if (priorAttempt && !sameClaimAttemptBinding(priorAttempt, attemptBinding)) {
      throw codedContextError(
        "claim_request_conflict",
        "playback claim replay authority does not match the reserved request"
      );
    }
    if (providerPendingDeadline(currentGeneration) !== null) {
      throw codedContextError(
        "provider_snapshot_busy",
        "provider snapshot mutation is active"
      );
    }
    if (expectedGeneration !== null && expectedGeneration !== currentGeneration) {
      throw codedContextError(
        "profile_generation_changed",
        "profile generation changed before playback claim"
      );
    }
    if (launchedAtMs > addMilliseconds(now, this._maxFutureLaunchSkewMs)) {
      throw new TypeError("launchedAt is too far in the future");
    }
    if (now - launchedAtMs > this._maxLaunchAgeMs) {
      throw new TypeError("launchedAt is too old");
    }
    const currentDeviceState = this._deviceGenerations.get(claimKey);
    const currentDeviceGeneration = currentDeviceState && currentDeviceState.generation;
    if (
      currentDeviceGeneration !== undefined &&
      currentDeviceGeneration !== expectedDeviceGeneration
    ) {
      throw codedContextError(
        "device_generation_changed",
        "device generation changed before playback claim"
      );
    }
    if (currentDeviceGeneration === undefined) {
      this._setDeviceGeneration(
        claimKey,
        scopedProfileId,
        scopedDeviceId,
        expectedDeviceGeneration,
        now
      );
    } else {
      this._setDeviceGeneration(
        claimKey,
        scopedProfileId,
        scopedDeviceId,
        currentDeviceGeneration,
        now
      );
    }
    if (priorAttempt) {
      if (priorAttempt.response.status !== "claimed") {
        return deepClone(priorAttempt.response);
      }
      const currentClaim = this._claims.get(claimKey);
      if (
        !currentClaim ||
        !sameClaimAttemptBinding(currentClaim, attemptBinding) ||
        currentClaim.releasedAtMs !== null ||
        currentClaim.response.status !== "claimed" ||
        currentClaim.response.sessionId !== reservedSessionId
      ) {
        return { status: "not_found", sessionId: reservedSessionId };
      }
      return deepClone(priorAttempt.response);
    }
    this._assertClaimAttemptCapacity(attemptKey, scopedProfileId);
    const previous = this._claims.get(claimKey);
    if (previous && launchedAtMs < previous.launchedAtMs) {
      const response = { status: "not_found", sessionId: reservedSessionId };
      this._storeClaimAttempt(attemptKey, {
        profileId: scopedProfileId,
        deviceId: scopedDeviceId,
        attemptId,
        fingerprints: fingerprints.slice(),
        intentUrlHash,
        launchedAtMs,
        generation: currentGeneration,
        deviceGeneration: expectedDeviceGeneration,
        requestDigest,
        sessionId: reservedSessionId,
        expiresAtMs: addMilliseconds(now, this._ttlMs),
        response,
      });
      return deepClone(response);
    }
    if (
      !previous &&
      (this._claims.size >= this._maxClaims ||
        this._countForProfile(this._claims, scopedProfileId) >= this._maxClaimsPerProfile)
    ) {
      throw capacityError("claim");
    }

    const requested = new Set(fingerprints);
    const matches = [];
    for (const stored of this._contexts.values()) {
      const identity = stored.identity;
      if (
        !identity ||
        identity.profileId !== scopedProfileId ||
        stored.generation !== currentGeneration
      ) {
        continue;
      }
      if (identity.createdAtMs > addMilliseconds(launchedAtMs, this._maxContextAfterLaunchMs)) {
        continue;
      }
      if (launchedAtMs - identity.createdAtMs > this._maxLaunchAgeMs) continue;
      let matched = false;
      for (const fingerprint of requested) {
        if (identity.fingerprints.includes(fingerprint)) {
          matched = true;
          break;
        }
      }
      if (matched) matches.push(stored);
    }

    let response;
    let stateExpiresAtMs;
    if (matches.length === 1) {
      if (this._hasActiveSessionId(reservedSessionId)) {
        throw new Error("reserved playback session id is already in use");
      }
      const match = matches[0];
      response = {
        status: "claimed",
        sessionId: reservedSessionId,
        context: deepClone(match.context),
        claimedAt: toIsoString(now),
        expiresAt: match.context.expiresAt,
      };
      stateExpiresAtMs = match.identity.expiresAtMs;
    } else if (matches.length > 1) {
      response = { status: "ambiguous", sessionId: reservedSessionId };
      stateExpiresAtMs = Math.max(...matches.map((match) => match.identity.expiresAtMs));
    } else {
      const tombstoneExpiry = this._findTombstoneExpiry(scopedProfileId, requested);
      if (tombstoneExpiry !== null) {
        response = { status: "expired", sessionId: reservedSessionId };
        stateExpiresAtMs = tombstoneExpiry;
      } else {
        response = { status: "not_found", sessionId: reservedSessionId };
        stateExpiresAtMs = addMilliseconds(now, this._ttlMs);
      }
    }

    const supersededSessionId =
      response.status === "claimed" &&
      previous &&
      previous.releasedAtMs === null &&
      previous.response.status === "claimed" &&
      previous.response.sessionId !== response.sessionId
        ? previous.response.sessionId
        : null;
    const privateState =
      response.status === "claimed"
        ? deepFreeze({
            v: 1,
            profileId: scopedProfileId,
            deviceId: scopedDeviceId,
            sessionId: response.sessionId,
            supersededSessionId,
          })
        : null;
    this._claims.delete(claimKey);
    this._claims.set(claimKey, {
      profileId: scopedProfileId,
      deviceId: scopedDeviceId,
      attemptId,
      fingerprints: fingerprints.slice(),
      deviceGeneration: expectedDeviceGeneration,
      generation: currentGeneration,
      requestDigest,
      sessionId: reservedSessionId,
      contextId: response.status === "claimed" ? response.context.contextId : null,
      intentUrlHash,
      launchedAtMs,
      claimedAtMs: response.status === "claimed" ? now : null,
      releasedAtMs: null,
      expiresAtMs: stateExpiresAtMs,
      privateState,
      response: deepClone(response),
    });
    this._storeClaimAttempt(attemptKey, {
      profileId: scopedProfileId,
      deviceId: scopedDeviceId,
      attemptId,
      fingerprints: fingerprints.slice(),
      intentUrlHash,
      launchedAtMs,
      generation: currentGeneration,
      deviceGeneration: expectedDeviceGeneration,
      requestDigest,
      sessionId: reservedSessionId,
      expiresAtMs: stateExpiresAtMs,
      response: deepClone(response),
    });
    return deepClone(response);
  }

  getActiveClaim(profileId, deviceId, sessionId) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const scopedDeviceId = assertIdentifier(deviceId, "deviceId");
    const scopedSessionId = assertIdentifier(sessionId, "sessionId");
    const now = this._readNow();
    this._purge(now);

    const claim = this._claims.get(contextMapKey(scopedProfileId, scopedDeviceId));
    if (
      !claim ||
      claim.profileId !== scopedProfileId ||
      claim.deviceId !== scopedDeviceId ||
      claim.releasedAtMs !== null ||
      claim.expiresAtMs <= now ||
      claim.response.status !== "claimed" ||
      claim.response.sessionId !== scopedSessionId
    ) {
      return null;
    }

    const currentGeneration = this.getProfileGeneration(scopedProfileId);
    const currentDeviceState = this._deviceGenerations.get(
      contextMapKey(scopedProfileId, scopedDeviceId)
    );
    const currentDeviceGeneration = currentDeviceState && currentDeviceState.generation;
    const stored = claim.contextId ? this._contexts.get(claim.contextId) : null;
    const identity = stored && stored.identity;
    const privateState = claim.privateState;
    if (
      claim.generation !== currentGeneration ||
      claim.deviceGeneration !== currentDeviceGeneration ||
      !privateState ||
      Object.keys(privateState).sort().join(",") !==
        "deviceId,profileId,sessionId,supersededSessionId,v" ||
      privateState.v !== 1 ||
      privateState.profileId !== scopedProfileId ||
      privateState.deviceId !== scopedDeviceId ||
      privateState.sessionId !== scopedSessionId ||
      (privateState.supersededSessionId !== null &&
        (typeof privateState.supersededSessionId !== "string" ||
          privateState.supersededSessionId.length < 1 ||
          privateState.supersededSessionId.length > MAX_ID_LENGTH ||
          privateState.supersededSessionId.trim() !== privateState.supersededSessionId ||
          /[\u0000-\u001f\u007f]/.test(privateState.supersededSessionId))) ||
      !stored ||
      !identity ||
      stored.profileId !== scopedProfileId ||
      stored.profileId !== identity.profileId ||
      stored.generation !== currentGeneration ||
      stored.generation !== identity.generation ||
      stored.revision !== identity.revision ||
      stored.providerRevision !== identity.providerRevision ||
      stored.createdAtMs !== identity.createdAtMs ||
      stored.expiresAtMs !== identity.expiresAtMs ||
      identity.profileId !== scopedProfileId ||
      identity.contextId !== claim.contextId ||
      identity.ref !== claim.contextId ||
      identity.expiresAtMs <= now ||
      identity.fingerprints.length !== stored.fingerprints.size ||
      identity.fingerprints.some((fingerprint) => !stored.fingerprints.has(fingerprint))
    ) {
      return null;
    }

    try {
      const storedContext = validateStoredContext(stored.context, identity);
      if (
        memoryContextEquivalenceIdentity(storedContext.contentKey, storedContext.fingerprints) !==
        identity.equivalenceIdentity
      ) {
        return null;
      }
      const deliveryBinding = {
        profileId: scopedProfileId,
        deviceId: scopedDeviceId,
        sessionId: scopedSessionId,
        generation: identity.generation,
        contextId: identity.contextId,
        contextRevision: identity.revision,
        providerRevision: identity.providerRevision,
        ...(privateState.supersededSessionId
          ? { supersededSessionId: privateState.supersededSessionId }
          : {}),
      };
      return deepFreeze({
        status: "claimed",
        sessionId: scopedSessionId,
        context: storedContext,
        claimedAt: toIsoString(claim.claimedAtMs),
        expiresAt: toIsoString(claim.expiresAtMs),
        deliveryBinding,
      });
    } catch (_error) {
      return null;
    }
  }

  release(profileId, deviceId, sessionId) {
    const scopedProfileId = assertIdentifier(profileId, "profileId");
    const scopedDeviceId = assertIdentifier(deviceId, "deviceId");
    const scopedSessionId = assertIdentifier(sessionId, "sessionId");
    const now = this._readNow();
    this._purge(now);
    const claim = this._claims.get(contextMapKey(scopedProfileId, scopedDeviceId));
    if (
      !claim ||
      claim.releasedAtMs !== null ||
      claim.response.status !== "claimed" ||
      claim.response.sessionId !== scopedSessionId
    ) {
      return false;
    }
    claim.releasedAtMs = now;
    return true;
  }

  getStats() {
    const now = this._readNow();
    this._purge(now);
    return {
      contexts: this._contexts.size,
      claims: this._claims.size,
      tombstones: this._tombstones.size,
    };
  }

  prune() {
    const now = this._readNow();
    this._purge(now);
  }

  _nextProfileGeneration(profileId, previous) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generation = assertProfileGeneration(this._generationFactory(profileId, previous));
      if (generation !== previous) return generation;
    }
    throw codedContextError(
      "profile_generation_collision",
      "generationFactory did not produce a new profile generation"
    );
  }

  _nextStableGeneration(profileId, previous) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const generation = assertProfileGeneration(this._generationFactory(profileId, previous));
      if (generation !== previous && providerPendingDeadline(generation) === null) return generation;
    }
    throw codedContextError(
      "profile_generation_collision",
      "generationFactory did not produce a new stable profile generation"
    );
  }

  _recoverProviderSnapshotMutation(profileId, previous) {
    const generation = this._nextStableGeneration(profileId, previous);
    this._profileGenerations.set(profileId, generation);
    this._providerSnapshotMutations.delete(profileId);
    return generation;
  }

  _clearProfileState(profileId) {
    for (const [contextId, stored] of this._contexts) {
      if (stored.identity.profileId === profileId) this._contexts.delete(contextId);
    }
    for (const [key, claim] of this._claims) {
      if (claim.profileId === profileId) this._claims.delete(key);
    }
    for (const [key, attempt] of this._claimAttempts) {
      if (attempt.profileId === profileId) this._claimAttempts.delete(key);
    }
    for (const [key, tombstone] of this._tombstones) {
      if (tombstone.profileId === profileId) this._tombstones.delete(key);
    }
    for (const [key, generation] of this._deviceGenerations) {
      if (generation.profileId === profileId) this._deviceGenerations.delete(key);
    }
  }

  _readNow() {
    const value = Number(this._clock());
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
      throw new TypeError("clock must return a valid millisecond timestamp");
    }
    if (value < this._lastNow) return this._lastNow;
    this._lastNow = value;
    return value;
  }

  _nextId(kind) {
    return assertIdentifier(this._idFactory(kind), kind + " id");
  }

  _findEquivalentContext(profileId, contentKey, fingerprints) {
    const equivalenceIdentity = memoryContextEquivalenceIdentity(contentKey, fingerprints);
    if (equivalenceIdentity === null) return null;
    for (const stored of this._contexts.values()) {
      if (
        stored.identity.profileId === profileId &&
        stored.identity.equivalenceIdentity === equivalenceIdentity
      ) {
        return stored;
      }
    }
    return null;
  }

  _findOverlappingContext(profileId, fingerprints) {
    const requested = new Set(fingerprints);
    for (const stored of this._contexts.values()) {
      if (stored.identity.profileId !== profileId) continue;
      for (const fingerprint of requested) {
        if (stored.identity.fingerprints.includes(fingerprint)) return stored;
      }
    }
    return null;
  }

  _purge(now) {
    for (const [contextId, stored] of this._contexts) {
      const identity = stored.identity;
      if (identity.expiresAtMs > now) continue;
      this._contexts.delete(contextId);
      const retainUntilMs = addMilliseconds(identity.expiresAtMs, this._tombstoneTtlMs);
      if (retainUntilMs <= now) continue;
      for (const fingerprint of identity.fingerprints) {
        this._addTombstone(identity.profileId, fingerprint, retainUntilMs);
      }
    }

    for (const [key, tombstone] of this._tombstones) {
      if (tombstone.retainUntilMs <= now) this._tombstones.delete(key);
    }
    for (const [key, claim] of this._claims) {
      if (claim.expiresAtMs <= now) this._claims.delete(key);
    }
    for (const [key, attempt] of this._claimAttempts) {
      if (attempt.expiresAtMs <= now) this._claimAttempts.delete(key);
    }
    for (const [key, generation] of this._deviceGenerations) {
      if (generation.expiresAtMs <= now) this._deviceGenerations.delete(key);
    }
  }

  _setDeviceGeneration(key, profileId, deviceId, generation, now) {
    const existing = this._deviceGenerations.get(key);
    if (!existing && this._countForProfile(this._deviceGenerations, profileId) >=
        this._maxDeviceGenerationsPerProfile) {
      this._deleteOldestForProfile(this._deviceGenerations, profileId);
    }
    this._deviceGenerations.delete(key);
    this._deviceGenerations.set(key, {
      profileId,
      deviceId,
      generation,
      expiresAtMs: addMilliseconds(now, this._deviceGenerationTtlMs),
    });
  }

  _storeClaimAttempt(key, attempt) {
    this._assertClaimAttemptCapacity(key, attempt.profileId);
    this._claimAttempts.delete(key);
    this._claimAttempts.set(key, attempt);
  }

  _assertClaimAttemptCapacity(key, profileId) {
    if (
      !this._claimAttempts.has(key) &&
      (this._claimAttempts.size >= this._maxClaimAttempts ||
        this._countForProfile(this._claimAttempts, profileId) >=
          this._maxClaimAttemptsPerProfile)
    ) {
      throw capacityError("claim_attempt");
    }
  }

  _addTombstone(profileId, fingerprint, retainUntilMs) {
    const key = contextMapKey(profileId, fingerprint);
    const existing = this._tombstones.get(key);
    if (existing && existing.retainUntilMs >= retainUntilMs) return;
    if (
      !existing &&
      this._tombstones.size >= this._maxTombstones &&
      this._countForProfile(this._tombstones, profileId) < this._maxTombstonesPerProfile
    ) {
      return;
    }
    this._tombstones.delete(key);
    this._tombstones.set(key, { profileId, fingerprint, retainUntilMs });

    while (this._countForProfile(this._tombstones, profileId) > this._maxTombstonesPerProfile) {
      this._deleteOldestForProfile(this._tombstones, profileId);
    }
  }

  _findTombstoneExpiry(profileId, requested) {
    let expiry = null;
    for (const fingerprint of requested) {
      const tombstone = this._tombstones.get(contextMapKey(profileId, fingerprint));
      if (tombstone && (expiry === null || tombstone.retainUntilMs > expiry)) {
        expiry = tombstone.retainUntilMs;
      }
    }
    return expiry;
  }

  _countForProfile(map, profileId) {
    let count = 0;
    for (const value of map.values()) {
      const valueProfileId = value.identity ? value.identity.profileId : value.profileId;
      if (valueProfileId === profileId) count += 1;
    }
    return count;
  }

  _deleteOldestForProfile(map, profileId) {
    for (const [key, value] of map) {
      const valueProfileId = value.identity ? value.identity.profileId : value.profileId;
      if (valueProfileId !== profileId) continue;
      map.delete(key);
      return;
    }
  }

  _hasActiveSessionId(sessionId) {
    for (const claim of this._claims.values()) {
      if (claim.response.status === "claimed" && claim.response.sessionId === sessionId) return true;
    }
    return false;
  }
}

module.exports = {
  SourceContextStore,
  assertProviderSnapshotAuthority,
  fingerprintStream,
  fingerprintExactUrl,
  hashOpaqueValue,
  invalidateProviderSnapshot,
  mergeStoredContext,
  readProviderCollectionSnapshot,
  readProviderSnapshotState,
  replaceProviderCollection,
  validateStoredContext,
};
