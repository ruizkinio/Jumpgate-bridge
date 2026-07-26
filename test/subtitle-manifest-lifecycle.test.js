"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const { SubtitleDeletionWorker } = require("../lib/subtitle-deletion-worker");
const { createMemoryRepositorySet, loadStorageConfig } = require("../lib/storage");
const { objectStoreError } = require("../lib/storage/object-store");

function sequenceRandom(seed = 0x5c) {
  let value = seed;
  return (length) => {
    const output = Buffer.alloc(length, value);
    value = value === 0xff ? 1 : value + 1;
    return output;
  };
}

function manifestInput(profile, device, overrides = {}) {
  return {
    profileId: profile.id,
    profileRevision: profile.revision,
    deviceId: device.id,
    deviceGeneration: device.generation,
    artifactId: "artifact_manifest_0001",
    sessionId: "session_manifest_0001",
    playbackGeneration: "g1:manifest",
    contextRevision: "1",
    providerRevision: "1",
    expiresAt: 20_000,
    uploadSettlementDeadline: 2_000,
    parts: [{
      partNumber: 1,
      objectKey: "subtitles/v1/opaque/manifest-object-0001",
      sizeBytes: 4,
      checksum: crypto.createHash("sha256").update("test").digest("hex"),
      mediaType: "text/plain",
    }],
    ...overrides,
  };
}

async function createLeasedManifestFixture(seed, suffix) {
  let now = 1_000;
  const randomBytes = sequenceRandom(seed);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => now,
    profileIdFactory: () => "profile_manifest_lease_" + suffix,
    deviceIdFactory: () => "device_manifest_lease_" + suffix,
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Lease" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });
  await repositories.subtitleManifests.reserve(manifestInput(
    created.profile,
    registered.device,
    {
      artifactId: "artifact_manifest_lease_" + suffix,
      sessionId: "session_manifest_lease_" + suffix,
      uploadSettlementDeadline: now,
      parts: [{
        ...manifestInput(created.profile, registered.device).parts[0],
        objectKey: "subtitles/v1/opaque/manifest-lease-" + suffix,
      }],
    }
  ));
  await repositories.subtitleManifests.requestProfileDeletion(created.profile.id);
  const claim = await repositories.subtitleManifests.claimDeletion({
    workerId: "worker_manifest_lease_" + suffix,
    leaseMs: 10,
  });
  return {
    claim,
    repositories,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

test("upload settlement tombstones can outlive playable subtitle expiry", async () => {
  const randomBytes = sequenceRandom(0x4c);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => 1_000,
    profileIdFactory: () => "profile_manifest_settlement_0001",
    deviceIdFactory: () => "device_manifest_settlement_0001",
  });
  const created = await storage.repositories.profiles.create({ displayName: "Settlement" });
  const registered = await storage.repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });

  const reserved = await storage.repositories.subtitleManifests.reserve(manifestInput(
    created.profile,
    registered.device,
    { expiresAt: 2_000, uploadSettlementDeadline: 3_000 }
  ));

  assert.equal(reserved.expiresAt, 2_000);
  assert.equal(reserved.uploadSettlementDeadline, 3_000);
});

test("durable manifest deletion survives Redis loss and removes a late PUT on pass two", async () => {
  let now = 1_000;
  const randomBytes = sequenceRandom(0x5d);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => now,
    profileIdFactory: () => "profile_manifest_worker_0001",
    deviceIdFactory: () => "device_manifest_worker_0001",
  });
  const created = await storage.repositories.profiles.create({ displayName: "Worker" });
  const registered = await storage.repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });
  const input = manifestInput(created.profile, registered.device, {
    expiresAt: 20_000,
    uploadSettlementDeadline: now,
  });
  await storage.repositories.subtitleManifests.reserve(input);
  await storage.repositories.subtitleManifests.requestProfileDeletion(created.profile.id);

  const objects = new Set(input.parts.map((part) => part.objectKey));
  let deletes = 0;
  const objectStore = {
    createKey() { return "unused"; },
    async put(key) { objects.add(key); },
    async get() { throw new Error("unused"); },
    async head(key) {
      if (!objects.has(key)) throw objectStoreError("object_store_not_found", "head");
      return {};
    },
    async delete(key) {
      deletes += 1;
      objects.delete(key);
    },
  };
  const worker = new SubtitleDeletionWorker({
    repository: storage.repositories.subtitleManifests,
    objectStore,
    workerId: "manifest-worker-0001",
    leaseMs: 10,
    secondPassDelayMs: 5,
  });

  assert.equal((await worker.runOnce()).status, "awaiting_second_pass");
  objects.add(input.parts[0].objectKey);
  now += 5;
  assert.equal((await worker.runOnce()).status, "confirmed");
  assert.equal(deletes, 2);
  assert.deepEqual(
    await storage.repositories.subtitleManifests.listProfile(created.profile.id),
    []
  );
});

