"use strict";

const {
  assertEnvironment,
  assertPostgresMigrationCeiling,
  assertProviderMutationMode,
  assertRedisPlaybackWriteVersion,
  assertStorageTopology,
  loadStorageConfig,
  parseUrl,
} = require("./config");
const { runProductionStoragePreflight } = require("./factory");
const { PostgresDatabase } = require("./postgres/database");
const { runPostgresMigrations } = require("./postgres/migration-runner");
const {
  activateProviderMutationProtocol,
  attestProviderMutationMode,
  pauseProviderMutationsForActivation,
} = require("./postgres/provider-mutation-activation");
const {
  resolveApplyEnvAction,
  runPlaybackClaimWriterProtocolCli,
} = require("./redis/playback-claim-writer-protocol");

const ACTION = "apply-env";
const DEFAULT_RELEASE_PROTOCOL_TIMEOUT_MS = 120_000;
const TIMEOUT_ENV = "JUMPGATE_RELEASE_PROTOCOL_TIMEOUT_MS";
const PERMANENT_ERASURE_MODE = "tigris-version-purge-v1";
const USAGE = "usage: node scripts/production-release-protocols.js apply-env";

function releaseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readRequiredEnvironmentValue(env, name) {
  const value = env && env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw releaseError("production_release_config_invalid", name + " is required");
  }
  return value;
}

function readReleaseProtocolTimeout(env) {
  const value = env && env[TIMEOUT_ENV];
  if (value === undefined || value === "") return DEFAULT_RELEASE_PROTOCOL_TIMEOUT_MS;
  if (!/^[1-9][0-9]{0,5}$/.test(value) || Number(value) > 300_000) {
    throw releaseError(
      "production_release_config_invalid",
      TIMEOUT_ENV + " must be between 1 and 300000"
    );
  }
  return Number(value);
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== ACTION) {
    throw releaseError("production_release_invalid_arguments", USAGE);
  }
  return ACTION;
}

function loadReleaseProtocolConfig(env = process.env) {
  if (!env || typeof env !== "object") {
    throw releaseError("production_release_config_invalid", "environment is required");
  }

  const environment = assertEnvironment(readRequiredEnvironmentValue(env, "NODE_ENV"));
  const durableDriver = readRequiredEnvironmentValue(env, "JUMPGATE_DURABLE_DRIVER");
  const ttlDriver = readRequiredEnvironmentValue(env, "JUMPGATE_TTL_DRIVER");
  assertStorageTopology(environment, durableDriver, ttlDriver);
  if (environment !== "production") {
    throw releaseError(
      "production_release_config_invalid",
      "release protocols require NODE_ENV=production"
    );
  }

  const providerMutationMode = assertProviderMutationMode(
    readRequiredEnvironmentValue(env, "JUMPGATE_PROVIDER_MUTATION_MODE")
  );
  if (providerMutationMode !== "fenced") {
    throw releaseError(
      "production_release_config_invalid",
      "release protocols require fenced provider mutations"
    );
  }
  const postgresMigrationCeiling = assertPostgresMigrationCeiling(
    readRequiredEnvironmentValue(env, "JUMPGATE_POSTGRES_MIGRATION_CEILING"),
    { required: true }
  );
  if (postgresMigrationCeiling < "0004_provider_mutation_fence") {
    throw releaseError(
      "production_release_config_invalid",
      "release protocols require the provider mutation fence migration"
    );
  }
  const redisPlaybackWriteVersion = assertRedisPlaybackWriteVersion(
    readRequiredEnvironmentValue(env, "JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION")
  );
  if (redisPlaybackWriteVersion !== "4") {
    throw releaseError(
      "production_release_config_invalid",
      "release protocols require Redis playback write version 4"
    );
  }
  const permanentErasureMode = readRequiredEnvironmentValue(
    env,
    "JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE"
  );
  if (permanentErasureMode !== PERMANENT_ERASURE_MODE) {
    throw releaseError(
      "production_release_config_invalid",
      "release protocols require attested permanent subtitle erasure"
    );
  }

  // Resolve the guarded Redis phase before opening either storage connection.
  const redisAction = resolveApplyEnvAction(env);
  const databaseUrl = parseUrl(
    readRequiredEnvironmentValue(env, "DATABASE_URL"),
    "DATABASE_URL",
    new Set(["postgres:", "postgresql:"])
  );
  const redisUrl = parseUrl(
    readRequiredEnvironmentValue(env, "REDIS_URL"),
    "REDIS_URL",
    new Set(["redis:", "rediss:"])
  );

  return Object.freeze({
    databaseUrl,
    postgresMigrationCeiling,
    providerMutationMode,
    redisAction,
    redisUrl,
    timeoutMs: readReleaseProtocolTimeout(env),
  });
}

