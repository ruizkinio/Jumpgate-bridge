"use strict";

const { RedisLeaseRepository } = require("./lease-repository");
const { RedisManagementSessionRepository } = require("./management-session-repository");
const { RedisOAuthStateRepository } = require("./oauth-state-repository");
const { RedisPairingRepository } = require("./pairing-repository");
const { RedisPlaybackContextRepository } = require("./playback-context-repository");
const { RedisRateLimitRepository } = require("./rate-limit-repository");
const {
  DEFAULT_SUBTITLE_DELIVERY_LIMITS,
  RedisSubtitleDeliveryRepository,
} = require("./subtitle-delivery-repository");
const { RedisKeyspace, DEFAULT_KEY_PREFIX } = require("./keyspace");
const {
  RedisScriptRunner,
  assertStandalonePrimaryClient,
  isClusterClient,
  isNoScriptError,
} = require("./script-runner");
const { SCRIPT_DEFINITIONS, SCRIPT_FILES } = require("./scripts");

const SUPPORTED_REDIS_MAJOR_VERSIONS = Object.freeze([7, 8]);

const SHARED_OPTION_NAMES = Object.freeze([
  "client",
  "tokenService",
  "envelopeCrypto",
  "objectKeyFactory",
  "keyspace",
  "keyPrefix",
  "scriptRunner",
]);
const REPOSITORY_OPTION_NAMES = Object.freeze({
  pairings: Object.freeze([
    "activationRetryTtlMs",
    "idFactory",
    "generationFactory",
    "randomBytes",
    "ttlMs",
    "tombstoneTtlMs",
    "maxPairings",
  ]),
  oauthStates: Object.freeze(["ttlMs", "maxStates"]),
  playbackContexts: Object.freeze([
    "sourceContextOptions",
    "writeVersion",
    "pruneBatchSize",
    "pruneEntryBatchSize",
    "isolatedScriptRunnerFactory",
    "cleanupOwnerFactory",
    "idFactory",
    "ttlMs",
    "tombstoneTtlMs",
    "maxContexts",
    "maxContextsPerProfile",
    "maxClaims",
    "maxClaimsPerProfile",
    "maxTombstones",
    "maxTombstonesPerProfile",
    "maxLaunchAgeMs",
    "maxFutureLaunchSkewMs",
    "maxContextAfterLaunchMs",
    "deviceGenerationTtlMs",
    "maxDeviceGenerationsPerProfile",
  ]),
  managementSessions: Object.freeze([
    "pairingReplayTtlMs",
    "ttlMs",
    "maxSessions",
    "maxSessionsPerProfile",
    "isProfileActive",
  ]),
  leases: Object.freeze(["maxLeases"]),
  rateLimits: Object.freeze(["maxEntries"]),
  subtitleDeliveries: Object.freeze([
    "idFactory",
    "maxProfileArtifacts",
    "maxProfileObjects",
    "maxProfileBytes",
    "maxProfileLeases",
    "maxGlobalArtifacts",
    "maxGlobalObjects",
    "maxGlobalBytes",
    "maxGlobalLeases",
    "maxGlobalAuthorities",
    "maxArtifactBytes",
    "maxArtifactParts",
    "logicalTtlMs",
    "absoluteTtlMs",
    "uploadLeaseTtlMs",
    "maxPutLifetimeMs",
    "uploadSettlementGraceMs",
    "ioLeaseTtlMs",
    "deletionLeaseTtlMs",
    "maxDeletionRetryMs",
    "pruneBatchSize",
    "deletionScanBatchSize",
    "leaseCleanupBatchSize",
    "uploadCleanupBatchSize",
    "maxSourceCapabilityBytes",
    "maxSourceEnvelopeBytes",
  ]),
});

function hasOwn(object, name) {
  return Object.prototype.hasOwnProperty.call(object, name);
}

function repositoryOptions(options, name) {
  const nested = options[name];
  if (nested !== undefined && (!nested || typeof nested !== "object" || Array.isArray(nested))) {
    throw new TypeError(name + " Redis options must be an object");
  }
  const allowed = REPOSITORY_OPTION_NAMES[name];
  for (const optionName of Object.keys(nested || {})) {
    if (SHARED_OPTION_NAMES.includes(optionName)) {
      throw new TypeError(name + " Redis options may not override shared " + optionName);
    }
    if (!allowed.includes(optionName)) {
      throw new TypeError(name + " Redis option is not supported: " + optionName);
    }
  }

  const resolved = {};
  for (const optionName of SHARED_OPTION_NAMES) {
    if (hasOwn(options, optionName)) resolved[optionName] = options[optionName];
  }
  for (const optionName of allowed) {
    if (hasOwn(options, optionName)) resolved[optionName] = options[optionName];
    if (nested && hasOwn(nested, optionName)) resolved[optionName] = nested[optionName];
  }
  return resolved;
}

