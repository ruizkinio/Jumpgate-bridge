"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { SourceContextStore } = require("../source-context");
const { isProductionLikeEnvironment } = require("../runtime-environment");
const {
  assertEnvironment,
  assertPersistentSqlitePath,
  assertPostgresMigrationCeiling,
  assertProviderMutationMode,
  assertRedisPlaybackWriteVersion,
  assertSubtitleObjectKeyConfig,
  assertSubtitleS3Config,
  assertStorageTopology,
  parseUrl,
} = require("./config");
const { assertRepositorySet } = require("./contracts");
const { EnvelopeCrypto } = require("./envelope-crypto");
const {
  MemoryLifecycleInvalidationRepository,
  ProfileLifecycleCoordinator,
} = require("./lifecycle-invalidation");
const {
  MemoryAddonCollectionBackupRepository,
  MemoryDeviceRepository,
  MemoryHistoryRepository,
  MemoryLegacyConfigAliasRepository,
  MemoryOAuthCredentialRepository,
} = require("./memory-durable-repositories");
const {
  MemoryHistoryGrantRepository,
} = require("./memory-history-grant-repository");
const {
  MemoryPlaybackSessionRepository,
} = require("./memory-playback-session-repository");
const {
  MemoryProfileRepository,
  MemoryProviderRepository,
} = require("./memory-profile-provider-repositories");
const {
  MemoryManagementGenerationStore,
  MemoryManagementSessionRepository,
} = require("./memory-repositories");
const {
  MemorySubtitleDeliveryRepository,
} = require("./memory-subtitle-delivery-repository");
const {
  MemorySubtitleManifestRepository,
} = require("./memory-subtitle-manifest-repository");
const { MemorySubtitleObjectStore } = require("./memory-subtitle-object-store");
const {
  MemoryLeaseRepository,
  MemoryOAuthStateRepository,
  MemoryPairingRepository,
  MemoryPlaybackContextRepository,
  MemoryRateLimitRepository,
} = require("./memory-ttl-repositories");
const {
  OpaqueObjectKeyFactory,
  assertObjectStore,
} = require("./object-store");
const { TokenService } = require("./token-service");

const DURABLE_DRIVERS = new Set(["memory", "postgres", "sqlite"]);
const TTL_DRIVERS = new Set(["memory", "redis"]);
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const REDIS_PROTOCOLS = new Set(["redis:", "rediss:"]);
const DEFAULT_LIFECYCLE_TIMEOUTS = Object.freeze({
  startupMs: 120000,
  migrationMs: 60000,
  connectMs: 15000,
  readinessMs: 5000,
  shutdownMs: 10000,
});
const MAX_LIFECYCLE_TIMEOUT_MS = 30 * 60 * 1000;
const REDIS_READINESS_PROBE_TTL_MS = 5000;
const UPSTASH_ROLE_UNAVAILABLE_MESSAGE =
  "ERR Command is not available: 'ROLE'. See https://upstash.com/docs/redis/overall/rediscompatibility for details";
const POSTGRES_READINESS_QUERY = "SELECT 1 AS ready";
const SUBTITLE_OBJECT_KEY_PREFIX = "subtitles/v1";
const SUBTITLE_ERASURE_CANARY_NAMESPACE = "erasure-attestation-canary-v2";
const TIGRIS_ORG_ADMIN_ACL_URI = "https://groups.tigris.dev/org/admins";
const DEFAULT_SUBTITLE_ERASURE_ATTESTATION_FRESHNESS_MS = 60 * 1000;
const MAX_SUBTITLE_ERASURE_ATTESTATION_FRESHNESS_MS = 5 * 60 * 1000;
const SUBTITLE_ERASURE_HEALTH_OPTION_FIELDS = new Set([
  "attestationFreshnessMs",
  "randomBytes",
]);
const SUBTITLE_AUTHORITY_FINGERPRINTS = new WeakMap();
const HARDENED_SUBTITLE_OBJECT_STORES = new WeakMap();
let REDIS_SIMPLE_ERROR_PROTOTYPE;
const LOCAL_FAILURE_DETAILS = new WeakMap();
const LOCAL_TIMEOUT_DETAILS = new WeakMap();
const LOCAL_CLEANUP_DETAILS = new WeakMap();
const STORAGE_STARTUP_FAILURE_DETAILS = Object.freeze({
  code: "storage_startup_failed",
  message: "storage startup failed",
  phase: "storage startup",
});
const STORAGE_READINESS_FAILURE_DETAILS = Object.freeze({
  code: "storage_readiness_failed",
  message: "storage readiness failed",
  phase: "storage readiness",
});
const CLEANUP_PHASE_BY_KIND = Object.freeze({
  PostgreSQL: "PostgreSQL shutdown",
  Redis: "Redis shutdown",
  "Redis preflight": "Redis preflight shutdown",
  SQLite: "SQLite shutdown",
  "subtitle S3": "subtitle S3 shutdown",
});
const SUBTITLE_STORE_CONFIG_FIELDS = new Set([
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
  "region",
  "serverSideEncryption",
  "sseResponsePolicy",
]);

function assertStorageConfig(config) {
  if (!config || typeof config !== "object") throw new TypeError("storage config is required");
  if (
    !Buffer.isBuffer(config.tokenPepper) ||
    config.tokenPepper.length < 32 ||
    config.tokenPepper.length > 64
  ) {
    throw new TypeError("storage config token pepper is invalid");
  }
  if (
    !(config.envelopeKeys instanceof Map) ||
    config.envelopeKeys.size < 1 ||
    config.envelopeKeys.size > 8
  ) {
    throw new TypeError("storage config envelope keys are invalid");
  }
  for (const [keyId, key] of config.envelopeKeys) {
    if (!KEY_ID_PATTERN.test(String(keyId)) || !Buffer.isBuffer(key) || key.length !== 32) {
      throw new TypeError("storage config envelope keys are invalid");
    }
  }
  if (typeof config.primaryEnvelopeKeyId !== "string" || !config.envelopeKeys.has(config.primaryEnvelopeKeyId)) {
    throw new TypeError("storage config primary envelope key is invalid");
  }
  if (!DURABLE_DRIVERS.has(config.durableDriver)) {
    throw new TypeError("storage config durable driver is invalid");
  }
  if (!TTL_DRIVERS.has(config.ttlDriver)) {
    throw new TypeError("storage config TTL driver is invalid");
  }
  if (config.durableDriver === "postgres") {
    parseUrl(config.databaseUrl, "storage config database URL", POSTGRES_PROTOCOLS);
  }
  if (config.durableDriver === "sqlite") {
    assertPersistentSqlitePath(config.sqlitePath, "storage config SQLite path", { absolute: true });
  }
  if (config.ttlDriver === "redis") {
    parseUrl(config.redisUrl, "storage config Redis URL", REDIS_PROTOCOLS);
  }
  const environment = assertEnvironment(config.environment);
  const productionLike = isProductionLikeEnvironment(environment);
  assertStorageTopology(environment, config.durableDriver, config.ttlDriver);
  assertProviderMutationMode(config.providerMutationMode);
  if (productionLike && config.providerMutationMode !== "fenced") {
    throw new TypeError("production requires fenced provider mutation");
  }
  assertPostgresMigrationCeiling(config.postgresMigrationCeiling, {
    required: productionLike && config.durableDriver === "postgres",
  });
  assertRedisPlaybackWriteVersion(config.redisPlaybackWriteVersion);
  if (productionLike && config.redisPlaybackWriteVersion !== "4") {
    throw new TypeError("production requires Redis playback write version 4");
  }
  const requiresSubtitleStorage = config.ttlDriver === "redis";
  assertSubtitleS3Config(config.subtitleS3, { required: requiresSubtitleStorage });
  assertSubtitleObjectKeyConfig(config.subtitleObjectKeys, {
    required: requiresSubtitleStorage,
  });
  if (productionLike && config.ephemeralSecurityMaterial === true) {
    throw new TypeError("production may not use ephemeral security material");
  }
  return config;
}

function assertPrimitives(primitives) {
  if (!primitives || !primitives.tokenService || !primitives.envelopeCrypto) {
    throw new TypeError("storage primitives are invalid");
  }
  return primitives;
}

function createStoragePrimitives(config, options = {}) {
  const safeConfig = assertStorageConfig(config);
  const common = options.randomBytes ? { randomBytes: options.randomBytes } : {};
  return {
    tokenService: new TokenService({ pepper: safeConfig.tokenPepper, ...common }),
    envelopeCrypto: new EnvelopeCrypto({
      primaryKeyId: safeConfig.primaryEnvelopeKeyId,
      keys: safeConfig.envelopeKeys,
      maxPlaintextBytes: options.maxPlaintextBytes,
      ...common,
    }),
  };
}

