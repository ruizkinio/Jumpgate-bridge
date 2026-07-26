"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const { ProfileLifecycleService } = require("../lib/profile-lifecycle-service");
const { ProfileProvisioner } = require("../lib/profile-provisioner");
const { fingerprintExactUrl, hashOpaqueValue } = require("../lib/source-context");
const { createMemoryRepositorySet, loadStorageConfig } = require("../lib/storage");
const { SubtitleDeletionWorker } = require("../lib/subtitle-deletion-worker");

function sequenceRandom(seed = 1) {
  let value = seed;
  return (length) => {
    const output = Buffer.alloc(length, value);
    value = value === 255 ? 1 : value + 1;
    return output;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function settledWithin(promise, timeoutMs) {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function historyEntry(contentKey) {
  return {
    contentKey,
    canonicalIdentity: null,
    displaySnapshot: { title: "Lifecycle" },
    playbackSnapshot: {},
    positionMs: 100,
    durationMs: 1000,
    watchedMs: 100,
    completed: false,
    lastPlayedAt: 1000,
  };
}

test("history clear validates its boundary and delegates without rewriting outcomes", async () => {
  const randomBytes = sequenceRandom(9);
  const storage = createMemoryRepositorySet(
    loadStorageConfig({ NODE_ENV: "test" }, { randomBytes }),
    { randomBytes }
  );
  const base = {
    profiles: storage.repositories.profiles,
    managementSessions: storage.repositories.managementSessions,
    subtitleManifests: storage.repositories.subtitleManifests,
    providerGateway: { async clearProfile() {} },
  };
  const withoutHistoryGrants = new ProfileLifecycleService(base);
  await assert.rejects(
    () => withoutHistoryGrants.clearHistory("profile_clear_service_0001"),
    /history grant lifecycle dependency is required/
  );

  const calls = [];
  const result = Object.freeze({
    previousGeneration: 1,
    historyGeneration: 2,
    revokedGrants: 3,
    releasedSessions: 4,
  });
  let failure = null;
  const lifecycle = new ProfileLifecycleService({
    ...base,
    historyGrants: {
      async clearHistory(profileId) {
        calls.push(profileId);
        if (failure) throw failure;
        return result;
      },
    },
  });

  await assert.rejects(() => lifecycle.clearHistory("bad id"), /profile id/);
  assert.deepEqual(calls, []);
  assert.equal(await lifecycle.clearHistory("profile_clear_service_0001"), result);
  assert.deepEqual(calls, ["profile_clear_service_0001"]);

  failure = new Error("controlled atomic clear failure");
  await assert.rejects(
    () => lifecycle.clearHistory("profile_clear_service_0002"),
    (error) => error === failure
  );
  assert.deepEqual(calls, ["profile_clear_service_0001", "profile_clear_service_0002"]);
});

test("profile erasure fences auth first, resumes safely, erases children, and tombstones identity", async () => {
  const randomBytes = sequenceRandom(11);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_lifecycle_0001",
    deviceIdFactory: () => "device_lifecycle_0001",
    backupIdFactory: () => "backup_lifecycle_0001",
  });
  const repositories = storage.repositories;
  const provisioner = new ProfileProvisioner({
    profiles: repositories.profiles,
    legacyConfigAliases: repositories.legacyConfigAliases,
    envelopeCrypto: storage.envelopeCrypto,
  });
  const configBlob = "L".repeat(64);
  const profileConfig = { profileId: "configured_lifecycle_profile_0001" };
  const provisioned = await provisioner.provision({
    config: profileConfig,
    configBlob,
    displayName: "Lifecycle profile",
    settings: { subtitles_enabled: true },
  });
  const profileId = provisioned.profile.id;
  const device = await repositories.devices.register(profileId, { displayName: "Kodi TV" });
  const managementA = await repositories.managementSessions.issue(profileId);
  const managementB = await repositories.managementSessions.issue(profileId);
  await repositories.oauthCredentials.put(
    profileId,
    "trakt",
    { access_token: "secret", refresh_token: "secret-refresh" },
    0
  );
  await repositories.history.upsert(profileId, historyEntry("a".repeat(64)), 0, {
    generation: 1,
  });
  await repositories.addonCollectionBackups.create(
    profileId,
    [{ transportUrl: "https://provider.example/manifest.json?token=secret" }],
    "before-erasure"
  );

  let clearAttempts = 0;
  let allowClear = false;
  const lifecycle = new ProfileLifecycleService({
    profiles: repositories.profiles,
    managementSessions: repositories.managementSessions,
    subtitleManifests: repositories.subtitleManifests,
    providerGateway: {
      async clearProfile(id) {
        assert.equal(id, profileId);
        clearAttempts += 1;
        if (!allowClear) throw new Error("temporary invalidation failure");
        await repositories.playbackContexts.invalidateProfile(id);
        await repositories.subtitleDeliveries.invalidateProfile(id);
      },
    },
  });

  const accepted = await lifecycle.requestErasure(profileId);
  assert.equal(accepted.status, "pending");
  assert.equal((await repositories.profiles.getById(profileId)).status, "revoked");
  assert.equal(await repositories.devices.authenticate(device.deviceToken), null);
  assert.equal(
    await repositories.managementSessions.authenticate(
      managementA.sessionToken,
      managementA.csrfToken
    ),
    null
  );
  assert.equal(
    await repositories.managementSessions.authenticate(
      managementB.sessionToken,
      managementB.csrfToken
    ),
    null
  );

  allowClear = true;
  assert.deepEqual(await lifecycle.resumePending(8), {
    processed: 1,
    completed: 1,
    failed: 0,
  });
  assert.equal(clearAttempts, 2);
  assert.equal((await lifecycle.requestErasure(profileId)).status, "deleted");
  const tombstone = await repositories.profiles.getById(profileId);
  assert.equal(tombstone.status, "revoked");
  assert.equal(tombstone.deletionState, "deleted");
  assert.equal(tombstone.displayName, "");
  assert.equal(tombstone.settingsEnvelope, null);
  assert.equal(await repositories.profiles.getByInstallToken(provisioned.installToken), null);
  assert.deepEqual(repositories.devices.storageSnapshot(), []);
  assert.deepEqual(repositories.oauthCredentials.storageSnapshot(), []);
  assert.deepEqual(repositories.history.storageSnapshot(), []);
  assert.deepEqual(repositories.addonCollectionBackups.storageSnapshot(), []);
  assert.ok(repositories.legacyConfigAliases.storageSnapshot().length >= 2);
  await assert.rejects(
    () => provisioner.provision({
      config: profileConfig,
      configBlob,
      displayName: "Must not return",
      settings: {},
    }),
    (error) => error.code === "profile_unavailable"
  );
});

test("profile erasure retains subtitle deletion fences through late-PUT-safe two-pass cleanup", async () => {
  let now = 1000;
  let contextSequence = 0;
  const randomBytes = sequenceRandom(41);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => now,
    profileIdFactory: () => "profile_lifecycle_subtitles_0001",
    deviceIdFactory: () => "device_lifecycle_subtitles_0001",
    sourceContextOptions: {
      clock: () => now,
      idFactory: (kind) => kind + "_lifecycle_" + String(++contextSequence).padStart(8, "0"),
      ttlMs: 10_000,
      tombstoneTtlMs: 10_000,
    },
    subtitleDeliveryOptions: {
      clock: () => now,
      idFactory: () => "artifact_lifecycle_subtitles_0001",
      logicalTtlMs: 1000,
      absoluteTtlMs: 5000,
      uploadLeaseTtlMs: 10,
      maxPutLifetimeMs: 10,
      uploadSettlementGraceMs: 5,
      ioLeaseTtlMs: 10,
      deletionLeaseTtlMs: 10,
      maxDeletionRetryMs: 100,
    },
  });
  const repositories = storage.repositories;
  const provisioner = new ProfileProvisioner({
    profiles: repositories.profiles,
    legacyConfigAliases: repositories.legacyConfigAliases,
    envelopeCrypto: storage.envelopeCrypto,
  });
  const provisioned = await provisioner.provision({
    config: { profileId: "configured_lifecycle_subtitles_0001" },
    configBlob: "S".repeat(64),
    displayName: "Lifecycle subtitle profile",
    settings: {},
  });
  const profileId = provisioned.profile.id;
  const device = await repositories.devices.register(profileId, { displayName: "Kodi TV" });
  const mediaUrl = "https://media.example/lifecycle.mkv?source=private";
  const fingerprint = fingerprintExactUrl(mediaUrl);
  const recorded = await repositories.playbackContexts.record(profileId, {
    contentKey: hashOpaqueValue("movie:lifecycle-subtitle-erasure"),
    canonicalIdentity: {
      provider: "imdb",
      id: "tt0133093",
      mediaType: "movie",
      season: null,
      episode: null,
      confidence: "canonical",
      provenance: "metadata-request",
    },
    traktEligible: true,
    request: {
      resource: "stream",
      type: "movie",
      metaId: "tt0133093",
      videoId: "tt0133093",
      metaProvider: "metadata-provider",
      streamProvider: "stream-provider",
    },
    display: { title: "The Matrix", year: 1999 },
    source: { type: "url", provider: "stream-provider", url: mediaUrl },
    fingerprints: [fingerprint],
    inlineSubtitles: [],
  });
  const claimRequest = {
    attemptId: "00000000-0000-4000-8000-000000000201",
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(mediaUrl),
    launchedAt: now,
  };
  const claim = await repositories.playbackContexts.claim(
    profileId,
    device.device.id,
    claimRequest,
    {
      generation: "g1:0",
      deviceGeneration: device.device.generation,
      sessionId: "session_erasure_subtitle_0001",
      requestDigest: hashOpaqueValue(JSON.stringify(claimRequest)),
    }
  );
  assert.equal(claim.status, "claimed");
  const active = await repositories.playbackContexts.getActiveClaim(
    profileId,
    device.device.id,
    claim.sessionId
  );
  const binding = active.deliveryBinding;
  await repositories.subtitleDeliveries.reconcileAuthority({
    profileId,
    providerRevision: binding.providerRevision,
    generation: binding.generation,
  });
  const artifact = await repositories.subtitleDeliveries.reserve({
    ...binding,
    discoveryKey: "profile-erasure-subtitle",
    sourceCapability: {
      url: "https://subs.example/lifecycle.srt?token=private",
      headers: { Authorization: "Bearer private" },
    },
  });
  const fetch = await repositories.subtitleDeliveries.beginFetch({
    artifactId: artifact.artifactId,
    ...binding,
  });
  const body = Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nLifecycle\n");
  const checksum = crypto.createHash("sha256").update(body).digest("hex");
  const staged = await repositories.subtitleDeliveries.stageUpload({
    artifactId: artifact.artifactId,
    ...binding,
    fetchToken: fetch.fetchToken,
    parts: [{
      partNumber: 1,
      sizeBytes: body.length,
      checksum,
      role: "subtitle",
      extension: ".srt",
      mediaType: "application/x-subrip",
    }],
  });
  const part = staged.parts[0];
  const objectOptions = {
    checksumSha256: checksum,
    contentLength: body.length,
    contentType: "application/x-subrip",
  };
  await storage.subtitleObjectStore.put(part.objectKey, body, objectOptions);
  await repositories.subtitleDeliveries.commit({
    artifactId: artifact.artifactId,
    ...binding,
    uploadToken: staged.uploadToken,
    receipts: [{
      partNumber: 1,
      objectKey: part.objectKey,
      sizeBytes: body.length,
      checksum,
      mediaType: "application/x-subrip",
    }],
  });

  const lifecycle = new ProfileLifecycleService({
    profiles: repositories.profiles,
    managementSessions: repositories.managementSessions,
    subtitleManifests: repositories.subtitleManifests,
    providerGateway: {
      async clearProfile(id) {
        assert.equal(id, profileId);
        await repositories.playbackContexts.invalidateProfile(id);
        await repositories.subtitleDeliveries.invalidateProfile(id);
      },
    },
  });
  assert.equal((await lifecycle.requestErasure(profileId)).status, "deleted");
  assert.equal((await storage.subtitleObjectStore.head(part.objectKey)).contentLength, body.length);
  now += 25;

  const worker = new SubtitleDeletionWorker({
    repository: repositories.subtitleDeliveries,
    objectStore: storage.subtitleObjectStore,
    workerId: "worker_lifecycle_subtitles_0001",
    retryDelayMs: 5,
  });
  const first = await worker.runOnce();
  assert.equal(first.phase, "first");
  assert.equal(first.status, "awaiting_second_pass");
  await assert.rejects(
    storage.subtitleObjectStore.head(part.objectKey),
    (error) => error.code === "object_store_not_found"
  );

  // Simulate a PUT that settled after the first absence check.
  await storage.subtitleObjectStore.put(part.objectKey, body, objectOptions);
  now += 5;
  const second = await worker.runOnce();
  assert.equal(second.phase, "second");
  assert.equal(second.status, "confirmed");
  await assert.rejects(
    storage.subtitleObjectStore.head(part.objectKey),
    (error) => error.code === "object_store_not_found"
  );
});

