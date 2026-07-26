"use strict";

const { isDeepStrictEqual } = require("node:util");

const STANDARD_MANIFEST_PATH = "/manifest.json";
const LEGACY_TRANSPORT_PATH = "/stremio/v1";
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SUPPORTED_RESOURCES = new Set(["stream", "subtitles"]);

const MAX_TRANSPORT_URL_BYTES = 8 * 1024;
const MAX_RESOURCE_COMPONENT_BYTES = 256;
const MAX_RESOURCE_ID_BYTES = 8 * 1024;
const MAX_RAW_EXTRA_BYTES = 16 * 1024;
const MAX_EXTRA_NAME_BYTES = 256;
const MAX_EXTRA_VALUE_BYTES = 8 * 1024;
const MAX_EXTRA_PAIRS = 128;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_ITEMS = 10_000;
const MAX_JSON_DEPTH = 32;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const JSON_INTEGER = /^-?(?:0|[1-9]\d*)$/;
const LEGACY_RAW_JSON_NUMBERS = Symbol("legacyRawJsonNumbers");
const MAX_UNSIGNED_64 = 18_446_744_073_709_551_615n;
const MAX_SIGNED_64_MAGNITUDE = 9_223_372_036_854_775_808n;

class StremioTransportError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "StremioTransportError";
    this.code = code;
  }
}

class ProviderResponseError extends TypeError {
  constructor(message, options = {}) {
    super(message);
    this.name = "ProviderResponseError";
    this.code = "invalid_provider_response";
    if (options.rpcCode !== undefined) this.rpcCode = options.rpcCode;
  }
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function ownDataValue(object, key, label) {
  const property = Object.getOwnPropertyDescriptor(object, key);
  if (!property) return undefined;
  if (!hasOwn(property, "value")) {
    throw new StremioTransportError("invalid_resource_request", label + " must be a data property");
  }
  return property.value;
}

function assertNoForbiddenOwnKeys(object, label) {
  for (const key of Object.keys(object)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new StremioTransportError(
        "invalid_resource_request",
        label + " contains a prototype-dangerous key"
      );
    }
  }
}

function assertRawString(value, label, maximumBytes, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    byteLength(value) > maximumBytes ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new StremioTransportError("invalid_resource_request", label + " is invalid");
  }
  return value;
}

function decodeOnce(value, label, maximumBytes, options = {}) {
  assertRawString(value, label, maximumBytes * 3, options);
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch (_error) {
    throw new StremioTransportError("invalid_resource_request", label + " is malformed");
  }
  return assertRawString(decoded, label, maximumBytes, options);
}

function decodeExtraSegment(rawExtra) {
  assertRawString(rawExtra, "resource extra path segment", MAX_RAW_EXTRA_BYTES);
  const encodedPairs = rawExtra.split("&");
  if (encodedPairs.length > MAX_EXTRA_PAIRS) {
    throw new StremioTransportError(
      "invalid_resource_request",
      "resource extra path segment has too many pairs"
    );
  }

  return encodedPairs.map((encodedPair) => {
    const separator = encodedPair.indexOf("=");
    if (separator <= 0) {
      throw new StremioTransportError(
        "invalid_resource_request",
        "resource extra pair is malformed"
      );
    }
    const name = decodeOnce(
      encodedPair.slice(0, separator),
      "resource extra name",
      MAX_EXTRA_NAME_BYTES
    );
    const value = decodeOnce(
      encodedPair.slice(separator + 1),
      "resource extra value",
      MAX_EXTRA_VALUE_BYTES,
      { allowEmpty: true }
    );
    if (FORBIDDEN_KEYS.has(name)) {
      throw new StremioTransportError(
        "invalid_resource_request",
        "resource extra name is prototype-dangerous"
      );
    }
    return { name, value };
  });
}