function createMemoryDurableRepositories(primitives, options = {}) {
  const safePrimitives = assertPrimitives(primitives);
  const tokenService = safePrimitives.tokenService;
  const envelopeCrypto = safePrimitives.envelopeCrypto;
  const clock = options.clock;
  const lifecycleCoordinator = new ProfileLifecycleCoordinator();
  const lifecycleInvalidations = new MemoryLifecycleInvalidationRepository({ clock });
  let profiles;
  let devices;
  const playbackSessions = new MemoryPlaybackSessionRepository({
    tokenService,
    clock,
    lifecycleCoordinator,
    getProfileBinding: (profileId) => profiles.getById(profileId),
    isDeviceBindingActive: (profileId, deviceId, generation) =>
      devices.isActiveBindingNow(profileId, deviceId, generation),
  });
  const subtitleManifests = new MemorySubtitleManifestRepository({
    tokenService,
    clock,
    lifecycleCoordinator,
    getProfileBinding: (profileId) => profiles.getById(profileId),
    isDeviceBindingActive: (profileId, deviceId, generation) =>
      devices.isActiveBindingNow(profileId, deviceId, generation),
  });
  profiles = new MemoryProfileRepository({
    tokenService,
    clock,
    idFactory: options.profileIdFactory,
    lifecycleCoordinator,
    lifecycleInvalidations,
    playbackSessions,
    subtitleManifests,
  });
  const isProfileActive = async (profileId) => {
    const profile = await profiles.getById(profileId);
    return Boolean(profile && profile.status === "active");
  };
  devices = new MemoryDeviceRepository({
    tokenService,
    clock,
    idFactory: options.deviceIdFactory,
    isProfileActive,
    getProfileBinding: (profileId) => profiles.getById(profileId),
    lifecycleCoordinator,
    lifecycleInvalidations,
    playbackSessions,
    subtitleManifests,
  });
  const providers = new MemoryProviderRepository({
      tokenService,
      envelopeCrypto,
      clock,
      idFactory: options.providerIdFactory,
    });
  const oauthCredentials = new MemoryOAuthCredentialRepository({
    envelopeCrypto,
    clock,
    isProfileActive,
  });
  const history = new MemoryHistoryRepository({
    clock,
    lifecycleCoordinator,
    isProfileActive,
    getGeneration: (profileId) => profiles.getHistoryGeneration(profileId),
    advanceGeneration: (profileId, generation) =>
      profiles.advanceHistoryGeneration(profileId, generation),
    isDeviceBindingActive: (profileId, deviceId, generation) =>
      devices.isActiveBindingNow(profileId, deviceId, generation),
  });
  const historyGrants = new MemoryHistoryGrantRepository({
    tokenService,
    envelopeCrypto,
    clock,
    lifecycleCoordinator,
    historyRepository: history,
    playbackSessions,
    getProfileBinding: (profileId) => profiles.getById(profileId),
    isDeviceBindingActive: (profileId, deviceId, generation) =>
      devices.isActiveBindingNow(profileId, deviceId, generation),
    getHistoryGeneration: (profileId) => profiles.getHistoryGeneration(profileId),
    grantIdFactory: options.historyGrantIdFactory,
    sessionIdFactory: options.historySessionIdFactory,
  });
  const addonCollectionBackups = new MemoryAddonCollectionBackupRepository({
    envelopeCrypto,
    clock,
    idFactory: options.backupIdFactory,
  });
  profiles.setEraser((profileId) => {
    historyGrants.eraseProfileNow(profileId);
    playbackSessions.eraseProfileNow(profileId);
    devices.eraseProfile(profileId);
    providers.eraseProfile(profileId);
    oauthCredentials.eraseProfile(profileId);
    history.eraseProfile(profileId);
    addonCollectionBackups.eraseProfile(profileId);
  });
  return {
    profiles,
    devices,
    providers,
    oauthCredentials,
    history,
    historyGrants,
    addonCollectionBackups,
    legacyConfigAliases: new MemoryLegacyConfigAliasRepository(),
    lifecycleInvalidations,
    playbackSessions,
    subtitleManifests,
  };
}

function createMemoryObjectKeyFactory(options = {}) {
  if (options.objectKeyFactory !== undefined) {
    if (!(options.objectKeyFactory instanceof OpaqueObjectKeyFactory)) {
      throw new TypeError("objectKeyFactory must be an OpaqueObjectKeyFactory");
    }
    return options.objectKeyFactory;
  }
  return new OpaqueObjectKeyFactory({
    currentKeyId: "memory",
    keyring: [{ id: "memory", secret: crypto.randomBytes(32) }],
    prefix: "subtitles/v1",
  });
}

function createMemoryTtlComponents(primitives, options = {}) {
  const safePrimitives = assertPrimitives(primitives);
  const tokenService = safePrimitives.tokenService;
  const envelopeCrypto = safePrimitives.envelopeCrypto;
  const clock = options.clock;
  const randomBytes = options.randomBytes;
  const isProfileActive = options.isProfileActive || (async () => true);
  const sourceContextOptions = options.sourceContextOptions || {};
  const sourceContextStore = options.sourceContextStore || new SourceContextStore(sourceContextOptions);
  const objectKeyFactory = createMemoryObjectKeyFactory(options);
  const subtitleDeliveryOptions = options.subtitleDeliveryOptions || {};
  const managementGenerations =
    options.managementGenerations || new MemoryManagementGenerationStore();
  const subtitleObjectStore = options.subtitleObjectStore
    ? assertObjectStore(options.subtitleObjectStore)
    : new MemorySubtitleObjectStore({
        ...(options.memorySubtitleObjectStoreOptions || {}),
        objectKeyFactory,
      });
  const repositories = {
    pairings: new MemoryPairingRepository({
      tokenService,
      envelopeCrypto,
      clock,
      randomBytes,
      idFactory: options.pairingIdFactory,
    }),
    oauthStates: new MemoryOAuthStateRepository({
      tokenService,
      envelopeCrypto,
      clock,
      managementGenerations,
    }),
    playbackContexts: new MemoryPlaybackContextRepository({ store: sourceContextStore }),
    subtitleDeliveries: new MemorySubtitleDeliveryRepository({
      ...subtitleDeliveryOptions,
      tokenService,
      objectKeyFactory,
      sourceContextStore,
      clock:
        subtitleDeliveryOptions.clock ||
        sourceContextOptions.clock ||
        sourceContextOptions.now ||
        clock ||
        Date.now,
      idFactory: subtitleDeliveryOptions.idFactory || options.subtitleArtifactIdFactory,
    }),
    managementSessions: new MemoryManagementSessionRepository({
      tokenService,
      envelopeCrypto,
      clock,
      isProfileActive,
      managementGenerations,
    }),
    leases: new MemoryLeaseRepository({ tokenService, clock }),
    rateLimits: new MemoryRateLimitRepository({ tokenService, clock }),
  };
  return { repositories, sourceContextStore, subtitleObjectStore };
}

function createMemoryTtlRepositories(primitives, options = {}) {
  return createMemoryTtlComponents(primitives, options).repositories;
}

function createMemoryRepositorySet(config, options = {}) {
  if (!config || config.durableDriver !== "memory" || config.ttlDriver !== "memory") {
    throw new TypeError("memory repository set requires memory storage drivers");
  }
  const safeConfig = assertStorageConfig(config);
  const primitives = assertPrimitives(options.primitives || createStoragePrimitives(safeConfig, options));
  const durable = createMemoryDurableRepositories(primitives, options);
  const isProfileActive = async (profileId) => {
    const profile = await durable.profiles.getById(profileId);
    return Boolean(profile && profile.status === "active");
  };
  const ttl = createMemoryTtlComponents(primitives, { ...options, isProfileActive });
  const repositories = {
    ...durable,
    ...ttl.repositories,
  };

  assertRepositorySet(repositories);
  return { repositories, subtitleObjectStore: ttl.subtitleObjectStore, ...primitives };
}

function defaultCreatePostgresPool(poolOptions) {
  const { Pool } = require("pg");
  return new Pool(poolOptions);
}

function defaultCreateRedisClient(clientOptions) {
  const { createClient } = require("redis");
  return createClient(clientOptions);
}

function defaultCreateSubtitleS3Client(clientOptions) {
  const { S3Client } = require("@aws-sdk/client-s3");
  return new S3Client(clientOptions);
}

function rememberLocalFailure(error, details) {
  LOCAL_FAILURE_DETAILS.set(error, Object.freeze({ ...details }));
  return error;
}

function localFailureDetails(error) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return null;
  }
  return LOCAL_FAILURE_DETAILS.get(error) || null;
}

function subtitleStorageError(phase) {
  const message = "subtitle object storage " + phase + " failed";
  const error = new Error(message);
  error.code = "subtitle_object_storage_unavailable";
  return rememberLocalFailure(error, {
    code: "subtitle_object_storage_unavailable",
    message,
    phase: "subtitle object storage " + phase,
  });
}

function assertProductionSubtitleErasureReadiness(config) {
  if (!config || !isProductionLikeEnvironment(config.environment)) return true;
  if (
    config.subtitleS3 &&
    config.subtitleS3.permanentErasureMode === "tigris-version-purge-v1"
  ) {
    return true;
  }
  const error = new Error(
    "production subtitle erasure requires tigris-version-purge-v1 live provider attestation"
  );
  error.code = "subtitle_permanent_erasure_unverifiable";
  throw rememberLocalFailure(error, {
    code: "subtitle_permanent_erasure_unverifiable",
    message:
      "production subtitle erasure requires tigris-version-purge-v1 live provider attestation",
    phase: "subtitle permanent erasure",
  });
}

function subtitleErasureError(message) {
  const error = new Error(message);
  error.code = "subtitle_permanent_erasure_unverifiable";
  return rememberLocalFailure(error, {
    code: "subtitle_permanent_erasure_unverifiable",
    message: "subtitle permanent erasure attestation failed",
    phase: "subtitle permanent erasure",
  });
}

function updateFingerprintField(hash, name, value) {
  const nameBytes = Buffer.from(name, "utf8");
  const valueBytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const lengths = Buffer.allocUnsafe(8);
  lengths.writeUInt32BE(nameBytes.length, 0);
  lengths.writeUInt32BE(valueBytes.length, 4);
  hash.update(lengths).update(nameBytes).update(valueBytes);
  lengths.fill(0);
}

function subtitleObjectKeyAuthorityFingerprint(config) {
  const safeConfig = assertSubtitleObjectKeyConfig(config, { required: true });
  const hash = crypto.createHash("sha256");
  hash.update("jumpgate-subtitle-authority-fingerprint:v1\0", "utf8");
  updateFingerprintField(hash, "prefix", SUBTITLE_OBJECT_KEY_PREFIX);
  updateFingerprintField(hash, "current-key-id", safeConfig.currentKeyId);
  const entries = [...safeConfig.keyring].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  updateFingerprintField(hash, "accepted-key-count", String(entries.length));
  for (const entry of entries) {
    updateFingerprintField(hash, "accepted-key-id", entry.id);
    updateFingerprintField(hash, "accepted-key-bytes", entry.secret);
  }
  return hash.digest("hex");
}

function createSubtitleObjectKeyFactory(config) {
  const fingerprint = subtitleObjectKeyAuthorityFingerprint(config);
  const objectKeyFactory = new OpaqueObjectKeyFactory({
    currentKeyId: config.currentKeyId,
    keyring: config.keyring,
    prefix: SUBTITLE_OBJECT_KEY_PREFIX,
  });
  SUBTITLE_AUTHORITY_FINGERPRINTS.set(objectKeyFactory, fingerprint);
  return objectKeyFactory;
}

function assertObjectKeyAuthority(candidate, expectedFingerprint) {
  if (
    !(candidate instanceof OpaqueObjectKeyFactory) ||
    SUBTITLE_AUTHORITY_FINGERPRINTS.get(candidate) !== expectedFingerprint
  ) {
    throw new TypeError("objectKeyFactory does not match configured subtitle authority");
  }
  return candidate;
}

