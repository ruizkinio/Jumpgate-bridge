"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PostgresDatabase } = require("../lib/storage/postgres");

class FakeClient {
  constructor(options = {}) {
    this.calls = [];
    this.released = false;
    this._fail = options.fail || null;
  }

  async query(text, values) {
    this.calls.push({ text, values });
    if (this._fail && this._fail(text)) throw new Error("query failed: " + text);
    return { rowCount: 0, rows: [] };
  }

  release() {
    this.released = true;
  }
}

class FakePool {
  constructor(client = new FakeClient()) {
    this.client = client;
    this.calls = [];
    this.connectCount = 0;
  }

  async query(text, values) {
    this.calls.push({ text, values });
    return { rowCount: 1, rows: [{ value: 1 }] };
  }

  async connect() {
    this.connectCount += 1;
    return this.client;
  }
}

test("PostgresDatabase delegates pool queries and commits a released client transaction", async () => {
  const client = new FakeClient();
  const pool = new FakePool(client);
  const database = new PostgresDatabase({ pool });

  assert.deepEqual(await database.query("SELECT $1::integer AS value", [1]), {
    rowCount: 1,
    rows: [{ value: 1 }],
  });
  const value = await database.transaction(async (transaction) => {
    assert.equal(transaction, client);
    await transaction.query("SELECT 2");
    return "committed";
  });

  assert.equal(value, "committed");
  assert.equal(pool.connectCount, 1);
  assert.deepEqual(client.calls.map((call) => call.text), ["BEGIN", "SELECT 2", "COMMIT"]);
  assert.equal(client.released, true);
});

test("PostgresDatabase rolls back and releases when transaction work fails", async () => {
  const client = new FakeClient();
  const database = new PostgresDatabase({ pool: new FakePool(client) });
  const operationError = new Error("write rejected");

  await assert.rejects(
    () =>
      database.transaction(async (transaction) => {
        await transaction.query("INSERT INTO example VALUES (1)");
        throw operationError;
      }),
    (error) => error === operationError
  );
  assert.deepEqual(client.calls.map((call) => call.text), [
    "BEGIN",
    "INSERT INTO example VALUES (1)",
    "ROLLBACK",
  ]);
  assert.equal(client.released, true);
});

test("PostgresDatabase preserves a commit failure and attempts rollback", async () => {
  const client = new FakeClient({ fail: (text) => text === "COMMIT" });
  const database = new PostgresDatabase({ pool: new FakePool(client) });

  await assert.rejects(() => database.transaction(async () => "value"), /query failed: COMMIT/);
  assert.deepEqual(client.calls.map((call) => call.text), ["BEGIN", "COMMIT", "ROLLBACK"]);
  assert.equal(client.released, true);
});

test("PostgresDatabase abort destroys the leased transaction before it can commit", async () => {
  const abortError = new Error("migration deadline reached");
  abortError.code = "storage_timeout";
  let rejectBlockedQuery;
  const client = new FakeClient();
  client.releaseCount = 0;
  client.query = async function query(text, values) {
    this.calls.push({ text, values });
    if (text === "APPLY MIGRATION") {
      return new Promise((_resolve, reject) => {
        rejectBlockedQuery = reject;
      });
    }
    return { rowCount: 0, rows: [] };
  };
  client.release = function release(error) {
    this.releaseCount += 1;
    this.released = true;
    if (rejectBlockedQuery) rejectBlockedQuery(error);
  };
  const database = new PostgresDatabase({ pool: new FakePool(client) });
  const controller = new AbortController();
  const transaction = database.transaction(
    async (connection) => {
      await connection.query("APPLY MIGRATION");
    },
    { signal: controller.signal }
  );

  while (!rejectBlockedQuery) await Promise.resolve();
  controller.abort(abortError);
  await assert.rejects(transaction, (error) => error === abortError);
  assert.deepEqual(client.calls.map((call) => call.text), ["BEGIN", "APPLY MIGRATION"]);
  assert.equal(client.releaseCount, 1);
});

test("PostgresDatabase checks the migration deadline immediately before commit", async () => {
  const client = new FakeClient();
  const database = new PostgresDatabase({ pool: new FakePool(client) });
  const timeout = new Error("migration deadline reached");
  timeout.code = "storage_timeout";

  await assert.rejects(
    database.transaction(
      async (transaction) => {
        await transaction.query("APPLY MIGRATION");
      },
      {
        beforeCommit() {
          throw timeout;
        },
      }
    ),
    (error) => error === timeout
  );
  assert.deepEqual(client.calls.map((call) => call.text), [
    "BEGIN",
    "APPLY MIGRATION",
    "ROLLBACK",
  ]);
  assert.equal(client.released, true);
});
