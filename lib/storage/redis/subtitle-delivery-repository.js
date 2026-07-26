"use strict";

const {
  assertBoundedString,
  assertJsonSize,
  assertPlainObject,
  assertPositiveInteger,
  codedError,
} = require("../repository-utils");
const { OpaqueObjectKeyFactory } = require("../object-store");
const { initializeRedisOptions } = require("./base");
const { asArray, asInteger, asString } = require("./reply");

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
  uploadLeaseTtlMs: 120 * 1000,
  maxPutLifetimeMs: 120 * 1000,
  uploadSettlementGraceMs: 30 * 1000,
  ioLeaseTtlMs: 30 * 1000,
  deletionLeaseTtlMs: 60 * 1000,
  maxDeletionRetryMs: 5 * 60 * 1000,
  pruneBatchSize: 32,
  deletionScanBatchSize: 32,
  leaseCleanupBatchSize: 32,
  uploadCleanupBatchSize: 32,
  sourceCapabilityBytes: 64 * 1024,
  sourceEnvelopeBytes: 256 * 1024,
});

const MAX_BATCH_SIZE = 256;
const MAX_ID_ATTEMPTS = 8;
const MAX_BEGIN_RETRIES = 4;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,127})$/;
const GENERATION_PATTERN = /^g1:[A-Za-z0-9_-]{1,128}$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const PART_METADATA_VERSION = 1;
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
const TEXT_PART_MEDIA_TYPES = new Map([
  [".srt", "application/x-subrip"],
  [".vtt", "text/vtt"],
  [".ass", "text/x-ssa"],
  [".ssa", "text/x-ssa"],
  [".smi", "application/x-sami"],
  [".sub", "text/x-microdvd"],
  [".txt", "text/plain"],
]);

function optionalLimit(options, name, fallback, maximum) {
  const value = options[name] ?? fallback;
  return assertPositiveInteger(value, name, maximum);
}

function assertScopedIdentifier(value, name) {
  return assertBoundedString(value, name, 256, { minimumLength: 1 });
}

function assertGeneration(value) {
  if (typeof value !== "string" || !GENERATION_PATTERN.test(value)) {
    throw new TypeError("profile generation is invalid");
  }
  return value;
}

function decimalString(value, name) {
  let normalized;
  if (typeof value === "bigint") normalized = value.toString();
  else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + " is invalid");
    normalized = String(value);
  } else normalized = value;
  if (typeof normalized !== "string" || !DECIMAL_PATTERN.test(normalized)) {
    throw new TypeError(name + " is invalid");
  }
  return normalized;
}

function safeReplyInteger(value, name) {
  const raw = asString(value, name);
  if (!DECIMAL_PATTERN.test(raw)) throw new TypeError(name + " is invalid");
  const parsed = BigInt(raw);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError(name + " is invalid");
  return Number(parsed);
}

function decimalReply(value, name) {
  const raw = asString(value, name);
  if (!DECIMAL_PATTERN.test(raw)) throw new TypeError(name + " is invalid");
  return raw;
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

function stateError(status) {
  const errors = {
    state_collision: ["subtitle_state_collision", "Redis subtitle delivery state is inconsistent"],
    artifact_collision: ["subtitle_artifact_collision", "subtitle artifact identifier collision"],
    authority_conflict: ["subtitle_authority_conflict", "subtitle provider authority changed"],
    authority_stale: ["subtitle_authority_stale", "subtitle provider authority snapshot is stale"],
    fetch_busy: ["subtitle_fetch_busy", "subtitle fetch is owned by another attempt"],
    fetch_conflict: ["subtitle_fetch_conflict", "subtitle fetch state conflicts with this request"],
    stage_conflict: ["subtitle_stage_conflict", "subtitle staged upload conflicts with this request"],
    upload_busy: ["subtitle_upload_busy", "subtitle upload is owned by another attempt"],
    upload_conflict: ["subtitle_upload_conflict", "subtitle upload state conflicts with this request"],
    commit_conflict: ["subtitle_commit_conflict", "subtitle commit state conflicts with this request"],
    invalid_parts: ["subtitle_invalid_parts", "subtitle part metadata is invalid"],
    artifact_too_large: ["subtitle_artifact_too_large", "subtitle artifact exceeds its byte limit"],
    upload_barrier: ["subtitle_upload_barrier", "subtitle upload has not reached a terminal state"],
    deletion_barrier: ["subtitle_deletion_barrier", "subtitle deletion verification is incomplete"],
    lease_busy: ["subtitle_lease_busy", "subtitle artifact still has an active I/O lease"],
  };
  const mapped = errors[status];
  return mapped
    ? codedError(mapped[0], mapped[1])
    : codedError("subtitle_state_error", "unexpected subtitle delivery status: " + status);
}

function normalizeSourceCapability(value, maximumBytes) {
  const input = assertPlainObject(value, "subtitle source capability");
  const allowed = new Set(["url", "headers"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError("subtitle source capability field is unsupported: " + key);
  }

  const rawUrl = assertBoundedString(input.url, "subtitle source capability url", 8192);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    throw new TypeError("subtitle source capability url is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new TypeError("subtitle source capability url is invalid");
  }

  const sourceHeaders = input.headers === undefined
    ? {}
    : assertPlainObject(input.headers, "subtitle source capability headers");
  const entries = Object.entries(sourceHeaders);
  if (entries.length > 32) throw new TypeError("subtitle source capability headers are invalid");
  const headers = Object.create(null);
  for (const [rawName, rawValue] of entries) {
    if (!HEADER_NAME_PATTERN.test(rawName)) {
      throw new TypeError("subtitle source capability header name is invalid");
    }
    const name = rawName.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(headers, name)) {
      throw new TypeError("subtitle source capability header name is duplicated");
    }
    headers[name] = assertBoundedString(
      rawValue,
      "subtitle source capability header value",
      8192,
      { minimumLength: 0, trimmed: false }
    );
  }

  const capability = {
    v: 1,
    url: parsed.toString(),
    headers: Object.fromEntries(Object.entries(headers).sort(([left], [right]) => left.localeCompare(right))),
  };
  assertJsonSize(capability, "subtitle source capability", maximumBytes);
  return capability;
}

function serializeEnvelope(envelope, maximumBytes) {
  assertPlainObject(envelope, "subtitle source envelope");
  let serialized;
  try {
    serialized = JSON.stringify(envelope);
  } catch (_error) {
    throw new TypeError("subtitle source envelope is not JSON serializable");
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new RangeError("subtitle source envelope exceeds its maximum length");
  }
  return serialized;
}

function parseEnvelope(value, maximumBytes) {
  const serialized = asString(value, "subtitle source envelope");
  if (
    serialized.length < 2 ||
    Buffer.byteLength(serialized, "utf8") > maximumBytes
  ) {
    throw new TypeError("Redis subtitle source envelope is invalid");
  }
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch (_error) {
    throw new TypeError("Redis subtitle source envelope is invalid");
  }
  return assertPlainObject(envelope, "Redis subtitle source envelope");
}

function assertOnlyFields(input, allowed, name) {
  for (const field of Reflect.ownKeys(input)) {
    if (typeof field !== "string" || !allowed.has(field)) {
      throw new TypeError(name + " contains an unsupported field");
    }
  }
}

function assertCanonicalPartTuple(part, count, index) {
  if (count === 1) {
    if (
      part.role !== "subtitle" ||
      TEXT_PART_MEDIA_TYPES.get(part.extension) !== part.mediaType
    ) {
      throw new TypeError("subtitle part metadata is not canonical");
    }
    return;
  }
  const expected = index === 0
    ? { role: "index", extension: ".idx", mediaType: "application/x-vobsub" }
    : { role: "sub", extension: ".sub", mediaType: "application/octet-stream" };
  if (
    count !== 2 ||
    part.role !== expected.role ||
    part.extension !== expected.extension ||
    part.mediaType !== expected.mediaType
  ) {
    throw new TypeError("subtitle VobSub part metadata is not canonical");
  }
}

function normalizeLegacyPart(part, index, maximumBytes) {
  const input = assertPlainObject(part, "subtitle part");
  const size = input.sizeBytes ?? input.size;
  assertPositiveInteger(size, "subtitle part size", maximumBytes);
  const checksum = input.checksum ?? input.sha256;
  if (typeof checksum !== "string" || !CHECKSUM_PATTERN.test(checksum)) {
    throw new TypeError("subtitle part checksum is invalid");
  }
  if (input.partNumber !== undefined && input.partNumber !== index + 1) {
    throw new TypeError("subtitle part number is invalid");
  }
  return { partNumber: index + 1, sizeBytes: size, checksum };
}

function normalizeStageParts(parts, maximumParts, maximumBytes) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > maximumParts) {
    throw new TypeError("subtitle parts are invalid");
  }
  const normalized = parts.map((part, index) => {
    const input = assertPlainObject(part, "subtitle staged part");
    assertOnlyFields(input, STAGE_PART_FIELDS, "subtitle staged part");
    if (Reflect.ownKeys(input).length !== STAGE_PART_FIELDS.size) {
      throw new TypeError("subtitle staged part fields are incomplete");
    }
    if (input.partNumber !== index + 1) {
      throw new TypeError("subtitle part number is invalid");
    }
    const sizeBytes = assertPositiveInteger(
      input.sizeBytes,
      "subtitle part size",
      maximumBytes
    );
    if (typeof input.checksum !== "string" || !CHECKSUM_PATTERN.test(input.checksum)) {
      throw new TypeError("subtitle part checksum is invalid");
    }
    for (const [field, maximum] of [["role", 16], ["extension", 16], ["mediaType", 128]]) {
      assertBoundedString(input[field], "subtitle part " + field, maximum);
    }
    const value = {
      partNumber: index + 1,
      sizeBytes,
      checksum: input.checksum,
      role: input.role,
      extension: input.extension,
      mediaType: input.mediaType,
    };
    assertCanonicalPartTuple(value, parts.length, index);
    return value;
  });
  const total = normalized.reduce((sum, part) => sum + part.sizeBytes, 0);
  if (!Number.isSafeInteger(total) || total > maximumBytes) {
    throw stateError("artifact_too_large");
  }
  return { parts: normalized, total };
}