function readSubtitleStoreOptions(options) {
  const value =
    options.subtitleObjectStoreOptions === undefined
      ? {}
      : options.subtitleObjectStoreOptions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("subtitleObjectStoreOptions must be an object");
  }
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== "string") {
      throw new TypeError("subtitleObjectStoreOptions contains unsupported fields");
    }
    if (SUBTITLE_STORE_CONFIG_FIELDS.has(field)) {
      throw new TypeError(
        "subtitleObjectStoreOptions may not override configured " + field
      );
    }
  }
  return value;
}

function addSubtitleS3ClientCloser(client, closesClient, options, closers) {
  let destroyed = false;
  let detachErrorListener = () => {};
  const destroyClient = async () => {
    if (destroyed || !closesClient) return;
    destroyed = true;
    try {
      if (!client || typeof client.destroy !== "function") {
        throw new TypeError("subtitle S3 client must provide destroy()");
      }
      await client.destroy();
    } catch (_error) {
      throw subtitleStorageError("shutdown");
    }
  };
  closers.push({
    kind: "subtitle S3",
    close: closesClient ? destroyClient : null,
    force: null,
    detach: () => detachErrorListener(),
  });
  if (closesClient && (!client || typeof client.destroy !== "function")) {
    throw new TypeError("owned subtitle S3 client must provide destroy()");
  }
  detachErrorListener = addErrorListener(client, "subtitle-s3", options);
}

function createHardenedSubtitleObjectStore(config, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("hardened subtitle object store options are invalid");
  }
  const allowed = new Set(["client", "subtitleObjectStoreOptions"]);
  if (
    Reflect.ownKeys(options).some(
      (field) => typeof field !== "string" || !allowed.has(field)
    )
  ) {
    throw new TypeError("hardened subtitle object store options contain unsupported fields");
  }
  const subtitleS3 = assertSubtitleS3Config(config.subtitleS3, { required: true });
  const subtitleObjectKeys = assertSubtitleObjectKeyConfig(config.subtitleObjectKeys, {
    required: true,
  });
  const fingerprint = subtitleObjectKeyAuthorityFingerprint(subtitleObjectKeys);
  const storeOptions = readSubtitleStoreOptions(options);
  const { SubtitleObjectStore } = require("./s3/subtitle-object-store");
  const subtitleObjectStore = new SubtitleObjectStore({
    ...storeOptions,
    allowInjectedClient: true,
    bucket: subtitleS3.bucket,
    client: options.client,
    endpoint: subtitleS3.endpoint,
    forcePathStyle: subtitleS3.forcePathStyle,
    keyHmacCurrentKeyId: subtitleObjectKeys.currentKeyId,
    keyHmacKeyring: subtitleObjectKeys.keyring,
    region: subtitleS3.region,
    serverSideEncryption: "AES256",
    sseResponsePolicy:
      subtitleS3.privacyMode === "tigris-policy-status" ? "allow-missing" : "required",
  });
  HARDENED_SUBTITLE_OBJECT_STORES.set(subtitleObjectStore, {
    bucket: subtitleS3.bucket,
    client: options.client,
    endpoint: subtitleS3.endpoint,
    fingerprint,
    forcePathStyle: subtitleS3.forcePathStyle,
    privacyMode: subtitleS3.privacyMode,
    region: subtitleS3.region,
  });
  return subtitleObjectStore;
}

function assertHardenedSubtitleObjectStore(store, expectedFingerprint, config) {
  const { SubtitleObjectStore } = require("./s3/subtitle-object-store");
  const attestation = HARDENED_SUBTITLE_OBJECT_STORES.get(store);
  if (
    !(store instanceof SubtitleObjectStore) ||
    !attestation ||
    attestation.fingerprint !== expectedFingerprint ||
    attestation.bucket !== config.subtitleS3.bucket ||
    attestation.endpoint !== config.subtitleS3.endpoint ||
    attestation.forcePathStyle !== config.subtitleS3.forcePathStyle ||
    attestation.privacyMode !== config.subtitleS3.privacyMode ||
    attestation.region !== config.subtitleS3.region
  ) {
    throw new TypeError(
      "subtitleObjectStore is not a hardened store for the configured subtitle authority"
    );
  }
  return attestation;
}

function assertPublicAccessBlock(response) {
  const block = response && response.PublicAccessBlockConfiguration;
  if (
    !block ||
    block.BlockPublicAcls !== true ||
    block.IgnorePublicAcls !== true ||
    block.BlockPublicPolicy !== true ||
    block.RestrictPublicBuckets !== true
  ) {
    throw new Error("subtitle bucket public access block is incomplete");
  }
}

function assertPrivateBucketPolicy(response) {
  if (!response || !response.PolicyStatus || response.PolicyStatus.IsPublic !== false) {
    throw new Error("subtitle bucket policy is public or unverifiable");
  }
}

function assertPrivateAcl(response, scope) {
  const owner = response && response.Owner;
  const ownerId = owner && owner.ID;
  if (
    !owner ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    typeof ownerId !== "string" ||
    !ownerId ||
    ownerId.length > 256 ||
    ownerId.trim() !== ownerId ||
    /[\u0000-\u001f\u007f]/.test(ownerId) ||
    !Array.isArray(response.Grants) ||
    response.Grants.length < 1 ||
    response.Grants.length > 2
  ) {
    throw new Error("subtitle " + scope + " ACL is unverifiable");
  }
  let ownerGrantSeen = false;
  let tigrisOrgAdminGrantSeen = false;
  for (const grant of response.Grants) {
    if (
      !grant ||
      typeof grant !== "object" ||
      Array.isArray(grant) ||
      !grant.Grantee ||
      typeof grant.Grantee !== "object" ||
      Array.isArray(grant.Grantee)
    ) {
      throw new Error("subtitle " + scope + " ACL is unverifiable");
    }
    const canonicalOwnerGrant =
      grant.Grantee.Type === "CanonicalUser" &&
      grant.Grantee.ID === ownerId &&
      grant.Grantee.URI === undefined &&
      grant.Grantee.EmailAddress === undefined &&
      grant.Permission === "FULL_CONTROL" &&
      !ownerGrantSeen;
    if (canonicalOwnerGrant) {
      ownerGrantSeen = true;
      continue;
    }

    const tigrisOrgAdminGrant =
      grant.Grantee.Type === "Group" &&
      grant.Grantee.URI === TIGRIS_ORG_ADMIN_ACL_URI &&
      grant.Grantee.ID === undefined &&
      grant.Grantee.EmailAddress === undefined &&
      grant.Permission === "FULL_CONTROL" &&
      !tigrisOrgAdminGrantSeen;
    if (tigrisOrgAdminGrant) {
      tigrisOrgAdminGrantSeen = true;
      continue;
    }

    throw new Error("subtitle " + scope + " ACL contains a non-private grant");
  }
  if (!ownerGrantSeen) {
    throw new Error("subtitle " + scope + " ACL is unverifiable");
  }
  return ownerId;
}

function boundedSubtitleHealthOperation(work, deadline, lifecycle) {
  const now = Number(lifecycle.timers.now());
  if (!Number.isFinite(now)) throw new TypeError("storage lifecycle clock is invalid");
  const remainingMs = Math.floor(deadline - now);
  if (remainingMs < 1) {
    throw timeoutError("subtitle object storage privacy probe", 1);
  }
  const controller = new AbortController();
  return withTimeout(
    () => work(controller.signal),
    remainingMs,
    "subtitle object storage privacy probe",
    lifecycle,
    () => controller.abort()
  ).finally(() => controller.abort());
}

function resolveSubtitleErasureHealthOptions(rawOptions = {}) {
  if (!rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
    throw new TypeError("subtitle erasure health options are invalid");
  }
  if (
    Reflect.ownKeys(rawOptions).some(
      (field) =>
        typeof field !== "string" || !SUBTITLE_ERASURE_HEALTH_OPTION_FIELDS.has(field)
    )
  ) {
    throw new TypeError("subtitle erasure health options contain unsupported fields");
  }
  const attestationFreshnessMs =
    rawOptions.attestationFreshnessMs ??
    DEFAULT_SUBTITLE_ERASURE_ATTESTATION_FRESHNESS_MS;
  if (
    !Number.isSafeInteger(attestationFreshnessMs) ||
    attestationFreshnessMs < 1 ||
    attestationFreshnessMs > MAX_SUBTITLE_ERASURE_ATTESTATION_FRESHNESS_MS
  ) {
    throw new TypeError("subtitle erasure attestation freshness is invalid");
  }
  const randomBytes = rawOptions.randomBytes || crypto.randomBytes;
  if (typeof randomBytes !== "function") {
    throw new TypeError("subtitle erasure attestation random source is invalid");
  }
  return Object.freeze({ attestationFreshnessMs, randomBytes });
}

function createErasureCanaryNonce(randomBytes) {
  let candidate;
  try {
    candidate = randomBytes(32);
  } catch (_error) {
    throw subtitleErasureError("Tigris subtitle erasure canary identity could not be created");
  }
  if (!Buffer.isBuffer(candidate) && !(candidate instanceof Uint8Array)) {
    throw subtitleErasureError("Tigris subtitle erasure canary identity could not be created");
  }
  const bytes = Buffer.from(candidate);
  if (bytes.length !== 32) {
    bytes.fill(0);
    throw subtitleErasureError("Tigris subtitle erasure canary identity could not be created");
  }
  try {
    return bytes.toString("base64url");
  } finally {
    bytes.fill(0);
  }
}