test("a stale deletion owner cannot confirm erasure after losing its lease", async () => {
  let releaseDelete;
  let deletionStarted;
  let claimed = false;
  let ownerToken = "deletion-token-current";
  const started = new Promise((resolve) => {
    deletionStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  const repository = {
    async claimDeletion() {
      if (claimed) return null;
      claimed = true;
      return {
        artifactId: "artifact_stale_owner_0001",
        deletionToken: "deletion-token-stale",
        phase: "first",
        parts: [{
          checksum: crypto.createHash("sha256").update("test").digest("hex"),
          objectKey: "subtitles/v1/opaque/stale-owner-object",
          sizeBytes: 4,
        }],
      };
    },
    async recordDeletionAbsence(input) {
      return input.deletionToken === ownerToken
        ? { status: "awaiting_second_pass" }
        : null;
    },
    async retryDeletion() {
      return null;
    },
    async confirmDeletion() {
      throw new Error("stale first-pass owner must not confirm deletion");
    },
  };
  const objectStore = {
    createKey() { return "unused"; },
    async put() { throw new Error("unused"); },
    async get() { throw new Error("unused"); },
    async delete() {
      deletionStarted();
      await blocked;
      return { deleted: true };
    },
    async head() {
      throw objectStoreError("object_store_not_found", "head");
    },
  };
  const worker = new SubtitleDeletionWorker({
    repository,
    objectStore,
    workerId: "worker-stale-owner",
  });

  const pending = worker.runOnce();
  await started;
  ownerToken = "deletion-token-new-owner";
  releaseDelete();
  assert.deepEqual(await pending, {
    artifactId: "artifact_stale_owner_0001",
    phase: "first",
    status: "lost",
  });
});

test("durable subtitle manifests fence profile erase through recovered two-pass deletion", async () => {
  let now = 1_000;
  const randomBytes = sequenceRandom();
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => now,
    profileIdFactory: () => "profile_manifest_lifecycle_0001",
    deviceIdFactory: () => "device_manifest_lifecycle_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Manifest lifecycle" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });

  const reserved = await repositories.subtitleManifests.reserve(
    manifestInput(created.profile, registered.device)
  );
  assert.equal(reserved.state, "uploading");
  assert.equal((await repositories.subtitleManifests.listProfile(created.profile.id)).length, 1);

  const pendingProfile = await repositories.profiles.beginErasure(
    created.profile.id,
    created.profile.revision
  );
  assert.equal(pendingProfile.deletionState, "pending");
  await assert.rejects(
    repositories.profiles.erase(created.profile.id),
    (error) => error.code === "profile_erasure_pending"
  );
  assert.equal(
    (await repositories.subtitleManifests.listProfile(created.profile.id))[0].state,
    "deletion_requested"
  );

  assert.equal(await repositories.subtitleManifests.claimDeletion({
    workerId: "worker_manifest_0001",
    leaseMs: 10,
  }), null);
  now = 2_000;
  const abandoned = await repositories.subtitleManifests.claimDeletion({
    workerId: "worker_manifest_0001",
    leaseMs: 10,
  });
  assert.equal(abandoned.phase, "first");

  now += 11;
  const recovered = await repositories.subtitleManifests.claimDeletion({
    workerId: "worker_manifest_0002",
    leaseMs: 10,
  });
  assert.equal(recovered.phase, "first");
  assert.notEqual(recovered.deletionToken, abandoned.deletionToken);
  await repositories.subtitleManifests.recordDeletionAbsence({
    artifactId: recovered.artifactId,
    deletionToken: recovered.deletionToken,
    secondPassDelayMs: 5,
  });

  now += 5;
  const second = await repositories.subtitleManifests.claimDeletion({
    workerId: "worker_manifest_0003",
    leaseMs: 10,
  });
  assert.equal(second.phase, "second");
  await repositories.subtitleManifests.confirmDeletion({
    artifactId: second.artifactId,
    deletionToken: second.deletionToken,
    verifiedAbsent: true,
  });
  assert.deepEqual(await repositories.subtitleManifests.listProfile(created.profile.id), []);
  assert.equal(await repositories.profiles.erase(created.profile.id), true);
  assert.equal((await repositories.profiles.getErasureStatus(created.profile.id)).status, "deleted");
});

test("device revocation requests deletion only for that profile and device", async () => {
  const randomBytes = sequenceRandom(0x6c);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  let profileSequence = 0;
  let deviceSequence = 0;
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => 1_000,
    profileIdFactory: () => "profile_manifest_isolation_" + String(++profileSequence).padStart(4, "0"),
    deviceIdFactory: () => "device_manifest_isolation_" + String(++deviceSequence).padStart(4, "0"),
  });
  const repositories = storage.repositories;
  const first = await repositories.profiles.create({ displayName: "First" });
  const second = await repositories.profiles.create({ displayName: "Second" });
  const firstDevice = await repositories.devices.register(first.profile.id, { displayName: "First" });
  const secondDevice = await repositories.devices.register(second.profile.id, { displayName: "Second" });
  await repositories.subtitleManifests.reserve(manifestInput(first.profile, firstDevice.device));
  await repositories.subtitleManifests.reserve(manifestInput(second.profile, secondDevice.device, {
    artifactId: "artifact_manifest_0002",
    sessionId: "session_manifest_0002",
    parts: [{
      ...manifestInput(second.profile, secondDevice.device).parts[0],
      objectKey: "subtitles/v1/opaque/manifest-object-0002",
    }],
  }));

  await repositories.devices.revokeWithInvalidation(first.profile.id, firstDevice.device.id);
  assert.equal((await repositories.subtitleManifests.listProfile(first.profile.id))[0].state, "deletion_requested");
  assert.equal((await repositories.subtitleManifests.listProfile(second.profile.id))[0].state, "uploading");
});

