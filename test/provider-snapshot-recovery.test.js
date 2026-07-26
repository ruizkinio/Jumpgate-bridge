"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { ProviderGatewayService } = require("../lib/provider-gateway-service");
const {
  readProviderCollectionSnapshot,
  readProviderSnapshotState,
} = require("../lib/source-context");
const { createMemoryRepositorySet, loadStorageConfig } = require("../lib/storage");

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function descriptor(name) {
  return {
    transportUrl: "https://" + name + ".example/manifest.json",
    manifest: {
      id: "org.example." + name,
      version: "1.0.0",
      name,
      types: ["movie"],
      resources: ["stream"],
    },
  };
}

async function fixture() {
  let sequence = 0;
  const randomBytes = (length) => Buffer.alloc(length, (++sequence % 250) + 1);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_recovery_0001",
    providerIdFactory: () => "provider_recovery_" + String(++sequence).padStart(4, "0"),
  });
  const created = await storage.repositories.profiles.create({ displayName: "Recovery" });
  const authority = storage.repositories.playbackContexts._store;
  authority._clock = () => 1000;
  authority._providerMutationLeaseMs = 10;
  return {
    storage,
    profileId: created.profile.id,
    providers: storage.repositories.providers,
    playbackContexts: storage.repositories.playbackContexts,
    authority,
  };
}

test("provider snapshot recovery fences out a writer that crashed before durable commit", async () => {
  const h = await fixture();
  const token = h.authority.beginProviderSnapshotMutation(h.profileId);
  const original = h.authority.fenceProviderSnapshotMutation(
    h.profileId,
    token,
    await h.providers.allocateMutationFence(h.profileId)
  );
  h.authority._clock = () => 1011;

  const recovered = await readProviderSnapshotState(
    h.playbackContexts,
    h.profileId,
    h.providers
  );
  assert.equal(recovered.pending, false);
  assert.notEqual(recovered.generation, token);
  assert.deepEqual(await h.providers.list(h.profileId), { revision: 0, providers: [] });
  assert.deepEqual(await h.providers.advanceMutationFence(h.profileId, "2"), {
    revision: 0,
    mutationFence: "2",
  });
  await assert.rejects(
    h.providers.replaceAll(h.profileId, [descriptor("stale")], 0, {
      mutationFence: original.fence,
    }),
    (error) => error.code === "provider_snapshot_stale_fence"
  );
  assert.deepEqual(await h.providers.list(h.profileId), { revision: 0, providers: [] });
});

test("provider snapshot recovery publishes a committed writer without changing its revision", async () => {
  const h = await fixture();
  const committed = descriptor("committed");
  const token = h.authority.beginProviderSnapshotMutation(h.profileId);
  const original = h.authority.fenceProviderSnapshotMutation(
    h.profileId,
    token,
    await h.providers.allocateMutationFence(h.profileId)
  );
  assert.deepEqual(
    await h.providers.replaceAll(h.profileId, [committed], 0, {
      mutationFence: original.fence,
    }),
    { revision: 1, count: 1 }
  );
  h.authority._clock = () => 1011;

  assert.deepEqual(h.authority.probeProviderSnapshotRecovery(h.profileId), {
    token,
    fence: "1",
    phase: "fenced",
  });
  const recovered = await readProviderSnapshotState(
    h.playbackContexts,
    h.profileId,
    h.providers
  );
  assert.equal(recovered.pending, false);
  assert.deepEqual(await h.providers.advanceMutationFence(h.profileId, "2"), {
    revision: 1,
    mutationFence: "2",
  });
  const collection = await h.providers.list(h.profileId);
  assert.equal(collection.revision, 1);
  assert.deepEqual(collection.providers.map((item) => item.descriptor), [committed]);
  const gateway = new ProviderGatewayService({
    providers: h.providers,
    playbackContexts: h.playbackContexts,
    fetchPolicy: { async fetchJson() { return { streams: [] }; } },
  });
  assert.deepEqual(await gateway.capabilities(h.profileId), {
    revision: 1,
    resources: [{ name: "stream", types: ["movie"], idPrefixes: [] }],
    types: ["movie"],
    idPrefixes: [],
  });
  assert.throws(
    () => h.authority.completeProviderSnapshotMutation(h.profileId, token),
    (error) => error.code === "provider_snapshot_changed"
  );

  const clearToken = h.authority.beginProviderSnapshotMutation(h.profileId);
  const clearFence = h.authority.fenceProviderSnapshotMutation(
    h.profileId,
    clearToken,
    await h.providers.allocateMutationFence(h.profileId)
  );
  assert.equal(clearFence.fence, "3");
  h.authority._clock = () => 1022;
  const clearedGeneration = await gateway.clearProfile(h.profileId);
  assert.equal(h.authority.getProviderSnapshotState(h.profileId).pending, false);
  assert.equal(h.authority.getProviderSnapshotState(h.profileId).generation, clearedGeneration);
  assert.throws(
    () => h.authority.completeProviderSnapshotMutation(h.profileId, clearToken),
    (error) => error.code === "provider_snapshot_changed"
  );
});