function normalizeReceipt(receipt, index, maximumBytes, objectKeyFactory) {
  const input = assertPlainObject(receipt, "subtitle upload receipt");
  assertOnlyFields(input, RECEIPT_FIELDS, "subtitle upload receipt");
  const aliases = [
    ["objectKey", "key"],
    ["sizeBytes", "contentLength"],
    ["checksum", "checksumSha256"],
    ["mediaType", "contentType"],
  ];
  for (const [left, right] of aliases) {
    if (input[left] !== undefined && input[right] !== undefined) {
      throw new TypeError("subtitle upload receipt contains duplicate fields");
    }
  }
  if (input.partNumber !== undefined && input.partNumber !== index + 1) {
    throw new TypeError("subtitle upload receipt part number is invalid");
  }
  const objectKey = assertStoredObjectKey(objectKeyFactory, input.objectKey ?? input.key);
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
  return { partNumber: index + 1, objectKey, sizeBytes, checksum, mediaType };
}

function assertStoredObjectKey(factory, value) {
  const objectKey = asString(value, "subtitle object key");
  if (!(factory instanceof OpaqueObjectKeyFactory)) {
    throw new TypeError("objectKeyFactory is required for subtitle delivery");
  }
  return factory.assert(objectKey);
}

function parseStoredParts(reply, offset, maximumParts, objectKeyFactory) {
  const schemaVersion = asInteger(reply[offset], "subtitle artifact schema version");
  const metadataRaw = asString(reply[offset + 1], "subtitle part metadata version");
  const count = asInteger(reply[offset + 2], "subtitle part count");
  if (
    (schemaVersion !== 2 && schemaVersion !== 3) ||
    (metadataRaw !== "" && metadataRaw !== String(PART_METADATA_VERSION)) ||
    (schemaVersion === 2 && metadataRaw !== "") ||
    count < 0 ||
    count > maximumParts ||
    reply.length !== offset + 3 + count * 7
  ) {
    throw new TypeError("Redis subtitle part reply is invalid");
  }
  const partMetadataVersion = metadataRaw === "" ? null : PART_METADATA_VERSION;
  const parts = [];
  let cursor = offset + 3;
  for (let index = 0; index < count; index += 1) {
    const objectKey = assertStoredObjectKey(objectKeyFactory, reply[cursor++]);
    const partNumberRaw = asString(reply[cursor++], "subtitle part number");
    const sizeRaw = asString(reply[cursor++], "subtitle part size");
    const checksumRaw = asString(reply[cursor++], "subtitle part checksum");
    const roleRaw = asString(reply[cursor++], "subtitle part role");
    const extensionRaw = asString(reply[cursor++], "subtitle part extension");
    const mediaTypeRaw = asString(reply[cursor++], "subtitle part media type");
    const partNumber = partNumberRaw === ""
      ? index + 1
      : safeReplyInteger(partNumberRaw, "subtitle part number");
    const part = {
      partNumber,
      objectKey,
      sizeBytes: sizeRaw === "" ? null : safeReplyInteger(sizeRaw, "subtitle part size"),
      checksum: checksumRaw === "" ? null : checksumRaw,
      role: roleRaw === "" ? null : roleRaw,
      extension: extensionRaw === "" ? null : extensionRaw,
      mediaType: mediaTypeRaw === "" ? null : mediaTypeRaw,
    };
    if (schemaVersion === 3) {
      if (
        partMetadataVersion !== PART_METADATA_VERSION ||
        part.partNumber !== index + 1 ||
        part.sizeBytes === null ||
        !CHECKSUM_PATTERN.test(part.checksum || "") ||
        part.role === null ||
        part.extension === null ||
        part.mediaType === null
      ) {
        throw new TypeError("Redis subtitle part metadata is invalid");
      }
      assertCanonicalPartTuple(part, count, index);
    } else if (
      partNumberRaw !== "" ||
      roleRaw !== "" ||
      extensionRaw !== "" ||
      mediaTypeRaw !== "" ||
      (checksumRaw !== "" && !CHECKSUM_PATTERN.test(checksumRaw))
    ) {
      throw new TypeError("Redis legacy subtitle part metadata is invalid");
    }
    parts.push(part);
  }
  return { schemaVersion, partMetadataVersion, parts };
}

function parseUploadParts(reply, offset, maximumParts, objectKeyFactory) {
  const count = asInteger(reply[offset], "subtitle upload part count");
  if (count < 1 || count > maximumParts || reply.length !== offset + 1 + count) {
    throw new TypeError("Redis subtitle upload part reply is invalid");
  }
  return Array.from({ length: count }, (_value, index) => ({
    partNumber: index + 1,
    objectKey: assertStoredObjectKey(objectKeyFactory, reply[offset + 1 + index]),
  }));
}

function callObject(first, second, additions = {}) {
  if (first && typeof first === "object" && !Array.isArray(first)) {
    return { ...assertPlainObject(first, "subtitle delivery request"), ...additions };
  }
  return {
    ...assertPlainObject(second, "subtitle delivery binding"),
    artifactId: first,
    ...additions,
  };
}