function objectRequestShape(input) {
  if (!isPlainObject(input)) {
    throw new StremioTransportError("invalid_resource_request", "resource request is invalid");
  }
  assertNoForbiddenOwnKeys(input, "resource request");
  const allowed = new Set(["resource", "type", "id", "extra", "rawExtra", "extraPathSegment"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new StremioTransportError("invalid_resource_request", "resource request has an unknown field");
    }
  }

  const extraKeys = ["extra", "rawExtra", "extraPathSegment"].filter((key) => hasOwn(input, key));
  if (extraKeys.length > 1) {
    throw new StremioTransportError(
      "invalid_resource_request",
      "resource request has conflicting extra path segments"
    );
  }
  return {
    resource: ownDataValue(input, "resource", "resource"),
    type: ownDataValue(input, "type", "resource type"),
    id: ownDataValue(input, "id", "resource id"),
    rawExtra: extraKeys.length
      ? ownDataValue(input, extraKeys[0], "resource extra path segment")
      : undefined,
  };
}

function decodeResourceRequest(input, type, id, rawExtra) {
  const shape = typeof input === "string"
    ? { resource: input, type, id, rawExtra }
    : objectRequestShape(input);
  const resource = decodeOnce(
    shape.resource,
    "resource",
    MAX_RESOURCE_COMPONENT_BYTES
  );
  const decodedType = decodeOnce(
    shape.type,
    "resource type",
    MAX_RESOURCE_COMPONENT_BYTES
  );
  const decodedId = decodeOnce(shape.id, "resource id", MAX_RESOURCE_ID_BYTES);
  if (FORBIDDEN_KEYS.has(resource) || FORBIDDEN_KEYS.has(decodedType)) {
    throw new StremioTransportError(
      "invalid_resource_request",
      "resource request contains a prototype-dangerous component"
    );
  }
  const extra = shape.rawExtra === undefined ? [] : decodeExtraSegment(shape.rawExtra);
  return { resource, type: decodedType, id: decodedId, extra };
}

function normalizeExtraPair(pair) {
  let name;
  let value;
  if (Array.isArray(pair)) {
    if (pair.length !== 2 || !hasOwn(pair, 0) || !hasOwn(pair, 1)) {
      throw new StremioTransportError("invalid_resource_request", "resource extra pair is invalid");
    }
    [name, value] = pair;
  } else {
    if (!isPlainObject(pair)) {
      throw new StremioTransportError("invalid_resource_request", "resource extra pair is invalid");
    }
    assertNoForbiddenOwnKeys(pair, "resource extra pair");
    const keys = Object.keys(pair);
    if (keys.some((key) => key !== "name" && key !== "value") || !hasOwn(pair, "name") || !hasOwn(pair, "value")) {
      throw new StremioTransportError("invalid_resource_request", "resource extra pair is invalid");
    }
    name = ownDataValue(pair, "name", "resource extra name");
    value = ownDataValue(pair, "value", "resource extra value");
  }

  assertRawString(name, "resource extra name", MAX_EXTRA_NAME_BYTES);
  assertRawString(value, "resource extra value", MAX_EXTRA_VALUE_BYTES, { allowEmpty: true });
  if (FORBIDDEN_KEYS.has(name)) {
    throw new StremioTransportError(
      "invalid_resource_request",
      "resource extra name is prototype-dangerous"
    );
  }
  return { name, value };
}

