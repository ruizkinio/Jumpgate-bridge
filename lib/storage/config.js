"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const OBJECT_KEY_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const POSTGRES_MIGRATION_VERSION_PATTERN = /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const STORAGE_DRIVERS = new Set(["memory", "postgres", "sqlite"]);
const TTL_DRIVERS = new Set(["memory", "redis"]);
const PROVIDER_MUTATION_MODES = new Set(["legacy", "fenced"]);
const REDIS_PLAYBACK_WRITE_VERSIONS = new Set(["3", "4"]);
const SUBTITLE_S3_PRIVACY_MODES = new Set(["strict", "tigris-policy-status"]);
const SUBTITLE_PERMANENT_ERASURE_MODES = new Set([
  "blocked-tigris-provider-confirmation-required",
  "tigris-version-purge-v1",
]);
const SUBTITLE_S3_ENDPOINTS = new Set([
  "https://t3.storage.dev",
  "https://fly.storage.tigris.dev",
]);
const SUBTITLE_S3_FIELDS = new Set([
  "accessKeyId",
  "bucket",
  "endpoint",
  "forcePathStyle",
  "permanentErasureMode",
  "privacyMode",
  "region",
  "secretAccessKey",
]);
const SUBTITLE_OBJECT_KEY_FIELDS = new Set(["currentKeyId", "keyring"]);
const SUBTITLE_OBJECT_KEYRING_FIELDS = new Set(["id", "secret"]);

function readEnum(env, name, fallback, allowed) {
  const value = String(env[name] || fallback).trim().toLowerCase();
  if (!allowed.has(value)) throw new TypeError(name + " is invalid");
  return value;
}

function readRequired(env, name) {
  const value = env[name];
  if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(name + " is required");
  }
  return value;
}

function readExactEnum(env, name, fallback, allowed, options = {}) {
  const configured = env[name];
  if (configured === undefined || configured === null || configured === "") {
    if (options.required === true) throw new TypeError(name + " is required");
    return fallback;
  }
  if (typeof configured !== "string" || configured.trim() !== configured || !allowed.has(configured)) {
    throw new TypeError(name + " is invalid");
  }
  return configured;
}

function readOptional(env, name) {
  const value = env[name];
  if (value === undefined || value === null || value === "") return null;
  return readRequired(env, name);
}

function readBooleanFlag(env, name, fallback = false) {
  const value = env[name];
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "0") return false;
  if (value === "1") return true;
  throw new TypeError(name + " must be 0 or 1");
}

function decodeSecret(value, name, minimumBytes = 32, maximumBytes = 64) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new TypeError(name + " must be canonical base64 or base64url");
  }

  const unpadded = value.replace(/=+$/, "");
  const isBase64Url = /^[A-Za-z0-9_-]+={0,2}$/.test(value);
  const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  if (!isBase64Url && !isBase64) {
    throw new TypeError(name + " must be canonical base64 or base64url");
  }

  const encoding = isBase64Url && /[-_]/.test(value) ? "base64url" : "base64";
  const decoded = Buffer.from(value, encoding);
  const canonical = decoded.toString(encoding).replace(/=+$/, "");
  if (canonical !== unpadded || decoded.length < minimumBytes || decoded.length > maximumBytes) {
    decoded.fill(0);
    throw new TypeError(name + " has an invalid encoding or length");
  }
  return decoded;
}

function parseKeyring(value) {
  let entries;
  try {
    entries = JSON.parse(value);
  } catch (_error) {
    throw new TypeError("JUMPGATE_ENVELOPE_KEYRING must be valid JSON");
  }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) {
    throw new TypeError("JUMPGATE_ENVELOPE_KEYRING must contain 1 to 8 keys");
  }

  const keys = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("JUMPGATE_ENVELOPE_KEYRING contains an invalid entry");
    }
    const fields = Object.keys(entry).sort();
    if (fields.length !== 2 || fields[0] !== "id" || fields[1] !== "key") {
      throw new TypeError("JUMPGATE_ENVELOPE_KEYRING entries require only id and key");
    }
    const keyId = String(entry.id || "");
    if (!KEY_ID_PATTERN.test(keyId) || keys.has(keyId)) {
      throw new TypeError("JUMPGATE_ENVELOPE_KEYRING contains an invalid or duplicate id");
    }
    keys.set(keyId, decodeSecret(entry.key, "envelope key " + keyId, 32, 32));
  }
  return keys;
}

