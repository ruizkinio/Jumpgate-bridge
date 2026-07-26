"use strict";

const crypto = require("node:crypto");
const { normalizeSubtitlePayload } = require("./subtitle-payload");
const { assertAbortSignal } = require("./storage/object-store");
const { assertBoundedString, assertPlainObject } = require("./storage/repository-utils");
const { UpstreamFetchPolicy } = require("./upstream-fetch-policy");

const DEFAULT_MAX_INPUT_BYTES = 4 * 1024 * 1024;
const HARD_MAX_INPUT_BYTES = 16 * 1024 * 1024;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

class SubtitleSourceError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = "SubtitleSourceError";
    this.code = code;
    this.status = statusCode;
    this.statusCode = statusCode;
  }
}

function stableSourceError(error, phase) {
  if (error instanceof SubtitleSourceError) return error;
  const code = error && typeof error.code === "string" ? error.code : "";
  if (phase === "payload" || code.startsWith("subtitle_")) {
    return new SubtitleSourceError(
      "subtitle_payload_rejected",
      "subtitle payload could not be accepted",
      422
    );
  }
  return new SubtitleSourceError(
    "subtitle_source_unavailable",
    "subtitle source could not be fetched",
    502
  );
}

function readMaximum(value) {
  const maximum = value ?? DEFAULT_MAX_INPUT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > HARD_MAX_INPUT_BYTES) {
    throw new TypeError("subtitle source byte limit is invalid");
  }
  return maximum;
}

