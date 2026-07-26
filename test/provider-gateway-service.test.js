"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { ProviderCollectionCoordinator } = require("../lib/provider-collection-coordinator");
const {
  ProviderGatewayError,
  ProviderGatewayService,
  buildPlaybackIdentity,
  createPlaybackContext,
  sourceKind,
} = require("../lib/provider-gateway-service");
const {
  SourceContextStore,
  fingerprintStream,
  hashOpaqueValue,
} = require("../lib/source-context");
const { UpstreamFetchPolicy } = require("../lib/upstream-fetch-policy");

const PROFILE_A = "profile_A_00000001";
const PROFILE_B = "profile_B_00000002";
const PROFILE_C = "profile_C_00000003";

function claimSourceContext(store, profileId, deviceId, request) {
  if (!Object.hasOwn(request, "attemptId")) request.attemptId = crypto.randomUUID();
  const requestDigest = hashOpaqueValue(JSON.stringify(request));
  const sessionId = "session_" + crypto.createHash("sha256")
    .update(profileId + "\0" + deviceId + "\0" + requestDigest, "utf8")
    .digest("hex")
    .slice(0, 32);
  return store.claim(profileId, deviceId, request, { sessionId, requestDigest });
}

function descriptor(name, transportUrl, resources = ["stream", "subtitles"], options = {}) {
  return {
    transportUrl,
    manifest: {
      id: "org.example." + name,
      version: "1.0.0",
      name,
      types: options.types || ["movie", "series"],
      idPrefixes: options.idPrefixes || ["tt"],
      resources,
    },
  };
}

function selection(providerId, ordinal, value) {
  return { providerId, ordinal, descriptor: value };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function listenerTrackedAbortController() {
  const controller = new AbortController();
  const signal = controller.signal;
  const listeners = new Set();
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") listeners.add(listener);
    return addEventListener(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") listeners.delete(listener);
    return removeEventListener(type, listener, options);
  };
  return {
    abort: (reason) => controller.abort(reason),
    listenerCount: () => listeners.size,
    signal,
  };
}

function observeByImmediate(promise) {
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason })
    ),
    new Promise((resolve) => setImmediate(() => resolve({ status: "pending" }))),
  ]);
}

function jsonResponse(value) {
  const body = Buffer.from(JSON.stringify(value));
  return {
    status: 200,
    headers: { get: () => null },
    body: {
      destroy() {},
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    },
  };
}

class FakeProviderRepository {
  constructor(collections = {}) {
    this.collections = new Map(Object.entries(collections));
  }

  async list(profileId) {
    return clone(this.collections.get(profileId) || { revision: 0, providers: [] });
  }
}

class FakeFetchPolicy {
  constructor(handler) {
    this.handler = handler;
    this.calls = [];
  }

  async fetchJson(url, options) {
    this.calls.push({ url, signal: options && options.signal });
    return { value: await this.handler(url, options) };
  }
}

class FakePlaybackContexts {
  constructor() {
    this.records = [];
    let sequence = 0;
    this._authority = new SourceContextStore({
      generationFactory: () => "g1:" + String(++sequence),
    });
    this.generations = this._authority._profileGenerations;
  }

  async getProfileGeneration(profileId) {
    return this._authority.getProfileGeneration(profileId);
  }

  async getProviderSnapshotState(profileId) {
    return this._authority.getProviderSnapshotState(profileId);
  }

  async beginProviderSnapshotMutation(profileId) {
    return this._authority.beginProviderSnapshotMutation(profileId);
  }

  async renewProviderSnapshotMutation(profileId, token) {
    return this._authority.renewProviderSnapshotMutation(profileId, token);
  }

  async fenceProviderSnapshotMutation(profileId, token, mutationFence) {
    return this._authority.fenceProviderSnapshotMutation(profileId, token, mutationFence);
  }

  async completeProviderSnapshotMutation(profileId, token) {
    return this._authority.completeProviderSnapshotMutation(profileId, token);
  }

  async releaseProviderSnapshotMutation(profileId, token) {
    return this._authority.releaseProviderSnapshotMutation(profileId, token);
  }

  async probeProviderSnapshotRecovery(profileId) {
    return this._authority.probeProviderSnapshotRecovery(profileId);
  }

  async beginProviderSnapshotRecovery(profileId, candidateFence, expectedRecoveryFence) {
    return this._authority.beginProviderSnapshotRecovery(
      profileId,
      candidateFence,
      expectedRecoveryFence
    );
  }

  async completeProviderSnapshotRecovery(profileId, token, recoveryFence) {
    return this._authority.completeProviderSnapshotRecovery(profileId, token, recoveryFence);
  }

  async invalidateProfile(profileId) {
    const generation = this._authority.invalidateProfile(profileId);
    this.records = this.records.filter((entry) => entry.profileId !== profileId);
    return generation;
  }

  async record(profileId, context, options = {}) {
    if (options.generation !== (await this.getProfileGeneration(profileId))) {
      const error = new Error("profile generation changed");
      error.code = "profile_generation_changed";
      throw error;
    }
    this.records.push({
      profileId,
      context: clone(context),
      snapshot: {
        generation: options.generation,
        providerRevision: options.providerRevision,
      },
    });
    return context;
  }
}

function generationAware(repository) {
  if (
    typeof repository.getProfileGeneration === "function" &&
    typeof repository.invalidateProfile === "function" &&
    typeof repository.getProviderSnapshotState === "function" &&
    typeof repository.beginProviderSnapshotMutation === "function" &&
    typeof repository.renewProviderSnapshotMutation === "function" &&
    typeof repository.fenceProviderSnapshotMutation === "function" &&
    typeof repository.completeProviderSnapshotMutation === "function" &&
    typeof repository.releaseProviderSnapshotMutation === "function" &&
    typeof repository.probeProviderSnapshotRecovery === "function" &&
    typeof repository.beginProviderSnapshotRecovery === "function" &&
    typeof repository.completeProviderSnapshotRecovery === "function"
  ) {
    return repository;
  }
  let sequence = 0;
  const authority = new SourceContextStore({
    generationFactory: () => "g1:" + String(++sequence),
  });
  const originalRecord = repository.record.bind(repository);
  for (const method of [
    "getProfileGeneration",
    "getProviderSnapshotState",
    "beginProviderSnapshotMutation",
    "renewProviderSnapshotMutation",
    "fenceProviderSnapshotMutation",
    "completeProviderSnapshotMutation",
    "releaseProviderSnapshotMutation",
    "probeProviderSnapshotRecovery",
    "beginProviderSnapshotRecovery",
    "completeProviderSnapshotRecovery",
    "invalidateProfile",
  ]) {
    repository[method] = authority[method].bind(authority);
  }
  repository.record = async (profileId, context, options = {}) => {
    const result = await originalRecord(profileId, context, options);
    if (options.generation !== (await repository.getProfileGeneration(profileId))) {
      const error = new Error("profile generation changed");
      error.code = "profile_generation_changed";
      throw error;
    }
    return result;
  };
  return repository;
}

function playbackContextAdapter(store, overrides = {}) {
  const adapter = {};
  for (const method of [
    "getProfileGeneration",
    "getProviderSnapshotState",
    "beginProviderSnapshotMutation",
    "renewProviderSnapshotMutation",
    "fenceProviderSnapshotMutation",
    "completeProviderSnapshotMutation",
    "releaseProviderSnapshotMutation",
    "probeProviderSnapshotRecovery",
    "beginProviderSnapshotRecovery",
    "completeProviderSnapshotRecovery",
    "invalidateProfile",
    "record",
  ]) {
    adapter[method] = store[method].bind(store);
  }
  return Object.assign(adapter, overrides);
}

test("playback contexts retain valid private subtitle hints and ignore malformed optional hints", () => {
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };
  const context = createPlaybackContext(
    request,
    {
      url: "https://media.example/hints.mkv",
      behaviorHints: {
        videoHash: "0123456789abcdef",
        videoSize: 123456789,
        filename: "Hints.Movie.1080p.mkv",
      },
    },
    "provider_hints_0001"
  );
  assert.deepEqual(
    {
      videoHash: context.request.videoHash,
      videoSize: context.request.videoSize,
      filename: context.request.filename,
    },
    {
      videoHash: "0123456789abcdef",
      videoSize: 123456789,
      filename: "Hints.Movie.1080p.mkv",
    }
  );

  const malformed = createPlaybackContext(
    request,
    {
      url: "https://media.example/malformed-hints.mkv",
      behaviorHints: {
        videoHash: { token: "not-a-hash" },
        videoSize: Number.MAX_SAFE_INTEGER + 1,
        filename: "bad\u0000name.mkv",
      },
    },
    "provider_hints_0001"
  );
  assert.equal(Object.hasOwn(malformed.request, "videoHash"), false);
  assert.equal(Object.hasOwn(malformed.request, "videoSize"), false);
  assert.equal(Object.hasOwn(malformed.request, "filename"), false);
});

function serviceFixture(collections, fetchHandler, options = {}) {
  const providers = new FakeProviderRepository(collections);
  const fetchPolicy = new FakeFetchPolicy(fetchHandler);
  const playbackContexts = generationAware(options.playbackContexts || new FakePlaybackContexts());
  const errors = [];
  const service = new ProviderGatewayService({
    providers,
    fetchPolicy,
    playbackContexts,
    onProviderError: (error) => errors.push(error),
    ...options,
    playbackContexts,
  });
  return { service, providers, fetchPolicy, playbackContexts, errors };
}

