"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const CANARY_BODY = Buffer.from([0xa5]);
const CANARY_SHA256 = crypto.createHash("sha256").update(CANARY_BODY).digest("hex");
const TIGRIS_ORG_ADMIN_ACL_URI = "https://groups.tigris.dev/org/admins";

const {
  assertObjectStore,
  assertRepositorySet,
  createHardenedSubtitleObjectStore,
  createMemoryRepositorySet,
  createSubtitleObjectKeyFactory,
  createStorageRuntime: createStorageRuntimeImpl,
  createStoragePrimitives,
  loadStorageConfig,
  MemorySubtitleObjectStore,
  OpaqueObjectKeyFactory,
  subtitleObjectKeyAuthorityFingerprint,
} = require("../lib/storage");
const {
  assertProductionSubtitleErasureReadiness,
  assertRedisReleaseProtocolCompatibility,
  runProductionStoragePreflight,
} = require("../lib/storage/factory");
const {
  assertRedisSupportedVersion,
  RedisPairingRepository,
  SCRIPT_DEFINITIONS,
} = require("../lib/storage/redis");

const REDIS_SCRIPTS_BY_SHA = new Map(
  Object.values(SCRIPT_DEFINITIONS).map((definition) => [definition.sha, definition])
);
const REDIS_SCRIPTS_BY_SOURCE = new Map(
  Object.values(SCRIPT_DEFINITIONS).map((definition) => [definition.source, definition])
);

function fakeNoScriptError(sha) {
  const error = new Error("NOSCRIPT No matching script for " + sha);
  error.code = "NOSCRIPT";
  return error;
}

function fakeScriptArguments(options) {
  assert.ok(options && typeof options === "object");
  assert.ok(Array.isArray(options.keys));
  assert.ok(Array.isArray(options.arguments));
  return {
    keys: options.keys.map(String),
    arguments: options.arguments.map(String),
  };
}

function deterministicRandom() {
  let value = 1;
  return (length) => Buffer.alloc(length, value++);
}

function stableSecrets() {
  return {
    JUMPGATE_TOKEN_PEPPER: Buffer.alloc(32, 0x31).toString("base64url"),
    JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "runtime-key",
    JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([
      { id: "runtime-key", key: Buffer.alloc(32, 0x41).toString("base64url") },
    ]),
  };
}

function stableSubtitleStorage() {
  return {
    JUMPGATE_SUBTITLE_S3_BUCKET: "jumpgate-test-subtitles",
    JUMPGATE_SUBTITLE_S3_REGION: "auto",
    JUMPGATE_SUBTITLE_S3_ENDPOINT: "https://fly.storage.tigris.dev",
    JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE: "0",
    JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: "strict",
    JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID: "test-subtitle-access-key",
    JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY: "test-subtitle-secret-never-reflect",
    JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID: "subtitle-current",
    JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: JSON.stringify([
      {
        id: "subtitle-previous",
        key: Buffer.alloc(32, 0x51).toString("base64url"),
      },
      {
        id: "subtitle-current",
        key: Buffer.alloc(32, 0x52).toString("base64url"),
      },
    ]),
  };
}

class FakePool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.queryImpl = options.queryImpl || null;
    this.endImpl = options.endImpl || null;
    this.destroyCalls = 0;
    this.ended = 0;
    this.queries = [];
  }

  async query(text) {
    this.queries.push(text);
    if (text.includes("WITH target_table AS")) {
      return {
        rows: [{
          history_generation_column_safe: true,
          history_generation_index_safe: true,
          history_http_columns_safe: true,
          history_http_constraints_safe: true,
          history_reservation_index_safe: true,
          migration_applied: true,
        }],
      };
    }
    if (this.queryImpl) return this.queryImpl(text);
    return { rows: [{ ready: 1 }] };
  }

  async connect() {
    return {
      async query(text) {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("set_config('lock_timeout'")) return { rows: [{}] };
        if (text.includes("to_regclass('provider_mutation_protocol')")) {
          return {
            rows: [{ protocol_installed: false, allocator_installed: false }],
          };
        }
        throw new Error("unexpected PostgreSQL transaction query");
      },
      release() {},
    };
  }

  async end() {
    this.ended += 1;
    if (this.endImpl) return this.endImpl();
  }

  destroy() {
    this.destroyCalls += 1;
  }
}

class FakeRedisClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.connectError = options.connectError || null;
    this.connectImpl = options.connectImpl || null;
    this.pingImpl = options.pingImpl || null;
    this.sendCommandImpl = options.sendCommandImpl || null;
    this.roleReply = options.roleReply || ["master", 0, []];
    this.serverInfo = options.serverInfo || "# Server\r\nredis_version:8.2.0\r\n";
    this.clusterInfo = options.clusterInfo || "# Cluster\r\ncluster_enabled:0\r\n";
    this.maxmemoryPolicy = options.maxmemoryPolicy || "noeviction";
    this.quitImpl = options.quitImpl || null;
    this.connectCalls = 0;
    this.destroyCalls = 0;
    this.isOpen = false;
    this.pingCalls = 0;
    this.quitCalls = 0;
    this.commands = [];
    this.values = new Map();
    this.scriptCache = new Set();
  }

  async connect() {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
    if (this.connectImpl) return this.connectImpl();
    this.isOpen = true;
  }

  async ping() {
    this.pingCalls += 1;
    if (this.pingImpl) return this.pingImpl();
    return "PONG";
  }

  async sendCommand(command) {
    this.commands.push(command.slice());
    const name = String(command[0]).toUpperCase();
    if (name === "INFO" && command[1] === "server") return this.serverInfo;
    if (this.sendCommandImpl) return this.sendCommandImpl(command, this);
    if (name === "INFO") {
      assert.deepEqual(command, ["INFO", "cluster"]);
      return this.clusterInfo;
    }
    if (name === "ROLE") return this.roleReply;
    if (name === "CONFIG") {
      assert.deepEqual(command, ["CONFIG", "GET", "maxmemory-policy"]);
      return ["maxmemory-policy", this.maxmemoryPolicy];
    }
    if (name === "SET") {
      const key = String(command[1]);
      if (this.values.has(key)) return null;
      this.values.set(key, String(command[2]));
      return "OK";
    }
    if (name === "DEL") return this.values.delete(String(command[1])) ? 1 : 0;
    throw new Error("unexpected Redis command: " + name);
  }

  async quit() {
    this.quitCalls += 1;
    if (this.quitImpl) return this.quitImpl();
    this.isOpen = false;
  }

  destroy() {
    this.destroyCalls += 1;
    this.isOpen = false;
  }

  async evalSha(sha, options) {
    const input = fakeScriptArguments(options);
    this.commands.push(["EVALSHA", sha, String(input.keys.length), ...input.keys, ...input.arguments]);
    if (!this.scriptCache.has(sha)) throw fakeNoScriptError(sha);
    const definition = REDIS_SCRIPTS_BY_SHA.get(sha);
    if (!definition) throw fakeNoScriptError(sha);
    return this._runKnownScript(definition, input);
  }

  async eval(source, options) {
    const input = fakeScriptArguments(options);
    const definition = REDIS_SCRIPTS_BY_SOURCE.get(source);
    const sha = crypto.createHash("sha1").update(source, "utf8").digest("hex");
    this.commands.push(["EVAL", sha, String(input.keys.length), ...input.keys, ...input.arguments]);
    if (!definition || definition.sha !== sha) {
      throw new Error("unexpected Redis EVAL source: " + sha);
    }
    this.scriptCache.add(sha);
    return this._runKnownScript(definition, input);
  }

  _runKnownScript(definition, input) {
    if (definition.name !== "pairingProtocolGate") {
      throw new Error("FakeRedisClient has no executor for Redis script " + definition.name);
    }
    if (
      input.keys.length !== 1 ||
      input.arguments.length !== 1 ||
      input.arguments[0] !== "pairing-replay-v2"
    ) {
      return ["state_collision"];
    }
    const key = input.keys[0];
    if (!this.values.has(key)) {
      this.values.set(key, input.arguments[0]);
      return ["ready"];
    }
    return this.values.get(key) === input.arguments[0]
      ? ["ready"]
      : ["state_collision"];
  }

  async get() {
    return null;
  }
}

test("factory Redis fake executes exact pairing readiness with NOSCRIPT cache semantics", async () => {
  const client = new FakeRedisClient();
  const repository = new RedisPairingRepository({
    client,
    tokenService: {},
    envelopeCrypto: {},
  });

  assert.equal(await repository.assertProtocol(), true);
  assert.deepEqual(
    client.commands.map((command) => command[0]),
    ["EVALSHA", "EVAL"]
  );
  assert.equal(client.scriptCache.has(SCRIPT_DEFINITIONS.pairingProtocolGate.sha), true);
  assert.equal(await repository.assertProtocol(), true);
  assert.deepEqual(
    client.commands.map((command) => command[0]),
    ["EVALSHA", "EVAL", "EVALSHA"]
  );

  client.values.set(repository._legacyGlobalKey, "foreign-protocol");
  await assert.rejects(
    repository.assertProtocol(),
    (error) => error.code === "pairing_protocol_gate"
  );
  await assert.rejects(
    client.evalSha("0".repeat(40), { keys: [], arguments: [] }),
    (error) => error.code === "NOSCRIPT"
  );
  await assert.rejects(
    client.eval("-- unknown script", { keys: [], arguments: [] }),
    /unexpected Redis EVAL source/
  );
});

test("Redis server version readiness accepts only well-formed supported majors", async () => {
  for (const [reply, expected] of [
    ["# Server\r\nredis_version:7.4.7\r\n", { major: 7, version: "7.4.7" }],
    [Buffer.from("# Server\nredis_version:8.2.0\n"), { major: 8, version: "8.2.0" }],
    ["# Server\r\nredis_version:8.0.0-rc1\r\n", { major: 8, version: "8.0.0-rc1" }],
  ]) {
    const commands = [];
    const client = {
      async sendCommand(command) {
        commands.push(command);
        return reply;
      },
    };
    assert.deepEqual(await assertRedisSupportedVersion(client), expected);
    assert.deepEqual(commands, [["INFO", "server"]]);
  }

  for (const reply of [
    null,
    "# Server\r\n",
    "redis_version:\r\n",
    "redis_version:8\r\n",
    "redis_version:8.x.0\r\n",
    "redis_version:08.2.0\r\n",
    "redis_version:8.2.0\r\nredis_version:8.2.0\r\n",
  ]) {
    await assert.rejects(
      assertRedisSupportedVersion({ sendCommand: async () => reply }),
      (error) => error.code === "redis_version_invalid"
    );
  }

  for (const version of ["6.2.19", "9.0.0"]) {
    await assert.rejects(
      assertRedisSupportedVersion({
        sendCommand: async () => "# Server\r\nredis_version:" + version + "\r\n",
      }),
      (error) => error.code === "redis_version_unsupported"
    );
  }
});

test("release Redis preflight accepts only the adjacent read-only protocol boundary", () => {
  const missing = { action: "status", changed: false, state: "missing", version: null };
  const v5 = { action: "status", changed: false, state: "ready", version: "5" };
  const v6 = { action: "status", changed: false, state: "ready", version: "6" };
  assert.equal(assertRedisReleaseProtocolCompatibility(missing, "initialize-v5"), missing);
  assert.equal(assertRedisReleaseProtocolCompatibility(v5, "initialize-v5"), v5);
  assert.equal(assertRedisReleaseProtocolCompatibility(v5, "advance-v6"), v5);
  assert.equal(assertRedisReleaseProtocolCompatibility(v6, "advance-v6"), v6);

  for (const [status, action] of [
    [v6, "initialize-v5"],
    [missing, "advance-v6"],
    [{ action: "status", changed: false, state: "malformed", version: null }, "initialize-v5"],
    [v5, "unsupported"],
  ]) {
    assert.throws(
      () => assertRedisReleaseProtocolCompatibility(status, action),
      (error) => error.code === "redis_release_protocol_incompatible"
    );
  }
});

function subtitleCanaryVersionId(key) {
  return "privacy-version-" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function subtitleCanaryRecord(input) {
  const versionId = subtitleCanaryVersionId(input.Key);
  return {
    body: Buffer.from(input.Body),
    head: {
      ChecksumSHA256: input.ChecksumSHA256,
      ContentLength: input.ContentLength,
      ContentType: input.ContentType,
      Metadata: { ...input.Metadata },
      ServerSideEncryption: input.ServerSideEncryption,
      VersionId: versionId,
    },
    versionId,
  };
}

function subtitleAclResponse(options = {}) {
  const ownerId = options.ownerId === undefined ? "private-owner" : options.ownerId;
  const granteeId =
    options.granteeId === undefined ? "private-owner" : options.granteeId;
  const grants = [
    {
      Grantee: {
        ID: granteeId,
        Type: options.type || "CanonicalUser",
      },
      Permission: options.permission || "FULL_CONTROL",
    },
  ];
  if (options.includeTigrisOrgAdmins === true) {
    grants.push({
      Grantee: {
        Type: "Group",
        URI: TIGRIS_ORG_ADMIN_ACL_URI,
      },
      Permission: "FULL_CONTROL",
    });
  }
  if (Array.isArray(options.extraGrants)) grants.push(...options.extraGrants);
  const response = {
    Grants: grants,
  };
  if (ownerId !== null) response.Owner = { ID: ownerId };
  return response;
}

function privateSubtitleS3Response(command, objects = null) {
  if (command.constructor.name === "GetPublicAccessBlockCommand") {
    return {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    };
  }
  if (command.constructor.name === "GetBucketPolicyStatusCommand") {
    return { PolicyStatus: { IsPublic: false } };
  }
  if (command.constructor.name === "GetBucketAclCommand") {
    return subtitleAclResponse({ includeTigrisOrgAdmins: true });
  }
  if (command.constructor.name === "GetObjectAclCommand") {
    return subtitleAclResponse({ includeTigrisOrgAdmins: true });
  }
  if (command.constructor.name === "PutObjectCommand") {
    const record = subtitleCanaryRecord(command.input);
    if (objects) {
      if (objects.has(command.input.Key)) {
        const error = new Error("precondition failed");
        error.name = "PreconditionFailed";
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      objects.set(command.input.Key, record);
    }
    return { ServerSideEncryption: "AES256", VersionId: record.versionId };
  }
  if (command.constructor.name === "HeadObjectCommand") {
    if (objects && objects.has(command.input.Key)) {
      return objects.get(command.input.Key).head;
    }
    const error = new Error("not found");
    error.name = "NoSuchKey";
    error.$metadata = { httpStatusCode: 404 };
    throw error;
  }
  if (command.constructor.name === "GetObjectCommand") {
    if (objects && objects.has(command.input.Key)) {
      const record = objects.get(command.input.Key);
      return {
        ...record.head,
        Body: Buffer.from(record.body),
      };
    }
    const error = new Error("not found");
    error.name = "NoSuchKey";
    error.$metadata = { httpStatusCode: 404 };
    throw error;
  }
  if (command.constructor.name === "ListObjectVersionsCommand") {
    const prefix = command.input.Prefix;
    return {
      DeleteMarkers: [],
      IsTruncated: false,
      Versions: objects
        ? [...objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, record]) => ({ Key: key, VersionId: record.versionId }))
        : [],
    };
  }
  if (command.constructor.name === "DeleteObjectCommand") {
    const record = objects && objects.get(command.input.Key);
    if (record && record.versionId === command.input.VersionId) {
      objects.delete(command.input.Key);
    }
    return {};
  }
  return {};
}