async function runSubtitleErasureAttestation(
  subtitleObjectStore,
  deadline,
  lifecycle,
  namespaceScope,
  randomBytes
) {
  const namespace = [SUBTITLE_ERASURE_CANARY_NAMESPACE, namespaceScope];
  const canaryKey = subtitleObjectStore.createKey([
    ...namespace,
    createErasureCanaryNonce(randomBytes),
  ]);
  const canary = Buffer.from([0x5a]);
  const checksumSha256 = crypto.createHash("sha256").update(canary).digest("hex");
  let writeAttempted = false;
  try {
    await boundedSubtitleHealthOperation(
      (signal) => subtitleObjectStore.purgeNamespace(namespace, { signal }),
      deadline,
      lifecycle
    );
    writeAttempted = true;
    const written = await boundedSubtitleHealthOperation(
      (signal) =>
        subtitleObjectStore.put(canaryKey, canary, {
          checksumSha256,
          contentLength: canary.length,
          contentType: "application/octet-stream",
          signal,
        }),
      deadline,
      lifecycle
    );
    if (
      !written ||
      written.key !== canaryKey ||
      written.checksumSha256 !== checksumSha256 ||
      written.contentLength !== canary.length ||
      typeof written.versionId !== "string" ||
      written.versionId.length === 0 ||
      written.versionId === "null"
    ) {
      throw subtitleErasureError("Tigris subtitle erasure canary write was not attested");
    }
    const deleted = await boundedSubtitleHealthOperation(
      (signal) => subtitleObjectStore.deleteVersion(canaryKey, written.versionId, { signal }),
      deadline,
      lifecycle
    );
    if (
      !deleted ||
      deleted.deleted !== true ||
      deleted.key !== canaryKey ||
      deleted.observed !== true ||
      deleted.versionId !== written.versionId
    ) {
      throw subtitleErasureError("Tigris subtitle exact-version delete was not attested");
    }
  } catch (_error) {
    if (writeAttempted) {
      const cleanupStartedAt = Number(lifecycle.timers.now());
      const cleanupBudgetMs = Math.max(1, Math.min(1000, lifecycle.readinessMs));
      if (Number.isFinite(cleanupStartedAt)) {
        try {
          await boundedSubtitleHealthOperation(
            (signal) => subtitleObjectStore.purgeNamespace(namespace, { signal }),
            cleanupStartedAt + cleanupBudgetMs,
            lifecycle
          );
        } catch (_cleanupError) {
          // The next uncached readiness run starts by recovering this namespace.
        }
      }
    }
    throw subtitleErasureError(
      "Tigris subtitle exact-version purge could not prove permanent erasure"
    );
  } finally {
    canary.fill(0);
  }
}

function createSubtitleErasureAttestation(subtitleObjectStore, lifecycle, rawOptions) {
  const options = resolveSubtitleErasureHealthOptions(rawOptions);
  if (
    typeof subtitleObjectStore.purgeNamespace !== "function" ||
    typeof subtitleObjectStore.deleteVersion !== "function"
  ) {
    throw new TypeError(
      "subtitle object store must provide purgeNamespace() and deleteVersion() in production"
    );
  }
  const namespaceScope = createErasureCanaryNonce(options.randomBytes);
  let attestedAt = null;
  let inFlight = null;
  return async (deadline) => {
    const now = Number(lifecycle.timers.now());
    if (!Number.isFinite(now)) throw new TypeError("storage lifecycle clock is invalid");
    if (
      attestedAt !== null &&
      now >= attestedAt &&
      now - attestedAt < options.attestationFreshnessMs
    ) {
      return;
    }
    if (!inFlight) {
      const task = runSubtitleErasureAttestation(
        subtitleObjectStore,
        deadline,
        lifecycle,
        namespaceScope,
        options.randomBytes
      ).then(() => {
        const completedAt = Number(lifecycle.timers.now());
        if (!Number.isFinite(completedAt)) {
          throw new TypeError("storage lifecycle clock is invalid");
        }
        attestedAt = completedAt;
      });
      inFlight = task;
      task.then(
        () => {
          if (inFlight === task) inFlight = null;
        },
        () => {
          if (inFlight === task) inFlight = null;
        }
      );
    }
    const pending = inFlight;
    await boundedSubtitleHealthOperation(() => pending, deadline, lifecycle);
  };
}

function createSubtitleStorageHealth(
  client,
  subtitleObjectStore,
  config,
  lifecycle,
  erasureHealthOptions
) {
  const attestPermanentErasure =
    isProductionLikeEnvironment(config.environment)
      ? createSubtitleErasureAttestation(
          subtitleObjectStore,
          lifecycle,
          erasureHealthOptions
        )
      : null;
  return {
    kind: "subtitle object storage",
    run: async (context = {}) => {
      try {
        assertProductionSubtitleErasureReadiness(config);
        const {
          GetBucketAclCommand,
          GetBucketPolicyStatusCommand,
          GetObjectAclCommand,
          GetPublicAccessBlockCommand,
          HeadBucketCommand,
        } = require("@aws-sdk/client-s3");
        const timeoutMs = Number.isSafeInteger(context.timeoutMs)
          ? context.timeoutMs
          : lifecycle.readinessMs;
        if (timeoutMs < 1) throw new TypeError("subtitle readiness timeout is invalid");
        const startedAt = Number(lifecycle.timers.now());
        if (!Number.isFinite(startedAt)) {
          throw new TypeError("storage lifecycle clock is invalid");
        }
        const outerMarginMs =
          timeoutMs > 1
            ? Math.min(
                timeoutMs - 1,
                Math.max(1, Math.floor(timeoutMs / 4)),
                Math.max(5, Math.ceil(timeoutMs / 10))
              )
            : 0;
        const healthBudgetMs = Math.max(1, timeoutMs - outerMarginMs);
        const deadline = startedAt + healthBudgetMs;
        const input = { Bucket: config.subtitleS3.bucket };
        if (config.subtitleS3.privacyMode === "strict") {
          await boundedSubtitleHealthOperation(
            (signal) => client.send(new HeadBucketCommand(input), { abortSignal: signal }),
            deadline,
            lifecycle
          );
          assertPublicAccessBlock(
            await boundedSubtitleHealthOperation(
              (signal) =>
                client.send(new GetPublicAccessBlockCommand(input), {
                  abortSignal: signal,
                }),
              deadline,
              lifecycle
            )
          );
          assertPrivateBucketPolicy(
            await boundedSubtitleHealthOperation(
              (signal) =>
                client.send(new GetBucketPolicyStatusCommand(input), {
                  abortSignal: signal,
                }),
              deadline,
              lifecycle
            )
          );
        } else {
          const canaryKey = subtitleObjectStore.createKey([
            "privacy-readiness-canary-v1",
          ]);
          const canary = Buffer.from([0xa5]);
          const checksumSha256 = crypto
            .createHash("sha256")
            .update(canary)
            .digest("hex");
          try {
            await boundedSubtitleHealthOperation(
              (signal) => client.send(new HeadBucketCommand(input), { abortSignal: signal }),
              deadline,
              lifecycle
            );
            const bucketOwnerId = assertPrivateAcl(
              await boundedSubtitleHealthOperation(
                (signal) =>
                  client.send(new GetBucketAclCommand(input), { abortSignal: signal }),
                deadline,
                lifecycle
              ),
              "bucket"
            );
            assertPrivateBucketPolicy(
              await boundedSubtitleHealthOperation(
                (signal) =>
                  client.send(new GetBucketPolicyStatusCommand(input), {
                    abortSignal: signal,
                  }),
                deadline,
                lifecycle
              )
            );
            const written = await boundedSubtitleHealthOperation(
              (signal) =>
                subtitleObjectStore.put(canaryKey, canary, {
                  checksumSha256,
                  contentLength: canary.length,
                  contentType: "application/octet-stream",
                  signal,
                }),
              deadline,
              lifecycle
            );
            if (
              !written ||
              written.key !== canaryKey ||
              written.checksumSha256 !== checksumSha256 ||
              written.contentLength !== canary.length ||
              written.contentType !== "application/octet-stream"
            ) {
              throw new Error("subtitle privacy canary write attestation failed");
            }
            let canaryVersionId = written.versionId;
            if (canaryVersionId === undefined) {
              const current = await boundedSubtitleHealthOperation(
                (signal) =>
                  subtitleObjectStore.head(canaryKey, {
                    checksumSha256,
                    contentLength: canary.length,
                    maxBytes: canary.length,
                    signal,
                  }),
                deadline,
                lifecycle
              );
              if (
                !current ||
                current.key !== canaryKey ||
                current.checksumSha256 !== checksumSha256 ||
                current.contentLength !== canary.length ||
                current.contentType !== "application/octet-stream" ||
                typeof current.versionId !== "string" ||
                current.versionId.length === 0 ||
                current.versionId === "null"
              ) {
                throw new Error("subtitle privacy canary version discovery failed");
              }
              canaryVersionId = current.versionId;
            }
            if (
              typeof canaryVersionId !== "string" ||
              canaryVersionId.length === 0 ||
              canaryVersionId === "null"
            ) {
              throw new Error("subtitle privacy canary write attestation failed");
            }
            const stored = await boundedSubtitleHealthOperation(
              (signal) =>
                subtitleObjectStore.head(canaryKey, {
                  checksumSha256,
                  contentLength: canary.length,
                  maxBytes: canary.length,
                  signal,
                  versionId: canaryVersionId,
                }),
              deadline,
              lifecycle
            );
            if (
              !stored ||
              stored.key !== canaryKey ||
              stored.checksumSha256 !== checksumSha256 ||
              stored.contentLength !== canary.length ||
              stored.contentType !== "application/octet-stream" ||
              stored.versionId !== canaryVersionId
            ) {
              throw new Error("subtitle privacy canary storage attestation failed");
            }
            let fetchedBody = null;
            try {
              const fetched = await boundedSubtitleHealthOperation(
                (signal) =>
                  subtitleObjectStore.get(canaryKey, {
                    checksumSha256,
                    contentLength: canary.length,
                    maxBytes: canary.length,
                    signal,
                    versionId: canaryVersionId,
                  }),
                deadline,
                lifecycle
              );
              fetchedBody = fetched && fetched.body;
              if (
                !fetched ||
                fetched.key !== canaryKey ||
                fetched.checksumSha256 !== checksumSha256 ||
                fetched.contentLength !== canary.length ||
                fetched.contentType !== "application/octet-stream" ||
                fetched.versionId !== canaryVersionId ||
                !Buffer.isBuffer(fetchedBody) ||
                fetchedBody.length !== canary.length ||
                !crypto.timingSafeEqual(fetchedBody, canary)
              ) {
                throw new Error("subtitle privacy canary body attestation failed");
              }
            } finally {
              if (Buffer.isBuffer(fetchedBody)) fetchedBody.fill(0);
            }
            const objectAcl = await boundedSubtitleHealthOperation(
              (signal) =>
                client.send(
                  new GetObjectAclCommand({
                    ...input,
                    Key: canaryKey,
                    VersionId: canaryVersionId,
                  }),
                  { abortSignal: signal }
                ),
              deadline,
              lifecycle
            );
            const objectOwnerId = assertPrivateAcl(objectAcl, "object");
            if (objectOwnerId !== bucketOwnerId) {
              throw new Error("subtitle object owner does not match the configured bucket owner");
            }
          } finally {
            canary.fill(0);
          }
        }
        if (attestPermanentErasure) await attestPermanentErasure(deadline);
      } catch (error) {
        if (
          localFailureDetails(error)?.code ===
          "subtitle_permanent_erasure_unverifiable"
        ) {
          throw error;
        }
        throw subtitleStorageError("readiness");
      }
    },
  };
}

