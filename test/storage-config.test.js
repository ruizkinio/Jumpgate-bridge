"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const { decodeSecret, loadStorageConfig, parseKeyring } = require("../lib/storage/config");

const PEPPER = Buffer.alloc(32, 0x31).toString("base64url");
const KEY_OLD = Buffer.alloc(32, 0x41).toString("base64");
const KEY_NEW = Buffer.alloc(32, 0x42).toString("base64url");
const SUBTITLE_KEY_OLD = Buffer.alloc(32, 0x51).toString("base64url");
const SUBTITLE_KEY_NEW = Buffer.alloc(32, 0x52).toString("base64url");
const SUBTITLE_S3_ACCESS_KEY = "test-subtitle-access-key-never-reflect";
const SUBTITLE_S3_SECRET = "test-subtitle-secret-never-reflect";

function secureEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://bridge:secret@db.example:5432/jumpgate?sslmode=require",
    REDIS_URL: "rediss://:secret@redis.example:6380/0",
    JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
    JUMPGATE_POSTGRES_MIGRATION_CEILING: "0003_storage_correctness",
    JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
    JUMPGATE_SUBTITLE_S3_BUCKET: "jumpgate-test-subtitles",
    JUMPGATE_SUBTITLE_S3_REGION: "auto",
    JUMPGATE_SUBTITLE_S3_ENDPOINT: "https://fly.storage.tigris.dev",
    JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE: "0",
    JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: "strict",
    JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID: SUBTITLE_S3_ACCESS_KEY,
    JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY: SUBTITLE_S3_SECRET,
    JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID: "subtitle-new",
    JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: JSON.stringify([
      { id: "subtitle-old", key: SUBTITLE_KEY_OLD },
      { id: "subtitle-new", key: SUBTITLE_KEY_NEW },
    ]),
    JUMPGATE_TOKEN_PEPPER: PEPPER,
    JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "key-new",
    JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([
      { id: "key-old", key: KEY_OLD },
      { id: "key-new", key: KEY_NEW },
    ]),
    ...overrides,
  };
}

test("production storage defaults to PostgreSQL and Redis with purpose-specific key material", () => {
  const config = loadStorageConfig(secureEnvironment());

  assert.equal(config.durableDriver, "postgres");
  assert.equal(config.ttlDriver, "redis");
  assert.equal(config.providerMutationMode, "fenced");
  assert.equal(config.postgresMigrationCeiling, "0003_storage_correctness");
  assert.equal(config.redisPlaybackWriteVersion, "4");
  assert.equal(config.subtitleS3.bucket, "jumpgate-test-subtitles");
  assert.equal(config.subtitleS3.endpoint, "https://fly.storage.tigris.dev");
  assert.equal(config.subtitleS3.region, "auto");
  assert.equal(config.subtitleS3.forcePathStyle, false);
  assert.equal(config.subtitleS3.privacyMode, "strict");
  assert.equal(
    config.subtitleS3.permanentErasureMode,
    "blocked-tigris-provider-confirmation-required"
  );
  assert.equal(config.subtitleObjectKeys.currentKeyId, "subtitle-new");
  assert.equal(config.subtitleObjectKeys.keyring.length, 2);
  assert.equal(config.envelopeKeys.size, 2);
  assert.equal(config.primaryEnvelopeKeyId, "key-new");
  assert.deepEqual(config.tokenPepper, Buffer.alloc(32, 0x31));
  assert.deepEqual(config.envelopeKeys.get("key-old"), Buffer.alloc(32, 0x41));
  assert.equal(config.ephemeralSecurityMaterial, false);
  assert.equal(config.legacyConfigSecret, null);
});

test("production accepts only the documented Tigris exact-version purge mode", () => {
  const config = loadStorageConfig(
    secureEnvironment({
      JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
    })
  );
  assert.equal(config.subtitleS3.permanentErasureMode, "tigris-version-purge-v1");
  assert.throws(
    () =>
      loadStorageConfig(
        secureEnvironment({
          JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "operator-asserted",
        })
      ),
    /JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE is invalid/
  );
});

test("production cannot downgrade to process-local storage", () => {
  assert.throws(
    () => loadStorageConfig(secureEnvironment({ JUMPGATE_DURABLE_DRIVER: "memory" })),
    /production requires PostgreSQL durable storage and Redis TTL storage/
  );
  assert.throws(
    () => loadStorageConfig(secureEnvironment({ JUMPGATE_TTL_DRIVER: "memory" })),
    /production requires PostgreSQL durable storage and Redis TTL storage/
  );
});

