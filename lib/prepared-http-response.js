"use strict";

const { isDeepStrictEqual, types } = require("node:util");

const MAX_PREPARED_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PREPARED_HEADERS = 32;
const MAX_PREPARED_HEADER_BYTES = 16 * 1024;
const PREPARED_HTTP_RESPONSE = Symbol.for("jumpgate.preparedHttpResponse");
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

function strictObject(value, name, expectedKeys = null) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(name + " is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " is invalid");
  }
  if (expectedKeys) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.size ||
      keys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
    ) {
      throw new TypeError(name + " is invalid");
    }
  }
  return value;
}

function normalizeStatus(value) {
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new TypeError("prepared HTTP status is invalid");
  }
  return value;
}

function normalizeHeaders(value) {
  const input = strictObject(value, "prepared HTTP headers");
  const entries = [];
  const names = new Set();
  let totalBytes = 0;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !HEADER_NAME_PATTERN.test(key)) {
      throw new TypeError("prepared HTTP header name is invalid");
    }
    const name = key.toLowerCase();
    if (names.has(name)) throw new TypeError("prepared HTTP header is duplicated");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    const headerValue = descriptor && descriptor.enumerable === true && "value" in descriptor
      ? descriptor.value
      : null;
    if (
      typeof headerValue !== "string" ||
      headerValue.length > 8192 ||
      /[\r\n\u0000]/.test(headerValue)
    ) {
      throw new TypeError("prepared HTTP header value is invalid");
    }
    totalBytes += Buffer.byteLength(name, "ascii") + Buffer.byteLength(headerValue, "utf8");
    if (totalBytes > MAX_PREPARED_HEADER_BYTES) {
      throw new RangeError("prepared HTTP headers exceed the maximum size");
    }
    names.add(name);
    entries.push([name, headerValue]);
  }
  if (entries.length > MAX_PREPARED_HEADERS) {
    throw new RangeError("prepared HTTP response has too many headers");
  }
  entries.sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeBody(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError("prepared HTTP body must be bytes");
  }
  const body = Buffer.from(value);
  if (body.length > MAX_PREPARED_BODY_BYTES) {
    throw new RangeError("prepared HTTP body exceeds the maximum size");
  }
  return body;
}

function normalizePreparedHttpResponse(value) {
  const input = strictObject(
    value,
    "prepared HTTP response",
    new Set(["status", "headers", "body"])
  );
  const body = normalizeBody(input.body);
  const headers = normalizeHeaders(input.headers);
  if (headers["content-length"] !== String(body.length)) {
    throw new TypeError("prepared HTTP Content-Length does not match the body");
  }
  return Object.freeze({
    status: normalizeStatus(input.status),
    headers,
    body,
  });
}

function normalizePreparedHttpHeadResponse(value) {
  const input = strictObject(
    value,
    "prepared HTTP HEAD response",
    new Set(["status", "headers"])
  );
  const headers = normalizeHeaders(input.headers);
  const contentLength = headers["content-length"];
  if (!/^(0|[1-9]\d*)$/.test(contentLength || "")) {
    throw new TypeError("prepared HTTP HEAD Content-Length is invalid");
  }
  const representationBytes = Number(contentLength);
  if (!Number.isSafeInteger(representationBytes) || representationBytes > MAX_PREPARED_BODY_BYTES) {
    throw new RangeError("prepared HTTP HEAD representation exceeds the maximum size");
  }
  return Object.freeze({
    status: normalizeStatus(input.status),
    headers,
  });
}

function preparedJsonResponse(status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return normalizePreparedHttpResponse({
    status,
    headers: {
      ...headers,
      "content-type": "application/json; charset=utf-8",
      "content-length": String(body.length),
    },
    body,
  });
}

function preparedHttpResponseEqual(left, right) {
  const first = normalizePreparedHttpResponse(left);
  const second = normalizePreparedHttpResponse(right);
  return (
    first.status === second.status &&
    isDeepStrictEqual(first.headers, second.headers) &&
    first.body.equals(second.body)
  );
}

function attachPreparedHttpResponse(payload, response) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("prepared HTTP payload is invalid");
  }
  Object.defineProperty(payload, PREPARED_HTTP_RESPONSE, {
    configurable: false,
    enumerable: false,
    value: normalizePreparedHttpResponse(response),
    writable: false,
  });
  return payload;
}

function getPreparedHttpResponse(payload) {
  if (!payload || typeof payload !== "object") return null;
  const response = payload[PREPARED_HTTP_RESPONSE];
  return response === undefined ? null : normalizePreparedHttpResponse(response);
}

function parsePreparedJsonResponse(response) {
  const prepared = normalizePreparedHttpResponse(response);
  let payload;
  try {
    payload = JSON.parse(prepared.body.toString("utf8"));
  } catch (_error) {
    throw new TypeError("prepared HTTP JSON body is invalid");
  }
  strictObject(payload, "prepared HTTP JSON payload");
  return attachPreparedHttpResponse(payload, prepared);
}

function encodePreparedHttpResponse(response) {
  const prepared = normalizePreparedHttpResponse(response);
  return Object.freeze({
    status: prepared.status,
    headers: prepared.headers,
    bodyBase64: prepared.body.toString("base64url"),
  });
}

function decodePreparedHttpResponse(value) {
  const input = strictObject(
    value,
    "stored prepared HTTP response",
    new Set(["status", "headers", "bodyBase64"])
  );
  if (
    typeof input.bodyBase64 !== "string" ||
    input.bodyBase64.length > Math.ceil(MAX_PREPARED_BODY_BYTES * 4 / 3) + 4 ||
    !BASE64URL_PATTERN.test(input.bodyBase64)
  ) {
    throw new TypeError("stored prepared HTTP body is invalid");
  }
  const body = Buffer.from(input.bodyBase64, "base64url");
  if (body.toString("base64url") !== input.bodyBase64) {
    throw new TypeError("stored prepared HTTP body is not canonical");
  }
  return normalizePreparedHttpResponse({
    status: input.status,
    headers: input.headers,
    body,
  });
}

module.exports = {
  MAX_PREPARED_BODY_BYTES,
  PREPARED_HTTP_RESPONSE,
  attachPreparedHttpResponse,
  decodePreparedHttpResponse,
  encodePreparedHttpResponse,
  getPreparedHttpResponse,
  normalizePreparedHttpHeadResponse,
  normalizePreparedHttpResponse,
  parsePreparedJsonResponse,
  preparedHttpResponseEqual,
  preparedJsonResponse,
};