test("legacy gateway preserves direct list-generation-invalidate ordering without fenced recovery", async () => {
  const events = [];
  let generation = "g1:legacy_1";
  const providers = {
    async list() {
      events.push("list");
      return { revision: 0, providers: [] };
    },
    async replaceAll() {
      throw new Error("gateway unexpectedly replaced providers");
    },
    async allocateMutationFence() {
      throw new Error("legacy strategy entered fenced allocation");
    },
    async advanceMutationFence() {
      throw new Error("legacy strategy entered fenced recovery");
    },
  };
  const playbackContexts = {
    async getProfileGeneration() {
      events.push("generation");
      return generation;
    },
    async invalidateProfile() {
      events.push("invalidate");
      generation = "g1:legacy_2";
      return generation;
    },
    async record() {},
    async getProviderSnapshotState() {
      throw new Error("legacy strategy entered fenced snapshot state");
    },
    async probeProviderSnapshotRecovery() {
      throw new Error("legacy strategy entered fenced recovery");
    },
  };
  const providerCollectionCoordinator = new ProviderCollectionCoordinator({
    mode: "legacy",
    providers,
    playbackContexts,
  });
  const service = new ProviderGatewayService({
    playbackContexts,
    providerCollectionCoordinator,
    fetchPolicy: new FakeFetchPolicy(async () => ({ subtitles: [] })),
  });

  assert.equal((await service.capabilities(PROFILE_A)).revision, 0);
  const result = await service.queryWithSnapshot(PROFILE_A, {
    resource: "subtitles",
    type: "movie",
    id: "tt2000000",
    extra: [],
  });
  assert.deepEqual(result.snapshot, {
    providerRevision: "0",
    generation: "g1:legacy_1",
  });
  assert.equal(await service.clearProfile(PROFILE_A), "g1:legacy_2");
  assert.deepEqual(events, [
    "list",
    "generation",
    "list",
    "generation",
    "invalidate",
  ]);
});

test("advertised gateway capabilities are profile isolated and honor provider manifests", async () => {
  const streamOnly = descriptor("streams", "https://streams.example/manifest.json", [
    { name: "stream", types: ["movie"], idPrefixes: ["tt"] },
  ]);
  const subtitleOnly = descriptor("subs", "https://subs.example/manifest.json", [
    { name: "subtitles", types: ["series"], idPrefixes: [] },
  ]);
  const { service } = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 3,
        providers: [
          selection("provider_stream_0001", 0, streamOnly),
          selection("provider_subs_00002", 1, subtitleOnly),
        ],
      },
      [PROFILE_B]: { revision: 0, providers: [] },
    },
    async () => ({})
  );

  assert.deepEqual(await service.capabilities(PROFILE_A), {
    revision: 3,
    types: ["movie", "series"],
    idPrefixes: [],
    resources: [
      { name: "stream", types: ["movie"], idPrefixes: ["tt"] },
      { name: "subtitles", types: ["series"], idPrefixes: [] },
    ],
  });
  assert.deepEqual(await service.capabilities(PROFILE_B), {
    revision: 0,
    types: [],
    idPrefixes: [],
    resources: [],
  });
});

test("mixed transports skip legacy providers whose encoder cannot represent the requested id", async () => {
  const legacy = descriptor(
    "legacy",
    "https://legacy.example/stremio/v1",
    ["stream"],
    { idPrefixes: [] }
  );
  const standard = descriptor(
    "standard",
    "https://standard.example/manifest.json",
    ["stream"],
    { idPrefixes: [] }
  );
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection("provider_legacy_0001", 0, legacy),
          selection("provider_standard_01", 1, standard),
        ],
      },
    },
    async () => ({ streams: [{ url: "https://media.example/local" }] })
  );

  assert.deepEqual(
    await fixture.service.query(PROFILE_A, {
      resource: "stream",
      type: "movie",
      id: "local-id",
      extra: [],
    }),
    { streams: [{ url: "https://media.example/local" }] }
  );
  assert.equal(fixture.fetchPolicy.calls.length, 1);
  assert.match(fixture.fetchPolicy.calls[0].url, /^https:\/\/standard\.example\//);
});

test("stream aggregation preserves order but never caches partial provider results", async () => {
  const collections = {
    [PROFILE_A]: {
      revision: 1,
      providers: [
        selection(
          "provider_one_000001",
          0,
          descriptor("one", "https://one.example/manifest.json", ["stream"])
        ),
        selection(
          "provider_bad_000002",
          1,
          descriptor("bad", "https://bad.example/manifest.json", ["stream"])
        ),
        selection(
          "provider_two_000003",
          2,
          descriptor("two", "https://two.example/manifest.json", ["stream"])
        ),
      ],
    },
  };
  const first = { url: "https://media.example/one.mkv", name: "one" };
  const second = { infoHash: "a".repeat(40), fileIdx: 3, name: "two" };
  const fixture = serviceFixture(collections, async (url) => {
    if (url.startsWith("https://bad.example/")) {
      const error = new Error("credential-bearing upstream detail must not escape");
      error.code = "upstream_timeout";
      throw error;
    }
    if (url.startsWith("https://one.example/")) return { streams: [first, { name: "not playable" }] };
    return { streams: [second] };
  });

  const response = await fixture.service.query(PROFILE_A, {
    resource: "stream",
    type: "movie",
    id: "tt1234567",
    extra: [],
  });
  assert.deepEqual(response, { streams: [first, second] });
  assert.equal(fixture.playbackContexts.records.length, 2);
  assert.deepEqual(
    fixture.playbackContexts.records.map((entry) => entry.context.request.streamProvider),
    ["provider_one_000001", "provider_two_000003"]
  );
  const context = fixture.playbackContexts.records[0].context;
  assert.equal(context.canonicalIdentity.id, "tt1234567");
  assert.equal(context.traktEligible, true);
  assert.equal(context.source.type, "url");
  assert.doesNotMatch(JSON.stringify(context), /media\.example/);
  assert.equal(fixture.errors.length, 2);
  assert.deepEqual(Object.keys(fixture.errors[0]).sort(), [
    "code",
    "phase",
    "profileScope",
    "providerScope",
  ]);
  assert.equal(fixture.errors[0].code, "upstream_timeout");
  assert.equal(fixture.errors[1].phase, "context_record");

  const cached = await fixture.service.query(PROFILE_A, {
    resource: "stream",
    type: "movie",
    id: "tt1234567",
    extra: [],
  });
  assert.deepEqual(cached, response);
  assert.equal(fixture.fetchPolicy.calls.length, 6, "partial aggregates must be fetched again");
  assert.equal(fixture.playbackContexts.records.length, 4, "cache hits must create fresh launch context");
});

test("private query snapshots bind exact provider revision and generation without changing public responses", async () => {
  const subtitle = { id: "private-snapshot-subtitle", lang: "eng", url: "https://media.example/sub.vtt" };
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 42,
        providers: [
          selection(
            "provider_snapshot_001",
            0,
            descriptor("snapshot", "https://snapshot.example/manifest.json")
          ),
        ],
      },
    },
    async (url) => url.includes("/subtitles/")
      ? { subtitles: [subtitle] }
      : { streams: [{ url: "https://media.example/snapshot.mkv" }] }
  );
  fixture.playbackContexts.generations.set(PROFILE_A, "g1:90071992547409910000000000000001");

  const subtitleRequest = {
    resource: "subtitles",
    type: "movie",
    id: "tt1234567",
    extra: [],
  };
  const publicResponse = await fixture.service.query(PROFILE_A, subtitleRequest);
  assert.equal(
    JSON.stringify(publicResponse),
    JSON.stringify({ subtitles: [subtitle] }),
    "the configured-addon response acquired private snapshot fields"
  );
  const privateResult = await fixture.service.queryWithSnapshot(PROFILE_A, subtitleRequest);
  assert.deepEqual(privateResult, {
    response: { subtitles: [subtitle] },
    snapshot: {
      providerRevision: "42",
      generation: "g1:90071992547409910000000000000001",
    },
  });
  assert.equal(Object.isFrozen(privateResult.snapshot), true);
  assert.deepEqual(Object.keys(publicResponse), ["subtitles"]);

  const streamResult = await fixture.service.queryWithSnapshot(PROFILE_A, {
    resource: "stream",
    type: "movie",
    id: "tt1234568",
    extra: [],
  });
  assert.deepEqual(streamResult.snapshot, privateResult.snapshot);
  assert.deepEqual(fixture.playbackContexts.records[0].snapshot, privateResult.snapshot);
});

test("private query snapshots remain linearizable across provider replacement and clear races", async () => {
  const oldStarted = deferred();
  const releaseOld = deferred();
  const provider = selection(
    "provider_snapshot_race",
    0,
    descriptor("snapshot-race", "https://snapshot-race.example/manifest.json", ["subtitles"])
  );
  const fixture = serviceFixture(
    { [PROFILE_A]: { revision: 1, providers: [provider] } },
    async (url) => {
      if (url.includes("tt2000001")) {
        oldStarted.resolve();
        await releaseOld.promise;
        return { subtitles: [{ id: "old", url: "https://media.example/old.vtt" }] };
      }
      return { subtitles: [{ id: "new", url: "https://media.example/new.vtt" }] };
    }
  );
  const request = (id) => ({ resource: "subtitles", type: "movie", id, extra: [] });

  const oldQuery = fixture.service.queryWithSnapshot(PROFILE_A, request("tt2000001"));
  await oldStarted.promise;
  fixture.providers.collections.set(PROFILE_A, { revision: 2, providers: [provider] });
  const current = await fixture.service.queryWithSnapshot(PROFILE_A, request("tt2000002"));
  assert.deepEqual(current, {
    response: { subtitles: [{ id: "new", url: "https://media.example/new.vtt" }] },
    snapshot: { providerRevision: "2", generation: "g1:0" },
  });
  releaseOld.resolve();
  assert.deepEqual(await oldQuery, {
    response: { subtitles: [] },
    snapshot: { providerRevision: "1", generation: "g1:0" },
  });

  const clearStarted = deferred();
  const releaseClear = deferred();
  fixture.fetchPolicy.handler = async () => {
    clearStarted.resolve();
    await releaseClear.promise;
    return { subtitles: [{ id: "cleared", url: "https://media.example/cleared.vtt" }] };
  };
  const clearingQuery = fixture.service.queryWithSnapshot(PROFILE_A, request("tt2000003"));
  await clearStarted.promise;
  await fixture.service.clearProfile(PROFILE_A);
  assert.deepEqual(await clearingQuery, { response: { subtitles: [] }, snapshot: null });
  releaseClear.resolve();
});