test("production cannot downgrade source mutation or playback protocols", () => {
  assert.throws(
    () => loadStorageConfig(secureEnvironment({ JUMPGATE_PROVIDER_MUTATION_MODE: "legacy" })),
    /production requires fenced provider mutation/
  );
  assert.throws(
    () => loadStorageConfig(secureEnvironment({ JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "3" })),
    /production requires Redis playback write version 4/
  );
});

test("production fails closed when connections or security material are absent", () => {
  for (const field of [
    "DATABASE_URL",
    "REDIS_URL",
    "JUMPGATE_PROVIDER_MUTATION_MODE",
    "JUMPGATE_POSTGRES_MIGRATION_CEILING",
    "JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION",
    "JUMPGATE_SUBTITLE_S3_BUCKET",
    "JUMPGATE_SUBTITLE_S3_REGION",
    "JUMPGATE_SUBTITLE_S3_ENDPOINT",
    "JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID",
    "JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY",
    "JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID",
    "JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING",
    "JUMPGATE_TOKEN_PEPPER",
    "JUMPGATE_ENVELOPE_PRIMARY_KEY_ID",
    "JUMPGATE_ENVELOPE_KEYRING",
  ]) {
    const env = secureEnvironment();
    delete env[field];
    assert.throws(() => loadStorageConfig(env), new RegExp(field));
  }
  assert.throws(
    () => loadStorageConfig(secureEnvironment({ DATABASE_URL: "https://db.example/jumpgate" })),
    /DATABASE_URL is invalid/
  );
  assert.throws(
    () => loadStorageConfig(secureEnvironment({ REDIS_URL: "https://redis.example/0" })),
    /REDIS_URL is invalid/
  );
});

test("persistent local SQLite resolves its path and requires stable keys", () => {
  const cwd = path.resolve("C:/jumpgate-test-root");
  const environment = secureEnvironment({
    NODE_ENV: "development",
    JUMPGATE_DURABLE_DRIVER: "sqlite",
    JUMPGATE_TTL_DRIVER: "memory",
    JUMPGATE_SQLITE_PATH: "var/state.sqlite3",
  });
  delete environment.JUMPGATE_PROVIDER_MUTATION_MODE;
  delete environment.JUMPGATE_POSTGRES_MIGRATION_CEILING;
  delete environment.JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION;
  const config = loadStorageConfig(environment, { cwd });

  assert.equal(config.sqlitePath, path.resolve(cwd, "var/state.sqlite3"));
  assert.equal(config.databaseUrl, null);
  assert.equal(config.redisUrl, null);
  assert.equal(config.providerMutationMode, "fenced");
  assert.equal(config.postgresMigrationCeiling, null);
  assert.equal(config.redisPlaybackWriteVersion, "4");
  assert.equal(config.subtitleS3, null);
  assert.equal(config.subtitleObjectKeys, null);
  assert.throws(
    () =>
      loadStorageConfig({
        NODE_ENV: "development",
        JUMPGATE_DURABLE_DRIVER: "sqlite",
        JUMPGATE_TTL_DRIVER: "memory",
      }),
    /JUMPGATE_TOKEN_PEPPER is required/
  );
  assert.throws(
    () => loadStorageConfig({ ...secureEnvironment({ NODE_ENV: "development" }), JUMPGATE_SQLITE_PATH: ":memory:" }),
    /may not use :memory:/
  );
});

test("test-only memory storage receives fresh ephemeral key material when omitted", () => {
  let seed = 0x10;
  const config = loadStorageConfig(
    { NODE_ENV: "test" },
    { randomBytes: (length) => Buffer.alloc(length, seed++) }
  );

  assert.equal(config.durableDriver, "memory");
  assert.equal(config.ttlDriver, "memory");
  assert.equal(config.providerMutationMode, "fenced");
  assert.equal(config.postgresMigrationCeiling, null);
  assert.equal(config.redisPlaybackWriteVersion, "4");
  assert.equal(config.subtitleS3, null);
  assert.equal(config.subtitleObjectKeys, null);
  assert.equal(config.ephemeralSecurityMaterial, true);
  assert.deepEqual(config.tokenPepper, Buffer.alloc(32, 0x10));
  assert.deepEqual(config.envelopeKeys.get("test-ephemeral"), Buffer.alloc(32, 0x11));
  assert.throws(
    () => loadStorageConfig({ NODE_ENV: "development", JUMPGATE_DURABLE_DRIVER: "memory" }),
    /test-only/
  );
});

