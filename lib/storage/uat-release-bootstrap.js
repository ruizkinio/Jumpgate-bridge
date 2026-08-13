"use strict";

const {
  assertPostgresMigrationCeiling,
  assertProviderMutationMode,
  assertRedisPlaybackWriteVersion,
  loadStorageConfig,
  parseUrl,
} = require("./config");
const { UAT_PUBLIC_BASE_URL, loadReleaseValidationConfig } = require("../release-validation");
const { runProductionStoragePreflight } = require("./factory");
const { PostgresDatabase } = require("./postgres/database");
const { runPostgresMigrations } = require("./postgres/migration-runner");
const {
  activateProviderMutationProtocol,
  attestProviderMutationMode,
  pauseProviderMutationsForActivation,
} = require("./postgres/provider-mutation-activation");
const {
  advanceV6,
  closeRedisClient,
  getStatus,
  initializeV5,
} = require("./redis/playback-claim-writer-protocol");

const ACTION = "apply-env";
const DEFAULT_UAT_BOOTSTRAP_TIMEOUT_MS = 120_000;
const TIMEOUT_ENV = "JUMPGATE_UAT_BOOTSTRAP_TIMEOUT_MS";
const USAGE = "usage: node scripts/uat-release-bootstrap.js apply-env";

function bootstrapError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredEnvironmentValue(env, name) {
  const value = env && env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw bootstrapError("uat_bootstrap_config_invalid", name + " is required");
  }
  return value;
}

function readBootstrapTimeout(env) {
  const value = env && env[TIMEOUT_ENV];
  if (value === undefined || value === "") return DEFAULT_UAT_BOOTSTRAP_TIMEOUT_MS;
  if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 300_000) {
    throw bootstrapError(
      "uat_bootstrap_config_invalid",
      TIMEOUT_ENV + " must be between 1 and 300000"
    );
  }
  return Number(value);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== ACTION) {
    throw bootstrapError("uat_bootstrap_invalid_arguments", USAGE);
  }
  return ACTION;
}

function loadUatBootstrapConfig(env = process.env) {
  if (!env || typeof env !== "object") {
    throw bootstrapError("uat_bootstrap_config_invalid", "environment is required");
  }

  // This rejects production, non-exact origins, external account credentials,
  // and any UAT topology other than PostgreSQL plus Redis.
  const validation = loadReleaseValidationConfig(env);
  if (
    validation.enabled !== true ||
    env.NODE_ENV !== "uat" ||
    env.JUMPGATE_UAT_MODE !== "1" ||
    env.PUBLIC_BASE_URL !== UAT_PUBLIC_BASE_URL
  ) {
    throw bootstrapError(
      "uat_bootstrap_config_invalid",
      "release bootstrap requires the exact isolated UAT environment"
    );
  }

  const providerMutationMode = assertProviderMutationMode(
    requiredEnvironmentValue(env, "JUMPGATE_PROVIDER_MUTATION_MODE")
  );
  if (providerMutationMode !== "fenced") {
    throw bootstrapError(
      "uat_bootstrap_config_invalid",
      "UAT release bootstrap requires fenced provider mutations"
    );
  }
  const postgresMigrationCeiling = assertPostgresMigrationCeiling(
    requiredEnvironmentValue(env, "JUMPGATE_POSTGRES_MIGRATION_CEILING"),
    { required: true }
  );
  if (postgresMigrationCeiling < "0004_provider_mutation_fence") {
    throw bootstrapError(
      "uat_bootstrap_config_invalid",
      "UAT release bootstrap requires the provider mutation fence migration"
    );
  }
  const redisPlaybackWriteVersion = assertRedisPlaybackWriteVersion(
    requiredEnvironmentValue(env, "JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION")
  );
  if (redisPlaybackWriteVersion !== "4") {
    throw bootstrapError(
      "uat_bootstrap_config_invalid",
      "UAT release bootstrap requires Redis playback write version 4"
    );
  }

  return Object.freeze({
    databaseUrl: parseUrl(
      requiredEnvironmentValue(env, "DATABASE_URL"),
      "DATABASE_URL",
      new Set(["postgres:", "postgresql:"])
    ),
    postgresMigrationCeiling,
    providerMutationMode,
    redisUrl: parseUrl(
      requiredEnvironmentValue(env, "REDIS_URL"),
      "REDIS_URL",
      new Set(["redis:", "rediss:"])
    ),
    timeoutMs: readBootstrapTimeout(env),
  });
}

async function closePostgresPool(pool, operationError) {
  if (!pool || typeof pool.end !== "function") return;
  try {
    await pool.end();
  } catch (_closeError) {
    if (!operationError) {
      throw bootstrapError(
        "uat_bootstrap_postgres_close_failed",
        "PostgreSQL connection did not close cleanly"
      );
    }
  }
}