test("failed device invalidation stays durable and stale authentication cannot claim before retry", async () => {
  let now = 1000;
  const randomBytes = sequenceRandom(71);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => now,
    profileIdFactory: () => "profile_device_outbox_0001",
    deviceIdFactory: () => "device_device_outbox_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Outbox profile" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });

  let allowPlaybackInvalidation = false;
  let playbackInvalidations = 0;
  let subtitleInvalidations = 0;
  let claims = 0;
  const lifecycle = new ProfileLifecycleService({
    profiles: repositories.profiles,
    devices: repositories.devices,
    lifecycleInvalidations: repositories.lifecycleInvalidations,
    managementSessions: repositories.managementSessions,
    subtitleManifests: repositories.subtitleManifests,
    providerGateway: { async clearProfile() {} },
    playbackContexts: {
      async claim() {
        claims += 1;
        return { status: "not_found" };
      },
      async release() { return false; },
      async invalidateDevice() {
        playbackInvalidations += 1;
        if (!allowPlaybackInvalidation) throw new Error("controlled playback invalidation failure");
      },
    },
    subtitleDeliveries: {
      async invalidateDevice() {
        subtitleInvalidations += 1;
      },
    },
    clock: () => now,
    retryBaseMs: 10,
    retryMaxMs: 100,
  });
  const staleBinding = {
    profileId: created.profile.id,
    profileRevision: created.profile.revision,
    deviceId: registered.device.id,
    deviceGeneration: registered.device.generation,
    playbackGeneration: "g1:0",
  };

  await assert.rejects(
    lifecycle.revokeDevice(created.profile.id, registered.device.id),
    /controlled playback invalidation failure/
  );
  assert.equal(await repositories.devices.authenticate(registered.deviceToken), null);
  assert.equal(
    await repositories.devices.getGeneration(created.profile.id, registered.device.id),
    2
  );
  assert.deepEqual(
    [await repositories.lifecycleInvalidations.getPending(
      "device",
      created.profile.id,
      registered.device.id
    )].map((item) => ({
      kind: item.kind,
      profileId: item.profileId,
      deviceId: item.deviceId,
      deviceGeneration: item.deviceGeneration,
    })),
    [{
      kind: "device",
      profileId: created.profile.id,
      deviceId: registered.device.id,
      deviceGeneration: 2,
    }]
  );
  await assert.rejects(
    lifecycle.claim(staleBinding, {}, {
      sessionId: "session_stale_device_0001",
      requestDigest: "4".repeat(64),
    }),
    (error) => error.code === "device_generation_changed"
  );
  assert.equal(claims, 0);

  allowPlaybackInvalidation = true;
  now += 10;
  assert.deepEqual(await lifecycle.resumeInvalidations(8), {
    processed: 1,
    completed: 1,
    failed: 0,
  });
  assert.equal(playbackInvalidations, 2);
  assert.equal(subtitleInvalidations, 1);
  assert.equal(
    await repositories.lifecycleInvalidations.getPending(
      "device",
      created.profile.id,
      registered.device.id
    ),
    null
  );
});

