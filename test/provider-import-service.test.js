"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { ProviderCollectionCoordinator } = require("../lib/provider-collection-coordinator");
const { ProviderImportService } = require("../lib/provider-import-service");
const { ProviderGatewayService } = require("../lib/provider-gateway-service");
const { createMemoryRepositorySet, loadStorageConfig } = require("../lib/storage");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function descriptor(overrides = {}) {
  const manifestOverrides = overrides.manifest || {};
  const copy = { ...overrides };
  delete copy.manifest;
  return {
    transportUrl: "https://provider.example/secret/manifest.json?token=private",
    manifest: {
      id: "org.example.provider",
      version: "1.2.3-beta.1+build.7",
      name: "Example Provider",
      types: ["movie", "series"],
      resources: ["stream", { name: "subtitles", types: ["movie"], idPrefixes: ["tt"] }],
      behaviorHints: { configurable: true },
      ...manifestOverrides,
    },
    flags: { official: false, protected: false },
    unknownDescriptorField: { preserved: true },
    ...copy,
  };
}

async function fixture() {
  let id = 0;
  const randomBytes = (length) => Buffer.alloc(length, (++id % 250) + 1);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_" + String(++id).padStart(8, "0"),
    providerIdFactory: () => "provider_" + String(++id).padStart(8, "0"),
    backupIdFactory: () => "backup_" + String(++id).padStart(8, "0"),
  });
  const created = await storage.repositories.profiles.create({
    displayName: "Provider test",
    settingsEnvelope: null,
  });
  const service = new ProviderImportService({
    profiles: storage.repositories.profiles,
    providers: storage.repositories.providers,
    addonCollectionBackups: storage.repositories.addonCollectionBackups,
    playbackContexts: storage.repositories.playbackContexts,
  });
  return { service, storage, profileId: created.profile.id };
}

test("preview classifies provider capabilities without returning transport secrets", async () => {
  const { service, storage } = await fixture();
  assert.throws(
    () =>
      new ProviderImportService({
        profiles: storage.repositories.profiles,
        providers: storage.repositories.providers,
        addonCollectionBackups: storage.repositories.addonCollectionBackups,
      }),
    /playbackContexts repository is invalid/
  );
  assert.throws(
    () =>
      new ProviderImportService({
        profiles: storage.repositories.profiles,
        providers: storage.repositories.providers,
        addonCollectionBackups: storage.repositories.addonCollectionBackups,
        playbackContexts: {
          async getProfileGeneration() {
            return "g1:w_8640000000000000_" + "a".repeat(43);
          },
        },
      }),
    /provider snapshot authority is unavailable/
  );
  const [summary] = service.preview([descriptor()]);

  assert.equal(summary.manifestId, "org.example.provider");
  assert.equal(summary.supportsStream, true);
  assert.equal(summary.supportsSubtitles, true);
  assert.equal(summary.configurable, true);
  assert.equal(summary.gatewayEligible, true);
  assert.equal(summary.insecureTransport, false);
  assert.equal(summary.unsupportedTransport, false);
  assert.equal(JSON.stringify(summary).includes("private"), false);
  assert.equal(JSON.stringify(summary).includes("provider.example"), false);
});

test("legacy imports use direct provider operations without fenced mutation or recovery", async () => {
  const { storage, profileId } = await fixture();
  const events = [];
  const providers = {
    async list(...args) {
      events.push(["list", args.length]);
      return storage.repositories.providers.list(...args);
    },
    async replaceAll(...args) {
      events.push(["replaceAll", args.length]);
      return storage.repositories.providers.replaceAll(...args);
    },
    async allocateMutationFence() {
      throw new Error("legacy strategy entered fenced allocation");
    },
    async advanceMutationFence() {
      throw new Error("legacy strategy entered fenced recovery");
    },
  };
  const playbackContexts = {
    getProfileGeneration: (...args) => storage.repositories.playbackContexts.getProfileGeneration(...args),
    invalidateProfile: (...args) => storage.repositories.playbackContexts.invalidateProfile(...args),
    beginProviderSnapshotMutation() {
      throw new Error("legacy strategy entered source-context mutation");
    },
    probeProviderSnapshotRecovery() {
      throw new Error("legacy strategy entered source-context recovery");
    },
  };
  const providerCollectionCoordinator = new ProviderCollectionCoordinator({
    mode: "legacy",
    providers,
    playbackContexts,
  });
  const service = new ProviderImportService({
    profiles: storage.repositories.profiles,
    addonCollectionBackups: storage.repositories.addonCollectionBackups,
    providerCollectionCoordinator,
  });

  const imported = await service.import(profileId, {
    descriptors: [descriptor()],
    expectedRevision: 0,
  });
  assert.equal(imported.revision, 1);
  assert.equal((await service.list(profileId)).revision, 1);
  assert.deepEqual(events, [["replaceAll", 3], ["list", 1]]);
});

