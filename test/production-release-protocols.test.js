"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  loadReleaseProtocolConfig,
  parseArguments,
  reportProductionReleaseProtocolError,
  runProductionReleaseProtocols,
} = require("../scripts/production-release-protocols");

function productionEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    JUMPGATE_DURABLE_DRIVER: "postgres",
    JUMPGATE_TTL_DRIVER: "redis",
    JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
    JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
    JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
    JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE: "transition",
    JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
    JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID: "release-test-access",
    JUMPGATE_SUBTITLE_S3_BUCKET: "release-test-subtitles",
    JUMPGATE_SUBTITLE_S3_ENDPOINT: "https://fly.storage.tigris.dev",
    JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE: "0",
    JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: "tigris-policy-status",
    JUMPGATE_SUBTITLE_S3_REGION: "auto",
    JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY: "release-test-secret",
    JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID: "release-subtitle-key",
    JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: JSON.stringify([
      {
        id: "release-subtitle-key",
        key: Buffer.alloc(32, 0x52).toString("base64url"),
      },
    ]),
    JUMPGATE_TOKEN_PEPPER: Buffer.alloc(32, 0x31).toString("base64url"),
    JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "release-envelope-key",
    JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([
      {
        id: "release-envelope-key",
        key: Buffer.alloc(32, 0x41).toString("base64url"),
      },
    ]),
    DATABASE_URL: "postgresql://jumpgate:secret@postgres.example/jumpgate",
    REDIS_URL: "rediss://redis.example/0",
    ...overrides,
  };
}

function releaseDependencies(options = {}) {
  const events = options.events || [];
  let state = options.state || {
    enforcementActive: false,
    mutationsPaused: false,
    phase: "expanded",
  };

  class Pool {
    constructor(config) {
      this.config = config;
      events.push("pool");
    }

    async end() {
      events.push("pool:end");
      if (options.closeError) throw options.closeError;
    }
  }

  class Database {
    constructor({ pool }) {
      assert.ok(pool instanceof Pool);
      events.push("database");
      if (options.databaseError) throw options.databaseError;
    }
  }

  return {
    Pool,
    PostgresDatabase: Database,
    events,
    async runProductionStoragePreflight(storageConfig, preflightOptions) {
      events.push("preflight");
      assert.equal(storageConfig.environment, "production");
      assert.equal(storageConfig.subtitleS3.bucket, "release-test-subtitles");
      assert.equal(preflightOptions.expectedRedisAction, "initialize-v5");
      assert.equal(preflightOptions.lifecycleTimeouts.startupMs, 120000);
      if (options.preflightError) throw options.preflightError;
      return {
        redis: { major: 8, protocolState: "missing", protocolVersion: null },
        subtitle: { attested: true },
      };
    },
    async runPostgresMigrations(_database, migrationOptions) {
      events.push("migrate");
      assert.equal(migrationOptions.migrationCeiling, "0011_history_http_receipts");
      assert.equal(migrationOptions.migrationTimeoutMs, 120000);
      if (options.migrationError) throw options.migrationError;
      return { applied: ["0011_history_http_receipts"], alreadyApplied: ["0001_initial"] };
    },
    async pauseProviderMutationsForActivation() {
      events.push("pause-for-activation");
      if (state.enforcementActive || state.mutationsPaused) {
        return { paused: state.mutationsPaused, changed: false };
      }
      state = { ...state, mutationsPaused: true, phase: "paused" };
      return { paused: true, changed: true };
    },
    async activateProviderMutationProtocol() {
      events.push("activate");
      if (state.enforcementActive) {
        return { activated: false, activationFence: "0" };
      }
      state = options.incompleteActivation
        ? { ...state }
        : {
            enforcementActive: true,
            mutationsPaused: false,
            phase: "active",
          };
      return { activated: !options.incompleteActivation, activationFence: "0" };
    },
    async attestProviderMutationMode(_database, attestation) {
      events.push("attest");
      assert.deepEqual(attestation, {
        migrationCeiling: "0011_history_http_receipts",
        mode: "fenced",
      });
      return { ...state };
    },
    async runPlaybackClaimWriterProtocolCli(redisOptions) {
      events.push("redis");
      assert.deepEqual(redisOptions.argv, ["apply-env"]);
      assert.equal(redisOptions.env.JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE, "transition");
      redisOptions.stdout.write("suppressed Redis output\n");
      if (options.redisError) throw options.redisError;
      return {
        action: "apply-env",
        appliedAction: options.redisAction || "initialize-v5",
        changed: true,
        state: "initialized",
        version: "5",
      };
    },
  };
}

test("release configuration is production-only and resolves the guarded Redis phase", () => {
  const transition = loadReleaseProtocolConfig(productionEnvironment());
  assert.equal(transition.redisAction, "initialize-v5");
  assert.equal(transition.timeoutMs, 120000);

  const v6 = loadReleaseProtocolConfig(
    productionEnvironment({
      JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE: "v6",
      JUMPGATE_RELEASE_PROTOCOL_TIMEOUT_MS: "300000",
    })
  );
  assert.equal(v6.redisAction, "advance-v6");
  assert.equal(v6.timeoutMs, 300000);
});

test("release configuration rejects non-production and weakened protocol state", () => {
  const cases = [
    { NODE_ENV: "development" },
    { JUMPGATE_DURABLE_DRIVER: "sqlite" },
    { JUMPGATE_TTL_DRIVER: "memory" },
    { JUMPGATE_PROVIDER_MUTATION_MODE: "legacy" },
    { JUMPGATE_POSTGRES_MIGRATION_CEILING: "0003_history" },
    { JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "3" },
    { JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE: "" },
    {
      JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE:
        "blocked-tigris-provider-confirmation-required",
    },
  ];
  for (const override of cases) {
    assert.throws(() => loadReleaseProtocolConfig(productionEnvironment(override)));
  }
});

