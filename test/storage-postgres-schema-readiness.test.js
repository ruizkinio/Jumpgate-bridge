"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  attestPostgresSchemaReadiness,
  REQUIRED_DISPATCH_HISTORY_INDEX,
  REQUIRED_HISTORY_RESERVATION_INDEX,
  REQUIRED_POSTGRES_SCHEMA_MIGRATION,
} = require("../lib/storage/postgres");
const { loadStorageConfig } = require("../lib/storage/config");
const { createStorageRuntime } = require("../lib/storage/factory");

function safeRow(overrides = {}) {
  return {
    history_generation_column_safe: true,
    history_generation_index_safe: true,
    history_http_columns_safe: true,
    history_http_constraints_safe: true,
    history_reservation_index_safe: true,
    migration_applied: true,
    ...overrides,
  };
}

function fakeDatabase(row = safeRow()) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows: row === null ? [] : [row] };
    },
  };
}

function runtimeConfig() {
  return loadStorageConfig({
    NODE_ENV: "development",
    JUMPGATE_DURABLE_DRIVER: "postgres",
    JUMPGATE_TTL_DRIVER: "memory",
    DATABASE_URL: "postgresql://bridge:secret@db.example:5432/jumpgate",
    JUMPGATE_PROVIDER_MUTATION_MODE: "legacy",
    JUMPGATE_POSTGRES_MIGRATION_CEILING: REQUIRED_POSTGRES_SCHEMA_MIGRATION,
    JUMPGATE_TOKEN_PEPPER: Buffer.alloc(32, 0x31).toString("base64url"),
    JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "schema-readiness-key",
    JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([{
      id: "schema-readiness-key",
      key: Buffer.alloc(32, 0x41).toString("base64url"),
    }]),
  });
}

function runtimeDatabase(initialRow) {
  let row = initialRow;
  const calls = [];
  return {
    calls,
    setRow(nextRow) {
      row = nextRow;
    },
    async query(text, values) {
      calls.push({ text, values });
      if (text === "SELECT 1 AS ready") return { rows: [{ ready: 1 }] };
      if (text.includes("WITH target_table AS")) {
        return { rows: row === null ? [] : [row] };
      }
      throw new Error("unexpected PostgreSQL runtime query");
    },
    async transaction(work) {
      return work(this);
    },
  };
}

function runtimeOptions(database, overrides = {}) {
  return {
    postgresDatabase: database,
    runPostgresMigrations: async () => ({
      applied: [],
      alreadyApplied: [REQUIRED_POSTGRES_SCHEMA_MIGRATION],
      verified: [REQUIRED_POSTGRES_SCHEMA_MIGRATION],
    }),
    attestProviderMutationMode: async () => ({ mode: "legacy" }),
    ...overrides,
  };
}

function schemaAttestationCalls(database) {
  return database.calls.filter((call) => call.text.includes("WITH target_table AS"));
}

test("PostgreSQL schema readiness requires the exact migration, column, and index shape", async () => {
  const database = fakeDatabase();
  assert.deepEqual(await attestPostgresSchemaReadiness(database), {
    historyGenerationColumn: true,
    historyGenerationIndex: REQUIRED_DISPATCH_HISTORY_INDEX,
    historyHttpColumns: true,
    historyHttpConstraints: true,
    historyReservationIndex: REQUIRED_HISTORY_RESERVATION_INDEX,
    migration: REQUIRED_POSTGRES_SCHEMA_MIGRATION,
  });
  assert.equal(database.calls.length, 1);
  assert.deepEqual(database.calls[0].values, [REQUIRED_POSTGRES_SCHEMA_MIGRATION]);
  assert.match(database.calls[0].text, /attnotnull = true/);
  assert.match(database.calls[0].text, /column_default IS NULL/);
  assert.match(database.calls[0].text, /data_type = 'bigint'/);
  assert.match(database.calls[0].text, /indisvalid = true/);
  assert.match(database.calls[0].text, /indisready = true/);
  assert.match(database.calls[0].text, /key_columns = ARRAY\['profile_id', 'history_generation', 'status'\]::name\[\]/);
  assert.match(database.calls[0].text, /claim_response_body/);
  assert.match(database.calls[0].text, /history_event_receipts_http_shape/);
  assert.match(database.calls[0].text, /key_columns = ARRAY\['reservation_expires_at', 'created_at', 'grant_id'\]::name\[\]/);
});

for (const [name, row] of [
  ["missing migration", safeRow({ migration_applied: false })],
  ["unsafe column", safeRow({ history_generation_column_safe: false })],
  ["unsafe index", safeRow({ history_generation_index_safe: false })],
  ["unsafe receipt columns", safeRow({ history_http_columns_safe: false })],
  ["unsafe receipt constraints", safeRow({ history_http_constraints_safe: false })],
  ["unsafe reservation index", safeRow({ history_reservation_index_safe: false })],
  ["missing result", null],
  ["malformed booleans", safeRow({ migration_applied: "true" })],
]) {
  test("PostgreSQL schema readiness fails closed for " + name, async () => {
    await assert.rejects(
      () => attestPostgresSchemaReadiness(fakeDatabase(row)),
      (error) => error.code === "postgres_schema_not_ready"
    );
  });
}

test("PostgreSQL schema readiness validates the query target and propagates transport errors", async () => {
  await assert.rejects(() => attestPostgresSchemaReadiness({}), /database is required/);
  const failure = new Error("controlled catalog failure");
  await assert.rejects(
    () => attestPostgresSchemaReadiness({ async query() { throw failure; } }),
    (error) => error === failure
  );
});

test("PostgreSQL runtime rejects an unsafe schema during startup", async () => {
  const database = runtimeDatabase(safeRow({ migration_applied: false }));
  await assert.rejects(
    () => createStorageRuntime(runtimeConfig(), runtimeOptions(database)),
    (error) => error.code === "postgres_schema_not_ready"
  );
  assert.equal(schemaAttestationCalls(database).length, 1);
});

test("PostgreSQL runtime re-attests schema safety on every readiness probe", async (t) => {
  const database = runtimeDatabase(safeRow());
  const runtime = await createStorageRuntime(runtimeConfig(), runtimeOptions(database));
  t.after(() => runtime.close());
  assert.equal(schemaAttestationCalls(database).length, 1);

  database.setRow(safeRow({ history_generation_index_safe: false }));
  await assert.rejects(
    () => runtime.ready(),
    (error) => error.code === "postgres_schema_not_ready"
  );
  assert.equal(schemaAttestationCalls(database).length, 2);

  database.setRow(safeRow());
  assert.deepEqual(await runtime.healthCheck(), {
    status: "ready",
    durableDriver: "postgres",
    ttlDriver: "memory",
  });
  assert.equal(schemaAttestationCalls(database).length, 3);
});

test("PostgreSQL runtime validates an injected schema attestor", async () => {
  const database = runtimeDatabase(safeRow());
  await assert.rejects(
    () => createStorageRuntime(
      runtimeConfig(),
      runtimeOptions(database, { attestPostgresSchemaReadiness: null })
    ),
    /PostgreSQL schema readiness attestation must be a function/
  );
});