test("device invalidation fences playback before both subtitle sweeps and outbox completion", async () => {
  const randomBytes = sequenceRandom(76);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_device_sweep_order_0001",
    deviceIdFactory: () => "device_device_sweep_order_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Sweep order" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });
  const order = [];
  const manifests = new Proxy(repositories.subtitleManifests, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "requestDeviceDeletion") {
        return async (...args) => {
          order.push("durable-subtitle-sweep");
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const invalidations = new Proxy(repositories.lifecycleInvalidations, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "complete") {
        return async (...args) => {
          order.push("outbox-complete");
          return value.apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const lifecycle = new ProfileLifecycleService({
    profiles: repositories.profiles,
    devices: repositories.devices,
    lifecycleInvalidations: invalidations,
    managementSessions: repositories.managementSessions,
    providerGateway: { async clearProfile() {} },
    playbackContexts: {
      async claim() { return { status: "not_found" }; },
      async invalidateDevice() { order.push("playback"); },
    },
    subtitleDeliveries: {
      async invalidateDevice() { order.push("redis-subtitle-sweep"); },
    },
    subtitleManifests: manifests,
  });

  assert.equal(await lifecycle.revokeDevice(created.profile.id, registered.device.id), true);
  assert.deepEqual(order, [
    "playback",
    "redis-subtitle-sweep",
    "durable-subtitle-sweep",
    "outbox-complete",
  ]);
});

test("stalled claim work holds no durable revocation lock and is fenced before return", async () => {
  const randomBytes = sequenceRandom(81);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_claim_revoke_race_0001",
    deviceIdFactory: () => "device_claim_revoke_race_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Race profile" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });
  let enterClaim;
  let releaseClaim;
  const entered = new Promise((resolve) => {
    enterClaim = resolve;
  });
  const release = new Promise((resolve) => {
    releaseClaim = resolve;
  });
  const order = [];
  const lifecycle = new ProfileLifecycleService({
    profiles: repositories.profiles,
    devices: repositories.devices,
    lifecycleInvalidations: repositories.lifecycleInvalidations,
    managementSessions: repositories.managementSessions,
    subtitleManifests: repositories.subtitleManifests,
    providerGateway: { async clearProfile() {} },
    playbackContexts: {
      async claim() {
        enterClaim();
        await release;
        order.push("claim");
        return { status: "not_found" };
      },
      async release() { return false; },
      async invalidateDevice() {
        order.push("playback-invalidation");
      },
    },
    subtitleDeliveries: {
      async invalidateDevice() {
        order.push("subtitle-invalidation");
      },
    },
  });
  const binding = {
    profileId: created.profile.id,
    profileRevision: created.profile.revision,
    deviceId: registered.device.id,
    deviceGeneration: registered.device.generation,
    playbackGeneration: "g1:0",
  };

  const claim = lifecycle.claim(binding, {}, {
    sessionId: "history_session_revoke_race_0001",
    requestDigest: "1".repeat(64),
  });
  await entered;
  const revocation = lifecycle.revokeDevice(created.profile.id, registered.device.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    await repositories.devices.getGeneration(created.profile.id, registered.device.id),
    2
  );
  assert.deepEqual(new Set(order), new Set([
    "playback-invalidation",
    "subtitle-invalidation",
  ]));
  releaseClaim();
  await assert.rejects(claim, (error) => error.code === "device_generation_changed");
  assert.equal(await revocation, true);
  assert.equal(
    await repositories.devices.getGeneration(created.profile.id, registered.device.id),
    2
  );
  assert.equal(order.at(-1), "claim");
});

