"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  EnvelopeCrypto,
  MemoryAddonCollectionBackupRepository,
  MemoryDeviceRepository,
  MemoryHistoryRepository,
  MemoryLeaseRepository,
  MemoryLegacyConfigAliasRepository,
  MemoryLifecycleInvalidationRepository,
  MemoryManagementSessionRepository,
  MemoryOAuthCredentialRepository,
  MemoryOAuthStateRepository,
  MemoryPairingRepository,
  MemoryPlaybackSessionRepository,
  MemoryPlaybackContextRepository,
  MemoryProfileRepository,
  MemoryProviderRepository,
  MemoryRateLimitRepository,
  MemorySubtitleDeliveryRepository,
  MemorySubtitleManifestRepository,
  OpaqueObjectKeyFactory,
  ProfileLifecycleCoordinator,
  TokenService,
  assertRepositorySet,
  createMemoryRepositorySet,
  loadStorageConfig,
} = require("../lib/storage");
const {
  SourceContextStore,
  fingerprintExactUrl,
  hashOpaqueValue,
} = require("../lib/source-context");

const PROFILE_A = "profile_memory_a";
const PROFILE_B = "profile_memory_b";
const DEVICE_A = "device_memory_a";

function sequenceRandom(seed = 1) {
  let next = seed;
  return (length) => {
    const output = Buffer.alloc(length, next);
    next = next === 255 ? 1 : next + 1;
    return output;
  };
}

function createTokenService(seed = 1) {
  return new TokenService({
    pepper: Buffer.alloc(32, 0x6a),
    randomBytes: sequenceRandom(seed),
  });
}

function createEnvelopeCrypto() {
  return new EnvelopeCrypto({
    primaryKeyId: "memory-key",
    keys: { "memory-key": Buffer.alloc(32, 0x4d) },
    randomBytes: sequenceRandom(0x30),
  });
}

