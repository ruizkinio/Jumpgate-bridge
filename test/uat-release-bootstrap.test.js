"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { parse: parseToml } = require("smol-toml");

const {
  loadUatBootstrapConfig,
  parseArguments,
  reportUatReleaseBootstrapError,
  runUatReleaseBootstrap,
} = require("../scripts/uat-release-bootstrap");

function uatEnvironment(overrides = {}) {
  return {
    NODE_ENV: "uat",
    JUMPGATE_UAT_MODE: "1",
    JUMPGATE_UAT_VOBSUB_FIXTURE: "1",
    PUBLIC_BASE_URL: "https://jumpgate-uat.fly.dev",
    JUMPGATE_DURABLE_DRIVER: "postgres",
    JUMPGATE_TTL_DRIVER: "redis",
    JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
    JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
    JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
    DATABASE_URL: "postgresql://uat:secret@postgres.example/jumpgate_uat",
    REDIS_URL: "rediss://uat:secret@redis.example/0",
    ...overrides,
  };
}

function bootstrapDependencies(options = {}) {
  const events = options.events || [];
  let postgresState = options.postgresState || {
    enforcementActive: false,
    mutationsPaused: false,
    phase: "expanded",
  };
  let redisVersion = Object.hasOwn(options, "redisVersion") ? options.redisVersion : null;

  class Pool {
    constructor(config) {
      assert.equal(config.connectionString, uatEnvironment().DATABASE_URL);
      assert.equal(config.max, 1);
      events.push("postgres:pool");
    }

    async end() {
      events.push("postgres:end");
    }
  }

  class Database {
    constructor({ pool }) {
      assert.ok(pool instanceof Pool);
      events.push("postgres:database");
    }
  }

  const redisClient = {
    async connect() {
      events.push("redis:connect");
    },
    on(event) {
      assert.equal(event, "error");
    },
    async quit() {
      events.push("redis:quit");
    },
  };

  return {
    Pool,
    PostgresDatabase: Database,
    events,
    loadStorageConfig(env) {
      events.push("storage:load");
      assert.equal(env.NODE_ENV, "uat");
      if (options.storageError) throw options.storageError;
      return { environment: "uat" };
    },
    async runProductionStoragePreflight(storage, preflightOptions) {
      events.push("storage:preflight");
      assert.equal(storage.environment, "uat");
      assert.equal(preflightOptions.requiredEnvironment, "uat");
      assert.equal(preflightOptions.expectedRedisAction, "initialize-or-advance-v6");
      assert.equal(preflightOptions.lifecycleTimeouts.startupMs, 120000);
      if (options.preflightError) throw options.preflightError;
    },
    async runPostgresMigrations(_database, migrationOptions) {
      events.push("postgres:migrate");
      assert.equal(migrationOptions.migrationCeiling, "0011_history_http_receipts");
      assert.equal(migrationOptions.migrationPhase, "UAT release PostgreSQL migration");
      if (options.migrationError) throw options.migrationError;
      return { applied: ["0011_history_http_receipts"], alreadyApplied: ["0001_initial"] };
    },
    async pauseProviderMutationsForActivation() {
      events.push("postgres:pause");
      if (postgresState.enforcementActive || postgresState.mutationsPaused) {
        return { paused: postgresState.mutationsPaused, changed: false };
      }
      postgresState = { ...postgresState, mutationsPaused: true, phase: "paused" };
      return { paused: true, changed: true };
    },
    async activateProviderMutationProtocol() {
      events.push("postgres:activate");
      if (postgresState.enforcementActive) {
        return { activated: false, activationFence: "0" };
      }
      postgresState = options.incompleteActivation
        ? postgresState
        : { enforcementActive: true, mutationsPaused: false, phase: "active" };
      return { activated: !options.incompleteActivation, activationFence: "0" };
    },
    async attestProviderMutationMode(_database, attestation) {
      events.push("postgres:attest");
      assert.deepEqual(attestation, {
        migrationCeiling: "0011_history_http_receipts",
        mode: "fenced",
      });
      return { ...postgresState };
    },
    createRedisClient(config) {
      events.push("redis:create");
      assert.deepEqual(config, { url: uatEnvironment().REDIS_URL });
      return redisClient;
    },
    async getPlaybackClaimWriterProtocolStatus(client) {
      assert.equal(client, redisClient);
      events.push("redis:status:" + (redisVersion || "missing"));
      if (options.invalidRedisStatus) return { state: "wrong_type", version: null };
      return redisVersion === null
        ? { state: "missing", version: null }
        : { state: "ready", version: redisVersion };
    },
    async initializePlaybackClaimWriterProtocolV5(client) {
      assert.equal(client, redisClient);
      events.push("redis:initialize-v5");
      assert.equal(redisVersion, null);
      redisVersion = "5";
      return { changed: true, state: "initialized", version: "5" };
    },
    async advancePlaybackClaimWriterProtocolV6(client) {
      assert.equal(client, redisClient);
      events.push("redis:advance-v6");
      assert.equal(redisVersion, "5");
      redisVersion = "6";
      return { changed: true, state: "advanced", version: "6" };
    },
  };
}