function normalizeResourceRequest(request) {
  if (!isPlainObject(request)) {
    throw new StremioTransportError("invalid_resource_request", "resource request is invalid");
  }
  assertNoForbiddenOwnKeys(request, "resource request");
  const resource = ownDataValue(request, "resource", "resource");
  const type = ownDataValue(request, "type", "resource type");
  const id = ownDataValue(request, "id", "resource id");
  assertRawString(resource, "resource", MAX_RESOURCE_COMPONENT_BYTES);
  assertRawString(type, "resource type", MAX_RESOURCE_COMPONENT_BYTES);
  assertRawString(id, "resource id", MAX_RESOURCE_ID_BYTES);
  if (FORBIDDEN_KEYS.has(resource) || FORBIDDEN_KEYS.has(type)) {
    throw new StremioTransportError(
      "invalid_resource_request",
      "resource request contains a prototype-dangerous component"
    );
  }

  const rawExtra = hasOwn(request, "extra")
    ? ownDataValue(request, "extra", "resource extra")
    : [];
  if (!Array.isArray(rawExtra) || rawExtra.length > MAX_EXTRA_PAIRS) {
    throw new StremioTransportError("invalid_resource_request", "resource extra is invalid");
  }
  return {
    resource,
    type,
    id,
    extra: rawExtra.map(normalizeExtraPair),
  };
}

function parseTransportUrl(transportUrl) {
  if (
    typeof transportUrl !== "string" ||
    transportUrl.length === 0 ||
    transportUrl.trim() !== transportUrl ||
    byteLength(transportUrl) > MAX_TRANSPORT_URL_BYTES ||
    CONTROL_CHARACTERS.test(transportUrl) ||
    transportUrl.includes("\\") ||
    transportUrl.includes("#")
  ) {
    throw new StremioTransportError("invalid_transport_url", "provider transport URL is invalid");
  }

  const schemeSeparator = transportUrl.indexOf("://");
  if (schemeSeparator <= 0) {
    throw new StremioTransportError("invalid_transport_url", "provider transport URL is invalid");
  }
  const authorityStart = schemeSeparator + 3;
  const authorityEndMatch = transportUrl.slice(authorityStart).search(/[/?]/);
  const authorityEnd = authorityEndMatch === -1
    ? transportUrl.length
    : authorityStart + authorityEndMatch;
  if (transportUrl.slice(authorityStart, authorityEnd).includes("@")) {
    throw new StremioTransportError("invalid_transport_url", "provider transport URL cannot use userinfo");
  }

  let parsed;
  try {
    parsed = new URL(transportUrl);
  } catch (_error) {
    throw new StremioTransportError("invalid_transport_url", "provider transport URL is invalid");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password
  ) {
    throw new StremioTransportError("invalid_transport_url", "provider transport URL is invalid");
  }

  const queryIndex = transportUrl.indexOf("?");
  const endpoint = queryIndex === -1 ? transportUrl : transportUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : transportUrl.slice(queryIndex);
  if (endpoint.endsWith(STANDARD_MANIFEST_PATH) && parsed.pathname.endsWith(STANDARD_MANIFEST_PATH)) {
    return { endpoint, kind: "v3", query, value: transportUrl };
  }
  if (
    queryIndex === -1 &&
    endpoint.endsWith(LEGACY_TRANSPORT_PATH) &&
    parsed.pathname.endsWith(LEGACY_TRANSPORT_PATH)
  ) {
    return { endpoint, kind: "legacy", query: "", value: transportUrl };
  }
  throw new StremioTransportError(
    "incompatible_transport_url",
    "provider transport URL has an incompatible terminal path"
  );
}

function classifyTransportUrl(transportUrl) {
  return parseTransportUrl(transportUrl).kind;
}

function isCompatibleTransportUrl(transportUrl) {
  try {
    parseTransportUrl(transportUrl);
    return true;
  } catch (_error) {
    return false;
  }
}

function encodeComponent(value) {
  try {
    return encodeURIComponent(value);
  } catch (_error) {
    throw new StremioTransportError("invalid_resource_request", "resource request is malformed");
  }
}

function buildStandardResourceUrl(transportUrl, request) {
  const transport = parseTransportUrl(transportUrl);
  if (transport.kind !== "v3") {
    throw new StremioTransportError(
      "incompatible_transport_url",
      "standard transport URL must end with /manifest.json"
    );
  }
  const path = normalizeResourceRequest(request);
  const components = [path.resource, path.type, path.id].map(encodeComponent);
  if (path.extra.length) {
    components.push(
      path.extra
        .map(({ name, value }) => encodeComponent(name) + "=" + encodeComponent(value))
        .join("&")
    );
  }
  const resourcePath = "/" + components.join("/") + ".json";
  return (
    transport.endpoint.slice(0, -STANDARD_MANIFEST_PATH.length) +
    resourcePath +
    transport.query
  );
}

