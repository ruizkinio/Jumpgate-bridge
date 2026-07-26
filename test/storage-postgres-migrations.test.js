"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  activateProviderMutationProtocol,
  attestProviderMutationMode,
  pauseProviderMutations,
  pauseProviderMutationsForActivation,
  PostgresMigrationRunner,
  readProviderMutationProtocolState,
  readPostgresMigrations,
  resumeProviderMutations,
  runPostgresMigrations,
} = require("../lib/storage/postgres");

class FakeTransactionalDatabase {
  constructor(storedRows = []) {
    this.calls = [];
    this.storedRows = storedRows;
    this.transactionCount = 0;
  }

  async transaction(work) {
    this.transactionCount += 1;
    return work({
      query: async (text, values) => {
        this.calls.push({ text, values });
        if (/SELECT version, checksum FROM schema_migrations/.test(text)) {
          return { rowCount: this.storedRows.length, rows: this.storedRows };
        }
        return { rowCount: 0, rows: [] };
      },
    });
  }
}

async function withMigrationDirectory(files, work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "jumpgate-pg-migrations-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await fs.writeFile(path.join(directory, name), contents);
    }
    return await work(directory);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
}

function memoryMigrationFs(files) {
  const entries = Object.entries(files).map(([name, contents]) => [
    name,
    Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8"),
  ]);
  const byName = new Map(entries);
  return {
    async readdir() {
      return entries.map(([name]) => name);
    },
    async readFile(filename) {
      const contents = byName.get(path.basename(filename));
      if (!contents) throw new Error("unknown in-memory migration: " + filename);
      return contents;
    },
  };
}

test("PostgreSQL migrations hold an advisory lock and persist raw LF-byte checksums", async () => {
  const source = Buffer.from("CREATE TABLE example (id integer);\n", "utf8");
  await withMigrationDirectory({ "0001_example.sql": source }, async (directory) => {
    const database = new FakeTransactionalDatabase();
    const result = await new PostgresMigrationRunner({ database, directory }).run();

    assert.deepEqual(result, {
      applied: ["0001_example"],
      alreadyApplied: [],
      verified: ["0001_example"],
    });
    assert.equal(database.transactionCount, 1);
    assert.match(database.calls[0].text, /pg_advisory_xact_lock/);
    assert.match(database.calls[1].text, /CREATE TABLE IF NOT EXISTS schema_migrations/);
    assert.match(database.calls[2].text, /SELECT version, checksum/);
    assert.equal(database.calls[3].text, source.toString("utf8"));
    assert.deepEqual(database.calls[4].values, [
      "0001_example",
      crypto.createHash("sha256").update(source).digest("hex"),
    ]);
  });
});

test("PostgreSQL migrations verify an applied checksum without re-executing SQL", async () => {
  const source = Buffer.from("SELECT 1;\n", "utf8");
  const checksum = crypto.createHash("sha256").update(source).digest("hex");
  await withMigrationDirectory({ "0001_example.sql": source }, async (directory) => {
    const database = new FakeTransactionalDatabase([
      { version: "0001_example", checksum },
    ]);
    const result = await new PostgresMigrationRunner({ database, directory }).run();

    assert.deepEqual(result, {
      applied: [],
      alreadyApplied: ["0001_example"],
      verified: ["0001_example"],
    });
    assert.equal(database.calls.some((call) => call.text === "SELECT 1;\n"), false);
    assert.equal(database.calls.some((call) => /INSERT INTO schema_migrations/.test(call.text)), false);
  });
});

test("PostgreSQL migrations fail closed on immutable checksum drift", async () => {
  await withMigrationDirectory({ "0001_example.sql": "SELECT 1;\n" }, async (directory) => {
    const database = new FakeTransactionalDatabase([
      { version: "0001_example", checksum: "0".repeat(64) },
    ]);
    await assert.rejects(
      () => new PostgresMigrationRunner({ database, directory }).run(),
      (error) => error.code === "migration_checksum_mismatch"
    );
    assert.equal(database.calls.some((call) => call.text === "SELECT 1;\n"), false);
  });
});

