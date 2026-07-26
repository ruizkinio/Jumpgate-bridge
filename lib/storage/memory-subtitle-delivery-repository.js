"use strict";

const crypto = require("node:crypto");
const {
  assertBoundedString,
  assertPlainObject,
  assertPositiveInteger,
  codedError,
} = require("./repository-utils");
const { OpaqueObjectKeyFactory } = require("./object-store");

const DEFAULT_LIMITS = Object.freeze({
  profileArtifacts: 64,
  profileObjects: 128,
  profileBytes: 128 * 1024 * 1024,
  profileLeases: 4,
  globalArtifacts: 4096,
  globalObjects: 8192,
  globalBytes: 8 * 1024 * 1024 * 1024,
  globalLeases: 32,
  globalAuthorities: 4096,
  artifactBytes: 12 * 1024 * 1024,
  artifactParts: 2,
  logicalTtlMs: 120 * 1000,
  absoluteTtlMs: 10 * 60 * 1000,
  fetchLeaseTtlMs: 30 * 1000,
  uploadLeaseTtlMs: 120 * 1000,
  maxPutLifetimeMs: 120 * 1000,
  uploadSettlementGraceMs: 30 * 1000,
  ioLeaseTtlMs: 30 * 1000,
  deletionLeaseTtlMs: 60 * 1000,
  maxDeletionRetryMs: 5 * 60 * 1000,
  sourceCapabilityBytes: 64 * 1024,
});

const MAX_DATE_MS = 8640000000000000;
const MAX_ID_ATTEMPTS = 8;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,127})$/;
const GENERATION_PATTERN = /^g1:[A-Za-z0-9_-]{1,128}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const STAGE_PART_FIELDS = new Set([
  "partNumber",
  "sizeBytes",
  "checksum",
  "role",
  "extension",
  "mediaType",
]);
const RECEIPT_FIELDS = new Set([
  "partNumber",
  "objectKey",
  "sizeBytes",
  "checksum",
  "mediaType",
  "key",
  "contentLength",
  "checksumSha256",
  "contentType",
]);
const TEXT_MEDIA = new Map([
  [".srt", "application/x-subrip"],
  [".vtt", "text/vtt"],
  [".ass", "text/x-ssa"],
  [".ssa", "text/x-ssa"],
  [".smi", "application/x-sami"],
  [".sub", "text/x-microdvd"],
  [".txt", "text/plain"],
]);

function optionalLimit(options, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  return assertPositiveInteger(options[name] ?? fallback, name, maximum);
}

function assertIdentifier(value, name) {
  return assertBoundedString(value, name, 256, { minimumLength: 1 });
}

function decimalString(value, name) {
  let normalized = value;
  if (typeof value === "bigint") normalized = value.toString();
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + " is invalid");
    normalized = String(value);
  }
  if (typeof normalized !== "string" || !DECIMAL_PATTERN.test(normalized)) {
    throw new TypeError(name + " is invalid");
  }
  return normalized;
}

function assertGeneration(value) {
  if (typeof value !== "string" || !GENERATION_PATTERN.test(value)) {
    throw new TypeError("profile generation is invalid");
  }
  return value;
}

function addTime(now, duration, name) {
  if (!Number.isSafeInteger(duration) || duration < 1 || now > MAX_DATE_MS - duration) {
    throw new TypeError(name + " is invalid");
  }
  return now + duration;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function frozen(value) {
  return Object.freeze(clone(value));
}

function stateError(status) {
  const errors = {
    authority_conflict: ["subtitle_authority_conflict", "subtitle provider authority changed"],
    authority_stale: ["subtitle_authority_stale", "subtitle provider authority snapshot is stale"],
    fetch_busy: ["subtitle_fetch_busy", "subtitle fetch is owned by another attempt"],
    fetch_conflict: ["subtitle_fetch_conflict", "subtitle fetch state conflicts with this request"],
    stage_conflict: ["subtitle_stage_conflict", "subtitle staged upload conflicts with this request"],
    upload_conflict: ["subtitle_upload_conflict", "subtitle upload state conflicts with this request"],
    commit_conflict: ["subtitle_commit_conflict", "subtitle commit state conflicts with this request"],
    invalid_parts: ["subtitle_invalid_parts", "subtitle part metadata is invalid"],
    artifact_too_large: ["subtitle_artifact_too_large", "subtitle artifact exceeds its byte limit"],
    upload_barrier: ["subtitle_upload_barrier", "subtitle upload has not reached a terminal state"],
    deletion_barrier: ["subtitle_deletion_barrier", "subtitle deletion verification is incomplete"],
    lease_busy: ["subtitle_lease_busy", "subtitle artifact still has an active I/O lease"],
    legacy_only: ["subtitle_legacy_upload_only", "beginUpload is reserved for legacy artifacts"],
  };
  const mapped = errors[status] || ["subtitle_state_error", "unexpected subtitle delivery state"];
  return codedError(mapped[0], mapped[1]);
}

function capacityError(scope, resource = "capacity") {
  const profile = scope === "profile";
  const error = codedError(
    profile ? "subtitle_profile_capacity" : "subtitle_global_capacity",
    profile ? "subtitle profile " + resource + " reached" : "subtitle global " + resource + " reached"
  );
  error.status = profile ? 429 : 503;
  error.statusCode = error.status;
  return error;
}

function normalizeSourceCapability(value, maximumBytes) {
  const input = assertPlainObject(value, "subtitle source capability");
  const allowed = new Set(["url", "headers"]);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError("subtitle source capability contains unsupported fields");
    }
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
  const result = {
    v: 1,
    url: parsed.toString(),
    headers: Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))),
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximumBytes) {
    throw new RangeError("subtitle source capability exceeds its maximum length");
  }
  return result;
}

