"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const {
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const {
  assertProductionSubtitleErasureReadiness,
  createHardenedSubtitleObjectStore,
  createSubtitleStorageHealth,
  loadStorageConfig,
} = require("../lib/storage");

function stableSecrets() {
  return {
    JUMPGATE_TOKEN_PEPPER: Buffer.alloc(32, 0x31).toString("base64url"),
    JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "runtime-key",
    JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([
      { id: "runtime-key", key: Buffer.alloc(32, 0x41).toString("base64url") },
    ]),
  };
}

function productionConfig(overrides = {}) {
  return loadStorageConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://bridge:secret@db.example:5432/jumpgate",
    REDIS_URL: "redis://redis.example:6379/0",
    JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
    JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
    JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
    JUMPGATE_SUBTITLE_S3_BUCKET: "jumpgate-test-subtitles",
    JUMPGATE_SUBTITLE_S3_REGION: "auto",
    JUMPGATE_SUBTITLE_S3_ENDPOINT: "https://fly.storage.tigris.dev",
    JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE: "0",
    JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: "strict",
    JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
    JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID: "subtitle-access-do-not-reflect",
    JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY: "subtitle-secret-do-not-reflect",
    JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID: "subtitle-current",
    JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: JSON.stringify([
      {
        id: "subtitle-current",
        key: Buffer.alloc(32, 0x52).toString("base64url"),
      },
    ]),
    ...stableSecrets(),
    ...overrides,
  });
}

