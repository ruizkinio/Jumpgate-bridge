"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const Database = require("better-sqlite3");
const { Pool } = require("pg");

const { PostgresMigrationRunner } = require("../lib/storage/postgres");
const {
  configureSqliteDatabase,
  runSqliteMigrations,
} = require("../lib/storage/sqlite");

const POSTGRES_URL = process.env.TEST_POSTGRES_URL || process.env.DATABASE_URL || "";
const AGGREGATED_POSTGRES_LIVE_RUN =
  process.env.JUMPGATE_POSTGRES_LIVE_AGGREGATE === "1";
const SQLITE_MIGRATIONS = path.join(__dirname, "..", "migrations", "sqlite");

function quoteIdentifier(value) {
  assert.match(value, /^[a-z0-9_]+$/);
  return `"${value}"`;
}

function copySqliteMigrationPrefix(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const filename of fs.readdirSync(SQLITE_MIGRATIONS).sort()) {
    if (
      filename.startsWith("0008_") ||
      filename.startsWith("0009_") ||
      filename.startsWith("0010_")
    ) {
      continue;
    }
    fs.copyFileSync(path.join(SQLITE_MIGRATIONS, filename), path.join(directory, filename));
  }
}

function appendSqliteMigration(directory, filename) {
  fs.copyFileSync(
    path.join(SQLITE_MIGRATIONS, filename),
    path.join(directory, filename)
  );
}

function historyEntry() {
  return {
    contentKey: "a".repeat(64),
    canonicalIdentity: {
      provider: "imdb",
      id: "tt0133093",
      mediaType: "movie",
      provenance: "metadata-request",
      confidence: "canonical",
    },
    displaySnapshot: { title: "Caller Selected Identity", year: 1999 },
    playbackSnapshot: {
      providerId: "provider_forged_history",
      sourceFingerprint: "sha256:" + "b".repeat(64),
    },
    positionMs: 20_000,
    durationMs: 100_000,
    watchedMs: 18_000,
    completed: false,
    lastPlayedAt: 10_000,
  };
}

function dispatch() {
  return {
    id: "dispatch_forged_history",
    event: "start",
    progress: 20,
    payload: { movie: { ids: { imdb: "tt0133093" } }, progress: 20 },
  };
}

function legacyBinding(label) {
  const binding = {
    profileId: `profile_${label}`,
    profileRevision: 1,
    deviceId: `device_${label}`,
    deviceGeneration: 1,
    sessionId: `session_${label}_forged`,
    contextId: `context_${label}_forged`,
    playbackGeneration: `g1:${label}_forged`,
    contextRevision: "1",
  };
  return binding;
}

function fixtureHash(label) {
  return crypto.createHash("sha256").update(label).digest("hex");
}

