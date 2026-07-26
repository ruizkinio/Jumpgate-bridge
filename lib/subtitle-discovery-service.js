"use strict";

const crypto = require("node:crypto");
const { normalizePrivateSubtitleCandidates } = require("./provider-gateway-service");
const { assertRepository } = require("./storage/contracts");
const { assertAbortSignal } = require("./storage/object-store");
const {
  assertBoundedString,
  assertPlainObject,
  assertPositiveInteger,
} = require("./storage/repository-utils");

const MAX_DISCOVERED_SUBTITLES = 128;
const PUBLIC_SCHEMA_VERSION = 1;
const RESOLVE_SCHEMA_VERSION = 2;
const EXPIRES_AT_UNIT = "unix_ms";
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;
const SELECTOR_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ROUTE_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;
const SAFE_EXTENSION_PATTERN = /^\.(?:srt|vtt|ass|ssa|smi|sub|txt|idx)$/;
const TEXT_CONTENT_TYPES = new Map([
  [".srt", "application/x-subrip"],
  [".vtt", "text/vtt"],
  [".ass", "text/x-ssa"],
  [".ssa", "text/x-ssa"],
  [".smi", "application/x-sami"],
  [".sub", "text/x-microdvd"],
  [".txt", "text/plain"],
]);
const BINDING_FIELDS = Object.freeze([
  "profileId",
  "deviceId",
  "sessionId",
  "generation",
  "contextId",
  "contextRevision",
  "providerRevision",
]);

function exactObject(value, allowed, name) {
  const input = assertPlainObject(value, name);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(name + " contains unsupported fields");
    }
  }
  return input;
}

function routeIdentifier(value, name) {
  const result = assertBoundedString(value, name, 256);
  if (!ROUTE_ID_PATTERN.test(result)) throw new TypeError(name + " is invalid");
  return result;
}

function deviceBinding(value) {
  const input = exactObject(
    value,
    new Set([
      "profileId",
      "deviceId",
      "profileRevision",
      "deviceGeneration",
      "historyGeneration",
      "playbackGeneration",
    ]),
    "device binding"
  );
  const result = {
    profileId: routeIdentifier(input.profileId, "profile id"),
    deviceId: routeIdentifier(input.deviceId, "device id"),
  };
  const hasProfileRevision = input.profileRevision !== undefined;
  const hasDeviceGeneration = input.deviceGeneration !== undefined;
  if (hasProfileRevision !== hasDeviceGeneration) {
    throw new TypeError("device lifecycle binding is incomplete");
  }
  if (hasProfileRevision) {
    result.profileRevision = assertPositiveInteger(
      input.profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    );
    result.deviceGeneration = assertPositiveInteger(
      input.deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
  }
  return Object.freeze(result);
}

function deliveryBinding(value) {
  const input = assertPlainObject(value, "active subtitle delivery binding");
  const result = {};
  for (const field of BINDING_FIELDS) {
    result[field] = assertBoundedString(input[field], "subtitle delivery " + field, 256);
  }
  return Object.freeze(result);
}

function sameBinding(left, right) {
  return BINDING_FIELDS.every((field) => left[field] === right[field]);
}

function authorityRace(error) {
  return Boolean(error && [
    "authority_conflict",
    "authority_stale",
    "subtitle_authorization_changed",
    "subtitle_delivery_changed",
  ].includes(error.code));
}

function gatewayRequest(active) {
  const context = assertPlainObject(active.context, "active playback context");
  const request = assertPlainObject(context.request, "active playback request");
  if (request.resource !== "stream") throw new TypeError("active playback request is invalid");
  const type = assertBoundedString(request.type, "active playback type", 256);
  const id = assertBoundedString(
    request.videoId || request.metaId,
    "active playback video id",
    4096
  );
  const extra = [];
  if (request.videoHash !== undefined) {
    extra.push({
      name: "videoHash",
      value: assertBoundedString(request.videoHash, "active playback video hash", 256),
    });
  }
  if (request.videoSize !== undefined) {
    if (!Number.isSafeInteger(request.videoSize) || request.videoSize < 1) {
      throw new TypeError("active playback video size is invalid");
    }
    extra.push({ name: "videoSize", value: String(request.videoSize) });
  }
  if (request.filename !== undefined) {
    extra.push({
      name: "filename",
      value: assertBoundedString(request.filename, "active playback filename", 2048),
    });
  }
  return { resource: "subtitles", type, id, extra };
}

function canonicalCandidateIdentity(binding, candidate) {
  return JSON.stringify([
    1,
    binding.profileId,
    binding.sessionId,
    binding.generation,
    binding.contextId,
    binding.contextRevision,
    binding.providerRevision,
    candidate.providerId,
    candidate.sourceCapability.url,
    candidate.sourceCapability.headers,
  ]);
}

function publicDisplay(display, rank) {
  const value = assertPlainObject(display, "private subtitle display");
  const language = assertBoundedString(value.language, "private subtitle language", 35);
  const format = assertBoundedString(value.format, "private subtitle format", 16);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$|^und$/.test(language)) {
    throw new TypeError("private subtitle language is invalid");
  }
  if (!/^[a-z0-9]{1,16}$/.test(format)) {
    throw new TypeError("private subtitle format is invalid");
  }
  return Object.freeze({
    language,
    format,
    label: assertBoundedString(language + " - " + format.toUpperCase(), "subtitle label", 64),
    rank: assertPositiveInteger(rank, "subtitle rank", MAX_DISCOVERED_SUBTITLES),
  });
}