function assertPlainObject(value, name, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " is invalid");
  }
  if (
    fields &&
    Reflect.ownKeys(value).some(
      (field) => typeof field !== "string" || !fields.has(field)
    )
  ) {
    throw new TypeError(name + " contains unsupported fields");
  }
  return value;
}

function assertSubtitleBucket(value, name = "subtitle S3 bucket") {
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
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertSubtitleRegion(value, name = "subtitle S3 region") {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertSubtitleEndpoint(value, name = "subtitle S3 endpoint") {
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
    (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
    !SUBTITLE_S3_ENDPOINTS.has(endpoint.origin)
  ) {
    throw new TypeError(name + " is invalid or untrusted");
  }
  return endpoint.origin;
}

function assertCredential(value, name, maximumLength) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertSubtitleS3Config(value, options = {}) {
  if (value === null || value === undefined) {
    if (options.required === true) throw new TypeError("subtitle S3 config is required");
    return null;
  }
  const config = assertPlainObject(value, "subtitle S3 config", SUBTITLE_S3_FIELDS);
  assertSubtitleBucket(config.bucket);
  assertSubtitleRegion(config.region);
  assertSubtitleEndpoint(config.endpoint);
  assertCredential(config.accessKeyId, "subtitle S3 access key id", 256);
  assertCredential(config.secretAccessKey, "subtitle S3 secret access key", 1024);
  if (typeof config.forcePathStyle !== "boolean") {
    throw new TypeError("subtitle S3 force-path-style flag is invalid");
  }
  if (!SUBTITLE_S3_PRIVACY_MODES.has(config.privacyMode)) {
    throw new TypeError("subtitle S3 privacy mode is invalid");
  }
  if (!SUBTITLE_PERMANENT_ERASURE_MODES.has(config.permanentErasureMode)) {
    throw new TypeError("subtitle S3 permanent erasure mode is invalid");
  }
  if (
    config.privacyMode === "tigris-policy-status" &&
    !SUBTITLE_S3_ENDPOINTS.has(config.endpoint)
  ) {
    throw new TypeError("subtitle S3 Tigris privacy mode requires a Tigris endpoint");
  }
  return config;
}

function assertSubtitleObjectKeyConfig(value, options = {}) {
  if (value === null || value === undefined) {
    if (options.required === true) {
      throw new TypeError("subtitle object key config is required");
    }
    return null;
  }
  const config = assertPlainObject(
    value,
    "subtitle object key config",
    SUBTITLE_OBJECT_KEY_FIELDS
  );
  if (
    typeof config.currentKeyId !== "string" ||
    !OBJECT_KEY_ID_PATTERN.test(config.currentKeyId)
  ) {
    throw new TypeError("subtitle object key current id is invalid");
  }
  if (!Array.isArray(config.keyring) || config.keyring.length < 1 || config.keyring.length > 8) {
    throw new TypeError("subtitle object key keyring is invalid");
  }
  const ids = new Set();
  for (const rawEntry of config.keyring) {
    const entry = assertPlainObject(
      rawEntry,
      "subtitle object key keyring entry",
      SUBTITLE_OBJECT_KEYRING_FIELDS
    );
    if (
      typeof entry.id !== "string" ||
      !OBJECT_KEY_ID_PATTERN.test(entry.id) ||
      ids.has(entry.id) ||
      (!Buffer.isBuffer(entry.secret) && !(entry.secret instanceof Uint8Array)) ||
      entry.secret.byteLength < 32 ||
      entry.secret.byteLength > 64
    ) {
      throw new TypeError("subtitle object key keyring is invalid");
    }
    ids.add(entry.id);
  }
  if (!ids.has(config.currentKeyId)) {
    throw new TypeError("subtitle object key current id is not present in the keyring");
  }
  return config;
}

function parseSubtitleObjectKeyring(value) {
  let entries;
  try {
    entries = JSON.parse(value);
  } catch (_error) {
    throw new TypeError("JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING must be valid JSON");
  }
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) {
    throw new TypeError("JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING must contain 1 to 8 keys");
  }

  const parsed = [];
  const ids = new Set();
  try {
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new TypeError("JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING contains an invalid entry");
      }
      const fields = Object.keys(entry).sort();
      if (fields.length !== 2 || fields[0] !== "id" || fields[1] !== "key") {
        throw new TypeError(
          "JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING entries require only id and key"
        );
      }
      if (
        typeof entry.id !== "string" ||
        !OBJECT_KEY_ID_PATTERN.test(entry.id) ||
        ids.has(entry.id)
      ) {
        throw new TypeError(
          "JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING contains an invalid or duplicate id"
        );
      }
      ids.add(entry.id);
      parsed.push({
        id: entry.id,
        secret: decodeSecret(
          entry.key,
          "subtitle object key " + entry.id,
          32,
          64
        ),
      });
    }
    return parsed;
  } catch (error) {
    for (const entry of parsed) entry.secret.fill(0);
    throw error;
  }
}