test("UAT bootstrap requires the exact isolated runtime identity", () => {
  const config = loadUatBootstrapConfig(uatEnvironment());
  assert.equal(config.postgresMigrationCeiling, "0011_history_http_receipts");
  assert.equal(config.timeoutMs, 120000);

  const cases = [
    { NODE_ENV: "production" },
    { JUMPGATE_UAT_MODE: "0" },
    { JUMPGATE_UAT_VOBSUB_FIXTURE: undefined },
    { JUMPGATE_UAT_VOBSUB_FIXTURE: "0" },
    { JUMPGATE_UAT_VOBSUB_FIXTURE: "true" },
    { PUBLIC_BASE_URL: "https://jumpgate-bridge.fly.dev" },
    { JUMPGATE_DURABLE_DRIVER: "sqlite" },
    { JUMPGATE_TTL_DRIVER: "memory" },
    { JUMPGATE_PROVIDER_MUTATION_MODE: "legacy" },
    { JUMPGATE_POSTGRES_MIGRATION_CEILING: "0003_storage_correctness" },
    { JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "3" },
    { TRAKT_CLIENT_SECRET: "forbidden" },
    { TMDB_API_KEY: "forbidden" },
  ];
  for (const override of cases) {
    assert.throws(() => loadUatBootstrapConfig(uatEnvironment(override)));
  }
});

test("UAT bootstrap accepts only its explicit action", () => {
  assert.equal(parseArguments(["apply-env"]), "apply-env");
  for (const argv of [[], ["status"], ["apply-env", "extra"], null]) {
    assert.throws(
      () => parseArguments(argv),
      (error) => error.code === "uat_bootstrap_invalid_arguments"
    );
  }
});

test("fresh UAT bootstrap preflights, fences PostgreSQL, then initializes Redis v5 and v6", async () => {
  const dependencies = bootstrapDependencies();
  let output = "";
  const result = await runUatReleaseBootstrap({
    argv: ["apply-env"],
    env: uatEnvironment(),
    stdout: { write(value) { output += value; } },
    ...dependencies,
  });

  assert.deepEqual(dependencies.events, [
    "storage:load",
    "storage:preflight",
    "postgres:pool",
    "postgres:database",
    "postgres:migrate",
    "postgres:pause",
    "postgres:activate",
    "postgres:attest",
    "postgres:end",
    "redis:create",
    "redis:connect",
    "redis:status:missing",
    "redis:initialize-v5",
    "redis:advance-v6",
    "redis:status:6",
    "redis:quit",
  ]);
  assert.deepEqual(result.postgres, {
    activated: true,
    alreadyApplied: 1,
    applied: 1,
    paused: true,
    phase: "active",
  });
  assert.deepEqual(result.redis, {
    advanced: true,
    initialVersion: null,
    initialized: true,
    state: "ready",
    version: "6",
  });
  assert.deepEqual(JSON.parse(output), result);
  assert.equal(output.includes("secret"), false);
});

test("UAT bootstrap is idempotent after both protocols are active", async () => {
  const dependencies = bootstrapDependencies({
    postgresState: {
      enforcementActive: true,
      mutationsPaused: false,
      phase: "active",
    },
    redisVersion: "6",
  });
  const result = await runUatReleaseBootstrap({
    argv: ["apply-env"],
    env: uatEnvironment(),
    stdout: { write() {} },
    ...dependencies,
  });

  assert.equal(result.postgres.activated, false);
  assert.equal(result.postgres.paused, false);
  assert.equal(result.redis.initialized, false);
  assert.equal(result.redis.advanced, false);
  assert.equal(dependencies.events.includes("redis:initialize-v5"), false);
  assert.equal(dependencies.events.includes("redis:advance-v6"), false);
});

