"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  EnvelopeCrypto,
  MAX_MUTATION_FENCE,
  MemoryManagementSessionRepository,
  MemoryProfileRepository,
  MemoryProviderRepository,
  TokenService,
  assertMutationFence,
  assertRepository,
  assertRepositorySet,
  compareMutationFences,
  stableScope,
} = require("../lib/storage");

function sequenceRandom(seed = 1) {
  let next = seed;
  return (length) => {
    const output = Buffer.alloc(length, next);
    next = next === 255 ? 1 : next + 1;
    return output;
  };
}

function tokenService(seed = 1) {
  return new TokenService({
    pepper: Buffer.alloc(32, 0xa5),
    randomBytes: sequenceRandom(seed),
  });
}

function envelopeCrypto(primaryKeyId = "key-current", keys) {
  return new EnvelopeCrypto({
    primaryKeyId,
    keys: keys || { [primaryKeyId]: Buffer.alloc(32, 0x3c) },
    randomBytes: sequenceRandom(0x21),
  });
}

function providerPurpose(profileId) {
  return "provider-descriptor:" + stableScope("profile", profileId);
}

test("repository contracts fail closed for missing methods and accept scoped sets", () => {
  const profiles = {
    create() {},
    getById() {},
    getByInstallToken() {},
    update() {},
    rotateInstallToken() {},
    revoke() {},
    beginErasure() {},
    erase() {},
    getErasureStatus() {},
    listPendingErasures() {},
    deferErasure() {},
  };
  assert.equal(assertRepository("profiles", profiles), profiles);
  assert.equal(assertRepositorySet({ profiles }, ["profiles"]).profiles, profiles);
  assert.throws(() => assertRepository("profiles", { create() {} }), /getById/);
  assert.throws(
    () => assertRepository("devices", {
      register() {},
      authenticate() {},
      list() {},
      revoke() {},
      revokeWithInvalidation() {},
    }),
    /getGeneration|isActiveBinding/
  );
  assert.throws(() => assertRepository("unknown", {}), /unknown repository contract/);
  assert.throws(() => assertRepositorySet({}, ["profiles"]), /profiles repository is required/);
});