test("rollout controls accept only explicit protocol values and exact migration versions", () => {
  for (const value of ["", "FENCED", " fenced", "future"]) {
    assert.throws(
      () => loadStorageConfig(secureEnvironment({ JUMPGATE_PROVIDER_MUTATION_MODE: value })),
      /JUMPGATE_PROVIDER_MUTATION_MODE/
    );
  }
  for (const value of ["latest", "0003", "0003-storage-correctness", "0003_Storage"] ) {
    assert.throws(
      () => loadStorageConfig(secureEnvironment({ JUMPGATE_POSTGRES_MIGRATION_CEILING: value })),
      /migration ceiling/i
    );
  }
  for (const value of ["", "v4", "04", "5"]) {
    assert.throws(
      () => loadStorageConfig(secureEnvironment({ JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: value })),
      /JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION/
    );
  }

  assert.equal(
    loadStorageConfig(secureEnvironment({ JUMPGATE_PROVIDER_MUTATION_MODE: "fenced" }))
      .providerMutationMode,
    "fenced"
  );
  assert.equal(
    loadStorageConfig(secureEnvironment({ JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4" }))
      .redisPlaybackWriteVersion,
    "4"
  );
});

test("key material parsing rejects ambiguity, duplicate ids, unknown fields, and weak secrets", () => {
  assert.deepEqual(decodeSecret(PEPPER, "pepper"), Buffer.alloc(32, 0x31));
  assert.throws(() => decodeSecret("not a secret", "pepper"), /canonical base64/);
  assert.throws(() => decodeSecret(Buffer.alloc(16).toString("base64url"), "pepper"), /length/);
  assert.throws(
    () => parseKeyring(JSON.stringify([{ id: "same", key: KEY_NEW }, { id: "same", key: KEY_OLD }])),
    /duplicate id/
  );
  assert.throws(
    () => parseKeyring(JSON.stringify([{ id: "key", key: KEY_NEW, comment: "not accepted" }])),
    /require only id and key/
  );
  assert.throws(
    () => loadStorageConfig(secureEnvironment({ JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "missing" })),
    /not present/
  );
  assert.throws(
    () =>
      loadStorageConfig(
        secureEnvironment({
          JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: JSON.stringify([
            { id: "subtitle-new", key: SUBTITLE_KEY_NEW, purpose: "not accepted" },
          ]),
        })
      ),
    /require only id and key/
  );
  assert.throws(
    () =>
      loadStorageConfig(
        secureEnvironment({
          JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID: "missing",
        })
      ),
    /not present/
  );
});

test("subtitle object storage rejects unsafe endpoints, flags, and key authority", () => {
  for (const endpoint of [
    "http://fly.storage.tigris.dev",
    "https://user:password@fly.storage.tigris.dev",
    "https://fly.storage.tigris.dev/private",
    "https://s3.example.com",
  ]) {
    assert.throws(
      () =>
        loadStorageConfig(
          secureEnvironment({ JUMPGATE_SUBTITLE_S3_ENDPOINT: endpoint })
        ),
      /JUMPGATE_SUBTITLE_S3_ENDPOINT/
    );
  }
  assert.throws(
    () =>
      loadStorageConfig(
        secureEnvironment({ JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE: "true" })
      ),
    /JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE/
  );
  for (const privacyMode of ["STRICT", "tigris", "allow-unknown"]) {
    assert.throws(
      () =>
        loadStorageConfig(
          secureEnvironment({ JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: privacyMode })
        ),
      /JUMPGATE_SUBTITLE_S3_PRIVACY_MODE/
    );
  }
  assert.equal(
    loadStorageConfig(
      secureEnvironment({
        JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: "tigris-policy-status",
      })
    ).subtitleS3.privacyMode,
    "tigris-policy-status"
  );
  assert.throws(
    () =>
      loadStorageConfig(
        secureEnvironment({
          JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: JSON.stringify([
            { id: "Invalid_Uppercase", key: SUBTITLE_KEY_NEW },
          ]),
        })
      ),
    /invalid or duplicate id/
  );
});

test("subtitle credentials and HMAC secrets are not reflected by config serialization or errors", () => {
  const config = loadStorageConfig(secureEnvironment());
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, new RegExp(SUBTITLE_S3_ACCESS_KEY));
  assert.doesNotMatch(serialized, new RegExp(SUBTITLE_S3_SECRET));
  assert.doesNotMatch(serialized, new RegExp(SUBTITLE_KEY_NEW));

  let failure;
  try {
    loadStorageConfig(
      secureEnvironment({ JUMPGATE_SUBTITLE_S3_ENDPOINT: SUBTITLE_S3_SECRET })
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.doesNotMatch(String(failure.stack), new RegExp(SUBTITLE_S3_SECRET));
});

test("CONFIG_SECRET is retained only as explicit legacy migration input", () => {
  const config = loadStorageConfig(secureEnvironment({ CONFIG_SECRET: "legacy-config-secret" }));
  assert.equal(config.legacyConfigSecret, "legacy-config-secret");
  assert.notEqual(config.tokenPepper.toString("base64url"), Buffer.from(config.legacyConfigSecret).toString("base64url"));
});