test("PostgreSQL migration reads reject CRLF and missing final LF before opening a transaction", async () => {
  for (const source of ["SELECT 1;\r\n", "SELECT 1;"]) {
    await withMigrationDirectory({ "0001_example.sql": source }, async (directory) => {
      const database = new FakeTransactionalDatabase();
      await assert.rejects(
        () => new PostgresMigrationRunner({ database, directory }).run(),
        (error) => error.code === "migration_line_endings"
      );
      assert.equal(database.transactionCount, 0);
    });
  }
});

test("PostgreSQL migration runner honors an already-aborted lifecycle signal", async () => {
  const database = new FakeTransactionalDatabase();
  const controller = new AbortController();
  const timeout = new Error("migration timed out");
  timeout.code = "storage_timeout";
  controller.abort(timeout);

  await assert.rejects(
    () => new PostgresMigrationRunner({ database, signal: controller.signal }).run(),
    (error) => error === timeout
  );
  assert.equal(database.transactionCount, 0);
});

test("PostgreSQL migrations reject nested transaction-control statements", async () => {
  await withMigrationDirectory(
    { "0001_example.sql": "SAVEPOINT nested_work;\n" },
    async (directory) => {
      const database = new FakeTransactionalDatabase();
      await assert.rejects(
        () => new PostgresMigrationRunner({ database, directory }).run(),
        (error) => error.code === "migration_transaction_control"
      );
      assert.equal(database.transactionCount, 0);
    }
  );
});

test("PostgreSQL migration validation ignores quoted controls and comments", async () => {
  const source = [
    "CREATE TABLE example (value text);",
    "INSERT INTO example (value) VALUES ('COMMIT; END; ROLLBACK');",
    "SELECT $$SAVEPOINT nested; RELEASE SAVEPOINT nested;$$;",
    "SELECT $body$BEGIN; ABORT; END;$body$;",
    "SELECT E'PREPARE TRANSACTION \\'ignored\\'';",
    "-- START TRANSACTION;",
    "/* COMMIT; /* nested ROLLBACK; */ END; */",
    "",
  ].join("\n");

  await withMigrationDirectory({ "0001_example.sql": source }, async (directory) => {
    const migrations = await readPostgresMigrations({ directory });
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0].sql, source);
  });
});

test("PostgreSQL migration validation finds controls after any statement boundary", async () => {
  const controls = [
    "SELECT 'COMMIT'; COMMIT;\n",
    "SELECT 1; /* boundary */ END;\n",
    "-- leading comment\nROLLBACK;\n",
    "SELECT $$SAVEPOINT in a string$$; SAVEPOINT nested;\n",
    "SELECT 1; RELEASE SAVEPOINT nested;\n",
    "SELECT 1; ABORT;\n",
    "SELECT 1; START /* comment */ TRANSACTION;\n",
    "SELECT 1; PREPARE /* comment */ TRANSACTION 'branch';\n",
  ];

  for (const source of controls) {
    await withMigrationDirectory({ "0001_example.sql": source }, async (directory) => {
      await assert.rejects(
        () => readPostgresMigrations({ directory }),
        (error) => error.code === "migration_transaction_control"
      );
    });
  }
});

test("PostgreSQL migration batches expose one atomic rollback boundary", async () => {
  const committed = [];
  let rollbackCount = 0;
  let transactionCount = 0;
  const database = {
    async transaction(work) {
      transactionCount += 1;
      const staged = [];
      try {
        const result = await work({
          async query(text) {
            if (/SELECT version, checksum FROM schema_migrations/.test(text)) {
              return { rowCount: 0, rows: [] };
            }
            staged.push(text);
            if (text.includes("definitely_missing_relation")) {
              const error = new Error("relation does not exist");
              error.code = "42P01";
              throw error;
            }
            return { rowCount: 0, rows: [] };
          },
        });
        committed.push(...staged);
        return result;
      } catch (error) {
        rollbackCount += 1;
        throw error;
      }
    },
  };

  await withMigrationDirectory(
    {
      "0001_first.sql": "CREATE TABLE first_step (id integer);\n",
      "0002_failing.sql":
        "CREATE TABLE leaked_step (id integer);\n" +
        "SELECT * FROM definitely_missing_relation;\n",
    },
    async (directory) => {
      await assert.rejects(
        () => new PostgresMigrationRunner({ database, directory }).run(),
        (error) => error.code === "42P01"
      );
    }
  );
  assert.equal(transactionCount, 1);
  assert.equal(rollbackCount, 1);
  assert.deepEqual(committed, []);
});

