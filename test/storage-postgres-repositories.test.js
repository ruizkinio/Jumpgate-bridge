"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  EnvelopeCrypto,
  stableScope,
  TokenService,
} = require("../lib/storage");
const {
  createPostgresRepositories,
  PostgresAddonCollectionBackupRepository,
  PostgresDeviceRepository,
  PostgresHistoryRepository,
  PostgresOAuthCredentialRepository,
  PostgresProfileRepository,
  PostgresProviderRepository,
} = require("../lib/storage/postgres");
const { assertRepository } = require("../lib/storage/contracts");
const {
  assertEnvelopeStorageSize,
  MAX_BACKUP_ENVELOPE_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
  MAX_JSON_SNAPSHOT_BYTES,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
  MAX_POSTGRES_JSONB_STORAGE_BYTES,
} = require("../lib/storage/postgres/repository-helpers");
const { lifecycleInvalidationId } = require("../lib/storage/lifecycle-invalidation");
const {
  PLAYBACK_SESSION_TRANSITION_SQL,
} = require("../lib/storage/postgres/history-grant-repository");

const PROFILE_ID = "profile_postgres_a";
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

test("history dispatch transition types its shared PostgreSQL timestamp parameter", () => {
  assert.match(PLAYBACK_SESSION_TRANSITION_SQL, /updated_at = \$5::timestamptz/);
  assert.match(PLAYBACK_SESSION_TRANSITION_SQL, /THEN \$5::timestamptz/);
  assert.doesNotMatch(PLAYBACK_SESSION_TRANSITION_SQL, /updated_at = \$5,/);
});

class ScriptedDatabase {
  constructor(steps = []) {
    this.calls = [];
    this.steps = steps.slice();
    this.transactionCount = 0;
    this.activeTransactions = 0;
  }