test("playback claim deadlines abort stalled work and release a late successful claim", async () => {
  const randomBytes = sequenceRandom(83);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_claim_deadline_0001",
    deviceIdFactory: () => "device_claim_deadline_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Deadline profile" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });
  const entered = deferred();
  const lateClaim = deferred();
  const released = deferred();
  let claimSignal = null;
  const lifecycle = new ProfileLifecycleService({
    profiles: repositories.profiles,
    devices: repositories.devices,
    lifecycleInvalidations: repositories.lifecycleInvalidations,
    managementSessions: repositories.managementSessions,
    subtitleManifests: repositories.subtitleManifests,
    providerGateway: { async clearProfile() {} },
    playbackContexts: {
      async claim(_profileId, _deviceId, _request, options) {
        claimSignal = options.signal;
        assert.equal(options.sessionId, "session_claim_deadline_0001");
        assert.equal(options.requestDigest, "2".repeat(64));
        entered.resolve();
        return lateClaim.promise;
      },
      async release() {
        assert.fail("owned Redis claims must not use unconditional cleanup");
      },
      async releaseOwned(profileId, deviceId, sessionId, cleanupOwner) {
        assert.equal(profileId, created.profile.id);
        assert.equal(deviceId, registered.device.id);
        assert.equal(sessionId, "session_claim_deadline_0001");
        assert.equal(cleanupOwner, "cleanup_owner_deadline_0001");
        released.resolve();
        return true;
      },
      async invalidateDevice() {},
    },
    subtitleDeliveries: { async invalidateDevice() {} },
    claimDeadlineMs: 10,
  });
  const binding = {
    profileId: created.profile.id,
    profileRevision: created.profile.revision,
    deviceId: registered.device.id,
    deviceGeneration: registered.device.generation,
    playbackGeneration: "g1:0",
  };

  const pending = lifecycle.claim(binding, {}, {
    sessionId: "session_claim_deadline_0001",
    requestDigest: "2".repeat(64),
  });
  await entered.promise;
  await assert.rejects(
    pending,
    (error) => error.code === "playback_claim_deadline"
  );
  assert.ok(claimSignal instanceof AbortSignal);
  assert.equal(claimSignal.aborted, true);

  const lateResult = { status: "claimed", sessionId: "session_claim_deadline_0001" };
  Object.defineProperty(
    lateResult,
    Symbol.for("jumpgate.playbackClaimCleanupOwner"),
    { value: "cleanup_owner_deadline_0001" }
  );
  lateClaim.resolve(lateResult);
  assert.equal(await settledWithin(released.promise, 250), true);
});