function assertSubtitleStorageComposition(config, options) {
  const expectedFingerprint = subtitleObjectKeyAuthorityFingerprint(
    config.subtitleObjectKeys
  );
  if (
    isProductionLikeEnvironment(config.environment) &&
    (options.objectKeyFactory !== undefined ||
      options.subtitleObjectStore !== undefined ||
      options.subtitleS3Client !== undefined ||
      options.createSubtitleS3Client !== undefined)
  ) {
    throw new TypeError(
      "production subtitle storage does not allow injected clients, factories, or stores"
    );
  }
  if (options.objectKeyFactory !== undefined) {
    assertObjectKeyAuthority(options.objectKeyFactory, expectedFingerprint);
  }
  if (options.subtitleObjectStore !== undefined) {
    if (
      options.subtitleS3Client !== undefined ||
      options.createSubtitleS3Client !== undefined ||
      options.subtitleObjectStoreOptions !== undefined
    ) {
      throw new TypeError("injected subtitleObjectStore may not override its S3 composition");
    }
    assertHardenedSubtitleObjectStore(
      options.subtitleObjectStore,
      expectedFingerprint,
      config
    );
  } else {
    readSubtitleStoreOptions(options);
    if (
      options.createSubtitleS3Client !== undefined &&
      typeof options.createSubtitleS3Client !== "function"
    ) {
      throw new TypeError("createSubtitleS3Client must be a function");
    }
  }
  return expectedFingerprint;
}

function createSubtitleStorageComponents(config, options, closers, lifecycle) {
  const expectedFingerprint = assertSubtitleStorageComposition(config, options);

  const configuredAuthority = createSubtitleObjectKeyFactory(config.subtitleObjectKeys);
  const objectKeyFactory =
    options.objectKeyFactory === undefined
      ? configuredAuthority
      : assertObjectKeyAuthority(options.objectKeyFactory, expectedFingerprint);

  if (options.subtitleObjectStore !== undefined) {
    if (
      options.subtitleS3Client !== undefined ||
      options.createSubtitleS3Client !== undefined ||
      options.subtitleObjectStoreOptions !== undefined
    ) {
      throw new TypeError("injected subtitleObjectStore may not override its S3 composition");
    }
    const attestation = assertHardenedSubtitleObjectStore(
      options.subtitleObjectStore,
      expectedFingerprint,
      config
    );
    addSubtitleS3ClientCloser(
      attestation.client,
      options.closeInjectedResources === true,
      options,
      closers
    );
    return {
      health: createSubtitleStorageHealth(
        attestation.client,
        options.subtitleObjectStore,
        config,
        lifecycle
      ),
      objectKeyFactory,
      subtitleObjectStore: options.subtitleObjectStore,
    };
  }

  const subtitleObjectStoreOptions = readSubtitleStoreOptions(options);
  const createClient =
    options.createSubtitleS3Client === undefined
      ? defaultCreateSubtitleS3Client
      : options.createSubtitleS3Client;
  if (typeof createClient !== "function") {
    throw new TypeError("createSubtitleS3Client must be a function");
  }
  const injectedClient = options.subtitleS3Client;
  let client;
  try {
    client =
      injectedClient !== undefined
        ? injectedClient
        : createClient({
            credentials: {
              accessKeyId: config.subtitleS3.accessKeyId,
              secretAccessKey: config.subtitleS3.secretAccessKey,
            },
            endpoint: config.subtitleS3.endpoint,
            forcePathStyle: config.subtitleS3.forcePathStyle,
            maxAttempts: 2,
            region: config.subtitleS3.region,
            requestChecksumCalculation: "WHEN_SUPPORTED",
            responseChecksumValidation: "WHEN_SUPPORTED",
          });
  } catch (_error) {
    throw subtitleStorageError("initialization");
  }
  addSubtitleS3ClientCloser(
    client,
    injectedClient === undefined || options.closeInjectedResources === true,
    options,
    closers
  );

  const subtitleObjectStore = createHardenedSubtitleObjectStore(config, {
    client,
    subtitleObjectStoreOptions,
  });
  assertHardenedSubtitleObjectStore(subtitleObjectStore, expectedFingerprint, config);

  return {
    health: createSubtitleStorageHealth(
      client,
      subtitleObjectStore,
      config,
      lifecycle
    ),
    objectKeyFactory,
    subtitleObjectStore,
  };
}

function readLifecycleTimeout(source, name) {
  const value = source[name] ?? DEFAULT_LIFECYCLE_TIMEOUTS[name];
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIFECYCLE_TIMEOUT_MS) {
    throw new TypeError("storage lifecycle " + name + " is invalid");
  }
  return value;
}

function resolveLifecycle(options) {
  const source = options.lifecycleTimeouts || options.timeouts || {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("storage lifecycle timeouts are invalid");
  }
  const timerSource = options.lifecycleTimers || {};
  if (!timerSource || typeof timerSource !== "object" || Array.isArray(timerSource)) {
    throw new TypeError("storage lifecycle timers are invalid");
  }
  const timers = {
    setTimeout: timerSource.setTimeout || setTimeout,
    clearTimeout: timerSource.clearTimeout || clearTimeout,
    now: timerSource.now || Date.now,
  };
  if (
    typeof timers.setTimeout !== "function" ||
    typeof timers.clearTimeout !== "function" ||
    typeof timers.now !== "function"
  ) {
    throw new TypeError("storage lifecycle timers are invalid");
  }
  return {
    startupMs: readLifecycleTimeout(source, "startupMs"),
    migrationMs: readLifecycleTimeout(source, "migrationMs"),
    connectMs: readLifecycleTimeout(source, "connectMs"),
    readinessMs: readLifecycleTimeout(source, "readinessMs"),
    shutdownMs: readLifecycleTimeout(source, "shutdownMs"),
    timers,
  };
}

function timeoutError(phase, timeoutMs) {
  const message = phase + " timed out after " + timeoutMs + "ms";
  const error = new Error(message);
  error.code = "storage_timeout";
  error.phase = phase;
  error.timeoutMs = timeoutMs;
  const details = Object.freeze({
    code: "storage_timeout",
    message,
    phase,
    timeoutMs,
  });
  LOCAL_TIMEOUT_DETAILS.set(error, details);
  return rememberLocalFailure(error, details);
}

function runDetached(work) {
  try {
    const result = work();
    if (result && typeof result.then === "function") result.catch(() => {});
  } catch (_error) {
    // The bounded lifecycle error remains authoritative.
  }
}

function withTimeout(work, timeoutMs, phase, lifecycle, onTimeout) {
  let timeoutHandle;
  const operation = Promise.resolve().then(work);
  const timeout = new Promise((resolve, reject) => {
    timeoutHandle = lifecycle.timers.setTimeout(() => {
      const error = timeoutError(phase, timeoutMs);
      if (typeof onTimeout === "function") runDetached(() => onTimeout(error));
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutHandle !== undefined) lifecycle.timers.clearTimeout(timeoutHandle);
  });
}

function createStartupBudget(lifecycle) {
  const startedAt = Number(lifecycle.timers.now());
  if (!Number.isFinite(startedAt)) throw new TypeError("storage lifecycle clock is invalid");
  let deadline = startedAt + lifecycle.startupMs;
  return {
    remaining(phase) {
      const now = Number(lifecycle.timers.now());
      if (!Number.isFinite(now)) throw new TypeError("storage lifecycle clock is invalid");
      const remainingMs = Math.floor(deadline - now);
      if (remainingMs < 1) throw timeoutError(phase || "storage startup", lifecycle.startupMs);
      return remainingMs;
    },
    run(work, phase, phaseTimeoutMs, onTimeout) {
      const timeoutMs = Math.min(phaseTimeoutMs, this.remaining("storage startup"));
      return withTimeout(work, timeoutMs, phase, lifecycle, onTimeout);
    },
    phaseDeadline(phaseTimeoutMs) {
      const now = Number(lifecycle.timers.now());
      if (!Number.isFinite(now)) throw new TypeError("storage lifecycle clock is invalid");
      const remainingMs = Math.floor(deadline - now);
      if (remainingMs < 1) throw timeoutError("storage startup", lifecycle.startupMs);
      const timeoutMs = Math.min(phaseTimeoutMs, remainingMs);
      return { deadlineMs: now + timeoutMs, timeoutMs };
    },
    acceptSynchronousCommit() {
      const now = Number(lifecycle.timers.now());
      if (!Number.isFinite(now)) throw new TypeError("storage lifecycle clock is invalid");
      // A synchronous SQLite COMMIT cannot be interrupted after its pre-commit deadline gate.
      // Never report that atomic work as timed out after it has already committed successfully.
      if (now >= deadline) deadline = now + lifecycle.startupMs;
    },
  };
}

function addErrorListener(resource, kind, options) {
  if (!resource || typeof resource.on !== "function") return () => {};
  const listener = (error) => {
    if (typeof options.onStorageError === "function") options.onStorageError(kind, error);
  };
  resource.on("error", listener);
  return () => {
    if (typeof resource.off === "function") resource.off("error", listener);
    else if (typeof resource.removeListener === "function") resource.removeListener("error", listener);
  };
}

function forceRedisClient(client) {
  if (!client) return;
  if (typeof client.destroy === "function") {
    client.destroy();
    return;
  }
  if (typeof client.disconnect === "function") runDetached(() => client.disconnect());
}

function forcePostgresDatabase(database, pool) {
  const target = pool || (database && database.pool) || database;
  if (!target) return;
  if (typeof target.destroy === "function") {
    target.destroy();
    return;
  }
  if (!Array.isArray(target._clients)) return;
  for (const client of Array.from(target._clients)) {
    try {
      if (client && typeof client.release === "function") client.release(true);
      else if (client && client.connection && client.connection.stream) {
        client.connection.stream.destroy();
      }
    } catch (_error) {
      // Continue forcing the rest of the owned pool closed.
    }
  }
}

function rememberCleanupFailure(error, kind) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  const phase = CLEANUP_PHASE_BY_KIND[kind] || "storage shutdown";
  const timeout = LOCAL_TIMEOUT_DETAILS.get(error);
  LOCAL_CLEANUP_DETAILS.set(
    error,
    Object.freeze({
      code: timeout ? timeout.code : "storage_cleanup_failed",
      phase,
      ...(timeout ? { timeoutMs: timeout.timeoutMs } : {}),
    })
  );
}