class FakeSubtitleS3Client extends EventEmitter {
  constructor(options = {}) {
    super();
    this.destroyCalls = 0;
    this.sendImpl = options.sendImpl || null;
    this.commands = [];
    this.objects = options.objects || new Map();
  }

  async send(command) {
    this.commands.push(command);
    if (this.sendImpl) {
      return this.sendImpl(
        command,
        (candidate = command) => privateSubtitleS3Response(candidate, this.objects),
        this
      );
    }
    return privateSubtitleS3Response(command, this.objects);
  }

  destroy() {
    this.destroyCalls += 1;
  }
}

function createStorageRuntime(config, options = {}) {
  const runtimeOptions =
    config &&
    config.environment !== "production" &&
    config.ttlDriver === "redis" &&
    options.subtitleObjectStore === undefined &&
    options.subtitleS3Client === undefined &&
    options.createSubtitleS3Client === undefined
      ? {
          createSubtitleS3Client: () => new FakeSubtitleS3Client(),
          ...options,
        }
      : options;
  return createStorageRuntimeImpl(config, runtimeOptions);
}

const SHORT_LIFECYCLE_TIMEOUTS = Object.freeze({
  startupMs: 100,
  migrationMs: 20,
  connectMs: 20,
  readinessMs: 20,
  shutdownMs: 20,
});

const CANARY_LIFECYCLE_TIMEOUTS = Object.freeze({
  startupMs: 300,
  migrationMs: 50,
  connectMs: 50,
  readinessMs: 100,
  shutdownMs: 50,
});

function productionConfig(overrides = {}) {
  return loadStorageConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://bridge:secret@db.example:5432/jumpgate",
    REDIS_URL: "redis://redis.example:6379/0",
    JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
    JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
    JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
    ...stableSubtitleStorage(),
    ...stableSecrets(),
    ...overrides,
  });
}

function developmentRedisConfig(overrides = {}) {
  return loadStorageConfig({
    NODE_ENV: "development",
    JUMPGATE_DURABLE_DRIVER: "postgres",
    JUMPGATE_TTL_DRIVER: "redis",
    DATABASE_URL: "postgresql://bridge:secret@db.example:5432/jumpgate",
    REDIS_URL: "redis://redis.example:6379/0",
    JUMPGATE_PROVIDER_MUTATION_MODE: "legacy",
    ...stableSubtitleStorage(),
    ...stableSecrets(),
    ...overrides,
  });
}

function configuredSubtitleAuthority(config) {
  return createSubtitleObjectKeyFactory(config.subtitleObjectKeys);
}

function tigrisDevelopmentConfig(overrides = {}) {
  return developmentRedisConfig({
    JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: "tigris-policy-status",
    ...overrides,
  });
}

async function expectTigrisReadinessFailure(sendImpl, options = {}) {
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  const s3Client = new FakeSubtitleS3Client({ sendImpl });
  await assert.rejects(
    createStorageRuntime(tigrisDevelopmentConfig(), {
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      createSubtitleS3Client: () => s3Client,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      ...(options.lifecycleTimeouts
        ? { lifecycleTimeouts: options.lifecycleTimeouts }
        : {}),
    }),
    (error) =>
      error.code === "subtitle_object_storage_unavailable" &&
      error.message === "subtitle object storage readiness failed"
  );
  assert.equal(s3Client.destroyCalls, 1);
  assert.equal(s3Client.listenerCount("error"), 0);
  assert.equal(redisClient.quitCalls, 1);
  assert.equal(pool.ended, 1);
  return s3Client;
}

function neverSettles() {
  return new Promise(() => {});
}

async function withPatchedDefaultStorageFactories(replacements, work) {
  const targets = [
    [require("pg"), "Pool", replacements.Pool],
    [require("redis"), "createClient", replacements.createRedisClient],
    [require("@aws-sdk/client-s3"), "S3Client", replacements.S3Client],
  ];
  const originals = targets.map(([target, name]) =>
    Object.getOwnPropertyDescriptor(target, name)
  );
  try {
    targets.forEach(([target, name, replacement]) => {
      Object.defineProperty(target, name, {
        ...Object.getOwnPropertyDescriptor(target, name),
        value: replacement,
      });
    });
    return await work();
  } finally {
    targets.forEach(([target, name], index) => {
      Object.defineProperty(target, name, originals[index]);
    });
  }
}

test("production readiness exposes the precise Tigris permanent-erasure blocker", () => {
  assert.equal(typeof assertProductionSubtitleErasureReadiness, "function");
  assert.throws(
    () => assertProductionSubtitleErasureReadiness(productionConfig()),
    (error) =>
      error.code === "subtitle_permanent_erasure_unverifiable" &&
      error.message ===
        "production subtitle erasure requires tigris-version-purge-v1 live provider attestation"
  );
});

test("production preflight probes and closes PostgreSQL before constructing Redis or S3", async () => {
  const events = [];
  let pool;
  let redisClient;
  let s3Client;
  class PreflightPool extends FakePool {
    constructor(options) {
      super({
        queryImpl(text) {
          events.push("postgres:query:" + text);
          return { rows: [{ ready: 1 }] };
        },
      });
      assert.equal(options.connectionString, productionConfig().databaseUrl);
      events.push("postgres:construct");
      pool = this;
    }
  }
  class PreflightRedisClient extends FakeRedisClient {
    async eval() {
      return ["missing", "", ""];
    }
  }
  class PreflightS3Client extends FakeSubtitleS3Client {
    constructor() {
      super();
      events.push("s3:construct");
      s3Client = this;
    }
  }

  const result = await withPatchedDefaultStorageFactories(
    {
      Pool: PreflightPool,
      createRedisClient() {
        events.push("redis:construct");
        redisClient = new PreflightRedisClient();
        return redisClient;
      },
      S3Client: PreflightS3Client,
    },
    () =>
      runProductionStoragePreflight(
        productionConfig({
          JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
        }),
        { expectedRedisAction: "initialize-v5" }
      )
  );

  assert.deepEqual(events.slice(0, 4), [
    "postgres:construct",
    "postgres:query:SELECT 1 AS ready",
    "s3:construct",
    "redis:construct",
  ]);
  assert.deepEqual(pool.queries, ["SELECT 1 AS ready"]);
  assert.equal(pool.ended, 1);
  assert.equal(redisClient.quitCalls, 1);
  assert.equal(s3Client.destroyCalls, 1);
  assert.deepEqual(result.redis, {
    major: 8,
    protocolState: "missing",
    protocolVersion: null,
    version: "8.2.0",
  });
  assert.deepEqual(result.subtitle, { attested: true });
});

test("production preflight PostgreSQL failures construct no Redis or S3", async () => {
  for (const phase of ["constructor", "probe"]) {
    const counters = { postgresEnds: 0, redis: 0, s3: 0 };
    class FailingPool extends EventEmitter {
      constructor() {
        super();
        if (phase !== "constructor") this.connect = async () => ({});
      }

      async query(text) {
        assert.equal(text, "SELECT 1 AS ready");
        throw new Error("controlled preflight query failure");
      }

      async end() {
        counters.postgresEnds += 1;
      }
    }

    await withPatchedDefaultStorageFactories(
      {
        Pool: FailingPool,
        createRedisClient() {
          counters.redis += 1;
          return new FakeRedisClient();
        },
        S3Client: class extends FakeSubtitleS3Client {
          constructor() {
            super();
            counters.s3 += 1;
          }
        },
      },
      async () => {
        await assert.rejects(
          runProductionStoragePreflight(
            productionConfig({
              JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
            }),
            { expectedRedisAction: "initialize-v5" }
          ),
          (error) => error.code === "production_postgres_preflight_failed",
          phase
        );
      }
    );
    assert.deepEqual(counters, { postgresEnds: 1, redis: 0, s3: 0 }, phase);
  }
});

test("production preflight closes every owned resource once across Redis and S3 failures", async () => {
  class WorkingPreflightRedisClient extends FakeRedisClient {
    async eval() {
      return ["missing", "", ""];
    }
  }

  const scenarios = [
    {
      name: "missing connect",
      createRedis() {
        return {
          destroyCalls: 0,
          destroy() {
            this.destroyCalls += 1;
          },
        };
      },
      expectedCode: "production_redis_preflight_failed",
    },
    {
      name: "throwing on",
      createRedis() {
        return {
          destroyCalls: 0,
          async connect() {},
          destroy() {
            this.destroyCalls += 1;
          },
          on() {
            throw new Error("listener registration failed with provider details");
          },
        };
      },
      expectedCode: "production_redis_preflight_failed",
    },
    {
      name: "connect failure",
      createRedis() {
        return new WorkingPreflightRedisClient({
          connectError: new Error("Redis connection failed"),
        });
      },
      expectedCode: "production_redis_preflight_failed",
    },
    {
      name: "readiness failure",
      createRedis() {
        return new WorkingPreflightRedisClient({
          pingImpl: async () => {
            throw new Error("Redis readiness failed");
          },
        });
      },
      expectedCode: "production_redis_preflight_failed",
    },
    {
      name: "subtitle readiness failure",
      createRedis() {
        return new WorkingPreflightRedisClient();
      },
      expectedCode: "production_subtitle_preflight_failed",
      failSubtitle: true,
    },
  ];

  for (const scenario of scenarios) {
    let pool;
    let redisClient;
    let s3Client;
    class PreflightPool extends FakePool {
      constructor() {
        super();
        pool = this;
      }
    }
    class PreflightS3Client extends FakeSubtitleS3Client {
      constructor() {
        super({
          sendImpl: scenario.failSubtitle
            ? async (command, next) => {
                if (command.constructor.name === "HeadBucketCommand") {
                  throw new Error("subtitle readiness failed");
                }
                return next();
              }
            : null,
        });
        s3Client = this;
      }
    }

    await withPatchedDefaultStorageFactories(
      {
        Pool: PreflightPool,
        createRedisClient() {
          redisClient = scenario.createRedis();
          return redisClient;
        },
        S3Client: PreflightS3Client,
      },
      async () => {
        await assert.rejects(
          runProductionStoragePreflight(
            productionConfig({
              JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE:
                "tigris-version-purge-v1",
            }),
            { expectedRedisAction: "initialize-v5" }
          ),
          (error) => error.code === scenario.expectedCode,
          scenario.name
        );
      }
    );

    assert.equal(pool.ended, 1, scenario.name + " PostgreSQL close");
    assert.equal(pool.destroyCalls, 0, scenario.name + " PostgreSQL force");
    assert.equal(s3Client.destroyCalls, 1, scenario.name + " S3 close");
    const redisCloseCalls =
      Number(redisClient.quitCalls || 0) +
      Number(redisClient.destroyCalls || 0) +
      Number(redisClient.closeCalls || 0) +
      Number(redisClient.disconnectCalls || 0);
    assert.equal(redisCloseCalls, 1, scenario.name + " Redis close/force");
    if (typeof redisClient.listenerCount === "function") {
      assert.equal(redisClient.listenerCount("error"), 0, scenario.name);
    }
    assert.equal(s3Client.listenerCount("error"), 0, scenario.name);
    assert.equal(pool.listenerCount("error"), 0, scenario.name);
  }
});

class ManualLifecycleTimers {
  constructor() {
    this.current = 0;
    this.nextHandle = 1;
    this.pending = new Map();
    this.now = () => this.current;
    this.setTimeout = (callback, delayMs) => {
      const handle = this.nextHandle++;
      this.pending.set(handle, {
        callback,
        deadline: this.current + Number(delayMs),
        handle,
      });
      return handle;
    };
    this.clearTimeout = (handle) => {
      this.pending.delete(handle);
    };
  }

  deadlines() {
    return [...this.pending.values()]
      .sort((left, right) => left.deadline - right.deadline || left.handle - right.handle)
      .map((timer) => timer.deadline);
  }

  async advanceTo(target) {
    assert.ok(target >= this.current, "manual lifecycle clock cannot move backward");
    while (true) {
      const due = [...this.pending.values()]
        .filter((timer) => timer.deadline <= target)
        .sort((left, right) => left.deadline - right.deadline || left.handle - right.handle)[0];
      if (!due) break;
      this.current = due.deadline;
      this.pending.delete(due.handle);
      due.callback();
      await eventLoopLoad(8);
    }
    this.current = target;
    await eventLoopLoad(8);
  }
}

async function eventLoopLoad(turns = 64) {
  let chain = Promise.resolve();
  for (let index = 0; index < turns; index += 1) chain = chain.then(() => {});
  await chain;
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await eventLoopLoad(8);
  }
  assert.fail(message);
}

function invalidJsonPayloads() {
  const cyclic = {};
  cyclic.self = cyclic;
  return [
    { label: "NUL", pattern: /NUL/, value: "bad\u0000value" },
    { label: "lone surrogate", pattern: /lone UTF-16 surrogate/, value: "\ud800" },
    { label: "unsafe integer", pattern: /unsafe integer/, value: Number.MAX_SAFE_INTEGER + 1 },
    { label: "cycle", pattern: /cycle/, value: cyclic },
    { label: "non-plain object", pattern: /non-plain object/, value: new Date(0) },
    { label: "sparse array", pattern: /unsupported array/, value: new Array(1) },
    { label: "unsupported value", pattern: /unsupported value/, value: undefined },
  ];
}