test("import is revisioned, encrypted, exact, and never creates backups", async () => {
  const { service, storage, profileId } = await fixture();
  const provider = descriptor();
  const imported = await service.import(profileId, {
    descriptors: [provider],
    expectedRevision: 0,
  });

  assert.equal(imported.revision, 1);
  assert.equal(imported.count, 1);
  assert.equal(Object.hasOwn(imported, "backup"), false);
  assert.deepEqual(
    (await storage.repositories.providers.list(profileId)).providers.map((item) => item.descriptor),
    [provider]
  );
  const rawProviders = JSON.stringify(storage.repositories.providers.storageSnapshot(profileId));
  assert.equal(rawProviders.includes("token=private"), false);
  const backupsBeforeConflict = storage.repositories.addonCollectionBackups.storageSnapshot();
  await assert.rejects(
    service.import(profileId, { descriptors: [], expectedRevision: 0 }),
    (error) => error.code === "revision_conflict"
  );
  assert.deepEqual(storage.repositories.addonCollectionBackups.storageSnapshot(), backupsBeforeConflict);
  await assert.rejects(
    service.import(profileId, {
      descriptors: [provider],
      expectedRevision: 1,
      backupCollection: [provider],
    }),
    /standalone backup operation/
  );
  assert.deepEqual(storage.repositories.addonCollectionBackups.storageSnapshot(), backupsBeforeConflict);
});

test("imports publish leased provider snapshot transitions on success, empty, and failure paths", async () => {
  const { service, storage, profileId } = await fixture();
  const providers = storage.repositories.providers;
  const playbackContexts = storage.repositories.playbackContexts;
  const gateway = new ProviderGatewayService({
    providers,
    playbackContexts,
    fetchPolicy: {
      async fetchJson(url) {
        return { value: { subtitles: [{ id: "stable", url }] } };
      },
    },
  });
  const originalReplaceAll = providers.replaceAll.bind(providers);
  const started = deferred();
  const release = deferred();
  providers.replaceAll = async (...args) => {
    started.resolve();
    await release.promise;
    return originalReplaceAll(...args);
  };

  const importing = service.import(profileId, {
    descriptors: [descriptor()],
    expectedRevision: 0,
  });
  await started.promise;
  const pending = playbackContexts._store.getProviderSnapshotState(profileId);
  assert.equal(pending.pending, true);
  assert.match(pending.generation, /^g1:w_[0-9]+_[A-Za-z0-9_-]{43}$/);
  release.resolve();
  assert.equal((await importing).revision, 1);
  const stable = playbackContexts._store.getProviderSnapshotState(profileId);
  assert.equal(stable.pending, false);
  assert.notEqual(stable.generation, pending.generation);

  const configured = await gateway.queryWithSnapshot(profileId, {
    resource: "subtitles",
    type: "movie",
    id: "tt4000001",
    extra: [],
  });
  assert.deepEqual(configured.snapshot, {
    providerRevision: "1",
    generation: stable.generation,
  });
  assert.equal(configured.response.subtitles.length, 1);

  providers.replaceAll = async () => {
    throw new Error("replace unavailable");
  };
  await assert.rejects(
    service.import(profileId, { descriptors: [], expectedRevision: 1 }),
    /replace unavailable/
  );
  const afterFailure = playbackContexts._store.getProviderSnapshotState(profileId);
  assert.equal(afterFailure.pending, false);
  assert.notEqual(afterFailure.generation, stable.generation);
  assert.equal((await providers.list(profileId)).revision, 1);

  providers.replaceAll = originalReplaceAll;
  const emptied = await service.import(profileId, { descriptors: [], expectedRevision: 1 });
  assert.deepEqual({ revision: emptied.revision, count: emptied.count }, { revision: 2, count: 0 });
  const emptyResult = await gateway.queryWithSnapshot(profileId, {
    resource: "subtitles",
    type: "movie",
    id: "tt4000002",
    extra: [],
  });
  assert.deepEqual(emptyResult.response, { subtitles: [] });
  assert.equal(emptyResult.snapshot.providerRevision, "2");
  assert.equal(playbackContexts._store.getProviderSnapshotState(profileId).pending, false);
});