function createRedisTtlRepositories(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Redis repository options must be an object");
  }
  return {
    pairings: new RedisPairingRepository(repositoryOptions(options, "pairings")),
    oauthStates: new RedisOAuthStateRepository(repositoryOptions(options, "oauthStates")),
    playbackContexts: new RedisPlaybackContextRepository(repositoryOptions(options, "playbackContexts")),
    managementSessions: new RedisManagementSessionRepository(
      repositoryOptions(options, "managementSessions")
    ),
    leases: new RedisLeaseRepository(repositoryOptions(options, "leases")),
    rateLimits: new RedisRateLimitRepository(repositoryOptions(options, "rateLimits")),
    subtitleDeliveries: new RedisSubtitleDeliveryRepository(
      repositoryOptions(options, "subtitleDeliveries")
    ),
  };
}

function redisConfigText(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string") return value;
  return null;
}

function redisVersionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function assertRedisSupportedVersion(client) {
  assertStandalonePrimaryClient(client);
  if (typeof client.sendCommand !== "function") {
    throw new TypeError("Redis client must provide sendCommand() for version verification");
  }
  const info = redisConfigText(await client.sendCommand(["INFO", "server"]));
  if (info === null) {
    throw redisVersionError(
      "redis_version_invalid",
      "Redis INFO server readiness reply is invalid"
    );
  }
  const values = info
    .split(/\r?\n/)
    .filter((line) => line.startsWith("redis_version:"))
    .map((line) => line.slice("redis_version:".length));
  const match = values.length === 1
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.exec(values[0])
    : null;
  if (!match) {
    throw redisVersionError(
      "redis_version_invalid",
      "Redis INFO server version is invalid"
    );
  }
  const major = Number(match[1]);
  if (!Number.isSafeInteger(major) || !SUPPORTED_REDIS_MAJOR_VERSIONS.includes(major)) {
    throw redisVersionError(
      "redis_version_unsupported",
      "Redis major version is unsupported; configure Redis 7 or 8"
    );
  }
  return { major, version: values[0] };
}

async function assertRedisNoEvictionPolicy(client) {
  assertStandalonePrimaryClient(client);
  if (typeof client.sendCommand !== "function") {
    throw new TypeError("Redis client must provide sendCommand() for policy verification");
  }
  const reply = await client.sendCommand(["CONFIG", "GET", "maxmemory-policy"]);
  let policy = null;
  if (Array.isArray(reply)) {
    for (let index = 0; index + 1 < reply.length; index += 2) {
      if (redisConfigText(reply[index]) === "maxmemory-policy") {
        policy = redisConfigText(reply[index + 1]);
        break;
      }
    }
  } else if (reply && typeof reply === "object") {
    policy = redisConfigText(reply["maxmemory-policy"] ?? reply.maxmemoryPolicy);
  }
  if (!policy) throw new Error("Redis maxmemory-policy readiness reply is invalid");
  if (policy.toLowerCase() !== "noeviction") {
    const error = new Error("Redis readiness requires maxmemory-policy noeviction");
    error.code = "redis_eviction_policy";
    throw error;
  }
  return { maxmemoryPolicy: "noeviction" };
}

module.exports = {
  DEFAULT_KEY_PREFIX,
  DEFAULT_SUBTITLE_DELIVERY_LIMITS,
  RedisKeyspace,
  RedisLeaseRepository,
  RedisManagementSessionRepository,
  RedisOAuthStateRepository,
  RedisPairingRepository,
  RedisPlaybackContextRepository,
  RedisRateLimitRepository,
  RedisSubtitleDeliveryRepository,
  RedisScriptRunner,
  SCRIPT_DEFINITIONS,
  SCRIPT_FILES,
  SUPPORTED_REDIS_MAJOR_VERSIONS,
  assertStandalonePrimaryClient,
  assertRedisNoEvictionPolicy,
  assertRedisSupportedVersion,
  createRedisTtlRepositories,
  isClusterClient,
  isNoScriptError,
};