test("release CLI accepts only its explicit apply-env action", () => {
  assert.equal(parseArguments(["apply-env"]), "apply-env");
  for (const argv of [[], ["status"], ["apply-env", "extra"], null]) {
    assert.throws(
      () => parseArguments(argv),
      (error) => error.code === "production_release_invalid_arguments"
    );
  }
});

test("live storage preflight fails before PostgreSQL or Redis protocol mutation", async () => {
  const failure = Object.assign(new Error("controlled live preflight failure"), {
    code: "production_subtitle_preflight_failed",
  });
  const dependencies = releaseDependencies({ preflightError: failure });
  await assert.rejects(
    runProductionReleaseProtocols({
      argv: ["apply-env"],
      env: productionEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    (error) => error === failure
  );
  assert.deepEqual(dependencies.events, ["preflight"]);
});

test("release orchestration migrates, fences PostgreSQL, then applies Redis", async () => {
  const dependencies = releaseDependencies();
  let output = "";
  const result = await runProductionReleaseProtocols({
    argv: ["apply-env"],
    env: productionEnvironment(),
    stdout: { write: (value) => { output += value; } },
    ...dependencies,
  });

  assert.deepEqual(dependencies.events, [
    "preflight",
    "pool",
    "database",
    "migrate",
    "pause-for-activation",
    "activate",
    "attest",
    "pool:end",
    "redis",
  ]);
  assert.deepEqual(result.postgres, {
    activated: true,
    alreadyApplied: 1,
    applied: 1,
    mutationsPaused: false,
    paused: true,
    phase: "active",
  });
  assert.deepEqual(result.redis, {
    action: "initialize-v5",
    changed: true,
    state: "initialized",
    version: "5",
  });
  assert.deepEqual(JSON.parse(output), result);
  assert.equal(output.includes("suppressed Redis output"), false);
});

test("release orchestration is idempotent when PostgreSQL enforcement is active", async () => {
  const dependencies = releaseDependencies({
    state: {
      enforcementActive: true,
      mutationsPaused: true,
      phase: "active",
    },
  });
  const result = await runProductionReleaseProtocols({
    argv: ["apply-env"],
    env: productionEnvironment(),
    stdout: { write() {} },
    ...dependencies,
  });

  assert.deepEqual(dependencies.events, [
    "preflight",
    "pool",
    "database",
    "migrate",
    "pause-for-activation",
    "activate",
    "attest",
    "pool:end",
    "redis",
  ]);
  assert.equal(result.postgres.activated, false);
  assert.equal(result.postgres.paused, false);
  assert.equal(result.postgres.mutationsPaused, true);
});

test("release fails closed if provider enforcement does not activate", async () => {
  const dependencies = releaseDependencies({ incompleteActivation: true });
  await assert.rejects(
    runProductionReleaseProtocols({
      argv: ["apply-env"],
      env: productionEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    (error) => error.code === "production_release_provider_activation_incomplete"
  );
  assert.equal(dependencies.events.at(-1), "pool:end");
  assert.equal(dependencies.events.includes("redis"), false);
});

test("release closes PostgreSQL and leaves Redis untouched after migration failure", async () => {
  const failure = Object.assign(new Error("controlled migration failure"), {
    code: "migration_controlled",
  });
  const dependencies = releaseDependencies({ migrationError: failure });
  await assert.rejects(
    runProductionReleaseProtocols({
      argv: ["apply-env"],
      env: productionEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    failure
  );
  assert.deepEqual(dependencies.events, [
    "preflight",
    "pool",
    "database",
    "migrate",
    "pool:end",
  ]);
});

test("release closes a created pool when PostgreSQL database setup fails", async () => {
  const failure = new Error("controlled database setup failure");
  const dependencies = releaseDependencies({ databaseError: failure });
  await assert.rejects(
    runProductionReleaseProtocols({
      argv: ["apply-env"],
      env: productionEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    (error) => error === failure
  );
  assert.deepEqual(dependencies.events, ["preflight", "pool", "database", "pool:end"]);
});

test("release fails before Redis when a successful PostgreSQL operation cannot close", async () => {
  const dependencies = releaseDependencies({
    closeError: new Error("controlled close failure"),
  });
  await assert.rejects(
    runProductionReleaseProtocols({
      argv: ["apply-env"],
      env: productionEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    (error) => error.code === "production_release_postgres_close_failed"
  );
  assert.equal(dependencies.events.includes("redis"), false);
});

test("release attests the Redis action selected before storage mutation", async () => {
  const dependencies = releaseDependencies({ redisAction: "advance-v6" });
  await assert.rejects(
    runProductionReleaseProtocols({
      argv: ["apply-env"],
      env: productionEnvironment(),
      stdout: { write() {} },
      ...dependencies,
    }),
    (error) => error.code === "production_release_redis_attestation_failed"
  );
  assert.ok(dependencies.events.indexOf("pool:end") < dependencies.events.indexOf("redis"));
});

test("release CLI reporting never prints exception messages", () => {
  let stderr = "";
  const processObject = { exitCode: 0 };
  reportProductionReleaseProtocolError(
    Object.assign(new Error("postgresql://user:secret@example.invalid/db"), {
      code: "production_release_controlled",
    }),
    { write: (value) => { stderr += value; } },
    processObject
  );
  assert.equal(
    stderr,
    "production release protocol command failed [production_release_controlled]\n"
  );
  assert.equal(stderr.includes("secret"), false);
  assert.equal(processObject.exitCode, 1);
});