class RedisSubtitleDeliveryRepository {
  constructor(options = {}) {
    const supplied = assertPlainObject(options, "Redis subtitle delivery options");
    const shared = initializeRedisOptions(supplied);
    if (
      !supplied.tokenService ||
      typeof supplied.tokenService.issue !== "function" ||
      typeof supplied.tokenService.hashToken !== "function" ||
      typeof supplied.tokenService.hashOpaque !== "function"
    ) {
      throw new TypeError("tokenService is required");
    }
    if (
      !supplied.envelopeCrypto ||
      typeof supplied.envelopeCrypto.encryptJson !== "function" ||
      typeof supplied.envelopeCrypto.decryptJson !== "function"
    ) {
      throw new TypeError("envelopeCrypto is required");
    }
    this._keys = shared.keyspace;
    this._scripts = shared.scripts;
    this._tokens = supplied.tokenService;
    this._crypto = supplied.envelopeCrypto;
    if (
      supplied.objectKeyFactory !== undefined &&
      !(supplied.objectKeyFactory instanceof OpaqueObjectKeyFactory)
    ) {
      throw new TypeError("objectKeyFactory must be an OpaqueObjectKeyFactory");
    }
    this._objectKeys = supplied.objectKeyFactory || null;
    this._idFactory = supplied.idFactory || null;
    if (this._idFactory !== null && typeof this._idFactory !== "function") {
      throw new TypeError("idFactory must be a function");
    }

    const legacyEnvelopeLimit = supplied.maxSourceEnvelopeBytes;
    this._limits = Object.freeze({
      profileArtifacts: optionalLimit(supplied, "maxProfileArtifacts", 64, 64),
      profileObjects: optionalLimit(supplied, "maxProfileObjects", 128, 128),
      profileBytes: optionalLimit(supplied, "maxProfileBytes", 128 * 1024 * 1024, 128 * 1024 * 1024),
      profileLeases: optionalLimit(supplied, "maxProfileLeases", 4, 4),
      globalArtifacts: optionalLimit(supplied, "maxGlobalArtifacts", 4096, 4096),
      globalObjects: optionalLimit(supplied, "maxGlobalObjects", 8192, 8192),
      globalBytes: optionalLimit(supplied, "maxGlobalBytes", 8 * 1024 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
      globalLeases: optionalLimit(supplied, "maxGlobalLeases", 32, 32),
      globalAuthorities: optionalLimit(supplied, "maxGlobalAuthorities", 4096, 4096),
      artifactBytes: optionalLimit(supplied, "maxArtifactBytes", 12 * 1024 * 1024, 12 * 1024 * 1024),
      artifactParts: optionalLimit(supplied, "maxArtifactParts", 2, 2),
      logicalTtlMs: optionalLimit(supplied, "logicalTtlMs", 120 * 1000, 120 * 1000),
      absoluteTtlMs: optionalLimit(supplied, "absoluteTtlMs", 10 * 60 * 1000, 10 * 60 * 1000),
      uploadLeaseTtlMs: optionalLimit(supplied, "uploadLeaseTtlMs", 120 * 1000, 120 * 1000),
      maxPutLifetimeMs: optionalLimit(supplied, "maxPutLifetimeMs", 120 * 1000, 120 * 1000),
      uploadSettlementGraceMs: optionalLimit(
        supplied,
        "uploadSettlementGraceMs",
        30 * 1000,
        120 * 1000
      ),
      ioLeaseTtlMs: optionalLimit(supplied, "ioLeaseTtlMs", 30 * 1000, 120 * 1000),
      deletionLeaseTtlMs: optionalLimit(supplied, "deletionLeaseTtlMs", 60 * 1000, 5 * 60 * 1000),
      maxDeletionRetryMs: optionalLimit(supplied, "maxDeletionRetryMs", 5 * 60 * 1000, 5 * 60 * 1000),
      pruneBatchSize: optionalLimit(supplied, "pruneBatchSize", 32, MAX_BATCH_SIZE),
      deletionScanBatchSize: optionalLimit(supplied, "deletionScanBatchSize", 32, MAX_BATCH_SIZE),
      leaseCleanupBatchSize: optionalLimit(supplied, "leaseCleanupBatchSize", 32, MAX_BATCH_SIZE),
      uploadCleanupBatchSize: optionalLimit(supplied, "uploadCleanupBatchSize", 32, MAX_BATCH_SIZE),
      sourceCapabilityBytes: optionalLimit(supplied, "maxSourceCapabilityBytes", 64 * 1024, 256 * 1024),
      sourceEnvelopeBytes: optionalLimit(
        { maxSourceEnvelopeBytes: legacyEnvelopeLimit },
        "maxSourceEnvelopeBytes",
        256 * 1024,
        1024 * 1024
      ),
    });
    if (this._limits.absoluteTtlMs < this._limits.logicalTtlMs) {
      throw new TypeError("absoluteTtlMs must not be shorter than logicalTtlMs");
    }
    for (const [profileName, globalName] of [
      ["profileArtifacts", "globalArtifacts"],
      ["profileObjects", "globalObjects"],
      ["profileBytes", "globalBytes"],
      ["profileLeases", "globalLeases"],
    ]) {
      if (this._limits[profileName] > this._limits[globalName]) {
        throw new TypeError(globalName + " must not be lower than " + profileName);
      }
    }

    this._global = Object.freeze([
      this._keys.key("subtitle-global-v2", "root"),
      this._keys.key("subtitle-global", "artifacts"),
      this._keys.key("subtitle-global", "deletions-ready"),
      this._keys.key("subtitle-global", "deletion-claims"),
      this._keys.key("subtitle-global", "lease-expiries"),
      this._keys.key("subtitle-global", "lease-data"),
      this._keys.key("subtitle-global", "upload-expiries"),
      this._keys.key("subtitle-global", "deletion-tokens"),
      this._keys.key("subtitle-global", "authorities"),
    ]);
  }

  async getAuthority(profileId) {
    const scopedProfileId = assertScopedIdentifier(
      profileId && typeof profileId === "object" ? profileId.profileId : profileId,
      "profile id"
    );
    const profileTag = this._keys.member("playback-profile", scopedProfileId);
    const reply = asArray(
      await this._scripts.run("subtitleGetAuthority", this._global, [profileTag]),
      "subtitleGetAuthority"
    );
    const status = asString(reply[0], "subtitle authority read status");
    if (status === "not_found") {
      if (reply.length !== 1) throw stateError("state_collision");
      return null;
    }
    if (status !== "authority" || reply.length !== 4) throw stateError(status);
    return {
      profileId: scopedProfileId,
      providerRevision: decimalReply(reply[1], "subtitle provider revision"),
      generation: assertGeneration(asString(reply[2], "subtitle profile generation")),
      revision: decimalReply(reply[3], "subtitle authority revision"),
    };
  }

  async transitionAuthority(profileId, request) {
    let input;
    if (profileId && typeof profileId === "object") {
      input = assertPlainObject(profileId, "subtitle authority update");
    } else {
      input = { ...assertPlainObject(request, "subtitle authority update"), profileId };
    }
    const scopedProfileId = assertScopedIdentifier(input.profileId, "profile id");
    const expectedProvider = input.expectedProviderRevision;
    const expectedGeneration = input.expectedGeneration;
    if (
      (expectedProvider === null) !== (expectedGeneration === null) ||
      expectedProvider === undefined ||
      expectedGeneration === undefined
    ) {
      throw new TypeError("subtitle authority expected revision and generation must both be null or present");
    }
    const nextProviderRevision = decimalString(
      input.providerRevision ?? input.nextProviderRevision,
      "provider revision"
    );
    const nextGeneration = assertGeneration(input.generation ?? input.nextGeneration);
    const profileTag = this._keys.member("playback-profile", scopedProfileId);
    const reply = asArray(
      await this._scripts.run(
        "subtitleUpdateAuthority",
        [
          ...this._global,
          ...this._profileKeys(scopedProfileId),
          this._keys.key("playback-profile-generation", scopedProfileId),
        ],
        [
          profileTag,
          expectedProvider === null ? "" : decimalString(expectedProvider, "expected provider revision"),
          expectedGeneration === null ? "" : assertGeneration(expectedGeneration),
          nextProviderRevision,
          nextGeneration,
          String(this._limits.globalAuthorities),
          String(this._limits.profileArtifacts),
        ]
      ),
      "subtitleUpdateAuthority"
    );
    const status = asString(reply[0], "subtitle authority update status");
    if (status === "global_capacity") throw capacityError("global", "authority limit");
    if (status === "authority_conflict" || status === "authority_stale") {
      const error = stateError(status);
      error.status = 409;
      error.statusCode = 409;
      throw error;
    }
    if ((status !== "updated" && status !== "unchanged") || reply.length !== 3) {
      throw stateError(status === "updated" || status === "unchanged" ? "state_collision" : status);
    }
    return {
      status,
      revision: decimalReply(reply[1], "subtitle authority revision"),
      invalidated: asInteger(reply[2], "invalidated subtitle artifact count"),
      providerRevision: nextProviderRevision,
      generation: nextGeneration,
    };
  }

  updateAuthority(...args) {
    return this.transitionAuthority(...args);
  }

  compareAndSetAuthority(...args) {
    return this.transitionAuthority(...args);
  }

  async reconcileAuthority(profileId, snapshot) {
    let input;
    if (profileId && typeof profileId === "object") {
      input = assertPlainObject(profileId, "subtitle authority reconciliation");
    } else {
      input = {
        ...assertPlainObject(snapshot, "subtitle authority reconciliation"),
        profileId,
      };
    }
    const scopedProfileId = assertScopedIdentifier(input.profileId, "profile id");
    const providerRevision = decimalString(input.providerRevision, "provider revision");
    const generation = assertGeneration(input.generation);
    const profileTag = this._keys.member("playback-profile", scopedProfileId);
    const reply = asArray(
      await this._scripts.run(
        "subtitleReconcileAuthority",
        [
          ...this._global,
          ...this._profileKeys(scopedProfileId),
          this._keys.key("playback-profile-generation", scopedProfileId),
        ],
        [
          profileTag,
          providerRevision,
          generation,
          String(this._limits.globalAuthorities),
          String(this._limits.profileArtifacts),
        ]
      ),
      "subtitleReconcileAuthority"
    );
    const status = asString(reply[0], "subtitle authority reconciliation status");
    if (status === "global_capacity") throw capacityError("global", "authority limit");
    if (status === "authority_stale") {
      const error = stateError(status);
      error.status = 409;
      error.statusCode = 409;
      throw error;
    }
    if ((status !== "updated" && status !== "unchanged") || reply.length !== 3) {
      throw stateError(status === "updated" || status === "unchanged" ? "state_collision" : status);
    }
    return {
      status,
      revision: decimalReply(reply[1], "subtitle authority revision"),
      invalidated: asInteger(reply[2], "invalidated subtitle artifact count"),
      providerRevision,
      generation,
    };
  }

  async reserve(profileId, deviceId, sessionId, request) {
    let input;
    if (profileId && typeof profileId === "object") input = assertPlainObject(profileId, "subtitle reservation");
    else {
      input = {
        ...assertPlainObject(request, "subtitle reservation"),
        profileId,
        deviceId,
        sessionId,
      };
    }
    this._requireObjectKeys();
    if (input.sourceEnvelope !== undefined) {
      throw new TypeError("sourceEnvelope is not accepted; provide a structured sourceCapability");
    }
    const binding = this._binding(input);
    const discoveryKey = assertBoundedString(
      input.discoveryKey ?? input.discoveryId ?? input.sourceHash,
      "subtitle discovery key",
      1024
    );
    const sourceCapability = normalizeSourceCapability(
      input.sourceCapability,
      this._limits.sourceCapabilityBytes
    );
    const discoveryRef = this._keys.member(
      "subtitle-discovery",
      binding.profileId,
      binding.deviceId,
      binding.sessionId,
      binding.generation,
      binding.contextId,
      binding.contextRevision,
      binding.providerRevision,
      discoveryKey
    );

    allocation: for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const artifactId = this._nextArtifactId();
      const artifact = this._artifact(artifactId);
      const reservation = this._tokens.issue("subtitle-reservation", 32);
      const envelope = serializeEnvelope(
        this._crypto.encryptJson(
          sourceCapability,
          this._sourcePurpose(binding.profileTag, artifact.ref)
        ),
        this._limits.sourceEnvelopeBytes
      );
      let duplicateChallenge = null;
      for (let duplicatePass = 0; duplicatePass < 2; duplicatePass += 1) {
        const digestArtifactRef = duplicateChallenge
          ? duplicateChallenge.artifactRef
          : artifact.ref;
        const sourceCapabilityDigest = this._sourceCapabilityDigest(
          sourceCapability,
          binding.profileTag,
          digestArtifactRef
        );
        const reply = asArray(
          await this._scripts.run(
            "subtitleReserve",
            [
              ...this._global,
              ...this._profileKeys(binding.profileId),
              ...artifact.keys,
              ...this._playbackKeys(binding),
            ],
            [
              binding.profileTag,
              artifactId,
              artifact.ref,
              discoveryRef,
              binding.deviceRef,
              binding.sessionId,
              binding.sessionRef,
              binding.generation,
              binding.contextRef,
              binding.contextRevision,
              binding.providerRevision,
              String(this._limits.artifactBytes),
              String(this._limits.artifactParts),
              envelope,
              sourceCapabilityDigest,
              reservation.tokenHash,
              String(this._limits.profileArtifacts),
              String(this._limits.profileObjects),
              String(this._limits.profileBytes),
              String(this._limits.globalArtifacts),
              String(this._limits.globalObjects),
              String(this._limits.globalBytes),
              String(this._limits.logicalTtlMs),
              String(this._limits.absoluteTtlMs),
              duplicateChallenge ? duplicateChallenge.artifactRef : "",
              duplicateChallenge ? duplicateChallenge.envelope : "",
            ]
          ),
          "subtitleReserve"
        );
        const status = asString(reply[0], "subtitle reserve status");
        if (status === "duplicate_challenge") {
          if (duplicateChallenge || reply.length !== 5) {
            throw new TypeError("Redis subtitle reserve reply is invalid");
          }
          const existingArtifactId = asString(reply[1], "subtitle artifact id");
          const existingArtifactRef = asString(reply[2], "subtitle artifact ref");
          const existingState = asString(reply[3], "subtitle artifact state");
          const existingEnvelope = asString(reply[4], "subtitle source envelope");
          if (
            existingState !== "reserved" &&
            existingState !== "fetching" &&
            existingState !== "uploading" &&
            existingState !== "committed"
          ) {
            throw stateError("state_collision");
          }
          if (this._artifact(existingArtifactId).ref !== existingArtifactRef) {
            throw stateError("state_collision");
          }
          if (existingEnvelope) {
            this._decryptSourceCapability(
              existingEnvelope,
              binding.profileTag,
              existingArtifactRef
            );
          } else if (existingState !== "committed") {
            throw stateError("state_collision");
          }
          duplicateChallenge = {
            artifactId: existingArtifactId,
            artifactRef: existingArtifactRef,
            envelope: existingEnvelope,
          };
          continue;
        }
        if (status === "artifact_collision") {
          if (duplicateChallenge) throw stateError("state_collision");
          continue allocation;
        }
        if (status === "not_found" || status === "source_conflict") return null;
        if (status === "profile_capacity") throw capacityError("profile");
        if (status === "global_capacity") throw capacityError("global");
        if (status === "reserved") {
          if (duplicateChallenge || reply.length !== 4) {
            throw new TypeError("Redis subtitle reserve reply is invalid");
          }
          return {
            status,
            duplicate: false,
            artifactId: asString(reply[1], "subtitle artifact id"),
            expiresAt: safeReplyInteger(reply[2], "subtitle artifact expiry"),
            absoluteExpiresAt: safeReplyInteger(reply[3], "subtitle artifact absolute expiry"),
            reservationToken: reservation.token,
            schemaVersion: 3,
            partMetadataVersion: null,
            state: "reserved",
            parts: [],
          };
        }
        if (status === "duplicate") {
          if (!duplicateChallenge || reply.length < 6) {
            throw new TypeError("Redis subtitle reserve reply is invalid");
          }
          const duplicateArtifactId = asString(reply[1], "subtitle artifact id");
          if (duplicateArtifactId !== duplicateChallenge.artifactId) {
            throw stateError("state_collision");
          }
          const ownsReservation = asString(reply[4], "subtitle reservation ownership");
          if (ownsReservation !== "0" && ownsReservation !== "1") {
            throw new TypeError("Redis subtitle reservation ownership is invalid");
          }
          const stored = parseStoredParts(
            reply,
            5,
            this._limits.artifactParts,
            this._objectKeys
          );
          return {
            status,
            duplicate: true,
            artifactId: duplicateArtifactId,
            state: asString(reply[2], "subtitle artifact state"),
            expiresAt: safeReplyInteger(reply[3], "subtitle artifact expiry"),
            reservationToken: ownsReservation === "1" ? reservation.token : null,
            ...stored,
          };
        }
        throw stateError(status);
      }
      throw stateError("state_collision");
    }
    throw codedError(
      "subtitle_artifact_collision",
      "could not allocate a unique subtitle artifact identifier"
    );
  }