test("private query snapshots retry split reads instead of returning an impossible revision tuple", async () => {
  const oldProvider = selection(
    "provider_split_old_0001",
    0,
    descriptor("split-old", "https://split-old.example/manifest.json", ["subtitles"])
  );
  const newProvider = selection(
    "provider_split_new_0002",
    0,
    descriptor("split-new", "https://split-new.example/manifest.json", ["subtitles"])
  );
  const playbackContexts = new SourceContextStore();
  playbackContexts._profileGenerations.set(PROFILE_A, "g1:1");
  let listCalls = 0;
  const providers = {
    async list() {
      listCalls += 1;
      if (listCalls === 1) {
        playbackContexts._profileGenerations.set(PROFILE_A, "g1:2");
        return { revision: 1, providers: [oldProvider] };
      }
      return { revision: 2, providers: [newProvider] };
    },
  };
  const service = new ProviderGatewayService({
    providers,
    playbackContexts,
    fetchPolicy: new FakeFetchPolicy(async (url) => ({
      subtitles: [{ id: url.includes("split-new") ? "new" : "old", url }],
    })),
  });

  const result = await service.queryWithSnapshot(PROFILE_A, {
    resource: "subtitles",
    type: "movie",
    id: "tt2000004",
    extra: [],
  });
  assert.equal(listCalls, 2);
  assert.deepEqual(result.snapshot, { providerRevision: "2", generation: "g1:2" });
  assert.equal(result.response.subtitles[0].id, "new");
  assert.notDeepEqual(result.snapshot, { providerRevision: "1", generation: "g1:2" });
});

test("private query snapshot retries are bounded while a distributed writer remains pending", async () => {
  let snapshotReads = 0;
  let listCalls = 0;
  const partialPlaybackContexts = {
    async getProfileGeneration() {
      return "g1:w_8640000000000000_" + "a".repeat(43);
    },
    async invalidateProfile() {},
    async record() {},
  };
  assert.throws(
    () =>
      new ProviderGatewayService({
        providers: { async list() { listCalls += 1; } },
        playbackContexts: partialPlaybackContexts,
        fetchPolicy: new FakeFetchPolicy(async () => ({ subtitles: [] })),
      }),
    /provider snapshot authority is unavailable/
  );
  assert.equal(listCalls, 0);

  const playbackContexts = new SourceContextStore({
    clock: () => 0,
    providerMutationLeaseMs: 60_000,
  });
  playbackContexts.beginProviderSnapshotMutation(PROFILE_A);
  const readState = playbackContexts.getProviderSnapshotState.bind(playbackContexts);
  playbackContexts.getProviderSnapshotState = (...args) => {
    snapshotReads += 1;
    return readState(...args);
  };
  const service = new ProviderGatewayService({
    providers: {
      async list() {
        listCalls += 1;
        return { revision: 1, providers: [] };
      },
    },
    playbackContexts,
    fetchPolicy: new FakeFetchPolicy(async () => ({ subtitles: [] })),
  });

  await assert.rejects(
    service.queryWithSnapshot(PROFILE_A, {
      resource: "subtitles",
      type: "movie",
      id: "tt2000005",
      extra: [],
    }),
    (error) => error.code === "provider_snapshot_contention"
  );
  assert.equal(snapshotReads, 16);
  assert.equal(listCalls, 0);
});

test("coordinated clearProfile returns the completed stable generation", async () => {
  let sequence = 0;
  const playbackContexts = new SourceContextStore({
    generationFactory: () => "g1:clear_" + String(++sequence),
  });
  const service = new ProviderGatewayService({
    providers: {
      async list() {
        return { revision: 0, providers: [] };
      },
    },
    playbackContexts,
    fetchPolicy: new FakeFetchPolicy(async () => ({ subtitles: [] })),
  });

  assert.equal(await service.clearProfile(PROFILE_A), "g1:clear_1");
  assert.deepEqual(playbackContexts.getProviderSnapshotState(PROFILE_A), {
    generation: "g1:clear_1",
    pending: false,
  });
});

test("fixed-clock long-TTL cache excludes skipped, failed, partial, timed-out, and aborted work", async (t) => {
  const now = 42_000;
  const cacheOptions = {
    clock: () => now,
    cacheTtlMs: 60 * 60 * 1000,
    failureThreshold: 3,
    breakerCooldownMs: 60 * 60 * 1000,
  };
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  const singleProviderFixture = (suffix, handler, options = {}) =>
    serviceFixture(
      {
        [PROFILE_A]: {
          revision: 1,
          providers: [
            selection(
              "provider_cache_" + suffix,
              0,
              descriptor(suffix, "https://" + suffix + ".example/manifest.json", ["stream"])
            ),
          ],
        },
      },
      handler,
      { ...cacheOptions, ...options }
    );

  const assertFailureIsNotCached = async (suffix, code) => {
    let failing = true;
    const fixture = singleProviderFixture(suffix, async () => {
      if (failing) {
        const error = new Error("adversarial provider failure");
        if (code) error.code = code;
        throw error;
      }
      return { streams: [{ url: "https://media.example/" + suffix }] };
    });

    assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams: [] });
    assert.equal(fixture.service._cache.size, 0, suffix + " failure populated the long-TTL cache");
    failing = false;
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
    assert.equal(fixture.fetchPolicy.calls.length, 2, suffix + " failure became a cache hit");
    assert.equal(fixture.service._cache.size, 1);
  };

  await t.test("failed results are never cached", async () => {
    await assertFailureIsNotCached("failed", null);
  });

  await t.test("timed-out results are never cached", async () => {
    await assertFailureIsNotCached("timedout", "upstream_timeout");
  });

  await t.test("partial results are never cached", async () => {
    let secondProviderFails = true;
    const fixture = serviceFixture(
      {
        [PROFILE_A]: {
          revision: 1,
          providers: [
            selection(
              "provider_partial_good",
              0,
              descriptor("partial-good", "https://partial-good.example/manifest.json", ["stream"])
            ),
            selection(
              "provider_partial_bad_",
              1,
              descriptor("partial-bad", "https://partial-bad.example/manifest.json", ["stream"])
            ),
          ],
        },
      },
      async (url) => {
        if (url.startsWith("https://partial-bad.example/") && secondProviderFails) {
          const error = new Error("partial provider failed");
          error.code = "upstream_http_status";
          throw error;
        }
        return {
          streams: [
            { url: url.startsWith("https://partial-good.example/")
              ? "https://media.example/good"
              : "https://media.example/recovered" },
          ],
        };
      },
      cacheOptions
    );

    assert.deepEqual(await fixture.service.query(PROFILE_A, request), {
      streams: [{ url: "https://media.example/good" }],
    });
    assert.equal(fixture.service._cache.size, 0, "partial aggregate populated the long-TTL cache");
    secondProviderFails = false;
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 2);
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 2);
    assert.equal(fixture.fetchPolicy.calls.length, 4, "partial aggregate became a cache hit");
    assert.equal(fixture.service._cache.size, 1);
  });

  await t.test("breaker-skipped results are never cached", async () => {
    const fixture = singleProviderFixture(
      "skipped",
      async () => {
        const error = new Error("open the breaker");
        error.code = "upstream_timeout";
        throw error;
      },
      { failureThreshold: 1 }
    );

    assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams: [] });
    assert.equal(fixture.service._cache.size, 0);
    assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams: [] });
    assert.equal(fixture.service._cache.size, 0, "breaker skip populated the long-TTL cache");
    assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams: [] });
    assert.equal(fixture.fetchPolicy.calls.length, 1, "open breaker unexpectedly executed the provider");
    assert.equal(fixture.service._cache.size, 0);
  });

  await t.test("aborted results are never cached", async () => {
    const controller = new AbortController();
    let abortFirst = true;
    const fixture = singleProviderFixture("aborted", async () => {
      if (abortFirst) {
        abortFirst = false;
        controller.abort();
        const error = new Error("caller canceled");
        error.code = "upstream_aborted";
        throw error;
      }
      return { streams: [{ url: "https://media.example/after-abort" }] };
    });

    await assert.rejects(
      fixture.service.query(PROFILE_A, request, { signal: controller.signal }),
      (error) => error instanceof ProviderGatewayError && error.code === "gateway_aborted"
    );
    assert.equal(fixture.service._cache.size, 0, "aborted aggregate populated the long-TTL cache");
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
    assert.equal(fixture.fetchPolicy.calls.length, 2, "aborted aggregate became a cache hit");
    assert.equal(fixture.service._cache.size, 1);
  });
});

test("cache keys include profile, provider revision, and exact request extras", async () => {
  const shared = descriptor("shared", "https://shared.example/manifest.json", ["stream"]);
  const collections = {
    [PROFILE_A]: {
      revision: 1,
      providers: [selection("provider_a_00000001", 0, shared)],
    },
    [PROFILE_B]: {
      revision: 1,
      providers: [selection("provider_b_00000002", 0, shared)],
    },
  };
  let serial = 0;
  const fixture = serviceFixture(collections, async () => ({
    streams: [{ url: "https://media.example/" + ++serial }],
  }));
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  await fixture.service.query(PROFILE_A, request);
  await fixture.service.query(PROFILE_A, request);
  await fixture.service.query(PROFILE_B, request);
  await fixture.service.query(PROFILE_A, {
    ...request,
    extra: [{ name: "videoHash", value: "abc" }],
  });
  fixture.providers.collections.get(PROFILE_A).revision = 2;
  await fixture.service.query(PROFILE_A, request);
  assert.equal(fixture.fetchPolicy.calls.length, 4);

  await fixture.service.clearProfile(PROFILE_A);
  await fixture.service.query(PROFILE_A, request);
  await fixture.service.query(PROFILE_B, request);
  assert.equal(fixture.fetchPolicy.calls.length, 5, "clearing A must not evict B");
});