function legacyIdQuery(id) {
  const parts = id.split(":");
  if (id.startsWith("tt")) {
    if (!/^tt\d+$/.test(parts[0])) return null;
    if (parts.length === 1) return { imdb_id: parts[0] };
    if (parts.length === 3) {
      const season = parseUnsigned16(parts[1]);
      const episode = parseUnsigned16(parts[2]);
      if (season === null || episode === null) return null;
      return {
        imdb_id: parts[0],
        season,
        episode,
      };
    }
    return null;
  }
  if (id.startsWith("UC")) {
    if (!/^UC[A-Za-z0-9_-]+$/.test(parts[0])) return null;
    if (parts.length === 1) return { yt_id: parts[0] };
    if (parts.length === 2 && parts[1]) {
      return { yt_id: parts[0], video_id: parts[1] };
    }
    return null;
  }
  if (parts.length === 2 || parts.length === 3) {
    if (parts.some((part) => part.length === 0)) return null;
    if (FORBIDDEN_KEYS.has(parts[0])) {
      throw new StremioTransportError(
        "invalid_resource_request",
        "legacy resource id has a prototype-dangerous prefix"
      );
    }
    const query = {};
    Object.defineProperty(query, parts[0], {
      configurable: true,
      enumerable: true,
      value: parts[1],
      writable: true,
    });
    if (parts.length === 3) query.video_id = parts[2];
    return query;
  }
  return null;
}

function isLegacyStreamIdSupported(id) {
  if (typeof id !== "string") return false;
  try {
    return legacyIdQuery(id) !== null;
  } catch (_error) {
    return false;
  }
}

function parseUnsigned16(value) {
  if (!/^\+?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 65_535 ? number : null;
}

function firstExtraValue(extra, name) {
  const pair = extra.find((item) => item.name === name);
  return pair ? pair.value : undefined;
}

function parseVideoSize(value) {
  if (typeof value !== "string" || !JSON_NUMBER.test(value)) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  if (JSON_INTEGER.test(value) && value !== "-0") {
    const integer = BigInt(value);
    if (
      (integer >= 0n && integer <= MAX_UNSIGNED_64) ||
      (integer < 0n && -integer <= MAX_SIGNED_64_MAGNITUDE)
    ) {
      return { number, raw: integer.toString() };
    }
  }
  return { number, raw: formatRustJsonFloat(number) };
}

function formatRustJsonFloat(number) {
  if (Object.is(number, -0)) return "-0.0";
  if (number === 0) return "0.0";

  const negative = number < 0;
  const [mantissa, rawExponent] = Math.abs(number).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(rawExponent);
  const decimalPosition = exponent + 1;
  const trailingZeroes = decimalPosition - digits.length;
  let formatted;
  if (trailingZeroes >= 0 && decimalPosition <= 16) {
    formatted = digits + "0".repeat(trailingZeroes) + ".0";
  } else if (decimalPosition > 0 && decimalPosition <= 16) {
    formatted = digits.slice(0, decimalPosition) + "." + digits.slice(decimalPosition);
  } else if (decimalPosition > -5 && decimalPosition <= 0) {
    formatted = "0." + "0".repeat(-decimalPosition) + digits;
  } else if (digits.length === 1) {
    formatted = digits + "e" + exponent;
  } else {
    formatted = digits[0] + "." + digits.slice(1) + "e" + exponent;
  }
  return negative ? "-" + formatted : formatted;
}

function setRawJsonNumber(object, key, parsed) {
  object[key] = parsed.number;
  let rawNumbers = object[LEGACY_RAW_JSON_NUMBERS];
  if (!rawNumbers) {
    rawNumbers = Object.create(null);
    Object.defineProperty(object, LEGACY_RAW_JSON_NUMBERS, {
      configurable: false,
      enumerable: false,
      value: rawNumbers,
      writable: false,
    });
  }
  rawNumbers[key] = parsed.raw;
}

function buildLegacyResourcePayload(request) {
  const path = normalizeResourceRequest(request);
  let method;
  let query;
  if (path.resource === "stream") {
    query = legacyIdQuery(path.id);
    if (!query) {
      throw new StremioTransportError(
        "unsupported_legacy_request",
        "legacy stream request requires a supported id shape"
      );
    }
    query.type = path.type;
    method = "stream.find";
  } else if (path.resource === "subtitles") {
    query = { itemHash: path.id.split(":").join(" ") };
    const videoHash = firstExtraValue(path.extra, "videoHash");
    if (videoHash !== undefined) query.videoHash = videoHash;
    const videoSize = parseVideoSize(firstExtraValue(path.extra, "videoSize"));
    if (videoSize !== undefined) setRawJsonNumber(query, "videoSize", videoSize);
    const filename = firstExtraValue(path.extra, "filename");
    if (filename !== undefined) query.filename = filename;
    method = "subtitles.find";
  } else {
    throw new StremioTransportError(
      "unsupported_legacy_request",
      "legacy transport supports only stream and subtitles resources"
    );
  }

  return {
    params: [null, { query }],
    method,
    id: 1,
    jsonrpc: "2.0",
  };
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const rawNumbers = value[LEGACY_RAW_JSON_NUMBERS];
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) =>
        JSON.stringify(key) +
        ":" +
        (rawNumbers && hasOwn(rawNumbers, key) ? rawNumbers[key] : stableJson(value[key]))
      )
      .join(",") +
    "}"
  );
}

