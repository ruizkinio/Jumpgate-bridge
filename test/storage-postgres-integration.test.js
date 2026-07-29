"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Pool } = require("pg");
const { createClient } = require("redis");

const {
  EnvelopeCrypto,
  TokenService,
  createStorageRuntime,
  loadStorageConfig,
} = require("../lib/storage");
const {
  fingerprintExactUrl,
  hashOpaqueValue,
  invalidateProviderSnapshot,
  readProviderCollectionSnapshot,
  replaceProviderCollection,
} = require("../lib/source-context");
const { HistoryService } = require("../lib/history-service");
const { ProfileLifecycleService } = require("../lib/profile-lifecycle-service");
const { assertRepository } = require("../lib/storage/contracts");
const {
  activateProviderMutationProtocol,
  createPostgresRepositories,
  pauseProviderMutations,
  PostgresDatabase,
  PostgresMigrationRunner,
  readProviderMutationProtocolState,
  resumeProviderMutations,
} = require("../lib/storage/postgres");
const {
  MAX_BACKUP_ENVELOPE_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
  MAX_JSON_SNAPSHOT_BYTES,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
  MAX_POSTGRES_JSONB_STORAGE_BYTES,
} = require("../lib/storage/postgres/repository-helpers");
const {
  RedisKeyspace,
  RedisManagementSessionRepository,
  RedisPlaybackContextRepository,
} = require("../lib/storage/redis");

const POSTGRES_URL = process.env.TEST_POSTGRES_URL || process.env.DATABASE_URL || "";
const REDIS_URL = process.env.REDIS_URL || "";
// Snapshots of the exact query strings in c801f38dec932c6a188ddbf3581750fa118ec3e6.
const LEGACY_PROVIDER_COLLECTION_FIRST_INSERT_SQL = [
  "INSERT INTO provider_collections (profile_id, schema_version, revision, updated_at)",
  "           VALUES ($1, 1, 0, $2)",
  "           ON CONFLICT (profile_id) DO NOTHING",
].join("\n");
const LEGACY_PROVIDER_COLLECTION_UPDATE_SQL = [
  "UPDATE provider_collections",
  "              SET revision = revision + 1, updated_at = $3",
  "            WHERE profile_id = $1 AND revision = $2",
  "            RETURNING revision",
].join("\n");

function quoteIdentifier(value) {
  assert.match(value, /^[a-z0-9_]+$/);
  return '"' + value + '"';
}

function schemaName(label) {
  return [
    "jumpgate",
    label,
    String(process.pid),
    crypto.randomBytes(6).toString("hex"),
  ].join("_");
}

function idFactory() {
  const counters = new Map();
  return (kind) => {
    const next = (counters.get(kind) || 0) + 1;
    counters.set(kind, next);
    return kind + "_integration_" + String(next).padStart(6, "0");
  };
}

function providerDescriptor(name) {
  return {
    transportUrl: "https://" + name + ".example/manifest.json",
    manifest: {
      id: "org.example." + name,
      version: "1.0.0",
      name,
      types: ["movie"],
      resources: ["stream"],
    },
  };
}

function lifecyclePlaybackContext(url, mediaId) {
  return {
    contentKey: hashOpaqueValue("movie:" + mediaId),
    canonicalIdentity: {
      provider: "imdb",
      id: mediaId,
      mediaType: "movie",
      season: null,
      episode: null,
      provenance: "metadata-request",
      confidence: "canonical",
    },
    traktEligible: true,
    request: { type: "movie", metaId: mediaId, videoId: mediaId },
    source: { type: "url", provider: "integration" },
    fingerprints: [fingerprintExactUrl(url)],
  };
}

function lifecycleClaimRequest(url) {
  return {
    fingerprints: [fingerprintExactUrl(url)],
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: Date.now(),
  };
}

function lifecycleClaimInput(url, sessionId) {
  const request = {
    ...lifecycleClaimRequest(url),
    attemptId: crypto.randomUUID(),
  };
  return {
    request,
    options: {
      sessionId,
      requestDigest: hashOpaqueValue(JSON.stringify(request)),
    },
  };
}

async function cleanRedisPrefix(client, prefix) {
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, { MATCH: prefix + ":*", COUNT: 100 });
    cursor = String(reply.cursor);
    if (reply.keys.length > 0) await client.del(reply.keys);
  } while (cursor !== "0");
}

function objectWithExactJsonBytes(base, field, byteLength) {
  const value = { ...base, [field]: "" };
  const emptyLength = Buffer.byteLength(JSON.stringify(value), "utf8");
  assert.ok(emptyLength <= byteLength);
  value[field] = "x".repeat(byteLength - emptyLength);
  assert.equal(Buffer.byteLength(JSON.stringify(value), "utf8"), byteLength);
  return value;
}

function collectionWithExactJsonBytes(byteLength) {
  const collection = [{ payload: "" }];
  const emptyLength = Buffer.byteLength(JSON.stringify(collection), "utf8");
  assert.ok(emptyLength <= byteLength);
  collection[0].payload = "x".repeat(byteLength - emptyLength);
  assert.equal(Buffer.byteLength(JSON.stringify(collection), "utf8"), byteLength);
  return collection;
}

async function createIsolatedPool(adminPool, pools, schemas, label) {
  const schema = schemaName(label);
  await adminPool.query("CREATE SCHEMA " + quoteIdentifier(schema));
  schemas.push(schema);
  const pool = new Pool({
    connectionString: POSTGRES_URL,
    max: 8,
    options: "-c search_path=" + schema + ",public",
  });
  pools.push(pool);
  return { pool, schema };
}