function loadSubtitleStorageConfig(env, required) {
  if (!required) return { subtitleS3: null, subtitleObjectKeys: null };

  const subtitleS3 = {
    bucket: assertSubtitleBucket(
      readRequired(env, "JUMPGATE_SUBTITLE_S3_BUCKET"),
      "JUMPGATE_SUBTITLE_S3_BUCKET"
    ),
    endpoint: assertSubtitleEndpoint(
      readRequired(env, "JUMPGATE_SUBTITLE_S3_ENDPOINT"),
      "JUMPGATE_SUBTITLE_S3_ENDPOINT"
    ),
    forcePathStyle: readBooleanFlag(env, "JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE"),
    permanentErasureMode: readExactEnum(
      env,
      "JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE",
      "blocked-tigris-provider-confirmation-required",
      SUBTITLE_PERMANENT_ERASURE_MODES
    ),
    privacyMode: readExactEnum(
      env,
      "JUMPGATE_SUBTITLE_S3_PRIVACY_MODE",
      "strict",
      SUBTITLE_S3_PRIVACY_MODES
    ),
    region: assertSubtitleRegion(
      readRequired(env, "JUMPGATE_SUBTITLE_S3_REGION"),
      "JUMPGATE_SUBTITLE_S3_REGION"
    ),
  };
  Object.defineProperties(subtitleS3, {
    accessKeyId: {
      value: assertCredential(
        readRequired(env, "JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID"),
        "JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID",
        256
      ),
    },
    secretAccessKey: {
      value: assertCredential(
        readRequired(env, "JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY"),
        "JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY",
        1024
      ),
    },
  });
  Object.freeze(subtitleS3);

  const currentKeyId = readRequired(env, "JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID");
  const keyring = parseSubtitleObjectKeyring(
    readRequired(env, "JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING")
  );
  if (!keyring.some((entry) => entry.id === currentKeyId)) {
    for (const entry of keyring) entry.secret.fill(0);
    throw new TypeError(
      "JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID is not present in the keyring"
    );
  }
  const subtitleObjectKeys = { currentKeyId };
  Object.defineProperty(subtitleObjectKeys, "keyring", {
    value: Object.freeze(keyring.map((entry) => Object.freeze(entry))),
  });
  Object.freeze(subtitleObjectKeys);

  assertSubtitleS3Config(subtitleS3, { required: true });
  assertSubtitleObjectKeyConfig(subtitleObjectKeys, { required: true });
  return { subtitleS3, subtitleObjectKeys };
}

function parseUrl(value, name, protocols) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new TypeError(name + " is invalid");
  }
  if (!protocols.has(parsed.protocol) || !parsed.hostname || parsed.hash) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertEnvironment(value, options = {}) {
  if (value === undefined && options.optional === true) return null;
  if (
    typeof value !== "string" ||
    value.trim().toLowerCase() !== value ||
    !ENVIRONMENT_PATTERN.test(value)
  ) {
    throw new TypeError("storage config environment is invalid");
  }
  return value;
}