test("token hashes are purpose-separated and malformed tokens fail closed", () => {
  const tokens = tokenService();
  const issued = tokens.issue("install", 32);

  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(issued.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(tokens.matchesToken("install", issued.token, issued.tokenHash), true);
  assert.equal(tokens.matchesToken("device", issued.token, issued.tokenHash), false);
  assert.notEqual(tokens.hashToken("device", issued.token), issued.tokenHash);
  assert.equal(tokens.matchesToken("install", "bad token", issued.tokenHash), false);
  assert.equal(tokens.matchesToken("install", issued.token, "not-a-hash"), false);
  assert.notEqual(
    tokens.hashOpaque("provider-transport", "https://example.test/manifest.json?token=secret"),
    tokens.hashOpaque("provider-profile", "https://example.test/manifest.json?token=secret")
  );
});

test("envelopes authenticate purpose, support key rotation, and reject tampering", () => {
  const oldKey = Buffer.alloc(32, 0x11);
  const newKey = Buffer.alloc(32, 0x22);
  const oldCrypto = envelopeCrypto("old", { old: oldKey });
  const original = { authKey: "never-store-this-in-plaintext", nested: { enabled: true } };
  const oldEnvelope = oldCrypto.encryptJson(original, "stremio-auth");

  assert.deepEqual(oldCrypto.decryptJson(oldEnvelope, "stremio-auth"), original);
  assert.equal(JSON.stringify(oldEnvelope).includes(original.authKey), false);
  assert.throws(() => oldCrypto.decryptJson(oldEnvelope, "other-purpose"), /authentication failed/);

  const tampered = { ...oldEnvelope, ct: (oldEnvelope.ct[0] === "A" ? "B" : "A") + oldEnvelope.ct.slice(1) };
  assert.throws(() => oldCrypto.decryptJson(tampered, "stremio-auth"), /authentication failed/);

  const rotating = envelopeCrypto("new", { old: oldKey, new: newKey });
  assert.equal(rotating.needsRotation(oldEnvelope), true);
  const rotated = rotating.reencryptJson(oldEnvelope, "stremio-auth");
  assert.equal(rotating.needsRotation(rotated), false);
  assert.deepEqual(rotating.decryptJson(rotated, "stremio-auth"), original);
  assert.throws(
    () => envelopeCrypto("new", { new: newKey }).decryptJson(oldEnvelope, "stremio-auth"),
    /key is unavailable/
  );
});

test("envelopes enforce serialization and plaintext limits", () => {
  const crypto = new EnvelopeCrypto({
    primaryKeyId: "key",
    keys: { key: Buffer.alloc(32, 7) },
    maxPlaintextBytes: 1024,
    randomBytes: sequenceRandom(),
  });
  const circular = {};
  circular.self = circular;

  assert.throws(() => crypto.encryptJson(circular, "settings"), /not JSON serializable/);
  assert.throws(() => crypto.encryptJson({ value: "x".repeat(1100) }, "settings"), /maximum length/);
  assert.throws(() => crypto.decryptJson({ v: 1, alg: "A256GCM", kid: "key", iv: "bad" }, "settings"));
});

test("profile repository returns install capability once and stores only its hash", async () => {
  let now = 1000;
  const repository = new MemoryProfileRepository({
    tokenService: tokenService(),
    clock: () => now,
    idFactory: () => "profile_0001",
  });
  const created = await repository.create({
    displayName: " Living room ",
    legacyConfigHash: "a".repeat(64),
  });

  assert.equal(created.profile.displayName, "Living room");
  assert.equal(created.profile.revision, 1);
  assert.equal(await repository.getByInstallToken("invalid"), null);
  assert.deepEqual(await repository.getByInstallToken(created.installToken), created.profile);
  const snapshot = repository.storageSnapshot();
  const raw = JSON.stringify(snapshot);
  assert.equal(raw.includes(created.installToken), false);
  assert.equal(Object.hasOwn(snapshot[0], "installToken"), false);
  assert.match(snapshot[0].installTokenHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(created.profile, "installTokenHash"), false);

  await assert.rejects(
    () => repository.update(created.profile.id, { displayName: "Must not stick", settingsEnvelope: {} }, 1),
    /settingsEnvelope is invalid/
  );
  assert.equal((await repository.getById(created.profile.id)).displayName, "Living room");
  assert.equal((await repository.getById(created.profile.id)).revision, 1);

  now = 2000;
  const updated = await repository.update(created.profile.id, { displayName: "Bedroom" }, 1);
  assert.equal(updated.revision, 2);
  assert.equal(updated.updatedAt, 2000);
  await assert.rejects(() => repository.update(created.profile.id, {}, 1), (error) => error.code === "revision_conflict");
  const rotated = await repository.rotateInstallToken(created.profile.id, 2);
  assert.equal(rotated.profile.revision, 3);
  assert.notEqual(rotated.installToken, created.installToken);
  assert.equal(await repository.getByInstallToken(created.installToken), null);
  assert.deepEqual(await repository.getByInstallToken(rotated.installToken), rotated.profile);
  assert.equal(await repository.revoke(created.profile.id, 3), true);
  assert.equal(await repository.getByInstallToken(created.installToken), null);
  assert.equal((await repository.getById(created.profile.id)).status, "revoked");

  await assert.rejects(
    () =>
      new MemoryProfileRepository({
        tokenService: tokenService(9),
        idFactory: () => "profile_0002",
      }).create({ legacyConfigHash: "plaintext" }),
    /legacyConfigHash is invalid/
  );
});

test("provider repository preserves exact descriptors while isolating encrypted profile data", async () => {
  const tokens = tokenService();
  const crypto = envelopeCrypto();
  let providerNumber = 0;
  const repository = new MemoryProviderRepository({
    tokenService: tokens,
    envelopeCrypto: crypto,
    clock: () => 5000,
    idFactory: () => "provider_" + String(++providerNumber).padStart(4, "0"),
  });
  const profileId = "p".repeat(128);
  const otherProfileId = "other_profile_0001";
  const descriptors = [
    {
      transportUrl: "https://one.example/secret/manifest.json?token=alpha",
      manifest: { id: "one", resources: [{ name: "stream", types: ["movie"] }] },
      flags: { protected: true, official: false },
      futureField: { keep: "exactly" },
    },
    {
      transportUrl: "https://two.example/manifest.json",
      manifest: { id: "two", resources: ["subtitles"] },
      flags: { protected: false },
    },
  ];

  assert.deepEqual(await repository.replaceAll(profileId, descriptors, 0), { revision: 1, count: 2 });
  const listed = await repository.list(profileId);
  assert.equal(listed.revision, 1);
  assert.deepEqual(
    listed.providers.map((provider) => provider.descriptor),
    descriptors
  );
  assert.deepEqual(await repository.list(otherProfileId), { revision: 0, providers: [] });

  const snapshot = repository.storageSnapshot(profileId);
  const raw = JSON.stringify(snapshot);
  assert.equal(raw.includes("token=alpha"), false);
  assert.equal(raw.includes(descriptors[0].transportUrl), false);
  assert.match(snapshot.records[0].transportHash, /^[a-f0-9]{64}$/);

  const correctPurpose = providerPurpose(profileId);
  const wrongPurpose = providerPurpose(otherProfileId);
  assert.deepEqual(crypto.decryptJson(snapshot.records[0].descriptorEnvelope, correctPurpose), descriptors[0]);
  assert.throws(() => crypto.decryptJson(snapshot.records[0].descriptorEnvelope, wrongPurpose), /authentication failed/);

  await assert.rejects(() => repository.replaceAll(profileId, [], 0), (error) => error.code === "revision_conflict");
  await assert.rejects(
    () => repository.replaceAll(profileId, [descriptors[0], descriptors[0]], 1),
    /duplicate provider transportUrl/
  );
  await assert.rejects(
    () => repository.replaceAll(profileId, [{ ...descriptors[0], extra: "x".repeat(70 * 1024) }], 1),
    /exceeds 64 KiB/
  );
});

test("provider mutation fences are canonical, monotonic, and independent of provider revision", async () => {
  let providerNumber = 0;
  const repository = new MemoryProviderRepository({
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
    clock: () => 6000,
    idFactory: () => "provider_fence_" + String(++providerNumber).padStart(4, "0"),
  });
  const profileId = "profile_fence_0001";
  const firstFence = "1".repeat(128);
  const recoveryFence = "2".repeat(128);
  const descriptors = [{ transportUrl: "https://fenced.example/manifest.json" }];

  assert.equal(assertMutationFence(firstFence), firstFence);
  assert.equal(compareMutationFences(firstFence, recoveryFence), -1);
  for (const invalid of [1, "", "00", "01", "-1", "+1", "1.0", "9".repeat(129)]) {
    assert.throws(() => assertMutationFence(invalid), /mutationFence is invalid/);
    await assert.rejects(
      () => repository.advanceMutationFence(profileId, invalid),
      /mutationFence is invalid/
    );
  }

  assert.deepEqual(await repository.advanceMutationFence(profileId, firstFence), {
    revision: 0,
    mutationFence: firstFence,
  });
  assert.deepEqual(
    await repository.replaceAll(profileId, descriptors, 0, { mutationFence: firstFence }),
    { revision: 1, count: 1 }
  );
  const beforeRecovery = await repository.list(profileId);
  assert.deepEqual(await repository.advanceMutationFence(profileId, recoveryFence), {
    revision: 1,
    mutationFence: recoveryFence,
  });
  assert.deepEqual(await repository.advanceMutationFence(profileId, recoveryFence), {
    revision: 1,
    mutationFence: recoveryFence,
  });
  assert.deepEqual(await repository.list(profileId), beforeRecovery);

  await assert.rejects(
    () => repository.replaceAll(
      profileId,
      [{ transportUrl: "https://stale.example/manifest.json" }],
      1,
      { mutationFence: firstFence }
    ),
    (error) => error.code === "provider_snapshot_stale_fence"
  );
  assert.deepEqual(await repository.list(profileId), beforeRecovery);
  assert.equal(repository.storageSnapshot(profileId).mutationFence, recoveryFence);
});

test("memory provider fence allocation is global, rebased, and exhaustion-safe", async () => {
  const repository = new MemoryProviderRepository({
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
  });
  const profileId = "profile_allocator_0001";
  const otherProfileId = "profile_allocator_0002";
  const abandonedProfileId = "profile_allocator_0003";

  const allocated = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      repository.allocateMutationFence(index % 2 === 0 ? profileId : otherProfileId)
    )
  );
  assert.deepEqual(allocated, Array.from({ length: 32 }, (_, index) => String(index + 1)));
  assert.equal(repository.storageSnapshot(profileId).mutationFence, "0");
  await repository.replaceAll(abandonedProfileId, [], 0, { mutationFence: allocated[0] });
  assert.equal(repository.storageSnapshot(abandonedProfileId).mutationFence, "1");

  await repository.replaceAll(profileId, [], 0, { mutationFence: "1000" });
  assert.equal(await repository.allocateMutationFence(otherProfileId), "1001");
  await repository.advanceMutationFence(profileId, "5000");
  assert.equal(await repository.allocateMutationFence(otherProfileId), "5001");

  await repository.advanceMutationFence(otherProfileId, MAX_MUTATION_FENCE);
  await assert.rejects(
    () => repository.allocateMutationFence(profileId),
    (error) =>
      error.code === "provider_mutation_fence_exhausted" &&
      error.message === "provider mutation fence allocator exhausted"
  );
});