function noSuchKey() {
  const error = new Error("not found");
  error.name = "NoSuchKey";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function noSuchVersion() {
  const error = new Error("version not found");
  error.name = "NoSuchVersion";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

class AttestedTigrisClient {
  constructor(options = {}) {
    this.commands = [];
    this.retainDeletedVersions = options.retainDeletedVersions === true;
    this.failListMessage = options.failListMessage || null;
    this.emptyVersionLists = options.emptyVersionLists === true;
    this.omitPutVersionId = options.omitPutVersionId === true;
    this.putVersionId = Object.prototype.hasOwnProperty.call(options, "putVersionId")
      ? options.putVersionId
      : null;
    this.objects = new Map();
    this.nextVersion = 1;
  }

  async send(command) {
    this.commands.push(command);
    if (command instanceof HeadBucketCommand) {
      return { $metadata: { httpHeaders: {} } };
    }
    if (command instanceof GetBucketAclCommand) {
      return {
        Owner: { ID: "private-owner" },
        Grants: [
          {
            Grantee: { ID: "private-owner", Type: "CanonicalUser" },
            Permission: "FULL_CONTROL",
          },
        ],
      };
    }
    if (command instanceof GetPublicAccessBlockCommand) {
      return {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      };
    }
    if (command instanceof GetBucketPolicyStatusCommand) {
      return { PolicyStatus: { IsPublic: false } };
    }
    if (command instanceof PutObjectCommand) {
      if (this.objects.has(command.input.Key)) {
        const error = new Error("precondition failed");
        error.name = "PreconditionFailed";
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      const versionId =
        this.putVersionId === null
          ? "canary-version-" + this.nextVersion++
          : this.putVersionId;
      this.objects.set(command.input.Key, {
        head: {
          ChecksumSHA256: command.input.ChecksumSHA256,
          ContentLength: command.input.ContentLength,
          ContentType: command.input.ContentType,
          Metadata: { ...command.input.Metadata },
          ServerSideEncryption: "AES256",
        },
        versionId,
      });
      return {
        ServerSideEncryption: "AES256",
        ...(this.omitPutVersionId ? {} : { VersionId: versionId }),
      };
    }
    if (command instanceof ListObjectVersionsCommand) {
      if (this.failListMessage) throw new Error(this.failListMessage);
      if (this.emptyVersionLists) {
        return { DeleteMarkers: [], IsTruncated: false, Versions: [] };
      }
      return {
        DeleteMarkers: [],
        IsTruncated: false,
        Versions: [...this.objects.entries()]
          .filter(([key]) => key.startsWith(command.input.Prefix))
          .map(([key, record]) => ({
            ETag: '"canary-etag"',
            Key: key,
            VersionId: record.versionId,
          })),
      };
    }
    if (command instanceof DeleteObjectCommand) {
      const record = this.objects.get(command.input.Key);
      if (
        !this.retainDeletedVersions &&
        record &&
        record.versionId === command.input.VersionId
      ) {
        this.objects.delete(command.input.Key);
      }
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const record = this.objects.get(command.input.Key);
      if (!record) {
        if (command.input.VersionId !== undefined) throw noSuchVersion();
        throw noSuchKey();
      }
      return record.head;
    }
    throw new Error("unexpected S3 command");
  }
}

function lifecycle(now = Date.now) {
  return {
    readinessMs: 1000,
    timers: { clearTimeout, now, setTimeout },
  };
}

function deterministicRandom() {
  let value = 0;
  return (size) => Buffer.alloc(size, ++value);
}

function healthFixture(options = {}) {
  const config = productionConfig(options.env);
  const client = new AttestedTigrisClient(options.client);
  const objectStore = createHardenedSubtitleObjectStore(config, { client });
  return {
    client,
    health: createSubtitleStorageHealth(
      client,
      objectStore,
      config,
      options.lifecycle || lifecycle(),
      options.health
    ),
    objectStore,
  };
}

test("production erasure mode requires the version-purge contract", () => {
  const blocked = productionConfig({
    JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE:
      "blocked-tigris-provider-confirmation-required",
  });
  assert.throws(
    () => assertProductionSubtitleErasureReadiness(blocked),
    (error) => error.code === "subtitle_permanent_erasure_unverifiable"
  );
  assert.equal(assertProductionSubtitleErasureReadiness(productionConfig()), true);
});

test("production readiness needs no undocumented snapshot response header", async () => {
  const fixture = healthFixture();
  await fixture.health.run({ timeoutMs: 1000 });

  assert.equal(fixture.client.objects.size, 0);
  const names = fixture.client.commands.map((command) => command.constructor.name);
  assert.deepEqual(names.slice(0, 4), [
    "HeadBucketCommand",
    "GetBucketAclCommand",
    "GetPublicAccessBlockCommand",
    "GetBucketPolicyStatusCommand",
  ]);
  assert.ok(names.includes("PutObjectCommand"));
  assert.ok(names.includes("ListObjectVersionsCommand"));
  assert.ok(names.includes("DeleteObjectCommand"));
  assert.ok(
    fixture.client.commands
      .filter((command) => command instanceof DeleteObjectCommand)
      .every((command) => typeof command.input.VersionId === "string")
  );
  const exactDelete = fixture.client.commands.find(
    (command) => command instanceof DeleteObjectCommand
  );
  assert.match(exactDelete.input.VersionId, /^canary-version-[1-9][0-9]*$/);
  const exactHeads = fixture.client.commands.filter(
    (command) => command instanceof HeadObjectCommand
  );
  assert.equal(exactHeads.length, 2);
  assert.ok(
    exactHeads.every(
      (command) => command.input.VersionId === exactDelete.input.VersionId
    )
  );
});

test("production readiness rejects snapshot/versioning-disabled canary writes", async () => {
  const fixture = healthFixture({
    client: { omitPutVersionId: true, putVersionId: "null" },
  });
  await assert.rejects(
    fixture.health.run({ timeoutMs: 1000 }),
    (error) => error.code === "subtitle_permanent_erasure_unverifiable"
  );
  const put = fixture.client.commands.find((command) => command instanceof PutObjectCommand);
  assert.ok(put);
});

test("production readiness rejects exact deletion without local observation proof", async () => {
  const fixture = healthFixture({ client: { emptyVersionLists: true } });
  await assert.rejects(
    fixture.health.run({ timeoutMs: 1000 }),
    (error) => error.code === "subtitle_permanent_erasure_unverifiable"
  );
  assert.equal(fixture.client.objects.size, 1);
  assert.equal(
    fixture.client.commands.some((command) => command instanceof DeleteObjectCommand),
    false
  );
  assert.ok(
    fixture.client.commands.filter((command) => command instanceof ListObjectVersionsCommand)
      .length >= 4
  );
});

test("production readiness rejects the provider literal null VersionId", async () => {
  const fixture = healthFixture({ client: { putVersionId: "null" } });
  await assert.rejects(
    fixture.health.run({ timeoutMs: 1000 }),
    (error) => error.code === "subtitle_permanent_erasure_unverifiable"
  );
  const put = fixture.client.commands.find((command) => command instanceof PutObjectCommand);
  assert.ok(put);
});

test("interleaved replicas use private namespaces and cannot delete each other's canaries", async () => {
  let releaseFirstDelete;
  let reportFirstDelete;
  const firstDeleteReached = new Promise((resolve) => {
    reportFirstDelete = resolve;
  });
  const firstDeleteRelease = new Promise((resolve) => {
    releaseFirstDelete = resolve;
  });
  class InterleavedTigrisClient extends AttestedTigrisClient {
    constructor() {
      super();
      this.pausedDelete = false;
    }

    async send(command) {
      if (command instanceof DeleteObjectCommand && !this.pausedDelete) {
        this.pausedDelete = true;
        reportFirstDelete(command.input);
        await firstDeleteRelease;
      }
      return super.send(command);
    }
  }

  const config = productionConfig();
  const client = new InterleavedTigrisClient();
  const objectStore = createHardenedSubtitleObjectStore(config, { client });
  const randomBytes = deterministicRandom();
  const first = createSubtitleStorageHealth(client, objectStore, config, lifecycle(), {
    attestationFreshnessMs: 100,
    randomBytes,
  });
  const second = createSubtitleStorageHealth(client, objectStore, config, lifecycle(), {
    attestationFreshnessMs: 100,
    randomBytes,
  });

  const firstRun = first.run({ timeoutMs: 1000 });
  const pausedDelete = await firstDeleteReached;
  const secondRun = second.run({ timeoutMs: 1000 });
  try {
    await secondRun;
  } finally {
    releaseFirstDelete();
  }
  await firstRun;

  const puts = client.commands.filter((command) => command instanceof PutObjectCommand);
  assert.equal(puts.length, 2);
  const canaryKeys = puts.map((command) => command.input.Key);
  assert.equal(new Set(canaryKeys).size, 2);
  assert.equal(pausedDelete.Key, canaryKeys[0]);
  const deletedKeys = client.commands
    .filter((command) => command instanceof DeleteObjectCommand)
    .map((command) => command.input.Key);
  assert.deepEqual(
    canaryKeys.map((key) => deletedKeys.filter((deletedKey) => deletedKey === key).length),
    [1, 1]
  );
  const purgePrefixes = client.commands
    .filter((command) => command instanceof ListObjectVersionsCommand)
    .map((command) => command.input.Prefix);
  assert.ok(
    purgePrefixes.every(
      (prefix) => canaryKeys.filter((key) => key.startsWith(prefix)).length <= 1
    )
  );
  assert.equal(client.objects.size, 0);
});

test("repeated readiness coalesces in flight and refreshes only after its bounded lease", async () => {
  let now = 10_000;
  const fixture = healthFixture({
    health: { attestationFreshnessMs: 100, randomBytes: deterministicRandom() },
    lifecycle: lifecycle(() => now),
  });

  await Promise.all([
    fixture.health.run({ timeoutMs: 1000 }),
    fixture.health.run({ timeoutMs: 1000 }),
  ]);
  await fixture.health.run({ timeoutMs: 1000 });
  assert.equal(
    fixture.client.commands.filter((command) => command instanceof PutObjectCommand).length,
    1
  );

  now += 101;
  await fixture.health.run({ timeoutMs: 1000 });
  const puts = fixture.client.commands.filter((command) => command instanceof PutObjectCommand);
  assert.equal(puts.length, 2);
  assert.notEqual(puts[0].input.Key, puts[1].input.Key);
  assert.equal(fixture.client.objects.size, 0);
});

test("same-instance readiness recovers its own failed canary before refreshing", async () => {
  class RecoverableDeleteClient extends AttestedTigrisClient {
    constructor() {
      super();
      this.failDeletes = true;
      this.successfulDeletes = [];
    }

    async send(command) {
      if (command instanceof DeleteObjectCommand && this.failDeletes) {
        this.commands.push(command);
        const error = new Error("AccessDenied private provider details");
        error.name = "AccessDenied";
        error.$metadata = { httpStatusCode: 403 };
        throw error;
      }
      if (command instanceof DeleteObjectCommand) {
        this.successfulDeletes.push({ ...command.input });
      }
      return super.send(command);
    }
  }

  const config = productionConfig();
  const client = new RecoverableDeleteClient();
  const objectStore = createHardenedSubtitleObjectStore(config, { client });
  const health = createSubtitleStorageHealth(client, objectStore, config, lifecycle(), {
    attestationFreshnessMs: 100,
    randomBytes: deterministicRandom(),
  });

  await assert.rejects(
    health.run({ timeoutMs: 1000 }),
    (error) => error.code === "subtitle_permanent_erasure_unverifiable"
  );
  assert.equal(client.objects.size, 1);
  const [failedKey] = client.objects.keys();
  assert.ok(failedKey);

  client.failDeletes = false;
  await health.run({ timeoutMs: 1000 });

  assert.equal(client.objects.size, 0);
  assert.ok(
    client.successfulDeletes.some((command) => command.Key === failedKey)
  );
});

test("production readiness rejects residual versions and redacts provider errors", async () => {
  const residual = healthFixture({
    client: { retainDeletedVersions: true },
  });
  await assert.rejects(
    residual.health.run({ timeoutMs: 1000 }),
    (error) => error.code === "subtitle_permanent_erasure_unverifiable"
  );
  assert.equal(residual.client.objects.size, 1);

  const failed = healthFixture({
    client: {
      failListMessage:
        "bucket=jumpgate-test-subtitles AWS_SECRET_ACCESS_KEY=subtitle-secret-do-not-reflect",
    },
  });
  await assert.rejects(failed.health.run({ timeoutMs: 1000 }), (error) => {
    assert.equal(error.code, "subtitle_permanent_erasure_unverifiable");
    assert.doesNotMatch(
      error.stack,
      /jumpgate-test-subtitles|AWS_SECRET_ACCESS_KEY|subtitle-secret-do-not-reflect/
    );
    return true;
  });
});

test("readiness canary names and results do not expose configured credentials", async () => {
  const fixture = healthFixture();
  await fixture.health.run({ timeoutMs: 1000 });
  const serialized = JSON.stringify(
    fixture.client.commands.map((command) => ({
      input: command.input,
      name: command.constructor.name,
    })),
    (_name, value) => (Buffer.isBuffer(value) ? "<bytes>" : value)
  );
  assert.doesNotMatch(
    serialized,
    /subtitle-access-do-not-reflect|subtitle-secret-do-not-reflect/
  );
  const put = fixture.client.commands.find((command) => command instanceof PutObjectCommand);
  assert.ok(put);
  assert.equal(put.input.Key.includes("permanent-erasure"), false);
  assert.equal(put.input.Key.includes("readiness"), false);
  assert.equal(crypto.createHash("sha256").update(put.input.Body).digest("hex").length, 64);
});