test("pruneCache scans past live LRU entries and keeps cache bytes exact", async () => {
  let now = 1_000;
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_prune_cache_01",
            0,
            descriptor("prune-cache", "https://prune-cache.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => ({ streams: [{ url: "https://media.example/prune-cache" }] }),
    { cacheTtlMs: 10, clock: () => now }
  );
  const firstRequest = { resource: "stream", type: "movie", id: "tt1000001", extra: [] };
  const secondRequest = { resource: "stream", type: "movie", id: "tt1000002", extra: [] };

  await fixture.service.query(PROFILE_A, firstRequest);
  now += 5;
  await fixture.service.query(PROFILE_A, secondRequest);
  await fixture.service.query(PROFILE_A, firstRequest);

  const reordered = [...fixture.service._cache.entries()];
  assert.equal(reordered.length, 2);
  assert.deepEqual(
    reordered.map((entry) => entry[1].expiresAt),
    [1_015, 1_010],
    "the older entry must sit behind the live entry after an LRU cache hit"
  );
  assert.equal(
    fixture.service._cacheBytes,
    reordered.reduce((total, entry) => total + entry[1].bytes, 0)
  );

  const [liveKey, liveEntry] = reordered[0];
  now = 1_010;
  assert.equal(fixture.service.pruneCache(), 1);
  assert.equal(fixture.service._cache.size, 1);
  assert.equal(fixture.service._cache.get(liveKey), liveEntry);
  assert.equal(fixture.service._cacheBytes, liveEntry.bytes);
  assert.equal(fixture.service.pruneCache(), 0, "a live entry must survive repeated pruning");

  now = 1_015;
  assert.equal(fixture.service.pruneCache(), 1);
  assert.equal(fixture.service._cache.size, 0);
  assert.equal(fixture.service._cacheBytes, 0);
  assert.equal(fixture.fetchPolicy.calls.length, 2, "the LRU reorder must come from a cache hit");
});

test("subtitles aggregate in provider order and deduplicate exact source identity", async () => {
  const collections = {
    [PROFILE_A]: {
      revision: 1,
      providers: [
        selection(
          "provider_sub_a_00001",
          0,
          descriptor("sub-a", "https://sub-a.example/manifest.json", ["subtitles"])
        ),
        selection(
          "provider_sub_b_00002",
          1,
          descriptor("sub-b", "https://sub-b.example/manifest.json", ["subtitles"])
        ),
      ],
    },
  };
  const duplicate = { id: "en-1", url: "https://subs.example/a.srt", lang: "en" };
  const unique = { id: "es-1", url: "https://subs.example/b.srt", lang: "es" };
  const fixture = serviceFixture(collections, async (url) => ({
    subtitles: url.includes("sub-a") ? [duplicate] : [duplicate, unique],
  }));

  assert.deepEqual(
    await fixture.service.query(PROFILE_A, {
      resource: "subtitles",
      type: "movie",
      id: "tt1234567",
      extra: [{ name: "filename", value: "movie.mkv" }],
    }),
    { subtitles: [duplicate, unique] }
  );
  assert.equal(fixture.playbackContexts.records.length, 0);
});

test("private subtitle discovery retains only server-owned provider capabilities", async () => {
  const provider = selection(
    "provider_private_subs_0001",
    0,
    descriptor("private-subs", "https://private-subs.example/manifest.json", ["subtitles"])
  );
  const valid = {
    id: "secret-provider-id",
    lang: "pt-BR",
    url: "https://subs.example/private.srt?token=source-secret",
    headers: { Authorization: "Bearer header-secret" },
    objectKey: "storage-secret",
    arbitrary: { token: "arbitrary-secret" },
  };
  const malformed = [
    { id: "http", lang: "en", url: "http://127.0.0.1/private.srt" },
    { id: "credentials", lang: "en", url: "https://user:pass@subs.example/private.srt" },
    { id: "missing", lang: "en" },
  ];
  const directVobSub = [
    {
      id: "direct-idx",
      lang: "en",
      url: "https://subs.example/packs/Movie.idx?token=idx-secret",
      headers: { Authorization: "Bearer idx-header-secret" },
    },
    {
      id: "direct-sub",
      lang: "en",
      url: "https://subs.example/data/Movie.sub?token=sub-secret",
      headers: { Authorization: "Bearer sub-header-secret" },
    },
  ];
  const ambiguousVobSub = [
    { id: "ambiguous-idx", lang: "es", url: "https://subs.example/a/Ambiguous.idx" },
    { id: "ambiguous-sub-1", lang: "es", url: "https://subs.example/b/Ambiguous.sub?part=1" },
    { id: "ambiguous-sub-2", lang: "es", url: "https://subs.example/c/Ambiguous.sub?part=2" },
  ];
  const archive = {
    id: "archive-vobsub",
    lang: "de",
    url: "https://subs.example/archive/Movie.zip?token=archive-secret",
  };
  const unmatchedTextSub = {
    id: "microdvd",
    lang: "fr",
    url: "https://subs.example/text/Dialogue.sub",
  };
  const differentOrigin = [
    { id: "other-idx", lang: "it", url: "https://index.example/Other.idx" },
    { id: "other-sub", lang: "it", url: "https://data.example/Other.sub" },
  ];
  const languageMismatch = [
    { id: "mismatch-idx", lang: "nl", url: "https://subs.example/a/Mismatch.idx" },
    { id: "mismatch-sub", lang: "en", url: "https://subs.example/b/Mismatch.sub" },
  ];
  const providerItems = [
    valid,
    ...malformed,
    ...directVobSub,
    ...ambiguousVobSub,
    archive,
    unmatchedTextSub,
    ...differentOrigin,
    ...languageMismatch,
  ];
  const fixture = serviceFixture(
    { [PROFILE_A]: { revision: 7, providers: [provider] } },
    async () => ({ subtitles: providerItems })
  );
  const request = { resource: "subtitles", type: "movie", id: "tt1234567", extra: [] };

  const privateResult = await fixture.service.discoverSubtitles(PROFILE_A, request);
  assert.deepEqual(privateResult.snapshot, { providerRevision: "7", generation: "g1:0" });
  assert.equal(privateResult.response.candidates.length, 2);
  const candidate = privateResult.response.candidates[0];
  assert.equal(candidate.providerId, "provider_private_subs_0001");
  assert.deepEqual(candidate.display, { language: "pt-br", format: "srt" });
  assert.equal(candidate.sourceCapability.url.includes("source-secret"), true);
  assert.equal(candidate.sourceCapability.headers.authorization, "Bearer header-secret");
  assert.equal(Object.hasOwn(candidate, "objectKey"), false);
  assert.equal(Object.hasOwn(candidate, "arbitrary"), false);
  assert.deepEqual(
    privateResult.response.candidates.map((item) => item.display),
    [
      { language: "pt-br", format: "srt" },
      { language: "de", format: "archive" },
    ]
  );
  const privateJson = JSON.stringify(privateResult.response);
  for (const rejected of [
    "idx-secret",
    "sub-secret",
    "idx-header-secret",
    "sub-header-secret",
    "Ambiguous",
    "Mismatch",
    "index.example",
    "Dialogue.sub",
    "data.example",
  ]) {
    assert.equal(privateJson.includes(rejected), false, rejected);
  }

  const publicResult = await fixture.service.query(PROFILE_A, request);
  assert.deepEqual(publicResult, { subtitles: providerItems });
});

test("private discovery rejects ambiguous direct .sub when response bounds hide its .idx", async () => {
  const provider = selection(
    "provider_split_vobsub_0001",
    0,
    descriptor("split-vobsub", "https://split-vobsub.example/manifest.json", ["subtitles"])
  );
  const splitPair = [
    { id: "sub-first", lang: "en", url: "https://subs.example/Movie.sub?token=sub-secret" },
    { id: "idx-second", lang: "en", url: "https://subs.example/Movie.idx?token=idx-secret" },
  ];
  const fixture = serviceFixture(
    { [PROFILE_A]: { revision: 1, providers: [provider] } },
    async () => ({ subtitles: splitPair }),
    { maxAggregateItems: 1 }
  );
  const request = { resource: "subtitles", type: "movie", id: "tt1234567", extra: [] };

  const privateResult = await fixture.service.discoverSubtitles(PROFILE_A, request);
  assert.deepEqual(privateResult.response, { candidates: [] });
  assert.deepEqual(await fixture.service.query(PROFILE_A, request), {
    subtitles: [splitPair[0]],
  });
});

test("provider collection mutation fences playback before transition and final subtitle sweep", async () => {
  const events = [];
  const coordinator = new ProviderCollectionCoordinator({
    mode: "legacy",
    providers: {
      async list() { return { revision: 0, providers: [] }; },
      async replaceAll() {
        events.push("providers-replaced");
        return { revision: 1, count: 0 };
      },
    },
    playbackContexts: {
      async getProfileGeneration() { return "g1:0"; },
      async invalidateProfile() {
        events.push("playback-invalidated");
        return "g1:1";
      },
    },
    subtitleDeliveries: {
      async invalidateProfile() {
        events.push("subtitles-invalidated");
        return 1;
      },
    },
  });

  assert.deepEqual(await coordinator.replaceAll(PROFILE_A, [], 0), { revision: 1, count: 0 });
  assert.equal(await coordinator.invalidate(PROFILE_A), "g1:1");
  assert.deepEqual(events, [
    "playback-invalidated",
    "providers-replaced",
    "subtitles-invalidated",
    "playback-invalidated",
    "subtitles-invalidated",
  ]);
});

test("subtitle final-sweep failure leaves a visible provider mutation playback-fenced", async () => {
  let replacements = 0;
  let playbackInvalidations = 0;
  const coordinator = new ProviderCollectionCoordinator({
    mode: "legacy",
    providers: {
      async list() { return { revision: 0, providers: [] }; },
      async replaceAll() { replacements += 1; },
    },
    playbackContexts: {
      async getProfileGeneration() { return "g1:0"; },
      async invalidateProfile() {
        playbackInvalidations += 1;
        return "g1:1";
      },
    },
    subtitleDeliveries: {
      async invalidateProfile() { throw new Error("subtitle invalidation unavailable"); },
    },
  });
  await assert.rejects(
    coordinator.replaceAll(PROFILE_A, [], 0),
    /subtitle invalidation unavailable/
  );
  await assert.rejects(
    coordinator.invalidate(PROFILE_A),
    /subtitle invalidation unavailable/
  );
  assert.equal(replacements, 1);
  assert.equal(playbackInvalidations, 2);
});