async function closeResourceStack(closers, lifecycle) {
  const errors = [];
  for (let index = closers.length - 1; index >= 0; index -= 1) {
    const closer = closers[index];
    let forced = false;
    let forceError = null;
    const forceOnce = () => {
      if (forced || typeof closer.force !== "function") return;
      forced = true;
      try {
        closer.force();
      } catch (error) {
        forceError = error;
      }
    };
    try {
      if (typeof closer.close === "function") {
        await withTimeout(
          closer.close,
          lifecycle.shutdownMs,
          closer.kind + " shutdown",
          lifecycle,
          forceOnce
        );
      }
    } catch (error) {
      runDetached(forceOnce);
      rememberCleanupFailure(error, closer.kind);
      errors.push(error);
    } finally {
      if (forceError) {
        rememberCleanupFailure(forceError, closer.kind);
        errors.push(forceError);
      }
      try {
        closer.detach();
      } catch (error) {
        rememberCleanupFailure(error, closer.kind);
        errors.push(error);
      }
    }
  }
  return errors;
}

function attachCleanupErrors(error, cleanupErrors, fallbackDetails) {
  if (!Array.isArray(cleanupErrors) || cleanupErrors.length === 0) return error;
  const records = Object.freeze(
    cleanupErrors.map((source) => {
      const trusted =
        source && (typeof source === "object" || typeof source === "function")
          ? LOCAL_CLEANUP_DETAILS.get(source)
          : null;
      return Object.freeze(
        trusted
          ? {
              code: trusted.code,
              phase: trusted.phase,
              ...(trusted.timeoutMs === undefined
                ? {}
                : { timeoutMs: trusted.timeoutMs }),
            }
          : {
              code: "storage_cleanup_failed",
              phase: "storage shutdown",
            }
      );
    })
  );
  const details = localFailureDetails(error) || fallbackDetails || {
    code: "storage_operation_failed",
    message: "storage operation failed",
    phase: "storage operation",
  };
  const replacement = new Error(details.message);
  Object.defineProperties(replacement, {
    cleanupErrors: {
      configurable: false,
      enumerable: false,
      value: records,
      writable: false,
    },
    code: {
      configurable: false,
      enumerable: true,
      value: details.code,
      writable: false,
    },
    phase: {
      configurable: false,
      enumerable: true,
      value: details.phase,
      writable: false,
    },
    ...(details.timeoutMs === undefined
      ? {}
      : {
          timeoutMs: {
            configurable: false,
            enumerable: true,
            value: details.timeoutMs,
            writable: false,
          },
        }),
  });
  return Object.freeze(replacement);
}

function assertPong(value) {
  if (typeof value !== "string" || value.toUpperCase() !== "PONG") {
    throw new Error("Redis readiness check did not return PONG");
  }
}

function redisReplyString(value, name) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string") return value;
  throw new Error("Redis readiness " + name + " reply is invalid");
}

function redisOwnDataValue(error, name) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, name);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function redisOwnDataMessage(error) {
  if (typeof error === "string") return error;
  const message = redisOwnDataValue(error, "message");
  return typeof message === "string" ? message : "";
}

function redisSimpleErrorPrototype() {
  if (REDIS_SIMPLE_ERROR_PROTOTYPE === undefined) {
    const { SimpleError } = require("redis");
    if (typeof SimpleError !== "function" || !SimpleError.prototype) {
      throw new Error("Redis client SimpleError type is unavailable");
    }
    REDIS_SIMPLE_ERROR_PROTOTYPE = SimpleError.prototype;
  }
  return REDIS_SIMPLE_ERROR_PROTOTYPE;
}

function isExactUpstashRoleUnavailable(error) {
  try {
    if (!(error instanceof Error)) return false;
    return (
      redisOwnDataMessage(error) === UPSTASH_ROLE_UNAVAILABLE_MESSAGE &&
      Object.getPrototypeOf(error) === redisSimpleErrorPrototype() &&
      Object.getOwnPropertyDescriptor(error, "code") === undefined
    );
  } catch {
    return false;
  }
}

function redisClusterUnsupported(cause) {
  const error = new Error(
    "Redis Cluster is unsupported; configure one standalone writable primary"
  );
  error.code = "redis_cluster_unsupported";
  if (cause !== undefined) error.cause = cause;
  return error;
}

function normalizeRedisTopologyError(error) {
  if (redisOwnDataValue(error, "code") === "redis_cluster_unsupported") return error;
  const message = redisOwnDataMessage(error);
  if (/(?:^|\s)(?:MOVED|CROSSSLOT)(?:\s|$)/i.test(message)) {
    return redisClusterUnsupported(error);
  }
  return error;
}

async function assertRedisStandaloneTopology(client) {
  if (typeof client.sendCommand !== "function") {
    throw new TypeError("Redis client must provide sendCommand() for readiness checks");
  }
  const raw = redisReplyString(
    await client.sendCommand(["INFO", "cluster"]),
    "INFO cluster"
  );
  const values = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("cluster_enabled:"))
    .map((line) => line.slice("cluster_enabled:".length));
  if (values.length !== 1 || (values[0] !== "0" && values[0] !== "1")) {
    const error = new Error("Redis INFO cluster readiness reply is invalid");
    error.code = "redis_topology_invalid";
    throw error;
  }
  if (values[0] === "1") throw redisClusterUnsupported();
}

async function assertRedisWritablePrimary(client, keyspace) {
  if (typeof client.sendCommand !== "function") {
    throw new TypeError("Redis client must provide sendCommand() for readiness checks");
  }
  if (!keyspace || typeof keyspace.key !== "function") {
    throw new TypeError("Redis readiness keyspace is invalid");
  }
  let role;
  let roleUnavailable = false;
  try {
    role = await client.sendCommand(["ROLE"]);
  } catch (error) {
    if (!isExactUpstashRoleUnavailable(error)) throw error;
    roleUnavailable = true;
  }
  if (!roleUnavailable) {
    if (!Array.isArray(role) || role.length < 1) {
      throw new Error("Redis ROLE readiness reply is invalid");
    }
    if (redisReplyString(role[0], "ROLE").toLowerCase() !== "master") {
      const error = new Error("Redis readiness requires a writable primary");
      error.code = "redis_not_primary";
      throw error;
    }
  }

  const nonce = crypto.randomBytes(16).toString("hex");
  const probeKey = keyspace.key("readiness", nonce);
  let created = false;
  try {
    const stored = await client.sendCommand([
      "SET",
      probeKey,
      nonce,
      "NX",
      "PX",
      String(REDIS_READINESS_PROBE_TTL_MS),
    ]);
    if (redisReplyString(stored, "write") !== "OK") {
      throw new Error("Redis readiness write probe was not stored");
    }
    created = true;
  } finally {
    if (created) {
      const removed = await client.sendCommand(["DEL", probeKey]);
      if (removed !== 1) throw new Error("Redis readiness write probe cleanup failed");
    }
  }
}

function runBoundedPostgresReadinessProbe(
  database,
  startup,
  lifecycle,
  phase,
  force
) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("PostgreSQL database must provide query()");
  }
  return startup.run(
    () => database.query(POSTGRES_READINESS_QUERY),
    phase,
    lifecycle.readinessMs,
    force
  );
}

function assertRedisReleaseProtocolCompatibility(status, expectedAction) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("Redis release protocol status is invalid");
  }
  const compatible =
    expectedAction === "initialize-v5"
      ? status.state === "missing" ||
        (status.state === "ready" && status.version === "5")
      : expectedAction === "advance-v6"
        ? status.state === "ready" &&
          (status.version === "5" || status.version === "6")
        : expectedAction === "initialize-or-advance-v6"
          ? status.state === "missing" ||
            (status.state === "ready" &&
              (status.version === "5" || status.version === "6"))
        : false;
  if (!compatible) {
    const error = new Error("Redis release protocol state is incompatible with this rollout");
    error.code = "redis_release_protocol_incompatible";
    throw error;
  }
  return status;
}

function productionPreflightError(phase, error) {
  if (
    phase === "subtitle" &&
    localFailureDetails(error)?.code ===
      "subtitle_permanent_erasure_unverifiable"
  ) {
    return subtitleErasureError("production subtitle storage preflight failed");
  }
  const message = "production " + phase + " storage preflight failed";
  const code = "production_" + phase + "_preflight_failed";
  const failure = new Error(message);
  failure.code = code;
  return rememberLocalFailure(failure, {
    code,
    message,
    phase: "production " + phase + " storage preflight",
  });
}

