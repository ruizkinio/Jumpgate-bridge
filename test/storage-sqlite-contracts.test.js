"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const { EnvelopeCrypto } = require("../lib/storage/envelope-crypto");
const { assertRepository } = require("../lib/storage/contracts");
const { TokenService } = require("../lib/storage/token-service");
const {
  configureSqliteDatabase,
  createSqliteRepositories,
  readSqliteMigrations,
  runSqliteMigrations,
  withImmediateTransaction,
} = require("../lib/storage/sqlite");
const {
  MAX_BACKUP_ENVELOPE_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
  MAX_JSON_SNAPSHOT_BYTES,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
} = require("../lib/storage/sqlite/helpers");

let Database = null;
try {
  Database = require("better-sqlite3");
} catch (_error) {
  // Integration tests are conditionally skipped when the optional native driver is absent.
}

const PROFILE_A = "profile_sqlite_a";
const PROFILE_B = "profile_sqlite_b";

function sqliteTest(name, callback) {
  test(name, { skip: Database ? false : "better-sqlite3 is not installed" }, callback);
}

function sequenceRandom(seed = 1) {
  let next = seed;
  return (length) => {
    const output = Buffer.alloc(length, next);
    next = next === 255 ? 1 : next + 1;
    return output;
  };
}

function primitives(seed = 1, options = {}) {
  const keyId = options.keyId || "sqlite-key";
  return {
    tokenService: new TokenService({
      pepper: Buffer.alloc(32, 0x6a),
      randomBytes: sequenceRandom(seed),
    }),
    envelopeCrypto: new EnvelopeCrypto({
      primaryKeyId: keyId,
      keys: { [keyId]: Buffer.alloc(32, 0x4d) },
      randomBytes: sequenceRandom(0x30),
    }),
  };
}