test("checked-in PostgreSQL migrations expose deterministic versions and checksums", async () => {
  const migrations = await readPostgresMigrations();
  assert.deepEqual(migrations.map((migration) => migration.version), [
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
  for (const migration of migrations) {
    assert.match(migration.checksum, /^[a-f0-9]{64}$/);
    assert.equal(migration.sql.endsWith("\n"), true);
    assert.equal(migration.sql.includes("\r"), false);
  }
  const parity = migrations.find((migration) => migration.version === "0002_contract_parity");
  assert.equal(
    parity.checksum,
    "71d3631e6e4c30a581637c101a0d7ec6d0fa125a344be15d77d9649975c3c3ee"
  );
  assert.match(parity.sql, /descriptor_envelope::text\) <= 65536/);
  assert.match(parity.sql, /credential_envelope::text\) <= 65536/);
  assert.match(parity.sql, /collection_envelope::text\) <= 4194304/);

  const correctness = migrations.find(
    (migration) => migration.version === "0003_storage_correctness"
  );
  assert.match(correctness.sql, /DROP CONSTRAINT IF EXISTS providers_descriptor_envelope_size/);
  assert.match(correctness.sql, /descriptor_envelope::text\) <= 87552/);
  assert.match(correctness.sql, /credential_envelope::text\) <= 87552/);
  assert.match(correctness.sql, /collection_envelope::text\) <= 5592576/);
  assert.match(correctness.sql, /canonical_identity::text\) <= 4194304/);
  assert.match(correctness.sql, /display_snapshot::text\) <= 4194304/);
  assert.match(correctness.sql, /playback_snapshot::text\) <= 4194304/);
  const mutationFence = migrations.find(
    (migration) => migration.version === "0004_provider_mutation_fence"
  );
  assert.match(mutationFence.sql, /mutation_fence numeric\(128, 0\) NOT NULL DEFAULT 0/);
  assert.match(mutationFence.sql, /CHECK \(mutation_fence >= 0\)/);
  assert.match(mutationFence.sql, /CREATE TABLE provider_mutation_fence_counter/);
  assert.match(mutationFence.sql, /singleton_id smallint PRIMARY KEY CHECK \(singleton_id = 1\)/);
  assert.match(
    mutationFence.sql,
    /INSERT INTO provider_mutation_fence_counter[\s\S]*COALESCE\(MAX\(mutation_fence\), 0\)/
  );
  assert.match(mutationFence.sql, /CREATE TABLE provider_mutation_protocol/);
  assert.match(mutationFence.sql, /mutations_paused boolean NOT NULL DEFAULT false/);
  assert.match(mutationFence.sql, /paused_at timestamptz/);
  assert.match(mutationFence.sql, /activation_fence numeric\(128, 0\)/);
  assert.match(mutationFence.sql, /VALUES \(1, false, false, NULL, NULL, NULL\)/);
  assert.match(mutationFence.sql, /current_setting\('jumpgate\.provider_mutation_protocol', true\)/);
  assert.match(mutationFence.sql, /fence_marker !~ '\^\[1-9\]\[0-9\]\{0,127\}\$'/);
  assert.match(mutationFence.sql, /NEW\.mutation_fence <= activation_floor/);
  assert.match(mutationFence.sql, /NEW\.mutation_fence < OLD\.mutation_fence/);
  assert.match(mutationFence.sql, /IF paused THEN[\s\S]*provider mutations are paused/);
  assert.doesNotMatch(mutationFence.sql, /modikodi\./);
  assert.match(mutationFence.sql, /BEFORE INSERT OR UPDATE ON provider_collections/);
  const lifecycle = migrations.find(
    (migration) => migration.version === "0005_lifecycle_controls"
  );
  assert.match(lifecycle.sql, /history_generation bigint NOT NULL DEFAULT 1/);
  assert.match(lifecycle.sql, /ALTER TABLE devices/);
  assert.match(lifecycle.sql, /generation bigint NOT NULL DEFAULT 1/);
  assert.match(lifecycle.sql, /generation BETWEEN 1 AND 9007199254740991/);
  assert.match(lifecycle.sql, /deletion_state IN \('none', 'pending', 'deleted'\)/);
  assert.match(lifecycle.sql, /profiles_pending_erasure_idx/);
  const lifecycleSecurity = migrations.find(
    (migration) => migration.version === "0006_lifecycle_security_outbox"
  );
  assert.match(lifecycleSecurity.sql, /CREATE TABLE lifecycle_invalidations/);
  assert.match(lifecycleSecurity.sql, /erasure_next_attempt_at timestamptz/);
  assert.match(lifecycleSecurity.sql, /lifecycle_invalidations_eligible_idx/);
});