async function closePostgresPool(pool, operationError) {
  if (!pool || typeof pool.end !== "function") return;
  try {
    await pool.end();
  } catch (_closeError) {
    if (!operationError) {
      throw releaseError(
        "production_release_postgres_close_failed",
        "PostgreSQL connection did not close cleanly"
      );
    }
  }
}

async function preparePostgres(config, dependencies) {
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
      migrationPhase: "production release PostgreSQL migration",
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
    if (!state.enforcementActive) {
      throw releaseError(
        "production_release_provider_activation_incomplete",
        "provider mutation enforcement did not activate"
      );
    }

    return Object.freeze({
      activated: activationResult.activated === true,
      alreadyApplied: Array.isArray(migration.alreadyApplied)
        ? migration.alreadyApplied.length
        : 0,
      applied: Array.isArray(migration.applied) ? migration.applied.length : 0,
      mutationsPaused: state.mutationsPaused === true,
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

async function runProductionReleaseProtocols(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  parseArguments(argv);
  const config = loadReleaseProtocolConfig(env);
  const loadStorage = options.loadStorageConfig || loadStorageConfig;
  const preflight =
    options.runProductionStoragePreflight || runProductionStoragePreflight;
  if (typeof loadStorage !== "function" || typeof preflight !== "function") {
    throw new TypeError("production release storage preflight is invalid");
  }
  const storageConfig = loadStorage(env);
  await preflight(storageConfig, {
    expectedRedisAction: config.redisAction,
    lifecycleTimeouts: {
      connectMs: Math.min(15_000, config.timeoutMs),
      migrationMs: config.timeoutMs,
      readinessMs: config.timeoutMs,
      shutdownMs: Math.min(10_000, config.timeoutMs),
      startupMs: config.timeoutMs,
    },
  });
  const postgres = await preparePostgres(config, options);
  const runRedis =
    options.runPlaybackClaimWriterProtocolCli || runPlaybackClaimWriterProtocolCli;
  const redis = await runRedis({
    argv: [ACTION],
    createClient: options.createRedisClient,
    env,
    stdout: { write() {} },
  });
  if (redis.appliedAction !== config.redisAction) {
    throw releaseError(
      "production_release_redis_attestation_failed",
      "Redis release action did not match the configured rollout phase"
    );
  }

  const result = Object.freeze({
    action: ACTION,
    postgres,
    redis: Object.freeze({
      action: redis.appliedAction,
      changed: redis.changed === true,
      state: redis.state,
      version: redis.version,
    }),
    schema: "jumpgate-production-release-v1",
  });
  stdout.write(JSON.stringify(result) + "\n");
  return result;
}

function reportProductionReleaseProtocolError(
  error,
  stderr = process.stderr,
  processObject = process
) {
  const code =
    error && typeof error.code === "string" && /^[a-z0-9_]{1,96}$/.test(error.code)
      ? " [" + error.code + "]"
      : "";
  stderr.write("production release protocol command failed" + code + "\n");
  processObject.exitCode = 1;
}

module.exports = {
  ACTION,
  closePostgresPool,
  DEFAULT_RELEASE_PROTOCOL_TIMEOUT_MS,
  loadReleaseProtocolConfig,
  parseArguments,
  PERMANENT_ERASURE_MODE,
  preparePostgres,
  readReleaseProtocolTimeout,
  reportProductionReleaseProtocolError,
  runProductionReleaseProtocols,
  TIMEOUT_ENV,
  USAGE,
};

if (require.main === module) {
  runProductionReleaseProtocols().catch(reportProductionReleaseProtocolError);
}