function ids() {
  const counters = new Map();
  return (kind) => {
    const next = (counters.get(kind) || 0) + 1;
    counters.set(kind, next);
    return kind + "_" + String(next).padStart(8, "0");
  };
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-sqlite-"));
  const filename = path.join(directory, "storage.sqlite3");
  const database = new Database(filename);
  const now = options.now || { value: 1000 };
  const repositories = createSqliteRepositories(database, {
    ...primitives(options.seed, { keyId: options.keyId }),
    clock: () => now.value,
    idFactory: ids(),
    busyTimeoutMs: options.busyTimeoutMs || 2500,
    deviceTtlMs: 1000,
    deviceTouchIntervalMs: 100,
    maxDevicesPerProfile: 2,
    maxBackupsPerProfile: 4,
  });
  t.after(() => {
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { database, directory, filename, now, repositories };
}

function historyEntry(contentKey, lastPlayedAt, overrides = {}) {
  return {
    contentKey,
    canonicalIdentity: { provider: "imdb", id: "tt0133093", mediaType: "movie" },
    displaySnapshot: { title: "The Matrix" },
    playbackSnapshot: { providerId: "provider_00000001", subtitleLanguages: ["en"] },
    positionMs: 120000,
    durationMs: 8160000,
    watchedMs: 120000,
    completed: false,
    lastPlayedAt,
    ...overrides,
  };
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

function jsonTextWithExactBytes(byteLength) {
  const prefix = '{"padding":"';
  const suffix = '"}';
  assert.ok(prefix.length + suffix.length <= byteLength);
  const json = prefix + "x".repeat(byteLength - prefix.length - suffix.length) + suffix;
  assert.equal(Buffer.byteLength(json, "utf8"), byteLength);
  return json;
}

test("SQLite appends durable subtitle manifest deletion state at 0006", () => {
  const migrations = readSqliteMigrations();
  const manifest = migrations.find(
    (migration) => migration.version === "0006_durable_subtitle_manifests"
  );
  assert.ok(manifest);
  assert.match(manifest.sql, /CREATE TABLE subtitle_object_manifests/);
  assert.match(manifest.sql, /CREATE TABLE subtitle_object_manifest_parts/);
  assert.match(manifest.sql, /upload_settlement_deadline/);
  assert.match(manifest.sql, /lease_token_hash/);
  assert.match(manifest.sql, /subtitle_object_manifests_eligible_idx/);
});

test("SQLite appends generation-bound playback sessions and scrobble outbox at 0007", () => {
  const migrations = readSqliteMigrations();
  const playback = migrations.find(
    (migration) => migration.version === "0007_scrobble_dispatch"
  );
  assert.ok(playback);
  assert.match(playback.sql, /CREATE TABLE playback_source_revocations/);
  assert.match(playback.sql, /CREATE TABLE playback_sessions/);
  assert.match(playback.sql, /CREATE TABLE scrobble_dispatches/);
  assert.match(playback.sql, /status IN \('queued', 'leased', 'delivered', 'revoked'\)/);
  assert.match(playback.sql, /lease_token_hash TEXT/);
  assert.match(playback.sql, /scrobble_dispatches_claim_idx/);
});

test("SQLite 0008 purges caller-selected history without rewinding history identity", () => {
  const migrations = readSqliteMigrations();
  const historyGrant = migrations.find(
    (migration) => migration.version === "0008_claim_bound_history"
  );
  assert.ok(historyGrant);
  assert.match(
    historyGrant.sql,
    /DELETE FROM scrobble_dispatches;\s+DELETE FROM playback_sessions;\s+DELETE FROM playback_source_revocations;\s+DELETE FROM cloud_history;/
  );
  assert.doesNotMatch(historyGrant.sql, /UPDATE history_sequence SET value = 0/);
  assert.match(historyGrant.sql, /CREATE TABLE history_grant_revocations/);
  assert.match(historyGrant.sql, /CREATE TABLE history_grants/);
  assert.match(historyGrant.sql, /CREATE TABLE history_event_receipts/);
  assert.match(historyGrant.sql, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(historyGrant.sql, /token_envelope TEXT NOT NULL/);
  assert.match(historyGrant.sql, /\[1-8\]\?\?\?/);
  assert.match(
    historyGrant.sql,
    /FOREIGN KEY \(grant_id, terminal_receipt_id\)[\s\S]*DEFERRABLE INITIALLY DEFERRED/
  );
  assert.doesNotMatch(historyGrant.sql, /grant_token|history_grant_token/);
  assert.doesNotMatch(historyGrant.sql, /INSERT INTO history_grants[\s\S]+SELECT/i);
});

test("SQLite 0009 requires explicit history generations on scrobble dispatches", () => {
  const migrations = readSqliteMigrations();
  const dispatchFence = migrations.find(
    (migration) => migration.version === "0009_dispatch_history_generation"
  );
  assert.ok(dispatchFence);
  assert.match(dispatchFence.sql, /DELETE FROM scrobble_dispatches/);
  assert.match(
    dispatchFence.sql,
    /history_generation INTEGER NOT NULL CHECK \([\s\S]*BETWEEN 1 AND 9007199254740991/
  );
  assert.match(
    dispatchFence.sql,
    /ON scrobble_dispatches \(profile_id, history_generation, status\)/
  );
  assert.doesNotMatch(dispatchFence.sql, /^\s*history_generation\b[^\r\n]*\bDEFAULT\b/im);
});

function readSqliteMigrationSource(source) {
  return readSqliteMigrations({
    directory: path.join(os.tmpdir(), "virtual-sqlite-migrations"),
    fs: {
      readFileSync() {
        return Buffer.from(source, "utf8");
      },
      readdirSync() {
        return ["0001_example.sql"];
      },
    },
  });
}

function invalidJsonPayloads() {
  const cyclic = {};
  cyclic.self = cyclic;
  return [
    { label: "NUL", pattern: /NUL/, value: "bad\u0000value" },
    { label: "lone surrogate", pattern: /lone UTF-16 surrogate/, value: "\ud800" },
    { label: "unsafe integer", pattern: /unsafe integer/, value: Number.MAX_SAFE_INTEGER + 1 },
    { label: "cycle", pattern: /cycle/, value: cyclic },
    { label: "non-plain object", pattern: /non-plain object/, value: new Set() },
    { label: "sparse array", pattern: /unsupported array/, value: new Array(1) },
    { label: "unsupported value", pattern: /unsupported value/, value: undefined },
  ];
}

test("SQLite module import does not load better-sqlite3", () => {
  const modulePath = path.join(__dirname, "..", "lib", "storage", "sqlite");
  const source = `
    const Module = require("node:module");
    const original = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === "better-sqlite3") throw new Error("native driver loaded during import");
      return original.call(this, request, parent, isMain);
    };
    require(${JSON.stringify(modulePath)});
  `;
  const result = spawnSync(process.execPath, ["-e", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("nested SQLite transactions use distinct rollback-and-release savepoints", () => {
  const calls = [];
  const database = {
    inTransaction: true,
    exec(sql) {
      calls.push(sql);
    },
    pragma() {},
    prepare() {},
  };

  for (const message of ["first failure", "second failure"]) {
    assert.throws(
      () => withImmediateTransaction(database, () => {
        throw new Error(message);
      }),
      new RegExp(message)
    );
  }

  const savepoints = calls
    .filter((sql) => sql.startsWith("SAVEPOINT "))
    .map((sql) => sql.slice("SAVEPOINT ".length));
  assert.equal(savepoints.length, 2);
  assert.notEqual(savepoints[0], savepoints[1]);
  assert.deepEqual(calls, savepoints.flatMap((savepoint) => [
    "SAVEPOINT " + savepoint,
    "ROLLBACK TO SAVEPOINT " + savepoint,
    "RELEASE SAVEPOINT " + savepoint,
  ]));
});

sqliteTest("SQLite filename factory lazily opens and owns a persistent database", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-owned-sqlite-"));
  const filename = path.join(directory, "owned.sqlite3");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const repositories = createSqliteRepositories({
    filename,
    ...primitives(90),
    clock: () => 1000,
    idFactory: ids(),
  });
  assert.equal(repositories.ownsDatabase, true);
  const created = await repositories.profiles.create({ displayName: "Persistent" });
  repositories.close();

  const reopened = new Database(filename, { readonly: true });
  const row = reopened.prepare("SELECT display_name FROM profiles WHERE id = ?").get(created.profile.id);
  reopened.close();
  assert.equal(row.display_name, "Persistent");
});

sqliteTest("SQLite factory configures pragmas and applies immutable checksum migrations", (t) => {
  const { database, repositories } = fixture(t, { busyTimeoutMs: 4321 });

  assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(database.pragma("busy_timeout", { simple: true }), 4321);
  assert.deepEqual(database.pragma("foreign_key_check"), []);
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  const migrations = database
    .prepare("SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version")
    .all();
  assert.deepEqual(
    migrations.map((row) => row.version),
    [
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
    ]
  );
  for (const migration of migrations) {
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    assert.equal(Number.isSafeInteger(migration.applied_at), true);
  }

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
  const providerCollectionSql = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_collections'")
    .get().sql;
  assert.match(providerCollectionSql, /mutation_fence TEXT NOT NULL DEFAULT '0'/);
  assert.match(providerCollectionSql, /length\(mutation_fence\) BETWEEN 1 AND 128/);
  assert.match(providerCollectionSql, /mutation_fence NOT GLOB '\*\[\^0-9\]\*'/);
  const providerCounterSql = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' " +
      "AND name = 'provider_mutation_fence_counter'"
    )
    .get().sql;
  assert.match(providerCounterSql, /singleton_id INTEGER PRIMARY KEY CHECK \(singleton_id = 1\)/);
  assert.match(providerCounterSql, /length\(mutation_fence\) BETWEEN 1 AND 128/);
  assert.deepEqual(
    database.prepare("SELECT * FROM provider_mutation_fence_counter").all(),
    [{ singleton_id: 1, mutation_fence: "0" }]
  );
  const devicesSql = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'devices'")
    .get().sql;
  assert.match(devicesSql, /generation INTEGER NOT NULL DEFAULT 1/);
  assert.match(devicesSql, /generation BETWEEN 1 AND 9007199254740991/);
});

sqliteTest("SQLite migration runner rejects changed bytes for an applied migration", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-migrations-"));
  const migrationsPath = path.join(directory, "migrations");
  const filename = path.join(directory, "checksum.sqlite3");
  fs.cpSync(path.join(__dirname, "..", "migrations", "sqlite"), migrationsPath, {
    recursive: true,
  });
  const database = new Database(filename);
  t.after(() => {
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  configureSqliteDatabase(database);
  runSqliteMigrations(database, { migrationsPath, clock: () => 1000 });
  fs.appendFileSync(path.join(migrationsPath, "0001_initial.sql"), "\n-- changed\n");
  assert.throws(
    () => runSqliteMigrations(database, { migrationsPath, clock: () => 2000 }),
    (error) => error.code === "migration_checksum_mismatch"
  );
  database
    .prepare("DELETE FROM schema_migrations WHERE version = '0001_initial'")
    .run();
  assert.throws(
    () => runSqliteMigrations(database, { migrationsPath, clock: () => 2000 }),
    (error) => error.code === "migration_history_invalid"
  );
});

test("SQLite migration validation finds controls only at lexical statement boundaries", () => {
  const safeSql = [
    "CREATE TABLE example (value TEXT);",
    "INSERT INTO example (value) VALUES ('COMMIT; END; ROLLBACK');",
    "-- SAVEPOINT ignored_comment;",
    "/* BEGIN; SAVEPOINT ignored_block_comment; END; */",
    'SELECT "COMMIT", `END`, [ROLLBACK] FROM example;',
    "",
  ].join("\n");
  assert.equal(readSqliteMigrationSource(safeSql).length, 1);

  for (const source of [
    "SELECT 'COMMIT'; COMMIT;\n",
    "SELECT 1; /* boundary */ END;\n",
    "-- leading comment\nROLLBACK;\n",
    "SELECT 'SAVEPOINT in a string';\nSAVEPOINT nested;\n",
    "SELECT 1; RELEASE SAVEPOINT nested;\n",
    "SELECT 1; /* first terminator /* text */ COMMIT;\n",
  ]) {
    assert.throws(
      () => readSqliteMigrationSource(source),
      (error) => error.code === "migration_transaction_control"
    );
  }
});

sqliteTest("SQLite migration batches roll back every prior statement and history row", (t) => {
  const database = new Database(":memory:");
  t.after(() => database.close());
  configureSqliteDatabase(database);
  const sources = new Map([
    ["0001_first.sql", Buffer.from("CREATE TABLE first_step (id INTEGER);\n", "utf8")],
    [
      "0002_failing.sql",
      Buffer.from(
        "CREATE TABLE leaked_step (id INTEGER);\nSELECT * FROM missing_relation;\n",
        "utf8"
      ),
    ],
  ]);

  assert.throws(
    () => runSqliteMigrations(database, {
      fs: {
        readFileSync(filename) {
          return sources.get(path.basename(filename));
        },
        readdirSync() {
          return [...sources.keys()];
        },
      },
      migrationsPath: path.join(os.tmpdir(), "virtual-atomic-sqlite-migrations"),
    }),
    /missing_relation/
  );
  assert.equal(database.inTransaction, false);
  assert.deepEqual(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all(),
    []
  );
});

sqliteTest("SQLite migration lock waits honor and restore the explicit timeout", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-sqlite-lock-"));
  const filename = path.join(directory, "locked.sqlite3");
  const holder = new Database(filename);
  const contender = new Database(filename);
  t.after(() => {
    if (holder.inTransaction) holder.exec("ROLLBACK");
    if (contender.open) contender.close();
    if (holder.open) holder.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  configureSqliteDatabase(holder, { busyTimeoutMs: 1000 });
  configureSqliteDatabase(contender, { busyTimeoutMs: 2500 });
  runSqliteMigrations(holder);
  holder.exec("BEGIN IMMEDIATE");

  const startedAt = Date.now();
  assert.throws(
    () => runSqliteMigrations(contender, { migrationBusyTimeoutMs: 25 }),
    (error) => error.code === "SQLITE_BUSY"
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 1000, "migration lock wait exceeded its bounded timeout");
  assert.equal(contender.pragma("busy_timeout", { simple: true }), 2500);
  assert.throws(
    () => runSqliteMigrations(contender, { migrationBusyTimeoutMs: 0 }),
    /migrationBusyTimeoutMs is invalid/
  );

  holder.exec("ROLLBACK");
  assert.doesNotThrow(() => runSqliteMigrations(contender, { migrationBusyTimeoutMs: 25 }));
});

sqliteTest("SQLite migration deadline rolls back synchronous work before commit", (t) => {
  const database = new Database(":memory:");
  t.after(() => database.close());
  let now = 0;
  database.function("expire_migration_budget", () => {
    now = 20;
    return 1;
  });
  const migrationFs = {
    readdirSync() {
      return ["0001_expire.sql"];
    },
    readFileSync() {
      return Buffer.from(
        "CREATE TABLE migration_should_rollback (id INTEGER);\n" +
          "SELECT expire_migration_budget();\n",
        "utf8"
      );
    },
  };

  assert.throws(
    () =>
      runSqliteMigrations(database, {
        fs: migrationFs,
        migrationDeadlineMs: 10,
        migrationTimeoutMs: 10,
        migrationNow: () => now,
      }),
    (error) => error.code === "storage_timeout" && error.phase === "SQLite migration"
  );
  assert.equal(database.inTransaction, false);
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE name IN " +
          "('migration_should_rollback', 'schema_migrations')"
      )
      .get().count,
    0
  );
});

sqliteTest("SQLite repositories enforce the strict JSON persistence domain", async (t) => {
  const { database, repositories } = fixture(t, { seed: 19 });
  const created = await repositories.profiles.create({ displayName: "JSON profile" });

  for (const invalid of invalidJsonPayloads()) {
    await assert.rejects(
      repositories.oauthCredentials.put(
        created.profile.id,
        "realdebrid",
        { payload: invalid.value },
        0
      ),
      invalid.pattern,
      invalid.label
    );
  }
  assert.equal(database.prepare("SELECT count(*) AS count FROM oauth_credentials").get().count, 0);

  const accepted = {
    emoji: "\ud83d\ude00",
    fraction: 1.25,
    nested: [null, true, { value: "ok" }],
  };
  await repositories.oauthCredentials.put(created.profile.id, "realdebrid", accepted, 0);
  assert.deepEqual(
    (await repositories.oauthCredentials.get(created.profile.id, "realdebrid")).credentials,
    accepted
  );
});

sqliteTest("SQLite durable repositories preserve memory semantics and encrypted storage", async (t) => {
  const { database, now, repositories } = fixture(t);
  const created = await repositories.profiles.create({
    displayName: " Living room ",
    legacyConfigHash: "a".repeat(64),
  });
  const profileId = created.profile.id;

  assert.match(profileId, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(created.profile.displayName, "Living room");
  assert.equal(await repositories.legacyConfigAliases.getProfileId("a".repeat(64)), profileId);
  const profileRow = database.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId);
  assert.notEqual(profileRow.install_token_hash, created.installToken);
  assert.match(profileRow.install_token_hash, /^[a-f0-9]{64}$/);
  assert.equal(typeof profileRow.created_at, "number");

  now.value = 2000;
  const updated = await repositories.profiles.update(profileId, { displayName: "Bedroom" }, 1);
  assert.equal(updated.revision, 2);
  await assert.rejects(
    () => repositories.profiles.update(profileId, { displayName: "stale" }, 1),
    (error) => error.code === "revision_conflict"
  );

  const suppliedDeviceToken = "A".repeat(43);
  const deviceInput = {
    pairingId: "pairing_sqlite_0001",
    deviceToken: suppliedDeviceToken,
    displayName: "Kodi TV",
  };
  const device = await repositories.devices.register(profileId, deviceInput);
  assert.deepEqual(await repositories.devices.register(profileId, deviceInput), device);
  assert.equal(
    database.prepare("SELECT token_hash FROM devices WHERE id = ?").get(device.device.id).token_hash ===
      suppliedDeviceToken,
    false
  );

  const descriptors = [
    {
      transportUrl: "https://provider.example/manifest.json?token=private",
      manifest: { id: "provider.example" },
      futureField: { preserve: true },
    },
  ];
  assert.deepEqual(await repositories.providers.replaceAll(profileId, descriptors, 0), {
    revision: 1,
    count: 1,
  });
  assert.deepEqual(
    (await repositories.providers.list(profileId)).providers.map((item) => item.descriptor),
    descriptors
  );
  const providerEnvelope = database
    .prepare("SELECT descriptor_envelope FROM providers WHERE profile_id = ?")
    .get(profileId).descriptor_envelope;
  assert.equal(typeof providerEnvelope, "string");
  assert.equal(providerEnvelope.includes("token=private"), false);

  const credentials = { access_token: "access-secret", refresh_token: "refresh-secret" };
  assert.equal(
    (await repositories.oauthCredentials.put(profileId, "trakt", credentials, 0)).revision,
    1
  );
  const credentialEnvelope = database
    .prepare("SELECT credential_envelope FROM oauth_credentials WHERE profile_id = ?")
    .get(profileId).credential_envelope;
  assert.equal(credentialEnvelope.includes(credentials.access_token), false);
  assert.deepEqual((await repositories.oauthCredentials.get(profileId, "trakt")).credentials, credentials);

  const collection = [{ transportUrl: "https://secret.example/addon?token=backup" }];
  const backup = await repositories.addonCollectionBackups.create(
    profileId,
    collection,
    "before-import"
  );
  const backupEnvelope = database
    .prepare("SELECT collection_envelope FROM addon_collection_backups WHERE id = ?")
    .get(backup.id).collection_envelope;
  assert.equal(backupEnvelope.includes("token=backup"), false);
  assert.deepEqual((await repositories.addonCollectionBackups.get(profileId, backup.id)).collection, collection);

  now.value = 2500;
  assert.equal(await repositories.profiles.revoke(profileId, 2), true);
  assert.equal(await repositories.devices.authenticate(suppliedDeviceToken), null);
  assert.deepEqual(await repositories.providers.list(profileId), { revision: 0, providers: [] });
  assert.equal(await repositories.oauthCredentials.get(profileId, "trakt"), null);
  assert.equal(await repositories.addonCollectionBackups.get(profileId, backup.id), null);
  assert.equal(await repositories.legacyConfigAliases.getProfileId("a".repeat(64)), null);
  await assert.rejects(
    () => repositories.oauthCredentials.put(profileId, "trakt", credentials, 1),
    (error) => error.code === "profile_inactive"
  );
});

sqliteTest("failed nested provider replacement rolls back to its savepoint only", async (t) => {
  const { database, repositories } = fixture(t, { seed: 7 });
  const profile = (await repositories.profiles.create({ displayName: "Before" })).profile;
  const original = [{ transportUrl: "https://old.example/manifest.json" }];
  await repositories.providers.replaceAll(profile.id, original, 0);
  database.exec(`
    CREATE TRIGGER reject_second_provider
    BEFORE INSERT ON providers
    WHEN NEW.ordinal = 1
    BEGIN
      SELECT RAISE(ABORT, 'forced provider failure');
    END
  `);

  let replacement;
  withImmediateTransaction(database, () => {
    replacement = repositories.providers.replaceAll(
      profile.id,
      [
        { transportUrl: "https://new-a.example/manifest.json" },
        { transportUrl: "https://new-b.example/manifest.json" },
      ],
      1
    );
    replacement.catch(() => {});
    database
      .prepare("UPDATE profiles SET display_name = 'Outer committed' WHERE id = ?")
      .run(profile.id);
  });

  await assert.rejects(replacement, /forced provider failure/);
  assert.equal(database.inTransaction, false);
  assert.equal((await repositories.profiles.getById(profile.id)).displayName, "Outer committed");
  assert.deepEqual(await repositories.providers.list(profile.id), {
    revision: 1,
    providers: [{
      providerId: "provider_00000001",
      ordinal: 0,
      descriptor: original[0],
    }],
  });
});

sqliteTest("SQLite provider mutation fence rejects stale writers without changing snapshots", async (t) => {
  const { database, repositories } = fixture(t, { seed: 31 });
  const profile = (await repositories.profiles.create({})).profile;
  const firstFence = "1".repeat(128);
  const recoveryFence = "2".repeat(128);
  const descriptors = [{ transportUrl: "https://sqlite-fence.example/manifest.json" }];

  for (const invalid of ["", "00", "01", "9".repeat(129)]) {
    await assert.rejects(
      () => repositories.providers.advanceMutationFence(profile.id, invalid),
      /mutationFence is invalid/
    );
  }
  await assert.rejects(
    () => repositories.providers.advanceMutationFence("missing_profile_0001", "1"),
    (error) => error.code === "profile_inactive"
  );

  assert.deepEqual(await repositories.providers.advanceMutationFence(profile.id, firstFence), {
    revision: 0,
    mutationFence: firstFence,
  });
  assert.deepEqual(
    database.prepare(
      "SELECT revision, mutation_fence, typeof(mutation_fence) AS storage_type " +
      "FROM provider_collections WHERE profile_id = ?"
    ).get(profile.id),
    { revision: 0, mutation_fence: firstFence, storage_type: "text" }
  );
  for (const invalid of ["01", "9".repeat(129)]) {
    assert.throws(
      () => database.prepare(
        "UPDATE provider_collections SET mutation_fence = ? WHERE profile_id = ?"
      ).run(invalid, profile.id),
      /CHECK constraint failed/
    );
  }

  await repositories.providers.replaceAll(profile.id, descriptors, 0, {
    mutationFence: firstFence,
  });
  const beforeRecovery = await repositories.providers.list(profile.id);
  assert.deepEqual(await repositories.providers.advanceMutationFence(profile.id, recoveryFence), {
    revision: 1,
    mutationFence: recoveryFence,
  });
  assert.deepEqual(await repositories.providers.advanceMutationFence(profile.id, recoveryFence), {
    revision: 1,
    mutationFence: recoveryFence,
  });
  assert.deepEqual(await repositories.providers.list(profile.id), beforeRecovery);

  await assert.rejects(
    () => repositories.providers.replaceAll(
      profile.id,
      [{ transportUrl: "https://sqlite-stale.example/manifest.json" }],
      1,
      { mutationFence: firstFence }
    ),
    (error) => error.code === "provider_snapshot_stale_fence"
  );
  assert.deepEqual(await repositories.providers.list(profile.id), beforeRecovery);
  assert.deepEqual(
    database.prepare(
      "SELECT revision, mutation_fence FROM provider_collections WHERE profile_id = ?"
    ).get(profile.id),
    { revision: 1, mutation_fence: recoveryFence }
  );
});

sqliteTest("SQLite provider fence allocation is durable, global, rebased, and exhaustion-safe", async (t) => {
  const { database, filename, repositories } = fixture(t, { seed: 32 });
  const profile = (await repositories.profiles.create({})).profile;
  const otherProfile = (await repositories.profiles.create({})).profile;
  const abandonedProfile = (await repositories.profiles.create({})).profile;

  await assert.rejects(
    () => repositories.providers.allocateMutationFence("missing_profile_0001"),
    (error) => error.code === "profile_inactive"
  );
  const allocated = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      repositories.providers.allocateMutationFence(
        index % 2 === 0 ? profile.id : otherProfile.id
      )
    )
  );
  assert.deepEqual(allocated, Array.from({ length: 24 }, (_, index) => String(index + 1)));
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM provider_collections").get().count,
    0
  );
  await repositories.providers.replaceAll(abandonedProfile.id, [], 0, {
    mutationFence: allocated[0],
  });
  assert.deepEqual(
    database.prepare(
      "SELECT revision, mutation_fence FROM provider_collections WHERE profile_id = ?"
    ).get(abandonedProfile.id),
    { revision: 1, mutation_fence: "1" }
  );

  const secondDatabase = new Database(filename);
  const secondRepositories = createSqliteRepositories(secondDatabase, {
    ...primitives(33),
    idFactory: ids(),
  });
  t.after(() => {
    if (secondDatabase.open) secondDatabase.close();
  });
  assert.equal(await secondRepositories.providers.allocateMutationFence(profile.id), "25");

  await repositories.providers.replaceAll(profile.id, [], 0, { mutationFence: "1000" });
  assert.equal(await secondRepositories.providers.allocateMutationFence(otherProfile.id), "1001");
  await secondRepositories.providers.advanceMutationFence(otherProfile.id, "5000");
  assert.equal(await repositories.providers.allocateMutationFence(profile.id), "5001");

  const maximumFence = "9".repeat(128);
  await repositories.providers.advanceMutationFence(profile.id, maximumFence);
  await assert.rejects(
    () => secondRepositories.providers.allocateMutationFence(otherProfile.id),
    (error) =>
      error.code === "provider_mutation_fence_exhausted" &&
      error.message === "provider mutation fence allocator exhausted"
  );
  assert.deepEqual(
    database.prepare("SELECT * FROM provider_mutation_fence_counter").all(),
    [{ singleton_id: 1, mutation_fence: maximumFence }]
  );
  assert.throws(
    () => database.prepare(
      "INSERT INTO provider_mutation_fence_counter (singleton_id, mutation_fence) VALUES (2, '1')"
    ).run(),
    /CHECK constraint failed/
  );
  secondDatabase.close();
});

sqliteTest("SQLite provider lists keep revision and rows in one WAL snapshot", async (t) => {
  const { filename, repositories } = fixture(t, { seed: 8 });
  const profile = (await repositories.profiles.create({})).profile;
  const original = [{ transportUrl: "https://snapshot-old.example/manifest.json" }];
  const replacement = [{ transportUrl: "https://snapshot-new.example/manifest.json" }];
  await repositories.providers.replaceAll(profile.id, original, 0);

  const secondDatabase = new Database(filename);
  const secondRepositories = createSqliteRepositories(secondDatabase, {
    ...primitives(9),
    clock: () => 2000,
    idFactory: (kind) => kind + "_snapshot_0001",
  });
  t.after(() => {
    if (secondDatabase.open) secondDatabase.close();
  });

  const collectionStatement = repositories.providers._getCollection;
  let writerPromise = null;
  repositories.providers._getCollection = {
    get(...parameters) {
      const collection = collectionStatement.get(...parameters);
      if (writerPromise === null) {
        writerPromise = secondRepositories.providers.replaceAll(profile.id, replacement, 1);
        writerPromise.catch(() => {});
      }
      return collection;
    },
  };

  const snapshot = await repositories.providers.list(profile.id);
  await writerPromise;
  assert.equal(snapshot.revision, 1);
  assert.deepEqual(snapshot.providers.map((provider) => provider.descriptor), original);
  assert.deepEqual(await secondRepositories.providers.list(profile.id), {
    revision: 2,
    providers: [{
      providerId: "provider_snapshot_0001",
      ordinal: 0,
      descriptor: replacement[0],
    }],
  });
  secondDatabase.close();
});

sqliteTest("SQLite protected reads keep authorization and data in one snapshot", async (t) => {
  const { database, repositories } = fixture(t, { seed: 12 });
  const profile = (await repositories.profiles.create({})).profile;
  const alias = "9".repeat(64);
  const historyKey = "8".repeat(64);
  await repositories.oauthCredentials.put(profile.id, "trakt", { token: "secret" }, 0);
  const backup = await repositories.addonCollectionBackups.create(
    profile.id,
    [{ transportUrl: "https://snapshot.example/manifest.json" }],
    "snapshot"
  );
  await repositories.history.upsert(profile.id, historyEntry(historyKey, 900), 0);
  await repositories.legacyConfigAliases.bind(profile.id, alias);

  let statementChecks = 0;
  function requireTransaction(repository, property, method) {
    const statement = repository[property];
    repository[property] = {
      [method](...parameters) {
        statementChecks += 1;
        assert.equal(database.inTransaction, true, property + " ran outside a transaction");
        return statement[method](...parameters);
      },
    };
  }

  for (const repository of [
    repositories.oauthCredentials,
    repositories.addonCollectionBackups,
    repositories.history,
    repositories.legacyConfigAliases,
  ]) {
    requireTransaction(repository, "_profileStatus", "get");
  }
  requireTransaction(repositories.oauthCredentials, "_get", "get");
  requireTransaction(repositories.addonCollectionBackups, "_getById", "get");
  requireTransaction(repositories.addonCollectionBackups, "_list", "all");
  requireTransaction(repositories.history, "_getActive", "get");
  requireTransaction(repositories.history, "_getAny", "get");
  requireTransaction(repositories.history, "_list", "all");
  requireTransaction(repositories.history, "_changes", "all");
  requireTransaction(repositories.legacyConfigAliases, "_get", "get");

  assert.ok(await repositories.oauthCredentials.get(profile.id, "trakt"));
  assert.ok(await repositories.addonCollectionBackups.get(profile.id, backup.id));
  assert.equal((await repositories.addonCollectionBackups.list(profile.id)).length, 1);
  assert.ok(await repositories.history.get(profile.id, historyKey));
  assert.ok(await repositories.history.getForWrite(profile.id, historyKey));
  assert.equal((await repositories.history.list(profile.id)).length, 1);
  assert.equal((await repositories.history.changes(profile.id)).length, 1);
  assert.equal(await repositories.legacyConfigAliases.getProfileId(alias), profile.id);
  assert.equal(statementChecks, 16);
  assert.equal(database.inTransaction, false);
});

sqliteTest("SQLite protected reads survive concurrent revocation as one WAL snapshot", async (t) => {
  const { filename, repositories } = fixture(t, { seed: 13 });
  const profile = (await repositories.profiles.create({})).profile;
  await repositories.oauthCredentials.put(profile.id, "trakt", { token: "old" }, 0);

  const writer = new Database(filename);
  configureSqliteDatabase(writer, { busyTimeoutMs: 1000 });
  t.after(() => {
    if (writer.open) writer.close();
  });

  const statusStatement = repositories.oauthCredentials._profileStatus;
  let revoked = false;
  repositories.oauthCredentials._profileStatus = {
    get(...parameters) {
      const activeRow = statusStatement.get(...parameters);
      if (!revoked) {
        revoked = true;
        writer.exec("BEGIN IMMEDIATE");
        try {
          writer.prepare(`
            UPDATE profiles
               SET status = 'revoked', revision = revision + 1,
                   updated_at = 2000, revoked_at = 2000
             WHERE id = ?
          `).run(profile.id);
          writer.prepare("DELETE FROM oauth_credentials WHERE profile_id = ?").run(profile.id);
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }
      return activeRow;
    },
  };

  const snapshot = await repositories.oauthCredentials.get(profile.id, "trakt");
  assert.deepEqual(snapshot.credentials, { token: "old" });
  assert.equal(await repositories.oauthCredentials.get(profile.id, "trakt"), null);
  writer.close();
});

sqliteTest("SQLite separates exact plaintext and encoded envelope storage limits", async (t) => {
  const keyId = "k".repeat(64);
  const { database, repositories } = fixture(t, { keyId, seed: 11 });
  const profile = (await repositories.profiles.create({})).profile;
  const descriptor = objectWithExactJsonBytes(
    { transportUrl: "https://boundary.example/manifest.json" },
    "padding",
    MAX_JSON_SNAPSHOT_BYTES
  );
  const credentials = objectWithExactJsonBytes({}, "padding", MAX_JSON_SNAPSHOT_BYTES);
  const collection = collectionWithExactJsonBytes(MAX_BACKUP_PLAINTEXT_BYTES);

  await repositories.providers.replaceAll(profile.id, [descriptor], 0);
  await repositories.oauthCredentials.put(profile.id, "trakt", credentials, 0);
  const backup = await repositories.addonCollectionBackups.create(
    profile.id,
    collection,
    "exact-boundary"
  );

  const lengths = {
    provider: database
      .prepare("SELECT length(CAST(descriptor_envelope AS BLOB)) AS bytes FROM providers")
      .get().bytes,
    oauth: database
      .prepare("SELECT length(CAST(credential_envelope AS BLOB)) AS bytes FROM oauth_credentials")
      .get().bytes,
    backup: database
      .prepare(
        "SELECT length(CAST(collection_envelope AS BLOB)) AS bytes " +
        "FROM addon_collection_backups WHERE id = ?"
      )
      .get(backup.id).bytes,
  };
  assert.equal(lengths.provider, MAX_JSON_SNAPSHOT_ENVELOPE_BYTES - 11);
  assert.equal(lengths.oauth, MAX_JSON_SNAPSHOT_ENVELOPE_BYTES - 11);
  assert.equal(lengths.backup, MAX_BACKUP_ENVELOPE_BYTES - 11);
  assert.ok(lengths.provider > MAX_JSON_SNAPSHOT_BYTES);
  assert.ok(lengths.backup > MAX_BACKUP_PLAINTEXT_BYTES);

  const boundaries = [
    {
      limit: MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
      sql: "UPDATE providers SET descriptor_envelope = ?",
    },
    {
      limit: MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
      sql: "UPDATE oauth_credentials SET credential_envelope = ?",
    },
    {
      limit: MAX_BACKUP_ENVELOPE_BYTES,
      sql: "UPDATE addon_collection_backups SET collection_envelope = ?",
    },
  ];
  for (const boundary of boundaries) {
    const statement = database.prepare(boundary.sql);
    assert.doesNotThrow(() => statement.run(jsonTextWithExactBytes(boundary.limit)));
    assert.throws(
      () => statement.run(jsonTextWithExactBytes(boundary.limit + 1)),
      (error) => error.code === "SQLITE_CONSTRAINT_CHECK"
    );
  }

  await assert.rejects(
    () => repositories.providers.replaceAll(
      profile.id,
      [objectWithExactJsonBytes(
        { transportUrl: "https://too-large.example/manifest.json" },
        "padding",
        MAX_JSON_SNAPSHOT_BYTES + 1
      )],
      1
    ),
    /exceeds 64 KiB/
  );
  await assert.rejects(
    () => repositories.oauthCredentials.put(
      profile.id,
      "trakt",
      objectWithExactJsonBytes({}, "padding", MAX_JSON_SNAPSHOT_BYTES + 1),
      1
    ),
    new RegExp("exceeds " + MAX_JSON_SNAPSHOT_BYTES + " bytes")
  );
  await assert.rejects(
    () => repositories.addonCollectionBackups.create(
      profile.id,
      collectionWithExactJsonBytes(MAX_BACKUP_PLAINTEXT_BYTES + 1),
      "too-large"
    ),
    new RegExp("exceeds " + MAX_BACKUP_PLAINTEXT_BYTES + " bytes")
  );
});

sqliteTest("SQLite history uses global changes and sanitized tombstones", async (t) => {
  const { database, now, repositories } = fixture(t, { seed: 10 });
  const profile = (await repositories.profiles.create({})).profile;
  const keyA = "b".repeat(64);
  const keyB = "c".repeat(64);

  const first = await repositories.history.upsert(profile.id, historyEntry(keyA, 900), 0);
  const second = await repositories.history.upsert(profile.id, historyEntry(keyB, 950), 0);
  assert.equal(first.changeSequence, 1);
  assert.equal(second.changeSequence, 2);
  assert.deepEqual(
    (await repositories.history.list(profile.id)).map((entry) => entry.contentKey),
    [keyB, keyA]
  );
  await assert.rejects(
    () => repositories.history.upsert(profile.id, historyEntry(keyA, 899), 1),
    (error) => error.code === "stale_history"
  );
  await assert.rejects(
    () =>
      repositories.history.upsert(
        profile.id,
        historyEntry("d".repeat(64), 999, {
          playbackSnapshot: { sourceUrl: "https://secret.example/video" },
        }),
        0
      ),
    /sensitive field/
  );

  now.value = 2000;
  assert.equal(await repositories.history.remove(profile.id, keyA, 1), true);
  assert.equal(await repositories.history.get(profile.id, keyA), null);
  const changes = await repositories.history.changes(profile.id);
  assert.deepEqual(
    changes.map((entry) => entry.changeSequence),
    [2, 3]
  );
  const tombstone = changes[1];
  assert.equal(tombstone.deletedAt, 2000);
  assert.deepEqual(tombstone.displaySnapshot, {});
  assert.deepEqual(tombstone.playbackSnapshot, {});
  const raw = database
    .prepare("SELECT display_snapshot, playback_snapshot, deleted_at FROM cloud_history WHERE content_key = ?")
    .get(keyA);
  assert.equal(raw.display_snapshot, "{}");
  assert.equal(raw.playback_snapshot, "{}");
  assert.equal(typeof raw.deleted_at, "number");

  const internalTombstone = await repositories.history.getForWrite(profile.id, keyA);
  assert.equal(internalTombstone.revision, 2);
  assert.equal(internalTombstone.deletedAt, 2000);
  const resurrected = await repositories.history.upsert(
    profile.id,
    historyEntry(keyA, 2001, { positionMs: 2000, watchedMs: 2000 }),
    internalTombstone.revision
  );
  assert.equal(resurrected.revision, 3);
  assert.equal(resurrected.deletedAt, null);
  assert.equal((await repositories.history.get(profile.id, keyA)).revision, 3);
});

sqliteTest("SQLite history tuple cursors do not lose tied timestamps", async (t) => {
  const { repositories } = fixture(t, { seed: 14 });
  const profile = (await repositories.profiles.create({})).profile;
  const tiedKeys = ["a", "b", "c", "d", "e"].map((value) => value.repeat(64));
  const olderKey = "f".repeat(64);
  for (const contentKey of tiedKeys) {
    await repositories.history.upsert(profile.id, historyEntry(contentKey, 5000), 0);
  }
  await repositories.history.upsert(profile.id, historyEntry(tiedKeys[4], 5000), 1);
  await repositories.history.upsert(profile.id, historyEntry(olderKey, 4000), 0);

  const firstPage = await repositories.history.list(profile.id, { limit: 2 });
  const firstCursor = {
    contentKey: firstPage.at(-1).contentKey,
    lastPlayedAt: firstPage.at(-1).lastPlayedAt,
    revision: firstPage.at(-1).revision,
  };
  const secondPage = await repositories.history.list(profile.id, {
    cursor: firstCursor,
    limit: 2,
  });
  const secondCursor = {
    contentKey: secondPage.at(-1).contentKey,
    lastPlayedAt: secondPage.at(-1).lastPlayedAt,
    revision: secondPage.at(-1).revision,
  };
  const thirdPage = await repositories.history.list(profile.id, {
    before: secondCursor,
    limit: 2,
  });

  assert.deepEqual(
    [...firstPage, ...secondPage, ...thirdPage].map((entry) => entry.contentKey),
    [tiedKeys[4], tiedKeys[0], tiedKeys[1], tiedKeys[2], tiedKeys[3], olderKey]
  );
  assert.equal(new Set([...firstPage, ...secondPage, ...thirdPage].map(
    (entry) => entry.contentKey
  )).size, 6);
  assert.deepEqual(
    (await repositories.history.list(profile.id, { before: 5000 })).map(
      (entry) => entry.contentKey
    ),
    [olderKey]
  );
  await assert.rejects(
    () => repositories.history.list(profile.id, { before: 5000, cursor: firstCursor }),
    /mutually exclusive/
  );
});

sqliteTest("SQLite CAS observes writes from another handle and persists after reopen", async (t) => {
  const { filename, now, repositories } = fixture(t, { seed: 20 });
  const created = await repositories.profiles.create({ displayName: "Original" });
  const secondDatabase = new Database(filename);
  let secondId = 0;
  const secondRepositories = createSqliteRepositories(secondDatabase, {
    ...primitives(30),
    clock: () => now.value,
    idFactory: (kind) => kind + "_second_" + String(++secondId).padStart(8, "0"),
  });
  t.after(() => {
    if (secondDatabase.open) secondDatabase.close();
  });

  assert.equal((await secondRepositories.profiles.getById(created.profile.id)).revision, 1);
  assert.deepEqual(secondRepositories.migrationResult.alreadyApplied, [
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
  now.value = 3000;
  await repositories.profiles.update(created.profile.id, { displayName: "Winner" }, 1);
  await assert.rejects(
    () => secondRepositories.profiles.update(created.profile.id, { displayName: "Loser" }, 1),
    (error) => error.code === "revision_conflict"
  );
  assert.equal((await secondRepositories.profiles.getById(created.profile.id)).displayName, "Winner");

  const other = await secondRepositories.profiles.create({});
  const alias = "e".repeat(64);
  await repositories.legacyConfigAliases.bind(created.profile.id, alias);
  await assert.rejects(
    () => secondRepositories.legacyConfigAliases.bind(other.profile.id, alias),
    (error) => error.code === "legacy_alias_conflict"
  );
  secondDatabase.close();
});

sqliteTest("SQLite device listing and history clearing share lifecycle semantics", async (t) => {
  const { now, repositories } = fixture(t, { seed: 41 });
  const profile = (await repositories.profiles.create({ displayName: "Lifecycle" })).profile;
  const first = await repositories.devices.register(profile.id, { displayName: "First" });
  const second = await repositories.devices.register(profile.id, { displayName: "Second" });
  assert.deepEqual((await repositories.devices.list(profile.id)).map((device) => device.id), [
    first.device.id,
    second.device.id,
  ]);
  await repositories.devices.revoke(profile.id, first.device.id);
  assert.deepEqual((await repositories.devices.list(profile.id)).map((device) => device.id), [
    second.device.id,
  ]);

  const contentKey = "e".repeat(64);
  const staleGeneration = await repositories.history.getGeneration(profile.id);
  await repositories.history.upsert(
    profile.id,
    historyEntry(contentKey, 1000),
    0,
    { generation: staleGeneration }
  );
  const currentGeneration = await repositories.history.clear(profile.id);
  assert.equal(currentGeneration, staleGeneration + 1);
  assert.deepEqual(repositories.history.storageSnapshot(), []);
  await assert.rejects(
    () => repositories.history.upsert(
      profile.id,
      historyEntry(contentKey, 1001),
      0,
      { generation: staleGeneration }
    ),
    (error) => error.code === "history_generation_changed"
  );
  assert.equal(
    (await repositories.history.upsert(
      profile.id,
      historyEntry(contentKey, 1002),
      0,
      { generation: currentGeneration }
    )).revision,
    1
  );

  now.value = second.device.expiresAt;
  assert.deepEqual(await repositories.devices.list(profile.id), []);
});

sqliteTest("SQLite device revocation generations atomically fence stale history writes", async (t) => {
  const { database, repositories } = fixture(t, { seed: 32 });
  const profile = (await repositories.profiles.create({ displayName: "Fence" })).profile;
  const registered = await repositories.devices.register(profile.id, { displayName: "Kodi" });
  const binding = await repositories.devices.authenticate(registered.deviceToken);
  assert.equal(binding.generation, 1);
  assert.equal(
    await repositories.devices.isActiveBinding(profile.id, binding.id, binding.generation),
    true
  );

  assert.equal(await repositories.devices.revoke(profile.id, binding.id), true);
  assert.equal(await repositories.devices.getGeneration(profile.id, binding.id), 2);
  assert.equal(await repositories.devices.revoke(profile.id, binding.id), true);
  assert.equal(await repositories.devices.getGeneration(profile.id, binding.id), 2);

  const contentKey = "f".repeat(64);
  await assert.rejects(
    () => repositories.history.upsert(profile.id, historyEntry(contentKey, 1000), 0, {
      deviceId: binding.id,
      deviceGeneration: binding.generation,
    }),
    (error) => error.code === "device_generation_changed"
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM cloud_history WHERE profile_id = ?").get(profile.id).count,
    0
  );
});

sqliteTest("SQLite claim admission rejects work after concurrent durable revocation", async (t) => {
  const { repositories } = fixture(t, { seed: 52 });
  assert.equal(typeof repositories.devices.withClaimAdmission, "function");
  assert.equal(typeof repositories.devices.revokeWithInvalidation, "function");
  assert.equal(typeof repositories.lifecycleInvalidations.getPending, "function");

  const profile = (await repositories.profiles.create({ displayName: "Admission" })).profile;
  const registered = await repositories.devices.register(profile.id, { displayName: "Kodi" });
  let enterClaim;
  let releaseClaim;
  const entered = new Promise((resolve) => {
    enterClaim = resolve;
  });
  const release = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  const admitted = repositories.devices.withClaimAdmission(
    profile.id,
    registered.device.id,
    profile.revision,
    registered.device.generation,
    async () => {
      enterClaim();
      await release;
      return "claimed";
    }
  );
  await entered;
  const revocation = repositories.devices.revokeWithInvalidation(
    profile.id,
    registered.device.id
  );
  const revoked = await revocation;
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.invalidation.deviceGeneration, 2);
  assert.equal(await repositories.devices.getGeneration(profile.id, registered.device.id), 2);
  releaseClaim();
  await assert.rejects(admitted, (error) => error.code === "device_generation_changed");
  assert.equal(
    (await repositories.lifecycleInvalidations.getPending(
      "device",
      profile.id,
      registered.device.id
    )).id,
    revoked.invalidation.id
  );
  await assert.rejects(
    () => repositories.devices.withClaimAdmission(
      profile.id,
      registered.device.id,
      profile.revision,
      registered.device.generation,
      async () => "must-not-run"
    ),
    (error) => error.code === "device_generation_changed"
  );
});

sqliteTest("SQLite profile erasure atomically retains tombstones and deletes durable children", async (t) => {
  const { database, repositories } = fixture(t, { seed: 43 });
  const identityHash = "f".repeat(64);
  const created = await repositories.profiles.create({
    displayName: "Erase me",
    legacyConfigHash: identityHash,
  });
  const profileId = created.profile.id;
  await repositories.devices.register(profileId, { displayName: "Kodi" });
  await repositories.providers.replaceAll(
    profileId,
    [{ transportUrl: "https://provider.example/manifest.json" }],
    0
  );
  await repositories.oauthCredentials.put(profileId, "trakt", { access_token: "secret" }, 0);
  await repositories.history.upsert(profileId, historyEntry("d".repeat(64), 1000), 0, {
    generation: 1,
  });
  await repositories.addonCollectionBackups.create(profileId, [], "before-erasure");

  const pending = await repositories.profiles.beginErasure(profileId, created.profile.revision);
  assert.equal(pending.status, "revoked");
  assert.equal(pending.deletionState, "pending");
  assert.equal(await repositories.profiles.erase(profileId), true);
  assert.equal(await repositories.profiles.erase(profileId), true);
  assert.equal((await repositories.profiles.getErasureStatus(profileId)).status, "deleted");
  assert.equal(await repositories.profiles.getByInstallToken(created.installToken), null);
  for (const table of [
    "devices",
    "providers",
    "provider_collections",
    "oauth_credentials",
    "cloud_history",
    "addon_collection_backups",
  ]) {
    assert.equal(
      database.prepare(`SELECT count(*) AS count FROM ${table} WHERE profile_id = ?`).get(profileId).count,
      0,
      table
    );
  }
  assert.equal(
    database.prepare(
      "SELECT count(*) AS count FROM legacy_config_aliases WHERE profile_id = ?"
    ).get(profileId).count,
    1
  );
  await assert.rejects(
    () => repositories.profiles.create({
      displayName: "Must not reprovision",
      legacyConfigHash: identityHash,
    }),
    (error) => error.code === "legacy_alias_conflict"
  );
});

sqliteTest("SQLite durable subtitle manifests block erasure through two absence passes", async (t) => {
  const { now, repositories } = fixture(t, { seed: 61 });
  const created = await repositories.profiles.create({ displayName: "Subtitle manifest" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi",
  });
  const manifest = {
    profileId: created.profile.id,
    profileRevision: created.profile.revision,
    deviceId: registered.device.id,
    deviceGeneration: registered.device.generation,
    artifactId: "artifact_sqlite_manifest_0001",
    sessionId: "session_sqlite_manifest_0001",
    playbackGeneration: "g1:sqlite-manifest",
    contextRevision: "1",
    providerRevision: "1",
    expiresAt: 20_000,
    uploadSettlementDeadline: 2_000,
    parts: [{
      partNumber: 1,
      objectKey: "subtitles/v1/opaque/sqlite-manifest-object-0001",
      sizeBytes: 4,
      checksum: "a".repeat(64),
      mediaType: "text/plain",
    }],
  };

  assert.equal((await repositories.subtitleManifests.reserve(manifest)).state, "uploading");
  await repositories.profiles.beginErasure(created.profile.id, created.profile.revision);
  assert.equal(
    (await repositories.subtitleManifests.listProfile(created.profile.id))[0].state,
    "deletion_requested"
  );
  await assert.rejects(
    () => repositories.profiles.erase(created.profile.id),
    (error) => error.code === "profile_erasure_pending"
  );

  now.value = manifest.uploadSettlementDeadline;
  const first = await repositories.subtitleManifests.claimDeletion({
    workerId: "sqlite_manifest_worker_0001",
    leaseMs: 10,
  });
  await repositories.subtitleManifests.recordDeletionAbsence({
    artifactId: first.artifactId,
    deletionToken: first.deletionToken,
    verifiedAbsent: true,
    secondPassDelayMs: 5,
  });
  now.value += 5;
  const second = await repositories.subtitleManifests.claimDeletion({
    workerId: "sqlite_manifest_worker_0002",
    leaseMs: 10,
  });
  await repositories.subtitleManifests.confirmDeletion({
    artifactId: second.artifactId,
    deletionToken: second.deletionToken,
    verifiedAbsent: true,
  });

  assert.equal(await repositories.profiles.erase(created.profile.id), true);
  assert.equal((await repositories.profiles.getErasureStatus(created.profile.id)).status, "deleted");
});