test("caller cancellation aborts playback claim work and releases a late success", async () => {
  const randomBytes = sequenceRandom(87);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_claim_abort_0001",
    deviceIdFactory: () => "device_claim_abort_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Abort profile" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });
  const entered = deferred();
  const lateClaim = deferred();
  const released = deferred();
  let claimSignal = null;
  const lifecycle = new ProfileLifecycleService({
    profiles: repositories.profiles,
    devices: repositories.devices,
    lifecycleInvalidations: repositories.lifecycleInvalidations,
    managementSessions: repositories.managementSessions,
    subtitleManifests: repositories.subtitleManifests,
    providerGateway: { async clearProfile() {} },
    playbackContexts: {
      async claim(_profileId, _deviceId, _request, options) {
        claimSignal = options.signal;
        assert.equal(options.sessionId, "session_claim_abort_0001");
        assert.equal(options.requestDigest, "3".repeat(64));
        entered.resolve();
        return lateClaim.promise;
      },
      async release(_profileId, _deviceId, sessionId) {
        assert.equal(sessionId, "session_claim_abort_0001");
        released.resolve();
        return true;
      },
      async invalidateDevice() {},
    },
    subtitleDeliveries: { async invalidateDevice() {} },
    claimDeadlineMs: 1000,
  });
  const binding = {
    profileId: created.profile.id,
    profileRevision: created.profile.revision,
    deviceId: registered.device.id,
    deviceGeneration: registered.device.generation,
    playbackGeneration: "g1:0",
  };
  const controller = new AbortController();

  const pending = lifecycle.claim(binding, {}, {
    signal: controller.signal,
    sessionId: "session_claim_abort_0001",
    requestDigest: "3".repeat(64),
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.ok(claimSignal instanceof AbortSignal);
  assert.equal(claimSignal.aborted, true);

  lateClaim.resolve({ status: "claimed", sessionId: "session_claim_abort_0001" });
  assert.equal(await settledWithin(released.promise, 250), true);
});