test("provider IDs are unique across profile collections", async () => {
  const repository = new MemoryProviderRepository({
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
    idFactory: () => "provider_collision",
  });
  const descriptor = { transportUrl: "https://example.test/manifest.json", manifest: { id: "example" } };
  await repository.replaceAll("profile_one", [descriptor], 0);
  await assert.rejects(
    () => repository.replaceAll("profile_two", [{ ...descriptor, transportUrl: "https://two.test/manifest.json" }], 0),
    /provider id collision/
  );
});

test("management sessions require both capabilities and reject cross-profile capacity eviction", async () => {
  let now = 1000;
  const repository = new MemoryManagementSessionRepository({
    tokenService: tokenService(),
    clock: () => now,
    ttlMs: 1000,
    maxSessions: 4,
    maxSessionsPerProfile: 2,
  });
  const first = await repository.issue("profile_0001");

  assert.deepEqual(await repository.authenticate(first.sessionToken, first.csrfToken), {
    profileId: "profile_0001",
    managementGeneration: 0,
    expiresAt: 2000,
  });
  assert.equal(await repository.authenticate(first.sessionToken, "wrong-token-value"), null);
  const raw = JSON.stringify(repository.storageSnapshot());
  assert.equal(raw.includes(first.sessionToken), false);
  assert.equal(raw.includes(first.csrfToken), false);

  await repository.issue("profile_0001");
  await assert.rejects(() => repository.issue("profile_0001"), /profile management session limit/);
  await repository.issue("profile_0002");
  const fourth = await repository.issue("profile_0003");
  await assert.rejects(() => repository.issue("profile_0004"), /session capacity/);
  assert.deepEqual(await repository.authenticate(first.sessionToken, first.csrfToken), {
    profileId: "profile_0001",
    managementGeneration: 0,
    expiresAt: 2000,
  });
  assert.equal(await repository.revoke(fourth.sessionToken), true);
  assert.equal(await repository.authenticate(fourth.sessionToken, fourth.csrfToken), null);

  const expiring = await repository.issue("profile_0004");
  now = expiring.expiresAt;
  assert.equal(await repository.authenticate(expiring.sessionToken, expiring.csrfToken), null);
});