function normalizePart(part, index, count, maximumBytes) {
  const input = assertPlainObject(part, "subtitle part");
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !STAGE_PART_FIELDS.has(key)) {
      throw new TypeError("subtitle part contains unsupported fields");
    }
  }
  if (Reflect.ownKeys(input).length !== STAGE_PART_FIELDS.size) {
    throw new TypeError("subtitle part fields are incomplete");
  }
  const size = assertPositiveInteger(input.sizeBytes, "subtitle part size", maximumBytes);
  const checksum = input.checksum;
  if (typeof checksum !== "string" || !CHECKSUM_PATTERN.test(checksum)) {
    throw new TypeError("subtitle part checksum is invalid");
  }
  if (input.partNumber !== index + 1) {
    throw new TypeError("subtitle part number is invalid");
  }
  const role = assertBoundedString(input.role, "subtitle part role", 16);
  const extension = assertBoundedString(input.extension, "subtitle part extension", 16);
  const mediaType = assertBoundedString(input.mediaType, "subtitle part media type", 128);
  if (count === 1) {
    if (role !== "subtitle" || TEXT_MEDIA.get(extension) !== mediaType) {
      throw stateError("invalid_parts");
    }
  } else {
    const expected = index === 0
      ? { role: "index", extension: ".idx", mediaType: "application/x-vobsub" }
      : { role: "sub", extension: ".sub", mediaType: "application/octet-stream" };
    if (role !== expected.role || extension !== expected.extension || mediaType !== expected.mediaType) {
      throw stateError("invalid_parts");
    }
  }
  return { partNumber: index + 1, sizeBytes: size, checksum, role, extension, mediaType };
}

function normalizeReceipt(value, index, maximumBytes, objectKeys, expected) {
  const input = assertPlainObject(value, "subtitle upload receipt");
  for (const field of Reflect.ownKeys(input)) {
    if (typeof field !== "string" || !RECEIPT_FIELDS.has(field)) {
      throw new TypeError("subtitle upload receipt contains an unsupported field");
    }
  }
  for (const [primary, alias] of [
    ["objectKey", "key"],
    ["sizeBytes", "contentLength"],
    ["checksum", "checksumSha256"],
    ["mediaType", "contentType"],
  ]) {
    if (input[primary] !== undefined && input[alias] !== undefined) {
      throw new TypeError("subtitle upload receipt contains duplicate fields");
    }
  }
  if (input.partNumber !== undefined && input.partNumber !== index + 1) {
    throw new TypeError("subtitle upload receipt part number is invalid");
  }
  const objectKey = objectKeys.assert(input.objectKey ?? input.key);
  const sizeBytes = assertPositiveInteger(
    input.sizeBytes ?? input.contentLength,
    "subtitle upload receipt size",
    maximumBytes
  );
  const checksum = input.checksum ?? input.checksumSha256;
  if (typeof checksum !== "string" || !CHECKSUM_PATTERN.test(checksum)) {
    throw new TypeError("subtitle upload receipt checksum is invalid");
  }
  const mediaType = assertBoundedString(
    input.mediaType ?? input.contentType,
    "subtitle upload receipt media type",
    128
  );
  return {
    partNumber: index + 1,
    objectKey,
    sizeBytes,
    checksum,
    role: expected.role,
    extension: expected.extension,
    mediaType,
  };
}

function normalizeParts(value, limits) {
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.artifactParts) {
    throw new TypeError("subtitle parts are invalid");
  }
  if (value.length !== 1 && value.length !== 2) throw stateError("invalid_parts");
  const parts = value.map((part, index) => normalizePart(part, index, value.length, limits.artifactBytes));
  const total = parts.reduce((sum, part) => sum + part.sizeBytes, 0);
  if (!Number.isSafeInteger(total) || total > limits.artifactBytes) {
    throw stateError("artifact_too_large");
  }
  return { parts, total };
}

function partPublic(part) {
  return {
    partNumber: part.partNumber,
    objectKey: part.objectKey,
    sizeBytes: part.sizeBytes,
    checksum: part.checksum,
    role: part.role,
    extension: part.extension,
    mediaType: part.mediaType,
  };
}

function partsEqual(left, right, includeObjectKey = false) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((part, index) => {
    const candidate = right[index];
    return candidate &&
      part.partNumber === candidate.partNumber &&
      part.sizeBytes === candidate.sizeBytes &&
      part.checksum === candidate.checksum &&
      part.role === candidate.role &&
      part.extension === candidate.extension &&
      part.mediaType === candidate.mediaType &&
      (!includeObjectKey || part.objectKey === candidate.objectKey);
  });
}

function parseBinding(input) {
  const request = assertPlainObject(input, "subtitle delivery binding");
  return {
    profileId: assertIdentifier(request.profileId, "profile id"),
    deviceId: assertIdentifier(request.deviceId, "device id"),
    sessionId: assertIdentifier(request.sessionId, "session id"),
    generation: assertGeneration(request.generation),
    contextId: assertIdentifier(request.contextId, "context id"),
    contextRevision: decimalString(request.contextRevision, "context revision"),
    providerRevision: decimalString(request.providerRevision, "provider revision"),
  };
}

function bindingEqual(left, right) {
  return left.profileId === right.profileId &&
    left.deviceId === right.deviceId &&
    left.sessionId === right.sessionId &&
    left.generation === right.generation &&
    left.contextId === right.contextId &&
    left.contextRevision === right.contextRevision &&
    left.providerRevision === right.providerRevision;
}

function callObject(first, second, additions = {}) {
  if (first && typeof first === "object" && !Array.isArray(first)) {
    return { ...assertPlainObject(first, "subtitle delivery request"), ...additions };
  }
  return { ...assertPlainObject(second, "subtitle delivery binding"), artifactId: first, ...additions };
}

function zeroUsage() {
  return { artifacts: 0, objects: 0, bytes: 0, leases: 0 };
}