test("live preflight fails before any PostgreSQL or Redis mutation", async () => {
  const failure = Object.assign(new Error("controlled UAT preflight failure"), {
    code: "uat_preflight_controlled",
  });
  const dependencies = bootstrapDependencies({ preflightError: failure });
  await assert.rejects(
    runUatReleaseBootstrap({
      argv: ["apply-env"],
      env: uatEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    (error) => error === failure
  );
  assert.deepEqual(dependencies.events, ["storage:load", "storage:preflight"]);
});

test("PostgreSQL failure closes its pool and leaves Redis untouched", async () => {
  const failure = new Error("controlled migration failure");
  const dependencies = bootstrapDependencies({ migrationError: failure });
  await assert.rejects(
    runUatReleaseBootstrap({
      argv: ["apply-env"],
      env: uatEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    (error) => error === failure
  );
  assert.equal(dependencies.events.at(-1), "postgres:end");
  assert.equal(dependencies.events.includes("redis:create"), false);
});

test("malformed Redis protocol state fails closed and closes Redis", async () => {
  const dependencies = bootstrapDependencies({ invalidRedisStatus: true });
  await assert.rejects(
    runUatReleaseBootstrap({
      argv: ["apply-env"],
      env: uatEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    (error) => error.code === "uat_bootstrap_redis_attestation_failed"
  );
  assert.equal(dependencies.events.at(-1), "redis:quit");
  assert.equal(dependencies.events.includes("redis:initialize-v5"), false);
  assert.equal(dependencies.events.includes("redis:advance-v6"), false);
});

test("UAT bootstrap error reporting never prints exception details", () => {
  let stderr = "";
  const processObject = { exitCode: 0 };
  reportUatReleaseBootstrapError(
    Object.assign(new Error("postgresql://user:secret@example.invalid/db"), {
      code: "uat_bootstrap_controlled",
    }),
    { write(value) { stderr += value; } },
    processObject
  );
  assert.equal(stderr, "UAT release bootstrap failed [uat_bootstrap_controlled]\n");
  assert.equal(stderr.includes("secret"), false);
  assert.equal(processObject.exitCode, 1);
});

test("pinned Fly UAT deployment uses only the guarded bootstrap and isolated identity", () => {
  const root = path.join(__dirname, "..");
  const fly = parseToml(fs.readFileSync(path.join(root, "fly.uat.toml"), "utf8"));
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile.uat"), "utf8");
  const productionDockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");

  assert.equal(fly.app, "jumpgate-uat");
  assert.equal(fly.deploy.release_command, "node scripts/uat-release-bootstrap.js apply-env");
  assert.equal(fly.env.NODE_ENV, "uat");
  assert.equal(fly.env.JUMPGATE_UAT_MODE, "1");
  assert.equal(fly.env.JUMPGATE_UAT_VOBSUB_FIXTURE, "1");
  assert.equal(fly.build.dockerfile, "Dockerfile.uat");
  assert.equal(fly.env.PUBLIC_BASE_URL, "https://jumpgate-uat.fly.dev");
  assert.equal(fly.env.JUMPGATE_DURABLE_DRIVER, "postgres");
  assert.equal(fly.env.JUMPGATE_TTL_DRIVER, "redis");
  assert.equal(fly.http_service.min_machines_running, 2);
  for (const credential of [
    "DATABASE_URL",
    "REDIS_URL",
    "TRAKT_CLIENT_ID",
    "TRAKT_CLIENT_SECRET",
    "TMDB_API_KEY",
  ]) {
    assert.equal(Object.hasOwn(fly.env, credential), false, credential);
  }
  assert.match(
    dockerfile,
    /ln -s \.\.\/lib\/storage\/uat-release-bootstrap\.js[\s\S]*\/app\/scripts\/uat-release-bootstrap\.js/
  );
  assert.doesNotMatch(dockerfile, /COPY[^\n]*scripts/);
  assert.match(dockerfile, /COPY --chown=node:node uat-fixtures \.\/uat-fixtures/);
  assert.doesNotMatch(productionDockerfile, /uat-fixtures/);
  assert.equal(
    dockerfile.replace("COPY --chown=node:node uat-fixtures ./uat-fixtures\n", "").replace(/\r\n/g, "\n"),
    productionDockerfile.replace(/\r\n/g, "\n")
  );
});
