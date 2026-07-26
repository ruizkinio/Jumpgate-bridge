"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { EnvelopeCrypto } = require("../lib/storage/envelope-crypto");
const { createMemoryDurableRepositories } = require("../lib/storage/factory");
const { MemoryOAuthCredentialRepository } = require(
  "../lib/storage/memory-durable-repositories"
);
const { TokenService } = require("../lib/storage/token-service");
const {
  PostgresOAuthCredentialRepository,
} = require("../lib/storage/postgres/oauth-credential-repository");
const { createSqliteRepositories } = require("../lib/storage/sqlite");

let Database = null;
try {
  Database = require("better-sqlite3");
} catch (_error) {
  // The shared matrix still covers every non-native adapter without the optional driver.
}

const PROFILE_ID = "profile_json_parity";
const PROVIDER = "realdebrid";

function tokenService() {
  return new TokenService({
    pepper: Buffer.alloc(32, 0x61),
    randomBytes: (length) => Buffer.alloc(length, 0x42),
  });
}

function countingEnvelopeCrypto() {
  const inner = new EnvelopeCrypto({
    primaryKeyId: "json-parity-key",
    keys: { "json-parity-key": Buffer.alloc(32, 0x51) },
    randomBytes: (length) => Buffer.alloc(length, 0x31),
  });
  let encryptions = 0;
  return {
    crypto: {
      decryptJson: inner.decryptJson.bind(inner),
      encryptJson(value, purpose) {
        encryptions += 1;
        return inner.encryptJson(value, purpose);
      },
    },
    encryptions() {
      return encryptions;
    },
  };
}

function invalidJsonGraphs() {
  return [
    {
      label: "NUL",
      pattern: /NUL/,
      make: () => ({ value: "bad\u0000value" }),
    },
    {
      label: "lone surrogate",
      pattern: /lone UTF-16 surrogate/,
      make: () => ({ value: "\ud800" }),
    },
    {
      label: "unsafe integer",
      pattern: /unsafe integer/,
      make: () => ({ value: Number.MAX_SAFE_INTEGER + 1 }),
    },
    {
      label: "cycle",
      pattern: /cycle/,
      make() {
        const value = {};
        value.self = value;
        return { value };
      },
    },
    {
      label: "proxy",
      pattern: /non-plain object/,
      make: () => ({
        value: new Proxy(
          { hidden: true },
          {
            getOwnPropertyDescriptor() {
              throw new Error("proxy trap must not run");
            },
            ownKeys() {
              throw new Error("proxy trap must not run");
            },
          }
        ),
      }),
    },
    {
      label: "non-plain object",
      pattern: /non-plain object/,
      make: () => ({ value: new Map([["key", "value"]]) }),
    },
    {
      label: "Date coercion",
      pattern: /non-plain object/,
      make: () => ({ value: new Date(0) }),
    },
    {
      label: "sparse array",
      pattern: /unsupported array/,
      make: () => ({ value: new Array(1) }),
    },
    {
      label: "accessor",
      pattern: /unsupported property/,
      make() {
        let reads = 0;
        const value = {};
        Object.defineProperty(value, "secret", {
          enumerable: true,
          get() {
            reads += 1;
            return "coerced";
          },
        });
        return {
          value,
          verify() {
            assert.equal(reads, 0, "accessor was evaluated");
          },
        };
      },
    },
    {
      label: "symbol value",
      pattern: /unsupported value/,
      make: () => ({ value: Symbol("secret") }),
    },
    {
      label: "symbol property",
      pattern: /symbol property/,
      make() {
        const value = {};
        value[Symbol("secret")] = true;
        return { value };
      },
    },
    {
      label: "undefined",
      pattern: /unsupported value/,
      make: () => ({ value: undefined }),
    },
    {
      label: "function",
      pattern: /unsupported value/,
      make: () => ({ value() {} }),
    },
  ];
}

function acceptedGraph() {
  const nullPrototype = Object.create(null);
  nullPrototype.value = "ok";
  return {
    emoji: "\ud83d\ude00",
    fraction: 1.25,
    maximumSafeInteger: Number.MAX_SAFE_INTEGER,
    nested: [null, true, nullPrototype],
  };
}

class OAuthFakeDatabase {
  constructor() {
    this.calls = [];
    this.row = null;
    this.transactionCount = 0;
  }

  async transaction(work) {
    this.transactionCount += 1;
    return work(this);
  }