class MemorySubtitleDeliveryRepository {
  constructor(options = {}) {
    const supplied = assertPlainObject(options, "memory subtitle delivery options");
    if (!supplied.tokenService || typeof supplied.tokenService.issue !== "function" ||
        typeof supplied.tokenService.hashToken !== "function" ||
        typeof supplied.tokenService.hashOpaque !== "function") {
      throw new TypeError("tokenService is required");
    }
    if (!(supplied.objectKeyFactory instanceof OpaqueObjectKeyFactory)) {
      throw new TypeError("objectKeyFactory must be an OpaqueObjectKeyFactory");
    }
    if (!supplied.sourceContextStore ||
        typeof supplied.sourceContextStore.getProfileGeneration !== "function" ||
        typeof supplied.sourceContextStore.getActiveClaim !== "function") {
      throw new TypeError("sourceContextStore is required");
    }
    this._tokens = supplied.tokenService;
    this._objectKeys = supplied.objectKeyFactory;
    this._contexts = supplied.sourceContextStore;
    const clock = supplied.clock || Date.now;
    if (typeof clock === "function") this._clock = clock;
    else if (clock && typeof clock.now === "function") this._clock = () => clock.now();
    else throw new TypeError("clock must be a function or expose now()");
    this._idFactory = supplied.idFactory || null;
    if (this._idFactory !== null && typeof this._idFactory !== "function") {
      throw new TypeError("idFactory must be a function");
    }
    this._limits = Object.freeze({
      profileArtifacts: optionalLimit(supplied, "maxProfileArtifacts", DEFAULT_LIMITS.profileArtifacts, 64),
      profileObjects: optionalLimit(supplied, "maxProfileObjects", DEFAULT_LIMITS.profileObjects, 128),
      profileBytes: optionalLimit(supplied, "maxProfileBytes", DEFAULT_LIMITS.profileBytes, 128 * 1024 * 1024),
      profileLeases: optionalLimit(supplied, "maxProfileLeases", DEFAULT_LIMITS.profileLeases, 4),
      globalArtifacts: optionalLimit(supplied, "maxGlobalArtifacts", DEFAULT_LIMITS.globalArtifacts, 4096),
      globalObjects: optionalLimit(supplied, "maxGlobalObjects", DEFAULT_LIMITS.globalObjects, 8192),
      globalBytes: optionalLimit(supplied, "maxGlobalBytes", DEFAULT_LIMITS.globalBytes, 8 * 1024 * 1024 * 1024),
      globalLeases: optionalLimit(supplied, "maxGlobalLeases", DEFAULT_LIMITS.globalLeases, 32),
      globalAuthorities: optionalLimit(supplied, "maxGlobalAuthorities", DEFAULT_LIMITS.globalAuthorities, 4096),
      artifactBytes: optionalLimit(supplied, "maxArtifactBytes", DEFAULT_LIMITS.artifactBytes, 12 * 1024 * 1024),
      artifactParts: optionalLimit(supplied, "maxArtifactParts", DEFAULT_LIMITS.artifactParts, 2),
      logicalTtlMs: optionalLimit(supplied, "logicalTtlMs", DEFAULT_LIMITS.logicalTtlMs, 7 * 24 * 60 * 60 * 1000),
      absoluteTtlMs: optionalLimit(supplied, "absoluteTtlMs", DEFAULT_LIMITS.absoluteTtlMs, 7 * 24 * 60 * 60 * 1000),
      fetchLeaseTtlMs: optionalLimit(supplied, "fetchLeaseTtlMs", DEFAULT_LIMITS.fetchLeaseTtlMs, 7 * 24 * 60 * 60 * 1000),
      uploadLeaseTtlMs: optionalLimit(supplied, "uploadLeaseTtlMs", DEFAULT_LIMITS.uploadLeaseTtlMs, 7 * 24 * 60 * 60 * 1000),
      maxPutLifetimeMs: optionalLimit(supplied, "maxPutLifetimeMs", DEFAULT_LIMITS.maxPutLifetimeMs, 7 * 24 * 60 * 60 * 1000),
      uploadSettlementGraceMs: optionalLimit(supplied, "uploadSettlementGraceMs", DEFAULT_LIMITS.uploadSettlementGraceMs, 7 * 24 * 60 * 60 * 1000),
      ioLeaseTtlMs: optionalLimit(supplied, "ioLeaseTtlMs", DEFAULT_LIMITS.ioLeaseTtlMs, 7 * 24 * 60 * 60 * 1000),
      deletionLeaseTtlMs: optionalLimit(supplied, "deletionLeaseTtlMs", DEFAULT_LIMITS.deletionLeaseTtlMs, 7 * 24 * 60 * 60 * 1000),
      maxDeletionRetryMs: optionalLimit(supplied, "maxDeletionRetryMs", DEFAULT_LIMITS.maxDeletionRetryMs, 7 * 24 * 60 * 60 * 1000),
      sourceCapabilityBytes: optionalLimit(supplied, "maxSourceCapabilityBytes", DEFAULT_LIMITS.sourceCapabilityBytes, 1024 * 1024),
    });
    if (this._limits.logicalTtlMs > this._limits.absoluteTtlMs) {
      throw new TypeError("logicalTtlMs cannot exceed absoluteTtlMs");
    }
    this._authorities = new Map();
    this._artifacts = new Map();
    this._discoveries = new Map();
    this._profiles = new Map();
    this._global = zeroUsage();
    this._lastNow = 0;
  }

  async getAuthority(profileId) {
    const id = assertIdentifier(
      profileId && typeof profileId === "object" ? profileId.profileId : profileId,
      "profile id"
    );
    this._prune(this._now());
    const value = this._authorities.get(id);
    return value ? frozen({ profileId: id, ...value }) : null;
  }

  async transitionAuthority(profileId, request) {
    const input = profileId && typeof profileId === "object"
      ? assertPlainObject(profileId, "subtitle authority update")
      : { ...assertPlainObject(request, "subtitle authority update"), profileId };
    const id = assertIdentifier(input.profileId, "profile id");
    const expectedProvider = input.expectedProviderRevision;
    const expectedGeneration = input.expectedGeneration;
    if ((expectedProvider === null) !== (expectedGeneration === null) ||
        expectedProvider === undefined || expectedGeneration === undefined) {
      throw new TypeError("subtitle authority expected revision and generation must both be null or present");
    }
    return this._setAuthority(id, {
      expectedProviderRevision: expectedProvider === null ? null : decimalString(expectedProvider, "expected provider revision"),
      expectedGeneration: expectedGeneration === null ? null : assertGeneration(expectedGeneration),
      providerRevision: decimalString(input.providerRevision ?? input.nextProviderRevision, "provider revision"),
      generation: assertGeneration(input.generation ?? input.nextGeneration),
      compareAndSet: true,
    });
  }

  updateAuthority(...args) {
    return this.transitionAuthority(...args);
  }

  compareAndSetAuthority(...args) {
    return this.transitionAuthority(...args);
  }

  async reconcileAuthority(profileId, snapshot) {
    const input = profileId && typeof profileId === "object"
      ? assertPlainObject(profileId, "subtitle authority reconciliation")
      : { ...assertPlainObject(snapshot, "subtitle authority reconciliation"), profileId };
    return this._setAuthority(assertIdentifier(input.profileId, "profile id"), {
      providerRevision: decimalString(input.providerRevision, "provider revision"),
      generation: assertGeneration(input.generation),
      compareAndSet: false,
    });
  }