test("repeated memory profile erasure requests repeat the immediate manifest sweep", async () => {
  const randomBytes = sequenceRandom(0x71);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => 1_000,
    profileIdFactory: () => "profile_manifest_repeat_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Repeat profile" });
  const original = repositories.subtitleManifests.requestProfileDeletionNow.bind(
    repositories.subtitleManifests
  );
  let sweeps = 0;
  repositories.subtitleManifests.requestProfileDeletionNow = (...args) => {
    sweeps += 1;
    return original(...args);
  };

  await repositories.profiles.beginErasure(created.profile.id, created.profile.revision);
  await repositories.profiles.beginErasure(created.profile.id, created.profile.revision);
  assert.equal(sweeps, 2);
});

test("repeated memory device revocation repeats the immediate manifest sweep", async () => {
  const randomBytes = sequenceRandom(0x72);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => 1_000,
    profileIdFactory: () => "profile_manifest_device_repeat_0001",
    deviceIdFactory: () => "device_manifest_device_repeat_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Repeat device" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });
  const original = repositories.subtitleManifests.requestDeviceDeletionNow.bind(
    repositories.subtitleManifests
  );
  let sweeps = 0;
  repositories.subtitleManifests.requestDeviceDeletionNow = (...args) => {
    sweeps += 1;
    return original(...args);
  };

  await repositories.devices.revokeWithInvalidation(created.profile.id, registered.device.id);
  await repositories.devices.revokeWithInvalidation(created.profile.id, registered.device.id);
  assert.equal(sweeps, 2);
});

test("memory manifest commit requests cleanup when its lifecycle binding changed", async () => {
  const randomBytes = sequenceRandom(0x73);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    clock: () => 1_000,
    profileIdFactory: () => "profile_manifest_commit_0001",
    deviceIdFactory: () => "device_manifest_commit_0001",
  });
  const repositories = storage.repositories;
  const created = await repositories.profiles.create({ displayName: "Commit lifecycle" });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: "Kodi TV",
  });
  const input = manifestInput(created.profile, registered.device, {
    artifactId: "artifact_manifest_commit_0001",
    sessionId: "session_manifest_commit_0001",
    parts: [{
      ...manifestInput(created.profile, registered.device).parts[0],
      objectKey: "subtitles/v1/opaque/manifest-commit-0001",
    }],
  });
  await repositories.subtitleManifests.reserve(input);
  await repositories.profiles.update(
    created.profile.id,
    { displayName: "Changed" },
    created.profile.revision
  );

  assert.equal(await repositories.subtitleManifests.commit({
    profileId: created.profile.id,
    artifactId: input.artifactId,
  }), null);
  const [manifest] = await repositories.subtitleManifests.listProfile(created.profile.id);
  assert.equal(manifest.state, "deletion_requested");
  assert.equal(manifest.deletionReason, "lifecycle_changed");
});

test("memory deletion mutations reject an expired matching lease", async () => {
  const absence = await createLeasedManifestFixture(0x74, "absence");
  absence.advance(11);
  assert.equal(await absence.repositories.subtitleManifests.recordDeletionAbsence({
    artifactId: absence.claim.artifactId,
    deletionToken: absence.claim.deletionToken,
    secondPassDelayMs: 5,
    verifiedAbsent: true,
  }), null);

  const retry = await createLeasedManifestFixture(0x75, "retry");
  retry.advance(11);
  assert.equal(await retry.repositories.subtitleManifests.retryDeletion({
    artifactId: retry.claim.artifactId,
    deletionToken: retry.claim.deletionToken,
    retryDelayMs: 5,
  }), null);

  const confirmation = await createLeasedManifestFixture(0x76, "confirmation");
  await confirmation.repositories.subtitleManifests.recordDeletionAbsence({
    artifactId: confirmation.claim.artifactId,
    deletionToken: confirmation.claim.deletionToken,
    secondPassDelayMs: 5,
    verifiedAbsent: true,
  });
  confirmation.advance(5);
  const second = await confirmation.repositories.subtitleManifests.claimDeletion({
    workerId: "worker_manifest_lease_confirmation_second",
    leaseMs: 10,
  });
  confirmation.advance(11);
  assert.equal(await confirmation.repositories.subtitleManifests.confirmDeletion({
    artifactId: second.artifactId,
    deletionToken: second.deletionToken,
    verifiedAbsent: true,
  }), null);
});