  async query(text, values) {
    this.calls.push({ text, values });
    if (/SELECT id, status FROM profiles/.test(text)) {
      return { rowCount: 1, rows: [{ id: PROFILE_ID, status: "active" }] };
    }
    if (/SELECT \* FROM oauth_credentials[\s\S]*FOR UPDATE/.test(text)) {
      return { rowCount: this.row ? 1 : 0, rows: this.row ? [this.row] : [] };
    }
    if (/INSERT INTO oauth_credentials/.test(text)) {
      this.row = {
        schema_version: 1,
        profile_id: values[0],
        provider: values[1],
        credential_envelope: values[2],
        revision: 1,
        created_at: values[3],
        updated_at: values[3],
      };
      return { rowCount: 1, rows: [this.row] };
    }
    if (/JOIN profiles/.test(text)) {
      return { rowCount: this.row ? 1 : 0, rows: this.row ? [this.row] : [] };
    }
    throw new Error("unexpected PostgreSQL fake query: " + text);
  }
}

function directMemoryAdapter() {
  const envelope = countingEnvelopeCrypto();
  const repository = new MemoryOAuthCredentialRepository({
    envelopeCrypto: envelope.crypto,
    clock: () => 1000,
  });
  return {
    name: "direct memory",
    repository,
    encryptions: envelope.encryptions,
    mutationCount: () => repository.storageSnapshot().length,
  };
}

async function factoryMemoryAdapter() {
  const envelope = countingEnvelopeCrypto();
  const repositories = createMemoryDurableRepositories({
    tokenService: tokenService(),
    envelopeCrypto: envelope.crypto,
  }, {
    clock: () => 1000,
    profileIdFactory: () => PROFILE_ID,
  });
  const created = await repositories.profiles.create({ displayName: "Parity" });
  assert.equal(created.profile.id, PROFILE_ID);
  return {
    name: "factory memory",
    repository: repositories.oauthCredentials,
    encryptions: envelope.encryptions,
    mutationCount: () => repositories.oauthCredentials.storageSnapshot().length,
  };
}

async function sqliteAdapter(t) {
  if (!Database) return null;
  const envelope = countingEnvelopeCrypto();
  const database = new Database(":memory:");
  t.after(() => database.close());
  const repositories = createSqliteRepositories(database, {
    tokenService: tokenService(),
    envelopeCrypto: envelope.crypto,
    clock: () => 1000,
    idFactory: () => PROFILE_ID,
  });
  const created = await repositories.profiles.create({ displayName: "Parity" });
  assert.equal(created.profile.id, PROFILE_ID);
  return {
    name: "SQLite",
    repository: repositories.oauthCredentials,
    encryptions: envelope.encryptions,
    mutationCount: () => repositories.oauthCredentials.storageSnapshot().length,
  };
}

function postgresFakeAdapter() {
  const envelope = countingEnvelopeCrypto();
  const database = new OAuthFakeDatabase();
  return {
    name: "PostgreSQL fake",
    repository: new PostgresOAuthCredentialRepository({
      database,
      envelopeCrypto: envelope.crypto,
      clock: () => 1000,
    }),
    encryptions: envelope.encryptions,
    mutationCount: () => (database.row ? 1 : 0),
    transactionCount: () => database.transactionCount,
  };
}

async function assertAdapterParity(adapter) {
  for (const invalid of invalidJsonGraphs()) {
    const instance = invalid.make();
    await assert.rejects(
      adapter.repository.put(
        PROFILE_ID,
        PROVIDER,
        { payload: instance.value },
        0
      ),
      invalid.pattern,
      adapter.name + ": " + invalid.label
    );
    if (instance.verify) instance.verify();
    assert.equal(adapter.mutationCount(), 0, adapter.name + " mutated on " + invalid.label);
    assert.equal(adapter.encryptions(), 0, adapter.name + " encrypted " + invalid.label);
  }

  if (adapter.transactionCount) {
    assert.equal(adapter.transactionCount(), 0, adapter.name + " opened an invalid transaction");
  }

  const accepted = acceptedGraph();
  const stored = await adapter.repository.put(PROFILE_ID, PROVIDER, accepted, 0);
  assert.deepEqual(stored.credentials, {
    emoji: "\ud83d\ude00",
    fraction: 1.25,
    maximumSafeInteger: Number.MAX_SAFE_INTEGER,
    nested: [null, true, { value: "ok" }],
  });
  assert.equal(adapter.mutationCount(), 1);
  assert.equal(adapter.encryptions(), 1);
}

test("strict JSON graph domain is identical across durable repository adapters", async (t) => {
  const adapters = [
    directMemoryAdapter(),
    await factoryMemoryAdapter(),
    postgresFakeAdapter(),
  ];
  const sqlite = await sqliteAdapter(t);
  if (sqlite) adapters.splice(2, 0, sqlite);

  for (const adapter of adapters) {
    await t.test(adapter.name, () => assertAdapterParity(adapter));
  }
});

test("PostgreSQL JSON-domain compatibility path re-exports the generic module", () => {
  assert.equal(
    require("../lib/storage/postgres/json-domain"),
    require("../lib/storage/json-domain")
  );
});