  async cancelReservation(artifactId, binding, reservationToken) {
    const input = callObject(
      artifactId,
      binding,
      reservationToken === undefined ? {} : { reservationToken }
    );
    const scoped = this._boundArtifact(input);
    let reservationTokenHash = "";
    let fetchTokenHash = "";
    try {
      if (input.reservationToken !== undefined) {
        reservationTokenHash = this._tokens.hashToken(
          "subtitle-reservation",
          input.reservationToken
        );
      }
      if (input.fetchToken !== undefined) {
        fetchTokenHash = this._tokens.hashToken("subtitle-fetch", input.fetchToken);
      }
    } catch (_error) {
      return null;
    }
    if (!reservationTokenHash && !fetchTokenHash) return null;
    const reply = asArray(
      await this._scripts.run(
        "subtitleCancelReservation",
        [...this._global, ...this._profileKeys(scoped.profileId), ...scoped.artifact.keys],
        [...this._bindingArgs(scoped), reservationTokenHash, fetchTokenHash]
      ),
      "subtitleCancelReservation"
    );
    const status = asString(reply[0], "subtitle reservation cancellation status");
    if (status === "not_found") {
      if (reply.length !== 1) throw stateError("state_collision");
      return null;
    }
    if (status !== "canceled" || reply.length !== 5) throw stateError(status);
    return {
      status,
      artifactId: asString(reply[1], "subtitle artifact id"),
      released: {
        artifacts: safeReplyInteger(reply[2], "released subtitle artifact count"),
        objects: safeReplyInteger(reply[3], "released subtitle object count"),
        bytes: safeReplyInteger(reply[4], "released subtitle byte count"),
      },
    };
  }