  async reserve(profileId, deviceId, sessionId, request) {
    const input = profileId && typeof profileId === "object"
      ? assertPlainObject(profileId, "subtitle reservation")
      : { ...assertPlainObject(request, "subtitle reservation"), profileId, deviceId, sessionId };
    if (input.sourceEnvelope !== undefined) {
      throw new TypeError("sourceEnvelope is not accepted; provide a structured sourceCapability");
    }
    const binding = parseBinding(input);
    const discoveryKey = assertBoundedString(
      input.discoveryKey ?? input.discoveryId ?? input.sourceHash,
      "subtitle discovery key",
      1024
    );
    const sourceCapability = normalizeSourceCapability(
      input.sourceCapability,
      this._limits.sourceCapabilityBytes
    );
    const now = this._now();
    this._prune(now);
    if (!this._bindingIsCurrent(binding)) return null;
    const discoveryRef = this._discoveryRef(binding, discoveryKey);
    const sourceDigest = this._tokens.hashOpaque(
      "subtitle-source-capability",
      JSON.stringify(sourceCapability),
      this._limits.sourceCapabilityBytes + 1024
    );
    const existingId = this._discoveries.get(discoveryRef);
    if (existingId) {
      const existing = this._artifacts.get(existingId);
      if (existing && !existing.deletionRequested && bindingEqual(existing.binding, binding)) {
        if (existing.sourceDigest !== sourceDigest) return null;
        this._touch(existing, now);
        let reservationToken = null;
        if (existing.state === "reserved") {
          const replacement = this._tokens.issue("subtitle-reservation", 32);
          existing.reservationTokenHash = replacement.tokenHash;
          reservationToken = replacement.token;
        }
        return frozen({
          status: "duplicate",
          duplicate: true,
          artifactId: existing.artifactId,
          state: existing.state,
          expiresAt: existing.expiresAt,
          reservationToken,
          parts: existing.parts.map(partPublic),
        });
      }
      this._discoveries.delete(discoveryRef);
    }
    this._assertCapacity(binding.profileId, {
      artifacts: 1,
      objects: this._limits.artifactParts,
      bytes: this._limits.artifactBytes,
    });
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const artifactId = this._nextArtifactId();
      if (this._artifacts.has(artifactId)) continue;
      const reservation = this._tokens.issue("subtitle-reservation", 32);
      const absoluteExpiresAt = addTime(now, this._limits.absoluteTtlMs, "absolute subtitle TTL");
      const record = {
        schemaVersion: 3,
        artifactId,
        binding,
        discoveryRef,
        discoveryKey,
        sourceCapability,
        sourceDigest,
        reservationTokenHash: reservation.tokenHash,
        state: "reserved",
        expiresAt: Math.min(addTime(now, this._limits.logicalTtlMs, "subtitle TTL"), absoluteExpiresAt),
        absoluteExpiresAt,
        quota: { artifacts: 1, objects: this._limits.artifactParts, bytes: this._limits.artifactBytes },
        parts: [],
        partMetadataVersion: null,
        stagedAtMs: null,
        stagedBytes: null,
        fetchFence: 0,
        fetchTokenHash: null,
        fetchFencedTokenHash: null,
        fetchExpiresAt: null,
        uploadTokenHash: null,
        uploadExpiresAt: null,
        uploadSettlesAt: null,
        deletionRequested: false,
        deletionPhase: null,
        deletionDueAt: null,
        deletionTokenHash: null,
        deletionLeaseExpiresAt: null,
        deletionAttempt: 0,
        leases: new Map(),
      };
      this._artifacts.set(artifactId, record);
      this._discoveries.set(discoveryRef, artifactId);
      this._adjustUsage(binding.profileId, record.quota);
      return frozen({
        status: "reserved",
        duplicate: false,
        artifactId,
        expiresAt: record.expiresAt,
        absoluteExpiresAt,
        reservationToken: reservation.token,
        state: "reserved",
        parts: [],
      });
    }
    throw codedError("subtitle_artifact_collision", "could not allocate a unique subtitle artifact identifier");
  }

  async cancelReservation(artifactId, binding, reservationToken) {
    const input = callObject(artifactId, binding, reservationToken === undefined ? {} : { reservationToken });
    const scopedBinding = parseBinding(input);
    this._prune(this._now());
    const record = this._record(input.artifactId);
    if (!record || !bindingEqual(record.binding, scopedBinding)) {
      return null;
    }
    const ownsReservation = record.state === "reserved" &&
      this._tokenMatches("subtitle-reservation", input.reservationToken, record.reservationTokenHash);
    const ownsFetch = record.state === "fetching" &&
      this._tokenMatches("subtitle-fetch", input.fetchToken, record.fetchTokenHash);
    const ownsFencedFetch = record.state === "reserved" &&
      this._tokenMatches("subtitle-fetch", input.fetchToken, record.fetchFencedTokenHash);
    if (!ownsReservation && !ownsFetch && !ownsFencedFetch) return null;
    const released = clone(record.quota);
    this._removeRecord(record);
    return frozen({ status: "canceled", artifactId: record.artifactId, released });
  }

  async beginFetch(artifactId, binding) {
    const input = callObject(artifactId, binding);
    const scopedBinding = parseBinding(input);
    const now = this._now();
    this._prune(now);
    const record = this._record(input.artifactId);
    if (!record || record.deletionRequested || !bindingEqual(record.binding, scopedBinding) ||
        !this._bindingIsCurrent(scopedBinding)) return null;
    if (record.state === "committed") {
      return frozen({
        status: "committed",
        artifactId: record.artifactId,
        expiresAt: record.expiresAt,
        fetchToken: null,
        sourceCapability: null,
        parts: record.parts.map(partPublic),
      });
    }
    let fetch;
    try {
      fetch = input.fetchToken === undefined
        ? this._tokens.issue("subtitle-fetch", 32)
        : { token: input.fetchToken, tokenHash: this._tokens.hashToken("subtitle-fetch", input.fetchToken) };
    } catch (_error) {
      throw stateError("fetch_conflict");
    }
    if (record.state === "fetching") {
      if (record.fetchTokenHash !== fetch.tokenHash) throw stateError("fetch_busy");
      return frozen(this._fetchResponse(record, fetch.token, true));
    }
    if (record.state === "uploading") {
      throw stateError("fetch_busy");
    }
    if (record.state !== "reserved") return null;
    if (record.fetchFencedTokenHash === fetch.tokenHash) throw stateError("fetch_conflict");
    record.state = "fetching";
    record.fetchTokenHash = fetch.tokenHash;
    record.fetchFence += 1;
    record.fetchExpiresAt = addTime(now, this._limits.fetchLeaseTtlMs, "subtitle fetch lease");
    this._touch(record, now);
    return frozen(this._fetchResponse(record, fetch.token, false));
  }

  async releaseFetch(artifactId, fetchToken) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle fetch release")
      : { artifactId, fetchToken };
    this._prune(this._now());
    const record = this._record(input.artifactId);
    if (!record || record.state !== "fetching" ||
        !this._tokenMatches("subtitle-fetch", input.fetchToken, record.fetchTokenHash)) return false;
    this._resetFetch(record);
    return true;
  }

  async stageUpload(artifactId, binding, parts) {
    const input = callObject(artifactId, binding, parts === undefined ? {} : { parts });
    const scopedBinding = parseBinding(input);
    const normalized = normalizeParts(input.parts, this._limits);
    const now = this._now();
    this._prune(now);
    const record = this._record(input.artifactId);
    if (!record || record.deletionRequested || !bindingEqual(record.binding, scopedBinding) ||
        !this._bindingIsCurrent(scopedBinding)) return null;
    let fetchHash;
    let upload;
    try {
      fetchHash = this._tokens.hashToken("subtitle-fetch", input.fetchToken);
      upload = input.uploadToken === undefined
        ? this._tokens.issue("subtitle-upload", 32)
        : { token: input.uploadToken, tokenHash: this._tokens.hashToken("subtitle-upload", input.uploadToken) };
    } catch (_error) {
      throw stateError("stage_conflict");
    }
    if (record.state === "uploading" || record.state === "committed") {
      if (record.fetchTokenHash !== fetchHash || record.uploadTokenHash !== upload.tokenHash ||
          !partsEqual(record.parts, normalized.parts)) throw stateError("stage_conflict");
      return frozen(this._stageResponse(record, upload.token, true));
    }
    if (record.state !== "fetching" || record.fetchTokenHash !== fetchHash) {
      throw stateError("stage_conflict");
    }
    if (normalized.parts.length > record.quota.objects || normalized.total > record.quota.bytes) {
      throw stateError(normalized.total > record.quota.bytes ? "artifact_too_large" : "invalid_parts");
    }
    const attempt = this._tokens.hashOpaque(
      "subtitle-upload-attempt",
      record.artifactId + ":" + upload.tokenHash,
      1024
    );
    const staged = normalized.parts.map((part) => ({
      ...part,
      objectKey: this._objectKeys.create([
        "subtitle-staging-v1",
        record.artifactId,
        attempt,
        String(part.partNumber),
      ]),
    }));
    this._adjustUsage(record.binding.profileId, {
      artifacts: 0,
      objects: staged.length - record.quota.objects,
      bytes: normalized.total - record.quota.bytes,
    });
    record.quota.objects = staged.length;
    record.quota.bytes = normalized.total;
    record.parts = staged;
    record.partMetadataVersion = 1;
    record.stagedAtMs = now;
    record.stagedBytes = normalized.total;
    record.state = "uploading";
    record.uploadTokenHash = upload.tokenHash;
    record.uploadExpiresAt = addTime(now, this._limits.uploadLeaseTtlMs, "subtitle upload lease");
    record.uploadSettlesAt = addTime(
      addTime(record.uploadExpiresAt, this._limits.maxPutLifetimeMs, "subtitle PUT lifetime"),
      this._limits.uploadSettlementGraceMs,
      "subtitle upload settlement grace"
    );
    record.sourceCapability = null;
    record.reservationTokenHash = null;
    this._touch(record, now);
    return frozen(this._stageResponse(record, upload.token, false));
  }

  async beginUpload() {
    throw stateError("legacy_only");
  }

  async abortUpload(artifactId, uploadToken) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle upload abort")
      : { artifactId, uploadToken };
    const now = this._now();
    this._prune(now);
    const record = this._record(input.artifactId);
    if (!record || record.state === "committed" ||
        !this._tokenMatches("subtitle-upload", input.uploadToken, record.uploadTokenHash)) return null;
    if (record.state !== "uploading") return null;
    this._markDeleting(record, now);
    return frozen({ status: "aborted", artifactId: record.artifactId, parts: record.parts.map(partPublic) });
  }

  async commit(artifactId, binding, parts) {
    const input = callObject(artifactId, binding, parts === undefined ? {} : { parts });
    if (input.receipts !== undefined && input.parts !== undefined) {
      throw new TypeError("subtitle commit accepts receipts or legacy parts, not both");
    }
    if (input.receipts === undefined) throw stateError("commit_conflict");
    const scopedBinding = parseBinding(input);
    const now = this._now();
    this._prune(now);
    const record = this._record(input.artifactId);
    if (!record || record.deletionRequested || !bindingEqual(record.binding, scopedBinding) ||
        !this._bindingIsCurrent(scopedBinding)) return null;
    let uploadHash;
    try {
      uploadHash = this._tokens.hashToken("subtitle-upload", input.uploadToken);
    } catch (_error) {
      return null;
    }
    const receipts = this._normalizeReceipts(input.receipts, record.parts);
    if (record.state === "committed") {
      if (record.uploadTokenHash !== uploadHash || !partsEqual(record.parts, receipts, true)) {
        throw stateError("commit_conflict");
      }
      return frozen(this._commitResponse(record, true));
    }
    if (record.state !== "uploading") return null;
    if (record.uploadTokenHash !== uploadHash || !partsEqual(record.parts, receipts, true)) {
      throw stateError("commit_conflict");
    }
    record.state = "committed";
    record.uploadExpiresAt = null;
    this._touch(record, now);
    return frozen(this._commitResponse(record, false));
  }

  async authorize(artifactId, binding, method) {
    const input = callObject(artifactId, binding, method === undefined ? {} : { method });
    const scopedBinding = parseBinding(input);
    const requestMethod = String(input.method || "GET").toUpperCase();
    if (requestMethod !== "GET" && requestMethod !== "HEAD") {
      throw new TypeError("subtitle delivery method is invalid");
    }
    const now = this._now();
    this._prune(now);
    const record = this._record(input.artifactId);
    if (!record || record.state !== "committed" || record.deletionRequested ||
        !bindingEqual(record.binding, scopedBinding) || !this._bindingIsCurrent(scopedBinding)) return null;
    const profile = this._usage(scopedBinding.profileId);
    if (profile.leases >= this._limits.profileLeases) throw capacityError("profile", "I/O lease limit");
    if (this._global.leases >= this._limits.globalLeases) throw capacityError("global", "I/O lease limit");
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const lease = this._tokens.issue("subtitle-lease", 24);
      if (record.leases.has(lease.tokenHash)) continue;
      const leaseExpiresAt = addTime(now, this._limits.ioLeaseTtlMs, "subtitle I/O lease");
      record.leases.set(lease.tokenHash, { method: requestMethod, expiresAt: leaseExpiresAt });
      profile.leases += 1;
      this._global.leases += 1;
      this._touch(record, now);
      return frozen({
        status: "authorized",
        artifactId: record.artifactId,
        expiresAt: record.expiresAt,
        leaseExpiresAt,
        method: requestMethod,
        leaseToken: lease.token,
        parts: record.parts.map(partPublic),
      });
    }
    throw codedError("subtitle_lease_collision", "could not allocate a unique subtitle I/O lease");
  }

  async revalidate(artifactId, binding, leaseToken) {
    const input = callObject(artifactId, binding, leaseToken === undefined ? {} : { leaseToken });
    const scopedBinding = parseBinding(input);
    let leaseHash;
    try {
      leaseHash = this._tokens.hashToken("subtitle-lease", input.leaseToken);
    } catch (_error) {
      return null;
    }
    const now = this._now();
    this._prune(now);
    const record = this._record(input.artifactId);
    const lease = record && record.leases.get(leaseHash);
    if (!record || !lease || record.state !== "committed" || record.deletionRequested ||
        !bindingEqual(record.binding, scopedBinding) || !this._bindingIsCurrent(scopedBinding)) return null;
    this._touch(record, now);
    return frozen({
      status: "revalidated",
      artifactId: record.artifactId,
      expiresAt: record.expiresAt,
      leaseExpiresAt: lease.expiresAt,
      method: lease.method,
      parts: record.parts.map(partPublic),
    });
  }

  async releaseLease(artifactId, leaseToken) {
    const id = assertIdentifier(
      artifactId && typeof artifactId === "object" ? artifactId.artifactId : artifactId,
      "subtitle artifact id"
    );
    const token = artifactId && typeof artifactId === "object" ? artifactId.leaseToken : leaseToken;
    let hash;
    try {
      hash = this._tokens.hashToken("subtitle-lease", token);
    } catch (_error) {
      return false;
    }
    const record = this._artifacts.get(id);
    if (!record || !record.leases.delete(hash)) return false;
    this._usage(record.binding.profileId).leases -= 1;
    this._global.leases -= 1;
    return true;
  }

  async invalidateRelease(profileId, deviceId, sessionId) {
    const input = profileId && typeof profileId === "object"
      ? assertPlainObject(profileId, "subtitle invalidation")
      : { profileId, deviceId, sessionId };
    return this._invalidate("release", input);
  }

  async invalidateSession(profileId, sessionId) {
    const input = profileId && typeof profileId === "object"
      ? assertPlainObject(profileId, "subtitle invalidation")
      : { profileId, sessionId };
    return this._invalidate("session", input);
  }

  async invalidateDevice(profileId, deviceId) {
    const input = profileId && typeof profileId === "object"
      ? assertPlainObject(profileId, "subtitle invalidation")
      : { profileId, deviceId };
    return this._invalidate("device", input);
  }

  async invalidateProfile(profileId) {
    const input = profileId && typeof profileId === "object"
      ? assertPlainObject(profileId, "subtitle invalidation")
      : { profileId };
    return this._invalidate("profile", input);
  }

  async claimDeletion(workerId, options = {}) {
    let worker = workerId;
    let supplied = options;
    if (workerId && typeof workerId === "object") {
      supplied = assertPlainObject(workerId, "subtitle deletion claim");
      worker = supplied.workerId;
    }
    const safeOptions = assertPlainObject(supplied || {}, "subtitle deletion claim options");
    assertIdentifier(worker, "subtitle deletion worker id");
    const leaseTtlMs = safeOptions.leaseTtlMs === undefined
      ? this._limits.deletionLeaseTtlMs
      : assertPositiveInteger(safeOptions.leaseTtlMs, "subtitle deletion lease ttl", this._limits.maxDeletionRetryMs);
    const now = this._now();
    this._prune(now);
    for (const record of this._artifacts.values()) {
      if (record.state !== "deleting" || record.deletionDueAt > now || record.leases.size > 0) continue;
      if (record.uploadSettlesAt !== null && record.uploadSettlesAt > now) continue;
      const token = this._tokens.issue("subtitle-deletion", 24);
      record.state = "deletion_claimed";
      record.deletionTokenHash = token.tokenHash;
      record.deletionLeaseExpiresAt = addTime(now, leaseTtlMs, "subtitle deletion lease");
      record.deletionAttempt += 1;
      return frozen({
        status: "claimed",
        artifactId: record.artifactId,
        artifactRef: record.artifactId,
        attempt: String(record.deletionAttempt),
        leaseExpiresAt: record.deletionLeaseExpiresAt,
        phase: record.deletionPhase,
        deletionToken: token.token,
        parts: record.parts.map(partPublic),
      });
    }
    return null;
  }

  async recordDeletionAbsence(artifactId, deletionToken, verifiedAbsent) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle deletion absence")
      : { artifactId, deletionToken, verifiedAbsent };
    if (input.verifiedAbsent !== true) throw new TypeError("subtitle deletion absence must be verified");
    const now = this._now();
    this._prune(now);
    const record = this._claimedDeletion(input.artifactId, input.deletionToken);
    if (!record) return null;
    if (record.uploadSettlesAt !== null && record.uploadSettlesAt > now) throw stateError("upload_barrier");
    if (record.deletionPhase !== "first") throw stateError("deletion_barrier");
    record.state = "deleting";
    record.deletionPhase = "second";
    record.deletionDueAt = addTime(now, this._limits.uploadSettlementGraceMs, "subtitle second deletion pass");
    this._clearDeletionClaim(record);
    return frozen({ status: "awaiting_second_pass", retryAt: record.deletionDueAt });
  }

  async retryDeletion(artifactId, deletionToken, retryDelayMs) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle deletion retry")
      : { artifactId, deletionToken, retryDelayMs };
    const delay = assertPositiveInteger(input.retryDelayMs, "subtitle deletion retry delay", this._limits.maxDeletionRetryMs);
    const now = this._now();
    this._prune(now);
    const record = this._claimedDeletion(input.artifactId, input.deletionToken);
    if (!record) return null;
    record.state = "deleting";
    record.deletionDueAt = addTime(now, delay, "subtitle deletion retry");
    this._clearDeletionClaim(record);
    return frozen({ status: "retrying", attempt: String(record.deletionAttempt), retryAt: record.deletionDueAt });
  }

  async confirmDeletion(artifactId, deletionToken, verifiedAbsent) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle deletion confirmation")
      : { artifactId, deletionToken, verifiedAbsent };
    if (input.verifiedAbsent !== true) {
      throw new TypeError("subtitle deletion confirmation requires verified absence");
    }
    const now = this._now();
    this._prune(now);
    const record = this._claimedDeletion(input.artifactId, input.deletionToken);
    if (!record) return null;
    if (record.uploadSettlesAt !== null && record.uploadSettlesAt > now) throw stateError("upload_barrier");
    if (record.deletionPhase !== "second") throw stateError("deletion_barrier");
    if (record.leases.size > 0) throw stateError("lease_busy");
    const released = clone(record.quota);
    this._removeRecord(record);
    return frozen({ status: "confirmed", released });
  }

  async prune() {
    return frozen(this._prune(this._now()));
  }

  reserveArtifact(...args) { return this.reserve(...args); }
  commitUpload(...args) { return this.commit(...args); }
  authorizeRead(...args) { return this.authorize(...args); }
  revalidateRead(...args) { return this.revalidate(...args); }
  claimDeletionJob(...args) { return this.claimDeletion(...args); }
  retryDeletionJob(...args) { return this.retryDeletion(...args); }
  recordDeletionAbsenceJob(...args) { return this.recordDeletionAbsence(...args); }
  confirmDeletionJob(...args) { return this.confirmDeletion(...args); }

  _setAuthority(profileId, request) {
    const now = this._now();
    this._prune(now);
    if (this._contexts.getProfileGeneration(profileId) !== request.generation) {
      const error = stateError("authority_stale");
      error.status = 409;
      error.statusCode = 409;
      throw error;
    }
    const current = this._authorities.get(profileId) || null;
    if (request.compareAndSet) {
      const expectedMatches = current
        ? request.expectedProviderRevision === current.providerRevision && request.expectedGeneration === current.generation
        : request.expectedProviderRevision === null && request.expectedGeneration === null;
      if (!expectedMatches) {
        const error = stateError("authority_conflict");
        error.status = 409;
        error.statusCode = 409;
        throw error;
      }
    }
    if (current && BigInt(request.providerRevision) < BigInt(current.providerRevision)) {
      const error = stateError("authority_stale");
      error.status = 409;
      error.statusCode = 409;
      throw error;
    }
    if (current && current.providerRevision === request.providerRevision && current.generation === request.generation) {
      return frozen({ status: "unchanged", revision: current.revision, invalidated: 0,
        providerRevision: current.providerRevision, generation: current.generation });
    }
    if (!current && this._authorities.size >= this._limits.globalAuthorities) {
      throw capacityError("global", "authority limit");
    }
    let invalidated = 0;
    for (const record of this._artifacts.values()) {
      if (record.binding.profileId !== profileId || record.deletionRequested) continue;
      if (record.binding.providerRevision === request.providerRevision &&
          record.binding.generation === request.generation) continue;
      this._markDeleting(record, now);
      invalidated += 1;
    }
    const next = {
      providerRevision: request.providerRevision,
      generation: request.generation,
      revision: current ? (BigInt(current.revision) + 1n).toString() : "1",
    };
    this._authorities.set(profileId, next);
    return frozen({ status: "updated", revision: next.revision, invalidated,
      providerRevision: next.providerRevision, generation: next.generation });
  }

  _invalidate(mode, input) {
    const profileId = assertIdentifier(input.profileId, "profile id");
    const deviceId = mode === "release" || mode === "device"
      ? assertIdentifier(input.deviceId, "device id")
      : null;
    const sessionId = mode === "release" || mode === "session"
      ? assertIdentifier(input.sessionId, "session id")
      : null;
    const now = this._now();
    this._prune(now);
    let invalidated = 0;
    for (const record of this._artifacts.values()) {
      if (record.binding.profileId !== profileId || record.deletionRequested) continue;
      if (deviceId !== null && record.binding.deviceId !== deviceId) continue;
      if (sessionId !== null && record.binding.sessionId !== sessionId) continue;
      this._markDeleting(record, now);
      invalidated += 1;
    }
    return invalidated;
  }

  _bindingIsCurrent(binding) {
    if (this._contexts.getProfileGeneration(binding.profileId) !== binding.generation) return false;
    const authority = this._authorities.get(binding.profileId);
    if (!authority || authority.generation !== binding.generation ||
        authority.providerRevision !== binding.providerRevision) return false;
    const active = this._contexts.getActiveClaim(binding.profileId, binding.deviceId, binding.sessionId);
    if (!active || active.status !== "claimed" || !active.deliveryBinding) return false;
    return bindingEqual(binding, active.deliveryBinding);
  }

  _record(value) {
    const id = assertIdentifier(value, "subtitle artifact id");
    return this._artifacts.get(id) || null;
  }

  _fetchResponse(record, token, replay) {
    return {
      status: "fetching",
      replay,
      artifactId: record.artifactId,
      expiresAt: record.expiresAt,
      fetchExpiresAt: record.fetchExpiresAt,
      fetchToken: token,
      fetchFence: String(record.fetchFence),
      sourceCapability: clone(record.sourceCapability),
      parts: [],
    };
  }

  _stageResponse(record, token, replay) {
    return {
      status: record.state === "committed" ? "committed" : "uploading",
      replay,
      artifactId: record.artifactId,
      expiresAt: record.expiresAt,
      uploadExpiresAt: record.uploadExpiresAt,
      uploadSettlementDeadline: record.uploadSettlesAt,
      uploadToken: token,
      sourceCapability: null,
      parts: record.parts.map(partPublic),
    };
  }

  _commitResponse(record, replay) {
    return {
      status: "committed",
      replay,
      artifactId: record.artifactId,
      expiresAt: record.expiresAt,
      sizeBytes: record.quota.bytes,
      parts: record.parts.map(partPublic),
    };
  }

  _normalizeReceipts(value, staged) {
    if (!Array.isArray(value) || value.length !== staged.length) {
      throw new TypeError("subtitle upload receipts are invalid");
    }
    return value.map((raw, index) => normalizeReceipt(
      raw,
      index,
      this._limits.artifactBytes,
      this._objectKeys,
      staged[index]
    ));
  }

  _markDeleting(record, now) {
    if (record.deletionRequested) return;
    record.deletionRequested = true;
    record.sourceCapability = null;
    record.reservationTokenHash = null;
    if (this._discoveries.get(record.discoveryRef) === record.artifactId) {
      this._discoveries.delete(record.discoveryRef);
    }
    const barrier = (record.state === "uploading" || record.state === "committed") &&
      record.uploadSettlesAt !== null
      ? record.uploadSettlesAt
      : now;
    record.state = "deleting";
    record.deletionPhase = "first";
    record.deletionDueAt = Math.max(now, barrier);
    record.fetchExpiresAt = null;
    record.uploadExpiresAt = null;
  }

  _resetFetch(record) {
    record.fetchFencedTokenHash = record.fetchTokenHash;
    record.state = "reserved";
    record.fetchTokenHash = null;
    record.fetchExpiresAt = null;
  }

  _claimedDeletion(artifactId, token) {
    const record = this._record(artifactId);
    if (!record || record.state !== "deletion_claimed" ||
        !this._tokenMatches("subtitle-deletion", token, record.deletionTokenHash)) return null;
    return record;
  }

  _clearDeletionClaim(record) {
    record.deletionTokenHash = null;
    record.deletionLeaseExpiresAt = null;
  }

  _prune(now) {
    const result = { artifacts: 0, deletionClaims: 0, leases: 0, uploads: 0, fetches: 0, hasMore: false };
    for (const record of this._artifacts.values()) {
      result.leases += this._pruneLeases(record, now);
      if (record.state === "deletion_claimed" && record.deletionLeaseExpiresAt <= now) {
        record.state = "deleting";
        record.deletionDueAt = now;
        this._clearDeletionClaim(record);
        result.deletionClaims += 1;
      }
      if (record.state === "fetching" && record.fetchExpiresAt <= now) {
        this._resetFetch(record);
        result.fetches += 1;
      }
      if (record.state === "uploading" && record.uploadExpiresAt <= now) {
        this._markDeleting(record, now);
        result.uploads += 1;
      }
      if (!record.deletionRequested && (record.expiresAt <= now || record.absoluteExpiresAt <= now)) {
        this._markDeleting(record, now);
        result.artifacts += 1;
      }
    }
    return result;
  }

  _pruneLeases(record, now) {
    let removed = 0;
    for (const [hash, lease] of record.leases) {
      if (lease.expiresAt > now) continue;
      record.leases.delete(hash);
      removed += 1;
    }
    if (removed > 0) {
      this._usage(record.binding.profileId).leases -= removed;
      this._global.leases -= removed;
    }
    return removed;
  }

  _touch(record, now) {
    record.expiresAt = Math.min(addTime(now, this._limits.logicalTtlMs, "subtitle TTL"), record.absoluteExpiresAt);
  }

  _removeRecord(record) {
    this._artifacts.delete(record.artifactId);
    if (this._discoveries.get(record.discoveryRef) === record.artifactId) {
      this._discoveries.delete(record.discoveryRef);
    }
    this._pruneLeases(record, this._now());
    if (record.leases.size > 0) {
      const count = record.leases.size;
      record.leases.clear();
      this._usage(record.binding.profileId).leases -= count;
      this._global.leases -= count;
    }
    this._adjustUsage(record.binding.profileId, {
      artifacts: -record.quota.artifacts,
      objects: -record.quota.objects,
      bytes: -record.quota.bytes,
    });
  }

  _assertCapacity(profileId, delta) {
    const profile = this._usage(profileId);
    if (profile.artifacts + delta.artifacts > this._limits.profileArtifacts ||
        profile.objects + delta.objects > this._limits.profileObjects ||
        profile.bytes + delta.bytes > this._limits.profileBytes) throw capacityError("profile");
    if (this._global.artifacts + delta.artifacts > this._limits.globalArtifacts ||
        this._global.objects + delta.objects > this._limits.globalObjects ||
        this._global.bytes + delta.bytes > this._limits.globalBytes) throw capacityError("global");
  }

  _adjustUsage(profileId, delta) {
    const profile = this._usage(profileId);
    for (const field of ["artifacts", "objects", "bytes"]) {
      profile[field] += delta[field] || 0;
      this._global[field] += delta[field] || 0;
      if (profile[field] < 0 || this._global[field] < 0) throw stateError("state_collision");
    }
  }

  _usage(profileId) {
    let usage = this._profiles.get(profileId);
    if (!usage) {
      usage = zeroUsage();
      this._profiles.set(profileId, usage);
    }
    return usage;
  }

  _tokenMatches(purpose, token, expectedHash) {
    if (!expectedHash) return false;
    try {
      const actual = Buffer.from(this._tokens.hashToken(purpose, token), "hex");
      const expected = Buffer.from(expectedHash, "hex");
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    } catch (_error) {
      return false;
    }
  }

  _nextArtifactId() {
    const value = this._idFactory
      ? this._idFactory("subtitle-artifact")
      : this._tokens.issue("subtitle-artifact", 32).token;
    return assertIdentifier(value, "subtitle artifact id");
  }

  _discoveryRef(binding, discoveryKey) {
    return JSON.stringify([
      binding.profileId,
      binding.deviceId,
      binding.sessionId,
      binding.generation,
      binding.contextId,
      binding.contextRevision,
      binding.providerRevision,
      discoveryKey,
    ]);
  }

  _now() {
    const value = Number(this._clock());
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
      throw new TypeError("clock must return a valid millisecond timestamp");
    }
    if (value < this._lastNow) return this._lastNow;
    this._lastNow = value;
    return value;
  }
}

module.exports = {
  DEFAULT_MEMORY_SUBTITLE_DELIVERY_LIMITS: DEFAULT_LIMITS,
  MemorySubtitleDeliveryRepository,
};