test("storage primitives share configured purpose-specific security material", () => {
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes: deterministicRandom() });
  const primitives = createStoragePrimitives(config, { randomBytes: deterministicRandom() });
  const issued = primitives.tokenService.issue("install");
  const envelope = primitives.envelopeCrypto.encryptJson({ private: "value" }, "settings");

  assert.equal(primitives.tokenService.matchesToken("install", issued.token, issued.tokenHash), true);
  assert.equal(primitives.tokenService.matchesToken("device", issued.token, issued.tokenHash), false);
  assert.deepEqual(primitives.envelopeCrypto.decryptJson(envelope, "settings"), { private: "value" });
});

test("memory composition returns a contract-complete isolated repository set", async () => {
  const randomBytes = deterministicRandom();
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  let id = 0;
  const nextId = (prefix) => () => prefix + "_" + String(++id).padStart(8, "0");
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: nextId("profile"),
    deviceIdFactory: nextId("device"),
    providerIdFactory: nextId("provider"),
    pairingIdFactory: nextId("pairing"),
    backupIdFactory: nextId("backup"),
  });

  assert.equal(assertRepositorySet(storage.repositories), storage.repositories);
  assert.equal(assertObjectStore(storage.subtitleObjectStore), storage.subtitleObjectStore);
  const created = await storage.repositories.profiles.create({ displayName: "Living room" });
  assert.equal(created.profile.displayName, "Living room");
  assert.deepEqual(await storage.repositories.profiles.getByInstallToken(created.installToken), created.profile);
});

test("factory-created memory repositories enforce the strict JSON persistence domain", async () => {
  const randomBytes = deterministicRandom();
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_memory_json",
  });
  await storage.repositories.profiles.create({ displayName: "JSON domain" });

  for (const invalid of invalidJsonPayloads()) {
    await assert.rejects(
      storage.repositories.oauthCredentials.put(
        "profile_memory_json",
        "realdebrid",
        { payload: invalid.value },
        0
      ),
      invalid.pattern,
      invalid.label
    );
  }

  const accepted = {
    emoji: "\ud83d\ude00",
    fraction: 1.25,
    nested: [null, true, { value: "ok" }],
  };
  await storage.repositories.oauthCredentials.put(
    "profile_memory_json",
    "realdebrid",
    accepted,
    0
  );
  assert.deepEqual(
    (await storage.repositories.oauthCredentials.get("profile_memory_json", "realdebrid"))
      .credentials,
    accepted
  );
});

test("memory composition refuses a configuration intended for production drivers", () => {
  const key = Buffer.alloc(32, 7);
  const config = {
    durableDriver: "postgres",
    ttlDriver: "redis",
    tokenPepper: key,
    envelopeKeys: new Map([["key", key]]),
    primaryEnvelopeKeyId: "key",
  };
  assert.throws(() => createMemoryRepositorySet(config), /requires memory storage drivers/);
});

test("runtime validation rejects empty manually assembled connection settings", async () => {
  const key = Buffer.alloc(32, 7);
  const base = {
    tokenPepper: key,
    envelopeKeys: new Map([["key", key]]),
    primaryEnvelopeKeyId: "key",
  };
  await assert.rejects(
    createStorageRuntime({ ...base, durableDriver: "postgres", ttlDriver: "memory", databaseUrl: "" }),
    /database URL is invalid/
  );
  await assert.rejects(
    createStorageRuntime({ ...base, durableDriver: "memory", ttlDriver: "redis", redisUrl: "" }),
    /Redis URL is invalid/
  );
  await assert.rejects(
    createStorageRuntime({ ...base, durableDriver: "sqlite", ttlDriver: "memory", sqlitePath: "" }),
    /SQLite path is invalid/
  );
});

test("factory independently enforces topology, URL protocols, and persistent SQLite", () => {
  const key = Buffer.alloc(32, 7);
  const security = {
    tokenPepper: key,
    envelopeKeys: new Map([["key", key]]),
    primaryEnvelopeKeyId: "key",
  };
  assert.throws(
    () =>
      createStoragePrimitives({
        ...security,
        durableDriver: "sqlite",
        ttlDriver: "memory",
        sqlitePath: path.resolve("state.sqlite3"),
      }),
    /environment is invalid/
  );
  assert.throws(
    () =>
      createStoragePrimitives({
        ...security,
        environment: "production",
        durableDriver: "sqlite",
        ttlDriver: "memory",
        sqlitePath: path.resolve("state.sqlite3"),
      }),
    /production requires PostgreSQL durable storage and Redis TTL storage/
  );
  assert.throws(
    () =>
      createStoragePrimitives({
        ...security,
        environment: "development",
        durableDriver: "memory",
        ttlDriver: "memory",
      }),
    /test-only/
  );
  assert.throws(
    () =>
      createStoragePrimitives({
        ...security,
        environment: "production",
        durableDriver: "postgres",
        ttlDriver: "redis",
        databaseUrl: "https://db.example/jumpgate",
        redisUrl: "redis://redis.example/0",
      }),
    /database URL is invalid/
  );
  assert.throws(
    () =>
      createStoragePrimitives({
        ...security,
        environment: "production",
        durableDriver: "postgres",
        ttlDriver: "redis",
        databaseUrl: "postgresql://db.example/jumpgate",
        redisUrl: "https://redis.example/0",
      }),
    /Redis URL is invalid/
  );
  for (const sqlitePath of [":memory:", "file::memory:?cache=shared", "relative.sqlite3"]) {
    assert.throws(
      () =>
        createStoragePrimitives({
          ...security,
          environment: "development",
          durableDriver: "sqlite",
          ttlDriver: "memory",
          sqlitePath,
        }),
      /SQLite path/
    );
  }
});

test("runtime composes persistent SQLite with process-local TTL repositories", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-sqlite-"));
  const sqlitePath = path.join(directory, "nested", "jumpgate.sqlite3");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = loadStorageConfig({
    NODE_ENV: "development",
    JUMPGATE_DURABLE_DRIVER: "sqlite",
    JUMPGATE_TTL_DRIVER: "memory",
    JUMPGATE_SQLITE_PATH: sqlitePath,
    ...stableSecrets(),
  });

  const runtime = await createStorageRuntime(config);
  assert.equal(assertRepositorySet(runtime.repositories), runtime.repositories);
  assert.equal(assertObjectStore(runtime.subtitleObjectStore), runtime.subtitleObjectStore);
  assert.deepEqual(await runtime.ready(), {
    status: "ready",
    durableDriver: "sqlite",
    ttlDriver: "memory",
  });
  assert.deepEqual(runtime.migrationResult.verified, [
    "0001_initial",
    "0002_contract_parity",
    "0003_provider_mutation_fence",
    "0004_lifecycle_controls",
    "0005_lifecycle_security_outbox",
    "0006_durable_subtitle_manifests",
    "0007_scrobble_dispatch",
    "0008_claim_bound_history",
    "0009_dispatch_history_generation",
    "0010_history_http_receipts",
  ]);
  assert.equal(fs.existsSync(sqlitePath), true);

  const created = await runtime.repositories.profiles.create({ displayName: "Persistent profile" });
  assert.equal(created.profile.displayName, "Persistent profile");
  const firstClose = runtime.close();
  assert.equal(runtime.close(), firstClose);
  await firstClose;
  assert.equal(runtime.state, "closed");
  await assert.rejects(runtime.ready(), { code: "storage_not_ready" });
});