  async beginFetch(artifactId, binding, fetchToken) {
    const input = callObject(
      artifactId,
      binding,
      fetchToken === undefined ? {} : { fetchToken }
    );
    const scoped = this._boundArtifact(input);
    let fetch;
    if (input.fetchToken === undefined) fetch = this._tokens.issue("subtitle-fetch", 32);
    else {
      fetch = {
        token: input.fetchToken,
        tokenHash: this._tokens.hashToken("subtitle-fetch", input.fetchToken),
      };
    }

    for (let attempt = 0; attempt < MAX_BEGIN_RETRIES; attempt += 1) {
      const peek = asArray(
        await this._scripts.run(
          "subtitleBeginFetchPeek",
          [...this._global, ...scoped.artifact.keys, ...this._playbackKeys(scoped)],
          [...this._bindingArgs(scoped), fetch.tokenHash]
        ),
        "subtitleBeginFetchPeek"
      );
      const peekStatus = asString(peek[0], "subtitle begin fetch peek status");
      if (peekStatus === "not_found") return null;
      if (peekStatus === "fetch_busy" || peekStatus === "fetch_conflict") {
        throw stateError(peekStatus);
      }
      if (peekStatus === "committed") {
        const stored = parseStoredParts(
          peek,
          3,
          this._limits.artifactParts,
          this._objectKeys
        );
        if (stored.schemaVersion !== 3 || stored.parts.length < 1) {
          throw stateError("state_collision");
        }
        return {
          status: "committed",
          artifactId: asString(peek[1], "subtitle artifact id"),
          expiresAt: safeReplyInteger(peek[2], "subtitle artifact expiry"),
          fetchToken: null,
          sourceCapability: null,
          ...stored,
        };
      }
      if (peekStatus !== "ready" && peekStatus !== "replay") throw stateError(peekStatus);
      const envelopeOffset = peekStatus === "ready" ? 4 : 6;
      const envelopeText = asString(peek[envelopeOffset], "subtitle source envelope");
      const sourceCapability = this._decryptSourceCapability(
        envelopeText,
        scoped.profileTag,
        scoped.artifact.ref
      );
      const reply = asArray(
        await this._scripts.run(
          "subtitleBeginFetch",
          [...this._global, ...scoped.artifact.keys, ...this._playbackKeys(scoped)],
          [
            ...this._bindingArgs(scoped),
            fetch.tokenHash,
            String(this._limits.uploadLeaseTtlMs),
            String(this._limits.logicalTtlMs),
            envelopeText,
            String(this._limits.artifactParts),
            String(this._limits.artifactBytes),
          ]
        ),
        "subtitleBeginFetch"
      );
      const status = asString(reply[0], "subtitle begin fetch status");
      if (status === "changed") continue;
      if (status === "not_found") return null;
      if (status === "fetch_busy" || status === "fetch_conflict") throw stateError(status);
      if ((status !== "fetching" && status !== "replay") || reply.length !== 6) {
        throw stateError(status);
      }
      const schemaVersion = asInteger(reply[5], "subtitle artifact schema version");
      if (schemaVersion !== 3) throw stateError("state_collision");
      return {
        status: "fetching",
        replay: status === "replay",
        artifactId: asString(reply[1], "subtitle artifact id"),
        expiresAt: safeReplyInteger(reply[2], "subtitle artifact expiry"),
        fetchExpiresAt: safeReplyInteger(reply[3], "subtitle fetch expiry"),
        fetchFence: decimalReply(reply[4], "subtitle fetch fence"),
        fetchToken: fetch.token,
        sourceCapability,
        schemaVersion,
        partMetadataVersion: null,
        parts: [],
      };
    }
    throw codedError("subtitle_fetch_changed", "subtitle source capability changed during fetch begin");
  }