  async query(text, values) {
    this.calls.push({ text, values });
    if (/set_config\('lock_timeout'/.test(text)) {
      assert.deepEqual(values, ["15000ms"]);
      return { rowCount: 1, rows: [{}] };
    }
    const step = this.steps.shift();
    assert.ok(step, "unexpected query: " + text);
    if (step.match) assert.match(text, step.match);
    if (step.inspect) step.inspect(text, values);
    if (step.error) throw step.error;
    const rows = step.rows || [];
    return { rowCount: step.rowCount ?? rows.length, rows };
  }

  async transaction(work) {
    this.transactionCount += 1;
    this.activeTransactions += 1;
    try {
      return await work(this);
    } finally {
      this.activeTransactions -= 1;
    }
  }

  assertConsumed() {
    assert.equal(this.steps.length, 0, "not all scripted queries were consumed");
  }
}

function tokenService() {
  return new TokenService({
    pepper: Buffer.alloc(32, 0x61),
    randomBytes: (length) => Buffer.alloc(length, 0x42),
  });
}

test("PostgreSQL durable repository factory includes subtitle manifests", () => {
  const repositories = createPostgresRepositories({
    database: new ScriptedDatabase(),
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });
  assert.equal(
    assertRepository("subtitleManifests", repositories.subtitleManifests),
    repositories.subtitleManifests
  );
});

function envelopeCrypto(keyId = "postgres-key") {
  return new EnvelopeCrypto({
    primaryKeyId: keyId,
    keys: { [keyId]: Buffer.alloc(32, 0x51) },
    randomBytes: (length) => Buffer.alloc(length, 0x31),
  });
}

function providerProtocolStep(mutationFence) {
  return {
    match: /set_config\('jumpgate\.provider_mutation_protocol'[\s\S]*set_config\('jumpgate\.provider_mutation_fence'/,
    inspect(_text, values) {
      assert.deepEqual(values, ["1", mutationFence]);
    },
  };
}

function providerProtocolStateStep(overrides = {}) {
  return {
    match: /FROM provider_mutation_protocol[\s\S]*FOR SHARE/,
    rows: [{ enforcement_active: false, mutations_paused: false, ...overrides }],
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

function profileRow(overrides = {}) {
  return {
    schema_version: 1,
    id: PROFILE_ID,
    install_token_hash: "a".repeat(64),
    display_name: "Living room",
    settings_envelope: null,
    legacy_config_hash: null,
    status: "active",
    revision: "7",
    created_at: new Date(1000),
    updated_at: new Date(1000),
    revoked_at: null,
    history_generation: "1",
    deletion_state: "none",
    deletion_started_at: null,
    durable_erased_at: null,
    ...overrides,
  };
}

function deviceRow(tokenHash, overrides = {}) {
  return {
    schema_version: 1,
    id: "device_postgres_a",
    profile_id: PROFILE_ID,
    pairing_id: "pairing_postgres_a",
    token_hash: tokenHash,
    display_name: "Kodi TV",
    created_at: new Date(1000),
    last_seen_at: new Date(1000),
    expires_at: new Date(5000),
    revoked_at: null,
    generation: "1",
    ...overrides,
  };
}

function historyRow(overrides = {}) {
  return {
    schema_version: 1,
    profile_id: PROFILE_ID,
    content_key: "a".repeat(64),
    canonical_identity: null,
    display_snapshot: {},
    playback_snapshot: {},
    position_ms: "0",
    duration_ms: "0",
    watched_ms: "0",
    completed: false,
    revision: "3",
    change_seq: "42",
    last_played_at: new Date(4000),
    updated_at: new Date(5000),
    deleted_at: new Date(5000),
    ...overrides,
  };
}

function guardProjectionProperty(database, row, property) {
  const guarded = { ...row };
  const value = guarded[property];
  Object.defineProperty(guarded, property, {
    configurable: true,
    enumerable: true,
    get() {
      assert.equal(
        database.activeTransactions,
        0,
        property + " was projected while a PostgreSQL transaction was active"
      );
      return value;
    },
  });
  return guarded;
}

function invalidJsonPayloads() {
  const cyclic = {};
  cyclic.self = cyclic;
  return [
    { label: "NUL", pattern: /NUL/, value: "bad\u0000value" },
    { label: "lone surrogate", pattern: /lone UTF-16 surrogate/, value: "\udfff" },
    { label: "unsafe integer", pattern: /unsafe integer/, value: Number.MAX_SAFE_INTEGER + 1 },
    { label: "cycle", pattern: /cycle/, value: cyclic },
    { label: "non-plain object", pattern: /non-plain object/, value: new Map() },
    { label: "sparse array", pattern: /unsupported array/, value: new Array(1) },
    { label: "unsupported value", pattern: /unsupported value/, value: undefined },
  ];
}

test("PostgreSQL repositories reject the strict JSON domain before opening a transaction", async () => {
  for (const invalid of invalidJsonPayloads()) {
    const database = new ScriptedDatabase();
    const repository = new PostgresOAuthCredentialRepository({
      database,
      envelopeCrypto: envelopeCrypto(),
    });
    await assert.rejects(
      repository.put(PROFILE_ID, "realdebrid", { payload: invalid.value }, 0),
      invalid.pattern,
      invalid.label
    );
    assert.equal(database.transactionCount, 0);
    assert.deepEqual(database.calls, []);
  }
});

test("PostgreSQL encoded limits cover exact plaintext boundaries with bounded overhead", () => {
  const crypto = envelopeCrypto("k".repeat(64));
  const descriptor = objectWithExactJsonBytes(
    { transportUrl: "https://boundary.example/manifest.json" },
    "padding",
    MAX_JSON_SNAPSHOT_BYTES
  );
  const collection = collectionWithExactJsonBytes(MAX_BACKUP_PLAINTEXT_BYTES);
  const descriptorEnvelope = crypto.encryptJson(
    descriptor,
    "provider-descriptor:" + stableScope("profile", PROFILE_ID)
  );
  const backupEnvelope = crypto.encryptJson(
    collection,
    "addon-backup:" + stableScope("addon-backup", PROFILE_ID, "backup_postgres_a")
  );

  assert.equal(
    Buffer.byteLength(JSON.stringify(descriptorEnvelope), "utf8"),
    MAX_JSON_SNAPSHOT_ENVELOPE_BYTES - 11
  );
  assert.equal(
    Buffer.byteLength(JSON.stringify(backupEnvelope), "utf8"),
    MAX_BACKUP_ENVELOPE_BYTES - 11
  );
  assert.equal(
    assertEnvelopeStorageSize(
      descriptorEnvelope,
      "provider descriptor envelope",
      MAX_JSON_SNAPSHOT_ENVELOPE_BYTES
    ),
    descriptorEnvelope
  );
  assert.equal(
    assertEnvelopeStorageSize(
      backupEnvelope,
      "addon collection envelope",
      MAX_BACKUP_ENVELOPE_BYTES
    ),
    backupEnvelope
  );
});

test("PostgreSQL repositories reject oversized encoded envelopes before transactions", async () => {
  const oversizedSnapshotEnvelope = objectWithExactJsonBytes(
    {},
    "padding",
    MAX_JSON_SNAPSHOT_ENVELOPE_BYTES + 1
  );
  const oversizedBackupEnvelope = objectWithExactJsonBytes(
    {},
    "padding",
    MAX_BACKUP_ENVELOPE_BYTES + 1
  );
  const smallCrypto = { encryptJson: () => oversizedSnapshotEnvelope };
  const backupCrypto = { encryptJson: () => oversizedBackupEnvelope };

  const providerDatabase = new ScriptedDatabase();
  const providers = new PostgresProviderRepository({
    database: providerDatabase,
    envelopeCrypto: smallCrypto,
    mode: "legacy",
    tokenService: tokenService(),
    idFactory: () => "provider_postgres_boundary",
  });
  await assert.rejects(
    () => providers.replaceAll(
      PROFILE_ID,
      [{ transportUrl: "https://oversized.example/manifest.json" }],
      0
    ),
    new RegExp("exceeds " + MAX_JSON_SNAPSHOT_ENVELOPE_BYTES + " bytes")
  );
  assert.equal(providerDatabase.transactionCount, 0);

  const oauthDatabase = new ScriptedDatabase();
  const oauth = new PostgresOAuthCredentialRepository({
    database: oauthDatabase,
    envelopeCrypto: smallCrypto,
  });
  await assert.rejects(
    () => oauth.put(PROFILE_ID, "trakt", { token: "secret" }, 0),
    new RegExp("exceeds " + MAX_JSON_SNAPSHOT_ENVELOPE_BYTES + " bytes")
  );
  assert.equal(oauthDatabase.transactionCount, 0);

  const backupDatabase = new ScriptedDatabase();
  const backups = new PostgresAddonCollectionBackupRepository({
    database: backupDatabase,
    envelopeCrypto: backupCrypto,
    idFactory: () => "backup_postgres_boundary",
  });
  await assert.rejects(
    () => backups.create(PROFILE_ID, [], "oversized"),
    new RegExp("exceeds " + MAX_BACKUP_ENVELOPE_BYTES + " bytes")
  );
  assert.equal(backupDatabase.transactionCount, 0);
});

test("profile updates lock rows, apply revision CAS, and map bigint/timestamps safely", async () => {
  const database = new ScriptedDatabase([
    { match: /SELECT \* FROM profiles WHERE id = \$1 FOR UPDATE/, rows: [profileRow()] },
    {
      match: /UPDATE profiles[\s\S]*revision = revision \+ 1[\s\S]*revision = \$2/,
      inspect(_text, values) {
        assert.equal(values[1], 7);
        assert.equal(values[2], "Bedroom");
        assert.equal(values[4] instanceof Date, true);
      },
      rows: [profileRow({ display_name: "Bedroom", revision: "8", updated_at: new Date(2000) })],
    },
    { match: /UPDATE scrobble_dispatches[\s\S]*profile_revision < \$2/ },
    { match: /UPDATE playback_sessions[\s\S]*profile_revision < \$2/ },
  ]);
  const repository = new PostgresProfileRepository({
    database,
    tokenService: tokenService(),
    clock: () => 2000,
  });

  const updated = await repository.update(PROFILE_ID, { displayName: "Bedroom" }, 7);
  assert.equal(updated.revision, 8);
  assert.equal(updated.updatedAt, 2000);
  assert.equal(database.transactionCount, 1);
  database.assertConsumed();
});

test("profile reads reject PostgreSQL bigint values outside JavaScript's safe range", async () => {
  const database = new ScriptedDatabase([
    { match: /SELECT \* FROM profiles WHERE id = \$1/, rows: [profileRow({ revision: "9007199254740992" })] },
  ]);
  const repository = new PostgresProfileRepository({ database, tokenService: tokenService() });

  await assert.rejects(
    () => repository.getById(PROFILE_ID),
    /outside the JavaScript safe integer range/
  );
  database.assertConsumed();
});

test("pairing-linked device retries lock pairing_id and return the original durable device", async () => {
  const tokens = tokenService();
  const deviceToken = "A".repeat(43);
  const tokenHash = tokens.hashToken("device", deviceToken);
  const database = new ScriptedDatabase([
    { match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/, rows: [{ id: PROFILE_ID, status: "active" }] },
    { match: /SELECT \* FROM devices WHERE pairing_id = \$1 FOR UPDATE/, rows: [deviceRow(tokenHash)] },
  ]);
  const repository = new PostgresDeviceRepository({ database, tokenService: tokens, clock: () => 1500 });

  const result = await repository.register(PROFILE_ID, {
    pairingId: "pairing_postgres_a",
    deviceToken,
    displayName: "Kodi TV",
  });
  assert.equal(result.device.id, "device_postgres_a");
  assert.equal(result.deviceToken, deviceToken);
  assert.equal(Object.hasOwn(result.device, "tokenHash"), false);
  assert.equal(database.calls.some((call) => /INSERT INTO devices/.test(call.text)), false);
  database.assertConsumed();
});

test("device authentication locks profile before device and keeps rolling credentials scoped", async () => {
  const tokens = tokenService();
  const deviceToken = "B".repeat(43);
  const tokenHash = tokens.hashToken("device", deviceToken);
  const database = new ScriptedDatabase([
    { match: /SELECT profile_id FROM devices WHERE token_hash = \$1/, rows: [{ profile_id: PROFILE_ID }] },
    { match: /SELECT id, status FROM profiles WHERE id = \$1 FOR UPDATE/, rows: [{ id: PROFILE_ID, status: "active" }] },
    { match: /SELECT \* FROM devices[\s\S]*FOR UPDATE/, rows: [deviceRow(tokenHash)] },
  ]);
  const repository = new PostgresDeviceRepository({
    database,
    tokenService: tokens,
    clock: () => 1500,
  });

  const authenticated = await repository.authenticate(deviceToken);
  assert.equal(authenticated.profileId, PROFILE_ID);
  assert.equal(authenticated.lastSeenAt, 1000);
  assert.equal(authenticated.generation, 1);
  database.assertConsumed();
});

test("device revocation advances its generation once and same-profile retries are idempotent", async () => {
  const tokenHash = "c".repeat(64);
  const revokedRow = deviceRow(tokenHash, {
    generation: "2",
    revoked_at: new Date(2000),
  });
  const invalidationRow = {
    id: lifecycleInvalidationId("device", PROFILE_ID, 1, "device_postgres_a", 2),
    kind: "device",
    profile_id: PROFILE_ID,
    profile_revision: "1",
    device_id: "device_postgres_a",
    device_generation: "2",
    attempt_count: "0",
    next_attempt_at: new Date(2000),
    created_at: new Date(2000),
    updated_at: new Date(2000),
  };
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status, revision FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", revision: "1" }],
    },
    { match: /SELECT \* FROM devices[\s\S]*FOR UPDATE/, rows: [deviceRow(tokenHash)] },
    {
      match: /UPDATE devices[\s\S]*generation = generation \+ 1[\s\S]*RETURNING \*/,
      rows: [revokedRow],
    },
    { match: /UPDATE scrobble_dispatches[\s\S]*device_generation < \$3/ },
    { match: /UPDATE playback_sessions[\s\S]*device_generation < \$3/ },
    { match: /UPDATE subtitle_object_manifests[\s\S]*device_id = \$2/ },
    { match: /INSERT INTO lifecycle_invalidations[\s\S]*ON CONFLICT/, rows: [invalidationRow] },
    {
      match: /SELECT id, status, revision FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", revision: "1" }],
    },
    { match: /SELECT \* FROM devices[\s\S]*FOR UPDATE/, rows: [revokedRow] },
    { match: /UPDATE scrobble_dispatches[\s\S]*device_generation < \$3/ },
    { match: /UPDATE playback_sessions[\s\S]*device_generation < \$3/ },
    { match: /UPDATE subtitle_object_manifests[\s\S]*device_id = \$2/ },
    { match: /SELECT \* FROM lifecycle_invalidations[\s\S]*device_id IS NOT DISTINCT FROM/, rows: [invalidationRow] },
    {
      match: /SELECT generation FROM devices WHERE id = \$1 AND profile_id = \$2/,
      rows: [{ generation: "2" }],
    },
  ]);
  const repository = new PostgresDeviceRepository({
    database,
    tokenService: tokenService(),
    clock: () => 2000,
  });

  assert.equal(await repository.revoke(PROFILE_ID, "device_postgres_a"), true);
  assert.equal(await repository.revoke(PROFILE_ID, "device_postgres_a"), true);
  assert.equal(await repository.getGeneration(PROFILE_ID, "device_postgres_a"), 2);
  database.assertConsumed();
});

test("PostgreSQL claim admission performs external work between short lock transactions", async () => {
  const tokenHash = "d".repeat(64);
  const currentDevice = deviceRow(tokenHash);
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status, revision FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", revision: "1" }],
    },
    { match: /SELECT \* FROM devices[\s\S]*FOR UPDATE/, rows: [currentDevice] },
    {
      match: /SELECT id, status, revision FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", revision: "1" }],
    },
    { match: /SELECT \* FROM devices[\s\S]*FOR UPDATE/, rows: [currentDevice] },
  ]);
  const repository = new PostgresDeviceRepository({
    database,
    tokenService: tokenService(),
    clock: () => 1500,
  });
  assert.equal(typeof repository.withClaimAdmission, "function");
  let callsInsideAdmission = 0;
  let transactionsInsideAdmission = 0;