test("failed oldest erasures back off so later pending profiles are not starved", async () => {
  let now = 5000;
  let profileSequence = 0;
  const randomBytes = sequenceRandom(91);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => now,
    profileIdFactory: () =>
      "profile_erasure_fair_" + String(++profileSequence).padStart(4, "0"),
  });
  const repositories = storage.repositories;
  const profileIds = [];
  for (let index = 0; index < 10; index += 1) {
    const created = await repositories.profiles.create({ displayName: "Fair erasure" });
    profileIds.push(created.profile.id);
    await repositories.profiles.beginErasure(created.profile.id, created.profile.revision);
  }
  const permanentlyFailing = new Set(profileIds.slice(0, 8));
  const lifecycle = new ProfileLifecycleService({
    profiles: repositories.profiles,
    managementSessions: repositories.managementSessions,
    subtitleManifests: repositories.subtitleManifests,
    providerGateway: {
      async clearProfile(profileId) {
        if (permanentlyFailing.has(profileId)) {
          throw new Error("controlled permanent erasure failure");
        }
      },
    },
    clock: () => now,
    retryBaseMs: 100,
    retryMaxMs: 1000,
  });

  assert.deepEqual(await lifecycle.resumePending(8), {
    processed: 8,
    completed: 0,
    failed: 8,
  });
  assert.deepEqual(await lifecycle.resumePending(8), {
    processed: 2,
    completed: 2,
    failed: 0,
  });
  assert.equal((await repositories.profiles.getErasureStatus(profileIds[8])).status, "deleted");
  assert.equal((await repositories.profiles.getErasureStatus(profileIds[9])).status, "deleted");
});