async function preparePostgres(config, dependencies = {}) {
  const Pool = dependencies.Pool || require("pg").Pool;
  const Database = dependencies.PostgresDatabase || PostgresDatabase;
  const migrate = dependencies.runPostgresMigrations || runPostgresMigrations;
  const pauseForActivation =
    dependencies.pauseProviderMutationsForActivation || pauseProviderMutationsForActivation;
  const activate =
    dependencies.activateProviderMutationProtocol || activateProviderMutationProtocol;
  const attest = dependencies.attestProviderMutationMode || attestProviderMutationMode;
  const pool = new Pool({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: config.timeoutMs,
    max: 1,
  });
  let operationError = null;
  try {
    const database = new Database({ pool });
    const migration = await migrate(database, {
      migrationCeiling: config.postgresMigrationCeiling,
      migrationPhase: "UAT release PostgreSQL migration",
      migrationTimeoutMs: config.timeoutMs,
    });
    const pauseResult = await pauseForActivation({ pool, timeoutMs: config.timeoutMs });
    const activationResult = await activate({ pool, timeoutMs: config.timeoutMs });
    const state = await attest(
      { pool, timeoutMs: config.timeoutMs },
      {
        migrationCeiling: config.postgresMigrationCeiling,
        mode: config.providerMutationMode,
      }
    );
    if (!state.enforcementActive || state.mutationsPaused) {
      throw bootstrapError(
        "uat_bootstrap_provider_activation_incomplete",
        "provider mutation enforcement is not active and writable"
      );
    }
    return Object.freeze({
      activated: activationResult.activated === true,
      alreadyApplied: Array.isArray(migration.alreadyApplied)
        ? migration.alreadyApplied.length
        : 0,
      applied: Array.isArray(migration.applied) ? migration.applied.length : 0,
      paused: pauseResult.changed === true,
      phase: state.phase,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await closePostgresPool(pool, operationError);
  }
}

function assertRedisStatus(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw bootstrapError("uat_bootstrap_redis_attestation_failed", "Redis protocol status is invalid");
  }
  if (status.state === "missing" && status.version === null) return status;
  if (status.state === "ready" && (status.version === "5" || status.version === "6")) {
    return status;
  }
  throw bootstrapError(
    "uat_bootstrap_redis_attestation_failed",
    "Redis protocol state is incompatible with UAT bootstrap"
  );
}

async function prepareRedis(config, dependencies = {}) {
  const createClient = dependencies.createRedisClient || require("redis").createClient;
  const status = dependencies.getPlaybackClaimWriterProtocolStatus || getStatus;
  const initialize = dependencies.initializePlaybackClaimWriterProtocolV5 || initializeV5;
  const advance = dependencies.advancePlaybackClaimWriterProtocolV6 || advanceV6;
  if (typeof createClient !== "function") throw new TypeError("createRedisClient must be a function");
  const client = createClient({ url: config.redisUrl });
  if (!client || typeof client.connect !== "function") {
    throw new TypeError("Redis client must provide connect()");
  }
  if (typeof client.on === "function") client.on("error", () => {});

  let connected = false;
  let operationError = null;
  try {
    await client.connect();
    connected = true;
    const initial = assertRedisStatus(await status(client));
    let initialized = false;
    let advanced = false;
    if (initial.state === "missing") {
      const result = await initialize(client);
      initialized = result.changed === true;
    }
    if (initial.version !== "6") {
      const result = await advance(client);
      advanced = result.changed === true;
    }
    const finalStatus = assertRedisStatus(await status(client));
    if (finalStatus.state !== "ready" || finalStatus.version !== "6") {
      throw bootstrapError(
        "uat_bootstrap_redis_attestation_failed",
        "Redis playback writer protocol did not reach version 6"
      );
    }
    return Object.freeze({
      advanced,
      initialVersion: initial.version,
      initialized,
      state: finalStatus.state,
      version: finalStatus.version,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await closeRedisClient(client, connected);
    } catch (_closeError) {
      if (!operationError) {
        throw bootstrapError(
          "uat_bootstrap_redis_close_failed",
          "Redis connection did not close cleanly"
        );
      }
    }
  }
}

async function runUatReleaseBootstrap(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  parseArguments(argv);
  const config = loadUatBootstrapConfig(env);

  // Fully validate production-like storage and security material before mutation.
  const loadStorage = options.loadStorageConfig || loadStorageConfig;
  const preflight = options.runProductionStoragePreflight || runProductionStoragePreflight;
  const storageConfig = loadStorage(env);
  if (storageConfig.environment !== "uat") {
    throw bootstrapError("uat_bootstrap_config_invalid", "storage environment is not UAT");
  }
  await preflight(storageConfig, {
    expectedRedisAction: "initialize-or-advance-v6",
    lifecycleTimeouts: {
      connectMs: Math.min(15_000, config.timeoutMs),
      migrationMs: config.timeoutMs,
      readinessMs: config.timeoutMs,
      shutdownMs: Math.min(10_000, config.timeoutMs),
      startupMs: config.timeoutMs,
    },
    requiredEnvironment: "uat",
  });

  const postgres = await preparePostgres(config, options);
  const redis = await prepareRedis(config, options);
  const result = Object.freeze({
    action: ACTION,
    postgres,
    redis,
    schema: "jumpgate-uat-release-v1",
  });
  stdout.write(JSON.stringify(result) + "\n");
  return result;
}

function reportUatReleaseBootstrapError(error, stderr = process.stderr, processObject = process) {
  const code =
    error && typeof error.code === "string" && /^[a-z0-9_]{1,96}$/.test(error.code)
      ? " [" + error.code + "]"
      : "";
  stderr.write("UAT release bootstrap failed" + code + "\n");
  processObject.exitCode = 1;
}

module.exports = {
  ACTION,
  closePostgresPool,
  DEFAULT_UAT_BOOTSTRAP_TIMEOUT_MS,
  loadUatBootstrapConfig,
  parseArguments,
  preparePostgres,
  prepareRedis,
  readBootstrapTimeout,
  reportUatReleaseBootstrapError,
  runUatReleaseBootstrap,
  TIMEOUT_ENV,
  USAGE,
};

if (require.main === module) {
  runUatReleaseBootstrap().catch(reportUatReleaseBootstrapError);
}