  const result = await repository.withClaimAdmission(
    PROFILE_ID,
    "device_postgres_a",
    1,
    1,
    async () => {
      callsInsideAdmission = database.calls.length;
      transactionsInsideAdmission = database.activeTransactions;
      return "claimed";
    }
  );

  assert.equal(result, "claimed");
  assert.equal(callsInsideAdmission, 2);
  assert.equal(transactionsInsideAdmission, 0);
  assert.equal(database.transactionCount, 2);
  database.assertConsumed();
});

test("PostgreSQL history locks and rejects a stale device binding before touching history", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status, history_generation FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", history_generation: "1" }],
    },
    {
      match: /SELECT generation FROM devices[\s\S]*FOR UPDATE/,
      rows: [],
    },
  ]);
  const repository = new PostgresHistoryRepository({ database, clock: () => 2000 });

  await assert.rejects(
    () => repository.upsert(
      PROFILE_ID,
      {
        canonicalIdentity: null,
        completed: false,
        contentKey: "6".repeat(64),
        displaySnapshot: {},
        durationMs: 1000,
        lastPlayedAt: 1000,
        playbackSnapshot: {},
        positionMs: 100,
        watchedMs: 100,
      },
      0,
      { deviceId: "device_postgres_a", deviceGeneration: 1 }
    ),
    (error) => error.code === "device_generation_changed"
  );
  database.assertConsumed();
});