test("circuit breaker skips a failing provider until one bounded half-open probe succeeds", async () => {
  let now = 1_000;
  let fail = true;
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_flaky_0001",
            0,
            descriptor("flaky", "https://flaky.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => {
      if (fail) {
        const error = new Error("timeout");
        error.code = "upstream_timeout";
        throw error;
      }
      return { streams: [{ url: "https://media.example/recovered" }] };
    },
    {
      clock: () => now,
      cacheTtlMs: 1,
      failureThreshold: 1,
      breakerCooldownMs: 100,
    }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams: [] });
  now += 2;
  assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams: [] });
  assert.equal(fixture.fetchPolicy.calls.length, 1);
  fail = false;
  now += 100;
  assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
  assert.equal(fixture.fetchPolicy.calls.length, 2);
});

test("multi-profile queue pressure is breaker-neutral and profile isolated", async () => {
  let now = 1_000;
  let queueFull = true;
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_timeout_0001",
            0,
            descriptor("timeout", "https://timeout.example/manifest.json", ["stream"])
          ),
        ],
      },
      [PROFILE_B]: {
        revision: 1,
        providers: [
          selection(
            "provider_queued_00002",
            0,
            descriptor("queued", "https://queued.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async (url) => {
      const error = new Error("local pressure");
      if (url.startsWith("https://timeout.example/")) {
        error.code = "upstream_timeout";
        throw error;
      }
      if (queueFull) {
        error.code = "upstream_queue_full";
        throw error;
      }
      return { streams: [{ url: "https://media.example/admitted" }] };
    },
    {
      clock: () => now,
      cacheTtlMs: 1,
      failureThreshold: 1,
      breakerCooldownMs: 10_000,
    }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  assert.deepEqual(await Promise.all([
    fixture.service.query(PROFILE_A, request),
    fixture.service.query(PROFILE_B, request),
  ]), [{ streams: [] }, { streams: [] }]);

  now += 2;
  queueFull = false;
  assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams: [] });
  assert.equal((await fixture.service.query(PROFILE_B, request)).streams.length, 1);
  assert.equal(
    fixture.fetchPolicy.calls.filter((call) => call.url.startsWith("https://timeout.example/")).length,
    1,
    "a real provider failure must still open only that profile's breaker"
  );
  assert.equal(
    fixture.fetchPolicy.calls.filter((call) => call.url.startsWith("https://queued.example/")).length,
    2,
    "queue admission pressure must not open the other profile's breaker"
  );
  assert.equal(fixture.service._breakers.size, 1);
});

test("queue-full and admission-timeout aggregates are breaker-neutral and never cached", async () => {
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };
  for (const code of ["upstream_queue_full", "upstream_admission_timeout"]) {
    let pressured = true;
    const fixture = serviceFixture(
      {
        [PROFILE_A]: {
          revision: 1,
          providers: [
            selection(
              "provider_pressure_01",
              0,
              descriptor("pressure", "https://pressure.example/manifest.json", ["stream"])
            ),
          ],
        },
      },
      async () => {
        if (pressured) {
          const error = new Error("local admission pressure");
          error.code = code;
          throw error;
        }
        return { streams: [{ url: "https://media.example/admitted" }] };
      },
      { failureThreshold: 1 }
    );

    assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams: [] });
    pressured = false;
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1, code);
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1, code);
    assert.equal(fixture.fetchPolicy.calls.length, 2, code + " result was incorrectly cached");
    assert.equal(fixture.service._breakers.size, 0, code + " advanced a breaker");
  }
});

test("cross-profile queue delay neither opens a breaker nor caches admission failure", async () => {
  const busyStarted = deferred();
  const releaseBusy = deferred();
  let profileBExecutions = 0;
  const fetchPolicy = new UpstreamFetchPolicy({
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    maxConcurrent: 1,
    maxQueued: 2,
    admissionTimeoutMs: 10,
    totalTimeoutMs: 1000,
    fetch: async (url) => {
      if (url.startsWith("https://busy.example/")) {
        busyStarted.resolve();
        await releaseBusy.promise;
        return jsonResponse({ streams: [{ url: "https://media.example/busy" }] });
      }
      profileBExecutions += 1;
      return jsonResponse({ streams: [{ url: "https://media.example/fast" }] });
    },
  });
  const providers = new FakeProviderRepository({
    [PROFILE_A]: {
      revision: 1,
      providers: [
        selection(
          "provider_busy_00001",
          0,
          descriptor("busy", "https://busy.example/manifest.json", ["stream"])
        ),
      ],
    },
    [PROFILE_B]: {
      revision: 1,
      providers: [
        selection(
          "provider_fast_00002",
          0,
          descriptor("fast", "https://fast.example/manifest.json", ["stream"])
        ),
      ],
    },
  });
  const errors = [];
  const service = new ProviderGatewayService({
    providers,
    playbackContexts: new FakePlaybackContexts(),
    fetchPolicy,
    failureThreshold: 1,
    onProviderError: (error) => errors.push(error),
  });
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  const busyQuery = service.query(PROFILE_A, request);
  await busyStarted.promise;
  assert.deepEqual(await service.query(PROFILE_B, request), { streams: [] });
  assert.equal(errors.at(-1).code, "upstream_admission_timeout");
  assert.equal(service._breakers.size, 0);
  releaseBusy.resolve();
  await busyQuery;

  assert.equal((await service.query(PROFILE_B, request)).streams.length, 1);
  assert.equal((await service.query(PROFILE_B, request)).streams.length, 1);
  assert.equal(profileBExecutions, 1, "admission failure must not become an empty cache hit");
  assert.equal(service._breakers.size, 0);
});

test("64-provider fanout stays within default per-profile admission and preserves order", async () => {
  const providerCount = 64;
  const providers = Array.from({ length: providerCount }, (_value, index) =>
    selection(
      "provider_pool_" + String(index).padStart(4, "0"),
      index,
      descriptor(
        "pool-" + index,
        "https://pool-" + String(index).padStart(2, "0") + ".example/manifest.json",
        ["stream"]
      )
    )
  );
  let active = 0;
  let maxActive = 0;
  let networkCalls = 0;
  const fetchPolicy = new UpstreamFetchPolicy({
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      const match = new URL(url).hostname.match(/^pool-(\d+)\.example$/);
      const index = Number(match[1]);
      networkCalls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1 + ((providerCount - index) % 4)));
        return jsonResponse({
          streams: [{ url: "https://media.example/pool/" + index, name: "stream-" + index }],
        });
      } finally {
        active -= 1;
      }
    },
  });
  const playbackContexts = new FakePlaybackContexts();
  const errors = [];
  const service = new ProviderGatewayService({
    providers: new FakeProviderRepository({
      [PROFILE_A]: { revision: 1, providers },
    }),
    playbackContexts,
    fetchPolicy,
    onProviderError: (error) => errors.push(error),
  });
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  const first = await service.query(PROFILE_A, request);
  assert.equal(first.streams.length, providerCount);
  assert.deepEqual(
    first.streams.map((stream) => stream.name),
    Array.from({ length: providerCount }, (_value, index) => "stream-" + index)
  );
  assert.equal(networkCalls, providerCount);
  assert.ok(maxActive <= 4, "gateway exceeded the default per-profile admission limit");
  assert.equal(errors.length, 0, "ordinary 64-provider fanout hit admission pressure");

  assert.deepEqual(await service.query(PROFILE_A, request), first);
  assert.equal(networkCalls, providerCount, "complete ordered aggregate was not cached");
  assert.equal(playbackContexts.records.length, providerCount * 2);
  assert.equal(service._breakers.size, 0);
});

test("late same-revision failure cannot overwrite an earlier successful cache entry", async () => {
  const slowStarted = deferred();
  const releaseSlow = deferred();
  let calls = 0;
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_cache_race1",
            0,
            descriptor("cache-race", "https://cache-race.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => {
      calls += 1;
      if (calls === 1) {
        slowStarted.resolve();
        await releaseSlow.promise;
        const error = new Error("late timeout");
        error.code = "upstream_timeout";
        throw error;
      }
      return { streams: [{ url: "https://media.example/success" }] };
    }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };
  const independentSignal = new AbortController().signal;

  const slow = fixture.service.query(PROFILE_A, request, { signal: independentSignal });
  await slowStarted.promise;
  const successful = await fixture.service.query(PROFILE_A, request);
  releaseSlow.resolve();
  assert.deepEqual(await slow, { streams: [] });
  assert.equal((await fixture.service.query(PROFILE_A, request)).streams[0].url, successful.streams[0].url);
  assert.equal(calls, 2, "late failure replaced the successful cache entry");
});

test("same-key provider work coalesces and releases bounded in-flight state", async () => {
  const started = deferred();
  const release = deferred();
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_coalesce_01",
            0,
            descriptor("coalesce", "https://coalesce.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => {
      started.resolve();
      await release.promise;
      return { streams: [{ url: "https://media.example/coalesced" }] };
    }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };
  const first = fixture.service.query(PROFILE_A, request);
  await started.promise;
  const second = fixture.service.query(PROFILE_A, request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.fetchPolicy.calls.length, 1);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [
    { streams: [{ url: "https://media.example/coalesced" }] },
    { streams: [{ url: "https://media.example/coalesced" }] },
  ]);
  assert.equal(fixture.service._inFlight.size, 0);
  assert.equal(fixture.service._profileEpochs.size, 0);
});

test("clearProfile promptly invalidates stalled fetches before cache and context writes", async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_clear_00001",
            0,
            descriptor("clear", "https://clear.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await release.promise;
      }
      return { streams: [{ url: "https://media.example/clear" }] };
    }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  const pending = fixture.service.query(PROFILE_A, request);
  await started.promise;
  const observed = observeByImmediate(pending);
  await fixture.service.clearProfile(PROFILE_A);
  assert.deepEqual(await observed, { status: "fulfilled", value: { streams: [] } });
  assert.equal(fixture.playbackContexts.records.length, 0);
  assert.equal(fixture.service._cache.size, 0);
  assert.equal(fixture.service._inFlight.size, 0);
  assert.equal(fixture.service._profileEpochs.size, 0);

  assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
  assert.equal(calls, 2, "cleared in-flight work repopulated the cache");
  assert.equal(fixture.playbackContexts.records.length, 1);
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.service._cache.size, 1, "late cleared fetch disturbed the current cache");
});