function activationRetryToken(byte) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function idFactory() {
  let sequence = 0;
  return (kind) => kind + "_" + String(++sequence).padStart(8, "0");
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function historyEntry(contentKey, lastPlayedAt, overrides = {}) {
  return {
    contentKey,
    canonicalIdentity: {
      provider: "imdb",
      id: "tt0133093",
      mediaType: "movie",
      provenance: "metadata-request",
      confidence: "canonical",
    },
    displaySnapshot: { title: "The Matrix", poster: "https://images.example/poster.jpg" },
    playbackSnapshot: { providerId: "provider_0001", subtitleLanguages: ["en"] },
    positionMs: 120000,
    durationMs: 8160000,
    watchedMs: 120000,
    completed: false,
    lastPlayedAt,
    ...overrides,
  };
}

test("device credentials are hashed, profile scoped, rolling, revocable, and expiring", async () => {
  let now = 1000;
  const repository = new MemoryDeviceRepository({
    tokenService: createTokenService(),
    clock: () => now,
    idFactory: () => DEVICE_A,
    ttlMs: 1000,
    touchIntervalMs: 100,
    maxDevicesPerProfile: 1,
  });
  const registered = await repository.register(PROFILE_A, { displayName: " Living room " });

  assert.equal(registered.device.profileId, PROFILE_A);
  assert.equal(registered.device.displayName, "Living room");
  assert.equal(registered.device.generation, 1);
  assert.equal(Object.hasOwn(registered.device, "tokenHash"), false);
  const raw = JSON.stringify(repository.storageSnapshot());
  assert.equal(raw.includes(registered.deviceToken), false);
  assert.match(repository.storageSnapshot()[0].tokenHash, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () => repository.register(PROFILE_A, { deviceId: "another_device" }),
    (error) => error.code === "device_limit"
  );

  now = 1150;
  const authenticated = await repository.authenticate(registered.deviceToken);
  assert.equal(authenticated.lastSeenAt, 1150);
  assert.equal(authenticated.expiresAt, 2150);
  assert.equal(authenticated.generation, 1);
  assert.equal(
    await repository.isActiveBinding(PROFILE_A, DEVICE_A, authenticated.generation),
    true
  );
  assert.equal(await repository.revoke(PROFILE_B, DEVICE_A), false);
  assert.equal(await repository.revoke(PROFILE_A, DEVICE_A), true);
  assert.equal(await repository.getGeneration(PROFILE_A, DEVICE_A), 2);
  assert.equal(await repository.revoke(PROFILE_A, DEVICE_A), true);
  assert.equal(await repository.getGeneration(PROFILE_A, DEVICE_A), 2);
  assert.equal(
    await repository.isActiveBinding(PROFILE_A, DEVICE_A, authenticated.generation),
    false
  );
  assert.equal(await repository.authenticate(registered.deviceToken), null);

  const expiring = new MemoryDeviceRepository({
    tokenService: createTokenService(9),
    clock: () => now,
    idFactory: () => "device_expiring",
    ttlMs: 1000,
    touchIntervalMs: 1000,
  });
  const second = await expiring.register(PROFILE_A);
  now = second.device.expiresAt;
  assert.equal(await expiring.authenticate(second.deviceToken), null);
});

test("pairing-linked device registration is idempotent across activation retries", async () => {
  const repository = new MemoryDeviceRepository({
    tokenService: createTokenService(),
    idFactory: () => "device_pairing_0001",
  });
  const input = {
    pairingId: "pairing_saga_0001",
    deviceToken: "A".repeat(43),
    displayName: "Kodi TV",
  };
  const first = await repository.register(PROFILE_A, input);
  const retry = await repository.register(PROFILE_A, input);

  assert.deepEqual(retry, first);
  assert.equal(repository.storageSnapshot().length, 1);
  await assert.rejects(
    () => repository.register(PROFILE_B, input),
    (error) => error.code === "pairing_device_conflict"
  );
});

test("device listing exposes only live credentials and inactive profiles fail closed", async () => {
  let now = 1000;
  let active = true;
  let sequence = 0;
  const repository = new MemoryDeviceRepository({
    tokenService: createTokenService(31),
    clock: () => now,
    idFactory: () => "device_list_" + String(++sequence).padStart(4, "0"),
    ttlMs: 1000,
    touchIntervalMs: 1000,
    isProfileActive: async () => active,
  });
  const first = await repository.register(PROFILE_A, { displayName: "First" });
  const second = await repository.register(PROFILE_A, { displayName: "Second" });
  assert.deepEqual((await repository.list(PROFILE_A)).map((device) => device.id), [
    first.device.id,
    second.device.id,
  ]);
  await repository.revoke(PROFILE_A, first.device.id);
  assert.deepEqual((await repository.list(PROFILE_A)).map((device) => device.id), [
    second.device.id,
  ]);
  now = second.device.expiresAt;
  assert.deepEqual(await repository.list(PROFILE_A), []);
  active = false;
  assert.equal(await repository.authenticate(second.deviceToken), null);
  assert.deepEqual(await repository.list(PROFILE_A), []);
  await assert.rejects(
    () => repository.revoke(PROFILE_A, second.device.id),
    (error) => error.code === "profile_inactive"
  );
});

test("OAuth credentials are encrypted per active profile with optimistic revisions", async () => {
  let now = 1000;
  let active = true;
  const repository = new MemoryOAuthCredentialRepository({
    envelopeCrypto: createEnvelopeCrypto(),
    clock: () => now,
    isProfileActive: () => active,
  });
  const credentials = {
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    expires_at: 5000,
  };
  const inserted = await repository.put(PROFILE_A, "trakt", credentials, 0);

  assert.equal(inserted.revision, 1);
  assert.deepEqual(inserted.credentials, credentials);
  assert.equal(await repository.get(PROFILE_B, "trakt"), null);
  const raw = JSON.stringify(repository.storageSnapshot());
  assert.equal(raw.includes(credentials.access_token), false);
  assert.equal(raw.includes(credentials.refresh_token), false);
  await assert.rejects(
    () => repository.put(PROFILE_A, "trakt", credentials, 0),
    (error) => error.code === "revision_conflict"
  );

  now = 2000;
  const updated = await repository.put(PROFILE_A, "trakt", { ...credentials, expires_at: 9000 }, 1);
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, 1000);
  assert.equal(updated.updatedAt, 2000);

  active = false;
  assert.equal(await repository.get(PROFILE_A, "trakt"), null);
  await assert.rejects(
    () => repository.put(PROFILE_A, "trakt", credentials, 2),
    (error) => error.code === "profile_inactive"
  );
  await assert.rejects(
    () => repository.remove(PROFILE_A, "trakt", 2),
    (error) => error.code === "profile_inactive"
  );
  active = true;
  assert.equal(await repository.remove(PROFILE_A, "trakt", 2), true);
  assert.equal(await repository.get(PROFILE_A, "trakt"), null);
});

test("memory factory OAuth writes cannot recreate credentials after profile deletion begins", async () => {
  const randomBytes = sequenceRandom(41);
  const storage = createMemoryRepositorySet(
    loadStorageConfig({ NODE_ENV: "test" }, { randomBytes }),
    {
      randomBytes,
      profileIdFactory: () => "profile_oauth_deletion_race",
    }
  );
  const created = await storage.repositories.profiles.create({ displayName: "Deleting" });
  await storage.repositories.oauthCredentials.put(
    created.profile.id,
    "trakt",
    { access_token: "initial" },
    0
  );
  await storage.repositories.profiles.beginErasure(created.profile.id, 1);

  await assert.rejects(
    () => storage.repositories.oauthCredentials.put(
      created.profile.id,
      "trakt",
      { access_token: "stale" },
      1
    ),
    (error) => error.code === "profile_inactive"
  );
  assert.equal(await storage.repositories.oauthCredentials.get(created.profile.id, "trakt"), null);
});