test("management session token collisions never overwrite an existing session", async () => {
  const tokens = new TokenService({
    pepper: Buffer.alloc(32, 0xa5),
    randomBytes: (length) => Buffer.alloc(length, 0x44),
  });
  const repository = new MemoryManagementSessionRepository({ tokenService: tokens });
  const first = await repository.issue("profile_0001");

  await assert.rejects(() => repository.issue("profile_0002"), /session token collision/);
  assert.deepEqual(await repository.authenticate(first.sessionToken, first.csrfToken), {
    profileId: "profile_0001",
    managementGeneration: 0,
    expiresAt: first.expiresAt,
  });
});

test("initial PostgreSQL migration enforces profile ownership and encrypted secret storage", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "postgres", "0001_initial.sql"), "utf8");
  for (const table of [
    "profiles",
    "devices",
    "provider_collections",
    "providers",
    "oauth_credentials",
    "addon_collection_backups",
    "cloud_history",
  ]) {
    assert.match(sql, new RegExp("CREATE TABLE " + table + "\\b"));
  }
  assert.match(sql, /id text PRIMARY KEY CHECK \(id ~ '\^\[A-Za-z0-9_-\]\{8,128\}\$'\)/);
  assert.match(sql, /profile_id text NOT NULL REFERENCES profiles\(id\) ON DELETE CASCADE/g);
  assert.doesNotMatch(sql, /\b(?:id|profile_id) uuid\b/);
  assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(sql, /install_token_hash char\(64\) NOT NULL UNIQUE/);
  assert.match(sql, /token_hash char\(64\) NOT NULL UNIQUE/);
  assert.match(sql, /descriptor_envelope jsonb NOT NULL/);
  assert.match(sql, /credential_envelope jsonb NOT NULL/);
  assert.doesNotMatch(sql, /\b(?:install_token|device_token|auth_key|access_token|refresh_token)\s+(?:text|varchar)/i);
});