test("clearProfile makes a signal-ignoring late context write behaviorally unclaimable", async () => {
  const recordStarted = deferred();
  const releaseRecord = deferred();
  const firstRecordFinished = deferred();
  const store = new SourceContextStore();
  const playbackContexts = playbackContextAdapter(store, {
    async record(profileId, context, options) {
      recordStarted.resolve();
      await releaseRecord.promise;
      try {
        return store.record(profileId, context, options);
      } finally {
        firstRecordFinished.resolve();
      }
    },
  });
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_clear_record",
            0,
            descriptor("clear-record", "https://clear-record.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => ({ streams: [{ url: "https://media.example/clear-record" }] }),
    { playbackContexts }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  const pending = fixture.service.query(PROFILE_A, request);
  await recordStarted.promise;
  const observed = observeByImmediate(pending);
  await fixture.service.clearProfile(PROFILE_A);
  assert.deepEqual(await observed, { status: "fulfilled", value: { streams: [] } });
  releaseRecord.resolve();
  await firstRecordFinished.promise;
  assert.equal(
    claimSourceContext(store, PROFILE_A, "device_clear_record_01", {
      fingerprints: fingerprintStream({ url: "https://media.example/clear-record" }),
      intentUrlHash: hashOpaqueValue("clear-record-intent"),
      launchedAt: new Date().toISOString(),
    }).status,
    "not_found"
  );

  const fresh = fixture.service.query(PROFILE_A, request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await fresh, { streams: [{ url: "https://media.example/clear-record" }] });
  assert.equal(fixture.fetchPolicy.calls.length, 2);
});

test("queries entering during clearProfile wait for its generation transition and stay claimable", async () => {
  const invalidationStarted = deferred();
  const releaseInvalidation = deferred();
  const store = new SourceContextStore();
  let listCalls = 0;
  let recordCalls = 0;
  const playbackContexts = playbackContextAdapter(store, {
    async invalidateProfile(profileId) {
      invalidationStarted.resolve();
      await releaseInvalidation.promise;
      return store.invalidateProfile(profileId);
    },
    async record(profileId, context, options) {
      recordCalls += 1;
      return store.record(profileId, context, options);
    },
  });
  const provider = selection(
    "provider_clear_barrier",
    0,
    descriptor("clear-barrier", "https://clear-barrier.example/manifest.json", ["stream"])
  );
  const service = new ProviderGatewayService({
    providers: {
      async list() {
        listCalls += 1;
        return { revision: 1, providers: [provider] };
      },
    },
    playbackContexts,
    fetchPolicy: new FakeFetchPolicy(async () => ({
      streams: [{ url: "https://media.example/clear-barrier" }],
    })),
  });
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  const clearing = service.clearProfile(PROFILE_A);
  await invalidationStarted.promise;
  const query = service.query(PROFILE_A, request);
  assert.deepEqual(await observeByImmediate(query), { status: "pending" });
  assert.equal(listCalls, 0, "signal-ignoring provider work entered the old generation");
  assert.equal(recordCalls, 0, "a context write entered while invalidation was pending");

  releaseInvalidation.resolve();
  await clearing;
  const response = await query;
  assert.deepEqual(response, { streams: [{ url: "https://media.example/clear-barrier" }] });
  assert.equal(listCalls, 1);
  assert.equal(recordCalls, 1);
  const claim = claimSourceContext(store, PROFILE_A, "device_clear_barrier", {
    fingerprints: fingerprintStream(response.streams[0]),
    intentUrlHash: hashOpaqueValue("clear-barrier-intent"),
    launchedAt: new Date().toISOString(),
  });
  assert.equal(claim.status, "claimed", "the returned stream was invalidated before claim");
});

test("failed clearProfile invalidation keeps later queries fail closed until retry", async () => {
  const store = new SourceContextStore();
  let invalidations = 0;
  let listCalls = 0;
  const service = new ProviderGatewayService({
    providers: {
      async list() {
        listCalls += 1;
        return { revision: 1, providers: [] };
      },
    },
    playbackContexts: playbackContextAdapter(store, {
      async invalidateProfile(profileId) {
        invalidations += 1;
        if (invalidations === 1) throw new Error("invalidation unavailable");
        return store.invalidateProfile(profileId);
      },
      record: (profileId, context, options) => store.record(profileId, context, options),
    }),
    fetchPolicy: new FakeFetchPolicy(async () => ({ streams: [] })),
  });
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  await assert.rejects(service.clearProfile(PROFILE_A), /invalidation unavailable/);
  await assert.rejects(service.query(PROFILE_A, request), /invalidation unavailable/);
  assert.equal(listCalls, 0);
  await service.clearProfile(PROFILE_A);
  assert.deepEqual(await service.query(PROFILE_A, request), { streams: [] });
  assert.equal(listCalls, 1);
});

test("clearProfile drains concurrent stalled queries and removes every caller abort listener", async () => {
  const queryCount = 32;
  const allStarted = deferred();
  const stalled = deferred();
  let starts = 0;
  const service = new ProviderGatewayService({
    providers: {
      async list() {
        starts += 1;
        if (starts === queryCount) allStarted.resolve();
        return stalled.promise;
      },
    },
    playbackContexts: new FakePlaybackContexts(),
    fetchPolicy: new FakeFetchPolicy(async () => ({ streams: [] })),
  });
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };
  const controllers = Array.from({ length: queryCount }, listenerTrackedAbortController);
  const pending = controllers.map((controller) =>
    service.query(PROFILE_A, request, { signal: controller.signal })
  );
  await allStarted.promise;

  const observed = observeByImmediate(Promise.all(pending));
  await service.clearProfile(PROFILE_A);
  const outcome = await observed;
  assert.equal(outcome.status, "fulfilled");
  assert.deepEqual(
    outcome.value,
    Array.from({ length: queryCount }, () => ({ streams: [] }))
  );
  assert.equal(controllers.every((controller) => controller.listenerCount() === 0), true);
  stalled.resolve({ revision: 1, providers: [] });
});

test("breaker state cleans 321 stale revisions without disturbing another profile", async () => {
  let now = 2_000;
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 0,
        providers: [
          selection(
            "provider_revision_001",
            0,
            descriptor("revision", "https://revision.example/manifest.json", ["stream"])
          ),
        ],
      },
      [PROFILE_B]: {
        revision: 500,
        providers: [
          selection(
            "provider_stable_0001",
            0,
            descriptor("stable", "https://stable.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => {
      const error = new Error("timeout");
      error.code = "upstream_timeout";
      throw error;
    },
    {
      clock: () => now,
      cacheTtlMs: 1,
      failureThreshold: 1,
      breakerCooldownMs: 10_000,
    }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  await fixture.service.query(PROFILE_B, request);
  for (let revision = 0; revision <= 320; revision += 1) {
    fixture.providers.collections.get(PROFILE_A).revision = revision;
    await fixture.service.query(PROFILE_A, request);
  }

  assert.equal(fixture.service._breakers.size, 2);
  assert.equal(fixture.service._breakerProfiles.size, 2);
  assert.deepEqual(
    [...fixture.service._breakers.values()]
      .map((state) => state.revision)
      .sort((left, right) => left - right),
    [320, 500]
  );

  const callsBeforeBreakerChecks = fixture.fetchPolicy.calls.length;
  now += 2;
  await fixture.service.query(PROFILE_A, request);
  await fixture.service.query(PROFILE_B, request);
  assert.equal(fixture.fetchPolicy.calls.length, callsBeforeBreakerChecks);
});

test("late failures from a stale revision cannot recreate breaker state", async () => {
  let now = 2_500;
  let releaseOldRequest;
  let markOldRequestStarted;
  let calls = 0;
  const oldRequestStarted = new Promise((resolve) => {
    markOldRequestStarted = resolve;
  });
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_race_000001",
            0,
            descriptor("race", "https://race.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => {
          releaseOldRequest = resolve;
          markOldRequestStarted();
        });
        const error = new Error("late timeout");
        error.code = "upstream_timeout";
        throw error;
      }
      return { streams: [{ url: "https://media.example/current-revision" }] };
    },
    {
      clock: () => now,
      cacheTtlMs: 1,
      failureThreshold: 1,
      breakerCooldownMs: 10_000,
    }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  const staleQuery = fixture.service.query(PROFILE_A, request);
  await oldRequestStarted;
  fixture.providers.collections.get(PROFILE_A).revision = 2;
  assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
  releaseOldRequest();
  assert.deepEqual(await staleQuery, { streams: [] });
  assert.equal(fixture.service._breakers.size, 0);

  now += 2;
  assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
  assert.equal(calls, 3, "the current revision must remain admitted after the stale failure settles");
});

test("a stale provider-list completion cannot reactivate an older breaker revision", async () => {
  const firstList = deferred();
  const firstListStarted = deferred();
  let listCalls = 0;
  const provider = selection(
    "provider_list_revision",
    0,
    descriptor("list-revision", "https://list-revision.example/manifest.json", ["stream"])
  );
  const fetchPolicy = new FakeFetchPolicy(async (url) => ({
    streams: [{ url: "https://media.example/" + (url.includes("tt2000002") ? "new" : "old") }],
  }));
  const service = new ProviderGatewayService({
    providers: {
      async list() {
        listCalls += 1;
        if (listCalls === 1) {
          firstListStarted.resolve();
          return firstList.promise;
        }
        return { revision: 2, providers: [provider] };
      },
    },
    playbackContexts: new FakePlaybackContexts(),
    fetchPolicy,
  });

  const stale = service.query(PROFILE_A, {
    resource: "stream",
    type: "movie",
    id: "tt2000001",
    extra: [],
  });
  await firstListStarted.promise;
  const current = await service.query(PROFILE_A, {
    resource: "stream",
    type: "movie",
    id: "tt2000002",
    extra: [],
  });
  firstList.resolve({ revision: 1, providers: [provider] });

  assert.deepEqual(current, { streams: [{ url: "https://media.example/new" }] });
  assert.deepEqual(await stale, { streams: [] });
  assert.equal(fetchPolicy.calls.length, 1, "the stale provider list reached upstream admission");
});