test("device listing returns only active unexpired bearer credentials", async () => {
  const tokenHash = "b".repeat(64);
  const database = new ScriptedDatabase([
    {
      match: /d\.revoked_at IS NULL[\s\S]*d\.expires_at > \$2[\s\S]*ORDER BY d\.created_at, d\.id/,
      inspect(_text, values) {
        assert.equal(values[0], PROFILE_ID);
        assert.equal(values[1].getTime(), 1500);
      },
      rows: [deviceRow(tokenHash)],
    },
  ]);
  const repository = new PostgresDeviceRepository({
    database,
    tokenService: tokenService(),
    clock: () => 1500,
  });
  assert.deepEqual((await repository.list(PROFILE_ID)).map((device) => device.id), [
    "device_postgres_a",
  ]);
  database.assertConsumed();
});

test("provider lists hold a profile share lock for a consistent revision and row snapshot", async () => {
  const crypto = envelopeCrypto();
  const descriptor = { transportUrl: "https://provider.example/manifest.json" };
  const purpose = "provider-descriptor:" + stableScope("profile", PROFILE_ID);
  const database = new ScriptedDatabase([
    { match: /SELECT id, status FROM profiles WHERE id = \$1 FOR SHARE/, rows: [{ id: PROFILE_ID, status: "active" }] },
    { match: /SELECT revision FROM provider_collections[\s\S]*FOR SHARE/, rows: [{ revision: "2" }] },
    {
      match: /SELECT id, ordinal, descriptor_envelope[\s\S]*ORDER BY ordinal ASC/,
      rows: [{
        id: "provider_postgres_a",
        ordinal: 0,
        descriptor_envelope: crypto.encryptJson(descriptor, purpose),
      }],
    },
  ]);
  const repository = new PostgresProviderRepository({
    database,
    mode: "legacy",
    tokenService: tokenService(),
    envelopeCrypto: crypto,
  });

  assert.deepEqual(await repository.list(PROFILE_ID), {
    revision: 2,
    providers: [{ providerId: "provider_postgres_a", ordinal: 0, descriptor }],
  });
  assert.equal(database.transactionCount, 1);
  database.assertConsumed();
});

test("provider descriptor decryption happens after the snapshot transaction commits", async () => {
  const baseCrypto = envelopeCrypto();
  const descriptor = { transportUrl: "https://provider.example/manifest.json" };
  const purpose = "provider-descriptor:" + stableScope("profile", PROFILE_ID);
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles WHERE id = \$1 FOR SHARE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    {
      match: /SELECT revision FROM provider_collections[\s\S]*FOR SHARE/,
      rows: [{ revision: "2" }],
    },
    {
      match: /SELECT id, ordinal, descriptor_envelope[\s\S]*ORDER BY ordinal ASC/,
      rows: [{
        id: "provider_postgres_a",
        ordinal: "0",
        descriptor_envelope: baseCrypto.encryptJson(descriptor, purpose),
      }],
    },
  ]);
  const guardedCrypto = {
    encryptJson: baseCrypto.encryptJson.bind(baseCrypto),
    decryptJson(...args) {
      assert.equal(database.activeTransactions, 0, "descriptor decrypted under a share lock");
      return baseCrypto.decryptJson(...args);
    },
  };
  const repository = new PostgresProviderRepository({
    database,
    mode: "legacy",
    tokenService: tokenService(),
    envelopeCrypto: guardedCrypto,
  });

  assert.equal((await repository.list(PROFILE_ID)).providers[0].descriptor.transportUrl,
    descriptor.transportUrl);
  database.assertConsumed();
});

test("OAuth returned-row decryption happens after the write transaction commits", async () => {
  const baseCrypto = envelopeCrypto();
  const credentials = { access_token: "secret" };
  const purpose = "oauth-credential:" + stableScope("oauth", PROFILE_ID, "trakt");
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    { match: /SELECT \* FROM oauth_credentials[\s\S]*FOR UPDATE/, rows: [] },
    {
      match: /INSERT INTO oauth_credentials[\s\S]*RETURNING \*/,
      rows: [{
        schema_version: "1",
        profile_id: PROFILE_ID,
        provider: "trakt",
        credential_envelope: baseCrypto.encryptJson(credentials, purpose),
        revision: "1",
        created_at: new Date(2000),
        updated_at: new Date(2000),
      }],
    },
  ]);
  const guardedCrypto = {
    encryptJson: baseCrypto.encryptJson.bind(baseCrypto),
    decryptJson(...args) {
      assert.equal(database.activeTransactions, 0, "OAuth credentials decrypted under a row lock");
      return baseCrypto.decryptJson(...args);
    },
  };
  const repository = new PostgresOAuthCredentialRepository({
    database,
    envelopeCrypto: guardedCrypto,
    clock: () => 2000,
  });

  assert.deepEqual((await repository.put(PROFILE_ID, "trakt", credentials, 0)).credentials,
    credentials);
  database.assertConsumed();
});