test("PostgreSQL parity migrations add sync state and correct bounded storage", () => {
  const paritySql = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "postgres", "0002_contract_parity.sql"),
    "utf8"
  );
  const correctnessSql = fs.readFileSync(
    path.join(__dirname, "..", "migrations", "postgres", "0003_storage_correctness.sql"),
    "utf8"
  );
  assert.match(paritySql, /ADD COLUMN playback_snapshot jsonb NOT NULL/);
  assert.match(paritySql, /ADD COLUMN deleted_at timestamptz/);
  assert.match(paritySql, /CREATE SEQUENCE cloud_history_change_seq/);
  assert.match(paritySql, /CREATE TABLE legacy_config_aliases/);
  assert.match(paritySql, /descriptor_envelope::text\) <= 65536/);
  assert.match(paritySql, /collection_envelope::text\) <= 4194304/);
  // Base64url needs ceil(4n/3); 170 bytes covers the largest envelope metadata
  // plus PostgreSQL's jsonb::text separators for a 64-byte key id.
  const snapshotEnvelopeLimit = Math.ceil(((64 * 1024) * 4) / 3) + 170;
  const backupEnvelopeLimit = Math.ceil(((4 * 1024 * 1024) * 4) / 3) + 170;
  assert.equal(snapshotEnvelopeLimit, 87552);
  assert.equal(backupEnvelopeLimit, 5592576);
  assert.match(
    correctnessSql,
    new RegExp("descriptor_envelope::text\\) <= " + snapshotEnvelopeLimit)
  );
  assert.match(
    correctnessSql,
    new RegExp("credential_envelope::text\\) <= " + snapshotEnvelopeLimit)
  );
  assert.match(
    correctnessSql,
    new RegExp("collection_envelope::text\\) <= " + backupEnvelopeLimit)
  );
  const jsonbStorageLimit = (64 * 1024) * 64;
  assert.equal(jsonbStorageLimit, 4194304);
  assert.match(correctnessSql, new RegExp("canonical_identity::text\\) <= " + jsonbStorageLimit));
  assert.match(correctnessSql, new RegExp("display_snapshot::text\\) <= " + jsonbStorageLimit));
  assert.match(correctnessSql, new RegExp("playback_snapshot::text\\) <= " + jsonbStorageLimit));
  assert.match(paritySql, /revision <= 9007199254740991/);
  assert.doesNotMatch(paritySql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.doesNotMatch(correctnessSql, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});