test("in-flight OAuth writes cannot recreate credentials after profile erasure", async () => {
  const checkStarted = deferred();
  const staleActiveResult = deferred();
  let activeCheckCount = 0;
  const repository = new MemoryOAuthCredentialRepository({
    envelopeCrypto: createEnvelopeCrypto(),
    isProfileActive: async () => {
      activeCheckCount += 1;
      if (activeCheckCount === 1) return true;
      checkStarted.resolve();
      return staleActiveResult.promise;
    },
  });
  await repository.put(PROFILE_A, "trakt", { access_token: "initial" }, 0);

  const stalePut = repository.put(
    PROFILE_A,
    "realdebrid",
    { access_token: "must-not-survive" },
    0
  );
  await checkStarted.promise;
  assert.equal(repository.eraseProfile(PROFILE_A), 1);
  staleActiveResult.resolve(true);

  await assert.rejects(stalePut, (error) => error.code === "profile_inactive");
  assert.deepEqual(repository.storageSnapshot(), []);
});

test("memory history rejects a stale authenticated device generation without recreating state", async () => {
  const devices = new MemoryDeviceRepository({
    tokenService: createTokenService(17),
    idFactory: () => "device_history_generation",
  });
  const registered = await devices.register(PROFILE_A, { displayName: "Kodi" });
  const binding = await devices.authenticate(registered.deviceToken);
  const history = new MemoryHistoryRepository({
    isDeviceBindingActive: (profileId, deviceId, generation) =>
      devices.isActiveBinding(profileId, deviceId, generation),
  });
  await devices.revoke(PROFILE_A, binding.id);

  await assert.rejects(
    () => history.upsert(PROFILE_A, historyEntry("e".repeat(64), 1000), 0, {
      deviceId: binding.id,
      deviceGeneration: binding.generation,
    }),
    (error) => error.code === "device_generation_changed"
  );
  assert.equal(await history.get(PROFILE_A, "e".repeat(64)), null);
});

test("history is profile isolated, revisioned, ordered, and rejects stale events", async () => {
  let now = 5000;
  const repository = new MemoryHistoryRepository({ clock: () => now });
  const keyA = "a".repeat(64);
  const keyB = "b".repeat(64);
  const first = await repository.upsert(PROFILE_A, historyEntry(keyA, 4000), 0);

  assert.equal(first.revision, 1);
  assert.equal(await repository.get(PROFILE_B, keyA), null);
  await repository.upsert(PROFILE_A, historyEntry(keyB, 4500, { positionMs: 1000 }), 0);
  assert.deepEqual(
    (await repository.list(PROFILE_A)).map((entry) => entry.contentKey),
    [keyB, keyA]
  );
  assert.deepEqual(
    (await repository.list(PROFILE_A, { before: 4500, limit: 1 })).map((entry) => entry.contentKey),
    [keyA]
  );
  await assert.rejects(
    () => repository.upsert(PROFILE_A, historyEntry(keyA, 3999), 1),
    (error) => error.code === "stale_history"
  );
  await assert.rejects(
    () => repository.upsert(PROFILE_A, historyEntry(keyA, 6000), 0),
    (error) => error.code === "revision_conflict"
  );
  await assert.rejects(
    () =>
      repository.upsert(
        PROFILE_A,
        historyEntry("c".repeat(64), 6000, {
          playbackSnapshot: { sourceUrl: "https://debrid.example/file?token=secret" },
        }),
        0
      ),
    /sensitive field/
  );

  now = 7000;
  const completed = await repository.upsert(
    PROFILE_A,
    historyEntry(keyA, 6000, { positionMs: 8100000, watchedMs: 8100000, completed: true }),
    1
  );
  assert.equal(completed.revision, 2);
  assert.equal(completed.completed, true);
  assert.equal(await repository.remove(PROFILE_A, keyA, 2), true);
  assert.equal(await repository.get(PROFILE_A, keyA), null);
  const changes = await repository.changes(PROFILE_A);
  assert.deepEqual(
    changes.map((entry) => entry.changeSequence),
    changes.map((entry) => entry.changeSequence).slice().sort((left, right) => left - right)
  );
  const tombstone = changes.find((entry) => entry.contentKey === keyA && entry.deletedAt !== null);
  assert.ok(tombstone);
  assert.deepEqual(tombstone.displaySnapshot, {});
  assert.deepEqual(tombstone.playbackSnapshot, {});
  assert.equal((await repository.getForWrite(PROFILE_A, keyA)).revision, 3);

  now = 8000;
  const resurrected = await repository.upsert(
    PROFILE_A,
    historyEntry(keyA, 7001, { positionMs: 2000, watchedMs: 2000 }),
    tombstone.revision
  );
  assert.equal(resurrected.revision, 4);
  assert.equal(resurrected.deletedAt, null);
  assert.equal((await repository.get(PROFILE_A, keyA)).revision, 4);
});