async function runProductionStoragePreflight(config, options = {}) {
  const safeConfig = assertStorageConfig(config);
  const requiredEnvironment = options.requiredEnvironment || "production";
  if (requiredEnvironment !== "production" && requiredEnvironment !== "uat") {
    throw new TypeError("production storage preflight environment is invalid");
  }
  if (
    safeConfig.environment !== requiredEnvironment ||
    safeConfig.durableDriver !== "postgres" ||
    safeConfig.ttlDriver !== "redis"
  ) {
    throw new TypeError(
      requiredEnvironment + " storage preflight requires PostgreSQL and Redis"
    );
  }
  const expectedRedisAction = options.expectedRedisAction;
  if (
    expectedRedisAction !== "initialize-v5" &&
    expectedRedisAction !== "advance-v6" &&
    expectedRedisAction !== "initialize-or-advance-v6"
  ) {
    throw new TypeError("production storage preflight Redis action is invalid");
  }

  const lifecycle = resolveLifecycle(options);
  const startup = createStartupBudget(lifecycle);
  const closers = [];
  let phase = "initialization";
  let failure = null;
  let result = null;
  try {
    phase = "postgres";
    const postgres = require("./postgres");
    const pool = defaultCreatePostgresPool({
      connectionString: safeConfig.databaseUrl,
      connectionTimeoutMillis: lifecycle.connectMs,
      max: 1,
    });
    let database = null;
    let postgresEndAttempted = false;
    let postgresForced = false;
    let detachPostgresErrorListener = () => {};
    const forcePostgresOnce = () => {
      if (postgresForced) return;
      postgresForced = true;
      forcePostgresDatabase(database, pool);
    };
    closers.push({
      kind: "PostgreSQL",
      close: async () => {
        if (postgresEndAttempted) return;
        postgresEndAttempted = true;
        const target = database || pool;
        if (!target || typeof target.end !== "function") {
          throw new TypeError("PostgreSQL preflight resource must provide end()");
        }
        await target.end();
      },
      force: forcePostgresOnce,
      detach: () => detachPostgresErrorListener(),
    });
    detachPostgresErrorListener = addErrorListener(
      pool,
      "postgres-preflight",
      {}
    );
    database = new postgres.PostgresDatabase({ pool });
    await runBoundedPostgresReadinessProbe(
      database,
      startup,
      lifecycle,
      "production PostgreSQL preflight readiness",
      forcePostgresOnce
    );

    phase = "subtitle";
    const subtitleStorage = createSubtitleStorageComponents(
      safeConfig,
      {},
      closers,
      lifecycle
    );
    phase = "redis";
    const redis = require("./redis");
    const {
      getPlaybackClaimWriterProtocolStatus,
    } = require("./redis/playback-claim-writer-protocol");
    const client = defaultCreateRedisClient({ url: safeConfig.redisUrl });
    let connected = false;
    let forced = false;
    let detachErrorListener = () => {};
    const forceRedisOnce = () => {
      if (forced) return;
      forced = true;
      forceRedisClient(client);
    };
    closers.push({
      kind: "Redis preflight",
      close: async () => {
        if (!connected) {
          forceRedisOnce();
          return;
        }
        if (typeof client.quit === "function") await client.quit();
        else if (typeof client.close === "function") await client.close();
        else throw new TypeError("Redis client must provide quit() or close()");
        connected = false;
      },
      force: forceRedisOnce,
      detach: () => detachErrorListener(),
    });
    if (!client || typeof client.connect !== "function") {
      throw new TypeError("Redis client must provide connect()");
    }
    detachErrorListener = addErrorListener(client, "redis-preflight", {});

    await startup.run(
      () => client.connect(),
      "production Redis preflight connect",
      lifecycle.connectMs,
      forceRedisOnce
    );
    connected = true;
    const redisKeyspace = new redis.RedisKeyspace();
    let redisVersion;
    let redisProtocol;
    await startup.run(
      async () => {
        if (typeof client.ping !== "function") {
          throw new TypeError("Redis client must provide ping()");
        }
        assertPong(await client.ping());
        redisVersion = await redis.assertRedisSupportedVersion(client);
        await assertRedisStandaloneTopology(client);
        await redis.assertRedisNoEvictionPolicy(client);
        await assertRedisWritablePrimary(client, redisKeyspace);
        redisProtocol = assertRedisReleaseProtocolCompatibility(
          await getPlaybackClaimWriterProtocolStatus(client, { keyspace: redisKeyspace }),
          expectedRedisAction
        );
      },
      "production Redis preflight",
      lifecycle.readinessMs,
      forceRedisOnce
    );

    phase = "subtitle";
    const subtitleTimeoutMs = Math.min(
      lifecycle.readinessMs,
      startup.remaining("production subtitle storage preflight")
    );
    await startup.run(
      () => subtitleStorage.health.run({ timeoutMs: subtitleTimeoutMs }),
      "production subtitle storage preflight",
      subtitleTimeoutMs
    );
    result = Object.freeze({
      redis: Object.freeze({
        major: redisVersion.major,
        protocolState: redisProtocol.state,
        protocolVersion: redisProtocol.version,
        version: redisVersion.version,
      }),
      subtitle: Object.freeze({ attested: true }),
    });
  } catch (error) {
    failure = productionPreflightError(phase, error);
  }

  const cleanupErrors = await closeResourceStack(closers, lifecycle);
  if (failure) {
    throw attachCleanupErrors(failure, cleanupErrors);
  }
  if (cleanupErrors.length > 0) {
    throw attachCleanupErrors(
      productionPreflightError("cleanup"),
      cleanupErrors
    );
  }
  return result;
}

function createRuntime(config, primitives, repositories, healthChecks, closers, metadata) {
  let state = "ready";
  let closePromise = null;
  const lifecycle = metadata.lifecycle;

  function assertReadyState() {
    if (state !== "ready") {
      const error = new Error("storage runtime is " + state);
      error.code = "storage_not_ready";
      throw error;
    }
  }

  async function runReadiness(timeoutMs) {
    assertReadyState();
    try {
      const startedAt = Number(lifecycle.timers.now());
      if (!Number.isFinite(startedAt)) throw new TypeError("storage lifecycle clock is invalid");
      const deadline = startedAt + timeoutMs;
      for (const check of [
        healthChecks.durable,
        healthChecks.ttl,
        healthChecks.subtitleObjectStorage,
      ].filter(Boolean)) {
        assertReadyState();
        const now = Number(lifecycle.timers.now());
        if (!Number.isFinite(now)) throw new TypeError("storage lifecycle clock is invalid");
        const remainingMs = Math.floor(deadline - now);
        if (remainingMs < 1) {
          throw timeoutError("storage readiness", timeoutMs);
        }
        await withTimeout(
          () => check.run({ timeoutMs: remainingMs }),
          remainingMs,
          check.kind + " readiness",
          lifecycle
        );
        assertReadyState();
      }
      assertReadyState();
      return {
        status: "ready",
        durableDriver: config.durableDriver,
        ttlDriver: config.ttlDriver,
      };
    } catch (error) {
      let failure = error;
      if (
        metadata.startupComplete &&
        localFailureDetails(error)?.code === "storage_timeout" &&
        state === "ready"
      ) {
        try {
          await close();
        } catch (cleanupError) {
          failure = attachCleanupErrors(
            error,
            cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError],
            STORAGE_READINESS_FAILURE_DETAILS
          );
        }
      }
      throw failure;
    }
  }

  function ready() {
    return runReadiness(lifecycle.readinessMs);
  }

  function close() {
    if (closePromise) return closePromise;
    state = "closing";
    closePromise = (async () => {
      let errors = [];
      try {
        errors = await closeResourceStack(closers, lifecycle);
      } finally {
        state = "closed";
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "storage runtime shutdown failed");
    })();
    return closePromise;
  }

  const runtime = {
    repositories,
    subtitleObjectStore: metadata.subtitleObjectStore || null,
    tokenService: primitives.tokenService,
    envelopeCrypto: primitives.envelopeCrypto,
    migrationResult: metadata.migrationResult,
    ready,
    healthCheck: ready,
    close,
  };
  Object.defineProperty(runtime, "state", {
    enumerable: true,
    get() {
      return state;
    },
  });
  return { runReadiness, runtime };
}