test("expired provider writer is fenced before durable commit after takeover publishes", async () => {
  const { service, storage, profileId } = await fixture();
  const providers = storage.repositories.providers;
  const playbackContexts = storage.repositories.playbackContexts;
  const authority = playbackContexts._store;
  let now = 1000;
  authority._clock = () => now;
  authority._providerMutationLeaseMs = 10;

  const gateway = new ProviderGatewayService({
    providers,
    playbackContexts,
    fetchPolicy: {
      async fetchJson(url) {
        const owner = url.includes("replacement.example") ? "replacement" : "stale";
        return {
          value: {
            streams: [{ url: "https://media.example/" + owner + ".mkv" }],
            subtitles: [{ id: owner, url: "https://media.example/" + owner + ".vtt" }],
          },
        };
      },
    },
  });

  const durableReplace = providers.replaceAll.bind(providers);
  let durableWrites = 0;
  providers.replaceAll = async (...args) => {
    durableWrites += 1;
    return durableReplace(...args);
  };

  const originalFence = authority.fenceProviderSnapshotMutation.bind(authority);
  const originalComplete = authority.completeProviderSnapshotMutation.bind(authority);
  const originalRenew = authority.renewProviderSnapshotMutation.bind(authority);
  const originalRelease = authority.releaseProviderSnapshotMutation.bind(authority);
  const staleAtBoundary = deferred();
  const resumeStale = deferred();
  const replacementAtPublish = deferred();
  const publishReplacement = deferred();
  let staleToken = null;
  let replacementToken = null;
  authority.fenceProviderSnapshotMutation = async (id, token, mutationFence) => {
    if (staleToken === null) {
      staleToken = token;
      staleAtBoundary.resolve();
      await resumeStale.promise;
    }
    return originalFence(id, token, mutationFence);
  };
  authority.completeProviderSnapshotMutation = async (id, token) => {
    if (token !== staleToken && replacementToken === null) {
      replacementToken = token;
      replacementAtPublish.resolve();
      await publishReplacement.promise;
    }
    return originalComplete(id, token);
  };

  const staleDescriptor = descriptor({
    transportUrl: "https://stale.example/manifest.json",
    manifest: { id: "org.example.stale" },
  });
  const replacementDescriptor = descriptor({
    transportUrl: "https://replacement.example/manifest.json",
    manifest: { id: "org.example.replacement" },
  });
  const staleImport = service.import(profileId, {
    descriptors: [staleDescriptor],
    expectedRevision: 0,
  });
  await staleAtBoundary.promise;
  assert.deepEqual(authority.getProviderSnapshotState(profileId), {
    generation: staleToken,
    pending: true,
  });
  await assert.rejects(
    gateway.queryWithSnapshot(profileId, {
      resource: "stream",
      type: "movie",
      id: "tt4100001",
      extra: [],
    }),
    (error) => error.code === "provider_snapshot_contention"
  );
  assert.equal(authority._contexts.size, 0);

  now = 1011;
  const replacementImport = service.import(profileId, {
    descriptors: [replacementDescriptor],
    expectedRevision: 0,
  });
  await replacementAtPublish.promise;
  assert.notEqual(replacementToken, staleToken);
  assert.deepEqual(
    (await providers.list(profileId)).providers.map((entry) => entry.descriptor.transportUrl),
    [replacementDescriptor.transportUrl]
  );
  assert.equal((await providers.list(profileId)).revision, 1);
  assert.equal(durableWrites, 1);
  assert.deepEqual(authority.getProviderSnapshotState(profileId), {
    generation: replacementToken,
    pending: true,
  });
  await assert.rejects(
    gateway.queryWithSnapshot(profileId, {
      resource: "stream",
      type: "movie",
      id: "tt4100002",
      extra: [],
    }),
    (error) => error.code === "provider_snapshot_contention"
  );
  assert.equal(authority._contexts.size, 0);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(originalRenew(profileId, staleToken), { renewed: false });
    assert.equal(originalRelease(profileId, staleToken), false);
    assert.deepEqual(authority.getProviderSnapshotState(profileId), {
      generation: replacementToken,
      pending: true,
    });
  }

  publishReplacement.resolve();
  assert.equal((await replacementImport).revision, 1);
  const stable = authority.getProviderSnapshotState(profileId);
  assert.equal(stable.pending, false);
  const current = await gateway.queryWithSnapshot(profileId, {
    resource: "stream",
    type: "movie",
    id: "tt4100003",
    extra: [],
  });
  assert.deepEqual(current.snapshot, { providerRevision: "1", generation: stable.generation });
  assert.equal(current.response.streams[0].url, "https://media.example/replacement.mkv");
  const [storedContext] = authority._contexts.values();
  assert.equal(storedContext.generation, stable.generation);
  assert.equal(storedContext.providerRevision, "1");

  resumeStale.resolve();
  await assert.rejects(
    staleImport,
    (error) => error.code === "provider_snapshot_changed"
  );
  assert.equal(durableWrites, 1);
  assert.equal((await providers.list(profileId)).revision, 1);
  assert.deepEqual(authority.getProviderSnapshotState(profileId), stable);
  assert.equal(storedContext.generation, stable.generation);
  assert.equal(storedContext.providerRevision, "1");
});