function assertPersistentSqlitePath(value, name = "SQLite path", options = {}) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(name + " is invalid");
  }
  if (
    value === ":memory:" ||
    /^file:/i.test(value) ||
    /(?:^|[?&])mode=memory(?:&|$)/i.test(value)
  ) {
    throw new TypeError(name + " may not use :memory: or another in-memory SQLite target");
  }
  if (options.absolute === true && !path.isAbsolute(value)) {
    throw new TypeError(name + " must be an absolute persistent SQLite path");
  }
  return value;
}

function assertStorageTopology(environment, durableDriver, ttlDriver) {
  if (!STORAGE_DRIVERS.has(durableDriver)) {
    throw new TypeError("storage config durable driver is invalid");
  }
  if (!TTL_DRIVERS.has(ttlDriver)) {
    throw new TypeError("storage config TTL driver is invalid");
  }
  if (environment === "production" && (durableDriver !== "postgres" || ttlDriver !== "redis")) {
    throw new TypeError("production requires PostgreSQL durable storage and Redis TTL storage");
  }
  if (durableDriver === "memory" && environment !== "test") {
    throw new TypeError("memory durable storage is test-only");
  }
}

function assertProviderMutationMode(value) {
  if (typeof value !== "string" || !PROVIDER_MUTATION_MODES.has(value)) {
    throw new TypeError("storage config provider mutation mode is invalid");
  }
  return value;
}

function assertPostgresMigrationCeiling(value, options = {}) {
  if (value === null && options.required !== true) return null;
  if (typeof value !== "string" || !POSTGRES_MIGRATION_VERSION_PATTERN.test(value)) {
    throw new TypeError("storage config PostgreSQL migration ceiling is invalid");
  }
  return value;
}

function assertRedisPlaybackWriteVersion(value) {
  if (typeof value !== "string" || !REDIS_PLAYBACK_WRITE_VERSIONS.has(value)) {
    throw new TypeError("storage config Redis playback write version is invalid");
  }
  return value;
}

function loadSecurityConfig(env, options) {
  const tokenPepperValue = readOptional(env, "JUMPGATE_TOKEN_PEPPER");
  const keyringValue = readOptional(env, "JUMPGATE_ENVELOPE_KEYRING");
  const primaryKeyIdValue = readOptional(env, "JUMPGATE_ENVELOPE_PRIMARY_KEY_ID");
  const canUseEphemeral = options.environment === "test" && options.durableDriver === "memory";

  if (!tokenPepperValue && !keyringValue && !primaryKeyIdValue && canUseEphemeral) {
    return {
      tokenPepper: options.randomBytes(32),
      envelopeKeys: new Map([["test-ephemeral", options.randomBytes(32)]]),
      primaryEnvelopeKeyId: "test-ephemeral",
      ephemeral: true,
    };
  }

  if (!tokenPepperValue) throw new TypeError("JUMPGATE_TOKEN_PEPPER is required");
  if (!keyringValue) throw new TypeError("JUMPGATE_ENVELOPE_KEYRING is required");
  if (!primaryKeyIdValue) throw new TypeError("JUMPGATE_ENVELOPE_PRIMARY_KEY_ID is required");

  const envelopeKeys = parseKeyring(keyringValue);
  if (!envelopeKeys.has(primaryKeyIdValue)) {
    for (const key of envelopeKeys.values()) key.fill(0);
    throw new TypeError("JUMPGATE_ENVELOPE_PRIMARY_KEY_ID is not present in the keyring");
  }
  return {
    tokenPepper: decodeSecret(tokenPepperValue, "JUMPGATE_TOKEN_PEPPER"),
    envelopeKeys,
    primaryEnvelopeKeyId: primaryKeyIdValue,
    ephemeral: false,
  };
}