test("history returned-row JSON projection happens after the write transaction commits", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status, history_generation FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", history_generation: "1" }],
    },
    { match: /SELECT \* FROM cloud_history[\s\S]*FOR UPDATE/, rows: [] },
    {
      match: /INSERT INTO cloud_history[\s\S]*RETURNING \*/,
      rows: [],
    },
  ]);
  database.steps[2].rows = [guardProjectionProperty(database, historyRow({
    change_seq: "1",
    content_key: "8".repeat(64),
    deleted_at: null,
    display_snapshot: { title: "Projection boundary" },
    last_played_at: new Date(2000),
    revision: "1",
    updated_at: new Date(2000),
  }), "display_snapshot")];
  const repository = new PostgresHistoryRepository({ database, clock: () => 2000 });

  const stored = await repository.upsert(PROFILE_ID, {
    canonicalIdentity: null,
    completed: false,
    contentKey: "8".repeat(64),
    displaySnapshot: { title: "Projection boundary" },
    durationMs: 1000,
    lastPlayedAt: 2000,
    playbackSnapshot: {},
    positionMs: 100,
    watchedMs: 100,
  }, 0);
  assert.equal(stored.displaySnapshot.title, "Projection boundary");
  database.assertConsumed();
});

test("profile returned-row projection happens after the write transaction commits", async () => {
  const database = new ScriptedDatabase([
    { match: /SELECT \* FROM profiles WHERE id = \$1 FOR UPDATE/, rows: [profileRow()] },
    { match: /UPDATE profiles[\s\S]*RETURNING \*/, rows: [] },
    { match: /UPDATE scrobble_dispatches[\s\S]*profile_revision < \$2/ },
    { match: /UPDATE playback_sessions[\s\S]*profile_revision < \$2/ },
  ]);
  database.steps[1].rows = [guardProjectionProperty(
    database,
    profileRow({ display_name: "Bedroom", revision: "8", updated_at: new Date(2000) }),
    "created_at"
  )];
  const repository = new PostgresProfileRepository({
    database,
    tokenService: tokenService(),
    clock: () => 2000,
  });

  assert.equal((await repository.update(PROFILE_ID, { displayName: "Bedroom" }, 7)).revision, 8);
  database.assertConsumed();
});

test("device returned-row projection happens after the registration transaction commits", async () => {
  const tokens = tokenService();
  const deviceToken = "P".repeat(43);
  const tokenHash = tokens.hashToken("device", deviceToken);
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    { match: /SELECT \* FROM devices WHERE pairing_id = \$1 FOR UPDATE/, rows: [] },
  ]);
  database.steps[1].rows = [guardProjectionProperty(
    database,
    deviceRow(tokenHash),
    "created_at"
  )];
  const repository = new PostgresDeviceRepository({
    database,
    tokenService: tokens,
    clock: () => 1500,
  });

  const registered = await repository.register(PROFILE_ID, {
    pairingId: "pairing_postgres_a",
    deviceToken,
    displayName: "Kodi TV",
  });
  assert.equal(registered.device.id, "device_postgres_a");
  database.assertConsumed();
});

test("backup returned-row projection happens after the write transaction commits", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    { match: /SELECT count\(\*\)::bigint AS backup_count/, rows: [{ backup_count: "0" }] },
    { match: /INSERT INTO addon_collection_backups[\s\S]*RETURNING \*/, rows: [] },
  ]);
  database.steps[2].rows = [guardProjectionProperty(database, {
    schema_version: "1",
    id: "backup_postgres_projection",
    profile_id: PROFILE_ID,
    reason: "projection-boundary",
    created_at: new Date(2000),
    restored_at: null,
  }, "created_at")];
  const repository = new PostgresAddonCollectionBackupRepository({
    database,
    envelopeCrypto: envelopeCrypto(),
    idFactory: () => "backup_postgres_projection",
    clock: () => 2000,
  });

  assert.equal((await repository.create(PROFILE_ID, [], "projection-boundary")).createdAt, 2000);
  database.assertConsumed();
});

test("provider repositories require an explicit legacy or fenced mutation mode", async () => {
  const options = {
    database: new ScriptedDatabase(),
    envelopeCrypto: envelopeCrypto(),
    tokenService: tokenService(),
  };
  assert.throws(() => new PostgresProviderRepository(options), /must be legacy or fenced/);
  assert.throws(
    () => new PostgresProviderRepository({ ...options, mode: "automatic" }),
    /must be legacy or fenced/
  );
  assert.throws(
    () => new PostgresProviderRepository({
      ...options,
      mode: "legacy",
      providerMutationMode: "fenced",
    }),
    /options conflict/
  );
});

test("legacy provider replacement uses exact pre-0004 SQL behind a table lock", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    { match: /^LOCK TABLE provider_collections IN ROW EXCLUSIVE MODE$/ },
    {
      inspect(text, values) {
        assert.equal(text, LEGACY_PROVIDER_COLLECTION_FIRST_INSERT_SQL);
        assert.equal(values[0], PROFILE_ID);
      },
    },
    {
      match: /SELECT \* FROM provider_collections[\s\S]*FOR UPDATE/,
      rows: [{ profile_id: PROFILE_ID, revision: "0" }],
    },
    { match: /^DELETE FROM providers WHERE profile_id = \$1$/ },
    {
      inspect(text, values) {
        assert.equal(text, LEGACY_PROVIDER_COLLECTION_UPDATE_SQL);
        assert.deepEqual(values.slice(0, 2), [PROFILE_ID, 0]);
      },
      rows: [{ revision: "1" }],
    },
  ]);
  const repository = new PostgresProviderRepository({
    database,
    envelopeCrypto: envelopeCrypto(),
    mode: "legacy",
    tokenService: tokenService(),
  });

  assert.deepEqual(await repository.replaceAll(PROFILE_ID, [], 0), {
    revision: 1,
    count: 0,
  });
  const providerDelete = database.calls.findIndex((call) => /^DELETE FROM providers/.test(call.text));
  const collectionLock = database.calls.findIndex((call) => /^LOCK TABLE provider_collections/.test(call.text));
  assert.ok(collectionLock >= 0 && collectionLock < providerDelete);
  assert.equal(
    database.calls.some((call) => /provider_mutation_|mutation_fence/.test(call.text)),
    false
  );
  database.assertConsumed();

  await assert.rejects(
    () => repository.replaceAll(PROFILE_ID, [], 1, { mutationFence: "1" }),
    /not supported in legacy provider mutation mode/
  );
  await assert.rejects(
    () => repository.allocateMutationFence(PROFILE_ID),
    (error) => error.code === "provider_mutation_mode_mismatch"
  );
  assert.equal(database.transactionCount, 1);
});