test("concurrent provider snapshot readers join one active recovery fence", async () => {
  const h = await fixture();
  const token = h.authority.beginProviderSnapshotMutation(h.profileId);
  const original = h.authority.fenceProviderSnapshotMutation(
    h.profileId,
    token,
    await h.providers.allocateMutationFence(h.profileId)
  );
  assert.equal(original.fence, "1");
  h.authority._clock = () => 1011;

  const firstAdvanceEntered = deferred();
  const bothAdvancesEntered = deferred();
  const releaseAdvances = deferred();
  const advancementFences = [];
  const coordinatedProviders = {
    allocateMutationFence: (...args) => h.providers.allocateMutationFence(...args),
    list: (...args) => h.providers.list(...args),
    async advanceMutationFence(...args) {
      advancementFences.push(args[1]);
      if (advancementFences.length === 1) firstAdvanceEntered.resolve();
      if (advancementFences.length === 2) bothAdvancesEntered.resolve();
      await releaseAdvances.promise;
      return h.providers.advanceMutationFence(...args);
    },
  };

  const firstRead = readProviderCollectionSnapshot(
    coordinatedProviders,
    h.playbackContexts,
    h.profileId
  );
  await firstAdvanceEntered.promise;
  const secondRead = readProviderCollectionSnapshot(
    coordinatedProviders,
    h.playbackContexts,
    h.profileId
  );
  await bothAdvancesEntered.promise;

  let fenceFailure = null;
  try {
    assert.deepEqual(advancementFences, ["2", "2"]);
  } catch (error) {
    fenceFailure = error;
  } finally {
    releaseAdvances.resolve();
  }
  const settled = await Promise.allSettled([firstRead, secondRead]);
  if (fenceFailure) throw fenceFailure;

  assert.deepEqual(
    settled.map((result) => result.status),
    ["fulfilled", "fulfilled"]
  );
  assert.equal(new Set(settled.map((result) => result.value.generation)).size, 1);
  assert.deepEqual(
    settled.map((result) => result.value.collection),
    [
      { revision: 0, providers: [] },
      { revision: 0, providers: [] },
    ]
  );
});

test("restored stale provider recovery fence is superseded once and converges", async () => {
  const h = await fixture();
  const token = h.authority.beginProviderSnapshotMutation(h.profileId);
  const original = h.authority.fenceProviderSnapshotMutation(
    h.profileId,
    token,
    await h.providers.allocateMutationFence(h.profileId)
  );
  assert.equal(original.fence, "1");
  h.authority._clock = () => 1011;
  assert.deepEqual(h.authority.beginProviderSnapshotRecovery(h.profileId, "2", "1"), {
    token,
    fence: "2",
  });
  assert.deepEqual(await h.providers.advanceMutationFence(h.profileId, "10"), {
    revision: 0,
    mutationFence: "10",
  });

  let allocations = 0;
  let recoveryBegins = 0;
  const providers = {
    async allocateMutationFence(...args) {
      allocations += 1;
      return h.providers.allocateMutationFence(...args);
    },
    advanceMutationFence: (...args) => h.providers.advanceMutationFence(...args),
    list: (...args) => h.providers.list(...args),
  };
  const authority = Object.create(h.playbackContexts);
  authority.beginProviderSnapshotRecovery = async (...args) => {
    recoveryBegins += 1;
    return h.playbackContexts.beginProviderSnapshotRecovery(...args);
  };

  const recovered = await readProviderCollectionSnapshot(
    providers,
    authority,
    h.profileId
  );

  assert.equal(h.authority.getProviderSnapshotState(h.profileId).pending, false);
  assert.deepEqual(recovered.collection, { revision: 0, providers: [] });
  assert.equal(allocations, 1);
  assert.equal(recoveryBegins, 1);
  assert.deepEqual(await h.providers.advanceMutationFence(h.profileId, "11"), {
    revision: 0,
    mutationFence: "11",
  });
  assert.deepEqual(await h.providers.list(h.profileId), { revision: 0, providers: [] });
});