test("history clear physically removes current rows and fences stale sessions", async () => {
  const repository = new MemoryHistoryRepository();
  const contentKey = "e".repeat(64);
  const staleGeneration = await repository.getGeneration(PROFILE_A);
  await repository.upsert(
    PROFILE_A,
    historyEntry(contentKey, 1000),
    0,
    { generation: staleGeneration }
  );
  assert.equal(repository.storageSnapshot().length, 1);
  const currentGeneration = await repository.clear(PROFILE_A);
  assert.equal(currentGeneration, staleGeneration + 1);
  assert.deepEqual(repository.storageSnapshot(), []);
  await assert.rejects(
    () => repository.upsert(
      PROFILE_A,
      historyEntry(contentKey, 2000),
      0,
      { generation: staleGeneration }
    ),
    (error) => error.code === "history_generation_changed"
  );
  const future = await repository.upsert(
    PROFILE_A,
    historyEntry(contentKey, 3000),
    0,
    { generation: currentGeneration }
  );
  assert.equal(future.revision, 1);
});

test("memory history tuple cursors do not lose tied timestamps", async () => {
  const repository = new MemoryHistoryRepository();
  const tiedKeys = ["a", "b", "c", "d", "e"].map((value) => value.repeat(64));
  const olderKey = "f".repeat(64);
  for (const contentKey of tiedKeys) {
    await repository.upsert(PROFILE_A, historyEntry(contentKey, 5000), 0);
  }
  await repository.upsert(PROFILE_A, historyEntry(tiedKeys[4], 5000), 1);
  await repository.upsert(PROFILE_A, historyEntry(olderKey, 4000), 0);

  const pages = [];
  let cursor;
  for (;;) {
    const page = await repository.list(PROFILE_A, {
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    pages.push(...page);
    if (page.length < 2) break;
    const last = page.at(-1);
    cursor = {
      contentKey: last.contentKey,
      lastPlayedAt: last.lastPlayedAt,
      revision: last.revision,
    };
  }

  assert.deepEqual(
    pages.map((entry) => entry.contentKey),
    [tiedKeys[4], tiedKeys[0], tiedKeys[1], tiedKeys[2], tiedKeys[3], olderKey]
  );
  assert.equal(new Set(pages.map((entry) => entry.contentKey)).size, 6);
  assert.deepEqual(
    (await repository.list(PROFILE_A, { before: 5000 })).map((entry) => entry.contentKey),
    [olderKey]
  );
  await assert.rejects(
    () => repository.list(PROFILE_A, { before: 5000, cursor }),
    /mutually exclusive/
  );
});

test("addon collection backups are encrypted, profile scoped, and restorable", async () => {
  let now = 1000;
  const repository = new MemoryAddonCollectionBackupRepository({
    envelopeCrypto: createEnvelopeCrypto(),
    clock: () => now,
    idFactory: () => "backup_00000001",
  });
  const collection = [
    {
      transportUrl: "https://provider.example/secret/manifest.json?token=private",
      manifest: { id: "provider.example" },
      flags: { protected: true },
    },
  ];
  const created = await repository.create(PROFILE_A, collection, "before-provider-import");

  assert.equal(created.profileId, PROFILE_A);
  assert.equal(JSON.stringify(repository.storageSnapshot()).includes("token=private"), false);
  assert.equal(await repository.get(PROFILE_B, created.id), null);
  assert.deepEqual((await repository.get(PROFILE_A, created.id)).collection, collection);
  assert.deepEqual(await repository.list(PROFILE_A), [created]);
  now = 2000;
  assert.equal(await repository.markRestored(PROFILE_A, created.id), true);
  assert.equal((await repository.get(PROFILE_A, created.id)).restoredAt, 2000);
});

test("legacy config aliases are idempotent and cannot cross profiles", async () => {
  const repository = new MemoryLegacyConfigAliasRepository();
  const hash = "d".repeat(64);

  assert.equal(await repository.getProfileId(hash), null);
  assert.deepEqual(await repository.bind(PROFILE_A, hash), {
    legacyConfigHash: hash,
    profileId: PROFILE_A,
  });
  assert.equal(await repository.getProfileId(hash), PROFILE_A);
  assert.deepEqual(await repository.bind(PROFILE_A, hash), {
    legacyConfigHash: hash,
    profileId: PROFILE_A,
  });
  await assert.rejects(
    () => repository.bind(PROFILE_B, hash),
    (error) => error.code === "legacy_alias_conflict"
  );
});

test("pairing accepts compact or dashed codes and retries encrypted redemption idempotently", async () => {
  let now = 1000;
  const repository = new MemoryPairingRepository({
    tokenService: createTokenService(),
    envelopeCrypto: createEnvelopeCrypto(),
    clock: () => now,
    idFactory: idFactory(),
    randomBytes: sequenceRandom(1),
    ttlMs: 1000,
    tombstoneTtlMs: 1000,
  });
  const issued = await repository.issue({ deviceName: "Kodi TV" });

  assert.match(issued.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((await repository.redeem(issued.deviceCode)).status, "pending");
  const activation = {
    profileIdentityHash: "a".repeat(64),
    installId: "install_opaque_0001",
  };
  const retryToken = activationRetryToken(0x71);
  const activating = await repository.activate(issued.userCode.replace("-", ""), activation, {
    activationRetryToken: retryToken,
  });
  assert.equal(activating.status, "activating");
  assert.match(activating.activation.deviceToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.deepEqual(
    { ...activating.activation, deviceToken: undefined },
    { ...activation, deviceToken: undefined }
  );
  assert.equal((await repository.redeem(issued.deviceCode)).activationState, "activating");
  assert.deepEqual(
    await repository.activate(issued.userCode, activation, {
      activationRetryToken: retryToken,
    }),
    activating
  );
  await assert.rejects(
    () =>
      repository.activate(
        issued.userCode,
        { ...activation, profileIdentityHash: "b".repeat(64) },
        { activationRetryToken: retryToken }
      ),
    (error) => error.code === "pairing_conflict"
  );

  const raw = JSON.stringify(repository.storageSnapshot());
  assert.equal(raw.includes(issued.userCode.replace("-", "")), false);
  assert.equal(raw.includes(issued.deviceCode), false);
  assert.equal(raw.includes(retryToken), false);
  assert.equal(raw.includes(activating.activation.deviceToken), false);
  assert.equal(
    (await repository.completeActivation(activating.pairingId, activating.activationDigest, { profileId: PROFILE_A })).status,
    "activated"
  );
  assert.equal(
    (await repository.completeActivation(activating.pairingId, activating.activationDigest, { profileId: PROFILE_A })).status,
    "activated"
  );
  const redeemed = await repository.redeem(issued.deviceCode);
  assert.equal(redeemed.status, "redeemed");
  assert.deepEqual(redeemed.activation, { ...activating.activation, profileId: PROFILE_A });
  assert.deepEqual(await repository.redeem(issued.deviceCode), redeemed);
  now += 1000;
  assert.equal((await repository.redeem(issued.deviceCode)).status, "not_found");

  const expiring = await repository.issue();
  now = expiring.expiresAt;
  assert.equal((await repository.redeem(expiring.deviceCode)).status, "expired");
});

test("memory pairing canonicalizes JSON-lossy activation once before persistence and retry comparison", async () => {
  const repository = new MemoryPairingRepository({
    tokenService: createTokenService(),
    envelopeCrypto: createEnvelopeCrypto(),
    idFactory: idFactory(),
    randomBytes: sequenceRandom(1),
  });
  const issued = await repository.issue();
  const activation = {
    profileIdentityHash: "a".repeat(64),
    installId: "install_lossy_0001",
    profileId: PROFILE_B,
    deviceToken: "caller-token-must-be-ignored",
    ignored: undefined,
    callback() {},
    nested: [undefined, "kept"],
  };

  const retryToken = activationRetryToken(0x72);
  const activating = await repository.activate(issued.userCode, activation, {
    activationRetryToken: retryToken,
  });
  assert.equal(Object.hasOwn(activating.activation, "ignored"), false);
  assert.equal(Object.hasOwn(activating.activation, "callback"), false);
  assert.equal(Object.hasOwn(activating.activation, "profileId"), false);
  assert.notEqual(activating.activation.deviceToken, activation.deviceToken);
  assert.deepEqual(activating.activation.nested, [null, "kept"]);
  assert.equal(Object.hasOwn(activation, "ignored"), true, "normalization mutated caller input");
  assert.deepEqual(
    await repository.activate(
      issued.userCode,
      {
        profileIdentityHash: "a".repeat(64),
        installId: "install_lossy_0001",
        profileId: PROFILE_A,
        deviceToken: "different-caller-token-is-also-ignored",
        nested: [null, "kept"],
      },
      { activationRetryToken: retryToken }
    ),
    activating
  );

  const unsafe = await repository.issue();
  const unsafeRetryToken = activationRetryToken(0x73);
  await assert.rejects(
    repository.activate(
      unsafe.userCode,
      { progress: Number.MAX_SAFE_INTEGER + 1 },
      { activationRetryToken: unsafeRetryToken }
    ),
    /non-safe integer/
  );
  assert.equal(
    (
      await repository.activate(
        unsafe.userCode,
        { progress: 1 },
        { activationRetryToken: unsafeRetryToken }
      )
    ).status,
    "activating"
  );
});

test("legacy pairing completion can be finalized once before redemption", async () => {
  const repository = new MemoryPairingRepository({
    tokenService: createTokenService(),
    envelopeCrypto: createEnvelopeCrypto(),
    idFactory: idFactory(),
    randomBytes: sequenceRandom(1),
  });
  const issued = await repository.issue();
  const activating = await repository.activate(
    issued.userCode,
    {
      profileIdentityHash: "a".repeat(64),
      installId: "install_opaque_0001",
    },
    { activationRetryToken: activationRetryToken(0x74) }
  );

  const legacy = await repository.completeActivation(
    activating.pairingId,
    activating.activationDigest
  );
  assert.equal(legacy.status, "activated");
  assert.equal(Object.hasOwn(legacy.activation, "profileId"), false);
  assert.deepEqual(await repository.redeem(issued.deviceCode), {
    status: "pending",
    activationState: "awaiting_profile_finalization",
    pairingId: activating.pairingId,
    expiresAt: activating.expiresAt,
  });

  const finalized = await repository.completeActivation(
    activating.pairingId,
    activating.activationDigest,
    { profileId: PROFILE_A }
  );
  assert.equal(finalized.activation.profileId, PROFILE_A);
  await assert.rejects(
    () =>
      repository.completeActivation(activating.pairingId, activating.activationDigest, {
        profileId: PROFILE_B,
      }),
    (error) => error.code === "pairing_conflict"
  );
  assert.equal((await repository.redeem(issued.deviceCode)).activation.profileId, PROFILE_A);
});

test("OAuth state is encrypted, profile-bound, one-time, cancellable, and expiring", async () => {
  let now = 1000;
  const repository = new MemoryOAuthStateRepository({
    tokenService: createTokenService(),
    envelopeCrypto: createEnvelopeCrypto(),
    clock: () => now,
    ttlMs: 1000,
  });
  const payload = { nonce: "cookie-bound-secret", redirectPath: "/configure" };
  const issued = await repository.issue(PROFILE_A, payload);

  const raw = JSON.stringify(repository.storageSnapshot());
  assert.equal(raw.includes(issued.stateToken), false);
  assert.equal(raw.includes(issued.browserBindingToken), false);
  assert.equal(raw.includes(payload.nonce), false);
  assert.equal(await repository.consume(issued.stateToken, "wrong-browser-binding"), null);
  const consumed = await repository.consume(issued.stateToken, issued.browserBindingToken);
  assert.equal(consumed.profileId, PROFILE_A);
  assert.deepEqual(consumed.payload, payload);
  assert.equal(await repository.consume(issued.stateToken, issued.browserBindingToken), null);

  const cancelled = await repository.issue(PROFILE_A, payload);
  assert.equal(await repository.cancel(cancelled.stateToken), true);
  assert.equal(await repository.consume(cancelled.stateToken, cancelled.browserBindingToken), null);
  const expired = await repository.issue(PROFILE_A, payload);
  now = expired.expiresAt;
  assert.equal(await repository.consume(expired.stateToken, expired.browserBindingToken), null);
});

test("memory OAuth canonicalizes lossy payloads and rejects Redis-incompatible numbers", async () => {
  const repository = new MemoryOAuthStateRepository({
    tokenService: createTokenService(),
    envelopeCrypto: createEnvelopeCrypto(),
  });

  await assert.rejects(
    repository.issue(PROFILE_A, { revision: Number.MAX_SAFE_INTEGER + 1 }),
    /non-safe integer/
  );
  await assert.rejects(repository.issue(PROFILE_A, { progress: 1.5 }), /non-safe integer/);

  const issued = await repository.issue(PROFILE_A, {
    redirectPath: "/configure",
    ignored: undefined,
    callback() {},
    nested: [undefined, "kept"],
  });
  const consumed = await repository.consume(issued.stateToken, issued.browserBindingToken);
  assert.deepEqual(consumed.payload, {
    redirectPath: "/configure",
    nested: [null, "kept"],
  });
});

test("OAuth state decryption failure does not consume the callback capability", async () => {
  const crypto = createEnvelopeCrypto();
  let failDecryption = true;
  const repository = new MemoryOAuthStateRepository({
    tokenService: createTokenService(),
    envelopeCrypto: {
      encryptJson: crypto.encryptJson.bind(crypto),
      decryptJson(...args) {
        if (failDecryption) throw new Error("temporary key failure");
        return crypto.decryptJson(...args);
      },
    },
  });
  const issued = await repository.issue(PROFILE_A, { redirectPath: "/configure" });

  await assert.rejects(
    () => repository.consume(issued.stateToken, issued.browserBindingToken),
    /temporary key failure/
  );
  failDecryption = false;
  const consumed = await repository.consume(issued.stateToken, issued.browserBindingToken);
  assert.equal(consumed.profileId, PROFILE_A);
  assert.deepEqual(consumed.payload, { redirectPath: "/configure" });
  assert.equal(Number.isSafeInteger(consumed.createdAt), true);
  assert.equal(Number.isSafeInteger(consumed.expiresAt), true);
  assert.equal(await repository.consume(issued.stateToken, issued.browserBindingToken), null);
});

test("memory OAuth state is fenced by the authenticated management generation", async () => {
  const randomBytes = sequenceRandom(73);
  const storage = createMemoryRepositorySet(
    loadStorageConfig({ NODE_ENV: "test" }, { randomBytes }),
    {
      randomBytes,
      profileIdFactory: () => "profile_management_oauth_fence",
    }
  );
  const profile = (await storage.repositories.profiles.create({ displayName: "OAuth fence" })).profile;
  const management = await storage.repositories.managementSessions.issue(profile.id);
  const binding = await storage.repositories.managementSessions.authenticate(
    management.sessionToken,
    management.csrfToken
  );
  assert.equal(binding.managementGeneration, 0);
  const state = await storage.repositories.oauthStates.issue(
    profile.id,
    { kind: "management-trakt-connect" },
    { managementGeneration: binding.managementGeneration }
  );

  await storage.repositories.managementSessions.revokeProfile(profile.id);
  assert.equal(
    await storage.repositories.oauthStates.consume(
      state.stateToken,
      state.browserBindingToken
    ),
    null
  );
  await assert.rejects(
    () => storage.repositories.oauthStates.issue(
      profile.id,
      { kind: "management-trakt-connect" },
      { managementGeneration: binding.managementGeneration }
    ),
    (error) => error.code === "profile_inactive"
  );
});

test("leases use compare-and-delete ownership and expire without plaintext keys", async () => {
  let now = 1000;
  const repository = new MemoryLeaseRepository({
    tokenService: createTokenService(),
    clock: () => now,
  });
  const first = await repository.acquire("trakt-refresh", PROFILE_A, "instance_0001", 1000);

  assert.equal(first.acquired, true);
  assert.equal((await repository.acquire("trakt-refresh", PROFILE_A, "instance_0002", 1000)).acquired, false);
  assert.equal(await repository.release("trakt-refresh", PROFILE_A, "wrong-token-value"), false);
  assert.deepEqual(await repository.renew("trakt-refresh", PROFILE_A, "wrong-token-value", 1000), {
    renewed: false,
  });
  now = 1500;
  assert.deepEqual(await repository.renew("trakt-refresh", PROFILE_A, first.leaseToken, 1000), {
    renewed: true,
    expiresAt: 2500,
  });
  assert.equal(JSON.stringify(repository.storageSnapshot()).includes(PROFILE_A), false);
  assert.equal(await repository.release("trakt-refresh", PROFILE_A, first.leaseToken), true);

  const expiring = await repository.acquire("trakt-refresh", PROFILE_A, "instance_0001", 1000);
  now = expiring.expiresAt;
  const reacquired = await repository.acquire("trakt-refresh", PROFILE_A, "instance_0002", 1000);
  assert.equal(reacquired.acquired, true);
});

test("distributed rate-limit model is atomic per hashed key and fixed window", async () => {
  let now = 1000;
  const repository = new MemoryRateLimitRepository({
    tokenService: createTokenService(),
    clock: () => now,
  });

  assert.deepEqual(await repository.consume("pair-activate", "profile-or-network", 2, 1000), {
    allowed: true,
    remaining: 1,
    resetAt: 2000,
  });
  assert.equal((await repository.consume("pair-activate", "profile-or-network", 2, 1000)).allowed, true);
  assert.equal((await repository.consume("pair-activate", "profile-or-network", 2, 1000)).allowed, false);
  assert.equal(JSON.stringify(repository.storageSnapshot()).includes("profile-or-network"), false);
  await assert.rejects(
    () => repository.consume("pair-activate", "profile-or-network", 3, 1000),
    (error) => error.code === "rate_limit_policy_mismatch"
  );

  now = 2000;
  assert.equal((await repository.consume("pair-activate", "profile-or-network", 2, 1000)).allowed, true);
  assert.equal(await repository.reset("pair-activate", "profile-or-network"), true);
});

test("playback context repository records, claims, releases, and prunes", async () => {
  let now = 1000;
  let sequence = 0;
  const repository = new MemoryPlaybackContextRepository({
    sourceContextOptions: {
      clock: () => now,
      idFactory: (kind) => kind + "_" + String(++sequence).padStart(8, "0"),
      ttlMs: 1000,
      tombstoneTtlMs: 1000,
    },
  });
  const url = "https://cdn.example/playback.mkv?token=signed";
  const context = await repository.record(PROFILE_A, {
    contentKey: hashOpaqueValue("movie:tt0133093"),
    canonicalIdentity: {
      provider: "imdb",
      id: "tt0133093",
      mediaType: "movie",
      season: null,
      episode: null,
      provenance: "metadata-request",
      confidence: "canonical",
    },
    traktEligible: true,
    request: { type: "movie", metaId: "tt0133093", videoId: "tt0133093" },
    source: { url },
  });
  const request = {
    attemptId: "00000000-0000-4000-8000-000000000301",
    fingerprints: [fingerprintExactUrl(url)],
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: now,
  };
  const claimAuthority = {
    generation: "g1:0",
    deviceGeneration: 1,
    sessionId: "session_memory_context_0001",
    requestDigest: hashOpaqueValue(JSON.stringify(request)),
  };
  const claim = await repository.claim(PROFILE_A, DEVICE_A, request, claimAuthority);

  assert.equal(context.profileId, PROFILE_A);
  assert.equal(claim.status, "claimed");
  assert.equal(await repository.release(PROFILE_A, DEVICE_A, claim.sessionId), true);
  assert.equal(
    (await repository.claim(PROFILE_A, DEVICE_A, request, claimAuthority)).status,
    "not_found"
  );
  now = 3000;
  const stats = await repository.prune();
  assert.equal(stats.contexts, 0);
});

test("memory playback rejects equivalent subtitle overflow atomically", async () => {
  let now = 1000;
  let sequence = 0;
  const repository = new MemoryPlaybackContextRepository({
    clock: () => now,
    idFactory: (kind) => kind + "_capacity_" + ++sequence,
  });
  const url = "https://cdn.example/playback-capacity.mkv";
  const input = (subtitles) => ({
    contentKey: hashOpaqueValue("movie:playback-capacity"),
    canonicalIdentity: null,
    traktEligible: false,
    request: {},
    display: { tags: [] },
    source: { url },
    inlineSubtitles: subtitles,
  });
  const first = await repository.record(
    PROFILE_A,
    input(Array.from({ length: 64 }, (_value, index) => ({ id: "s" + index, parts: [] })))
  );
  const before = JSON.stringify(repository._store._contexts.get(first.contextId));
  now += 1;

  await assert.rejects(
    () => repository.record(PROFILE_A, input([{ id: "s64", parts: [] }])),
    /inlineSubtitles exceeds the maximum array length/
  );
  assert.equal(JSON.stringify(repository._store._contexts.get(first.contextId)), before);
  assert.deepEqual(first.display.tags, []);
  assert.deepEqual(first.inlineSubtitles[0].parts, []);
});

test("memory management issuance cannot recreate state after a stale active-profile check", async () => {
  const entered = deferred();
  const release = deferred();
  const repository = new MemoryManagementSessionRepository({
    tokenService: createTokenService(),
    isProfileActive: async () => {
      entered.resolve();
      await release.promise;
      return true;
    },
  });

  const issuing = repository.issue(PROFILE_A);
  await entered.promise;
  await repository.revokeProfile(PROFILE_A);
  release.resolve();

  await assert.rejects(issuing, /profile.*changed|inactive/i);
  assert.deepEqual(repository.storageSnapshot(), []);
});

test("memory pairing replay expires without reminting and stores credentials only encrypted", async () => {
  let now = 1000;
  const repository = new MemoryManagementSessionRepository({
    tokenService: createTokenService(83),
    envelopeCrypto: createEnvelopeCrypto(),
    clock: () => now,
    ttlMs: 15 * 60 * 1000,
    pairingReplayTtlMs: 10 * 60 * 1000,
  });
  const retryToken = activationRetryToken(0x75);
  const input = {
    pairingId: "pairing_replay_expiry_0001",
    profileId: PROFILE_A,
    configHash: "a".repeat(64),
    activationRetryToken: retryToken,
    activationRetryExpiresAt: now + 10 * 60 * 1000,
    authority: { schemaVersion: 1, profileId: PROFILE_A },
  };
  const issued = await repository.issueForPairing(input);
  const rawReplay = JSON.stringify(repository.pairingReplaySnapshot());
  assert.equal(rawReplay.includes(retryToken), false);
  assert.equal(rawReplay.includes(issued.sessionToken), false);
  assert.equal(rawReplay.includes(issued.csrfToken), false);
  assert.equal(repository.storageSnapshot().length, 1);

  now = input.activationRetryExpiresAt;
  assert.deepEqual(await repository.recoverPairing(input), { status: "not_found" });
  assert.deepEqual(await repository.issueForPairing(input), { status: "denied" });
  assert.equal(repository.storageSnapshot().length, 1);
});

test("the complete in-memory repository set satisfies every declared contract", () => {
  const randomBytes = sequenceRandom(91);
  const { repositories } = createMemoryRepositorySet(
    loadStorageConfig({ NODE_ENV: "test" }, { randomBytes }),
    { randomBytes }
  );

  assert.equal(assertRepositorySet(repositories), repositories);
  assert.equal(repositories.profiles._subtitleManifests, repositories.subtitleManifests);
  assert.equal(repositories.devices._subtitleManifests, repositories.subtitleManifests);
});