test("provider mutation fence allocation is atomic and returns canonical decimal tokens", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    providerProtocolStateStep(),
    {
      match: /UPDATE provider_mutation_fence_counter[\s\S]*mutation_fence \+ 1[\s\S]*RETURNING mutation_fence::text/,
      inspect(_text, values) {
        assert.equal(values[0], "9".repeat(128));
      },
      rows: [{ mutation_fence: "42" }],
    },
  ]);
  const repository = new PostgresProviderRepository({
    database,
    mode: "fenced",
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });

  assert.equal(await repository.allocateMutationFence(PROFILE_ID), "42");
  database.assertConsumed();

  for (const step of [
    { rows: [] },
    { error: Object.assign(new Error("sensitive database detail"), { code: "22003" }) },
  ]) {
    const exhaustedDatabase = new ScriptedDatabase([
      {
        match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
        rows: [{ id: PROFILE_ID, status: "active" }],
      },
      providerProtocolStateStep(),
      { match: /UPDATE provider_mutation_fence_counter/, ...step },
    ]);
    const exhaustedRepository = new PostgresProviderRepository({
      database: exhaustedDatabase,
      mode: "fenced",
      tokenService: tokenService(),
      envelopeCrypto: envelopeCrypto(),
    });
    await assert.rejects(
      () => exhaustedRepository.allocateMutationFence(PROFILE_ID),
      (error) =>
        error.code === "provider_mutation_fence_exhausted" &&
        error.message === "provider mutation fence allocator exhausted"
    );
    exhaustedDatabase.assertConsumed();
  }
});

test("provider mutation fence allocator fails closed while mutations are paused", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    providerProtocolStateStep({ mutations_paused: true }),
  ]);
  const repository = new PostgresProviderRepository({
    database,
    envelopeCrypto: envelopeCrypto(),
    mode: "fenced",
    tokenService: tokenService(),
  });

  await assert.rejects(
    () => repository.allocateMutationFence(PROFILE_ID),
    (error) => error.code === "provider_mutations_paused"
  );
  assert.equal(
    database.calls.some((call) => /UPDATE provider_mutation_fence_counter/.test(call.text)),
    false
  );
  database.assertConsumed();
});

test("accepted provider replacement rebases the mutation fence allocator", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    providerProtocolStep("1000"),
    { match: /INSERT INTO provider_collections[\s\S]*ON CONFLICT/ },
    {
      match: /SELECT \* FROM provider_collections[\s\S]*FOR UPDATE/,
      rows: [{ profile_id: PROFILE_ID, revision: "0", mutation_fence: "1000" }],
    },
    { match: /DELETE FROM providers/ },
    { match: /UPDATE provider_collections[\s\S]*RETURNING revision/, rows: [{ revision: "1" }] },
    {
      match: /UPDATE provider_mutation_fence_counter[\s\S]*GREATEST/,
      inspect(_text, values) {
        assert.deepEqual(values, ["1000"]);
      },
      rowCount: 1,
    },
  ]);
  const repository = new PostgresProviderRepository({
    database,
    mode: "fenced",
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });

  assert.deepEqual(
    await repository.replaceAll(PROFILE_ID, [], 0, { mutationFence: "1000" }),
    { revision: 1, count: 0 }
  );
  database.assertConsumed();
});

test("provider replacement rejects a stale mutation fence while holding collection locks", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    providerProtocolStep("19"),
    {
      match: /INSERT INTO provider_collections[\s\S]*mutation_fence[\s\S]*ON CONFLICT/,
      inspect(_text, values) {
        assert.equal(values[1], "19");
      },
    },
    {
      match: /SELECT \* FROM provider_collections[\s\S]*FOR UPDATE/,
      rows: [{ profile_id: PROFILE_ID, revision: "4", mutation_fence: "20" }],
    },
  ]);
  const repository = new PostgresProviderRepository({
    database,
    mode: "fenced",
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });

  await assert.rejects(
    () => repository.replaceAll(PROFILE_ID, [], 4, { mutationFence: "19" }),
    (error) => error.code === "provider_snapshot_stale_fence"
  );
  assert.equal(database.calls.some((call) => /DELETE FROM providers/.test(call.text)), false);
  database.assertConsumed();
});

test("provider mutation fence advance is monotonic and leaves revision unchanged", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    providerProtocolStep("21"),
    { match: /INSERT INTO provider_collections[\s\S]*ON CONFLICT/ },
    {
      match: /SELECT \* FROM provider_collections[\s\S]*FOR UPDATE/,
      rows: [{ profile_id: PROFILE_ID, revision: "4", mutation_fence: "20" }],
    },
    {
      match: /UPDATE provider_collections[\s\S]*mutation_fence = \$2[\s\S]*RETURNING revision, mutation_fence/,
      inspect(_text, values) {
        assert.equal(values[1], "21");
      },
      rows: [{ revision: "4", mutation_fence: "21" }],
    },
    { match: /UPDATE provider_mutation_fence_counter[\s\S]*GREATEST/, rowCount: 1 },
  ]);
  const repository = new PostgresProviderRepository({
    database,
    mode: "fenced",
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
    clock: () => 2000,
  });

  assert.deepEqual(await repository.advanceMutationFence(PROFILE_ID, "21"), {
    revision: 4,
    mutationFence: "21",
  });
  database.assertConsumed();

  const maximumFence = "9".repeat(128);
  const equalDatabase = new ScriptedDatabase([
    {
      match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active" }],
    },
    providerProtocolStep(maximumFence),
    {
      match: /INSERT INTO provider_collections[\s\S]*ON CONFLICT/,
      inspect(_text, values) {
        assert.equal(values[1], maximumFence);
      },
    },
    {
      match: /SELECT \* FROM provider_collections[\s\S]*FOR UPDATE/,
      rows: [{ profile_id: PROFILE_ID, revision: "0", mutation_fence: maximumFence }],
    },
    {
      match: /UPDATE provider_mutation_fence_counter[\s\S]*GREATEST/,
      inspect(_text, values) {
        assert.deepEqual(values, [maximumFence]);
      },
      rowCount: 1,
    },
  ]);
  const equalRepository = new PostgresProviderRepository({
    database: equalDatabase,
    mode: "fenced",
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });
  assert.deepEqual(await equalRepository.advanceMutationFence(PROFILE_ID, maximumFence), {
    revision: 0,
    mutationFence: maximumFence,
  });
  equalDatabase.assertConsumed();

  for (const invalid of ["", "00", "01", "9".repeat(129)]) {
    const invalidDatabase = new ScriptedDatabase();
    const invalidRepository = new PostgresProviderRepository({
      database: invalidDatabase,
      mode: "fenced",
      tokenService: tokenService(),
      envelopeCrypto: envelopeCrypto(),
    });
    await assert.rejects(
      () => invalidRepository.advanceMutationFence(PROFILE_ID, invalid),
      /mutationFence is invalid/
    );
    assert.equal(invalidDatabase.transactionCount, 0);
  }
});