test("PostgreSQL appends durable subtitle manifest deletion state at 0007", async () => {
  const migrations = await readPostgresMigrations();
  const manifest = migrations.find(
    (migration) => migration.version === "0007_durable_subtitle_manifests"
  );
  assert.ok(manifest);
  assert.match(manifest.sql, /CREATE TABLE subtitle_object_manifests/);
  assert.match(manifest.sql, /CREATE TABLE subtitle_object_manifest_parts/);
  assert.match(manifest.sql, /upload_settlement_deadline/);
  assert.match(manifest.sql, /lease_token_hash/);
  assert.match(manifest.sql, /subtitle_object_manifests_eligible_idx/);
});

test("PostgreSQL appends generation-bound playback sessions and scrobble outbox at 0008", async () => {
  const migrations = await readPostgresMigrations();
  const playback = migrations.find(
    (migration) => migration.version === "0008_scrobble_dispatch"
  );
  assert.ok(playback);
  assert.match(playback.sql, /CREATE TABLE playback_source_revocations/);
  assert.match(playback.sql, /CREATE TABLE playback_sessions/);
  assert.match(playback.sql, /CREATE TABLE scrobble_dispatches/);
  assert.match(playback.sql, /status IN \('queued', 'leased', 'delivered', 'revoked'\)/);
  assert.match(playback.sql, /lease_token_hash char\(64\)/);
  assert.match(playback.sql, /scrobble_dispatches_claim_idx/);
});

test("PostgreSQL 0009 purges caller-selected history without rewinding history identity", async () => {
  const migrations = await readPostgresMigrations();
  const historyGrant = migrations.find(
    (migration) => migration.version === "0009_claim_bound_history"
  );
  assert.ok(historyGrant);
  assert.match(
    historyGrant.sql,
    /DELETE FROM scrobble_dispatches;\s+DELETE FROM playback_sessions;\s+DELETE FROM playback_source_revocations;\s+DELETE FROM cloud_history;/
  );
  assert.doesNotMatch(historyGrant.sql, /ALTER SEQUENCE cloud_history_change_seq RESTART/);
  assert.match(historyGrant.sql, /CREATE TABLE history_grant_revocations/);
  assert.match(historyGrant.sql, /CREATE TABLE history_grants/);
  assert.match(historyGrant.sql, /CREATE TABLE history_event_receipts/);
  assert.match(historyGrant.sql, /token_hash char\(64\) NOT NULL UNIQUE/);
  assert.match(historyGrant.sql, /token_envelope jsonb NOT NULL/);
  assert.match(historyGrant.sql, /\[1-8\]\[0-9a-f\]\{3\}/);
  assert.match(
    historyGrant.sql,
    /FOREIGN KEY \(grant_id, terminal_receipt_id\)[\s\S]*DEFERRABLE INITIALLY DEFERRED/
  );
  assert.doesNotMatch(historyGrant.sql, /grant_token|history_grant_token/);
  assert.doesNotMatch(historyGrant.sql, /INSERT INTO history_grants[\s\S]+SELECT/i);
});