test("preview safely classifies IPFS and IPNS while import remains HTTP-only", async () => {
  const { service, profileId } = await fixture();
  const ipfs = descriptor({
    transportUrl: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3pte3b5/manifest.json",
    manifest: { id: "org.example.ipfs" },
  });
  const ipns = descriptor({
    transportUrl: "ipns://k51qzi5uqu5dl-example/manifest.json",
    manifest: { id: "org.example.ipns" },
  });

  const previews = service.preview([ipfs, ipns]);
  assert.deepEqual(
    previews.map((preview) => ({
      gatewayEligible: preview.gatewayEligible,
      insecureTransport: preview.insecureTransport,
      unsupportedTransport: preview.unsupportedTransport,
    })),
    [
      { gatewayEligible: false, insecureTransport: false, unsupportedTransport: true },
      { gatewayEligible: false, insecureTransport: false, unsupportedTransport: true },
    ]
  );
  await assert.rejects(
    service.import(profileId, { descriptors: [ipfs], expectedRevision: 0 }),
    /transportUrl is invalid/
  );
});

test("preview keeps incompatible HTTP providers visible while import accepts only runtime transports", async () => {
  const { service, storage, profileId } = await fixture();
  const cases = [
    ["standard", "https://standard.example/manifest.json", true],
    ["standard-query", "https://query.example/config/manifest.json?token=a%2Bb&flag", true],
    ["legacy", "http://legacy.example/stremio/v1", true],
    ["arbitrary-path", "https://provider.example/not-manifest", false],
    ["manifest-case", "https://case.example/MANIFEST.JSON", false],
    ["manifest-trailing-slash", "https://slash.example/manifest.json/", false],
    ["legacy-query", "https://legacy-query.example/stremio/v1?token=private", false],
  ].map(([id, transportUrl, gatewayEligible]) => ({
    provider: descriptor({ transportUrl, manifest: { id: "org.example." + id } }),
    gatewayEligible,
  }));

  const previews = service.preview(cases.map((entry) => entry.provider));
  assert.equal(previews.length, cases.length);
  assert.deepEqual(
    previews.map((preview) => ({
      gatewayEligible: preview.gatewayEligible,
      unsupportedTransport: preview.unsupportedTransport,
    })),
    cases.map((entry) => ({
      gatewayEligible: entry.gatewayEligible,
      unsupportedTransport: !entry.gatewayEligible,
    }))
  );

  const supported = cases.filter((entry) => entry.gatewayEligible).map((entry) => entry.provider);
  const imported = await service.import(profileId, { descriptors: supported, expectedRevision: 0 });
  assert.equal(imported.count, supported.length);
  assert.equal(imported.revision, 1);

  for (const entry of cases.filter((candidate) => !candidate.gatewayEligible)) {
    await assert.rejects(
      service.import(profileId, { descriptors: [entry.provider], expectedRevision: 1 }),
      /transportUrl is invalid/
    );
  }
  assert.equal((await storage.repositories.providers.list(profileId)).revision, 1);
});

test("preview eligibility uses effective first-resource types and import rejects unusable providers", async () => {
  const { service, profileId } = await fixture();
  const noGlobalTypes = descriptor({
    manifest: { id: "org.example.no-types", types: [], resources: ["stream"] },
  });
  const unusableFirst = descriptor({
    manifest: {
      id: "org.example.first-wins",
      resources: [
        { name: "stream", types: [] },
        { name: "stream", types: ["movie"], idPrefixes: ["tt"] },
      ],
    },
  });

  for (const provider of [noGlobalTypes, unusableFirst]) {
    const [preview] = service.preview([provider]);
    assert.equal(preview.supportsStream, false);
    assert.equal(preview.supportsSubtitles, false);
    assert.equal(preview.gatewayEligible, false);
    await assert.rejects(
      service.import(profileId, { descriptors: [provider], expectedRevision: 0 }),
      /no usable stream or subtitle capability/
    );
  }
});