  async releaseFetch(artifactId, fetchToken) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle fetch release")
      : { artifactId, fetchToken };
    const id = assertScopedIdentifier(input.artifactId, "subtitle artifact id");
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("subtitle-fetch", input.fetchToken);
    } catch (_error) {
      return null;
    }
    const artifact = this._artifact(id);
    const reply = asArray(
      await this._scripts.run(
        "subtitleReleaseFetch",
        [...this._global, ...artifact.keys],
        [id, artifact.ref, tokenHash]
      ),
      "subtitleReleaseFetch"
    );
    const status = asString(reply[0], "subtitle fetch release status");
    if (status === "not_found") return null;
    if (status !== "released" || reply.length !== 3) throw stateError(status);
    return {
      status,
      artifactId: asString(reply[1], "subtitle artifact id"),
      fetchFence: decimalReply(reply[2], "subtitle fetch fence"),
      state: "reserved",
    };
  }

  async stageUpload(artifactId, binding, parts) {
    const input = callObject(artifactId, binding, parts === undefined ? {} : { parts });
    const scoped = this._boundArtifact(input);
    let fetchTokenHash;
    try {
      fetchTokenHash = this._tokens.hashToken("subtitle-fetch", input.fetchToken);
    } catch (_error) {
      return null;
    }
    let upload;
    if (input.uploadToken === undefined) upload = this._tokens.issue("subtitle-upload", 32);
    else {
      upload = {
        token: input.uploadToken,
        tokenHash: this._tokens.hashToken("subtitle-upload", input.uploadToken),
      };
    }
    const normalized = normalizeStageParts(
      input.parts,
      this._limits.artifactParts,
      this._limits.artifactBytes
    );
    const attemptRef = this._keys.member(
      "subtitle-upload-attempt",
      scoped.artifact.ref,
      fetchTokenHash,
      upload.tokenHash
    );
    const staged = normalized.parts.map((part) => ({
      ...part,
      objectKey: this._objectKey(scoped.artifact.ref, attemptRef, part.partNumber),
    }));
    const second = staged[1] || null;
    const reply = asArray(
      await this._scripts.run(
        "subtitleStageUpload",
        [...this._global, ...this._profileKeys(scoped.profileId), ...scoped.artifact.keys, ...this._playbackKeys(scoped)],
        [
          ...this._bindingArgs(scoped),
          fetchTokenHash,
          upload.tokenHash,
          attemptRef,
          String(staged.length),
          String(PART_METADATA_VERSION),
          staged[0].objectKey,
          String(staged[0].sizeBytes),
          staged[0].checksum,
          staged[0].role,
          staged[0].extension,
          staged[0].mediaType,
          second ? second.objectKey : "",
          second ? String(second.sizeBytes) : "",
          second ? second.checksum : "",
          second ? second.role : "",
          second ? second.extension : "",
          second ? second.mediaType : "",
          String(this._limits.uploadLeaseTtlMs),
          String(this._limits.maxPutLifetimeMs),
          String(this._limits.uploadSettlementGraceMs),
          String(this._limits.logicalTtlMs),
        ]
      ),
      "subtitleStageUpload"
    );
    const status = asString(reply[0], "subtitle stage upload status");
    if (status === "not_found") return null;
    if (status === "stage_conflict" || status === "invalid_parts" || status === "artifact_too_large") {
      throw stateError(status);
    }
    if (status !== "uploading" && status !== "replay" && status !== "aborting") {
      throw stateError(status);
    }
    const stored = parseStoredParts(reply, 5, this._limits.artifactParts, this._objectKeys);
    return {
      status: status === "aborting" ? status : "uploading",
      replay: status === "replay",
      artifactId: asString(reply[1], "subtitle artifact id"),
      expiresAt: safeReplyInteger(reply[2], "subtitle artifact expiry"),
      uploadExpiresAt: safeReplyInteger(reply[3], "subtitle upload expiry"),
      uploadSettlementDeadline: safeReplyInteger(
        reply[4],
        "subtitle upload settlement deadline"
      ),
      uploadToken: upload.token,
      sizeBytes: normalized.total,
      ...stored,
    };
  }

  async beginUpload(artifactId, binding, partCount) {
    const input = callObject(artifactId, binding, partCount === undefined ? {} : { partCount });
    const scoped = this._boundArtifact(input);
    const count = assertPositiveInteger(input.partCount, "subtitle part count", this._limits.artifactParts);
    let upload;
    if (input.uploadToken === undefined) upload = this._tokens.issue("subtitle-upload", 32);
    else {
      upload = {
        token: input.uploadToken,
        tokenHash: this._tokens.hashToken("subtitle-upload", input.uploadToken),
      };
    }
    const attemptRef = this._keys.member(
      "subtitle-upload-attempt",
      scoped.artifact.ref,
      upload.tokenHash
    );
    const objectKeys = Array.from({ length: count }, (_value, index) =>
      this._objectKey(scoped.artifact.ref, attemptRef, index + 1)
    );

    for (let attempt = 0; attempt < MAX_BEGIN_RETRIES; attempt += 1) {
      const peek = asArray(
        await this._scripts.run(
          "subtitleBeginUploadPeek",
          [...this._global, ...scoped.artifact.keys, ...this._playbackKeys(scoped)],
          [...this._bindingArgs(scoped), upload.tokenHash]
        ),
        "subtitleBeginUploadPeek"
      );
      const peekStatus = asString(peek[0], "subtitle begin upload peek status");
      if (peekStatus === "not_found") return null;
      if (peekStatus === "upload_busy") throw stateError(peekStatus);
      if (peekStatus === "aborting") {
        return {
          status: "aborting",
          artifactId: asString(peek[1], "subtitle artifact id"),
          uploadExpiresAt: safeReplyInteger(peek[2], "subtitle upload expiry"),
          uploadToken: upload.token,
          sourceCapability: null,
          schemaVersion: 2,
          partMetadataVersion: null,
          parts: parseUploadParts(peek, 3, this._limits.artifactParts, this._objectKeys),
        };
      }
      if (peekStatus === "committed") {
        const stored = parseStoredParts(peek, 3, this._limits.artifactParts, this._objectKeys);
        return {
          status: "committed",
          artifactId: asString(peek[1], "subtitle artifact id"),
          expiresAt: safeReplyInteger(peek[2], "subtitle artifact expiry"),
          uploadToken: null,
          sourceCapability: null,
          ...stored,
        };
      }
      if (peekStatus !== "ready" && peekStatus !== "replay") throw stateError(peekStatus);
      const envelopeOffset = peekStatus === "ready" ? 3 : 4;
      const envelopeText = asString(peek[envelopeOffset], "subtitle source envelope");
      const sourceCapability = this._decryptSourceCapability(
        envelopeText,
        scoped.profileTag,
        scoped.artifact.ref
      );
      const reply = asArray(
        await this._scripts.run(
          "subtitleBeginUpload",
          [...this._global, ...scoped.artifact.keys, ...this._playbackKeys(scoped)],
          [
            ...this._bindingArgs(scoped),
            String(count),
            upload.tokenHash,
            attemptRef,
            String(this._limits.uploadLeaseTtlMs),
            String(this._limits.maxPutLifetimeMs),
            String(this._limits.uploadSettlementGraceMs),
            String(this._limits.logicalTtlMs),
            envelopeText,
            objectKeys[0],
            objectKeys[1] || "",
          ]
        ),
        "subtitleBeginUpload"
      );
      const status = asString(reply[0], "subtitle begin upload status");
      if (status === "changed") continue;
      if (status === "not_found") return null;
      if (status === "upload_busy") throw stateError(status);
      if (status === "aborting") {
        return {
          status,
          artifactId: asString(reply[1], "subtitle artifact id"),
          uploadExpiresAt: safeReplyInteger(reply[2], "subtitle upload expiry"),
          uploadToken: upload.token,
          sourceCapability: null,
          schemaVersion: 2,
          partMetadataVersion: null,
          parts: parseUploadParts(reply, 3, this._limits.artifactParts, this._objectKeys),
        };
      }
      if (status !== "uploading" && status !== "replay") throw stateError(status);
        return {
          status: "uploading",
          replay: status === "replay",
          artifactId: asString(reply[1], "subtitle artifact id"),
          expiresAt: safeReplyInteger(reply[2], "subtitle artifact expiry"),
          uploadExpiresAt: safeReplyInteger(reply[3], "subtitle upload expiry"),
          uploadToken: upload.token,
          sourceCapability,
          schemaVersion: 2,
          partMetadataVersion: null,
          parts: parseUploadParts(reply, 4, this._limits.artifactParts, this._objectKeys),
        };
    }
    throw codedError("subtitle_upload_changed", "subtitle source capability changed during upload begin");
  }

  async abortUpload(artifactId, uploadToken) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle upload abort")
      : { artifactId, uploadToken };
    const id = assertScopedIdentifier(input.artifactId, "subtitle artifact id");
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("subtitle-upload", input.uploadToken);
    } catch (_error) {
      return null;
    }
    const artifact = this._artifact(id);
    const reply = asArray(
      await this._scripts.run(
        "subtitleAbortUpload",
        [...this._global, ...artifact.keys],
        [id, artifact.ref, tokenHash]
      ),
      "subtitleAbortUpload"
    );
    const status = asString(reply[0], "subtitle upload abort status");
    if (status === "not_found" || status === "complete") return null;
    if (status !== "aborted") throw stateError(status);
    const stored = parseStoredParts(reply, 2, this._limits.artifactParts, this._objectKeys);
    return {
      status,
      artifactId: asString(reply[1], "subtitle artifact id"),
      ...stored,
    };
  }

  async commit(artifactId, binding, parts) {
    const input = callObject(artifactId, binding, parts === undefined ? {} : { parts });
    const scoped = this._boundArtifact(input);
    let uploadTokenHash;
    try {
      uploadTokenHash = this._tokens.hashToken("subtitle-upload", input.uploadToken);
    } catch (_error) {
      return null;
    }
    if (input.receipts !== undefined && input.parts !== undefined) {
      throw new TypeError("subtitle commit accepts receipts or legacy parts, not both");
    }
    const receiptMode = input.receipts !== undefined;
    const values = receiptMode ? input.receipts : input.parts;
    if (!Array.isArray(values) || values.length < 1 || values.length > this._limits.artifactParts) {
      throw new TypeError("subtitle commit parts are invalid");
    }
    const normalized = receiptMode
      ? values.map((part, index) => normalizeReceipt(
          part,
          index,
          this._limits.artifactBytes,
          this._objectKeys
        ))
      : values.map((part, index) => normalizeLegacyPart(
          part,
          index,
          this._limits.artifactBytes
        ));
    const total = normalized.reduce((sum, part) => sum + part.sizeBytes, 0);
    if (!Number.isSafeInteger(total) || total > this._limits.artifactBytes) {
      throw stateError("artifact_too_large");
    }
    const second = normalized[1] || null;
    const reply = asArray(
      await this._scripts.run(
        "subtitleCommit",
        [...this._global, ...scoped.artifact.keys, ...this._playbackKeys(scoped)],
        [
          ...this._bindingArgs(scoped),
          uploadTokenHash,
          receiptMode ? "receipt" : "legacy",
          String(normalized.length),
          receiptMode ? normalized[0].objectKey : "",
          String(normalized[0].sizeBytes),
          normalized[0].checksum,
          receiptMode ? normalized[0].mediaType : "",
          receiptMode && second ? second.objectKey : "",
          second ? String(second.sizeBytes) : "",
          second ? second.checksum : "",
          receiptMode && second ? second.mediaType : "",
          String(this._limits.artifactBytes),
          String(this._limits.logicalTtlMs),
        ]
      ),
      "subtitleCommit"
    );
    const status = asString(reply[0], "subtitle commit status");
    if (status === "not_found" || status === "aborted") return null;
    if (status !== "committed" && status !== "replay") throw stateError(status);
    const stored = parseStoredParts(reply, 4, this._limits.artifactParts, this._objectKeys);
    return {
      status: "committed",
      replay: status === "replay",
      artifactId: asString(reply[1], "subtitle artifact id"),
      expiresAt: safeReplyInteger(reply[2], "subtitle artifact expiry"),
      sizeBytes: safeReplyInteger(reply[3], "subtitle artifact size"),
      ...stored,
    };
  }

  async authorize(artifactId, binding, method) {
    const input = callObject(artifactId, binding, method === undefined ? {} : { method });
    const scoped = this._boundArtifact(input);
    const requestMethod = String(input.method || "GET").toUpperCase();
    if (requestMethod !== "GET" && requestMethod !== "HEAD") {
      throw new TypeError("subtitle delivery method is invalid");
    }
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const lease = this._tokens.issue("subtitle-lease", 24);
      const leaseMember = this._keys.member("subtitle-lease", scoped.artifact.ref, lease.tokenHash);
      const reply = asArray(
        await this._scripts.run(
          "subtitleAuthorize",
          [
            ...this._global,
            ...this._profileKeys(scoped.profileId),
            ...scoped.artifact.keys,
            ...this._playbackKeys(scoped),
          ],
          [
            ...this._bindingArgs(scoped),
            requestMethod,
            lease.tokenHash,
            leaseMember,
            String(this._limits.ioLeaseTtlMs),
            String(this._limits.logicalTtlMs),
            String(this._limits.profileLeases),
            String(this._limits.globalLeases),
            String(this._limits.leaseCleanupBatchSize),
          ]
        ),
        "subtitleAuthorize"
      );
      const status = asString(reply[0], "subtitle authorize status");
      if (status === "lease_collision") continue;
      if (status === "not_found") return null;
      if (status === "profile_lease_capacity") throw capacityError("profile", "I/O lease limit");
      if (status === "global_lease_capacity") throw capacityError("global", "I/O lease limit");
      if (status !== "authorized") throw stateError(status);
      const stored = parseStoredParts(reply, 5, this._limits.artifactParts, this._objectKeys);
      return {
        status,
        artifactId: asString(reply[1], "subtitle artifact id"),
        expiresAt: safeReplyInteger(reply[2], "subtitle artifact expiry"),
        leaseExpiresAt: safeReplyInteger(reply[3], "subtitle lease expiry"),
        method: asString(reply[4], "subtitle delivery method"),
        leaseToken: lease.token,
        ...stored,
      };
    }
    throw codedError("subtitle_lease_collision", "could not allocate a unique subtitle I/O lease");
  }

  async revalidate(artifactId, binding, leaseToken) {
    const input = callObject(artifactId, binding, leaseToken === undefined ? {} : { leaseToken });
    const scoped = this._boundArtifact(input);
    let leaseHash;
    try {
      leaseHash = this._tokens.hashToken("subtitle-lease", input.leaseToken);
    } catch (_error) {
      return null;
    }
    const reply = asArray(
      await this._scripts.run(
        "subtitleRevalidate",
        [
          ...this._global,
          ...this._profileKeys(scoped.profileId),
          ...scoped.artifact.keys,
          ...this._playbackKeys(scoped),
        ],
        [
          ...this._bindingArgs(scoped),
          leaseHash,
          String(this._limits.logicalTtlMs),
          String(this._limits.leaseCleanupBatchSize),
        ]
      ),
      "subtitleRevalidate"
    );
    const status = asString(reply[0], "subtitle revalidate status");
    if (status === "not_found") return null;
    if (status !== "revalidated") throw stateError(status);
    const stored = parseStoredParts(reply, 5, this._limits.artifactParts, this._objectKeys);
    return {
      status,
      artifactId: asString(reply[1], "subtitle artifact id"),
      expiresAt: safeReplyInteger(reply[2], "subtitle artifact expiry"),
      leaseExpiresAt: safeReplyInteger(reply[3], "subtitle lease expiry"),
      method: asString(reply[4], "subtitle delivery method"),
      ...stored,
    };
  }

  async releaseLease(artifactId, leaseToken) {
    const id = assertScopedIdentifier(
      artifactId && typeof artifactId === "object" ? artifactId.artifactId : artifactId,
      "subtitle artifact id"
    );
    const token = artifactId && typeof artifactId === "object" ? artifactId.leaseToken : leaseToken;
    let leaseHash;
    try {
      leaseHash = this._tokens.hashToken("subtitle-lease", token);
    } catch (_error) {
      return false;
    }
    const artifact = this._artifact(id);
    const reply = asArray(
      await this._scripts.run(
        "subtitleReleaseLease",
        [...this._global, ...artifact.keys],
        [id, artifact.ref, leaseHash, String(this._limits.leaseCleanupBatchSize)]
      ),
      "subtitleReleaseLease"
    );
    const status = asString(reply[0], "subtitle release lease status");
    if (status === "not_found") return false;
    if (status !== "released") throw stateError(status);
    return true;
  }

  async invalidateRelease(profileId, deviceId, sessionId) {
    if (profileId && typeof profileId === "object") {
      return this._invalidate("release", assertPlainObject(profileId, "subtitle invalidation"));
    }
    return this._invalidate("release", { profileId, deviceId, sessionId });
  }

  async invalidateSession(profileId, sessionId) {
    if (profileId && typeof profileId === "object") {
      return this._invalidate("session", assertPlainObject(profileId, "subtitle invalidation"));
    }
    return this._invalidate("session", { profileId, sessionId });
  }

  async invalidateDevice(profileId, deviceId) {
    if (profileId && typeof profileId === "object") {
      return this._invalidate("device", assertPlainObject(profileId, "subtitle invalidation"));
    }
    return this._invalidate("device", { profileId, deviceId });
  }

  async invalidateProfile(profileId) {
    if (profileId && typeof profileId === "object") {
      return this._invalidate("profile", assertPlainObject(profileId, "subtitle invalidation"));
    }
    return this._invalidate("profile", { profileId });
  }

  async claimDeletion(workerId, options = {}) {
    let worker = workerId;
    let supplied = options;
    if (workerId && typeof workerId === "object") {
      supplied = assertPlainObject(workerId, "subtitle deletion claim");
      worker = supplied.workerId;
    }
    const safeOptions = assertPlainObject(supplied || {}, "subtitle deletion claim options");
    const workerRef = this._keys.member(
      "subtitle-deletion-worker",
      assertScopedIdentifier(worker, "subtitle deletion worker id")
    );
    const leaseTtlMs = safeOptions.leaseTtlMs === undefined
      ? this._limits.deletionLeaseTtlMs
      : assertPositiveInteger(
          safeOptions.leaseTtlMs,
          "subtitle deletion lease ttl",
          this._limits.maxDeletionRetryMs
        );
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const token = this._tokens.issue("subtitle-deletion", 24);
      const reply = asArray(
        await this._scripts.run(
          "subtitleClaimDeletion",
          this._global,
          [
            token.tokenHash,
            workerRef,
            String(leaseTtlMs),
            String(this._limits.deletionScanBatchSize),
            String(this._limits.leaseCleanupBatchSize),
          ]
        ),
        "subtitleClaimDeletion"
      );
      const status = asString(reply[0], "subtitle deletion claim status");
      if (status === "token_collision") continue;
      if (status === "empty") return null;
      if (status !== "claimed") throw stateError(status);
      const stored = parseStoredParts(reply, 6, this._limits.artifactParts, this._objectKeys);
      return {
        status,
        artifactId: asString(reply[1], "subtitle artifact id"),
        artifactRef: asString(reply[2], "subtitle artifact ref"),
        attempt: decimalReply(reply[3], "subtitle deletion attempt"),
        leaseExpiresAt: safeReplyInteger(reply[4], "subtitle deletion lease expiry"),
        phase: asString(reply[5], "subtitle deletion phase"),
        deletionToken: token.token,
        ...stored,
      };
    }
    throw codedError(
      "subtitle_deletion_token_collision",
      "could not allocate a unique subtitle deletion token"
    );
  }

  async recordDeletionAbsence(artifactId, deletionToken, verifiedAbsent) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle deletion absence")
      : { artifactId, deletionToken, verifiedAbsent };
    if (input.verifiedAbsent !== true) {
      throw new TypeError("subtitle deletion absence must be verified");
    }
    const id = assertScopedIdentifier(input.artifactId, "subtitle artifact id");
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("subtitle-deletion", input.deletionToken);
    } catch (_error) {
      return null;
    }
    const artifact = this._artifact(id);
    const reply = asArray(
      await this._scripts.run(
        "subtitleRecordDeletionAbsence",
        [...this._global, artifact.keys[0]],
        [
          id,
          artifact.ref,
          tokenHash,
          String(this._limits.uploadSettlementGraceMs),
        ]
      ),
      "subtitleRecordDeletionAbsence"
    );
    const status = asString(reply[0], "subtitle deletion absence status");
    if (status === "not_found") return null;
    if (status === "upload_barrier" || status === "deletion_barrier") throw stateError(status);
    if (status !== "awaiting_second_pass") throw stateError(status);
    return {
      status,
      retryAt: safeReplyInteger(reply[1], "subtitle second deletion pass time"),
    };
  }

  async retryDeletion(artifactId, deletionToken, retryDelayMs) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle deletion retry")
      : { artifactId, deletionToken, retryDelayMs };
    const id = assertScopedIdentifier(input.artifactId, "subtitle artifact id");
    const delay = assertPositiveInteger(
      input.retryDelayMs,
      "subtitle deletion retry delay",
      this._limits.maxDeletionRetryMs
    );
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("subtitle-deletion", input.deletionToken);
    } catch (_error) {
      return null;
    }
    const artifact = this._artifact(id);
    const reply = asArray(
      await this._scripts.run(
        "subtitleRetryDeletion",
        [...this._global, artifact.keys[0]],
        [id, artifact.ref, tokenHash, String(delay)]
      ),
      "subtitleRetryDeletion"
    );
    const status = asString(reply[0], "subtitle deletion retry status");
    if (status === "not_found") return null;
    if (status !== "retrying") throw stateError(status);
    return {
      status,
      attempt: decimalReply(reply[1], "subtitle deletion attempt"),
      retryAt: safeReplyInteger(reply[2], "subtitle deletion retry time"),
    };
  }

  async confirmDeletion(artifactId, deletionToken, verifiedAbsent) {
    const input = artifactId && typeof artifactId === "object"
      ? assertPlainObject(artifactId, "subtitle deletion confirmation")
      : { artifactId, deletionToken, verifiedAbsent };
    if (input.verifiedAbsent !== true) {
      throw new TypeError("subtitle deletion confirmation requires verified absence");
    }
    const id = assertScopedIdentifier(input.artifactId, "subtitle artifact id");
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("subtitle-deletion", input.deletionToken);
    } catch (_error) {
      return null;
    }
    const artifact = this._artifact(id);
    const reply = asArray(
      await this._scripts.run(
        "subtitleConfirmDeletion",
        [...this._global, ...artifact.keys],
        [id, artifact.ref, tokenHash, String(this._limits.leaseCleanupBatchSize)]
      ),
      "subtitleConfirmDeletion"
    );
    const status = asString(reply[0], "subtitle deletion confirmation status");
    if (status === "not_found") return null;
    if (
      status === "upload_barrier" ||
      status === "deletion_barrier" ||
      status === "lease_busy"
    ) throw stateError(status);
    if (status !== "confirmed") throw stateError(status);
    return {
      status,
      released: {
        artifacts: safeReplyInteger(reply[1], "released subtitle artifact quota"),
        objects: safeReplyInteger(reply[2], "released subtitle object quota"),
        bytes: safeReplyInteger(reply[3], "released subtitle byte quota"),
      },
    };
  }

  async prune() {
    const reply = asArray(
      await this._scripts.run(
        "subtitlePrune",
        this._global,
        [
          String(this._limits.pruneBatchSize),
          String(this._limits.deletionScanBatchSize),
          String(this._limits.leaseCleanupBatchSize),
          String(this._limits.uploadCleanupBatchSize),
        ]
      ),
      "subtitlePrune"
    );
    const status = asString(reply[0], "subtitle prune status");
    if (status !== "pruned") throw stateError(status);
    const continuation = asString(reply[5], "subtitle prune continuation");
    if (continuation !== "0" && continuation !== "1") {
      throw new TypeError("Redis subtitle prune continuation is invalid");
    }
    return {
      artifacts: asInteger(reply[1], "pruned subtitle artifacts"),
      deletionClaims: asInteger(reply[2], "reset subtitle deletion claims"),
      leases: asInteger(reply[3], "pruned subtitle leases"),
      uploads: asInteger(reply[4], "pruned subtitle uploads"),
      hasMore: continuation === "1",
    };
  }

  reserveArtifact(...args) {
    return this.reserve(...args);
  }

  commitUpload(...args) {
    return this.commit(...args);
  }

  authorizeRead(...args) {
    return this.authorize(...args);
  }

  revalidateRead(...args) {
    return this.revalidate(...args);
  }

  claimDeletionJob(...args) {
    return this.claimDeletion(...args);
  }

  retryDeletionJob(...args) {
    return this.retryDeletion(...args);
  }

  recordDeletionAbsenceJob(...args) {
    return this.recordDeletionAbsence(...args);
  }

  confirmDeletionJob(...args) {
    return this.confirmDeletion(...args);
  }

  async _invalidate(mode, input) {
    const profileId = assertScopedIdentifier(input.profileId, "profile id");
    const profileTag = this._keys.member("playback-profile", profileId);
    const deviceRef = mode === "release" || mode === "device"
      ? this._keys.member(
          "playback-device",
          profileId,
          assertScopedIdentifier(input.deviceId, "device id")
        )
      : "";
    const sessionRef = mode === "release" || mode === "session"
      ? this._keys.member(
          "subtitle-session",
          profileId,
          assertScopedIdentifier(input.sessionId, "session id")
        )
      : "";
    const reply = asArray(
      await this._scripts.run(
        "subtitleInvalidate",
        [...this._global, ...this._profileKeys(profileId)],
        [profileTag, mode, deviceRef, sessionRef, String(this._limits.profileArtifacts)]
      ),
      "subtitleInvalidate"
    );
    const status = asString(reply[0], "subtitle invalidation status");
    if (status !== "invalidated") throw stateError(status);
    return asInteger(reply[1], "invalidated subtitle artifact count");
  }

  _binding(input) {
    const request = assertPlainObject(input, "subtitle delivery binding");
    const profileId = assertScopedIdentifier(request.profileId, "profile id");
    const deviceId = assertScopedIdentifier(request.deviceId, "device id");
    const sessionId = assertScopedIdentifier(request.sessionId, "session id");
    const generation = assertGeneration(request.generation);
    const contextId = assertScopedIdentifier(request.contextId, "context id");
    const contextRevision = decimalString(request.contextRevision, "context revision");
    const providerRevision = decimalString(request.providerRevision, "provider revision");
    return {
      profileId,
      deviceId,
      sessionId,
      generation,
      contextId,
      contextRevision,
      providerRevision,
      profileTag: this._keys.member("playback-profile", profileId),
      deviceRef: this._keys.member("playback-device", profileId, deviceId),
      sessionRef: this._keys.member("subtitle-session", profileId, sessionId),
      contextRef: this._keys.member("playback-context", profileId, contextId),
    };
  }

  _boundArtifact(input) {
    const binding = this._binding(input);
    const artifactId = assertScopedIdentifier(input.artifactId, "subtitle artifact id");
    return { ...binding, artifactId, artifact: this._artifact(artifactId) };
  }

  _bindingArgs(scoped) {
    return [
      scoped.profileTag,
      scoped.artifactId,
      scoped.artifact.ref,
      scoped.deviceRef,
      scoped.sessionId,
      scoped.sessionRef,
      scoped.generation,
      scoped.contextRef,
      scoped.contextRevision,
      scoped.providerRevision,
    ];
  }

  _nextArtifactId() {
    const value = this._idFactory
      ? this._idFactory("subtitle-artifact")
      : this._tokens.issue("subtitle-artifact", 32).token;
    return assertScopedIdentifier(value, "subtitle artifact id");
  }

  _artifact(artifactId) {
    const ref = this._keys.member("subtitle-artifact", artifactId);
    return {
      ref,
      keys: [
        this._keys.key("subtitle-artifact-v2", artifactId),
        this._keys.key("subtitle-artifact-lease-data", artifactId),
        this._keys.key("subtitle-artifact-lease-expiries", artifactId),
      ],
    };
  }

  _objectKey(artifactRef, attemptRef, partNumber) {
    const factory = this._requireObjectKeys();
    return factory.assert(
      factory.create([
        "subtitle-staging-v1",
        artifactRef,
        attemptRef,
        String(partNumber),
      ])
    );
  }

  _requireObjectKeys() {
    if (!(this._objectKeys instanceof OpaqueObjectKeyFactory)) {
      throw new TypeError("objectKeyFactory is required for subtitle delivery");
    }
    return this._objectKeys;
  }

  _sourcePurpose(profileTag, artifactRef) {
    return "subtitle-source:" + this._keys.member("subtitle-source-purpose", profileTag, artifactRef);
  }

  _sourceCapabilityDigest(sourceCapability, profileTag, artifactRef) {
    const authenticated = JSON.stringify([1, profileTag, artifactRef, sourceCapability]);
    return this._tokens.hashOpaque(
      "subtitle-source-capability",
      authenticated,
      this._limits.sourceCapabilityBytes + 1024
    );
  }

  _decryptSourceCapability(envelopeText, profileTag, artifactRef) {
    const envelope = parseEnvelope(envelopeText, this._limits.sourceEnvelopeBytes);
    const decrypted = this._crypto.decryptJson(
      envelope,
      this._sourcePurpose(profileTag, artifactRef)
    );
    const value = assertPlainObject(decrypted, "decrypted subtitle source capability");
    if (value.v !== 1) throw new TypeError("decrypted subtitle source capability version is invalid");
    const normalized = normalizeSourceCapability(
      { url: value.url, headers: value.headers },
      this._limits.sourceCapabilityBytes
    );
    if (JSON.stringify(value) !== JSON.stringify(normalized)) {
      throw new TypeError("decrypted subtitle source capability is not canonical");
    }
    return normalized;
  }

  _profileKeys(profileId) {
    return [
      this._keys.key("subtitle-profile-v2", profileId),
      this._keys.key("subtitle-profile-artifacts", profileId),
      this._keys.key("subtitle-profile-discoveries", profileId),
    ];
  }

  _playbackKeys(binding) {
    return [
      this._keys.key("playback-profile-v3", binding.profileId),
      this._keys.key("playback-context-data", binding.profileId),
      this._keys.key("playback-claim-data", binding.profileId),
      this._keys.key("playback-session", binding.sessionId),
      this._keys.key("playback-profile-generation", binding.profileId),
    ];
  }
}

module.exports = {
  DEFAULT_SUBTITLE_DELIVERY_LIMITS: DEFAULT_LIMITS,
  RedisSubtitleDeliveryRepository,
};