test("profile-owned writes fail closed when the locked profile is not active", async () => {
  const database = new ScriptedDatabase([
    { match: /SELECT id, status FROM profiles[\s\S]*FOR UPDATE/, rows: [{ id: PROFILE_ID, status: "revoked" }] },
  ]);
  const repository = new PostgresOAuthCredentialRepository({
    database,
    envelopeCrypto: envelopeCrypto(),
  });

  await assert.rejects(
    () => repository.put(PROFILE_ID, "trakt", { access_token: "secret" }, 0),
    (error) => error.code === "profile_inactive"
  );
  database.assertConsumed();
});

test("history accepts exact compact JSON boundaries with multi-property snapshots", async () => {
  const canonicalIdentity = objectWithExactJsonBytes(
    { id: "tt0133093", mediaType: "movie", provider: "imdb", tiny: Number.MIN_VALUE },
    "padding",
    MAX_JSON_SNAPSHOT_BYTES
  );
  const displaySnapshot = objectWithExactJsonBytes(
    { title: "The Matrix", year: 1999, tiny: Number.MIN_VALUE },
    "padding",
    MAX_JSON_SNAPSHOT_BYTES
  );
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status, history_generation FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", history_generation: "1" }],
    },
    { match: /SELECT \* FROM cloud_history[\s\S]*FOR UPDATE/, rows: [] },
    {
      match: /INSERT INTO cloud_history/,
      inspect(_text, values) {
        assert.deepEqual(values[2], canonicalIdentity);
        assert.deepEqual(values[3], displaySnapshot);
      },
      rows: [historyRow({
        canonical_identity: canonicalIdentity,
        change_seq: "1",
        content_key: "7".repeat(64),
        deleted_at: null,
        display_snapshot: displaySnapshot,
        last_played_at: new Date(5000),
        revision: "1",
        updated_at: new Date(6000),
      })],
    },
  ]);
  const repository = new PostgresHistoryRepository({ database, clock: () => 6000 });

  const stored = await repository.upsert(PROFILE_ID, {
    canonicalIdentity,
    completed: false,
    contentKey: "7".repeat(64),
    displaySnapshot,
    durationMs: 1000,
    lastPlayedAt: 5000,
    playbackSnapshot: {},
    positionMs: 500,
    watchedMs: 500,
  }, 0);
  assert.deepEqual(stored.canonicalIdentity, canonicalIdentity);
  assert.deepEqual(stored.displaySnapshot, displaySnapshot);
  assert.equal(MAX_POSTGRES_JSONB_STORAGE_BYTES, MAX_JSON_SNAPSHOT_BYTES * 64);
  database.assertConsumed();
});

test("PostgreSQL history tuple cursors do not lose tied timestamps", async () => {
  const tiedAt = new Date(5000);
  const keys = ["a", "b", "c", "e"].map((value) => value.repeat(64));
  const database = new ScriptedDatabase([
    {
      match: /h\.revision < \$3[\s\S]*h\.content_key > \$4[\s\S]*LIMIT \$5/,
      inspect(_text, values) {
        assert.deepEqual(values, [PROFILE_ID, null, null, null, 2]);
      },
      rows: [
        historyRow({ content_key: keys[3], deleted_at: null, last_played_at: tiedAt, revision: "2" }),
        historyRow({ content_key: keys[0], deleted_at: null, last_played_at: tiedAt, revision: "1" }),
      ],
    },
    {
      match: /h\.revision < \$3[\s\S]*h\.content_key > \$4[\s\S]*LIMIT \$5/,
      inspect(_text, values) {
        assert.equal(values[0], PROFILE_ID);
        assert.equal(values[1].getTime(), 5000);
        assert.equal(values[2], 1);
        assert.equal(values[3], keys[0]);
        assert.equal(values[4], 2);
      },
      rows: [
        historyRow({ content_key: keys[1], deleted_at: null, last_played_at: tiedAt, revision: "1" }),
        historyRow({ content_key: keys[2], deleted_at: null, last_played_at: tiedAt, revision: "1" }),
      ],
    },
    {
      match: /h\.last_played_at < \$2/,
      inspect(_text, values) {
        assert.equal(values[1].getTime(), 5000);
        assert.equal(values[2], null);
        assert.equal(values[3], null);
      },
      rows: [historyRow({
        content_key: "f".repeat(64),
        deleted_at: null,
        last_played_at: new Date(4000),
        revision: "1",
      })],
    },
  ]);
  const repository = new PostgresHistoryRepository({ database });

  const firstPage = await repository.list(PROFILE_ID, { limit: 2 });
  const pageCursor = {
    contentKey: firstPage.at(-1).contentKey,
    lastPlayedAt: firstPage.at(-1).lastPlayedAt,
    revision: firstPage.at(-1).revision,
  };
  const secondPage = await repository.list(PROFILE_ID, { cursor: pageCursor, limit: 2 });
  assert.deepEqual(
    [...firstPage, ...secondPage].map((entry) => entry.contentKey),
    [keys[3], keys[0], keys[1], keys[2]]
  );
  assert.deepEqual(
    (await repository.list(PROFILE_ID, { before: 5000 })).map((entry) => entry.contentKey),
    ["f".repeat(64)]
  );
  await assert.rejects(
    () => repository.list(PROFILE_ID, { before: 5000, cursor: pageCursor }),
    /mutually exclusive/
  );
  database.assertConsumed();
});