test("breaker capacity uses deterministic LRU-style eviction", async () => {
  let now = 3_000;
  const collections = {};
  for (const [profileId, suffix] of [
    [PROFILE_A, "a"],
    [PROFILE_B, "b"],
    [PROFILE_C, "c"],
  ]) {
    collections[profileId] = {
      revision: 1,
      providers: [
        selection(
          "provider_lru_" + suffix.padEnd(8, "0"),
          0,
          descriptor("lru-" + suffix, "https://" + suffix + ".example/manifest.json", ["stream"])
        ),
      ],
    };
  }
  const fixture = serviceFixture(
    collections,
    async () => {
      const error = new Error("timeout");
      error.code = "upstream_timeout";
      throw error;
    },
    {
      clock: () => now,
      cacheTtlMs: 1,
      failureThreshold: 1,
      breakerCooldownMs: 10_000,
      maxBreakerEntries: 2,
    }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  await fixture.service.query(PROFILE_A, request);
  await fixture.service.query(PROFILE_B, request);
  now += 2;
  await fixture.service.query(PROFILE_A, request);
  await fixture.service.query(PROFILE_C, request);
  assert.equal(fixture.service._breakers.size, 2);
  assert.equal(fixture.service._breakerProfiles.size, 2);

  now += 2;
  await fixture.service.query(PROFILE_A, request);
  await fixture.service.query(PROFILE_B, request);
  const countCalls = (host) => fixture.fetchPolicy.calls.filter((call) => call.url.includes(host)).length;
  assert.equal(countCalls("a.example"), 1, "recently used A must remain open");
  assert.equal(countCalls("b.example"), 2, "least-recently-used B must be admitted after eviction");
  assert.equal(countCalls("c.example"), 1);
});

test("caller cancellation neither poisons cache nor advances provider breakers", async () => {
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_cancel_0001",
            0,
            descriptor("cancel", "https://cancel.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async (_url, options) => {
      if (options.signal && options.signal.aborted) {
        const error = new Error("aborted");
        error.code = "upstream_aborted";
        throw error;
      }
      return { streams: [{ url: "https://media.example/after-cancel" }] };
    },
    { failureThreshold: 1 }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    fixture.service.query(PROFILE_A, request, { signal: controller.signal }),
    (error) => error instanceof ProviderGatewayError && error.code === "gateway_aborted"
  );
  assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 1);
  assert.equal(fixture.fetchPolicy.calls.length, 1, "pre-aborted requests must stop before upstream admission");
  assert.equal(fixture.errors.length, 0);
});

test("caller abort returns promptly from stalled provider list, fetch, and record work", async (t) => {
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };
  const providerCollection = {
    revision: 1,
    providers: [
      selection(
        "provider_abort_stall",
        0,
        descriptor("abort-stall", "https://abort-stall.example/manifest.json", ["stream"])
      ),
    ],
  };
  const assertPromptAbort = async (pending, controller) => {
    const observed = observeByImmediate(pending);
    controller.abort();
    const outcome = await observed;
    assert.equal(outcome.status, "rejected", "abort waited for stalled external work");
    assert.ok(outcome.reason instanceof ProviderGatewayError);
    assert.equal(outcome.reason.code, "gateway_aborted");
  };

  await t.test("provider list", async () => {
    const started = deferred();
    const stalled = deferred();
    const service = new ProviderGatewayService({
      providers: {
        async list(_profileId, options) {
          started.resolve(options.signal);
          return stalled.promise;
        },
      },
      playbackContexts: new FakePlaybackContexts(),
      fetchPolicy: new FakeFetchPolicy(async () => ({ streams: [] })),
    });
    const controller = listenerTrackedAbortController();
    const pending = service.query(PROFILE_A, request, { signal: controller.signal });
    const operationSignal = await started.promise;

    await assertPromptAbort(pending, controller);
    assert.equal(operationSignal.aborted, true);
    assert.equal(controller.listenerCount(), 0);
  });

  await t.test("provider fetch", async () => {
    const started = deferred();
    const stalled = deferred();
    const fixture = serviceFixture(
      { [PROFILE_A]: providerCollection },
      async (_url, options) => {
        started.resolve(options.signal);
        return stalled.promise;
      }
    );
    const controller = listenerTrackedAbortController();
    const pending = fixture.service.query(PROFILE_A, request, { signal: controller.signal });
    const operationSignal = await started.promise;

    await assertPromptAbort(pending, controller);
    assert.equal(operationSignal.aborted, true);
    assert.equal(controller.listenerCount(), 0);
  });

  await t.test("context record", async () => {
    const started = deferred();
    const stalled = deferred();
    const playbackContexts = {
      async record(_profileId, _context, options) {
        started.resolve(options.signal);
        return stalled.promise;
      },
    };
    const fixture = serviceFixture(
      { [PROFILE_A]: providerCollection },
      async () => ({ streams: [{ url: "https://media.example/abort-record" }] }),
      { playbackContexts }
    );
    const controller = listenerTrackedAbortController();
    const pending = fixture.service.query(PROFILE_A, request, { signal: controller.signal });
    const operationSignal = await started.promise;

    await assertPromptAbort(pending, controller);
    assert.equal(operationSignal.aborted, true);
    assert.equal(controller.listenerCount(), 0);
  });
});

test("abort during context recording stops later writes and rejects the request", async () => {
  const controller = new AbortController();
  const records = [];
  const streams = [
    { url: "https://media.example/first" },
    { url: "https://media.example/second" },
    { url: "https://media.example/third" },
  ];
  const playbackContexts = {
    async record(profileId, context) {
      records.push({ profileId, context: clone(context) });
      if (records.length === 1) controller.abort();
      return context;
    },
  };
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_record_0001",
            0,
            descriptor("record", "https://record.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => ({ streams }),
    { playbackContexts }
  );
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };

  await assert.rejects(
    fixture.service.query(PROFILE_A, request, { signal: controller.signal }),
    (error) => error instanceof ProviderGatewayError && error.code === "gateway_aborted"
  );
  assert.equal(records.length, 1, "no context write may start after cancellation is observed");
  assert.equal(fixture.errors.length, 0, "caller cancellation is not a context persistence failure");

  assert.deepEqual(await fixture.service.query(PROFILE_A, request), { streams });
  assert.equal(records.length, 4);
  assert.equal(fixture.fetchPolicy.calls.length, 2, "an aborted query must not populate the cache");
});

test("provider concurrency is shared across same-profile queries and preserves provider order", async () => {
  const providers = [
    selection(
      "provider_shared_a",
      0,
      descriptor("shared-a", "https://shared-a.example/manifest.json", ["stream"])
    ),
    selection(
      "provider_shared_b",
      1,
      descriptor("shared-b", "https://shared-b.example/manifest.json", ["stream"])
    ),
  ];
  const firstWave = deferred();
  let active = 0;
  let peak = 0;
  let calls = 0;
  const fixture = serviceFixture(
    { [PROFILE_A]: { revision: 1, providers } },
    async (url) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) firstWave.resolve();
      await firstWave.promise;
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      const providerId = url.includes("shared-a") ? "a" : "b";
      const requestId = url.includes("tt3000001") ? "one" : "two";
      return {
        streams: [{ name: providerId, url: "https://media.example/" + requestId + "/" + providerId }],
      };
    },
    { maxProviderConcurrency: 2 }
  );

  const responses = await Promise.all([
    fixture.service.query(PROFILE_A, {
      resource: "stream",
      type: "movie",
      id: "tt3000001",
      extra: [],
    }),
    fixture.service.query(PROFILE_A, {
      resource: "stream",
      type: "movie",
      id: "tt3000002",
      extra: [],
    }),
  ]);

  assert.equal(calls, 4);
  assert.equal(peak, 2);
  assert.deepEqual(responses.map((response) => response.streams.map((stream) => stream.name)), [
    ["a", "b"],
    ["a", "b"],
  ]);
});

test("aborting one same-profile query removes its queued provider work and listeners", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const fetchedUrls = [];
  const providers = [
    selection(
      "provider_queue_a",
      0,
      descriptor("queue-a", "https://queue-a.example/manifest.json", ["stream"])
    ),
    selection(
      "provider_queue_b",
      1,
      descriptor("queue-b", "https://queue-b.example/manifest.json", ["stream"])
    ),
  ];
  const fixture = serviceFixture(
    { [PROFILE_A]: { revision: 1, providers } },
    async (url) => {
      fetchedUrls.push(url);
      if (url.includes("tt3100001") && url.includes("queue-a")) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      const providerId = url.includes("queue-a") ? "a" : "b";
      return { streams: [{ url: "https://media.example/queue/" + providerId }] };
    },
    { maxProviderConcurrency: 1, maxProviderQueueEntries: 8 }
  );
  const first = fixture.service.query(PROFILE_A, {
    resource: "stream",
    type: "movie",
    id: "tt3100001",
    extra: [],
  });
  await firstStarted.promise;

  const controller = listenerTrackedAbortController();
  const canceled = fixture.service.query(
    PROFILE_A,
    { resource: "stream", type: "movie", id: "tt3100002", extra: [] },
    { signal: controller.signal }
  );
  await new Promise((resolve) => setImmediate(resolve));
  const observed = observeByImmediate(canceled);
  controller.abort();
  const canceledResult = await observed;
  assert.equal(canceledResult.status, "rejected");
  assert.equal(canceledResult.reason.code, "gateway_aborted");
  assert.equal(controller.listenerCount(), 0);

  releaseFirst.resolve();
  assert.equal((await first).streams.length, 2);
  assert.equal(fetchedUrls.some((url) => url.includes("tt3100002")), false);
});