test("SQLite runtime deadline rolls back and closes an owned injected handle", async (t) => {
  const Database = require("better-sqlite3");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-deadline-"));
  const sqlitePath = path.join(directory, "deadline.sqlite3");
  const database = new Database(sqlitePath);
  t.after(() => {
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let now = 0;
  database.function("expire_runtime_migration", () => {
    now = 20;
    return 1;
  });
  const config = loadStorageConfig({
    NODE_ENV: "development",
    JUMPGATE_DURABLE_DRIVER: "sqlite",
    JUMPGATE_TTL_DRIVER: "memory",
    JUMPGATE_SQLITE_PATH: sqlitePath,
    ...stableSecrets(),
  });

  await assert.rejects(
    createStorageRuntime(config, {
      closeInjectedResources: true,
      lifecycleTimers: { now: () => now },
      lifecycleTimeouts: {
        startupMs: 100,
        migrationMs: 10,
        connectMs: 20,
        readinessMs: 20,
        shutdownMs: 20,
      },
      sqliteDatabase: database,
      sqliteRepositoryOptions: {
        fs: {
          readdirSync() {
            return ["0001_expire.sql"];
          },
          readFileSync() {
            return Buffer.from(
              "CREATE TABLE runtime_migration_should_rollback (id INTEGER);\n" +
                "SELECT expire_runtime_migration();\n",
              "utf8"
            );
          },
        },
      },
    }),
    (error) => error.code === "storage_timeout" && error.phase === "SQLite migration"
  );
  assert.equal(database.open, false);

  const reopened = new Database(sqlitePath);
  try {
    assert.equal(
      reopened
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE name IN " +
            "('runtime_migration_should_rollback', 'schema_migrations')"
        )
        .get().count,
      0
    );
  } finally {
    reopened.close();
  }
});

test("runtime owns configured clients, migrates before readiness, and shuts down once", async () => {
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  let migrations = 0;
  const config = developmentRedisConfig();

  const runtime = await createStorageRuntime(config, {
    createPostgresPool(poolOptions) {
      assert.equal(poolOptions.connectionString, config.databaseUrl);
      return pool;
    },
    createRedisClient(clientOptions) {
      assert.equal(clientOptions.url, config.redisUrl);
      return redisClient;
    },
    async runPostgresMigrations(database) {
      migrations += 1;
      assert.equal(typeof database.query, "function");
      return { applied: ["0001_initial"], alreadyApplied: [], verified: ["0001_initial"] };
    },
  });

  assert.equal(migrations, 1);
  assert.equal(redisClient.connectCalls, 1);
  assert.equal(redisClient.pingCalls, 1);
  assert.deepEqual(
    redisClient.commands.map((command) => command[0]),
    ["INFO", "ROLE", "SET", "DEL", "EVALSHA", "EVAL"]
  );
  assert.match(redisClient.commands[2][1], /^jg:v1:readiness:[a-f0-9]{64}$/);
  assert.equal(redisClient.commands[2][1].includes(redisClient.commands[2][2]), false);
  assert.equal(redisClient.values.size, 1);
  assert.equal(pool.queries.length, 3);
  assert.equal(pool.queries[0], "SELECT 1 AS ready");
  assert.equal(pool.queries[1], "SELECT 1 AS ready");
  assert.match(pool.queries[2], /WITH target_table AS/);
  assert.equal(assertRepositorySet(runtime.repositories), runtime.repositories);
  await runtime.ready();
  assert.equal(redisClient.pingCalls, 2);
  assert.deepEqual(
    redisClient.commands.map((command) => command[0]),
    [
      "INFO", "ROLE", "SET", "DEL", "EVALSHA", "EVAL",
      "INFO", "ROLE", "SET", "DEL", "EVALSHA",
    ]
  );
  assert.equal(redisClient.values.size, 1);
  assert.equal(pool.queries.length, 5);
  assert.equal(pool.queries[3], "SELECT 1 AS ready");
  assert.match(pool.queries[4], /WITH target_table AS/);

  await runtime.close();
  await runtime.close();
  assert.equal(pool.ended, 1);
  assert.equal(redisClient.quitCalls, 1);
});

test("runtime probes PostgreSQL before migrations, Redis, or S3 construction", async () => {
  const events = [];
  const pool = new FakePool({
    queryImpl(text) {
      events.push("postgres:query:" + text);
      return { rows: [{ ready: 1 }] };
    },
  });
  const redisClient = new FakeRedisClient();
  const s3Client = new FakeSubtitleS3Client();
  const runtime = await createStorageRuntime(developmentRedisConfig(), {
    createPostgresPool() {
      events.push("postgres:construct");
      return pool;
    },
    createRedisClient() {
      events.push("redis:construct");
      return redisClient;
    },
    createSubtitleS3Client() {
      events.push("s3:construct");
      return s3Client;
    },
    async runPostgresMigrations() {
      events.push("postgres:migrate");
      return { applied: [], alreadyApplied: [], verified: [] };
    },
  });

  assert.deepEqual(events.slice(0, 5), [
    "postgres:construct",
    "postgres:query:SELECT 1 AS ready",
    "postgres:migrate",
    "s3:construct",
    "redis:construct",
  ]);
  await runtime.close();
  assert.equal(pool.ended, 1);
});

test("PostgreSQL constructor, probe, and migration failures construct no Redis or S3", async () => {
  for (const phase of ["constructor", "probe", "migration"]) {
    let redisConstructions = 0;
    let s3Constructions = 0;
    let migrationCalls = 0;
    let pool;
    if (phase === "constructor") {
      pool = new EventEmitter();
      pool.ended = 0;
      pool.query = async () => ({ rows: [{ ready: 1 }] });
      pool.end = async () => {
        pool.ended += 1;
      };
    } else {
      pool = new FakePool({
        queryImpl:
          phase === "probe"
            ? async () => {
                throw new Error("controlled PostgreSQL probe failure");
              }
            : null,
      });
    }

    await assert.rejects(
      createStorageRuntime(developmentRedisConfig(), {
        createPostgresPool: () => pool,
        createRedisClient() {
          redisConstructions += 1;
          return new FakeRedisClient();
        },
        createSubtitleS3Client() {
          s3Constructions += 1;
          return new FakeSubtitleS3Client();
        },
        async runPostgresMigrations() {
          migrationCalls += 1;
          if (phase === "migration") {
            throw new Error("controlled PostgreSQL migration failure");
          }
          return { applied: [], alreadyApplied: [], verified: [] };
        },
      }),
      phase === "constructor"
        ? /must implement connect/
        : new RegExp("controlled PostgreSQL " + phase + " failure"),
      phase
    );
    assert.equal(redisConstructions, 0, phase);
    assert.equal(s3Constructions, 0, phase);
    assert.equal(migrationCalls, phase === "migration" ? 1 : 0, phase);
    assert.equal(pool.ended, 1, phase);
    assert.equal(pool.listenerCount("error"), 0, phase);
  }
});

test("Redis composition shares one configured subtitle authority with S3", async () => {
  const config = developmentRedisConfig();
  const expectedAuthority = configuredSubtitleAuthority(config);
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  const s3Client = new FakeSubtitleS3Client();
  let s3ClientOptions;
  const runtime = await createStorageRuntime(config, {
    createPostgresPool: () => pool,
    createRedisClient: () => redisClient,
    createSubtitleS3Client(options) {
      s3ClientOptions = options;
      return s3Client;
    },
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
  });

  const components = ["subtitle-staging-v1", "artifact", "attempt", "1"];
  assert.ok(
    runtime.repositories.subtitleDeliveries._objectKeys instanceof OpaqueObjectKeyFactory
  );
  assert.equal(
    runtime.subtitleObjectStore.createKey(components),
    expectedAuthority.create(components)
  );
  assert.deepEqual(
    s3Client.commands.map((command) => command.constructor.name),
    ["HeadBucketCommand", "GetPublicAccessBlockCommand", "GetBucketPolicyStatusCommand"]
  );
  assert.ok(
    s3Client.commands.every(
      (command) => command.input.Bucket === config.subtitleS3.bucket
    )
  );
  assert.equal(s3ClientOptions.endpoint, config.subtitleS3.endpoint);
  assert.equal(s3ClientOptions.region, config.subtitleS3.region);
  assert.equal(s3ClientOptions.forcePathStyle, false);
  assert.deepEqual(s3ClientOptions.credentials, {
    accessKeyId: config.subtitleS3.accessKeyId,
    secretAccessKey: config.subtitleS3.secretAccessKey,
  });

  await runtime.ready();
  assert.deepEqual(
    s3Client.commands.map((command) => command.constructor.name),
    [
      "HeadBucketCommand",
      "GetPublicAccessBlockCommand",
      "GetBucketPolicyStatusCommand",
      "HeadBucketCommand",
      "GetPublicAccessBlockCommand",
      "GetBucketPolicyStatusCommand",
    ]
  );
  await runtime.close();
  await runtime.close();
  assert.equal(s3Client.destroyCalls, 1);
  assert.equal(s3Client.listenerCount("error"), 0);
});

test("development Redis accepts only attested hardened store and factory injection", async () => {
  const config = developmentRedisConfig();
  const objectKeyFactory = configuredSubtitleAuthority(config);
  const s3Client = new FakeSubtitleS3Client();
  const subtitleObjectStore = createHardenedSubtitleObjectStore(config, {
    client: s3Client,
  });
  const runtime = await createStorageRuntime(config, {
    closeInjectedResources: true,
    createPostgresPool: () => new FakePool(),
    createRedisClient: () => new FakeRedisClient(),
    objectKeyFactory,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    subtitleObjectStore,
  });

  assert.equal(runtime.subtitleObjectStore, subtitleObjectStore);
  assert.equal(runtime.repositories.subtitleDeliveries._objectKeys, objectKeyFactory);
  assert.deepEqual(
    s3Client.commands.map((command) => command.constructor.name),
    ["HeadBucketCommand", "GetPublicAccessBlockCommand", "GetBucketPolicyStatusCommand"]
  );
  await runtime.close();
  assert.equal(s3Client.destroyCalls, 1);
});

test("production rejects every injected subtitle client, factory, and store", async () => {
  const config = productionConfig();
  const configuredAuthority = configuredSubtitleAuthority(config);
  const memoryStore = new MemorySubtitleObjectStore({
    objectKeyFactory: configuredAuthority,
  });
  let clientCreations = 0;
  const cases = [
    { name: "object-key factory", options: { objectKeyFactory: configuredAuthority } },
    { name: "memory object store", options: { subtitleObjectStore: memoryStore } },
    {
      name: "S3 client",
      options: { subtitleS3Client: new FakeSubtitleS3Client() },
    },
    {
      name: "S3 client factory",
      options: {
        createSubtitleS3Client: () => {
          clientCreations += 1;
          return new FakeSubtitleS3Client();
        },
      },
    },
  ];

  for (const entry of cases) {
    await assert.rejects(
      createStorageRuntime(config, entry.options),
      /production subtitle storage does not allow injected clients, factories, or stores/,
      entry.name
    );
  }
  assert.equal(clientCreations, 0);

  await assert.rejects(
    createStorageRuntime(developmentRedisConfig(), {
      subtitleObjectStoreOptions: { keyHmacCurrentKeyId: "wrong-authority" },
    }),
    /may not override configured keyHmacCurrentKeyId/
  );
});

test("authority fingerprints reject extra, missing, and changed rotation keys", async () => {
  const config = developmentRedisConfig();
  const base = config.subtitleObjectKeys;
  const reversed = {
    currentKeyId: base.currentKeyId,
    keyring: [...base.keyring].reverse(),
  };
  assert.equal(
    subtitleObjectKeyAuthorityFingerprint(reversed),
    subtitleObjectKeyAuthorityFingerprint(base)
  );

  const variants = [
    {
      label: "extra",
      config: {
        currentKeyId: base.currentKeyId,
        keyring: [
          ...base.keyring,
          { id: "subtitle-extra", secret: Buffer.alloc(32, 0x63) },
        ],
      },
    },
    {
      label: "missing",
      config: {
        currentKeyId: base.currentKeyId,
        keyring: base.keyring.filter((entry) => entry.id === base.currentKeyId),
      },
    },
    {
      label: "changed",
      config: {
        currentKeyId: base.currentKeyId,
        keyring: base.keyring.map((entry) =>
          entry.id === base.currentKeyId
            ? { id: entry.id, secret: Buffer.alloc(32, 0x64) }
            : entry
        ),
      },
    },
  ];

  for (const variant of variants) {
    assert.notEqual(
      subtitleObjectKeyAuthorityFingerprint(variant.config),
      subtitleObjectKeyAuthorityFingerprint(base),
      variant.label
    );
    await assert.rejects(
      createStorageRuntime(config, {
        objectKeyFactory: createSubtitleObjectKeyFactory(variant.config),
      }),
      /does not match configured subtitle authority/,
      variant.label
    );
    const mismatchedClient = new FakeSubtitleS3Client();
    const mismatchedStore = createHardenedSubtitleObjectStore(
      { ...config, subtitleObjectKeys: variant.config },
      { client: mismatchedClient }
    );
    await assert.rejects(
      createStorageRuntime(config, { subtitleObjectStore: mismatchedStore }),
      /not a hardened store for the configured subtitle authority/,
      variant.label + " store"
    );
    assert.equal(mismatchedClient.destroyCalls, 0);
  }
});

test("factory independently rejects invalid subtitle endpoints and keyrings", async () => {
  const config = productionConfig();
  const subtitleS3 = {
    accessKeyId: config.subtitleS3.accessKeyId,
    bucket: config.subtitleS3.bucket,
    endpoint: "https://s3.example.com",
    forcePathStyle: false,
    privacyMode: "strict",
    region: config.subtitleS3.region,
    secretAccessKey: config.subtitleS3.secretAccessKey,
  };
  await assert.rejects(
    createStorageRuntimeImpl({ ...config, subtitleS3 }),
    /subtitle S3 endpoint is invalid or untrusted/
  );
  await assert.rejects(
    createStorageRuntimeImpl({
      ...config,
      subtitleObjectKeys: { currentKeyId: "subtitle-current", keyring: [] },
    }),
    /subtitle object key keyring is invalid/
  );
});

test("Redis repository options cannot bypass the configured subtitle authority", async () => {
  const config = developmentRedisConfig();
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  const s3Client = new FakeSubtitleS3Client();
  await assert.rejects(
    createStorageRuntime(config, {
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      createSubtitleS3Client: () => s3Client,
      redisRepositoryOptions: {
        objectKeyFactory: configuredSubtitleAuthority(config),
      },
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    }),
    /may not override configured objectKeyFactory/
  );
  assert.equal(s3Client.destroyCalls, 1);
  assert.equal(redisClient.quitCalls, 0);
  assert.equal(pool.ended, 1);
});

test("subtitle S3 client ownership follows injection and close opt-in", async () => {
  for (const closeInjectedResources of [false, true]) {
    const s3Client = new FakeSubtitleS3Client();
    const runtime = await createStorageRuntime(developmentRedisConfig(), {
      closeInjectedResources,
      createPostgresPool: () => new FakePool(),
      createRedisClient: () => new FakeRedisClient(),
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      subtitleS3Client: s3Client,
    });

    await runtime.close();
    assert.equal(s3Client.destroyCalls, closeInjectedResources ? 1 : 0);
    assert.equal(s3Client.listenerCount("error"), 0);
  }
});

test("subtitle S3 readiness failures are redacted and clean owned resources", async () => {
  const reflectedSecret = "AWS_SECRET_ACCESS_KEY=must-never-reflect";
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  const s3Client = new FakeSubtitleS3Client({
    sendImpl: () => {
      throw new Error(reflectedSecret);
    },
  });

  let failure;
  try {
    await createStorageRuntime(developmentRedisConfig(), {
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      createSubtitleS3Client: () => s3Client,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  assert.equal(failure.code, "subtitle_object_storage_unavailable");
  assert.match(failure.message, /readiness failed/);
  assert.doesNotMatch(String(failure.stack), new RegExp(reflectedSecret));
  assert.equal(s3Client.commands.length, 1);
  assert.equal(s3Client.commands[0].constructor.name, "HeadBucketCommand");
  assert.equal(s3Client.destroyCalls, 1);
  assert.equal(redisClient.quitCalls, 1);
  assert.equal(pool.ended, 1);
  assert.equal(s3Client.listenerCount("error"), 0);
});

test("strict subtitle privacy readiness rejects missing, public, and unsupported state", async () => {
  const cases = [
    {
      name: "missing public-access block",
      response(command) {
        if (command.constructor.name === "GetPublicAccessBlockCommand") return {};
        return privateSubtitleS3Response(command);
      },
    },
    {
      name: "incomplete public-access block",
      response(command) {
        if (command.constructor.name !== "GetPublicAccessBlockCommand") {
          return privateSubtitleS3Response(command);
        }
        const response = privateSubtitleS3Response(command);
        response.PublicAccessBlockConfiguration.RestrictPublicBuckets = false;
        return response;
      },
    },
    {
      name: "public bucket policy",
      response(command) {
        if (command.constructor.name === "GetBucketPolicyStatusCommand") {
          return { PolicyStatus: { IsPublic: true } };
        }
        return privateSubtitleS3Response(command);
      },
    },
    {
      name: "missing bucket policy status",
      response(command) {
        if (command.constructor.name === "GetBucketPolicyStatusCommand") return {};
        return privateSubtitleS3Response(command);
      },
    },
    {
      name: "unsupported public-access API",
      response(command) {
        if (command.constructor.name === "GetPublicAccessBlockCommand") {
          const error = new Error("NotImplemented");
          error.name = "NotImplemented";
          throw error;
        }
        return privateSubtitleS3Response(command);
      },
    },
    {
      name: "unsupported bucket-policy API",
      response(command) {
        if (command.constructor.name === "GetBucketPolicyStatusCommand") {
          const error = new Error("NotImplemented");
          error.name = "NotImplemented";
          throw error;
        }
        return privateSubtitleS3Response(command);
      },
    },
  ];

  for (const entry of cases) {
    const pool = new FakePool();
    const redisClient = new FakeRedisClient();
    const s3Client = new FakeSubtitleS3Client({ sendImpl: entry.response });
    await assert.rejects(
      createStorageRuntime(developmentRedisConfig(), {
        createPostgresPool: () => pool,
        createRedisClient: () => redisClient,
        createSubtitleS3Client: () => s3Client,
        runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      }),
      (error) =>
        error.code === "subtitle_object_storage_unavailable" &&
        /readiness failed/.test(error.message),
      entry.name
    );
    assert.equal(s3Client.destroyCalls, 1, entry.name);
    assert.equal(redisClient.quitCalls, 1, entry.name);
    assert.equal(pool.ended, 1, entry.name);
  }
});

test("Tigris privacy readiness creates and replays one durable private canary", async () => {
  const config = tigrisDevelopmentConfig();
  const objects = new Map();
  const expectedKey = configuredSubtitleAuthority(config).create([
    "privacy-readiness-canary-v1",
  ]);
  const firstClient = new FakeSubtitleS3Client({ objects });
  const firstRuntime = await createStorageRuntime(config, {
    createPostgresPool: () => new FakePool(),
    createRedisClient: () => new FakeRedisClient(),
    createSubtitleS3Client: () => firstClient,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
  });

  assert.deepEqual(
    firstClient.commands.map((command) => command.constructor.name),
    [
      "HeadBucketCommand",
      "GetBucketAclCommand",
      "GetBucketPolicyStatusCommand",
      "PutObjectCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
      "GetObjectAclCommand",
    ]
  );
  const firstPut = firstClient.commands.find(
    (command) => command.constructor.name === "PutObjectCommand"
  );
  assert.equal(firstPut.input.Key, expectedKey);
  assert.equal(Object.hasOwn(firstPut.input, "ACL"), false);
  assert.equal(firstPut.input.CacheControl, "private, no-store");
  assert.equal(firstPut.input.ContentLength, 1);
  assert.equal(firstPut.input.ServerSideEncryption, "AES256");
  assert.equal(firstPut.input.IfNoneMatch, "*");
  assert.deepEqual(Buffer.from(firstPut.input.Body), CANARY_BODY);
  assert.match(expectedKey, /^subtitles\/v1\/subtitle-current\/[A-Za-z0-9_/-]+$/);
  assert.equal(expectedKey.includes("privacy-readiness-canary"), false);
  assert.equal(objects.size, 1);
  assert.deepEqual(objects.get(expectedKey).body, CANARY_BODY);
  assert.equal(objects.get(expectedKey).head.ChecksumSHA256, firstPut.input.ChecksumSHA256);
  assert.equal(objects.get(expectedKey).head.ContentLength, 1);
  assert.equal(objects.get(expectedKey).head.ContentType, "application/octet-stream");
  assert.equal(objects.get(expectedKey).head.ServerSideEncryption, "AES256");
  const firstVersionId = objects.get(expectedKey).versionId;
  assert.equal(objects.get(expectedKey).head.VersionId, firstVersionId);
  for (const commandName of [
    "HeadObjectCommand",
    "GetObjectCommand",
    "GetObjectAclCommand",
  ]) {
    const command = firstClient.commands.find(
      (candidate) => candidate.constructor.name === commandName
    );
    assert.equal(command.input.VersionId, firstVersionId, commandName);
  }
  assert.equal(
    objects.get(expectedKey).head.Metadata["jumpgate-sha256"],
    CANARY_SHA256
  );
  assert.equal(
    firstClient.commands.some((command) => command.constructor.name === "DeleteObjectCommand"),
    false
  );
  await firstRuntime.close();

  const existing = objects.get(expectedKey);
  const replayClient = new FakeSubtitleS3Client({ objects });
  const replayRuntime = await createStorageRuntime(config, {
    createPostgresPool: () => new FakePool(),
    createRedisClient: () => new FakeRedisClient(),
    createSubtitleS3Client: () => replayClient,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
  });
  assert.deepEqual(
    replayClient.commands.map((command) => command.constructor.name),
    [
      "HeadBucketCommand",
      "GetBucketAclCommand",
      "GetBucketPolicyStatusCommand",
      "PutObjectCommand",
      "HeadObjectCommand",
      "HeadObjectCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
      "GetObjectAclCommand",
    ]
  );
  assert.equal(objects.size, 1);
  assert.equal(objects.get(expectedKey), existing);
  assert.deepEqual(objects.get(expectedKey).body, CANARY_BODY);
  const replayVersionReads = replayClient.commands.filter(
    (command) =>
      new Set(["HeadObjectCommand", "GetObjectCommand", "GetObjectAclCommand"]).has(
        command.constructor.name
      ) && command.input.VersionId !== undefined
  );
  assert.deepEqual(
    replayVersionReads.map((command) => command.input.VersionId),
    [firstVersionId, firstVersionId, firstVersionId]
  );
  await replayRuntime.close();
  assert.equal(firstClient.destroyCalls, 1);
  assert.equal(replayClient.destroyCalls, 1);
});

test("Tigris privacy readiness rejects version substitution on version-bearing reads", async () => {
  for (const commandName of [
    "HeadObjectCommand",
    "GetObjectCommand",
  ]) {
    const client = await expectTigrisReadinessFailure((command, fallback) => {
      const response = fallback();
      return command.constructor.name === commandName
        ? { ...response, VersionId: "substituted-provider-version" }
        : response;
    });
    const put = client.commands.find(
      (command) => command.constructor.name === "PutObjectCommand"
    );
    const read = client.commands.find(
      (command) => command.constructor.name === commandName
    );
    const versionId = client.objects.get(put.input.Key).versionId;
    assert.equal(read.input.VersionId, versionId, commandName);
    assert.notEqual(read.input.VersionId, "substituted-provider-version", commandName);
  }
});

test("Tigris keeps AES256 requests while tolerating its missing SSE response echo", async () => {
  const config = tigrisDevelopmentConfig();
  const objects = new Map();
  const client = new FakeSubtitleS3Client({
    objects,
    sendImpl(command, fallback) {
      const response = fallback();
      if (
        new Set(["PutObjectCommand", "HeadObjectCommand", "GetObjectCommand"]).has(
          command.constructor.name
        )
      ) {
        const compatible = { ...response };
        delete compatible.ServerSideEncryption;
        return compatible;
      }
      return response;
    },
  });
  const runtime = await createStorageRuntime(config, {
    createPostgresPool: () => new FakePool(),
    createRedisClient: () => new FakeRedisClient(),
    createSubtitleS3Client: () => client,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
  });

  const put = client.commands.find((command) => command.constructor.name === "PutObjectCommand");
  assert.ok(put);
  assert.equal(put.input.ServerSideEncryption, "AES256");
  await runtime.close();
});

test("non-Tigris hardened stores still require the AES256 response echo", async () => {
  const config = developmentRedisConfig();
  const client = new FakeSubtitleS3Client({
    sendImpl(command, fallback) {
      if (command.constructor.name === "PutObjectCommand") return {};
      return fallback();
    },
  });
  const store = createHardenedSubtitleObjectStore(config, { client });
  const key = store.createKey(["strict-sse-response"]);

  await assert.rejects(
    store.put(key, Buffer.from("strict")),
    (error) => error.code === "object_store_integrity" && error.operation === "put"
  );
});

test("Tigris canary rotation retains one object per object-key generation", async () => {
  const firstConfig = tigrisDevelopmentConfig();
  const objects = new Map();
  const firstClient = new FakeSubtitleS3Client({ objects });
  const firstRuntime = await createStorageRuntime(firstConfig, {
    createPostgresPool: () => new FakePool(),
    createRedisClient: () => new FakeRedisClient(),
    createSubtitleS3Client: () => firstClient,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
  });
  await firstRuntime.close();
  const firstKey = [...objects.keys()][0];

  const nextKeyring = [
    ...firstConfig.subtitleObjectKeys.keyring.map((entry) => ({
      id: entry.id,
      key: entry.secret.toString("base64url"),
    })),
    {
      id: "subtitle-next",
      key: Buffer.alloc(32, 0x53).toString("base64url"),
    },
  ];
  const rotatedConfig = tigrisDevelopmentConfig({
    JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID: "subtitle-next",
    JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: JSON.stringify(nextKeyring),
  });
  const rotatedClient = new FakeSubtitleS3Client({ objects });
  const rotatedRuntime = await createStorageRuntime(rotatedConfig, {
    createPostgresPool: () => new FakePool(),
    createRedisClient: () => new FakeRedisClient(),
    createSubtitleS3Client: () => rotatedClient,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
  });
  await rotatedRuntime.close();

  const rotatedKey = configuredSubtitleAuthority(rotatedConfig).create([
    "privacy-readiness-canary-v1",
  ]);
  assert.notEqual(rotatedKey, firstKey);
  assert.deepEqual(new Set(objects.keys()), new Set([firstKey, rotatedKey]));
  assert.equal(objects.size, 2);
  assert.ok([...objects.values()].every((record) => record.body.equals(CANARY_BODY)));
  assert.equal(
    rotatedClient.commands.some((command) => command.constructor.name === "DeleteObjectCommand"),
    false
  );
});

test("Tigris privacy readiness rejects bucket ACL and policy ambiguity", async () => {
  const cases = [
    {
      name: "public bucket ACL",
      command: "GetBucketAclCommand",
      response: {
        Owner: { ID: "private-owner" },
        Grants: [
          {
            Grantee: {
              Type: "Group",
              URI: "http://acs.amazonaws.com/groups/global/AllUsers",
            },
            Permission: "READ",
          },
        ],
      },
    },
    { name: "missing bucket ACL", command: "GetBucketAclCommand", response: {} },
    {
      name: "missing bucket owner",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({ ownerId: null }),
    },
    {
      name: "malformed bucket owner",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({ ownerId: " private-owner" }),
    },
    {
      name: "cross-account bucket grant",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({ granteeId: "different-account" }),
    },
    {
      name: "bucket READ grant",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({ permission: "READ" }),
    },
    {
      name: "bucket WRITE grant",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({ permission: "WRITE" }),
    },
    {
      name: "unexpected bucket grantee",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({ type: "AmazonCustomerByEmail" }),
    },
    {
      name: "unexpected Tigris group",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({
        extraGrants: [
          {
            Grantee: { Type: "Group", URI: "https://groups.tigris.dev/org/editors" },
            Permission: "FULL_CONTROL",
          },
        ],
      }),
    },
    {
      name: "Tigris admin READ grant",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({
        extraGrants: [
          {
            Grantee: { Type: "Group", URI: TIGRIS_ORG_ADMIN_ACL_URI },
            Permission: "READ",
          },
        ],
      }),
    },
    {
      name: "duplicate Tigris admin grant",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({
        includeTigrisOrgAdmins: true,
        extraGrants: [
          {
            Grantee: { Type: "Group", URI: TIGRIS_ORG_ADMIN_ACL_URI },
            Permission: "FULL_CONTROL",
          },
        ],
      }),
    },
    {
      name: "duplicate canonical owner grant",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({
        extraGrants: [
          {
            Grantee: { ID: "private-owner", Type: "CanonicalUser" },
            Permission: "FULL_CONTROL",
          },
        ],
      }),
    },
    {
      name: "canonical owner grant with group URI",
      command: "GetBucketAclCommand",
      response: {
        Owner: { ID: "private-owner" },
        Grants: [
          {
            Grantee: {
              ID: "private-owner",
              Type: "CanonicalUser",
              URI: TIGRIS_ORG_ADMIN_ACL_URI,
            },
            Permission: "FULL_CONTROL",
          },
        ],
      },
    },
    {
      name: "Tigris admin grant without canonical owner grant",
      command: "GetBucketAclCommand",
      response: {
        Owner: { ID: "private-owner" },
        Grants: [
          {
            Grantee: { Type: "Group", URI: TIGRIS_ORG_ADMIN_ACL_URI },
            Permission: "FULL_CONTROL",
          },
        ],
      },
    },
    {
      name: "Tigris admin grant with canonical id",
      command: "GetBucketAclCommand",
      response: subtitleAclResponse({
        extraGrants: [
          {
            Grantee: {
              ID: "unexpected-id",
              Type: "Group",
              URI: TIGRIS_ORG_ADMIN_ACL_URI,
            },
            Permission: "FULL_CONTROL",
          },
        ],
      }),
    },
    { name: "unsupported bucket ACL", command: "GetBucketAclCommand", error: true },
    {
      name: "public bucket policy",
      command: "GetBucketPolicyStatusCommand",
      response: { PolicyStatus: { IsPublic: true } },
    },
    { name: "missing bucket policy", command: "GetBucketPolicyStatusCommand", response: {} },
    {
      name: "unsupported bucket policy",
      command: "GetBucketPolicyStatusCommand",
      error: true,
    },
  ];

  for (const entry of cases) {
    const client = await expectTigrisReadinessFailure((command, fallback) => {
      if (command.constructor.name !== entry.command) return fallback();
      if (entry.error) throw new Error("provider API unavailable: " + entry.name);
      return entry.response;
    });
    assert.equal(
      client.commands.some((command) => command.constructor.name === "PutObjectCommand"),
      false,
      entry.name
    );
    assert.equal(
      client.commands.some((command) => command.constructor.name === "DeleteObjectCommand"),
      false,
      entry.name
    );
  }
});

test("Tigris privacy readiness rejects public or unverifiable canary ACLs", async () => {
  const publicGrant = (group) => ({
    Owner: { ID: "private-owner" },
    Grants: [
      {
        Grantee: {
          Type: "Group",
          URI: "http://acs.amazonaws.com/groups/global/" + group,
        },
        Permission: "READ",
      },
    ],
  });
  const cases = [
    { name: "AllUsers", response: publicGrant("AllUsers") },
    { name: "AuthenticatedUsers", response: publicGrant("AuthenticatedUsers") },
    { name: "missing owner", response: subtitleAclResponse({ ownerId: null }) },
    { name: "malformed owner", response: subtitleAclResponse({ ownerId: "private-owner " }) },
    {
      name: "cross-account canonical grant",
      response: subtitleAclResponse({ granteeId: "different-account" }),
    },
    {
      name: "object owner differs from bucket owner",
      response: subtitleAclResponse({
        granteeId: "different-owner",
        includeTigrisOrgAdmins: true,
        ownerId: "different-owner",
      }),
    },
    { name: "READ grant", response: subtitleAclResponse({ permission: "READ" }) },
    { name: "WRITE grant", response: subtitleAclResponse({ permission: "WRITE" }) },
    {
      name: "unexpected grantee type",
      response: subtitleAclResponse({ type: "AmazonCustomerByEmail" }),
    },
    {
      name: "unexpected Tigris group",
      response: subtitleAclResponse({
        extraGrants: [
          {
            Grantee: { Type: "Group", URI: "https://groups.tigris.dev/org/editors" },
            Permission: "FULL_CONTROL",
          },
        ],
      }),
    },
    {
      name: "Tigris admin WRITE grant",
      response: subtitleAclResponse({
        extraGrants: [
          {
            Grantee: { Type: "Group", URI: TIGRIS_ORG_ADMIN_ACL_URI },
            Permission: "WRITE",
          },
        ],
      }),
    },
    {
      name: "duplicate Tigris admin grant",
      response: subtitleAclResponse({
        includeTigrisOrgAdmins: true,
        extraGrants: [
          {
            Grantee: { Type: "Group", URI: TIGRIS_ORG_ADMIN_ACL_URI },
            Permission: "FULL_CONTROL",
          },
        ],
      }),
    },
    {
      name: "duplicate canonical owner grant",
      response: subtitleAclResponse({
        extraGrants: [
          {
            Grantee: { ID: "private-owner", Type: "CanonicalUser" },
            Permission: "FULL_CONTROL",
          },
        ],
      }),
    },
    {
      name: "Tigris admin grant without canonical owner grant",
      response: {
        Owner: { ID: "private-owner" },
        Grants: [
          {
            Grantee: { Type: "Group", URI: TIGRIS_ORG_ADMIN_ACL_URI },
            Permission: "FULL_CONTROL",
          },
        ],
      },
    },
    { name: "missing response", response: {} },
    { name: "unsupported response", error: true },
    { name: "hanging response", hang: true },
  ];

  for (const entry of cases) {
    const client = await expectTigrisReadinessFailure(
      (command, fallback) => {
        if (command.constructor.name !== "GetObjectAclCommand") return fallback();
        if (entry.hang) return neverSettles();
        if (entry.error) throw new Error("GetObjectAcl unavailable");
        return { ...entry.response, VersionId: fallback().VersionId };
      },
      entry.hang ? { lifecycleTimeouts: CANARY_LIFECYCLE_TIMEOUTS } : {}
    );
    assert.equal(client.objects.size, 1, entry.name);
    assert.deepEqual(
      client.commands
        .filter((command) =>
          new Set([
            "PutObjectCommand",
            "HeadObjectCommand",
            "GetObjectCommand",
            "GetObjectAclCommand",
          ]).has(command.constructor.name)
        )
        .map((command) => command.constructor.name),
      [
        "PutObjectCommand",
        "HeadObjectCommand",
        "GetObjectCommand",
        "GetObjectAclCommand",
      ],
      entry.name
    );
    assert.equal(
      client.commands.some((command) => command.constructor.name === "DeleteObjectCommand"),
      false,
      entry.name
    );
  }
});

test("Tigris durable canary rejects conflicts and metadata tamper without overwrite", async () => {
  const config = tigrisDevelopmentConfig();
  const canaryKey = configuredSubtitleAuthority(config).create([
    "privacy-readiness-canary-v1",
  ]);
  const conflictingBody = Buffer.from([1]);
  const conflictingObjects = new Map([
    [
      canaryKey,
      {
        body: conflictingBody,
        head: {
          ChecksumSHA256: Buffer.alloc(32, 1).toString("base64"),
          ContentLength: 1,
          ContentType: "application/octet-stream",
          Metadata: {
            "jumpgate-content-length": "1",
            "jumpgate-schema": "1",
            "jumpgate-sha256": "01".repeat(32),
          },
          ServerSideEncryption: "AES256",
          VersionId: subtitleCanaryVersionId(canaryKey),
        },
        versionId: subtitleCanaryVersionId(canaryKey),
      },
    ],
  ]);
  const conflictingClient = new FakeSubtitleS3Client({ objects: conflictingObjects });
  await assert.rejects(
    createStorageRuntime(config, {
      createPostgresPool: () => new FakePool(),
      createRedisClient: () => new FakeRedisClient(),
      createSubtitleS3Client: () => conflictingClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    }),
    { code: "subtitle_object_storage_unavailable" }
  );
  assert.equal(conflictingObjects.size, 1);
  assert.equal(conflictingObjects.get(canaryKey).body, conflictingBody);
  assert.deepEqual(conflictingObjects.get(canaryKey).body, Buffer.from([1]));
  assert.equal(
    conflictingClient.commands.filter(
      (command) => command.constructor.name === "PutObjectCommand"
    ).length,
    1
  );

  const tamperedClient = new FakeSubtitleS3Client({
    sendImpl(command, fallback, client) {
      const response = fallback();
      if (command.constructor.name === "PutObjectCommand") {
        client.objects.get(command.input.Key).head.ServerSideEncryption = "aws:kms";
      }
      return response;
    },
  });
  await assert.rejects(
    createStorageRuntime(config, {
      createPostgresPool: () => new FakePool(),
      createRedisClient: () => new FakeRedisClient(),
      createSubtitleS3Client: () => tamperedClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    }),
    { code: "subtitle_object_storage_unavailable" }
  );
  assert.equal(tamperedClient.objects.size, 1);
  assert.deepEqual(tamperedClient.objects.get(canaryKey).body, CANARY_BODY);
  assert.equal(tamperedClient.objects.get(canaryKey).head.ServerSideEncryption, "aws:kms");
  assert.equal(
    tamperedClient.commands.some((command) => command.constructor.name === "DeleteObjectCommand"),
    false
  );
});

test("Tigris replay rejects forged metadata without a provider-native checksum", async () => {
  const config = tigrisDevelopmentConfig();
  const canaryKey = configuredSubtitleAuthority(config).create([
    "privacy-readiness-canary-v1",
  ]);
  const forgedBody = Buffer.from([0x01]);
  const objects = new Map([
    [
      canaryKey,
      {
        body: forgedBody,
        head: {
          ContentLength: 1,
          ContentType: "application/octet-stream",
          Metadata: {
            "jumpgate-content-length": "1",
            "jumpgate-schema": "1",
            "jumpgate-sha256": CANARY_SHA256,
          },
          ServerSideEncryption: "AES256",
          VersionId: subtitleCanaryVersionId(canaryKey),
        },
        versionId: subtitleCanaryVersionId(canaryKey),
      },
    ],
  ]);
  const client = new FakeSubtitleS3Client({ objects });
  await assert.rejects(
    createStorageRuntime(config, {
      createPostgresPool: () => new FakePool(),
      createRedisClient: () => new FakeRedisClient(),
      createSubtitleS3Client: () => client,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    }),
    { code: "subtitle_object_storage_unavailable" }
  );

  assert.equal(Object.hasOwn(objects.get(canaryKey).head, "ChecksumSHA256"), false);
  assert.equal(objects.get(canaryKey).body, forgedBody);
  assert.deepEqual(objects.get(canaryKey).body, Buffer.from([0x01]));
  assert.deepEqual(
    client.commands
      .filter((command) =>
        new Set(["PutObjectCommand", "HeadObjectCommand", "GetObjectCommand"]).has(
          command.constructor.name
        )
      )
      .map((command) => command.constructor.name),
    [
      "PutObjectCommand",
      "HeadObjectCommand",
      "HeadObjectCommand",
      "HeadObjectCommand",
      "GetObjectCommand",
    ]
  );
  assert.equal(
    client.commands.some((command) => command.constructor.name === "DeleteObjectCommand"),
    false
  );
});

test("Tigris canary GET is redacted on failure and wipes successful output", async () => {
  const config = tigrisDevelopmentConfig();
  const clearingClient = new FakeSubtitleS3Client();
  const store = createHardenedSubtitleObjectStore(config, { client: clearingClient });
  const originalGet = store.get.bind(store);
  let fetchedBody;
  store.get = async (...args) => {
    const result = await originalGet(...args);
    fetchedBody = result.body;
    assert.deepEqual(fetchedBody, CANARY_BODY);
    return result;
  };
  const runtime = await createStorageRuntime(config, {
    closeInjectedResources: true,
    createPostgresPool: () => new FakePool(),
    createRedisClient: () => new FakeRedisClient(),
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    subtitleObjectStore: store,
  });
  assert.ok(Buffer.isBuffer(fetchedBody));
  assert.deepEqual(fetchedBody, Buffer.alloc(1));
  assert.deepEqual([...clearingClient.objects.values()][0].body, CANARY_BODY);
  await runtime.close();
  assert.equal(clearingClient.destroyCalls, 1);

  const reflectedSecret = "GET_OBJECT_SECRET=must-never-reflect";
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  const failingClient = new FakeSubtitleS3Client({
    sendImpl(command, fallback) {
      if (command.constructor.name === "GetObjectCommand") {
        throw new Error(reflectedSecret);
      }
      return fallback();
    },
  });
  let failure;
  try {
    await createStorageRuntime(config, {
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      createSubtitleS3Client: () => failingClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.code, "subtitle_object_storage_unavailable");
  assert.equal(failure.message, "subtitle object storage readiness failed");
  assert.doesNotMatch(String(failure.stack), new RegExp(reflectedSecret));
  assert.equal(failingClient.objects.size, 1);
  assert.equal(failingClient.destroyCalls, 1);
  assert.equal(redisClient.quitCalls, 1);
  assert.equal(pool.ended, 1);
  assert.equal(
    failingClient.commands.some((command) => command.constructor.name === "DeleteObjectCommand"),
    false
  );
});

test("late canary PUT success and rejection are harmless after bounded readiness failure", async () => {
  const reflectedSecret = "late-canary-secret-must-not-reflect";
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const outcome of ["success", "rejection"]) {
      const timers = new ManualLifecycleTimers();
      const pool = new FakePool();
      const redisClient = new FakeRedisClient();
      const objects = new Map();
      let settlePut;
      let canaryKey;
      let canaryRecord;
      const s3Client = new FakeSubtitleS3Client({
        objects,
        sendImpl(command, fallback) {
          if (command.constructor.name !== "PutObjectCommand") return fallback();
          canaryKey = command.input.Key;
          canaryRecord = subtitleCanaryRecord(command.input);
          return new Promise((resolve, reject) => {
            settlePut = () => {
              if (outcome === "success") {
                objects.set(canaryKey, canaryRecord);
                resolve({
                  ServerSideEncryption: "AES256",
                  VersionId: canaryRecord.versionId,
                });
              } else {
                reject(new Error(reflectedSecret));
              }
            };
          });
        },
      });
      let failure;
      const startup = createStorageRuntime(tigrisDevelopmentConfig(), {
        createPostgresPool: () => pool,
        createRedisClient: () => redisClient,
        createSubtitleS3Client: () => s3Client,
        lifecycleTimers: timers,
        lifecycleTimeouts: {
          startupMs: 1000,
          migrationMs: 100,
          connectMs: 100,
          readinessMs: 100,
          shutdownMs: 100,
        },
        runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      }).catch((error) => {
        failure = error;
      });

      await waitUntil(() => typeof settlePut === "function", "canary PUT did not start");
      await timers.advanceTo(90);
      await startup;
      assert.ok(failure, outcome);
      assert.equal(failure.code, "subtitle_object_storage_unavailable", outcome);
      assert.equal(failure.message, "subtitle object storage readiness failed", outcome);
      assert.doesNotMatch(String(failure.stack), new RegExp(reflectedSecret), outcome);
      assert.equal(objects.size, 0, outcome);
      assert.equal(s3Client.destroyCalls, 1, outcome);
      assert.equal(redisClient.quitCalls, 1, outcome);
      assert.equal(pool.ended, 1, outcome);
      assert.deepEqual(timers.deadlines(), [], outcome);
      assert.equal(
        s3Client.commands.some((command) => command.constructor.name === "DeleteObjectCommand"),
        false,
        outcome
      );

      settlePut();
      await new Promise((resolve) => setImmediate(resolve));
      await eventLoopLoad(64);
      assert.equal(objects.size, outcome === "success" ? 1 : 0, outcome);
      assert.deepEqual(timers.deadlines(), [], outcome);

      if (outcome === "success") {
        const replayClient = new FakeSubtitleS3Client({ objects });
        const replayRuntime = await createStorageRuntime(tigrisDevelopmentConfig(), {
          createPostgresPool: () => new FakePool(),
          createRedisClient: () => new FakeRedisClient(),
          createSubtitleS3Client: () => replayClient,
          runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
        });
        assert.equal(replayClient.objects.size, 1);
        assert.deepEqual(replayClient.objects.get(canaryKey).body, CANARY_BODY);
        await replayRuntime.close();
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("Redis readiness uses the effective configured repository keyspace", async () => {
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  const runtime = await createStorageRuntime(developmentRedisConfig(), {
    createPostgresPool: () => pool,
    createRedisClient: () => redisClient,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    redisRepositoryOptions: { keyPrefix: "jg:v7" },
  });

  const writeProbe = redisClient.commands.find((command) => command[0] === "SET");
  assert.match(writeProbe[1], /^jg:v7:readiness:[a-f0-9]{64}$/);
  assert.equal(runtime.repositories.pairings._keys.prefix, "jg:v7");
  assert.equal(redisClient.values.size, 1);

  await runtime.close();
  assert.equal(pool.ended, 1);
  assert.equal(redisClient.quitCalls, 1);
});

test("rollout config authoritatively wires migrations, provider mode, attestation, and Redis writes", async () => {
  const postgres = require("../lib/storage/postgres");
  const originalCreateRepositories = postgres.createPostgresDurableRepositories;
  const events = [];
  let postgresRepositoryOptions = null;
  let migrationOptions = null;
  let attestationOptions = null;
  postgres.createPostgresDurableRepositories = (options) => {
    postgresRepositoryOptions = options;
    return originalCreateRepositories(options);
  };

  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  let runtime;
  try {
    runtime = await createStorageRuntime(
      developmentRedisConfig({
        JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
        JUMPGATE_POSTGRES_MIGRATION_CEILING: "0004_provider_mutation_fence",
        JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
      }),
      {
        createPostgresPool: () => pool,
        createRedisClient: () => redisClient,
        postgresMigrationOptions: { migrationCeiling: "0001_initial" },
        postgresRepositoryOptions: { providerMutationMode: "legacy" },
        redisRepositoryOptions: {
          writeVersion: "3",
          playbackContexts: { writeVersion: "3" },
        },
        runPostgresMigrations: async (_database, options) => {
          events.push("migration");
          migrationOptions = options;
          return { applied: [], alreadyApplied: [], verified: [] };
        },
        attestProviderMutationMode: async (_database, options) => {
          events.push("attestation");
          attestationOptions = options;
        },
      }
    );

    assert.deepEqual(events, ["migration", "attestation"]);
    assert.equal(migrationOptions.migrationCeiling, "0004_provider_mutation_fence");
    assert.equal(postgresRepositoryOptions.providerMutationMode, "fenced");
    assert.deepEqual(attestationOptions, {
      mode: "fenced",
      migrationCeiling: "0004_provider_mutation_fence",
    });
    assert.equal(runtime.repositories.playbackContexts._writeVersion, "4");
  } finally {
    postgres.createPostgresDurableRepositories = originalCreateRepositories;
    if (runtime) await runtime.close();
  }
});

test("local latest migration omits the ceiling from provider mode attestation", async () => {
  const config = loadStorageConfig({
    NODE_ENV: "development",
    JUMPGATE_DURABLE_DRIVER: "postgres",
    JUMPGATE_TTL_DRIVER: "memory",
    DATABASE_URL: "postgresql://bridge:secret@db.example:5432/jumpgate",
    ...stableSecrets(),
  });
  let migrationOptions = null;
  let attestationOptions = null;
  const pool = new FakePool();
  const runtime = await createStorageRuntime(config, {
    createPostgresPool: () => pool,
    runPostgresMigrations: async (_database, options) => {
      migrationOptions = options;
      return { applied: [], alreadyApplied: [], verified: [] };
    },
    attestProviderMutationMode: async (_database, options) => {
      attestationOptions = options;
    },
  });

  assert.equal(migrationOptions.migrationCeiling, null);
  assert.deepEqual(attestationOptions, { mode: "fenced" });
  await runtime.close();
});

test("runtime rejects nested Redis shared dependency overrides with startup cleanup", async () => {
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  await assert.rejects(
    createStorageRuntime(productionConfig(), {
      attestProviderMutationMode: async () => {},
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      redisRepositoryOptions: { pairings: { client: new FakeRedisClient() } },
    }),
    /pairings Redis options may not override shared client/
  );

  assert.equal(redisClient.connectCalls, 1);
  assert.equal(redisClient.pingCalls, 0);
  assert.equal(redisClient.quitCalls, 1);
  assert.equal(pool.ended, 1);
  assert.equal(redisClient.listenerCount("error"), 0);
  assert.equal(pool.listenerCount("error"), 0);
});

test("production Redis startup fails closed on unverified server versions", async () => {
  for (const [serverInfo, code] of [
    ["# Server\r\nredis_version:6.2.19\r\n", "redis_version_unsupported"],
    ["# Server\r\nredis_version:9.0.0\r\n", "redis_version_unsupported"],
    ["# Server\r\nredis_version:8.x.0\r\n", "redis_version_invalid"],
    ["# Server\r\n", "redis_version_invalid"],
  ]) {
    const pool = new FakePool();
    const redisClient = new FakeRedisClient({ serverInfo });
    await assert.rejects(
      createStorageRuntime(productionConfig(), {
        attestProviderMutationMode: async () => {},
        createPostgresPool: () => pool,
        createRedisClient: () => redisClient,
        runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      }),
      (error) => error.code === code
    );
    assert.deepEqual(redisClient.commands, [["INFO", "server"]]);
    assert.equal(redisClient.quitCalls, 1);
    assert.equal(pool.ended, 1);
    assert.equal(redisClient.listenerCount("error"), 0);
    assert.equal(pool.listenerCount("error"), 0);
  }
});

test("Redis readiness rejects replicas and read-only primaries with startup cleanup", async () => {
  const replicaPool = new FakePool();
  const replica = new FakeRedisClient({
    roleReply: ["slave", "primary.example", 6379, "connected", 0],
  });
  await assert.rejects(
    createStorageRuntime(productionConfig(), {
      createPostgresPool: () => replicaPool,
      createRedisClient: () => replica,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      attestProviderMutationMode: async () => {},
    }),
    (error) => error.code === "redis_not_primary"
  );
  assert.deepEqual(
    replica.commands.map((command) => command[0]),
    ["INFO", "INFO", "CONFIG", "ROLE"]
  );
  assert.deepEqual(replica.commands.slice(0, 2), [["INFO", "server"], ["INFO", "cluster"]]);
  assert.equal(replica.quitCalls, 1);
  assert.equal(replicaPool.ended, 1);
  assert.equal(replica.listenerCount("error"), 0);
  assert.equal(replicaPool.listenerCount("error"), 0);

  const readOnlyPool = new FakePool();
  const readOnly = new FakeRedisClient({
    sendCommandImpl: async (command) => {
      if (command[0] === "INFO") return "# Cluster\r\ncluster_enabled:0\r\n";
      if (command[0] === "CONFIG") return ["maxmemory-policy", "noeviction"];
      if (command[0] === "ROLE") return ["master", 0, []];
      if (command[0] === "SET") throw new Error("READONLY You cannot write against a read only replica");
      throw new Error("unexpected Redis command");
    },
  });
  await assert.rejects(
    createStorageRuntime(productionConfig(), {
      createPostgresPool: () => readOnlyPool,
      createRedisClient: () => readOnly,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      attestProviderMutationMode: async () => {},
    }),
    /READONLY/
  );
  assert.deepEqual(
    readOnly.commands.map((command) => command[0]),
    ["INFO", "INFO", "CONFIG", "ROLE", "SET"]
  );
  assert.equal(readOnly.values.size, 0);
  assert.equal(readOnly.quitCalls, 1);
  assert.equal(readOnlyPool.ended, 1);
  assert.equal(readOnly.listenerCount("error"), 0);
  assert.equal(readOnlyPool.listenerCount("error"), 0);
});

test("Redis readiness fails closed for cluster nodes, redirects, and malformed topology", async () => {
  for (const [name, client, expectedCommands] of [
    [
      "cluster node",
      new FakeRedisClient({ clusterInfo: "# Cluster\r\ncluster_enabled:1\r\n" }),
      ["INFO"],
    ],
    [
      "MOVED redirect",
      new FakeRedisClient({
        sendCommandImpl: async (command) => {
          if (command[0] === "INFO") throw new Error("MOVED 3999 10.0.0.2:6379");
          throw new Error("unexpected Redis command");
        },
      }),
      ["INFO"],
    ],
    [
      "CROSSSLOT write",
      new FakeRedisClient({
        sendCommandImpl: async (command) => {
          if (command[0] === "INFO") return "# Cluster\r\ncluster_enabled:0\r\n";
          if (command[0] === "CONFIG") return ["maxmemory-policy", "noeviction"];
          if (command[0] === "ROLE") return ["master", 0, []];
          if (command[0] === "SET") {
            throw new Error("CROSSSLOT Keys in request do not hash to the same slot");
          }
          throw new Error("unexpected Redis command");
        },
      }),
      ["INFO", "ROLE", "SET"],
    ],
    [
      "malformed topology",
      new FakeRedisClient({ clusterInfo: "# Cluster\r\ncluster_state:ok\r\n" }),
      ["INFO"],
    ],
  ]) {
    const pool = new FakePool();
    await assert.rejects(
      createStorageRuntime(developmentRedisConfig(), {
        createPostgresPool: () => pool,
        createRedisClient: () => client,
        runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
        attestProviderMutationMode: async () => {},
      }),
      (error) =>
        name === "malformed topology"
          ? error.code === "redis_topology_invalid"
          : error.code === "redis_cluster_unsupported"
    );
    assert.deepEqual(
      client.commands.map((command) => command[0]),
      expectedCommands,
      name
    );
    assert.equal(client.quitCalls, 1, name);
    assert.equal(pool.ended, 1, name);
  }
});

test("production Redis readiness rejects eviction policies before serving", async () => {
  const pool = new FakePool();
  const redisClient = new FakeRedisClient({ maxmemoryPolicy: "allkeys-lru" });
  await assert.rejects(
    createStorageRuntime(productionConfig(), {
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      attestProviderMutationMode: async () => {},
    }),
    (error) => error.code === "redis_eviction_policy"
  );
  assert.deepEqual(
    redisClient.commands.map((command) => command[0]),
    ["INFO", "INFO", "CONFIG"]
  );
  assert.equal(redisClient.commands.some((command) => command[0] === "SET" || command[0] === "DEL"), false);
  assert.equal(redisClient.values.size, 0);
  assert.equal(redisClient.quitCalls, 1);
  assert.equal(pool.ended, 1);
  assert.equal(redisClient.listenerCount("error"), 0);
  assert.equal(pool.listenerCount("error"), 0);
});

test("Redis ROLE readiness is lifecycle-bounded and cleans owned resources", async () => {
  const pool = new FakePool();
  const redisClient = new FakeRedisClient({
    sendCommandImpl: (command) => {
      if (command[0] === "INFO") return "# Cluster\r\ncluster_enabled:0\r\n";
      if (command[0] === "CONFIG") return ["maxmemory-policy", "noeviction"];
      if (command[0] === "ROLE") return neverSettles();
      throw new Error("unexpected Redis command");
    },
  });
  await assert.rejects(
    createStorageRuntime(productionConfig(), {
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      attestProviderMutationMode: async () => {},
      lifecycleTimeouts: SHORT_LIFECYCLE_TIMEOUTS,
    }),
    (error) => error.code === "storage_timeout" && /Redis|startup/.test(error.phase)
  );
  assert.deepEqual(
    redisClient.commands.map((command) => command[0]),
    ["INFO", "INFO", "CONFIG", "ROLE"]
  );
  assert.equal(redisClient.quitCalls, 1);
  assert.equal(pool.ended, 1);
  assert.equal(redisClient.listenerCount("error"), 0);
  assert.equal(pool.listenerCount("error"), 0);
});

test("runtime rolls back owned durable resources when Redis startup fails", async () => {
  const pool = new FakePool();
  const redisClient = new FakeRedisClient({ connectError: new Error("redis unavailable") });
  const config = productionConfig();

  await assert.rejects(
    createStorageRuntime(config, {
      attestProviderMutationMode: async () => {},
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    }),
    /redis unavailable/
  );
  assert.equal(pool.ended, 1);
  assert.equal(redisClient.listenerCount("error"), 0);
  assert.equal(pool.listenerCount("error"), 0);
});

test("main Redis startup closes each owned dependency once across fallible setup", async () => {
  const scenarios = [
    {
      name: "throwing on",
      createRedis() {
        const client = new FakeRedisClient();
        client.on = () => {
          throw new Error("controlled Redis listener failure");
        };
        return client;
      },
    },
    {
      name: "throwing isOpen getter",
      createRedis() {
        const client = new EventEmitter();
        client.connectCalls = 0;
        client.destroyCalls = 0;
        client.quitCalls = 0;
        client.connect = async () => {
          client.connectCalls += 1;
        };
        client.destroy = () => {
          client.destroyCalls += 1;
        };
        client.quit = async () => {
          client.quitCalls += 1;
        };
        Object.defineProperty(client, "isOpen", {
          get() {
            throw new Error("controlled Redis isOpen failure");
          },
        });
        return client;
      },
    },
    {
      name: "missing connect",
      createRedis() {
        const client = new EventEmitter();
        client.destroyCalls = 0;
        client.quitCalls = 0;
        client.isOpen = false;
        client.destroy = () => {
          client.destroyCalls += 1;
        };
        client.quit = async () => {
          client.quitCalls += 1;
        };
        return client;
      },
    },
    {
      name: "connect failure",
      createRedis() {
        return new FakeRedisClient({
          connectError: new Error("controlled Redis connect failure"),
        });
      },
    },
    {
      name: "Redis readiness failure",
      createRedis() {
        return new FakeRedisClient({
          pingImpl: async () => {
            throw new Error("controlled Redis readiness failure");
          },
        });
      },
    },
    {
      name: "later subtitle S3 readiness failure",
      createRedis() {
        return new FakeRedisClient();
      },
      failSubtitleReadiness: true,
    },
  ];

  for (const scenario of scenarios) {
    const pool = new FakePool();
    const redisClient = scenario.createRedis();
    const s3Client = new FakeSubtitleS3Client({
      sendImpl: scenario.failSubtitleReadiness
        ? async (command, next) => {
            if (command.constructor.name === "HeadBucketCommand") {
              throw new Error("controlled subtitle S3 readiness failure");
            }
            return next();
          }
        : null,
    });

    await assert.rejects(
      createStorageRuntime(developmentRedisConfig(), {
        createPostgresPool: () => pool,
        createRedisClient: () => redisClient,
        createSubtitleS3Client: () => s3Client,
        runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      }),
      undefined,
      scenario.name
    );

    const redisCloseCalls =
      Number(redisClient.quitCalls || 0) +
      Number(redisClient.destroyCalls || 0) +
      Number(redisClient.closeCalls || 0) +
      Number(redisClient.disconnectCalls || 0);
    assert.equal(redisCloseCalls, 1, scenario.name + " Redis close/force");
    assert.equal(pool.ended + pool.destroyCalls, 1, scenario.name + " PostgreSQL close/force");
    assert.equal(s3Client.destroyCalls, 1, scenario.name + " S3 close");
    assert.equal(pool.listenerCount("error"), 0, scenario.name + " PostgreSQL listener");
    assert.equal(s3Client.listenerCount("error"), 0, scenario.name + " S3 listener");
    assert.equal(redisClient.listenerCount("error"), 0, scenario.name + " Redis listener");
  }
});

test("main Redis cleanup preserves injected client ownership", async () => {
  for (const scenario of [
    {
      name: "pre-open shared client",
      initiallyOpen: true,
      closeInjectedResources: false,
      expectedConnectCalls: 0,
      expectedCloseCalls: 0,
    },
    {
      name: "runtime-opened shared client",
      initiallyOpen: false,
      closeInjectedResources: false,
      expectedConnectCalls: 1,
      expectedCloseCalls: 1,
    },
    {
      name: "pre-open opted-in client",
      initiallyOpen: true,
      closeInjectedResources: true,
      expectedConnectCalls: 0,
      expectedCloseCalls: 1,
    },
  ]) {
    const pool = new FakePool();
    const redisClient = new FakeRedisClient();
    const s3Client = new FakeSubtitleS3Client();
    redisClient.isOpen = scenario.initiallyOpen;
    const runtime = await createStorageRuntime(developmentRedisConfig(), {
      closeInjectedResources: scenario.closeInjectedResources,
      createPostgresPool: () => pool,
      createRedisClient: () => {
        throw new Error("Redis factory must not run for an injected client");
      },
      createSubtitleS3Client: () => s3Client,
      redisClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    });

    await runtime.close();
    assert.equal(redisClient.connectCalls, scenario.expectedConnectCalls, scenario.name);
    assert.equal(
      redisClient.quitCalls + redisClient.destroyCalls,
      scenario.expectedCloseCalls,
      scenario.name
    );
    assert.equal(redisClient.listenerCount("error"), 0, scenario.name);
    assert.equal(pool.ended, 1, scenario.name);
    assert.equal(s3Client.destroyCalls, 1, scenario.name);
  }
});

test("startup cleanup diagnostics are immutable sanitized local snapshots", async () => {
  const credential = "postgresql://provider:super-secret@example.invalid/jumpgate";
  const nested = { credential, mutable: { value: "provider-data" } };
  const cleanupSource = Object.assign(new Error("provider close leaked " + credential), {
    cause: new Error("provider cause leaked " + credential),
    code: "provider_secret_code",
    custom: nested,
    phase: "provider phase " + credential,
  });
  const pool = new FakePool({
    endImpl: async () => {
      throw cleanupSource;
    },
  });
  let failure;
  try {
    await createStorageRuntime(developmentRedisConfig(), {
      createPostgresPool: () => pool,
      createRedisClient: () => {
        throw new Error("Redis must not be constructed");
      },
      createSubtitleS3Client: () => {
        throw new Error("S3 must not be constructed");
      },
      runPostgresMigrations: async () => {
        throw new Error("controlled migration failure");
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure);
  const descriptor = Object.getOwnPropertyDescriptor(failure, "cleanupErrors");
  assert.deepEqual(
    {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      writable: descriptor.writable,
    },
    { configurable: false, enumerable: false, writable: false }
  );
  assert.equal(Object.isFrozen(descriptor.value), true);
  assert.equal(descriptor.value.length, 1);
  const record = descriptor.value[0];
  assert.equal(Object.isFrozen(record), true);
  assert.deepEqual(Reflect.ownKeys(record).sort(), ["code", "phase"]);
  assert.deepEqual(record, {
    code: "storage_cleanup_failed",
    phase: "PostgreSQL shutdown",
  });
  assert.notEqual(record, cleanupSource);
  assert.doesNotMatch(JSON.stringify(descriptor.value), /provider|secret|credential/i);
  assert.throws(() => descriptor.value.push({}), TypeError);
  assert.throws(() => {
    record.phase = "mutated";
  }, TypeError);
  assert.throws(() => {
    failure.cleanupErrors = [];
  }, TypeError);
  assert.throws(() => {
    delete failure.cleanupErrors;
  }, TypeError);

  cleanupSource.message = "mutated " + credential;
  cleanupSource.stack = "mutated stack " + credential;
  cleanupSource.cause = new Error("mutated cause " + credential);
  cleanupSource.code = "mutated_provider_code";
  cleanupSource.phase = "mutated provider phase " + credential;
  nested.credential = "mutated-provider-credential";
  nested.mutable.value = "mutated-provider-data";
  assert.deepEqual(record, {
    code: "storage_cleanup_failed",
    phase: "PostgreSQL shutdown",
  });
  assert.equal(failure.code, "storage_startup_failed");
  assert.equal(failure.message, "storage startup failed");
  assert.equal(failure.phase, "storage startup");
  assert.equal(Object.isFrozen(failure), true);
  assert.equal(pool.ended, 1);
});

test("cleanup diagnostics replace hostile primary errors without retaining their fields", async () => {
  const primarySecret = "postgresql://primary:secret@example.invalid/jumpgate";
  const cleanupSecret = "postgresql://cleanup:secret@example.invalid/jumpgate";
  const cases = [
    {
      name: "non-configurable data property",
      create() {
        const cleanupErrors = [{ credential: primarySecret }];
        const error = Object.assign(new Error("primary leaked " + primarySecret), {
          cause: new Error("primary cause " + primarySecret),
          credential: primarySecret,
          custom: { nested: primarySecret },
        });
        Object.defineProperty(error, "cleanupErrors", {
          configurable: false,
          enumerable: true,
          value: cleanupErrors,
          writable: true,
        });
        return { cleanupErrors, error, reads: () => 0 };
      },
    },
    {
      name: "configurable data property",
      create() {
        const cleanupErrors = [{ credential: primarySecret }];
        const error = new Error("primary leaked " + primarySecret);
        Object.defineProperty(error, "cleanupErrors", {
          configurable: true,
          enumerable: true,
          value: cleanupErrors,
          writable: true,
        });
        return { cleanupErrors, error, reads: () => 0 };
      },
    },
    {
      name: "accessor property",
      create() {
        let reads = 0;
        const cleanupErrors = [{ credential: primarySecret }];
        const error = new Error("primary leaked " + primarySecret);
        Object.defineProperty(error, "cleanupErrors", {
          configurable: false,
          enumerable: true,
          get() {
            reads += 1;
            return cleanupErrors;
          },
        });
        return { cleanupErrors, error, reads: () => reads };
      },
    },
    {
      name: "proxy traps",
      create() {
        const cleanupErrors = [{ credential: primarySecret }];
        const target = Object.assign(new Error("primary leaked " + primarySecret), {
          cleanupErrors,
          credential: primarySecret,
        });
        const error = new Proxy(target, {
          defineProperty() {
            throw new Error("define trap " + primarySecret);
          },
          get() {
            throw new Error("get trap " + primarySecret);
          },
          getOwnPropertyDescriptor() {
            throw new Error("descriptor trap " + primarySecret);
          },
          getPrototypeOf() {
            throw new Error("prototype trap " + primarySecret);
          },
          ownKeys() {
            throw new Error("keys trap " + primarySecret);
          },
        });
        return { cleanupErrors, error, reads: () => 0 };
      },
    },
  ];

  for (const entry of cases) {
    const primary = entry.create();
    const cleanupSource = Object.assign(
      new Error("cleanup leaked " + cleanupSecret),
      { cause: new Error(cleanupSecret), credential: cleanupSecret }
    );
    const pool = new FakePool({
      endImpl: async () => {
        throw cleanupSource;
      },
    });
    let failure;
    try {
      await createStorageRuntime(developmentRedisConfig(), {
        createPostgresPool: () => pool,
        createRedisClient: () => {
          throw new Error("Redis must not be constructed");
        },
        createSubtitleS3Client: () => {
          throw new Error("S3 must not be constructed");
        },
        runPostgresMigrations: async () => {
          throw primary.error;
        },
      });
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, entry.name);
    assert.notEqual(failure, primary.error, entry.name);
    assert.equal(primary.reads(), 0, entry.name);
    assert.equal(Object.isFrozen(failure), true, entry.name);
    assert.equal(failure.code, "storage_startup_failed", entry.name);
    assert.equal(failure.message, "storage startup failed", entry.name);
    assert.equal(failure.phase, "storage startup", entry.name);
    assert.equal(failure.cause, undefined, entry.name);
    assert.equal(failure.credential, undefined, entry.name);
    assert.equal(failure.custom, undefined, entry.name);
    assert.equal(Object.isFrozen(failure.cleanupErrors), true, entry.name);
    assert.equal(Object.isFrozen(failure.cleanupErrors[0]), true, entry.name);
    assert.deepEqual(
      failure.cleanupErrors,
      [{ code: "storage_cleanup_failed", phase: "PostgreSQL shutdown" }],
      entry.name
    );
    assert.doesNotMatch(
      failure.stack,
      /primary:secret|cleanup:secret|primary leaked|cleanup leaked/,
      entry.name
    );
    assert.throws(() => {
      failure.code = "mutated";
    }, TypeError, entry.name);
    assert.throws(() => {
      failure.cleanupErrors[0].phase = "mutated";
    }, TypeError, entry.name);
    assert.throws(() => {
      failure.cleanupErrors.push({});
    }, TypeError, entry.name);

    primary.cleanupErrors.push({ credential: "mutated-" + primarySecret });
    cleanupSource.message = "mutated-" + cleanupSecret;
    assert.deepEqual(
      failure.cleanupErrors,
      [{ code: "storage_cleanup_failed", phase: "PostgreSQL shutdown" }],
      entry.name
    );
    assert.equal(pool.ended, 1, entry.name);
  }
});

test("migration and Redis connect timeouts clean owned resources and listeners", async () => {
  const migrationPool = new FakePool();
  await assert.rejects(
    createStorageRuntime(productionConfig(), {
      createPostgresPool: () => migrationPool,
      runPostgresMigrations: () => neverSettles(),
      lifecycleTimeouts: SHORT_LIFECYCLE_TIMEOUTS,
    }),
    (error) => error.code === "storage_timeout" && error.phase === "PostgreSQL migration"
  );
  assert.equal(migrationPool.ended, 1);
  assert.equal(migrationPool.listenerCount("error"), 0);

  const connectPool = new FakePool();
  const redisClient = new FakeRedisClient({ connectImpl: neverSettles });
  await assert.rejects(
    createStorageRuntime(productionConfig(), {
      attestProviderMutationMode: async () => {},
      createPostgresPool: () => connectPool,
      createRedisClient: () => redisClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      lifecycleTimeouts: SHORT_LIFECYCLE_TIMEOUTS,
    }),
    (error) => error.code === "storage_timeout" && error.phase === "Redis connect"
  );
  assert.equal(redisClient.destroyCalls, 1);
  assert.equal(redisClient.listenerCount("error"), 0);
  assert.equal(connectPool.ended, 1);
  assert.equal(connectPool.listenerCount("error"), 0);
});

test("a timed-out PostgreSQL migration is aborted and cannot resume backend startup", async () => {
  const pool = new FakePool();
  let completeMigration;
  let migrationSignal;
  let redisCreations = 0;
  const startup = createStorageRuntime(productionConfig(), {
    createPostgresPool: () => pool,
    createRedisClient: () => {
      redisCreations += 1;
      return new FakeRedisClient();
    },
    runPostgresMigrations(_database, options) {
      migrationSignal = options.signal;
      return new Promise((resolve) => {
        completeMigration = resolve;
      });
    },
    lifecycleTimeouts: SHORT_LIFECYCLE_TIMEOUTS,
  });

  await assert.rejects(
    startup,
    (error) => error.code === "storage_timeout" && error.phase === "PostgreSQL migration"
  );
  assert.equal(migrationSignal.aborted, true);
  assert.equal(pool.destroyCalls, 1);
  assert.equal(redisCreations, 0);

  completeMigration({ applied: ["late"], alreadyApplied: [], verified: ["late"] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(redisCreations, 0);
  assert.equal(pool.listenerCount("error"), 0);
});

test("startup and live readiness time out without leaving owned handles", async () => {
  const startupPool = new FakePool({ queryImpl: neverSettles });
  const startupRedis = new FakeRedisClient();
  await assert.rejects(
    createStorageRuntime(productionConfig(), {
      attestProviderMutationMode: async () => {},
      createPostgresPool: () => startupPool,
      createRedisClient: () => startupRedis,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      lifecycleTimeouts: SHORT_LIFECYCLE_TIMEOUTS,
    }),
    (error) => error.code === "storage_timeout" && /readiness/.test(error.phase)
  );
  assert.equal(startupPool.ended, 1);
  assert.equal(startupRedis.connectCalls, 0);
  assert.equal(startupRedis.quitCalls, 0);
  assert.equal(startupPool.listenerCount("error"), 0);
  assert.equal(startupRedis.listenerCount("error"), 0);

  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  const runtime = await createStorageRuntime(developmentRedisConfig(), {
    createPostgresPool: () => pool,
    createRedisClient: () => redisClient,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    lifecycleTimeouts: SHORT_LIFECYCLE_TIMEOUTS,
  });
  pool.queryImpl = neverSettles;
  await assert.rejects(
    runtime.ready(),
    (error) => error.code === "storage_timeout" && error.phase === "PostgreSQL readiness"
  );
  assert.equal(runtime.state, "closed");
  assert.equal(pool.ended, 1);
  assert.equal(pool.destroyCalls, 0);
  await runtime.close();
  assert.equal(pool.listenerCount("error"), 0);
  assert.equal(redisClient.listenerCount("error"), 0);
});

test("readiness cannot report ready after close begins", async () => {
  const pool = new FakePool();
  const redisClient = new FakeRedisClient();
  const runtime = await createStorageRuntime(developmentRedisConfig(), {
    createPostgresPool: () => pool,
    createRedisClient: () => redisClient,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    lifecycleTimeouts: { ...SHORT_LIFECYCLE_TIMEOUTS, readinessMs: 100 },
  });
  let releaseHealth;
  pool.queryImpl = () =>
    new Promise((resolve) => {
      releaseHealth = resolve;
    });

  const readiness = runtime.ready();
  while (!releaseHealth) await Promise.resolve();
  await runtime.close();
  releaseHealth({ rows: [{ ready: 1 }] });
  await assert.rejects(readiness, { code: "storage_not_ready" });
  await assert.rejects(runtime.ready(), { code: "storage_not_ready" });
});

test("shutdown timeouts force resources closed, detach listeners, and settle state", async () => {
  const pool = new FakePool({ endImpl: neverSettles });
  const redisClient = new FakeRedisClient({ quitImpl: neverSettles });
  const runtime = await createStorageRuntime(developmentRedisConfig(), {
    createPostgresPool: () => pool,
    createRedisClient: () => redisClient,
    runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
    lifecycleTimeouts: SHORT_LIFECYCLE_TIMEOUTS,
  });

  await assert.rejects(
    runtime.close(),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.every((entry) => entry.code === "storage_timeout")
  );
  assert.equal(runtime.state, "closed");
  assert.equal(redisClient.destroyCalls, 1);
  assert.equal(pool.destroyCalls, 1);
  assert.equal(redisClient.listenerCount("error"), 0);
  assert.equal(pool.listenerCount("error"), 0);
  assert.equal(runtime.close(), runtime.close());
});

test("readiness cleanup strictly orders graceful quit before bounded force under load", async () => {
  const iterations = 128;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const timers = new ManualLifecycleTimers();
    const events = [];
    const pool = new FakePool();
    const redisClient = new FakeRedisClient({
      quitImpl: () => {
        events.push(["quit", timers.now()]);
        return neverSettles();
      },
      sendCommandImpl: (command) => {
        if (command[0] === "INFO") return "# Cluster\r\ncluster_enabled:0\r\n";
        if (command[0] === "CONFIG") return ["maxmemory-policy", "noeviction"];
        if (command[0] === "ROLE") return neverSettles();
        throw new Error("unexpected Redis command");
      },
    });
    const destroy = redisClient.destroy.bind(redisClient);
    redisClient.destroy = () => {
      events.push(["destroy", timers.now()]);
      destroy();
    };
    const startup = createStorageRuntime(productionConfig(), {
      attestProviderMutationMode: async () => {},
      createPostgresPool: () => pool,
      createRedisClient: () => redisClient,
      runPostgresMigrations: async () => ({ applied: [], alreadyApplied: [], verified: [] }),
      lifecycleTimers: timers,
      lifecycleTimeouts: {
        startupMs: 1000,
        migrationMs: 100,
        connectMs: 100,
        readinessMs: 50,
        shutdownMs: 30,
      },
    });
    const rejected = assert.rejects(
      startup,
      (error) =>
        error.code === "storage_timeout" &&
        error.phase === "Redis readiness" &&
        Array.isArray(error.cleanupErrors) &&
        error.cleanupErrors.length === 1 &&
        error.cleanupErrors[0].phase === "Redis shutdown"
    );

    await waitUntil(
      () => redisClient.commands.some((command) => command[0] === "ROLE"),
      "Redis readiness did not reach the blocked ROLE command"
    );
    assert.deepEqual(timers.deadlines(), [50]);
    await eventLoopLoad(256);
    await timers.advanceTo(49);
    assert.equal(redisClient.quitCalls, 0);
    assert.equal(redisClient.destroyCalls, 0);

    await timers.advanceTo(50);
    await waitUntil(() => redisClient.quitCalls === 1, "graceful Redis quit was not attempted");
    assert.equal(redisClient.destroyCalls, 0);
    assert.deepEqual(events, [["quit", 50]]);
    assert.deepEqual(timers.deadlines(), [80]);

    await eventLoopLoad(256);
    await timers.advanceTo(79);
    assert.equal(redisClient.destroyCalls, 0);
    await timers.advanceTo(80);
    await rejected;

    assert.deepEqual(events, [["quit", 50], ["destroy", 80]]);
    assert.equal(redisClient.quitCalls, 1);
    assert.equal(redisClient.destroyCalls, 1);
    assert.equal(pool.ended, 1);
    assert.equal(pool.destroyCalls, 0);
    assert.equal(redisClient.listenerCount("error"), 0);
    assert.equal(pool.listenerCount("error"), 0);
    assert.deepEqual(timers.deadlines(), []);
  }
});