function normalizeCapability(value) {
  const input = assertPlainObject(value, "subtitle source capability");
  const allowed = new Set(["v", "url", "headers"]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      if (key === "resources" || key === "parts") {
        throw new TypeError("subtitle source capability supports exactly one URL resource");
      }
      throw new TypeError("subtitle source capability contains unsupported fields");
    }
  }
  if (input.v !== undefined && input.v !== 1) {
    throw new TypeError("subtitle source capability version is invalid");
  }
  const rawUrl = assertBoundedString(input.url, "subtitle source capability url", 8192);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    throw new TypeError("subtitle source capability url is invalid");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new TypeError("subtitle source capability url is invalid");
  }
  const suppliedHeaders = input.headers === undefined
    ? {}
    : assertPlainObject(input.headers, "subtitle source capability headers");
  if (Reflect.ownKeys(suppliedHeaders).length > 32) {
    throw new TypeError("subtitle source capability headers are invalid");
  }
  const headers = Object.create(null);
  for (const [rawName, rawValue] of Object.entries(suppliedHeaders)) {
    if (!HEADER_NAME_PATTERN.test(rawName)) {
      throw new TypeError("subtitle source capability header name is invalid");
    }
    const name = rawName.toLowerCase();
    if (Object.hasOwn(headers, name)) {
      throw new TypeError("subtitle source capability header name is duplicated");
    }
    headers[name] = assertBoundedString(
      rawValue,
      "subtitle source capability header value",
      8192,
      { minimumLength: 0, trimmed: false }
    );
  }
  return {
    url: parsed.toString(),
    parsed,
    headers: Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function admissionKey(value) {
  const scope = assertBoundedString(value, "subtitle source admission scope", 256);
  return "subtitle:" + crypto.createHash("sha256").update(scope, "utf8").digest("hex");
}

function fileNameHint(parsed) {
  const value = parsed.pathname.split("/").pop() || "subtitle";
  return value.length <= 2048 ? value : value.slice(-2048);
}

function clearNormalizedSubtitlePayload(value) {
  if (!value || typeof value !== "object") return;
  const buffers = [];
  if (Buffer.isBuffer(value.data) || value.data instanceof Uint8Array) {
    buffers.push(value.data);
  }
  if (Array.isArray(value.files)) {
    for (const file of value.files) {
      if (file && (Buffer.isBuffer(file.data) || file.data instanceof Uint8Array)) {
        buffers.push(file.data);
      }
    }
  }
  const cleared = new Set();
  for (const buffer of buffers) {
    if (cleared.has(buffer)) continue;
    cleared.add(buffer);
    const bytes = Buffer.isBuffer(buffer)
      ? buffer
      : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    bytes.fill(0);
  }
}

function copyNormalizedSubtitlePayload(value) {
  const normalized = assertPlainObject(value, "normalized subtitle payload");
  if (normalized.type === "text") {
    if (!Buffer.isBuffer(normalized.data) && !(normalized.data instanceof Uint8Array)) {
      throw new TypeError("normalized subtitle data is invalid");
    }
    return Object.freeze({
      type: normalized.type,
      format: normalized.format,
      extension: normalized.extension,
      mediaType: normalized.mediaType,
      data: Buffer.from(normalized.data),
    });
  }
  if (normalized.type !== "vobsub" || !Array.isArray(normalized.files)) {
    throw new TypeError("normalized subtitle payload is invalid");
  }
  const files = [];
  try {
    for (const raw of normalized.files) {
      const file = assertPlainObject(raw, "normalized subtitle file");
      if (!Buffer.isBuffer(file.data) && !(file.data instanceof Uint8Array)) {
        throw new TypeError("normalized subtitle file data is invalid");
      }
      files.push(Object.freeze({
        role: file.role,
        extension: file.extension,
        mediaType: file.mediaType,
        data: Buffer.from(file.data),
      }));
    }
    return Object.freeze({
      type: normalized.type,
      format: normalized.format,
      files: Object.freeze(files),
    });
  } catch (error) {
    clearNormalizedSubtitlePayload({ files });
    throw error;
  }
}

class SubtitleSource {
  constructor(options = {}) {
    const supplied = assertPlainObject(options, "subtitle source options");
    this._fetchPolicy = supplied.fetchPolicy || new UpstreamFetchPolicy(supplied.fetchOptions);
    if (!this._fetchPolicy || typeof this._fetchPolicy.fetchBuffer !== "function") {
      throw new TypeError("fetchPolicy must provide fetchBuffer()");
    }
    this._normalize = supplied.normalize || normalizeSubtitlePayload;
    if (typeof this._normalize !== "function") {
      throw new TypeError("subtitle normalizer must be a function");
    }
    this._maxInputBytes = readMaximum(supplied.maxInputBytes);
    this._payloadOptions = supplied.payloadOptions || {};
    assertPlainObject(this._payloadOptions, "subtitle payload options");
  }

  async fetch(sourceCapability, options = {}) {
    const supplied = assertPlainObject(options, "subtitle source fetch options");
    const source = normalizeCapability(sourceCapability);
    const signal = assertAbortSignal(supplied.signal);
    const scope = admissionKey(supplied.admissionScope);
    const headerNames = Object.keys(source.headers);
    let fetched = null;
    let normalized = null;
    let phase = "fetch";
    try {
      fetched = await this._fetchPolicy.fetchBuffer(source.url, {
        admissionKey: scope,
        allowedHeaderNames: headerNames,
        upstreamHeaders: source.headers,
        maxDecodedBytes: this._maxInputBytes,
        maxWireBytes: this._maxInputBytes,
        ...(signal ? { signal } : {}),
      });
      if (!fetched || !Buffer.isBuffer(fetched.body)) {
        throw new SubtitleSourceError(
          "subtitle_source_unavailable",
          "subtitle source could not be fetched",
          502
        );
      }
      phase = "payload";
      normalized = await this._normalize(fetched.body, {
        ...this._payloadOptions,
        charset: fetched.charset || null,
        contentType: fetched.contentType || null,
        fileName: fileNameHint(source.parsed),
        ...(signal ? { signal } : {}),
      });
      return Object.freeze({
        normalized: copyNormalizedSubtitlePayload(normalized),
        redirects: Number.isSafeInteger(fetched.redirects) ? fetched.redirects : 0,
        status: Number.isSafeInteger(fetched.status) ? fetched.status : 200,
      });
    } catch (error) {
      throw stableSourceError(error, phase);
    } finally {
      clearNormalizedSubtitlePayload(normalized);
      if (fetched && Buffer.isBuffer(fetched.body)) fetched.body.fill(0);
    }
  }
}

module.exports = {
  clearNormalizedSubtitlePayload,
  DEFAULT_SUBTITLE_SOURCE_MAX_INPUT_BYTES: DEFAULT_MAX_INPUT_BYTES,
  HARD_SUBTITLE_SOURCE_MAX_INPUT_BYTES: HARD_MAX_INPUT_BYTES,
  normalizeSubtitleSourceCapability: normalizeCapability,
  SubtitleSource,
  SubtitleSourceError,
};