function seedSqlitePreClaimBoundData(database, label) {
  const binding = legacyBinding(label);
  const entry = historyEntry();
  const queued = dispatch();
  database.transaction(() => {
    database.prepare(`
      INSERT INTO profiles (
        id, schema_version, install_token_hash, display_name, status, revision,
        created_at, updated_at
      ) VALUES (?, 1, ?, ?, 'active', 1, ?, ?)
    `).run(binding.profileId, fixtureHash(`${label}:profile`), `Legacy ${label}`, 10_000, 10_000);
    database.prepare(`
      INSERT INTO devices (
        id, profile_id, schema_version, token_hash, display_name,
        created_at, last_seen_at, expires_at
      ) VALUES (?, ?, 1, ?, 'Legacy Kodi', ?, ?, ?)
    `).run(binding.deviceId, binding.profileId, fixtureHash(`${label}:device`), 10_000, 10_000, 70_000);
    database.prepare("UPDATE history_sequence SET value = 1 WHERE singleton = 1").run();
    database.prepare(`
      INSERT INTO cloud_history (
        profile_id, content_key, schema_version, canonical_identity, display_snapshot,
        playback_snapshot, position_ms, duration_ms, watched_ms, completed,
        revision, change_sequence, last_played_at, updated_at, deleted_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?, NULL)
    `).run(
      binding.profileId,
      entry.contentKey,
      JSON.stringify(entry.canonicalIdentity),
      JSON.stringify(entry.displaySnapshot),
      JSON.stringify(entry.playbackSnapshot),
      entry.positionMs,
      entry.durationMs,
      entry.watchedMs,
      entry.lastPlayedAt,
      10_000
    );
    database.prepare(`
      INSERT INTO playback_sessions (
        profile_id, session_id, profile_revision, device_id, device_generation,
        context_id, playback_generation, context_revision, state, revision,
        created_at, updated_at, invalidated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'playing', 1, ?, ?, NULL)
    `).run(
      binding.profileId,
      binding.sessionId,
      binding.profileRevision,
      binding.deviceId,
      binding.deviceGeneration,
      binding.contextId,
      binding.playbackGeneration,
      binding.contextRevision,
      10_000,
      10_000
    );
    database.prepare(`
      INSERT INTO scrobble_dispatches (
        profile_id, id, profile_revision, device_id, device_generation,
        session_id, context_id, playback_generation, context_revision,
        session_revision, event, progress, payload, required_state, status,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'playing', 'queued', ?, ?, ?)
    `).run(
      binding.profileId,
      queued.id,
      binding.profileRevision,
      binding.deviceId,
      binding.deviceGeneration,
      binding.sessionId,
      binding.contextId,
      binding.playbackGeneration,
      binding.contextRevision,
      queued.event,
      queued.progress,
      JSON.stringify(queued.payload),
      10_000,
      10_000,
      10_000
    );
    database.prepare(`
      INSERT INTO playback_source_revocations (
        profile_id, context_id, playback_generation, context_revision, revoked_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      binding.profileId,
      binding.contextId,
      binding.playbackGeneration,
      binding.contextRevision,
      10_000
    );
  })();
  return { binding, profileId: binding.profileId };
}

async function seedPostgresPreClaimBoundData(pool, label) {
  const binding = legacyBinding(label);
  const entry = historyEntry();
  const queued = dispatch();
  const now = new Date(10_000);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO profiles (
        id, schema_version, install_token_hash, display_name, status, revision,
        created_at, updated_at
      ) VALUES ($1, 1, $2, $3, 'active', 1, $4, $4)
    `, [binding.profileId, fixtureHash(`${label}:profile`), `Legacy ${label}`, now]);
    await client.query(`
      INSERT INTO devices (
        id, profile_id, schema_version, token_hash, display_name,
        created_at, last_seen_at, expires_at
      ) VALUES ($1, $2, 1, $3, 'Legacy Kodi', $4, $4, $5)
    `, [binding.deviceId, binding.profileId, fixtureHash(`${label}:device`), now, new Date(70_000)]);
    await client.query(`
      INSERT INTO cloud_history (
        profile_id, content_key, schema_version, canonical_identity, display_snapshot,
        playback_snapshot, position_ms, duration_ms, watched_ms, completed,
        revision, last_played_at, updated_at, deleted_at
      ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, false, 1, $9, $10, NULL)
    `, [
      binding.profileId,
      entry.contentKey,
      entry.canonicalIdentity,
      entry.displaySnapshot,
      entry.playbackSnapshot,
      entry.positionMs,
      entry.durationMs,
      entry.watchedMs,
      new Date(entry.lastPlayedAt),
      now,
    ]);
    await client.query(`
      INSERT INTO playback_sessions (
        profile_id, session_id, profile_revision, device_id, device_generation,
        context_id, playback_generation, context_revision, state, revision,
        created_at, updated_at, invalidated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'playing', 1, $9, $9, NULL)
    `, [
      binding.profileId,
      binding.sessionId,
      binding.profileRevision,
      binding.deviceId,
      binding.deviceGeneration,
      binding.contextId,
      binding.playbackGeneration,
      binding.contextRevision,
      now,
    ]);
    await client.query(`
      INSERT INTO scrobble_dispatches (
        profile_id, id, profile_revision, device_id, device_generation,
        session_id, context_id, playback_generation, context_revision,
        session_revision, event, progress, payload, required_state, status,
        next_attempt_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        1, $10, $11, $12, 'playing', 'queued', $13, $13, $13
      )
    `, [
      binding.profileId,
      queued.id,
      binding.profileRevision,
      binding.deviceId,
      binding.deviceGeneration,
      binding.sessionId,
      binding.contextId,
      binding.playbackGeneration,
      binding.contextRevision,
      queued.event,
      queued.progress,
      queued.payload,
      now,
    ]);
    await client.query(`
      INSERT INTO playback_source_revocations (
        profile_id, context_id, playback_generation, context_revision, revoked_at
      ) VALUES ($1, $2, $3, $4, $5)
    `, [
      binding.profileId,
      binding.contextId,
      binding.playbackGeneration,
      binding.contextRevision,
      now,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { binding, profileId: binding.profileId };
}

function sqliteCounts(database) {
  return {
    history: database.prepare("SELECT count(*) AS count FROM cloud_history").get().count,
    outbox: database.prepare("SELECT count(*) AS count FROM scrobble_dispatches").get().count,
    revocations: database.prepare(
      "SELECT count(*) AS count FROM playback_source_revocations"
    ).get().count,
    sessions: database.prepare("SELECT count(*) AS count FROM playback_sessions").get().count,
  };
}

function setupSqliteLegacy(t, label) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-history-migration-"));
  const migrationsPath = path.join(directory, "migrations");
  copySqliteMigrationPrefix(migrationsPath);
  const database = new Database(path.join(directory, "history.sqlite3"));
  configureSqliteDatabase(database, { busyTimeoutMs: 2_500 });
  runSqliteMigrations(database, { migrationsPath, clock: () => 1_000 });
  t.after(() => {
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { database, migrationsPath };
}

async function postgresCounts(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT count(*)::integer FROM cloud_history) AS history,
      (SELECT count(*)::integer FROM playback_sessions) AS sessions,
      (SELECT count(*)::integer FROM playback_source_revocations) AS revocations,
      (SELECT count(*)::integer FROM scrobble_dispatches) AS outbox
  `);
  return result.rows[0];
}

async function setupPostgresLegacy(t, label) {
  const schema = `jumpgate_history_migration_${process.pid}_${crypto.randomBytes(5).toString("hex")}`;
  const admin = new Pool({ connectionString: POSTGRES_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const pool = new Pool({
    connectionString: POSTGRES_URL,
    max: 16,
    options: `-c search_path=${schema},public`,
  });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  });
  await new PostgresMigrationRunner({
    pool,
    migrationCeiling: "0008_scrobble_dispatch",
  }).run();
  return { pool };
}

if (!AGGREGATED_POSTGRES_LIVE_RUN) {
test("SQLite 0008 purges forged pre-release authority and is runner-idempotent", async (t) => {
  const { database, migrationsPath } = setupSqliteLegacy(t, "sqlite_purge");
  seedSqlitePreClaimBoundData(database, "sqlite_purge");
  const sequenceBefore = database.prepare(
    "SELECT value FROM history_sequence WHERE singleton = 1"
  ).get().value;
  assert.deepEqual(sqliteCounts(database), {
    history: 1,
    outbox: 1,
    revocations: 1,
    sessions: 1,
  });

  appendSqliteMigration(migrationsPath, "0008_claim_bound_history.sql");
  const upgraded = runSqliteMigrations(database, { migrationsPath, clock: () => 2_000 });
  assert.deepEqual(upgraded.applied, ["0008_claim_bound_history"]);
  assert.deepEqual(sqliteCounts(database), {
    history: 0,
    outbox: 0,
    revocations: 0,
    sessions: 0,
  });
  assert.equal(database.prepare(
    "SELECT value FROM history_sequence WHERE singleton = 1"
  ).get().value, sequenceBefore);
  assert.equal(database.prepare("SELECT count(*) AS count FROM history_grants").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM history_event_receipts").get().count, 0);
  assert.deepEqual(database.pragma("foreign_key_check"), []);

  appendSqliteMigration(migrationsPath, "0009_dispatch_history_generation.sql");
  const fenced = runSqliteMigrations(database, { migrationsPath, clock: () => 2_500 });
  assert.deepEqual(fenced.applied, ["0009_dispatch_history_generation"]);
  const historyGenerationColumn = database.pragma("table_info(scrobble_dispatches)")
    .find((column) => column.name === "history_generation");
  assert.ok(historyGenerationColumn);
  assert.equal(historyGenerationColumn.notnull, 1);
  assert.equal(historyGenerationColumn.dflt_value, null);
  assert.equal(database.prepare(
    "SELECT value FROM history_sequence WHERE singleton = 1"
  ).get().value, sequenceBefore);
  assert.deepEqual(database.pragma("foreign_key_check"), []);

  appendSqliteMigration(migrationsPath, "0010_history_http_receipts.sql");
  const receipts = runSqliteMigrations(database, { migrationsPath, clock: () => 2_750 });
  assert.deepEqual(receipts.applied, ["0010_history_http_receipts"]);
  const grantColumns = database.pragma("table_info(history_grants)");
  assert.ok(grantColumns.some((column) => column.name === "reservation_expires_at"));
  assert.ok(grantColumns.some((column) => column.name === "claim_response_body"));
  const receiptColumns = database.pragma("table_info(history_event_receipts)");
  assert.ok(receiptColumns.some((column) => column.name === "response_status"));
  assert.ok(receiptColumns.some((column) => column.name === "response_body"));

  const replay = runSqliteMigrations(database, { migrationsPath, clock: () => 3_000 });
  assert.deepEqual(replay.applied, []);
  assert.equal(replay.alreadyApplied.at(-1), "0010_history_http_receipts");
  assert.deepEqual(sqliteCounts(database), {
    history: 0,
    outbox: 0,
    revocations: 0,
    sessions: 0,
  });
});

test("SQLite 0008 rolls its purge back when claim-bound schema creation fails", async (t) => {
  const { database, migrationsPath } = setupSqliteLegacy(t, "sqlite_rollback");
  seedSqlitePreClaimBoundData(database, "sqlite_rollback");
  const before = sqliteCounts(database);
  database.exec("CREATE TABLE history_grant_revocations (conflict INTEGER)");
  appendSqliteMigration(migrationsPath, "0008_claim_bound_history.sql");

  assert.throws(
    () => runSqliteMigrations(database, { migrationsPath, clock: () => 2_000 }),
    /history_grant_revocations already exists/
  );
  assert.deepEqual(sqliteCounts(database), before);
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM schema_migrations WHERE version = '0008_claim_bound_history'"
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'history_grants'"
  ).get().count, 0);
});
}

test(
  "PostgreSQL 0009 purges forged pre-release authority and is runner-idempotent",
  { skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL", timeout: 120_000 },
  async (t) => {
    const { pool } = await setupPostgresLegacy(t, "postgres_purge");
    await seedPostgresPreClaimBoundData(pool, "postgres_purge");
    const sequenceBefore = (await pool.query(
      "SELECT last_value::bigint AS value, is_called FROM cloud_history_change_seq"
    )).rows[0];
    assert.deepEqual(await postgresCounts(pool), {
      history: 1,
      outbox: 1,
      revocations: 1,
      sessions: 1,
    });

    const upgraded = await new PostgresMigrationRunner({ pool }).run();
    assert.deepEqual(upgraded.applied, [
      "0009_claim_bound_history",
      "0010_dispatch_history_generation",
      "0011_history_http_receipts",
    ]);
    assert.deepEqual(await postgresCounts(pool), {
      history: 0,
      outbox: 0,
      revocations: 0,
      sessions: 0,
    });
    assert.equal((await pool.query("SELECT count(*)::integer AS count FROM history_grants")).rows[0].count, 0);
    assert.equal(
      (await pool.query("SELECT count(*)::integer AS count FROM history_event_receipts")).rows[0].count,
      0
    );
    assert.deepEqual((await pool.query(
      "SELECT last_value::bigint AS value, is_called FROM cloud_history_change_seq"
    )).rows[0], sequenceBefore);
    assert.deepEqual((await pool.query(`
      SELECT is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'scrobble_dispatches'
         AND column_name = 'history_generation'
    `)).rows, [{ is_nullable: "NO", column_default: null }]);

    const replay = await new PostgresMigrationRunner({ pool }).run();
    assert.deepEqual(replay.applied, []);
    assert.equal(replay.alreadyApplied.at(-1), "0011_history_http_receipts");
  }
);

test(
  "PostgreSQL 0009 rolls its purge back when claim-bound schema creation fails",
  { skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL", timeout: 120_000 },
  async (t) => {
    const { pool } = await setupPostgresLegacy(t, "postgres_rollback");
    await seedPostgresPreClaimBoundData(pool, "postgres_rollback");
    const before = await postgresCounts(pool);
    await pool.query("CREATE TABLE history_grant_revocations (conflict integer)");

    await assert.rejects(
      () => new PostgresMigrationRunner({ pool }).run(),
      (error) => error.code === "42P07"
    );
    assert.deepEqual(await postgresCounts(pool), before);
    assert.equal(
      (await pool.query(
        "SELECT count(*)::integer AS count FROM schema_migrations WHERE version = '0009_claim_bound_history'"
      )).rows[0].count,
      0
    );
    assert.equal(
      (await pool.query("SELECT to_regclass('history_grants') AS relation")).rows[0].relation,
      null
    );
  }
);