function loadStorageConfig(env = process.env, options = {}) {
  if (!env || typeof env !== "object") throw new TypeError("environment is required");
  const environment = String(env.NODE_ENV || "development").trim().toLowerCase();
  if (!ENVIRONMENT_PATTERN.test(environment)) throw new TypeError("NODE_ENV is invalid");

  const durableFallback = environment === "test" ? "memory" : environment === "production" ? "postgres" : "sqlite";
  const ttlFallback = environment === "production" ? "redis" : "memory";
  const durableDriver = readEnum(env, "JUMPGATE_DURABLE_DRIVER", durableFallback, STORAGE_DRIVERS);
  const ttlDriver = readEnum(env, "JUMPGATE_TTL_DRIVER", ttlFallback, TTL_DRIVERS);

  assertStorageTopology(environment, durableDriver, ttlDriver);

  const production = environment === "production";
  const providerMutationMode = readExactEnum(
    env,
    "JUMPGATE_PROVIDER_MUTATION_MODE",
    "fenced",
    PROVIDER_MUTATION_MODES,
    { required: production && durableDriver === "postgres" }
  );
  const configuredMigrationCeiling = readOptional(env, "JUMPGATE_POSTGRES_MIGRATION_CEILING");
  if (production && durableDriver === "postgres" && configuredMigrationCeiling === null) {
    throw new TypeError("JUMPGATE_POSTGRES_MIGRATION_CEILING is required");
  }
  const postgresMigrationCeiling = assertPostgresMigrationCeiling(
    configuredMigrationCeiling,
    { required: production && durableDriver === "postgres" }
  );
  const redisPlaybackWriteVersion = readExactEnum(
    env,
    "JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION",
    "4",
    REDIS_PLAYBACK_WRITE_VERSIONS,
    { required: production && ttlDriver === "redis" }
  );
  if (production && providerMutationMode !== "fenced") {
    throw new TypeError("production requires fenced provider mutation");
  }
  if (production && redisPlaybackWriteVersion !== "4") {
    throw new TypeError("production requires Redis playback write version 4");
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const databaseUrl =
    durableDriver === "postgres"
      ? parseUrl(readRequired(env, "DATABASE_URL"), "DATABASE_URL", new Set(["postgres:", "postgresql:"]))
      : null;
  const redisUrl =
    ttlDriver === "redis"
      ? parseUrl(readRequired(env, "REDIS_URL"), "REDIS_URL", new Set(["redis:", "rediss:"]))
      : null;
  const subtitleStorage = loadSubtitleStorageConfig(env, ttlDriver === "redis");

  let sqlitePath = null;
  if (durableDriver === "sqlite") {
    const configuredPath = readOptional(env, "JUMPGATE_SQLITE_PATH") || path.join(".data", "jumpgate.sqlite3");
    assertPersistentSqlitePath(configuredPath, "JUMPGATE_SQLITE_PATH");
    sqlitePath = path.resolve(cwd, configuredPath);
    assertPersistentSqlitePath(sqlitePath, "JUMPGATE_SQLITE_PATH", { absolute: true });
  }

  const randomBytes = options.randomBytes || crypto.randomBytes;
  if (typeof randomBytes !== "function") throw new TypeError("randomBytes must be a function");
  const security = loadSecurityConfig(env, { environment, durableDriver, randomBytes });

  return {
    environment,
    durableDriver,
    ttlDriver,
    databaseUrl,
    redisUrl,
    sqlitePath,
    providerMutationMode,
    postgresMigrationCeiling,
    redisPlaybackWriteVersion,
    subtitleS3: subtitleStorage.subtitleS3,
    subtitleObjectKeys: subtitleStorage.subtitleObjectKeys,
    tokenPepper: security.tokenPepper,
    envelopeKeys: security.envelopeKeys,
    primaryEnvelopeKeyId: security.primaryEnvelopeKeyId,
    ephemeralSecurityMaterial: security.ephemeral,
    legacyConfigSecret: readOptional(env, "CONFIG_SECRET"),
  };
}

module.exports = {
  assertEnvironment,
  assertPersistentSqlitePath,
  assertPostgresMigrationCeiling,
  assertProviderMutationMode,
  assertRedisPlaybackWriteVersion,
  assertSubtitleObjectKeyConfig,
  assertSubtitleS3Config,
  assertStorageTopology,
  decodeSecret,
  loadStorageConfig,
  parseUrl,
  parseKeyring,
  parseSubtitleObjectKeyring,
};