async function createStorageRuntime(config, options = {}) {
  const safeConfig = assertStorageConfig(config);
  const lifecycle = resolveLifecycle(options);
  if (safeConfig.ttlDriver === "redis") {
    assertSubtitleStorageComposition(safeConfig, options);
  }
  const startup = createStartupBudget(lifecycle);
  const primitives = assertPrimitives(options.primitives || createStoragePrimitives(safeConfig, options));
  const closers = [];
  let durableRepositories;
  let ttlRepositories;
  let subtitleObjectStore = null;
  let objectKeyFactory = null;
  let migrationResult = null;
  let durableHealth = { kind: "durable storage", run: async () => {} };
  let ttlHealth = { kind: "TTL storage", run: async () => {} };
  let subtitleObjectStorageHealth = null;

  try {
    if (safeConfig.durableDriver === "memory") {
      durableRepositories = createMemoryDurableRepositories(primitives, options);
      startup.remaining("storage startup");
    } else if (safeConfig.durableDriver === "sqlite") {
      const sqlite = require("./sqlite");
      const injectedDatabase = options.sqliteDatabase;
      if (!injectedDatabase) fs.mkdirSync(path.dirname(path.resolve(safeConfig.sqlitePath)), { recursive: true });
      const sqliteMigrationDeadline = startup.phaseDeadline(lifecycle.migrationMs);
      let sqliteRepositories;
      try {
        sqliteRepositories = sqlite.createSqliteDurableRepositories({
          ...(options.sqliteRepositoryOptions || {}),
          database: injectedDatabase,
          filename: safeConfig.sqlitePath,
          tokenService: primitives.tokenService,
          envelopeCrypto: primitives.envelopeCrypto,
          clock: options.clock,
          migrate: true,
          migrationDeadlineMs: sqliteMigrationDeadline.deadlineMs,
          migrationTimeoutMs: sqliteMigrationDeadline.timeoutMs,
          migrationNow: lifecycle.timers.now,
          migrationPhase: "SQLite migration",
        });
      } catch (error) {
        if (
          injectedDatabase &&
          options.closeInjectedResources === true &&
          typeof injectedDatabase.close === "function" &&
          injectedDatabase.open !== false
        ) {
          try {
            injectedDatabase.close();
          } catch (cleanupError) {
            error = attachCleanupErrors(
              error,
              [cleanupError],
              STORAGE_STARTUP_FAILURE_DETAILS
            );
          }
        }
        throw error;
      }
      durableRepositories = sqliteRepositories;
      migrationResult = sqliteRepositories.migrationResult;
      durableHealth = {
        kind: "SQLite",
        run: async () => {
          sqliteRepositories.database.prepare("SELECT 1 AS ready").get();
        },
      };
      if (sqliteRepositories.ownsDatabase || options.closeInjectedResources === true) {
        closers.push({
          kind: "SQLite",
          close: async () => sqliteRepositories.close(),
          detach: () => {},
        });
      }
      startup.acceptSynchronousCommit();
    } else {
      const postgres = require("./postgres");
      const createPool = options.createPostgresPool || defaultCreatePostgresPool;
      const injectedDatabase = options.postgresDatabase;
      const injectedPool = options.postgresPool;
      const pool = injectedDatabase
        ? null
        : injectedPool ||
          createPool({
            ...(options.postgresPoolOptions || {}),
            connectionString: safeConfig.databaseUrl,
          });
      let database = injectedDatabase || null;
      const ownsDatabase = Boolean(!injectedDatabase && !injectedPool);
      const closesDatabase = ownsDatabase || options.closeInjectedResources === true;
      let postgresEndAttempted = false;
      let postgresForced = false;
      let detachErrorListener = () => {};
      const forcePostgresOnce = () => {
        if (!closesDatabase || postgresForced) return;
        postgresForced = true;
        forcePostgresDatabase(database, pool);
      };
      closers.push({
        kind: "PostgreSQL",
        close: closesDatabase
          ? async () => {
              if (postgresEndAttempted) return;
              postgresEndAttempted = true;
              const target = database || pool;
              if (!target || typeof target.end !== "function") {
                throw new TypeError("owned PostgreSQL resource must provide end()");
              }
              await target.end();
            }
          : null,
        force: closesDatabase ? forcePostgresOnce : null,
        detach: () => detachErrorListener(),
      });
      detachErrorListener = addErrorListener(pool, "postgres", options);
      if (!database) database = new postgres.PostgresDatabase({ pool });
      await runBoundedPostgresReadinessProbe(
        database,
        startup,
        lifecycle,
        "PostgreSQL startup readiness",
        closesDatabase ? forcePostgresOnce : null
      );
      const migrate = options.runPostgresMigrations || postgres.runPostgresMigrations;
      const migrationController = new AbortController();
      const postgresMigrationDeadline = startup.phaseDeadline(lifecycle.migrationMs);
      const migrationOptions = {
        ...(options.postgresMigrationOptions || {}),
        migrationCeiling: safeConfig.postgresMigrationCeiling,
        signal: migrationController.signal,
        migrationDeadlineMs: postgresMigrationDeadline.deadlineMs,
        migrationTimeoutMs: postgresMigrationDeadline.timeoutMs,
        migrationNow: lifecycle.timers.now,
        migrationPhase: "PostgreSQL migration",
      };
      migrationResult = await withTimeout(
        () => migrate(database, migrationOptions),
        postgresMigrationDeadline.timeoutMs,
        "PostgreSQL migration",
        lifecycle,
        (error) => {
          migrationController.abort(error);
          forcePostgresOnce();
        }
      );
      const attestProviderMutationMode = options.attestProviderMutationMode === undefined
        ? postgres.attestProviderMutationMode
        : options.attestProviderMutationMode;
      if (typeof attestProviderMutationMode !== "function") {
        throw new TypeError("PostgreSQL provider mutation attestation must be a function");
      }
      const attestationDeadline = startup.phaseDeadline(lifecycle.migrationMs);
      const attestationOptions = { mode: safeConfig.providerMutationMode };
      if (safeConfig.postgresMigrationCeiling !== null) {
        attestationOptions.migrationCeiling = safeConfig.postgresMigrationCeiling;
      }
      await withTimeout(
        () => attestProviderMutationMode(database, attestationOptions),
        attestationDeadline.timeoutMs,
        "PostgreSQL provider mutation attestation",
        lifecycle,
        forcePostgresOnce
      );
      const attestPostgresSchemaReadiness =
        options.attestPostgresSchemaReadiness === undefined
          ? postgres.attestPostgresSchemaReadiness
          : options.attestPostgresSchemaReadiness;
      if (typeof attestPostgresSchemaReadiness !== "function") {
        throw new TypeError("PostgreSQL schema readiness attestation must be a function");
      }
      durableRepositories = postgres.createPostgresDurableRepositories({
        ...(options.postgresRepositoryOptions || {}),
        providerMutationMode: safeConfig.providerMutationMode,
        database,
        tokenService: primitives.tokenService,
        envelopeCrypto: primitives.envelopeCrypto,
        clock: options.clock,
      });
      durableHealth = {
        kind: "PostgreSQL",
        force: closesDatabase ? forcePostgresOnce : null,
        run: async () => {
          await database.query(POSTGRES_READINESS_QUERY);
          await attestPostgresSchemaReadiness(database);
        },
      };
    }

    if (safeConfig.ttlDriver === "redis") {
      const subtitleStorage = createSubtitleStorageComponents(
        safeConfig,
        options,
        closers,
        lifecycle
      );
      subtitleObjectStore = subtitleStorage.subtitleObjectStore;
      objectKeyFactory = subtitleStorage.objectKeyFactory;
      subtitleObjectStorageHealth = subtitleStorage.health;
    }

    const isProfileActive = async (profileId) => {
      const profile = await durableRepositories.profiles.getById(profileId);
      return Boolean(profile && profile.status === "active");
    };

    if (safeConfig.ttlDriver === "memory") {
      const ttl = createMemoryTtlComponents(primitives, { ...options, isProfileActive });
      ttlRepositories = ttl.repositories;
      subtitleObjectStore = ttl.subtitleObjectStore;
    } else {
      const redis = require("./redis");
      const redisRepositoryOptions = options.redisRepositoryOptions || {};
      if (Object.prototype.hasOwnProperty.call(redisRepositoryOptions, "objectKeyFactory")) {
        throw new TypeError(
          "redisRepositoryOptions may not override configured objectKeyFactory"
        );
      }
      const nestedPlaybackOptions = redisRepositoryOptions.playbackContexts;
      if (
        nestedPlaybackOptions !== undefined &&
        (!nestedPlaybackOptions ||
          typeof nestedPlaybackOptions !== "object" ||
          Array.isArray(nestedPlaybackOptions))
      ) {
        throw new TypeError("playbackContexts Redis options must be an object");
      }
      const authoritativeRedisRepositoryOptions = {
        ...redisRepositoryOptions,
        playbackContexts: {
          ...(nestedPlaybackOptions || {}),
          writeVersion: safeConfig.redisPlaybackWriteVersion,
          productionLikeRuntime: isProductionLikeEnvironment(safeConfig.environment),
        },
      };
      const redisKeyspace =
        redisRepositoryOptions.keyspace || new redis.RedisKeyspace(redisRepositoryOptions.keyPrefix);
      const createClient = options.createRedisClient || defaultCreateRedisClient;
      const injectedClient = options.redisClient;
      const client =
        injectedClient ||
        createClient({
          ...(options.redisClientOptions || {}),
          url: safeConfig.redisUrl,
        });
      let detachErrorListener = () => {};
      let openedByRuntime = false;
      let redisConnected = false;
      let redisCloseAttempted = false;
      let redisForced = false;
      const ownsConnection = () =>
        openedByRuntime || !injectedClient || options.closeInjectedResources === true;
      const forceRedisOnce = () => {
        if (!ownsConnection() || redisForced) return;
        redisForced = true;
        forceRedisClient(client);
      };
      closers.push({
        kind: "Redis",
        close: async () => {
          if (!ownsConnection() || redisCloseAttempted || redisForced) return;
          redisCloseAttempted = true;
          if (!redisConnected) {
            forceRedisOnce();
            return;
          }
          const quit = client.quit;
          if (typeof quit !== "function") {
            forceRedisOnce();
            return;
          }
          await quit.call(client);
          redisConnected = false;
        },
        force: forceRedisOnce,
        detach: () => detachErrorListener(),
      });
      detachErrorListener = addErrorListener(client, "redis", options);
      const initiallyOpen = client.isOpen === true;
      redisConnected = initiallyOpen;
      if (!initiallyOpen) {
        const connect = client.connect;
        if (typeof connect !== "function") throw new TypeError("Redis client must provide connect()");
        openedByRuntime = true;
        await startup.run(
          () => connect.call(client),
          "Redis connect",
          lifecycle.connectMs
        );
        redisConnected = true;
      }
      if (typeof client.ping !== "function") throw new TypeError("Redis client must provide ping()");
      ttlRepositories = redis.createRedisTtlRepositories({
        ...authoritativeRedisRepositoryOptions,
        client,
        tokenService: primitives.tokenService,
        envelopeCrypto: primitives.envelopeCrypto,
        keyspace: redisKeyspace,
        objectKeyFactory,
        randomBytes: options.randomBytes,
        sourceContextOptions: options.sourceContextOptions,
        isProfileActive,
      });
      ttlHealth = {
        kind: "Redis",
        force: forceRedisOnce,
        run: async () => {
          assertPong(await client.ping());
          try {
            if (isProductionLikeEnvironment(safeConfig.environment)) {
              await redis.assertRedisSupportedVersion(client);
            }
            await assertRedisStandaloneTopology(client);
            if (isProductionLikeEnvironment(safeConfig.environment)) {
              await redis.assertRedisNoEvictionPolicy(client);
            }
            await assertRedisWritablePrimary(client, redisKeyspace);
            await ttlRepositories.pairings.assertProtocol();
          } catch (error) {
            throw normalizeRedisTopologyError(error);
          }
        },
      };
    }

    const repositories = { ...durableRepositories, ...ttlRepositories };
    assertRepositorySet(repositories);
    const runtimeMetadata = {
      migrationResult,
      lifecycle,
      startupComplete: false,
      subtitleObjectStore,
    };
    const { runReadiness, runtime } = createRuntime(
      safeConfig,
      primitives,
      repositories,
      {
        durable: durableHealth,
        ttl: ttlHealth,
        subtitleObjectStorage: subtitleObjectStorageHealth,
      },
      closers,
      runtimeMetadata
    );
    await runReadiness(
      Math.min(lifecycle.readinessMs, startup.remaining("storage startup"))
    );
    runtimeMetadata.startupComplete = true;
    return runtime;
  } catch (error) {
    throw attachCleanupErrors(
      error,
      await closeResourceStack(closers, lifecycle),
      STORAGE_STARTUP_FAILURE_DETAILS
    );
  }
}

module.exports = {
  DEFAULT_SUBTITLE_ERASURE_ATTESTATION_FRESHNESS_MS,
  SUBTITLE_ERASURE_CANARY_NAMESPACE,
  assertProductionSubtitleErasureReadiness,
  assertRedisReleaseProtocolCompatibility,
  createHardenedSubtitleObjectStore,
  createMemoryDurableRepositories,
  createMemoryRepositorySet,
  createMemoryTtlRepositories,
  createSubtitleObjectKeyFactory,
  createSubtitleStorageHealth,
  createStorageRuntime,
  createStoragePrimitives,
  runProductionStoragePreflight,
  subtitleObjectKeyAuthorityFingerprint,
};