async function waitForPendingProviderCollectionLock(adminPool, schema) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await adminPool.query(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_locks AS locks
           JOIN pg_class AS relations ON relations.oid = locks.relation
           JOIN pg_namespace AS namespaces ON namespaces.oid = relations.relnamespace
          WHERE namespaces.nspname = $1
            AND relations.relname = 'provider_collections'
            AND locks.mode = 'AccessExclusiveLock'
            AND locks.granted = false
       ) AS waiting`,
      [schema]
    );
    if (result.rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("provider mutation transition did not wait for the collection lock");
}

function providerRowsSnapshot(rows) {
  return Buffer.from(JSON.stringify(rows), "utf8");
}

test("legacy provider collection SQL snapshots remain byte-for-byte pinned to c801f38", () => {
  assert.equal(
    crypto.createHash("sha256").update(LEGACY_PROVIDER_COLLECTION_FIRST_INSERT_SQL).digest("hex"),
    "f46ddf1998f16ba5bfd5e7bc385259d5b295ac94402255b22b67aa66096ddbb5"
  );
  assert.equal(
    crypto.createHash("sha256").update(LEGACY_PROVIDER_COLLECTION_UPDATE_SQL).digest("hex"),
    "52c6ff4331725303af55dda4cdfa47dc418e613ac262979cf5f23e1f88846488"
  );
});

async function assertJsonbBoundary(pool, options) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const empty = await client.query(
      "SELECT octet_length(jsonb_build_object('padding', '')::text) AS bytes"
    );
    const paddingBytes = options.limit - Number(empty.rows[0].bytes);
    assert.ok(paddingBytes >= 0);
    const updateWhere = options.where.replace(
      /\$([0-9]+)/g,
      (_match, index) => "$" + (Number(index) + 1)
    );
    const updateSql =
      "UPDATE " + options.table +
      " SET " + options.column +
      " = jsonb_build_object('padding', repeat('x', $1::integer)) " +
      updateWhere;
    const exact = await client.query(updateSql, [paddingBytes, ...options.values]);
    assert.equal(exact.rowCount, 1);
    const measured = await client.query(
      "SELECT octet_length(" + options.column + "::text) AS bytes " +
      "FROM " + options.table + " " + options.where,
      options.values
    );
    assert.equal(Number(measured.rows[0].bytes), options.limit);
    await assert.rejects(
      () => client.query(updateSql, [paddingBytes + 1, ...options.values]),
      (error) => error.code === "23514" && error.constraint === options.constraint
    );
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}

async function assertMigrationRollback(adminPool, pools, schemas) {
  const { pool, schema } = await createIsolatedPool(
    adminPool,
    pools,
    schemas,
    "migration_rollback"
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jumpgate-pg-integration-"));
  try {
    await fs.writeFile(
      path.join(directory, "0001_first.sql"),
      "CREATE TABLE rollback_first (id integer PRIMARY KEY);\n"
    );
    await fs.writeFile(
      path.join(directory, "0002_failing.sql"),
      "CREATE TABLE rollback_leak (id integer);\n" +
        "SELECT * FROM definitely_missing_relation;\n"
    );
    await assert.rejects(
      () => new PostgresMigrationRunner({ pool, directory }).run(),
      (error) => error.code === "42P01"
    );
    const relations = await pool.query(
      "SELECT to_regclass($1) AS first, to_regclass($2) AS leaked, " +
        "to_regclass($3) AS history",
      [
        schema + ".rollback_first",
        schema + ".rollback_leak",
        schema + ".schema_migrations",
      ]
    );
    assert.deepEqual(relations.rows[0], { first: null, leaked: null, history: null });
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

test(
  "real PostgreSQL migrations and durable adapter contracts",
  {
    skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL",
    timeout: 120000,
  },
  async () => {
    const adminPool = new Pool({ connectionString: POSTGRES_URL, max: 2 });
    const pools = [];
    const schemas = [];
    try {
      await assertMigrationRollback(adminPool, pools, schemas);
      const { pool } = await createIsolatedPool(adminPool, pools, schemas, "contracts");
      const legacyDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "jumpgate-pg-legacy-migrations-")
      );
      try {
        for (const filename of ["0001_initial.sql", "0002_contract_parity.sql"]) {
          await fs.copyFile(
            path.join(__dirname, "..", "migrations", "postgres", filename),
            path.join(legacyDirectory, filename)
          );
        }
        const legacyResult = await new PostgresMigrationRunner({
          pool,
          directory: legacyDirectory,
        }).run();
        assert.deepEqual(legacyResult.applied, ["0001_initial", "0002_contract_parity"]);

        const upgradeProfileId = "profile_upgrade_probe";
        await pool.query(
          `INSERT INTO profiles (id, schema_version, install_token_hash)
           VALUES ($1, 1, $2)`,
          [upgradeProfileId, "c".repeat(64)]
        );
        await pool.query(
          `INSERT INTO cloud_history (
             profile_id, content_key, schema_version, canonical_identity,
             revision, last_played_at
           ) VALUES (
             $1, $2, 1, jsonb_build_object('padding', repeat('x', $3::integer)),
             1, now()
           )`,
          [upgradeProfileId, "d".repeat(64), MAX_POSTGRES_JSONB_STORAGE_BYTES + 1]
        );

        const migrationResult = await new PostgresMigrationRunner({ pool }).run();
        assert.deepEqual(migrationResult.applied, [
          "0003_storage_correctness",
          "0004_provider_mutation_fence",
          "0005_lifecycle_controls",
          "0006_lifecycle_security_outbox",
          "0007_durable_subtitle_manifests",
          "0008_scrobble_dispatch",
          "0009_claim_bound_history",
          "0010_dispatch_history_generation",
          "0011_history_http_receipts",
        ]);
        assert.deepEqual(migrationResult.alreadyApplied, [
          "0001_initial",
          "0002_contract_parity",
        ]);
        const canonicalConstraint = await pool.query(
          `SELECT convalidated
             FROM pg_constraint
            WHERE conname = 'cloud_history_canonical_identity_size'`
        );
        assert.equal(canonicalConstraint.rows[0].convalidated, false);
        await assert.rejects(
          () => pool.query(
            `INSERT INTO cloud_history (
               profile_id, content_key, schema_version, canonical_identity,
               revision, last_played_at
             ) VALUES (
               $1, $2, 1, jsonb_build_object('padding', repeat('x', $3::integer)),
               1, now()
             )`,
            [upgradeProfileId, "e".repeat(64), MAX_POSTGRES_JSONB_STORAGE_BYTES + 1]
          ),
          (error) =>
            error.code === "23514" &&
            error.constraint === "cloud_history_canonical_identity_size"
        );
        await pool.query("DELETE FROM profiles WHERE id = $1", [upgradeProfileId]);
      } finally {
        await fs.rm(legacyDirectory, { force: true, recursive: true });
      }
      assert.deepEqual(
        (await new PostgresMigrationRunner({ pool }).run()).alreadyApplied,
        [
          "0001_initial",
          "0002_contract_parity",
          "0003_storage_correctness",
          "0004_provider_mutation_fence",
          "0005_lifecycle_controls",
          "0006_lifecycle_security_outbox",
          "0007_durable_subtitle_manifests",
          "0008_scrobble_dispatch",
          "0009_claim_bound_history",
          "0010_dispatch_history_generation",
          "0011_history_http_receipts",
        ]
      );

      const now = Date.now();
      const keyId = "k".repeat(64);
      const repositories = createPostgresRepositories(pool, {
        clock: () => now,
        envelopeCrypto: new EnvelopeCrypto({
          primaryKeyId: keyId,
          keys: { [keyId]: Buffer.alloc(32, 0x51) },
        }),
        idFactory: idFactory(),
        maxBackupsPerProfile: 4,
        maxDevicesPerProfile: 4,
        providerMutationMode: "fenced",
        tokenService: new TokenService({
          pepper: Buffer.alloc(32, 0x61),
        }),
      });
      for (const name of [
        "profiles",
        "devices",
        "providers",
        "oauthCredentials",
        "history",
        "addonCollectionBackups",
        "legacyConfigAliases",
      ]) {
        assert.equal(assertRepository(name, repositories[name]), repositories[name]);
      }

      const created = await repositories.profiles.create({ displayName: "Integration" });
      const profileId = created.profile.id;
      assert.equal((await repositories.profiles.getByInstallToken(created.installToken)).id, profileId);
      const allocatedFences = await Promise.all(
        Array.from({ length: 24 }, () =>
          repositories.providers.allocateMutationFence(profileId)
        )
      );
      assert.equal(new Set(allocatedFences).size, 24);
      assert.deepEqual(
        allocatedFences.slice().sort((left, right) =>
          BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
        ),
        Array.from({ length: 24 }, (_, index) => String(index + 1))
      );
      assert.equal(
        (await pool.query(
          "SELECT COUNT(*)::integer AS count FROM provider_collections WHERE profile_id = $1",
          [profileId]
        )).rows[0].count,
        0
      );

      const descriptor = objectWithExactJsonBytes(
        { transportUrl: "https://boundary.example/manifest.json" },
        "padding",
        MAX_JSON_SNAPSHOT_BYTES
      );
      const credentials = objectWithExactJsonBytes({}, "padding", MAX_JSON_SNAPSHOT_BYTES);
      const collection = collectionWithExactJsonBytes(MAX_BACKUP_PLAINTEXT_BYTES);
      const firstFence = "1".repeat(128);
      const recoveryFence = "2".repeat(128);
      await repositories.providers.replaceAll(profileId, [descriptor], 0, {
        mutationFence: firstFence,
      });
      assert.equal(
        await repositories.providers.allocateMutationFence(profileId),
        (BigInt(firstFence) + 1n).toString(10)
      );
      await repositories.oauthCredentials.put(profileId, "trakt", credentials, 0);
      const backup = await repositories.addonCollectionBackups.create(
        profileId,
        collection,
        "exact-boundary"
      );

      const envelopeLengths = await pool.query(
        `SELECT
           (SELECT octet_length(descriptor_envelope::text) FROM providers
             WHERE profile_id = $1) AS provider,
           (SELECT octet_length(credential_envelope::text) FROM oauth_credentials
             WHERE profile_id = $1 AND provider = 'trakt') AS oauth,
           (SELECT octet_length(collection_envelope::text) FROM addon_collection_backups
             WHERE id = $2) AS backup`,
        [profileId, backup.id]
      );
      assert.deepEqual(envelopeLengths.rows[0], {
        provider: MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
        oauth: MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
        backup: MAX_BACKUP_ENVELOPE_BYTES,
      });

      await assertJsonbBoundary(pool, {
        column: "descriptor_envelope",
        constraint: "providers_descriptor_envelope_size",
        limit: MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
        table: "providers",
        values: [profileId],
        where: "WHERE profile_id = $1",
      });
      await assertJsonbBoundary(pool, {
        column: "credential_envelope",
        constraint: "oauth_credentials_envelope_size",
        limit: MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
        table: "oauth_credentials",
        values: [profileId, "trakt"],
        where: "WHERE profile_id = $1 AND provider = $2",
      });
      await assertJsonbBoundary(pool, {
        column: "collection_envelope",
        constraint: "addon_collection_backups_envelope_size",
        limit: MAX_BACKUP_ENVELOPE_BYTES,
        table: "addon_collection_backups",
        values: [backup.id],
        where: "WHERE id = $1",
      });

      const listedProviders = await repositories.providers.list(profileId);
      assert.equal(listedProviders.revision, 1);
      assert.equal(listedProviders.providers[0].descriptor.padding.length, descriptor.padding.length);
      assert.deepEqual(await repositories.providers.advanceMutationFence(
        profileId,
        recoveryFence
      ), {
        revision: 1,
        mutationFence: recoveryFence,
      });
      assert.equal(
        await repositories.providers.allocateMutationFence(profileId),
        (BigInt(recoveryFence) + 1n).toString(10)
      );
      assert.deepEqual(await repositories.providers.advanceMutationFence(
        profileId,
        recoveryFence
      ), {
        revision: 1,
        mutationFence: recoveryFence,
      });
      assert.deepEqual(await repositories.providers.list(profileId), listedProviders);
      await assert.rejects(
        () => repositories.providers.replaceAll(profileId, [descriptor], 1, {
          mutationFence: firstFence,
        }),
        (error) => error.code === "provider_snapshot_stale_fence"
      );
      assert.deepEqual(await repositories.providers.list(profileId), listedProviders);
      assert.equal(
        (await pool.query(
          "SELECT mutation_fence::text AS mutation_fence FROM provider_collections " +
          "WHERE profile_id = $1",
          [profileId]
        )).rows[0].mutation_fence,
        recoveryFence
      );
      const exhaustedProfile = await repositories.profiles.create({ displayName: "Exhausted" });
      await repositories.providers.advanceMutationFence(
        exhaustedProfile.profile.id,
        "9".repeat(128)
      );
      await assert.rejects(
        () => repositories.providers.allocateMutationFence(profileId),
        (error) =>
          error.code === "provider_mutation_fence_exhausted" &&
          error.message === "provider mutation fence allocator exhausted"
      );
      assert.equal(
        (await repositories.oauthCredentials.get(profileId, "trakt")).credentials.padding.length,
        credentials.padding.length
      );
      assert.equal(
        Buffer.byteLength(
          JSON.stringify((await repositories.addonCollectionBackups.get(profileId, backup.id)).collection),
          "utf8"
        ),
        MAX_BACKUP_PLAINTEXT_BYTES
      );
      assert.equal((await repositories.addonCollectionBackups.list(profileId)).length, 1);
      assert.equal(await repositories.addonCollectionBackups.markRestored(profileId, backup.id), true);

      const device = await repositories.devices.register(profileId, {
        displayName: "Integration TV",
        pairingId: "pairing_integration_000001",
      });
      assert.equal((await repositories.devices.authenticate(device.deviceToken)).id, device.device.id);

      const history = await repositories.history.upsert(
        profileId,
        {
          canonicalIdentity: objectWithExactJsonBytes(
            { id: "tt0133093", provider: "imdb", tiny: Number.MIN_VALUE },
            "padding",
            MAX_JSON_SNAPSHOT_BYTES
          ),
          completed: false,
          contentKey: "a".repeat(64),
          displaySnapshot: objectWithExactJsonBytes(
            { title: "Integration", tiny: Number.MIN_VALUE, year: 1999 },
            "padding",
            MAX_JSON_SNAPSHOT_BYTES
          ),
          durationMs: 2000,
          lastPlayedAt: now,
          playbackSnapshot: {},
          positionMs: 1000,
          watchedMs: 1000,
        },
        0
      );
      assert.equal((await repositories.history.get(profileId, history.contentKey)).revision, 1);
      assert.equal((await repositories.history.changes(profileId)).length, 1);
      const historyLengths = await pool.query(
        `SELECT octet_length(canonical_identity::text) AS canonical,
                octet_length(display_snapshot::text) AS display
           FROM cloud_history
          WHERE profile_id = $1 AND content_key = $2`,
        [profileId, history.contentKey]
      );
      assert.ok(historyLengths.rows[0].canonical > MAX_JSON_SNAPSHOT_BYTES);
      assert.ok(historyLengths.rows[0].display > MAX_JSON_SNAPSHOT_BYTES);
      assert.ok(historyLengths.rows[0].canonical <= MAX_POSTGRES_JSONB_STORAGE_BYTES);
      assert.ok(historyLengths.rows[0].display <= MAX_POSTGRES_JSONB_STORAGE_BYTES);

      for (const boundary of [
        ["canonical_identity", "cloud_history_canonical_identity_size"],
        ["display_snapshot", "cloud_history_display_snapshot_size"],
        ["playback_snapshot", "cloud_history_playback_snapshot_size"],
      ]) {
        await assertJsonbBoundary(pool, {
          column: boundary[0],
          constraint: boundary[1],
          limit: MAX_POSTGRES_JSONB_STORAGE_BYTES,
          table: "cloud_history",
          values: [profileId, history.contentKey],
          where: "WHERE profile_id = $1 AND content_key = $2",
        });
      }

      const tiedKeys = ["b", "c", "d"].map((value) => value.repeat(64));
      for (const contentKey of tiedKeys) {
        await repositories.history.upsert(
          profileId,
          {
            completed: false,
            contentKey,
            displaySnapshot: { title: contentKey.slice(0, 1) },
            durationMs: 2000,
            lastPlayedAt: now,
            playbackSnapshot: {},
            positionMs: 1000,
            watchedMs: 1000,
          },
          0
        );
      }
      await repositories.history.upsert(
        profileId,
        {
          completed: false,
          contentKey: tiedKeys[2],
          displaySnapshot: { title: "updated" },
          durationMs: 2000,
          lastPlayedAt: now,
          playbackSnapshot: {},
          positionMs: 1000,
          watchedMs: 1000,
        },
        1
      );
      const firstHistoryPage = await repositories.history.list(profileId, { limit: 2 });
      const pageBoundary = firstHistoryPage.at(-1);
      const secondHistoryPage = await repositories.history.list(profileId, {
        cursor: {
          contentKey: pageBoundary.contentKey,
          lastPlayedAt: pageBoundary.lastPlayedAt,
          revision: pageBoundary.revision,
        },
        limit: 2,
      });
      assert.deepEqual(
        [...firstHistoryPage, ...secondHistoryPage].map((entry) => entry.contentKey),
        [tiedKeys[2], history.contentKey, tiedKeys[0], tiedKeys[1]]
      );

      const historyService = new HistoryService({
        repository: repositories.history,
        clock: () => now + 1,
      });
      const serviceKey = "f".repeat(64);
      const serviceRecord = await historyService.put(
        { profileId, deviceId: device.device.id },
        serviceKey,
        {
          canonicalIdentity: {
            provider: "imdb",
            id: "tt0133093",
            mediaType: "movie",
            provenance: "metadata-request",
            confidence: "canonical",
          },
          displaySnapshot: { title: "Postgres history" },
          playbackSnapshot: { providerNamespace: "postgres-integration" },
          positionMs: 1250,
          durationMs: 5000,
          watchedMs: 1250,
          completed: false,
        }
      );
      assert.equal(serviceRecord.lastPlayedAt, now + 1);
      assert.deepEqual(
        await historyService.get(
          { profileId, deviceId: "device_integration_other" },
          serviceKey
        ),
        serviceRecord
      );
      assert.equal(Object.hasOwn(serviceRecord, "profileId"), false);
      assert.equal(Object.hasOwn(serviceRecord, "changeSequence"), false);

      assert.equal(await repositories.history.remove(profileId, serviceKey, 1), true);
      assert.equal(
        await historyService.get({ profileId, deviceId: device.device.id }, serviceKey),
        null
      );
      const serviceTombstone = await repositories.history.getForWrite(profileId, serviceKey);
      assert.equal(serviceTombstone.revision, 2);
      assert.ok(serviceTombstone.deletedAt !== null);
      const resurrectedServiceRecord = await historyService.put(
        { profileId, deviceId: device.device.id },
        serviceKey,
        {
          canonicalIdentity: {
            provider: "imdb",
            id: "tt0133093",
            mediaType: "movie",
            provenance: "metadata-request",
            confidence: "canonical",
          },
          displaySnapshot: { title: "Postgres history replay" },
          playbackSnapshot: { providerNamespace: "postgres-integration" },
          positionMs: 500,
          durationMs: 5000,
          watchedMs: 500,
          completed: false,
        }
      );
      assert.equal(resurrectedServiceRecord.lastPlayedAt, now + 2);
      assert.equal((await repositories.history.get(profileId, serviceKey)).revision, 3);

      const alias = "b".repeat(64);
      await repositories.legacyConfigAliases.bind(profileId, alias);
      assert.equal(await repositories.legacyConfigAliases.getProfileId(alias), profileId);

      const contenders = await Promise.allSettled([
        repositories.profiles.update(profileId, { displayName: "CAS A" }, 1),
        repositories.profiles.update(profileId, { displayName: "CAS B" }, 1),
      ]);
      assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = contenders.find((result) => result.status === "rejected");
      assert.equal(rejected.reason.code, "revision_conflict");
      assert.equal((await repositories.profiles.getById(profileId)).revision, 2);

      const database = new PostgresDatabase({ pool });
      await pool.query("CREATE TABLE transaction_rollback_probe (value integer)");
      const rollbackError = new Error("force rollback");
      await assert.rejects(
        () => database.transaction(async (transaction) => {
          await transaction.query("INSERT INTO transaction_rollback_probe (value) VALUES (1)");
          throw rollbackError;
        }),
        (error) => error === rollbackError
      );
      assert.equal(
        Number((await pool.query("SELECT count(*) AS count FROM transaction_rollback_probe")).rows[0].count),
        0
      );
    } finally {
      for (const pool of pools.reverse()) {
        await pool.end().catch(() => {});
      }
      for (const schema of schemas.reverse()) {
        await adminPool
          .query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE")
          .catch(() => {});
      }
      await adminPool.end().catch(() => {});
    }
  }
);

test(
  "real PostgreSQL runtime migrates, becomes ready, and serves repositories at 0010",
  {
    skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL",
    timeout: 120000,
  },
  async (t) => {
    const adminPool = new Pool({ connectionString: POSTGRES_URL, max: 2 });
    const pools = [];
    const schemas = [];
    t.after(async () => {
      for (const currentPool of pools.reverse()) {
        await currentPool.end().catch(() => {});
      }
      for (const schema of schemas.reverse()) {
        await adminPool
          .query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE")
          .catch(() => {});
      }
      await adminPool.end().catch(() => {});
    });

    const { pool } = await createIsolatedPool(adminPool, pools, schemas, "runtime_0010");
    const randomBytes = (length) => Buffer.alloc(length, 0x5d);
    const securitySeed = randomBytes(32);
    const testMaterial = (label) => crypto
      .createHash("sha256")
      .update("jumpgate-runtime-fixture-v1\0", "utf8")
      .update(label, "utf8")
      .update(securitySeed)
      .digest("base64url");
    const envelopeKeyId = "runtime-fixture-primary";
    const config = loadStorageConfig(
      {
        NODE_ENV: "development",
        JUMPGATE_DURABLE_DRIVER: "postgres",
        JUMPGATE_TTL_DRIVER: "memory",
        DATABASE_URL: POSTGRES_URL,
        JUMPGATE_PROVIDER_MUTATION_MODE: "legacy",
        JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
        JUMPGATE_TOKEN_PEPPER: testMaterial("token-pepper"),
        JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: envelopeKeyId,
        JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([{
          id: envelopeKeyId,
          key: testMaterial("envelope-key"),
        }]),
      },
      { randomBytes }
    );
    securitySeed.fill(0);
    const runtime = await createStorageRuntime(config, {
      postgresPool: pool,
      postgresRepositoryOptions: { idFactory: idFactory() },
      randomBytes,
    });
    t.after(() => runtime.close());

    assert.deepEqual(runtime.migrationResult.verified, [
      "0001_initial",
      "0002_contract_parity",
      "0003_storage_correctness",
      "0004_provider_mutation_fence",
      "0005_lifecycle_controls",
      "0006_lifecycle_security_outbox",
      "0007_durable_subtitle_manifests",
      "0008_scrobble_dispatch",
      "0009_claim_bound_history",
      "0010_dispatch_history_generation",
      "0011_history_http_receipts",
    ]);
    assert.deepEqual(await runtime.ready(), {
      status: "ready",
      durableDriver: "postgres",
      ttlDriver: "memory",
    });

    const created = await runtime.repositories.profiles.create({ displayName: "Runtime 0010" });
    const registered = await runtime.repositories.devices.register(created.profile.id, {
      displayName: "Kodi",
    });
    const binding = await runtime.repositories.devices.authenticate(registered.deviceToken);
    assert.equal(binding.generation, 1);
    await runtime.repositories.oauthCredentials.put(
      created.profile.id,
      "trakt",
      { access_token: "runtime-test" },
      0
    );
    const stored = await runtime.repositories.history.upsert(
      created.profile.id,
      {
        canonicalIdentity: null,
        completed: false,
        contentKey: "5".repeat(64),
        displaySnapshot: { title: "Runtime" },
        durationMs: 1000,
        lastPlayedAt: 1000,
        playbackSnapshot: {},
        positionMs: 100,
        watchedMs: 100,
      },
      0,
      { deviceId: binding.id, deviceGeneration: binding.generation }
    );
    assert.equal(stored.revision, 1);
    assert.deepEqual(
      (await runtime.repositories.oauthCredentials.get(created.profile.id, "trakt")).credentials,
      { access_token: "runtime-test" }
    );
  }
);

test(
  "real PostgreSQL provider mutation expansion and activation fence legacy writers",
  {
    skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL",
    timeout: 120000,
  },
  async () => {
    const adminPool = new Pool({ connectionString: POSTGRES_URL, max: 4 });
    const pools = [];
    const schemas = [];
    let blocker = null;
    let competitor = null;
    try {
      const { pool, schema } = await createIsolatedPool(
        adminPool,
        pools,
        schemas,
        "provider_activation"
      );
      const compatibility = await new PostgresMigrationRunner({
        pool,
        migrationCeiling: "0003_storage_correctness",
      }).run();
      assert.deepEqual(compatibility.applied, [
        "0001_initial",
        "0002_contract_parity",
        "0003_storage_correctness",
      ]);
      assert.deepEqual(compatibility.verified, [
        "0001_initial",
        "0002_contract_parity",
        "0003_storage_correctness",
        "0004_provider_mutation_fence",
        "0005_lifecycle_controls",
        "0006_lifecycle_security_outbox",
        "0007_durable_subtitle_manifests",
        "0008_scrobble_dispatch",
        "0009_claim_bound_history",
        "0010_dispatch_history_generation",
        "0011_history_http_receipts",
      ]);
      assert.deepEqual(
        (await pool.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(
          (row) => row.version
        ),
        compatibility.applied
      );
      assert.equal(
        (await pool.query("SELECT to_regclass('provider_mutation_protocol') AS relation")).rows[0]
          .relation,
        null
      );

      const createProfile = async (profileId) => {
        await pool.query(
          `INSERT INTO profiles (id, schema_version, install_token_hash)
           VALUES ($1, 1, $2)`,
          [profileId, crypto.createHash("sha256").update(profileId).digest("hex")]
        );
      };
      const preservedProfile = "profile_activation_preserved";
      await createProfile(preservedProfile);
      await pool.query(LEGACY_PROVIDER_COLLECTION_FIRST_INSERT_SQL, [
        preservedProfile,
        new Date(1000),
      ]);

      const expansion = await new PostgresMigrationRunner({ pool }).run();
      assert.deepEqual(expansion.applied, [
        "0004_provider_mutation_fence",
        "0005_lifecycle_controls",
        "0006_lifecycle_security_outbox",
        "0007_durable_subtitle_manifests",
        "0008_scrobble_dispatch",
        "0009_claim_bound_history",
        "0010_dispatch_history_generation",
        "0011_history_http_receipts",
      ]);
      assert.deepEqual(
        (
          await pool.query(
            `SELECT revision::text AS revision, mutation_fence::text AS mutation_fence
               FROM provider_collections
              WHERE profile_id = $1`,
            [preservedProfile]
          )
        ).rows[0],
        { revision: "0", mutation_fence: "0" }
      );
      assert.deepEqual(
        (
          await pool.query(
            `SELECT
               enforcement_active,
               mutations_paused,
               activated_at,
               paused_at,
               activation_fence::text AS activation_fence
               FROM provider_mutation_protocol
              WHERE singleton_id = 1`
          )
        ).rows[0],
        {
          enforcement_active: false,
          mutations_paused: false,
          activated_at: null,
          paused_at: null,
          activation_fence: null,
        }
      );

      const inactiveLegacyProfile = "profile_activation_inactive";
      await createProfile(inactiveLegacyProfile);
      await pool.query(LEGACY_PROVIDER_COLLECTION_FIRST_INSERT_SQL, [
        inactiveLegacyProfile,
        new Date(2000),
      ]);
      assert.equal(
        (
          await pool.query(LEGACY_PROVIDER_COLLECTION_UPDATE_SQL, [
            inactiveLegacyProfile,
            0,
            new Date(3000),
          ])
        ).rows[0].revision,
        "1"
      );
      await pool.query(
        "UPDATE provider_collections SET mutation_fence = 17 WHERE profile_id = $1",
        [preservedProfile]
      );

      const repositories = createPostgresRepositories(pool, {
        envelopeCrypto: new EnvelopeCrypto({
          primaryKeyId: "provider-activation",
          keys: { "provider-activation": Buffer.alloc(32, 0x4d) },
        }),
        idFactory: idFactory(),
        providerMutationMode: "fenced",
        tokenService: new TokenService({ pepper: Buffer.alloc(32, 0x5e) }),
      });
      const delayedProfile = "profile_activation_delayed";
      await createProfile(delayedProfile);
      const delayedFence = await repositories.providers.allocateMutationFence(delayedProfile);
      assert.equal(delayedFence, "1");

      const blockingProfile = "profile_activation_blocking";
      const queuedLegacyProfile = "profile_activation_queued";
      await createProfile(blockingProfile);
      await createProfile(queuedLegacyProfile);
      blocker = await pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(LEGACY_PROVIDER_COLLECTION_FIRST_INSERT_SQL, [
        blockingProfile,
        new Date(4000),
      ]);

      const pausePromise = pauseProviderMutations(
        new PostgresDatabase({ pool })
      );
      await waitForPendingProviderCollectionLock(adminPool, schema);

      competitor = await pool.connect();
      await competitor.query("BEGIN");
      const queuedLegacyRejection = assert.rejects(
        competitor.query(LEGACY_PROVIDER_COLLECTION_FIRST_INSERT_SQL, [
          queuedLegacyProfile,
          new Date(5000),
        ]),
        (error) =>
          error.code === "55000" &&
          error.message === "provider mutations are paused"
      );
      await blocker.query("COMMIT");
      blocker.release();
      blocker = null;

      assert.deepEqual(await pausePromise, {
        paused: true,
        changed: true,
      });
      await queuedLegacyRejection;
      await competitor.query("ROLLBACK");
      competitor.release();
      competitor = null;
      assert.deepEqual(await pauseProviderMutations({ pool }), {
        paused: true,
        changed: false,
      });
      assert.equal((await readProviderMutationProtocolState({ pool })).phase, "paused");
      assert.deepEqual(await activateProviderMutationProtocol({ pool }), {
        activated: true,
        mutationFence: "17",
        activationFence: "17",
      });
      assert.equal(
        (
          await pool.query(
            "SELECT COUNT(*)::integer AS count FROM provider_collections WHERE profile_id = $1",
            [queuedLegacyProfile]
          )
        ).rows[0].count,
        0
      );
      assert.deepEqual(await activateProviderMutationProtocol({ pool }), {
        activated: false,
        mutationFence: "17",
        activationFence: "17",
      });
      assert.deepEqual(await resumeProviderMutations({ pool }), {
        resumed: false,
        changed: false,
      });
      const activeState = await readProviderMutationProtocolState({ pool });
      assert.equal(activeState.installed, true);
      assert.equal(activeState.phase, "active");
      assert.equal(activeState.enforcementActive, true);
      assert.equal(activeState.mutationsPaused, false);
      assert.equal(activeState.activatedAt instanceof Date, true);
      assert.equal(activeState.pausedAt, null);
      assert.equal(activeState.activationFence, "17");
      assert.equal(activeState.allocatorFence, "17");

      await assert.rejects(
        () => repositories.providers.replaceAll(
          delayedProfile,
          [providerDescriptor("activation-delayed")],
          0,
          { mutationFence: delayedFence }
        ),
        (error) =>
          error.code === "55000" &&
          error.message === "provider mutation fence does not exceed the activation fence"
      );

      const markerPool = new Pool({
        connectionString: POSTGRES_URL,
        max: 1,
        options: "-c search_path=" + schema + ",public",
      });
      pools.push(markerPool);
      const modernProfile = "profile_activation_modern";
      const advanceProfile = "profile_activation_advance";
      await createProfile(modernProfile);
      await createProfile(advanceProfile);
      assert.deepEqual(
        await repositories.providers.replaceAll(
          modernProfile,
          [providerDescriptor("activation-first")],
          0,
          { mutationFence: "18" }
        ),
        { revision: 1, count: 1 }
      );
      assert.deepEqual(
        await repositories.providers.replaceAll(
          modernProfile,
          [providerDescriptor("activation-retry")],
          1,
          { mutationFence: "18" }
        ),
        { revision: 2, count: 1 }
      );
      assert.deepEqual(await repositories.providers.advanceMutationFence(advanceProfile, "20"), {
        revision: 0,
        mutationFence: "20",
      });
      await assert.rejects(
        () => repositories.providers.advanceMutationFence(advanceProfile, "19"),
        (error) => error.code === "provider_snapshot_stale_fence"
      );
      assert.deepEqual(await repositories.providers.advanceMutationFence(advanceProfile, "21"), {
        revision: 0,
        mutationFence: "21",
      });
      assert.deepEqual(
        (
          await markerPool.query(
            `SELECT
               NULLIF(current_setting('jumpgate.provider_mutation_protocol', true), '') AS protocol,
               NULLIF(current_setting('jumpgate.provider_mutation_fence', true), '') AS fence`
          )
        ).rows[0],
        { protocol: null, fence: null }
      );

      const snapshotQuery = `SELECT
         collections.revision::text AS revision,
         collections.mutation_fence::text AS mutation_fence,
         providers.id,
         providers.ordinal,
         providers.descriptor_envelope::text AS descriptor_envelope
       FROM provider_collections AS collections
       LEFT JOIN providers ON providers.profile_id = collections.profile_id
      WHERE collections.profile_id = $1
      ORDER BY providers.ordinal`;
      const beforeLegacyUpdate = providerRowsSnapshot(
        (await markerPool.query(snapshotQuery, [modernProfile])).rows
      );
      const rollbackClient = await markerPool.connect();
      try {
        await rollbackClient.query("BEGIN");
        await rollbackClient.query("DELETE FROM providers WHERE profile_id = $1", [modernProfile]);
        await assert.rejects(
          () => rollbackClient.query(LEGACY_PROVIDER_COLLECTION_UPDATE_SQL, [
            modernProfile,
            2,
            new Date(6000),
          ]),
          (error) =>
            error.code === "55000" &&
            error.message === "provider mutation protocol marker is required"
        );
        await rollbackClient.query("ROLLBACK");
      } finally {
        rollbackClient.release();
      }
      assert.equal(
        providerRowsSnapshot((await markerPool.query(snapshotQuery, [modernProfile])).rows).equals(
          beforeLegacyUpdate
        ),
        true
      );

      await pool.query("DELETE FROM profiles WHERE id = $1", [modernProfile]);
      assert.deepEqual(
        (
          await pool.query(
            `SELECT
               (SELECT COUNT(*)::integer FROM provider_collections WHERE profile_id = $1) AS collections,
               (SELECT COUNT(*)::integer FROM providers WHERE profile_id = $1) AS providers`,
            [modernProfile]
          )
        ).rows[0],
        { collections: 0, providers: 0 }
      );
    } finally {
      if (competitor) {
        await competitor.query("ROLLBACK").catch(() => {});
        competitor.release();
      }
      if (blocker) {
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
      }
      for (const pool of pools.reverse()) {
        await pool.end().catch(() => {});
      }
      for (const schema of schemas.reverse()) {
        await adminPool
          .query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE")
          .catch(() => {});
      }
      await adminPool.end().catch(() => {});
    }
  }
);

test(
  "real Redis and PostgreSQL recover provider snapshots without stale writes or revocation leaks",
  {
    skip:
      POSTGRES_URL && REDIS_URL
        ? false
        : "set TEST_POSTGRES_URL or DATABASE_URL together with REDIS_URL",
    timeout: 120000,
  },
  async (t) => {
    const adminPool = new Pool({ connectionString: POSTGRES_URL, max: 2 });
    const pools = [];
    const schemas = [];
    const prefix = "jg:v" + BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString();
    const client = createClient({ url: REDIS_URL });
    client.on("error", () => {});

    t.after(async () => {
      try {
        if (client.isOpen) await cleanRedisPrefix(client, prefix);
      } finally {
        if (client.isOpen) await client.quit();
        for (const currentPool of pools.reverse()) {
          await currentPool.end().catch(() => {});
        }
        for (const schema of schemas.reverse()) {
          await adminPool
            .query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE")
            .catch(() => {});
        }
        await adminPool.end().catch(() => {});
      }
    });

    const { pool } = await createIsolatedPool(adminPool, pools, schemas, "provider_recovery");
    await new PostgresMigrationRunner({ pool }).run();
    const repositories = createPostgresRepositories(pool, {
      envelopeCrypto: new EnvelopeCrypto({
        primaryKeyId: "mixed-postgres",
        keys: { "mixed-postgres": Buffer.alloc(32, 0x5b) },
      }),
      idFactory: idFactory(),
      providerMutationMode: "fenced",
      tokenService: new TokenService({ pepper: Buffer.alloc(32, 0x4a) }),
    });

    await client.connect();
    let generationSequence = 0;
    const playbackContexts = new RedisPlaybackContextRepository({
      client,
      keyspace: new RedisKeyspace(prefix),
      envelopeCrypto: new EnvelopeCrypto({
        primaryKeyId: "mixed-redis-postgres",
        keys: { "mixed-redis-postgres": Buffer.alloc(32, 0x6c) },
      }),
      generationFactory: () =>
        "g1:mixed_postgres_" + String(++generationSequence).padStart(8, "0"),
      sourceContextOptions: {
        idFactory: (kind) => kind + "_mixed_postgres_0001",
        // Recovery cases below force expiry explicitly; ordinary PostgreSQL round trips
        // must not race a scheduler-scale lease.
        providerMutationLeaseMs: 5_000,
      },
    });

    const preCommit = await repositories.profiles.create({ displayName: "Pre-commit" });
    const preCommitId = preCommit.profile.id;
    const preCommitToken = await playbackContexts.beginProviderSnapshotMutation(preCommitId);
    const preCommitFence = await playbackContexts.fenceProviderSnapshotMutation(
      preCommitId,
      preCommitToken,
      await repositories.providers.allocateMutationFence(preCommitId)
    );
    await client.hSet(
      playbackContexts._providerSnapshotStateKey(preCommitId),
      "expiresAtMs",
      "0"
    );
    const recoveredReads = await Promise.all(
      Array.from({ length: 4 }, () =>
        readProviderCollectionSnapshot(repositories.providers, playbackContexts, preCommitId)
      )
    );
    assert.equal(new Set(recoveredReads.map((item) => item.generation)).size, 1);
    assert.deepEqual(
      recoveredReads.map((item) => item.collection),
      Array.from({ length: 4 }, () => ({ revision: 0, providers: [] }))
    );
    await assert.rejects(
      repositories.providers.replaceAll(preCommitId, [providerDescriptor("stale")], 0, {
        mutationFence: preCommitFence.fence,
      }),
      (error) => error.code === "provider_snapshot_stale_fence"
    );
    await assert.rejects(
      playbackContexts.completeProviderSnapshotMutation(preCommitId, preCommitToken),
      (error) => error.code === "provider_snapshot_changed"
    );

    const clearToken = await playbackContexts.beginProviderSnapshotMutation(preCommitId);
    await playbackContexts.fenceProviderSnapshotMutation(
      preCommitId,
      clearToken,
      await repositories.providers.allocateMutationFence(preCommitId)
    );
    await client.hSet(
      playbackContexts._providerSnapshotStateKey(preCommitId),
      "expiresAtMs",
      "0"
    );
    const clearedGeneration = await invalidateProviderSnapshot(
      playbackContexts,
      repositories.providers,
      preCommitId
    );
    assert.deepEqual(await playbackContexts.getProviderSnapshotState(preCommitId), {
      generation: clearedGeneration,
      pending: false,
    });

    const postCommit = await repositories.profiles.create({ displayName: "Post-commit" });
    const postCommitId = postCommit.profile.id;
    const committedDescriptor = providerDescriptor("committed");
    const postCommitToken = await playbackContexts.beginProviderSnapshotMutation(postCommitId);
    const postCommitFence = await playbackContexts.fenceProviderSnapshotMutation(
      postCommitId,
      postCommitToken,
      await repositories.providers.allocateMutationFence(postCommitId)
    );
    await repositories.providers.replaceAll(postCommitId, [committedDescriptor], 0, {
      mutationFence: postCommitFence.fence,
    });
    await client.hSet(
      playbackContexts._providerSnapshotStateKey(postCommitId),
      "expiresAtMs",
      "0"
    );
    const postCommitReads = await Promise.all(
      Array.from({ length: 4 }, () =>
        readProviderCollectionSnapshot(repositories.providers, playbackContexts, postCommitId)
      )
    );
    for (const snapshot of postCommitReads) {
      assert.equal(snapshot.collection.revision, 1);
      assert.deepEqual(
        snapshot.collection.providers.map((item) => item.descriptor),
        [committedDescriptor]
      );
    }
    await assert.rejects(
      playbackContexts.completeProviderSnapshotMutation(postCommitId, postCommitToken),
      (error) => error.code === "provider_snapshot_changed"
    );

    const reset = await repositories.profiles.create({ displayName: "Redis reset" });
    const resetId = reset.profile.id;
    await repositories.providers.advanceMutationFence(resetId, "100");
    const oldToken = await playbackContexts.beginProviderSnapshotMutation(resetId);
    const oldFence = await playbackContexts.fenceProviderSnapshotMutation(
      resetId,
      oldToken,
      await repositories.providers.allocateMutationFence(resetId)
    );
    assert.equal(oldFence.fence, "101");
    assert.equal(
      await client.sendCommand([
        "DEL",
        playbackContexts._generationKey(resetId),
        playbackContexts._providerSnapshotStateKey(resetId),
        playbackContexts._providerSnapshotFenceKey(resetId),
      ]),
      3
    );
    assert.deepEqual(
      await replaceProviderCollection(
        repositories.providers,
        playbackContexts,
        resetId,
        [providerDescriptor("after-reset")],
        0
      ),
      { revision: 1, count: 1 }
    );
    assert.equal(
      (
        await pool.query(
          "SELECT mutation_fence::text AS mutation_fence FROM provider_collections " +
            "WHERE profile_id = $1",
          [resetId]
        )
      ).rows[0].mutation_fence,
      "102"
    );
    await assert.rejects(
      repositories.providers.replaceAll(resetId, [providerDescriptor("old-writer")], 0, {
        mutationFence: oldFence.fence,
      }),
      (error) => error.code === "provider_snapshot_stale_fence"
    );

    const revoked = await repositories.profiles.create({ displayName: "Revoked" });
    const revokedId = revoked.profile.id;
    const revokedToken = await playbackContexts.beginProviderSnapshotMutation(revokedId);
    const revokedFence = await playbackContexts.fenceProviderSnapshotMutation(
      revokedId,
      revokedToken,
      await repositories.providers.allocateMutationFence(revokedId)
    );
    await repositories.providers.replaceAll(revokedId, [providerDescriptor("revoked")], 0, {
      mutationFence: revokedFence.fence,
    });
    assert.equal(await repositories.profiles.revoke(revokedId, revoked.profile.revision), true);
    await client.hSet(
      playbackContexts._providerSnapshotStateKey(revokedId),
      "expiresAtMs",
      "0"
    );
    const revokedReads = await Promise.all(
      Array.from({ length: 4 }, () =>
        readProviderCollectionSnapshot(repositories.providers, playbackContexts, revokedId)
      )
    );
    assert.deepEqual(
      revokedReads.map((item) => item.collection),
      Array.from({ length: 4 }, () => ({ revision: 0, providers: [] }))
    );
    assert.deepEqual(await playbackContexts.getProviderSnapshotState(revokedId), {
      generation: revokedReads[0].generation,
      pending: false,
    });
    await assert.rejects(
      playbackContexts.completeProviderSnapshotMutation(revokedId, revokedToken),
      (error) => error.code === "provider_snapshot_changed"
    );
  }
);

test(
  "real PostgreSQL and Redis fence lifecycle races, recover invalidations, and erase generations",
  {
    skip:
      POSTGRES_URL && REDIS_URL
        ? false
        : "set TEST_POSTGRES_URL or DATABASE_URL together with REDIS_URL",
    timeout: 120000,
  },
  async (t) => {
    const adminPool = new Pool({ connectionString: POSTGRES_URL, max: 2 });
    const pools = [];
    const schemas = [];
    const prefix = "jg:v" + BigInt("0x" + crypto.randomBytes(16).toString("hex")).toString();
    const client = createClient({ url: REDIS_URL });
    client.on("error", () => {});

    t.after(async () => {
      try {
        if (client.isOpen) await cleanRedisPrefix(client, prefix);
      } finally {
        if (client.isOpen) await client.quit();
        for (const currentPool of pools.reverse()) {
          await currentPool.end().catch(() => {});
        }
        for (const schema of schemas.reverse()) {
          await adminPool
            .query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE")
            .catch(() => {});
        }
        await adminPool.end().catch(() => {});
      }
    });

    const { pool } = await createIsolatedPool(adminPool, pools, schemas, "lifecycle_security");
    await new PostgresMigrationRunner({ pool }).run();
    const database = new PostgresDatabase({ pool });
    let observeRevocationLock = false;
    let revocationLockEntered;
    const revocationLockAttempted = new Promise((resolve) => {
      revocationLockEntered = resolve;
    });
    let revokedProfileId = null;
    const instrumentedDatabase = {
      query: database.query.bind(database),
      transaction(work) {
        return database.transaction((transaction) =>
          work({
            async query(text, values) {
              if (
                observeRevocationLock &&
                /SELECT id, status, revision FROM profiles WHERE id = \$1 FOR UPDATE/.test(text) &&
                values[0] === revokedProfileId
              ) {
                observeRevocationLock = false;
                revocationLockEntered();
              }
              return transaction.query(text, values);
            },
          })
        );
      },
    };
    let now = Date.now();
    const repositories = createPostgresRepositories(instrumentedDatabase, {
      clock: () => now,
      envelopeCrypto: new EnvelopeCrypto({
        primaryKeyId: "lifecycle-postgres",
        keys: { "lifecycle-postgres": Buffer.alloc(32, 0x73) },
      }),
      idFactory: idFactory(),
      tokenService: new TokenService({ pepper: Buffer.alloc(32, 0x74) }),
    });

    await client.connect();
    const keyspace = new RedisKeyspace(prefix);
    const deviceGenerationTtlMs = 60 * 1000;
    const playbackContexts = new RedisPlaybackContextRepository({
      client,
      keyspace,
      envelopeCrypto: new EnvelopeCrypto({
        primaryKeyId: "lifecycle-redis",
        keys: { "lifecycle-redis": Buffer.alloc(32, 0x75) },
      }),
      sourceContextOptions: {
        idFactory: idFactory(),
        ttlMs: 60 * 1000,
        deviceGenerationTtlMs,
      },
    });
    const managementSessions = new RedisManagementSessionRepository({
      client,
      keyspace,
      tokenService: new TokenService({ pepper: Buffer.alloc(32, 0x76) }),
      isProfileActive: async (profileId) => {
        const profile = await repositories.profiles.getById(profileId);
        return Boolean(profile && profile.status === "active");
      },
    });

    const revokedProfile = await repositories.profiles.create({ displayName: "Revoked profile" });
    const isolatedProfile = await repositories.profiles.create({ displayName: "Isolated profile" });
    revokedProfileId = revokedProfile.profile.id;
    const revokedDevice = await repositories.devices.register(revokedProfileId, {
      displayName: "Revoked Kodi",
    });
    const isolatedDevice = await repositories.devices.register(isolatedProfile.profile.id, {
      displayName: "Isolated Kodi",
    });
    const revokedGeneration = await playbackContexts.getProfileGeneration(revokedProfileId);
    const isolatedGeneration = await playbackContexts.getProfileGeneration(isolatedProfile.profile.id);
    const revokedUrl = "https://cdn.example/lifecycle-revoked.mkv";
    const isolatedUrl = "https://cdn.example/lifecycle-isolated.mkv";
    await playbackContexts.record(
      revokedProfileId,
      lifecyclePlaybackContext(revokedUrl, "tt7000101"),
      { generation: revokedGeneration, providerRevision: "1" }
    );
    await playbackContexts.record(
      isolatedProfile.profile.id,
      lifecyclePlaybackContext(isolatedUrl, "tt7000102"),
      { generation: isolatedGeneration, providerRevision: "1" }
    );

    let enterClaim;
    let releaseClaim;
    const claimEntered = new Promise((resolve) => {
      enterClaim = resolve;
    });
    const claimRelease = new Promise((resolve) => {
      releaseClaim = resolve;
    });
    let gateRevokedClaim = true;
    let gatedClaimResult = null;
    let claimCalls = 0;
    let playbackInvalidations = 0;
    let finishPlaybackInvalidation;
    const playbackInvalidated = new Promise((resolve) => {
      finishPlaybackInvalidation = resolve;
    });
    const lifecyclePlayback = {
      async claim(...args) {
        claimCalls += 1;
        const result = await playbackContexts.claim(...args);
        if (args[0] === revokedProfileId && gateRevokedClaim) {
          gateRevokedClaim = false;
          gatedClaimResult = result;
          enterClaim();
          await claimRelease;
        }
        return result;
      },
      async release(...args) {
        return playbackContexts.release(...args);
      },
      async invalidateDevice(...args) {
        playbackInvalidations += 1;
        const result = await playbackContexts.invalidateDevice(...args);
        finishPlaybackInvalidation();
        return result;
      },
    };
    let subtitleInvalidations = 0;
    const subtitleDeliveries = {
      async invalidateDevice(profileId, deviceId) {
        assert.equal(profileId, revokedProfileId);
        assert.equal(deviceId, revokedDevice.device.id);
        subtitleInvalidations += 1;
        await playbackInvalidated;
        if (subtitleInvalidations === 1) {
          throw new Error("controlled live subtitle invalidation failure");
        }
      },
    };
    const lifecycle = new ProfileLifecycleService({
      profiles: repositories.profiles,
      devices: repositories.devices,
      lifecycleInvalidations: repositories.lifecycleInvalidations,
      managementSessions,
      subtitleManifests: repositories.subtitleManifests,
      providerGateway: {
        clearProfile: (profileId) => playbackContexts.invalidateProfile(profileId),
      },
      playbackContexts: lifecyclePlayback,
      subtitleDeliveries,
      clock: () => now,
      retryBaseMs: 10,
      retryMaxMs: 100,
    });
    const revokedBinding = {
      profileId: revokedProfileId,
      profileRevision: revokedProfile.profile.revision,
      deviceId: revokedDevice.device.id,
      deviceGeneration: revokedDevice.device.generation,
      playbackGeneration: revokedGeneration,
    };
    const isolatedBinding = {
      profileId: isolatedProfile.profile.id,
      profileRevision: isolatedProfile.profile.revision,
      deviceId: isolatedDevice.device.id,
      deviceGeneration: isolatedDevice.device.generation,
      playbackGeneration: isolatedGeneration,
    };

    const isolatedClaimInput = lifecycleClaimInput(
      isolatedUrl,
      "history_session_isolated_live_0001"
    );
    const revokedClaimInput = lifecycleClaimInput(
      revokedUrl,
      "history_session_revoked_live_0001"
    );
    const isolatedClaim = await lifecycle.claim(
      isolatedBinding,
      isolatedClaimInput.request,
      isolatedClaimInput.options
    );
    assert.equal(isolatedClaim.status, "claimed");
    const racingClaimPromise = lifecycle.claim(
      revokedBinding,
      revokedClaimInput.request,
      revokedClaimInput.options
    );
    await claimEntered;
    observeRevocationLock = true;
    const revocation = lifecycle.revokeDevice(revokedProfileId, revokedDevice.device.id);
    await revocationLockAttempted;
    await assert.rejects(
      revocation,
      /controlled live subtitle invalidation failure/
    );
    assert.equal(
      await repositories.devices.getGeneration(revokedProfileId, revokedDevice.device.id),
      2
    );
    releaseClaim();
    await assert.rejects(
      racingClaimPromise,
      (error) => error.code === "device_generation_changed"
    );

    assert.equal(await repositories.devices.authenticate(revokedDevice.deviceToken), null);
    assert.equal(
      await repositories.devices.getGeneration(revokedProfileId, revokedDevice.device.id),
      2
    );
    const pending = await repositories.lifecycleInvalidations.getPending(
      "device",
      revokedProfileId,
      revokedDevice.device.id
    );
    assert.equal(pending.attemptCount, 1);
    assert.equal(pending.deviceGeneration, 2);
    assert.equal(
      await client.get(
        playbackContexts._deviceGenerationKey(revokedProfileId, revokedDevice.device.id)
      ),
      "2"
    );
    assert.equal(
      await playbackContexts.getActiveClaim(
        revokedProfileId,
        revokedDevice.device.id,
        gatedClaimResult.sessionId
      ),
      null
    );

    const callsBeforeStaleClaim = claimCalls;
    await assert.rejects(
      lifecycle.claim(
        revokedBinding,
        revokedClaimInput.request,
        revokedClaimInput.options
      ),
      (error) => error.code === "device_generation_changed"
    );
    assert.equal(claimCalls, callsBeforeStaleClaim);
    now += 10;
    assert.deepEqual(await lifecycle.resumeInvalidations(8), {
      processed: 1,
      completed: 1,
      failed: 0,
    });
    assert.equal(playbackInvalidations, 2);
    assert.equal(subtitleInvalidations, 2);
    assert.equal(
      await repositories.lifecycleInvalidations.getPending(
        "device",
        revokedProfileId,
        revokedDevice.device.id
      ),
      null
    );
    assert.deepEqual(await lifecycle.resumeInvalidations(8), {
      processed: 0,
      completed: 0,
      failed: 0,
    });

    assert.notEqual(
      await playbackContexts.getActiveClaim(
        isolatedProfile.profile.id,
        isolatedDevice.device.id,
        isolatedClaim.sessionId
      ),
      null
    );
    const erased = await lifecycle.requestErasure(revokedProfileId);
    assert.equal(erased.status, "deleted");
    const revokedDeviceGenerationKey = playbackContexts._deviceGenerationKey(
      revokedProfileId,
      revokedDevice.device.id
    );
    assert.equal(await client.get(revokedDeviceGenerationKey), "2");
    const retainedGenerationTtlMs = await client.pTTL(revokedDeviceGenerationKey);
    assert.ok(retainedGenerationTtlMs > 0);
    assert.ok(retainedGenerationTtlMs <= deviceGenerationTtlMs);
    assert.equal(
      await client.exists(playbackContexts._deviceGenerationIndexKey(revokedProfileId)),
      0
    );
    assert.equal(
      await client.get(
        playbackContexts._deviceGenerationKey(
          isolatedProfile.profile.id,
          isolatedDevice.device.id
        )
      ),
      "1"
    );
    assert.notEqual(
      await playbackContexts.getActiveClaim(
        isolatedProfile.profile.id,
        isolatedDevice.device.id,
        isolatedClaim.sessionId
      ),
      null
    );
    assert.notEqual(await repositories.devices.authenticate(isolatedDevice.deviceToken), null);
    assert.equal(
      await repositories.lifecycleInvalidations.getPending("profile", revokedProfileId),
      null
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT
             (SELECT COUNT(*)::integer FROM devices WHERE profile_id = $1) AS devices,
             (SELECT COUNT(*)::integer FROM lifecycle_invalidations WHERE profile_id = $1)
               AS invalidations`,
          [revokedProfileId]
        )
      ).rows[0],
      { devices: 0, invalidations: 0 }
    );
  }
);