function safeExtension(value) {
  const extension = assertBoundedString(value, "subtitle extension", 16);
  if (!SAFE_EXTENSION_PATTERN.test(extension)) {
    throw new TypeError("subtitle extension is invalid");
  }
  return extension;
}

function deriveSubtitleFileName(tokenService, artifactId, extension) {
  const id = routeIdentifier(artifactId, "subtitle artifact id");
  const suffix = safeExtension(extension);
  return tokenService.hashOpaque("subtitle-file-name", id, 256) + suffix;
}

function timingSafeSelectorEqual(left, right) {
  if (!SELECTOR_PATTERN.test(left) || !SELECTOR_PATTERN.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function resolveSchemaVersion(value) {
  if (value === undefined) return PUBLIC_SCHEMA_VERSION;
  if (!Number.isSafeInteger(value) || value !== RESOLVE_SCHEMA_VERSION) {
    throw new TypeError("subtitle response schema version is invalid");
  }
  return value;
}

class SubtitleDiscoveryService {
  constructor(options = {}) {
    const supplied = assertPlainObject(options, "subtitle discovery service options");
    this._contexts = assertRepository("playbackContexts", supplied.playbackContexts);
    this._repository = assertRepository("subtitleDeliveries", supplied.subtitleDeliveries);
    if (!supplied.gateway || typeof supplied.gateway.discoverSubtitles !== "function") {
      throw new TypeError("provider gateway must provide discoverSubtitles()");
    }
    if (!supplied.delivery || typeof supplied.delivery.resolve !== "function" ||
        typeof supplied.delivery.read !== "function") {
      throw new TypeError("subtitle delivery service is invalid");
    }
    if (!supplied.tokenService || typeof supplied.tokenService.hashOpaque !== "function") {
      throw new TypeError("tokenService is required");
    }
    this._gateway = supplied.gateway;
    this._delivery = supplied.delivery;
    this._tokens = supplied.tokenService;
  }

  async discover(rawDeviceBinding, request = {}) {
    const scoped = deviceBinding(rawDeviceBinding);
    const input = exactObject(request, new Set(["sessionId", "signal"]), "subtitle discovery request");
    const sessionId = routeIdentifier(input.sessionId, "subtitle session id");
    const signal = assertAbortSignal(input.signal);
    const collected = await this._collect(scoped, sessionId, signal);
    if (!collected) return null;
    return Object.freeze({
      schemaVersion: PUBLIC_SCHEMA_VERSION,
      subtitles: Object.freeze(collected.candidates.map((candidate) => candidate.public)),
    });
  }

  async resolve(rawDeviceBinding, request = {}) {
    const scoped = deviceBinding(rawDeviceBinding);
    const input = exactObject(
      request,
      new Set(["sessionId", "selector", "responseSchemaVersion", "signal"]),
      "subtitle resolution request"
    );
    const sessionId = routeIdentifier(input.sessionId, "subtitle session id");
    if (typeof input.selector !== "string" || !SELECTOR_PATTERN.test(input.selector)) return null;
    const responseSchemaVersion = resolveSchemaVersion(input.responseSchemaVersion);
    const signal = assertAbortSignal(input.signal);
    const collected = await this._collect(scoped, sessionId, signal);
    if (!collected) return null;
    const selected = collected.candidates.find((candidate) =>
      timingSafeSelectorEqual(candidate.selector, input.selector)
    );
    if (!selected) return null;
    let ready;
    try {
      ready = await this._delivery.resolve(collected.binding, {
        discoveryKey: selected.discoveryKey,
        sourceCapability: selected.sourceCapability,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (authorityRace(error)) return null;
      throw error;
    }
    if (!ready) return null;
    return this._projectReady(sessionId, ready, responseSchemaVersion);
  }

  async read(rawDeviceBinding, request = {}) {
    const scoped = deviceBinding(rawDeviceBinding);
    const input = exactObject(
      request,
      new Set(["sessionId", "artifactId", "partNumber", "fileName", "method", "signal"]),
      "subtitle read request"
    );
    const sessionId = routeIdentifier(input.sessionId, "subtitle session id");
    const artifactId = routeIdentifier(input.artifactId, "subtitle artifact id");
    const partNumber = assertPositiveInteger(input.partNumber, "subtitle part number", 2);
    const fileName = assertBoundedString(input.fileName, "subtitle file name", 128);
    const method = String(input.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new TypeError("subtitle read method is invalid");
    const signal = assertAbortSignal(input.signal);
    const active = await this._reconcileActive(scoped, sessionId);
    if (!active) return null;
    let result;
    try {
      result = await this._delivery.read(active.binding, artifactId, partNumber, {
        method,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (authorityRace(error) || (error && error.code === "object_store_not_found")) return null;
      throw error;
    }
    if (!result) return null;
    const expected = deriveSubtitleFileName(this._tokens, artifactId, result.extension);
    if (fileName !== expected) {
      if (Buffer.isBuffer(result.body)) result.body.fill(0);
      return null;
    }
    return result;
  }

  async _collect(scoped, sessionId, signal) {
    const active = await this._reconcileActive(scoped, sessionId);
    if (!active) return null;
    const response = await this._gateway.discoverSubtitles(
      scoped.profileId,
      gatewayRequest(active.claim),
      signal ? { signal } : {}
    );
    if (!response || !response.snapshot || !response.response ||
        !Array.isArray(response.response.candidates) ||
        response.snapshot.providerRevision !== active.binding.providerRevision ||
        response.snapshot.generation !== active.binding.generation) {
      return null;
    }
    const current = await this._contexts.getActiveClaim(scoped.profileId, scoped.deviceId, sessionId);
    if (!current || !current.deliveryBinding ||
        !sameBinding(active.binding, deliveryBinding(current.deliveryBinding))) {
      return null;
    }

    const internal = [];
    const inline = Array.isArray(current.context.inlineSubtitles)
      ? current.context.inlineSubtitles
      : [];
    for (const candidate of normalizePrivateSubtitleCandidates("inline-source", inline)) {
      internal.push(candidate);
      if (internal.length >= MAX_DISCOVERED_SUBTITLES) break;
    }
    for (const candidate of response.response.candidates) {
      if (internal.length >= MAX_DISCOVERED_SUBTITLES) break;
      if (candidate && candidate.providerId && candidate.sourceCapability && candidate.display) {
        internal.push(candidate);
      }
    }

    const candidates = [];
    const selectors = new Set();
    for (const candidate of internal) {
      let display;
      try {
        display = publicDisplay(candidate.display, candidates.length + 1);
      } catch (_error) {
        continue;
      }
      const identity = canonicalCandidateIdentity(active.binding, candidate);
      const discoveryKey = this._tokens.hashOpaque("subtitle-discovery", identity, 512 * 1024);
      const selector = this._tokens.hashOpaque(
        "subtitle-selector",
        JSON.stringify([active.binding.sessionId, discoveryKey]),
        1024
      );
      if (selectors.has(selector)) continue;
      selectors.add(selector);
      candidates.push(Object.freeze({
        selector,
        discoveryKey,
        sourceCapability: candidate.sourceCapability,
        public: Object.freeze({
          selector,
          ...display,
        }),
      }));
    }
    return Object.freeze({
      binding: Object.freeze({
        ...active.binding,
        ...(scoped.profileRevision === undefined
          ? {}
          : {
              profileRevision: scoped.profileRevision,
              deviceGeneration: scoped.deviceGeneration,
            }),
      }),
      candidates: Object.freeze(candidates),
    });
  }

  async _reconcileActive(scoped, sessionId) {
    const claim = await this._contexts.getActiveClaim(scoped.profileId, scoped.deviceId, sessionId);
    if (!claim || claim.status !== "claimed" || !claim.deliveryBinding) return null;
    const binding = deliveryBinding(claim.deliveryBinding);
    try {
      await this._repository.reconcileAuthority({
        profileId: binding.profileId,
        providerRevision: binding.providerRevision,
        generation: binding.generation,
      });
    } catch (error) {
      if (authorityRace(error)) return null;
      throw error;
    }
    const current = await this._contexts.getActiveClaim(scoped.profileId, scoped.deviceId, sessionId);
    if (!current || !current.deliveryBinding) return null;
    const currentBinding = deliveryBinding(current.deliveryBinding);
    if (!sameBinding(binding, currentBinding)) return null;
    return Object.freeze({ claim: current, binding: currentBinding });
  }

  _projectReady(sessionId, ready, responseSchemaVersion) {
    if (!ready || ready.status !== "ready") {
      throw new TypeError("subtitle delivery status is invalid");
    }
    const artifactId = routeIdentifier(ready.artifactId, "subtitle artifact id");
    const expiresAt = assertPositiveInteger(ready.expiresAt, "subtitle expiry", MAX_DATE_MS);
    if (!Array.isArray(ready.parts) || ready.parts.length < 1 || ready.parts.length > 2) {
      throw new TypeError("subtitle delivery parts are invalid");
    }
    let aggregateBytes = 0;
    const parts = ready.parts.map((part, index) => {
      const input = assertPlainObject(part, "subtitle delivery part");
      const partNumber = assertPositiveInteger(input.partNumber, "subtitle part number", 2);
      if (partNumber !== index + 1) throw new TypeError("subtitle part ordering is invalid");
      const extension = safeExtension(input.extension);
      const fileName = deriveSubtitleFileName(this._tokens, artifactId, extension);
      const contentLength = assertPositiveInteger(
        input.sizeBytes,
        "subtitle content length",
        MAX_PART_BYTES
      );
      aggregateBytes += contentLength;
      if (aggregateBytes > MAX_ARTIFACT_BYTES) {
        throw new TypeError("subtitle aggregate content length is invalid");
      }
      const projected = {
        partNumber,
        role: assertBoundedString(input.role, "subtitle role", 16),
        contentLength,
        contentType: assertBoundedString(input.mediaType, "subtitle content type", 128),
        fileName,
        path: "/v1/subtitles/" + encodeURIComponent(sessionId) + "/" +
          encodeURIComponent(artifactId) + "/" + partNumber + "/" + encodeURIComponent(fileName),
      };
      if (responseSchemaVersion === RESOLVE_SCHEMA_VERSION) {
        projected.sha256 = assertBoundedString(input.checksum, "subtitle sha256", 64);
        if (!SHA256_PATTERN.test(projected.sha256)) {
          throw new TypeError("subtitle sha256 is invalid");
        }
      }
      return Object.freeze(projected);
    });
    if (parts.length === 1) {
      if (parts[0].role !== "subtitle" || TEXT_CONTENT_TYPES.get(safeExtension(ready.parts[0].extension)) !== parts[0].contentType) {
        throw new TypeError("text subtitle delivery metadata is invalid");
      }
    } else {
      if (
        parts[0].role !== "index" || parts[0].contentType !== "application/x-vobsub" ||
        safeExtension(ready.parts[0].extension) !== ".idx" ||
        parts[1].role !== "sub" || parts[1].contentType !== "application/octet-stream" ||
        safeExtension(ready.parts[1].extension) !== ".sub" ||
        parts[0].fileName.slice(0, -4) !== parts[1].fileName.slice(0, -4)
      ) {
        throw new TypeError("VobSub delivery metadata is invalid");
      }
    }
    return Object.freeze({
      schemaVersion: responseSchemaVersion,
      status: "ready",
      artifactId,
      expiresAt,
      expiresAtUnit: EXPIRES_AT_UNIT,
      parts: Object.freeze(parts),
    });
  }
}

module.exports = {
  deriveSubtitleFileName,
  EXPIRES_AT_UNIT,
  MAX_DISCOVERED_SUBTITLES,
  PUBLIC_SCHEMA_VERSION,
  RESOLVE_SCHEMA_VERSION,
  SubtitleDiscoveryService,
};