function buildLegacyResourceRequest(transportUrl, request) {
  const transport = parseTransportUrl(transportUrl);
  if (transport.kind !== "legacy") {
    throw new StremioTransportError(
      "incompatible_transport_url",
      "legacy transport URL must end with /stremio/v1"
    );
  }
  const payload = buildLegacyResourcePayload(request);
  const json = stableJson(payload);
  const encodedPayload = Buffer.from(json, "utf8").toString("base64");
  return {
    protocol: "legacy",
    method: "GET",
    url: transport.value + "/q.json?b=" + encodedPayload,
    payload,
    json,
    encodedPayload,
  };
}

function buildLegacyResourceUrl(transportUrl, request) {
  return buildLegacyResourceRequest(transportUrl, request).url;
}

function buildProviderResourceRequest(transportUrl, request) {
  const kind = classifyTransportUrl(transportUrl);
  if (kind === "legacy") return buildLegacyResourceRequest(transportUrl, request);
  return {
    protocol: "v3",
    method: "GET",
    url: buildStandardResourceUrl(transportUrl, request),
  };
}

function assertJsonTree(value, depth = 0, seen = new Set()) {
  if (depth > MAX_JSON_DEPTH) throw new ProviderResponseError("provider response is nested too deeply");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProviderResponseError("provider response has a non-finite number");
    return;
  }
  if (typeof value !== "object") {
    throw new ProviderResponseError("provider response is not JSON serializable");
  }
  if (seen.has(value)) throw new ProviderResponseError("provider response contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_RESPONSE_ITEMS) {
        throw new ProviderResponseError("provider response has too many items");
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!hasOwn(value, index)) {
          throw new ProviderResponseError("provider response contains a sparse array");
        }
        assertJsonTree(value[index], depth + 1, seen);
      }
      return;
    }
    if (!isPlainObject(value)) {
      throw new ProviderResponseError("provider response contains a non-plain object");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) {
        throw new ProviderResponseError("provider response contains a prototype-dangerous key");
      }
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property.enumerable || !hasOwn(property, "value")) {
        throw new ProviderResponseError("provider response contains a non-JSON property");
      }
      assertJsonTree(property.value, depth + 1, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function cloneProviderResponse(value) {
  assertJsonTree(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || byteLength(serialized) > MAX_RESPONSE_BYTES) {
    throw new ProviderResponseError("provider response exceeds its size limit");
  }
  const clone = JSON.parse(serialized);
  if (!isDeepStrictEqual(value, clone)) {
    throw new ProviderResponseError("provider response is not losslessly JSON serializable");
  }
  return clone;
}

function assertResource(resource) {
  if (!SUPPORTED_RESOURCES.has(resource)) {
    throw new ProviderResponseError("provider response resource is unsupported");
  }
  return resource;
}

function assertItemArray(value, label) {
  if (!Array.isArray(value)) throw new ProviderResponseError(label + " must be an array");
  if (value.length > MAX_RESPONSE_ITEMS) {
    throw new ProviderResponseError(label + " has too many items");
  }
  for (const item of value) {
    if (!isPlainObject(item)) throw new ProviderResponseError(label + " contains a malformed item");
  }
  return value;
}

function normalizeStandardResponse(resource, response) {
  const expectedResource = assertResource(resource);
  const clone = cloneProviderResponse(response);
  if (!isPlainObject(clone)) throw new ProviderResponseError("provider response root must be an object");
  const root = expectedResource === "stream" ? "streams" : "subtitles";
  if (!hasOwn(clone, root)) throw new ProviderResponseError("provider response has the wrong root");
  if (clone[root] === null) clone[root] = [];
  assertItemArray(clone[root], "provider response " + root);
  return clone;
}

function normalizeLegacyResponse(resource, response) {
  const expectedResource = assertResource(resource);
  const clone = cloneProviderResponse(response);
  if (!isPlainObject(clone)) throw new ProviderResponseError("legacy provider response root must be an object");
  if (hasOwn(clone, "error")) {
    const error = clone.error;
    const message = isPlainObject(error) && typeof error.message === "string"
      ? error.message
      : "legacy provider returned a JSON-RPC error";
    const rpcCode = isPlainObject(error) && typeof error.code === "number" ? error.code : undefined;
    throw new ProviderResponseError(message, { rpcCode });
  }
  if (!hasOwn(clone, "result")) {
    throw new ProviderResponseError("legacy provider response has the wrong root");
  }
  if (expectedResource === "stream") {
    return { streams: assertItemArray(clone.result, "legacy provider result") };
  }
  if (
    !isPlainObject(clone.result) ||
    !hasOwn(clone.result, "id") ||
    typeof clone.result.id !== "string" ||
    !hasOwn(clone.result, "all")
  ) {
    throw new ProviderResponseError("legacy subtitles result is malformed");
  }
  return { subtitles: assertItemArray(clone.result.all, "legacy provider subtitles") };
}

function normalizeProviderResponse(protocol, resource, response) {
  if (protocol === "v3" || protocol === "standard") {
    return normalizeStandardResponse(resource, response);
  }
  if (protocol === "legacy") return normalizeLegacyResponse(resource, response);
  throw new ProviderResponseError("provider response protocol is unsupported");
}

module.exports = {
  LEGACY_TRANSPORT_PATH,
  MAX_RESPONSE_BYTES,
  ProviderResponseError,
  STANDARD_MANIFEST_PATH,
  StremioTransportError,
  buildLegacyResourcePayload,
  buildLegacyResourceRequest,
  buildLegacyResourceUrl,
  buildProviderResourceRequest,
  buildStandardResourceUrl,
  buildStandardTransportUrl: buildStandardResourceUrl,
  classifyTransportUrl,
  decodeResourceRequest,
  isCompatibleTransportUrl,
  isLegacyStreamIdSupported,
  normalizeLegacyResponse,
  normalizeProviderResponse,
  normalizeResourceRequest,
  normalizeStandardResponse,
};