test("provider URL deduplication canonicalizes authority and dot segments without rewriting descriptors", async () => {
  const { service, storage, profileId } = await fixture();
  const canonical = descriptor({
    transportUrl: "https://EXAMPLE.com:443/a/../manifest.json?token=a%2Bb&flag",
    manifest: { id: "org.example.canonical" },
  });
  const equivalent = descriptor({
    transportUrl: "https://example.com/manifest.json?token=a%2Bb&flag",
    manifest: { id: "org.example.equivalent" },
  });
  assert.throws(() => service.preview([canonical, equivalent]), /duplicate provider transportUrl/);

  const distinctQueryBytes = descriptor({
    transportUrl: "https://example.com/manifest.json?token=a+b&flag",
    manifest: { id: "org.example.distinct-query" },
  });
  const distinctPath = descriptor({
    transportUrl: "https://example.com//manifest.json?token=a%2Bb&flag",
    manifest: { id: "org.example.distinct-path" },
  });
  assert.equal(service.preview([canonical, distinctQueryBytes, distinctPath]).length, 3);

  await service.import(profileId, { descriptors: [canonical], expectedRevision: 0 });
  assert.equal(
    (await storage.repositories.providers.list(profileId)).providers[0].descriptor.transportUrl,
    canonical.transportUrl
  );
});

test("list returns sanitized summaries while preserving profile isolation", async () => {
  const first = await fixture();
  const secondProfile = await first.storage.repositories.profiles.create({
    displayName: "Other",
    settingsEnvelope: null,
  });
  await first.service.import(first.profileId, { descriptors: [descriptor()], expectedRevision: 0 });

  const listed = await first.service.list(first.profileId);
  assert.equal(listed.revision, 1);
  assert.equal(listed.providers.length, 1);
  assert.match(listed.providers[0].providerId, /^provider_/);
  assert.equal(JSON.stringify(listed).includes("token=private"), false);
  assert.deepEqual(await first.service.list(secondProfile.profile.id), { revision: 0, providers: [] });
});

test("standalone backups are encrypted before browser-side collection mutation", async () => {
  const { service, storage, profileId } = await fixture();
  const collection = [descriptor()];
  const backup = await service.backup(profileId, collection, "before-managed-install");
  assert.match(backup.id, /^backup_/);
  assert.deepEqual(
    (await storage.repositories.addonCollectionBackups.get(profileId, backup.id)).collection,
    collection
  );
  assert.equal(
    JSON.stringify(storage.repositories.addonCollectionBackups.storageSnapshot()).includes("token=private"),
    false
  );
});

test("invalid, recursive, duplicate, lossy, and oversized descriptors fail closed", async () => {
  const { service } = await fixture();
  assert.throws(() => service.preview([descriptor({ manifest: { version: "01.2.3" } })]), /version/);
  assert.throws(
    () => service.preview([descriptor({ manifest: { id: "com.jumpgate.bridge" } })]),
    (error) => error.code === "recursive_provider"
  );
  const same = descriptor();
  assert.throws(() => service.preview([same, same]), /duplicate provider transportUrl/);
  assert.throws(
    () => service.preview([descriptor({ unknownDescriptorField: { value: undefined } })]),
    /not JSON serializable/
  );
  assert.throws(
    () => service.preview([descriptor({ padding: "x".repeat(70 * 1024) })]),
    /size limit/
  );
  const forbidden = descriptor();
  Object.defineProperty(forbidden.manifest, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  });
  assert.throws(() => service.preview([forbidden]), /forbidden key/);
  assert.equal({}.polluted, undefined);
});

test("inactive or unknown profiles cannot read or replace providers", async () => {
  const { service, storage, profileId } = await fixture();
  const profile = await storage.repositories.profiles.getById(profileId);
  await storage.repositories.profiles.revoke(profileId, profile.revision);
  await assert.rejects(
    service.import(profileId, { descriptors: [], expectedRevision: 0 }),
    (error) => error.code === "profile_unavailable"
  );
  await assert.rejects(
    service.list("profile_missing_0001"),
    (error) => error.code === "profile_unavailable"
  );
});