test("PostgreSQL history write lookup retains tombstone revision for CAS resurrection", async () => {
  const contentKey = "9".repeat(64);
  const canonicalIdentity = {
    provider: "imdb",
    id: "tt0133093",
    mediaType: "movie",
    provenance: "metadata-request",
    confidence: "canonical",
  };
  const tombstone = historyRow({ content_key: contentKey });
  const database = new ScriptedDatabase([
    {
      match: /h\.deleted_at IS NULL[\s\S]*p\.status = 'active'/,
      rows: [],
    },
    {
      match: /WHERE h\.profile_id = \$1[\s\S]*h\.content_key = \$2[\s\S]*p\.status = 'active'/,
      rows: [tombstone],
    },
    {
      match: /SELECT id, status, history_generation FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", history_generation: "1" }],
    },
    {
      match: /SELECT \* FROM cloud_history[\s\S]*FOR UPDATE/,
      rows: [tombstone],
    },
    {
      match: /UPDATE cloud_history[\s\S]*deleted_at = NULL/,
      rows: [historyRow({
        canonical_identity: canonicalIdentity,
        change_seq: "43",
        content_key: contentKey,
        deleted_at: null,
        display_snapshot: { title: "Resurrected" },
        duration_ms: "1000",
        last_played_at: new Date(5001),
        position_ms: "250",
        revision: "4",
        updated_at: new Date(6000),
        watched_ms: "250",
      })],
    },
  ]);
  const repository = new PostgresHistoryRepository({ database, clock: () => 6000 });

  assert.equal(await repository.get(PROFILE_ID, contentKey), null);
  const internal = await repository.getForWrite(PROFILE_ID, contentKey);
  assert.equal(internal.revision, 3);
  assert.equal(internal.deletedAt, 5000);
  assert.deepEqual(internal.displaySnapshot, {});
  const resurrected = await repository.upsert(
    PROFILE_ID,
    {
      canonicalIdentity,
      completed: false,
      contentKey,
      displaySnapshot: { title: "Resurrected" },
      durationMs: 1000,
      lastPlayedAt: 5001,
      playbackSnapshot: {},
      positionMs: 250,
      watchedMs: 250,
    },
    internal.revision
  );
  assert.equal(resurrected.revision, 4);
  assert.equal(resurrected.deletedAt, null);
  assert.equal(database.transactionCount, 1);
  database.assertConsumed();
});

test("history changes retain sanitized tombstones and map the bigint change cursor", async () => {
  const database = new ScriptedDatabase([
    {
      match: /h\.change_seq > \$2[\s\S]*ORDER BY h\.change_seq ASC/,
      inspect(_text, values) {
        assert.deepEqual(values, [PROFILE_ID, 41, 10]);
      },
      rows: [historyRow()],
    },
  ]);
  const repository = new PostgresHistoryRepository({ database });

  const changes = await repository.changes(PROFILE_ID, { afterSequence: 41, limit: 10 });
  assert.equal(changes[0].changeSequence, 42);
  assert.equal(changes[0].deletedAt, 5000);
  assert.deepEqual(changes[0].displaySnapshot, {});
  assert.deepEqual(changes[0].playbackSnapshot, {});
  database.assertConsumed();
});

test("PostgreSQL history clear deletes rows and advances its profile fence atomically", async () => {
  const database = new ScriptedDatabase([
    {
      match: /SELECT id, status, history_generation FROM profiles[\s\S]*FOR UPDATE/,
      rows: [{ id: PROFILE_ID, status: "active", history_generation: "7" }],
    },
    {
      match: /DELETE FROM cloud_history WHERE profile_id = \$1/,
      inspect(_text, values) {
        assert.deepEqual(values, [PROFILE_ID]);
      },
    },
    {
      match: /SET history_generation = history_generation \+ 1[\s\S]*status = 'active'/,
      inspect(_text, values) {
        assert.equal(values[0], PROFILE_ID);
        assert.equal(values[1].getTime(), 9000);
        assert.equal(values[2], 7);
      },
      rows: [{ history_generation: "8" }],
    },
  ]);
  const repository = new PostgresHistoryRepository({ database, clock: () => 9000 });
  assert.equal(await repository.clear(PROFILE_ID), 8);
  assert.equal(database.transactionCount, 1);
  database.assertConsumed();
});

test("PostgreSQL profile erasure deletes durable children and retains its tombstone", async () => {
  const pending = profileRow({
    status: "revoked",
    deletion_state: "pending",
    deletion_started_at: new Date(7000),
    revoked_at: new Date(7000),
  });
  const childTables = [
    "devices",
    "providers",
    "provider_collections",
    "oauth_credentials",
    "cloud_history",
    "addon_collection_backups",
  ];
  const database = new ScriptedDatabase([
    { match: /SELECT \* FROM profiles[\s\S]*FOR UPDATE/, rows: [pending] },
    { match: /SELECT 1 FROM subtitle_object_manifests/, rows: [] },
    { match: /DELETE FROM scrobble_dispatches WHERE profile_id = \$1/ },
    { match: /DELETE FROM playback_sessions WHERE profile_id = \$1/ },
    { match: /DELETE FROM playback_source_revocations WHERE profile_id = \$1/ },
    ...childTables.map((table) => ({
      match: new RegExp("DELETE FROM " + table + " WHERE profile_id = \\$1"),
      inspect(_text, values) {
        assert.deepEqual(values, [PROFILE_ID]);
      },
    })),
    {
      match: /SET install_token_hash = \$2, display_name = '', settings_envelope = NULL[\s\S]*deletion_state = 'deleted'/,
      inspect(_text, values) {
        assert.equal(values[0], PROFILE_ID);
        assert.match(values[1], /^[a-f0-9]{64}$/);
        assert.equal(values[2].getTime(), 8000);
      },
      rows: [{ id: PROFILE_ID }],
    },
  ]);
  const repository = new PostgresProfileRepository({
    database,
    tokenService: tokenService(),
    clock: () => 8000,
  });
  assert.equal(await repository.erase(PROFILE_ID), true);
  assert.equal(database.transactionCount, 1);
  database.assertConsumed();
});