test("a signal-ignoring aborted fetch retains its shared concurrency slot until settlement", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const fetchedUrls = [];
  const provider = selection(
    "provider_physical_slot",
    0,
    descriptor("physical-slot", "https://physical-slot.example/manifest.json", ["stream"])
  );
  const fixture = serviceFixture(
    { [PROFILE_A]: { revision: 1, providers: [provider] } },
    async (url) => {
      fetchedUrls.push(url);
      if (url.includes("tt3150001")) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { streams: [{ url: "https://media.example/physical-slot" }] };
    },
    { maxProviderConcurrency: 1 }
  );
  const controller = listenerTrackedAbortController();
  const first = fixture.service.query(
    PROFILE_A,
    { resource: "stream", type: "movie", id: "tt3150001", extra: [] },
    { signal: controller.signal }
  );
  await firstStarted.promise;
  const observed = observeByImmediate(first);
  controller.abort();
  assert.equal((await observed).status, "rejected");
  assert.equal(controller.listenerCount(), 0);

  const second = fixture.service.query(PROFILE_A, {
    resource: "stream",
    type: "movie",
    id: "tt3150002",
    extra: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchedUrls.length, 1, "abort released a still-running physical fetch slot");
  releaseFirst.resolve();
  assert.equal((await second).streams.length, 1);
  assert.equal(fetchedUrls.length, 2);
});

test("concurrent overlapping gateway results expose only one claimable stream", async () => {
  const store = new SourceContextStore();
  const bothFetched = deferred();
  let fetches = 0;
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_overlap_gateway",
            0,
            descriptor("overlap-gateway", "https://overlap-gateway.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async () => {
      fetches += 1;
      if (fetches === 2) bothFetched.resolve();
      await bothFetched.promise;
      return { streams: [{ url: "https://media.example/shared-overlap" }] };
    },
    { playbackContexts: store, maxProviderConcurrency: 2 }
  );
  const launchedAt = new Date().toISOString();
  const requests = ["tt3200001", "tt3200002"].map((id) => ({
    resource: "stream",
    type: "movie",
    id,
    extra: [],
  }));
  const responses = await Promise.all(requests.map((request) => fixture.service.query(PROFILE_A, request)));
  assert.deepEqual(responses.map((response) => response.streams.length).sort(), [0, 1]);

  const winner = responses.find((response) => response.streams.length === 1).streams[0];
  const loserIndex = responses.findIndex((response) => response.streams.length === 0);
  const claimInput = {
    fingerprints: fingerprintStream(winner),
    intentUrlHash: hashOpaqueValue("overlap-intent"),
    launchedAt,
  };
  const firstClaim = claimSourceContext(store, PROFILE_A, "device_overlap_gateway", claimInput);
  assert.equal(firstClaim.status, "claimed");
  assert.deepEqual(
    claimSourceContext(store, PROFILE_A, "device_overlap_gateway", claimInput),
    firstClaim,
    "an identical retry must retain the accepted context"
  );
  assert.deepEqual(await fixture.service.query(PROFILE_A, requests[loserIndex]), { streams: [] });
});

test("provider processing stops traversing later results at aggregate item and byte bounds", async (t) => {
  const providers = [
    selection(
      "provider_bound_first",
      0,
      descriptor("bound-first", "https://bound-first.example/manifest.json", ["stream"])
    ),
    selection(
      "provider_bound_later",
      1,
      descriptor("bound-later", "https://bound-later.example/manifest.json", ["stream"])
    ),
  ];
  const explosive = () => {
    const item = { url: "https://media.example/not-retained" };
    Object.defineProperty(item, "token", {
      enumerable: true,
      get() {
        throw new Error("later provider item was traversed");
      },
    });
    return item;
  };

  await t.test("items", async () => {
    let calls = 0;
    const fixture = serviceFixture(
      { [PROFILE_A]: { revision: 1, providers } },
      async (url) => {
        calls += 1;
        return url.includes("bound-first")
          ? { streams: [{ url: "https://media.example/item-1" }, { url: "https://media.example/item-2" }] }
          : { streams: [explosive()] };
      },
      { maxAggregateItems: 2 }
    );
    const request = { resource: "stream", type: "movie", id: "tt3300001", extra: [] };
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 2);
    assert.equal((await fixture.service.query(PROFILE_A, request)).streams.length, 2);
    assert.equal(calls, 2, "a bounded result was not cached");
    assert.equal(fixture.errors.length, 0);
  });

  await t.test("bytes", async () => {
    const retained = { url: "https://media.example/byte-budget" };
    const maxAggregateBytes = 2 + Buffer.byteLength(JSON.stringify(retained), "utf8") + 1;
    let calls = 0;
    const fixture = serviceFixture(
      { [PROFILE_A]: { revision: 2, providers } },
      async (url) => {
        calls += 1;
        return url.includes("bound-first") ? { streams: [retained] } : { streams: [explosive()] };
      },
      { maxAggregateBytes, maxAggregateItems: 8 }
    );
    const request = { resource: "stream", type: "movie", id: "tt3300002", extra: [] };
    assert.deepEqual((await fixture.service.query(PROFILE_A, request)).streams, [retained]);
    assert.deepEqual((await fixture.service.query(PROFILE_A, request)).streams, [retained]);
    assert.equal(calls, 2, "a byte-bounded result was not cached");
    assert.equal(fixture.errors.length, 0);
  });
});

test("aggregate item limits are deterministic and never reorder providers", async () => {
  const fixture = serviceFixture(
    {
      [PROFILE_A]: {
        revision: 1,
        providers: [
          selection(
            "provider_many_a_0001",
            0,
            descriptor("many-a", "https://many-a.example/manifest.json", ["stream"])
          ),
          selection(
            "provider_many_b_0002",
            1,
            descriptor("many-b", "https://many-b.example/manifest.json", ["stream"])
          ),
        ],
      },
    },
    async (url) => ({
      streams: url.includes("many-a")
        ? [{ url: "https://media.example/a1" }, { url: "https://media.example/a2" }]
        : [{ url: "https://media.example/b1" }],
    }),
    { maxAggregateItems: 2 }
  );

  assert.deepEqual(
    await fixture.service.query(PROFILE_A, {
      resource: "stream",
      type: "movie",
      id: "tt1234567",
      extra: [],
    }),
    {
      streams: [{ url: "https://media.example/a1" }, { url: "https://media.example/a2" }],
    }
  );
});

test("stream retention limit keeps every returned source claimable and scales coherently", async () => {
  const streams = Array.from({ length: 129 }, (_value, index) => ({
    url: "https://media.example/claimable/" + index,
  }));
  const request = { resource: "stream", type: "movie", id: "tt1234567", extra: [] };
  const providers = new FakeProviderRepository({
    [PROFILE_A]: {
      revision: 1,
      providers: [
        selection(
          "provider_claimable_01",
          0,
          descriptor("claimable", "https://claimable.example/manifest.json", ["stream"])
        ),
      ],
    },
  });
  const createService = (maxContextsPerProfile, options = {}) => {
    const store = new SourceContextStore({ maxContextsPerProfile });
    const service = new ProviderGatewayService({
      providers,
      playbackContexts: generationAware({
        async record(profileId, context) {
          return store.record(profileId, context);
        },
      }),
      fetchPolicy: new FakeFetchPolicy(async () => ({ streams })),
      ...options,
    });
    return { service, store };
  };

  const bounded = createService(128);
  const response = await bounded.service.query(PROFILE_A, request);
  assert.equal(response.streams.length, 128);
  assert.equal(bounded.store.getStats().contexts, 128);
  const launchedAt = new Date().toISOString();
  for (let index = 0; index < response.streams.length; index += 1) {
    const claim = claimSourceContext(
      bounded.store,
      PROFILE_A,
      "device_claim_" + String(index).padStart(4, "0"),
      {
        fingerprints: fingerprintStream(response.streams[index]),
        intentUrlHash: "a".repeat(64),
        launchedAt,
      }
    );
    assert.equal(claim.status, "claimed", "returned stream " + index + " lost its context");
  }

  assert.throws(
    () => createService(128, { maxAggregateItems: 129 }),
    /maxStreamItems cannot exceed maxContextsPerProfile/
  );
  assert.throws(
    () => createService(128, { maxStreamItems: 129 }),
    /maxStreamItems cannot exceed maxContextsPerProfile/
  );
  const expanded = createService(129, {
    maxContextsPerProfile: 129,
    maxStreamItems: 129,
  });
  const expandedResponse = await expanded.service.query(PROFILE_A, request);
  assert.equal(expandedResponse.streams.length, 129);
  assert.equal(expanded.store.getStats().contexts, 129);
  for (const index of [0, 128]) {
    assert.equal(
      claimSourceContext(
        expanded.store,
        PROFILE_A,
        "device_expand_" + String(index).padStart(4, "0"),
        {
          fingerprints: fingerprintStream(expandedResponse.streams[index]),
          intentUrlHash: "b".repeat(64),
          launchedAt: new Date().toISOString(),
        }
      ).status,
      "claimed"
    );
  }
});

test("invalid resources and source identity helpers fail closed", async () => {
  const { service } = serviceFixture({}, async () => ({}));
  await assert.rejects(
    service.query(PROFILE_A, { resource: "meta", type: "movie", id: "tt1234567", extra: [] }),
    (error) => error instanceof ProviderGatewayError && error.code === "unsupported_resource"
  );
  await assert.rejects(
    service.query(
      PROFILE_A,
      { resource: "stream", type: "movie", id: "tt1234567", extra: [] },
      { signal: { aborted: false } }
    ),
    /gateway query signal is invalid/
  );
  assert.equal(service._profileEpochs.size, 0);
  assert.deepEqual(buildPlaybackIdentity({ type: "series", id: "tt1234567:2:3" }), {
    contentKey: buildPlaybackIdentity({ type: "series", id: "tt1234567:2:3" }).contentKey,
    canonicalIdentity: {
      provider: "imdb",
      id: "tt1234567",
      mediaType: "episode",
      season: 2,
      episode: 3,
      provenance: "metadata-request",
      confidence: "canonical",
    },
    traktEligible: true,
    season: 2,
    episode: 3,
  });
  assert.equal(sourceKind({ url: "x", infoHash: "a".repeat(40) }), "url");
  assert.equal(sourceKind({ playerFrameUrl: "x", externalUrl: "y" }), "player-frame");
});