test("PostgreSQL 0010 requires explicit history generations on scrobble dispatches", async () => {
  const migrations = await readPostgresMigrations();
  const dispatchFence = migrations.find(
    (migration) => migration.version === "0010_dispatch_history_generation"
  );
  assert.ok(dispatchFence);
  assert.match(dispatchFence.sql, /DELETE FROM scrobble_dispatches/);
  assert.match(
    dispatchFence.sql,
    /ADD COLUMN history_generation bigint NOT NULL CHECK \([\s\S]*BETWEEN 1 AND 9007199254740991/
  );
  assert.match(
    dispatchFence.sql,
    /ON scrobble_dispatches \(profile_id, history_generation, status\)/
  );
  assert.doesNotMatch(dispatchFence.sql, /^\s*history_generation\b[^\r\n]*\bDEFAULT\b/im);
});

test("PostgreSQL 0011 stores bounded claim and event HTTP receipts", async () => {
  const migrations = await readPostgresMigrations();
  const receipts = migrations.find(
    (migration) => migration.version === "0011_history_http_receipts"
  );
  assert.ok(receipts);
  assert.match(receipts.sql, /reservation_expires_at timestamptz/);
  assert.match(receipts.sql, /claim_response_status integer/);
  assert.match(receipts.sql, /claim_response_body bytea/);
  assert.match(receipts.sql, /response_status integer/);
  assert.match(receipts.sql, /response_body bytea/);
  assert.match(receipts.sql, /octet_length\(response_body\) <= 4194304/);
});

test("PostgreSQL lifecycle migrations safely upgrade already-applied immutable migrations", async () => {
  const migrations = await readPostgresMigrations();
  const database = new FakeTransactionalDatabase(
    migrations.slice(0, 3).map((migration) => ({
      checksum: migration.checksum,
      version: migration.version,
    }))
  );

  const result = await new PostgresMigrationRunner({ database }).run();
  assert.deepEqual(result, {
    applied: [
      "0004_provider_mutation_fence",
      "0005_lifecycle_controls",
      "0006_lifecycle_security_outbox",
      "0007_durable_subtitle_manifests",
      "0008_scrobble_dispatch",
      "0009_claim_bound_history",
      "0010_dispatch_history_generation",
      "0011_history_http_receipts",
    ],
    alreadyApplied: ["0001_initial", "0002_contract_parity", "0003_storage_correctness"],
    verified: [
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
    ],
  });
  assert.equal(database.calls.some((call) => call.text === migrations[0].sql), false);
  assert.equal(database.calls.some((call) => call.text === migrations[1].sql), false);
  assert.equal(database.calls.some((call) => call.text === migrations[2].sql), false);
  assert.equal(database.calls.some((call) => call.text === migrations[3].sql), true);
  assert.equal(database.calls.some((call) => call.text === migrations[4].sql), true);
  assert.equal(database.calls.some((call) => call.text === migrations[5].sql), true);
  assert.equal(database.calls.some((call) => call.text === migrations[6].sql), true);
  assert.equal(database.calls.some((call) => call.text === migrations[7].sql), true);
  assert.equal(database.calls.some((call) => call.text === migrations[8].sql), true);
  assert.equal(database.calls.some((call) => call.text === migrations[9].sql), true);
});

test("PostgreSQL migration ceiling verifies final bytes while applying only its prefix", async () => {
  const migrations = await readPostgresMigrations();
  const stored = migrations.slice(0, 3).map((migration) => ({
    checksum: migration.checksum,
    version: migration.version,
  }));
  const database = new FakeTransactionalDatabase(stored);

  const result = await new PostgresMigrationRunner({
    database,
    migrationCeiling: "0003_storage_correctness",
  }).run();
  assert.deepEqual(result, {
    applied: [],
    alreadyApplied: ["0001_initial", "0002_contract_parity", "0003_storage_correctness"],
    verified: migrations.map((migration) => migration.version),
  });
  assert.equal(database.calls.some((call) => call.text === migrations[3].sql), false);
  assert.equal(database.calls.some((call) => /0004_provider_mutation_fence/.test(String(call.values))), false);
});

test("PostgreSQL migration ceiling validates exact versions and history above the ceiling", async () => {
  const migrations = await readPostgresMigrations();
  const stored = migrations.map((migration) => ({
    checksum: migration.checksum,
    version: migration.version,
  }));
  const database = new FakeTransactionalDatabase(stored);
  const result = await new PostgresMigrationRunner({
    database,
    migrationCeiling: "0003_storage_correctness",
  }).run();
  assert.deepEqual(result.alreadyApplied, migrations.map((migration) => migration.version));
  assert.deepEqual(result.verified, migrations.map((migration) => migration.version));

  assert.throws(
    () => new PostgresMigrationRunner({ database, migrationCeiling: "0003.sql" }),
    /migrationCeiling must be an exact migration version/
  );
  const missingDatabase = new FakeTransactionalDatabase();
  await assert.rejects(
    () => new PostgresMigrationRunner({
      database: missingDatabase,
      migrationCeiling: "9999_missing",
    }).run(),
    (error) => error.code === "migration_ceiling_invalid" && error.migration === "9999_missing"
  );
  assert.equal(missingDatabase.transactionCount, 0);

  const drifted = stored.map((row) => ({ ...row }));
  drifted[3].checksum = "0".repeat(64);
  await assert.rejects(
    () => new PostgresMigrationRunner({
      database: new FakeTransactionalDatabase(drifted),
      migrationCeiling: "0003_storage_correctness",
    }).run(),
    (error) => error.code === "migration_checksum_mismatch"
  );
});

function createProviderProtocolDatabase(options = {}) {
  const calls = [];
  const installed = options.installed !== false;
  const state = {
    enforcement_active: false,
    mutations_paused: false,
    activated_at: null,
    paused_at: null,
    activation_fence: null,
    ...(options.state || {}),
  };
  let allocatorFence = options.allocatorFence || "41";
  const database = {
    calls,
    state,
    async transaction(work) {
      return work({
        async query(text, values) {
          calls.push({ text, values });
          if (/set_config\('lock_timeout'/.test(text)) return { rowCount: 1, rows: [{}] };
          if (/pg_advisory_xact_lock/.test(text)) return { rowCount: 1, rows: [{}] };
          if (/^LOCK TABLE provider_collections/.test(text)) return { rowCount: 0, rows: [] };
          if (/to_regclass\('provider_mutation_protocol'\)/.test(text)) {
            return {
              rowCount: 1,
              rows: [{ protocol_installed: installed, allocator_installed: installed }],
            };
          }
          if (/CROSS JOIN provider_mutation_fence_counter/.test(text)) {
            return installed
              ? { rowCount: 1, rows: [{ ...state, allocator_fence: allocatorFence }] }
              : { rowCount: 0, rows: [] };
          }
          if (/FROM provider_mutation_protocol[\s\S]*FOR UPDATE/.test(text)) {
            return installed ? { rowCount: 1, rows: [{ ...state }] } : { rowCount: 0, rows: [] };
          }
          if (/FROM provider_mutation_fence_counter[\s\S]*FOR UPDATE/.test(text)) {
            return installed
              ? { rowCount: 1, rows: [{ allocator_fence: allocatorFence }] }
              : { rowCount: 0, rows: [] };
          }
          if (/SET mutations_paused = true/.test(text)) {
            state.mutations_paused = true;
            state.paused_at = new Date(1000);
            return { rowCount: 1, rows: [{ paused_at: state.paused_at }] };
          }
          if (/SET mutations_paused = false, paused_at = NULL/.test(text)) {
            state.mutations_paused = false;
            state.paused_at = null;
            return { rowCount: 1, rows: [] };
          }
          if (/UPDATE provider_mutation_fence_counter/.test(text)) {
            allocatorFence = options.rebasedFence || allocatorFence;
            return { rowCount: 1, rows: [{ mutation_fence: allocatorFence }] };
          }
          if (/SET enforcement_active = true/.test(text)) {
            assert.deepEqual(values, [allocatorFence]);
            state.enforcement_active = true;
            state.mutations_paused = false;
            state.activated_at = new Date(2000);
            state.paused_at = null;
            state.activation_fence = allocatorFence;
            return { rowCount: 1, rows: [{ activated_at: state.activated_at }] };
          }
          throw new Error("unexpected protocol query: " + text);
        },
      });
    },
  };
  return database;
}

test("provider mutation pause is bounded, ordered, and idempotent", async () => {
  const database = createProviderProtocolDatabase();
  assert.deepEqual(await pauseProviderMutations({ database, timeoutMs: 1234 }), {
    paused: true,
    changed: true,
  });
  assert.match(database.calls[0].text, /set_config\('lock_timeout'/);
  assert.equal(
    database.calls[1].text,
    "SELECT pg_advisory_xact_lock($1::integer, $2::integer)"
  );
  assert.equal(
    database.calls[2].text,
    "LOCK TABLE provider_collections IN ACCESS EXCLUSIVE MODE"
  );
  assert.deepEqual(database.calls[0].values, ["1234ms"]);
  assert.deepEqual(database.calls[1].values, [0x4a554d50, 0x47415445]);
  assert.match(database.calls[3].text, /provider_mutation_protocol[\s\S]*FOR UPDATE/);
  assert.match(database.calls[4].text, /provider_mutation_fence_counter[\s\S]*FOR UPDATE/);
  assert.match(database.calls[5].text, /SET mutations_paused = true/);

  const beforeSecondPause = database.calls.length;
  assert.deepEqual(await pauseProviderMutations(database), { paused: true, changed: false });
  assert.equal(
    database.calls.slice(beforeSecondPause).some((call) => /UPDATE provider_mutation_protocol/.test(call.text)),
    false
  );
});

test("activation pause never pauses an already active provider protocol", async () => {
  const expanded = createProviderProtocolDatabase();
  assert.deepEqual(await pauseProviderMutationsForActivation(expanded), {
    paused: true,
    changed: true,
  });
  assert.match(expanded.calls.at(-1).text, /enforcement_active = false/);

  const active = createProviderProtocolDatabase({
    allocatorFence: "43",
    state: {
      enforcement_active: true,
      activated_at: new Date(2000),
      activation_fence: "43",
    },
  });
  assert.deepEqual(await pauseProviderMutationsForActivation(active), {
    paused: false,
    changed: false,
  });
  assert.equal(
    active.calls.some((call) => /SET mutations_paused = true/.test(call.text)),
    false
  );
});

test("provider mutation resume is idempotent before and after activation", async () => {
  const database = createProviderProtocolDatabase({
    state: { mutations_paused: true, paused_at: new Date(1000) },
  });
  assert.deepEqual(await resumeProviderMutations(database), { resumed: true, changed: true });
  assert.deepEqual(await resumeProviderMutations(database), { resumed: false, changed: false });

  const active = createProviderProtocolDatabase({
    allocatorFence: "43",
    state: {
      enforcement_active: true,
      activated_at: new Date(2000),
      activation_fence: "43",
    },
  });
  assert.deepEqual(await pauseProviderMutations(active), { paused: true, changed: true });
  assert.deepEqual(await resumeProviderMutations(active), { resumed: true, changed: true });
  assert.deepEqual(await resumeProviderMutations(active), { resumed: false, changed: false });
});

test("provider mutation activation requires pause, rebases, persists its floor, and unpauses", async () => {
  const unpaused = createProviderProtocolDatabase();
  await assert.rejects(
    () => activateProviderMutationProtocol(unpaused),
    (error) => error.code === "provider_mutations_not_paused"
  );
  assert.equal(
    unpaused.calls.some((call) => /UPDATE provider_mutation_fence_counter/.test(call.text)),
    false
  );

  const database = createProviderProtocolDatabase({
    allocatorFence: "41",
    rebasedFence: "43",
    state: { mutations_paused: true, paused_at: new Date(1000) },
  });
  assert.deepEqual(await activateProviderMutationProtocol(database), {
    activated: true,
    mutationFence: "43",
    activationFence: "43",
  });
  const texts = database.calls.map((call) => call.text);
  const allocatorLock = texts.findIndex((text) => /FROM provider_mutation_fence_counter[\s\S]*FOR UPDATE/.test(text));
  const rebase = texts.findIndex((text) => /UPDATE provider_mutation_fence_counter/.test(text));
  const activate = texts.findIndex((text) => /SET enforcement_active = true/.test(text));
  assert.ok(allocatorLock >= 0 && allocatorLock < rebase && rebase < activate);
  assert.equal(database.state.activation_fence, "43");
  assert.equal(database.state.mutations_paused, false);

  assert.deepEqual(await activateProviderMutationProtocol(database), {
    activated: false,
    mutationFence: "43",
    activationFence: "43",
  });
});

test("provider mutation startup attestations bind legacy and fenced modes to protocol state", async () => {
  const absent = createProviderProtocolDatabase({ installed: false });
  assert.deepEqual(await readProviderMutationProtocolState(absent), {
    installed: false,
    phase: "legacy",
    enforcementActive: false,
    mutationsPaused: false,
    activatedAt: null,
    pausedAt: null,
    activationFence: null,
    allocatorFence: null,
  });
  assert.equal((await attestProviderMutationMode(absent, "legacy")).phase, "legacy");
  await assert.rejects(
    () => attestProviderMutationMode(absent, "fenced"),
    (error) => error.code === "provider_mutation_protocol_mismatch"
  );

  const active = createProviderProtocolDatabase({
    allocatorFence: "50",
    state: {
      enforcement_active: true,
      activated_at: new Date(2000),
      activation_fence: "49",
    },
  });
  assert.equal((await attestProviderMutationMode(active, {
    mode: "fenced",
    migrationCeiling: "0004_provider_mutation_fence",
  })).phase, "active");
  await assert.rejects(
    () => attestProviderMutationMode(active, {
      mode: "fenced",
      migrationCeiling: "0003_storage_correctness",
    }),
    (error) => error.code === "provider_mutation_protocol_mismatch"
  );
  await assert.rejects(
    () => attestProviderMutationMode(active, "legacy"),
    (error) => error.code === "provider_mutation_protocol_mismatch"
  );

  const paused = createProviderProtocolDatabase({
    state: { mutations_paused: true, paused_at: new Date(1000) },
  });
  assert.equal((await attestProviderMutationMode(paused, "legacy")).phase, "paused");
  assert.equal((await attestProviderMutationMode(paused, {
    mode: "fenced",
    migrationCeiling: "0004_provider_mutation_fence",
  })).phase, "paused");

  const expanded = createProviderProtocolDatabase();
  await assert.rejects(
    () => attestProviderMutationMode(expanded, "fenced"),
    (error) => error.code === "provider_mutation_protocol_mismatch"
  );
});

test("direct PostgreSQL migration timeout destroys a blocked advisory-lock lease", async () => {
  const directory = path.resolve("in-memory-postgres-migrations");
  const migrationFs = memoryMigrationFs({ "0001_example.sql": "SELECT 1;\n" });
  let resolveAdvisoryLock;
  let releaseError = null;
  let releaseCount = 0;
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/pg_advisory_xact_lock/.test(text)) {
        return new Promise((resolve) => {
          resolveAdvisoryLock = resolve;
        });
      }
      return { rowCount: 0, rows: [] };
    },
    release(error) {
      releaseCount += 1;
      releaseError = error;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };

  const startedAt = Date.now();
  await assert.rejects(
    runPostgresMigrations({
      pool,
      directory,
      fs: migrationFs,
      migrationTimeoutMs: 30,
    }),
    (error) =>
      error.code === "storage_timeout" &&
      error.phase === "PostgreSQL migration" &&
      error.timeoutMs === 30
  );
  assert.ok(Date.now() - startedAt < 1000, "advisory lock timeout was not active");
  assert.equal(releaseCount, 1);
  assert.equal(releaseError.code, "storage_timeout");
  assert.deepEqual(calls.map((call) => call.text), [
    "BEGIN",
    "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)",
    "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
  ]);
  assert.match(calls[1].values[0], /^[1-9][0-9]*ms$/);

  resolveAdvisoryLock({ rowCount: 1, rows: [{}] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.some((call) => call.text === "COMMIT"), false);
});

test("direct PostgreSQL migration timeout prevents a hanging query from resuming late", async () => {
  const migrationSql = "CREATE TABLE late_work (id integer);\n";
  const directory = path.resolve("in-memory-postgres-migrations");
  const migrationFs = memoryMigrationFs({ "0001_example.sql": migrationSql });
  let resolveMigration;
  let releaseCount = 0;
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (/SELECT version, checksum FROM schema_migrations/.test(text)) {
        return { rowCount: 0, rows: [] };
      }
      if (text === migrationSql) {
        return new Promise((resolve) => {
          resolveMigration = resolve;
        });
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      releaseCount += 1;
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      return { rowCount: 0, rows: [] };
    },
  };

  await assert.rejects(
    runPostgresMigrations({
      pool,
      directory,
      fs: migrationFs,
      migrationTimeoutMs: 30,
    }),
    (error) => error.code === "storage_timeout" && error.timeoutMs === 30
  );
  assert.equal(releaseCount, 1);
  assert.equal(
    calls.some((call) => /INSERT INTO schema_migrations/.test(call.text)),
    false
  );
  assert.equal(calls.some((call) => call.text === "COMMIT"), false);

  resolveMigration({ rowCount: 0, rows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    calls.some((call) => /INSERT INTO schema_migrations/.test(call.text)),
    false
  );
  assert.equal(calls.some((call) => call.text === "COMMIT"), false);
});
