"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  SourceContextStore,
  fingerprintExactUrl,
  hashOpaqueValue,
} = require("../lib/source-context");
const { SubtitleDeletionWorker } = require("../lib/subtitle-deletion-worker");
const {
  BUSY_RETRY_AFTER_SECONDS,
  SubtitleDeliveryService,
} = require("../lib/subtitle-delivery-service");
const {
  normalizeSubtitleSourceCapability,
  SubtitleSource,
} = require("../lib/subtitle-source");
const { MemorySubtitleDeliveryRepository } = require("../lib/storage/memory-subtitle-delivery-repository");
const {
  MemorySubtitleManifestRepository,
} = require("../lib/storage/memory-subtitle-manifest-repository");
const { MemorySubtitleObjectStore } = require("../lib/storage/memory-subtitle-object-store");
const { ProfileLifecycleCoordinator } = require("../lib/storage/lifecycle-invalidation");
const { OpaqueObjectKeyFactory, assertObjectStore } = require("../lib/storage/object-store");
const { TokenService } = require("../lib/storage/token-service");

const PROFILE = "profile_service_subtitles";
const DEVICE = "device_service_subtitles";

function deterministicBytes(seed = 1) {
  let value = seed;
  return (length) => {
    const output = Buffer.alloc(length, value);
    value = value === 255 ? 1 : value + 1;
    return output;
  };
}

function playbackContext(url) {
  return {
    contentKey: hashOpaqueValue("movie:subtitle-service"),
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
      metaProvider: "imdb",
      streamProvider: "provider-service",
    },
    display: { title: "The Matrix", year: 1999 },
    source: { type: "url", provider: "provider-service", url },
    fingerprints: [fingerprintExactUrl(url)],
    inlineSubtitles: [],
  };
}

async function createHarness(options = {}) {
  let now = 1000;
  let contextSequence = 0;
  let artifactSequence = 0;
  const tokenService = new TokenService({
    pepper: Buffer.alloc(32, 0x35),
    randomBytes: deterministicBytes(1),
  });
  const objectKeyFactory = new OpaqueObjectKeyFactory({
    currentKeyId: "service-test",
    keyring: [{ id: "service-test", secret: Buffer.alloc(32, 0x46) }],
    prefix: "subtitles/v1",
  });
  const sourceContextStore = new SourceContextStore({
    clock: () => now,
    idFactory: (kind) => kind + "_service_" + String(++contextSequence).padStart(8, "0"),
    ttlMs: 10_000,
    tombstoneTtlMs: 10_000,
  });
  const mediaUrl = "https://media.example/service.mkv";
  const recorded = sourceContextStore.record(PROFILE, playbackContext(mediaUrl));
  const claimRequest = {
    attemptId: "00000000-0000-4000-8000-000000000101",
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(mediaUrl),
    launchedAt: now,
  };
  const claim = sourceContextStore.claim(PROFILE, DEVICE, claimRequest, {
    generation: sourceContextStore.getProfileGeneration(PROFILE),
    deviceGeneration: 1,
    sessionId: "session_service_subtitles_0001",
    requestDigest: hashOpaqueValue(JSON.stringify(claimRequest)),
  });
  const binding = {
    ...sourceContextStore.getActiveClaim(PROFILE, DEVICE, claim.sessionId).deliveryBinding,
    profileRevision: 1,
    deviceGeneration: 1,
  };
  const repository = new MemorySubtitleDeliveryRepository({
    tokenService,
    objectKeyFactory,
    sourceContextStore,
    clock: () => now,
    idFactory: () => "artifact_service_" + String(++artifactSequence).padStart(8, "0"),
    logicalTtlMs: 1000,
    absoluteTtlMs: 5000,
    fetchLeaseTtlMs: 10,
    uploadLeaseTtlMs: 10,
    maxPutLifetimeMs: 10,
    uploadSettlementGraceMs: 5,
    ioLeaseTtlMs: 10,
    deletionLeaseTtlMs: 10,
    maxDeletionRetryMs: 100,
    ...(options.repositoryOptions || {}),
  });
  await repository.reconcileAuthority({
    profileId: PROFILE,
    providerRevision: binding.providerRevision,
    generation: binding.generation,
  });
  const objectStore = new MemorySubtitleObjectStore({ objectKeyFactory });
  const manifests = new MemorySubtitleManifestRepository({
    tokenService,
    clock: () => now,
    lifecycleCoordinator: new ProfileLifecycleCoordinator(),
    getProfileBinding: async (profileId) =>
      profileId === PROFILE ? { id: PROFILE, status: "active", revision: 1 } : null,
    isDeviceBindingActive: (profileId, deviceId, generation) =>
      profileId === PROFILE && deviceId === DEVICE && generation === 1,
  });
  const source = options.source || {
    async fetch() {
      return {
        normalized: {
          type: "text",
          format: "srt",
          extension: ".srt",
          mediaType: "application/x-subrip",
          data: Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nJumpgate\n"),
        },
      };
    },
  };
  const service = new SubtitleDeliveryService({
    repository,
    objectStore: options.serviceObjectStore || objectStore,
    source,
    tokenService,
    manifests,
    clock: () => now,
  });
  return {
    repository,
    objectStore,
    service,
    source,
    tokenService,
    manifests,
    binding,
    now: () => now,
    advance(milliseconds) { now += milliseconds; },
  };
}

test("delivery durably reserves opaque manifests before S3 and commits after Redis", async () => {
  const h = await createHarness();
  const events = [];
  let reservedInput = null;
  const manifests = new Proxy(h.manifests, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "reserve") {
        return async (input) => {
          events.push("manifest.reserve");
          reservedInput = input;
          return value.call(target, input);
        };
      }
      if (property === "commit") {
        return async (input) => {
          events.push("manifest.commit");
          return value.call(target, input);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const repository = new Proxy(h.repository, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "commit") {
        return async (input) => {
          events.push("redis.commit");
          return value.call(target, input);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const objectStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: async (...args) => {
      events.push("s3.put");
      return h.objectStore.put(...args);
    },
    head: (...args) => h.objectStore.head(...args),
    get: (...args) => h.objectStore.get(...args),
    delete: (...args) => h.objectStore.delete(...args),
  });
  const service = new SubtitleDeliveryService({
    repository,
    manifests,
    objectStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });

  assert.equal((await service.resolve(h.binding, resolution(91))).status, "ready");
  assert.deepEqual(events, ["manifest.reserve", "s3.put", "redis.commit", "manifest.commit"]);
  assert.equal(reservedInput.profileRevision, 1);
  assert.equal(reservedInput.deviceGeneration, 1);
  assert.equal(reservedInput.playbackGeneration, h.binding.generation);
  assert.equal(JSON.stringify(reservedInput).includes("subs.example"), false);
  assert.equal(JSON.stringify(reservedInput).includes("provider-secret"), false);
});

test("a blackholed S3 PUT aborts at the absolute deadline and retains cleanup state", async () => {
  const h = await createHarness();
  let uploadSignal = null;
  let uploadBody = null;
  const blackholedStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: async (_key, body, options) => {
      uploadBody = body;
      uploadSignal = options.signal;
      return new Promise(() => {});
    },
    head: (...args) => h.objectStore.head(...args),
    get: (...args) => h.objectStore.get(...args),
    delete: (...args) => h.objectStore.delete(...args),
  });
  const service = new SubtitleDeliveryService({
    repository: h.repository,
    manifests: h.manifests,
    objectStore: blackholedStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });

  const outcome = await Promise.race([
    service.resolve(h.binding, resolution(92)).then(
      () => ({ status: "resolved" }),
      (error) => ({ status: "rejected", error })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: "outer_timeout" }), 100)),
  ]);
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.code, "subtitle_upload_timeout");
  assert.equal(uploadSignal.aborted, true);
  assert.ok(uploadBody.every((byte) => byte === 0));
  const [manifest] = await h.manifests.listProfile(PROFILE);
  assert.equal(manifest.state, "deletion_requested");
  assert.ok(manifest.nextAttemptAt > h.now());
});

function resolution(number = 1) {
  return {
    discoveryKey: "subtitle-service-" + number,
    sourceCapability: {
      url: "https://subs.example/subtitle-" + number + ".srt?token=private-" + number,
      headers: { Authorization: "Bearer provider-secret", "X-Provider": "service" },
    },
  };
}

test("subtitle source uses the pinned fetch policy and normalizes bounded provider bytes", async () => {
  const calls = [];
  const sourceBodies = [];
  const source = new SubtitleSource({
    fetchPolicy: {
      async fetchBuffer(url, options) {
        calls.push({ url, options });
        const body = Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nSource\n");
        sourceBodies.push(body);
        return {
          body,
          contentType: "application/x-subrip",
          charset: "utf-8",
          redirects: 1,
          status: 200,
        };
      },
    },
  });
  const result = await source.fetch({
    v: 1,
    url: "https://subs.example/movie.srt?token=secret",
    headers: { Authorization: "Bearer secret", "X-Provider": "test" },
  }, { admissionScope: PROFILE });
  assert.equal(result.normalized.type, "text");
  assert.equal(result.normalized.format, "srt");
  assert.match(result.normalized.data.toString(), /Source/);
  assert.ok(sourceBodies[0].every((byte) => byte === 0));
  assert.equal(result.redirects, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.allowedHeaderNames, ["authorization", "x-provider"]);
  assert.equal(calls[0].options.admissionKey.includes(PROFILE), false);
  await assert.rejects(
    source.fetch({ url: "http://127.0.0.1/subtitle.srt", headers: {} }, { admissionScope: PROFILE }),
    /capability url/
  );
  assert.throws(
    () => normalizeSubtitleSourceCapability({
      v: 1,
      resources: [
        { role: "index", url: "https://subs.example/movie.idx" },
        { role: "sub", url: "https://subs.example/movie.sub" },
      ],
    }),
    /supports exactly one URL resource/
  );
});

test("subtitle source publishes stable non-oracular source and payload failures", async () => {
  const unavailable = new SubtitleSource({
    fetchPolicy: {
      async fetchBuffer() {
        throw Object.assign(new Error("https://secret.example/source?token=private"), {
          code: "upstream_fetch_failed",
        });
      },
    },
  });
  await assert.rejects(
    unavailable.fetch(
      { url: "https://subs.example/source.srt" },
      { admissionScope: PROFILE }
    ),
    (error) =>
      error.code === "subtitle_source_unavailable" &&
      error.statusCode === 502 &&
      !error.message.includes("secret.example")
  );

  let rejectedBody;
  const rejected = new SubtitleSource({
    fetchPolicy: {
      async fetchBuffer() {
        rejectedBody = Buffer.from("provider-payload-secret");
        return { body: rejectedBody, contentType: "application/x-subrip", status: 200 };
      },
    },
    async normalize() {
      throw Object.assign(new Error("payload detail secret"), { code: "subtitle_text_invalid" });
    },
  });
  await assert.rejects(
    rejected.fetch(
      { url: "https://subs.example/source.srt" },
      { admissionScope: PROFILE }
    ),
    (error) =>
      error.code === "subtitle_payload_rejected" &&
      error.statusCode === 422 &&
      !error.message.includes("detail secret")
  );
  assert.ok(rejectedBody.every((byte) => byte === 0));
});

test("delivery service maps concurrent preparation to a bounded retryable busy class", async () => {
  const h = await createHarness();
  const repository = new Proxy(h.repository, {
    get(target, property) {
      if (property === "beginFetch") {
        return async () => {
          throw Object.assign(new Error("private fetch owner"), { code: "subtitle_fetch_busy" });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new SubtitleDeliveryService({
    repository,
    manifests: h.manifests,
    objectStore: h.objectStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });

  await assert.rejects(
    service.resolve(h.binding, resolution(71)),
    (error) =>
      error.code === "subtitle_delivery_busy" &&
      error.statusCode === 409 &&
      error.retryAfterSeconds === BUSY_RETRY_AFTER_SECONDS &&
      !error.message.includes("owner")
  );
  assert.equal(BUSY_RETRY_AFTER_SECONDS, 1);
});

test("delivery service resolves opaque text objects and revalidates exact reads", async () => {
  const h = await createHarness();
  const ready = await h.service.resolve(h.binding, resolution());
  assert.equal(ready.status, "ready");
  assert.equal(ready.parts.length, 1);
  assert.equal(ready.parts[0].role, "subtitle");
  const serialized = JSON.stringify(ready);
  assert.equal(serialized.includes("subs.example"), false);
  assert.equal(serialized.includes("objectKey"), false);
  assert.equal(serialized.includes("provider-secret"), false);

  const fetched = await h.service.read(h.binding, ready.artifactId, 1, { method: "GET" });
  assert.match(fetched.body.toString("utf8"), /Jumpgate/);
  assert.equal(fetched.mediaType, "application/x-subrip");
  const head = await h.service.read(h.binding, ready.artifactId, 1, { method: "HEAD" });
  assert.equal(Object.hasOwn(head, "body"), false);
  assert.equal(await h.service.read({ ...h.binding, deviceId: "wrong-device" }, ready.artifactId, 1), null);

  assert.equal(await h.repository.invalidateSession(PROFILE, h.binding.sessionId), 1);
  h.advance(25);
  const worker = new SubtitleDeletionWorker({
    repository: h.repository,
    objectStore: h.objectStore,
    workerId: "worker_service_0001",
    retryDelayMs: 5,
  });
  assert.equal((await worker.runOnce()).status, "awaiting_second_pass");
  h.advance(5);
  assert.equal((await worker.runOnce()).status, "confirmed");
  assert.equal(await h.service.read(h.binding, ready.artifactId, 1), null);
});

test("delivery service commits through the v3 upload receipt contract", async () => {
  const h = await createHarness();
  let commitInput = null;
  const repository = new Proxy(h.repository, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "commit") {
        return async (input) => {
          commitInput = input;
          return value.call(target, input);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new SubtitleDeliveryService({
    repository,
    manifests: h.manifests,
    objectStore: h.objectStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });

  assert.equal((await service.resolve(h.binding, resolution(3))).status, "ready");
  assert.ok(commitInput);
  assert.equal(Object.hasOwn(commitInput, "parts"), false);
  assert.equal(Array.isArray(commitInput.receipts), true);
  assert.equal(commitInput.receipts.length, 1);
  assert.deepEqual(
    Object.keys(commitInput.receipts[0]).sort(),
    ["checksum", "mediaType", "objectKey", "partNumber", "sizeBytes"]
  );
});

test("delivery service clears transient upload buffers after durable storage settles", async () => {
  const h = await createHarness();
  const transient = [];
  const objectStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: async (key, body, options) => {
      transient.push(body);
      return h.objectStore.put(key, body, options);
    },
    head: (...args) => h.objectStore.head(...args),
    get: (...args) => h.objectStore.get(...args),
    delete: (...args) => h.objectStore.delete(...args),
  });
  const service = new SubtitleDeliveryService({
    repository: h.repository,
    manifests: h.manifests,
    objectStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });

  const ready = await service.resolve(h.binding, resolution(8));
  assert.equal(transient.length, 1);
  assert.ok(transient[0].every((byte) => byte === 0));
  assert.match(
    (await service.read(h.binding, ready.artifactId, 1)).body.toString("utf8"),
    /Jumpgate/
  );
});

test("delivery service clears source-owned originals on success and normalization failure", async () => {
  const successOriginal = Buffer.from("source-owned-success");
  const success = await createHarness({
    source: {
      async fetch() {
        return {
          normalized: {
            type: "text",
            format: "srt",
            extension: ".srt",
            mediaType: "application/x-subrip",
            data: successOriginal,
          },
        };
      },
    },
  });
  assert.equal((await success.service.resolve(success.binding, resolution(31))).status, "ready");
  assert.ok(successOriginal.every((byte) => byte === 0));

  const failureOriginal = Buffer.from("source-owned-failure");
  const failure = await createHarness({
    source: {
      async fetch() {
        return {
          normalized: {
            type: "text",
            format: "srt",
            extension: ".exe",
            mediaType: "application/octet-stream",
            data: failureOriginal,
          },
        };
      },
    },
  });
  await assert.rejects(
    failure.service.resolve(failure.binding, resolution(32)),
    (error) => error.code === "subtitle_payload_rejected" && error.statusCode === 422
  );
  assert.ok(failureOriginal.every((byte) => byte === 0));
});

test("delivery service reuses a committed discovery without refetching", async () => {
  let fetches = 0;
  const h = await createHarness({
    source: {
      async fetch() {
        fetches += 1;
        return {
          normalized: {
            type: "text",
            format: "vtt",
            extension: ".vtt",
            mediaType: "text/vtt",
            data: Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nCommitted replay\n"),
          },
        };
      },
    },
  });
  const first = await h.service.resolve(h.binding, resolution(4));
  const replay = await h.service.resolve(h.binding, resolution(4));

  assert.equal(fetches, 1);
  assert.equal(replay.status, "ready");
  assert.equal(replay.artifactId, first.artifactId);
  assert.deepEqual(replay.parts, first.parts);
});

test("delivery service supports canonical two-file VobSub without leaking storage keys", async () => {
  const h = await createHarness({
    source: {
      async fetch() {
        return {
          normalized: {
            type: "vobsub",
            format: "vobsub",
            files: [
              {
                role: "index",
                extension: ".idx",
                mediaType: "application/x-vobsub",
                data: Buffer.from("# VobSub index file, v7\nsize: 720x480\n"),
              },
              {
                role: "sub",
                extension: ".sub",
                mediaType: "application/octet-stream",
                data: Buffer.from([0, 0, 1, 0xba, 1, 2, 3, 4]),
              },
            ],
          },
        };
      },
    },
  });
  const ready = await h.service.resolve(h.binding, resolution(2));
  assert.deepEqual(ready.parts.map((part) => part.role), ["index", "sub"]);
  assert.equal(JSON.stringify(ready).includes("subtitles/v1"), false);
  assert.match((await h.service.read(h.binding, ready.artifactId, 1)).body.toString(), /VobSub/);
  assert.deepEqual(
    [...(await h.service.read(h.binding, ready.artifactId, 2)).body],
    [0, 0, 1, 0xba, 1, 2, 3, 4]
  );
});

test("pre-stage source failures release the reservation for an immediate retry", async () => {
  let fail = true;
  const source = {
    async fetch() {
      if (fail) throw Object.assign(new Error("upstream failed"), { code: "upstream_fetch_failed" });
      return {
        normalized: {
          type: "text",
          format: "vtt",
          extension: ".vtt",
          mediaType: "text/vtt",
          data: Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nRetry\n"),
        },
      };
    },
  };
  const h = await createHarness({
    source,
    repositoryOptions: {
      maxProfileArtifacts: 1,
      maxProfileObjects: 2,
      maxProfileBytes: 1000,
      maxArtifactBytes: 1000,
    },
  });
  await assert.rejects(
    h.service.resolve(h.binding, resolution()),
    (error) => error.code === "subtitle_source_unavailable" && error.statusCode === 502
  );
  fail = false;
  assert.equal((await h.service.resolve(h.binding, resolution())).status, "ready");
});

test("duplicate reserved source failures release the replacement ownership and quota", async () => {
  let fail = true;
  const h = await createHarness({
    source: {
      async fetch() {
        if (fail) throw Object.assign(new Error("upstream failed"), { code: "upstream_fetch_failed" });
        return {
          normalized: {
            type: "text",
            format: "srt",
            extension: ".srt",
            mediaType: "application/x-subrip",
            data: Buffer.from("replacement ownership retry"),
          },
        };
      },
    },
    repositoryOptions: {
      maxProfileArtifacts: 1,
      maxProfileObjects: 2,
      maxProfileBytes: 1000,
      maxArtifactBytes: 1000,
    },
  });
  const original = await h.repository.reserve({
    ...h.binding,
    ...resolution(),
  });
  assert.equal(original.status, "reserved");
  await assert.rejects(
    h.service.resolve(h.binding, resolution()),
    (error) => error.code === "subtitle_source_unavailable" && error.statusCode === 502
  );
  fail = false;
  assert.equal((await h.service.resolve(h.binding, resolution(2))).status, "ready");
});

test("the exact fetch owner cancels atomically after duplicate ownership rotates", async () => {
  let fail = true;
  const h = await createHarness({
    source: {
      async fetch() {
        if (fail) throw Object.assign(new Error("upstream failed"), { code: "upstream_fetch_failed" });
        return {
          normalized: {
            type: "text",
            format: "srt",
            extension: ".srt",
            mediaType: "application/x-subrip",
            data: Buffer.from("fetch owner retry"),
          },
        };
      },
    },
    repositoryOptions: {
      maxProfileArtifacts: 1,
      maxProfileObjects: 2,
      maxProfileBytes: 1000,
      maxArtifactBytes: 1000,
    },
  });
  const staleOwner = await h.repository.reserve({ ...h.binding, ...resolution() });
  const replacement = await h.repository.reserve({ ...h.binding, ...resolution() });
  assert.notEqual(staleOwner.reservationToken, replacement.reservationToken);
  const repository = new Proxy(h.repository, {
    get(target, property) {
      if (property === "reserve") return async () => staleOwner;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new SubtitleDeliveryService({
    repository,
    manifests: h.manifests,
    objectStore: h.objectStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });
  await assert.rejects(
    service.resolve(h.binding, resolution()),
    (error) => error.code === "subtitle_source_unavailable" && error.statusCode === 502
  );
  fail = false;
  assert.equal((await h.service.resolve(h.binding, resolution(2))).status, "ready");
});

test("fetch cleanup preserves both cancellation and release failures", async () => {
  const sourceFailure = Object.assign(new Error("upstream failed"), {
    code: "upstream_fetch_failed",
  });
  const releaseFailure = new Error("fetch release failed");
  const cancellationFailure = new Error("fetch cancellation failed");
  let releases = 0;
  const h = await createHarness({
    source: {
      async fetch() {
        throw sourceFailure;
      },
    },
  });
  const repository = new Proxy(h.repository, {
    get(target, property) {
      if (property === "releaseFetch") {
        return async () => {
          releases += 1;
          throw releaseFailure;
        };
      }
      if (property === "cancelReservation") {
        return async () => {
          throw cancellationFailure;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = new SubtitleDeliveryService({
    repository,
    manifests: h.manifests,
    objectStore: h.objectStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });
  await assert.rejects(
    service.resolve(h.binding, resolution()),
    (error) => error.code === "subtitle_source_unavailable" &&
      error.statusCode === 502 &&
      error.cleanupError instanceof AggregateError &&
      error.cleanupError.errors[0] === cancellationFailure &&
      error.cleanupError.errors[1] === releaseFailure
  );
  assert.equal(releases, 1);
});

test("partial object writes abort into late-PUT-safe two-pass cleanup", async () => {
  let puts = 0;
  let returnText = false;
  const serviceOwnedBuffers = [];
  const h = await createHarness({
    repositoryOptions: {
      maxProfileArtifacts: 1,
      maxProfileObjects: 2,
      maxProfileBytes: 1000,
      maxArtifactBytes: 1000,
    },
    source: {
      async fetch() {
        if (returnText) {
          return {
            normalized: {
              type: "text",
              format: "srt",
              extension: ".srt",
              mediaType: "application/x-subrip",
              data: Buffer.from("retry after cleanup"),
            },
          };
        }
        return {
          normalized: {
            type: "vobsub",
            format: "vobsub",
            files: [
              { role: "index", extension: ".idx", mediaType: "application/x-vobsub", data: Buffer.from("index") },
              { role: "sub", extension: ".sub", mediaType: "application/octet-stream", data: Buffer.from("binary") },
            ],
          },
        };
      },
    },
  });
  const failingStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: async (...args) => {
      puts += 1;
      serviceOwnedBuffers.push(args[1]);
      if (puts === 2) throw Object.assign(new Error("storage down"), { code: "object_store_unavailable" });
      return h.objectStore.put(...args);
    },
    head: (...args) => h.objectStore.head(...args),
    get: (...args) => h.objectStore.get(...args),
    delete: (...args) => h.objectStore.delete(...args),
  });
  h.service = new SubtitleDeliveryService({
    repository: h.repository,
    manifests: h.manifests,
    objectStore: failingStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });
  await assert.rejects(
    h.service.resolve(h.binding, resolution()),
    (error) => error.code === "object_store_unavailable"
  );
  assert.equal(serviceOwnedBuffers.length, 2);
  assert.ok(serviceOwnedBuffers.every((body) => body.every((byte) => byte === 0)));
  const worker = new SubtitleDeletionWorker({
    repository: h.repository,
    objectStore: h.objectStore,
    workerId: "worker_service_0002",
    retryDelayMs: 5,
  });
  assert.equal(await worker.runOnce(), null);
  h.advance(25);
  assert.equal((await worker.runOnce()).status, "awaiting_second_pass");
  h.advance(5);
  assert.equal((await worker.runOnce()).status, "confirmed");
  returnText = true;
  h.service = new SubtitleDeliveryService({
    repository: h.repository,
    manifests: h.manifests,
    objectStore: h.objectStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });
  assert.equal((await h.service.resolve(h.binding, resolution(2))).status, "ready");
});

test("deletion worker retries object-store failures without losing its phase", async () => {
  const h = await createHarness();
  const ready = await h.service.resolve(h.binding, resolution());
  await h.repository.invalidateProfile(PROFILE);
  h.advance(25);
  let failDelete = true;
  const flakyStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: (...args) => h.objectStore.put(...args),
    head: (...args) => h.objectStore.head(...args),
    get: (...args) => h.objectStore.get(...args),
    delete: async (...args) => {
      if (failDelete) {
        failDelete = false;
        throw Object.assign(new Error("temporary"), { code: "object_store_unavailable" });
      }
      return h.objectStore.delete(...args);
    },
  });
  const worker = new SubtitleDeletionWorker({
    repository: h.repository,
    objectStore: flakyStore,
    workerId: "worker_service_0003",
    retryDelayMs: 7,
  });
  const retry = await worker.runOnce();
  assert.equal(retry.status, "retrying");
  assert.equal(retry.errorCode, "object_store_unavailable");
  assert.equal(retry.retryAt, h.now() + 7);
  h.advance(7);
  assert.equal((await worker.runOnce()).phase, "first");
  h.advance(5);
  assert.equal((await worker.runOnce()).status, "confirmed");
  assert.equal(await h.service.read(h.binding, ready.artifactId, 1), null);
});

test("deletion worker confirms empty claims without touching object storage", async () => {
  const h = await createHarness();
  const artifactId = "artifact_empty_0001";
  const deletionToken = "deletion_empty_token_0001";
  let claimAvailable = true;
  let confirmations = 0;
  let retries = 0;
  const repository = new Proxy(h.repository, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "claimDeletion") {
        return async (input) => {
          assert.equal(input.workerId, "worker_service_empty_0001");
          if (!claimAvailable) return null;
          claimAvailable = false;
          return {
            status: "claimed",
            artifactId,
            phase: "empty",
            deletionToken,
            parts: [],
          };
        };
      }
      if (property === "confirmDeletion") {
        return async (input) => {
          confirmations += 1;
          assert.deepEqual(input, { artifactId, deletionToken, verifiedAbsent: true });
          return {
            status: "confirmed",
            released: { artifacts: 1, objects: 2, bytes: 1000 },
          };
        };
      }
      if (property === "retryDeletion") {
        return async () => {
          retries += 1;
          return null;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let objectStoreCalls = 0;
  const objectStore = assertObjectStore({
    createKey: (...args) => { objectStoreCalls += 1; return h.objectStore.createKey(...args); },
    put: (...args) => { objectStoreCalls += 1; return h.objectStore.put(...args); },
    head: (...args) => { objectStoreCalls += 1; return h.objectStore.head(...args); },
    get: (...args) => { objectStoreCalls += 1; return h.objectStore.get(...args); },
    delete: (...args) => { objectStoreCalls += 1; return h.objectStore.delete(...args); },
  });
  const worker = new SubtitleDeletionWorker({
    repository,
    objectStore,
    workerId: "worker_service_empty_0001",
    retryDelayMs: 5,
  });

  assert.deepEqual(await worker.runOnce(), {
    status: "confirmed",
    artifactId,
    phase: "empty",
    released: { artifacts: 1, objects: 2, bytes: 1000 },
  });
  assert.equal(await worker.runOnce(), null);
  assert.equal(confirmations, 1);
  assert.equal(retries, 0);
  assert.equal(objectStoreCalls, 0);
});

test("read discards bytes when the exact claim is invalidated during object I/O", async () => {
  const h = await createHarness();
  const ready = await h.service.resolve(h.binding, resolution());
  let invalidated = false;
  let fetchedBody;
  const racingStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: (...args) => h.objectStore.put(...args),
    head: (...args) => h.objectStore.head(...args),
    delete: (...args) => h.objectStore.delete(...args),
    get: async (...args) => {
      const result = await h.objectStore.get(...args);
      fetchedBody = result.body;
      if (!invalidated) {
        invalidated = true;
        await h.repository.invalidateSession(PROFILE, h.binding.sessionId);
      }
      return result;
    },
  });
  const racingService = new SubtitleDeliveryService({
    repository: h.repository,
    manifests: h.manifests,
    objectStore: racingStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });
  await assert.rejects(
    racingService.read(h.binding, ready.artifactId, 1),
    (error) => error.code === "subtitle_authorization_changed" && error.statusCode === 409
  );
  assert.ok(fetchedBody);
  assert.ok(fetchedBody.every((byte) => byte === 0));
});

test("read clears fetched bytes when object-store media type validation fails", async () => {
  const h = await createHarness();
  const ready = await h.service.resolve(h.binding, resolution());
  let fetchedBody;
  const mismatchedStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: (...args) => h.objectStore.put(...args),
    head: (...args) => h.objectStore.head(...args),
    delete: (...args) => h.objectStore.delete(...args),
    get: async (...args) => {
      const result = await h.objectStore.get(...args);
      fetchedBody = result.body;
      return { ...result, contentType: "application/octet-stream" };
    },
  });
  const service = new SubtitleDeliveryService({
    repository: h.repository,
    manifests: h.manifests,
    objectStore: mismatchedStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });

  await assert.rejects(
    service.read(h.binding, ready.artifactId, 1),
    (error) => error.code === "object_store_integrity"
  );
  assert.ok(fetchedBody);
  assert.ok(fetchedBody.every((byte) => byte === 0));
});

test("read clears fetched bytes when lease release fails before ownership transfer", async () => {
  const h = await createHarness();
  const ready = await h.service.resolve(h.binding, resolution());
  const releaseFailure = new Error("lease release failed");
  let fetchedBody;
  const repository = new Proxy(h.repository, {
    get(target, property) {
      if (property === "releaseLease") {
        return async () => {
          throw releaseFailure;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const capturingStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: (...args) => h.objectStore.put(...args),
    head: (...args) => h.objectStore.head(...args),
    delete: (...args) => h.objectStore.delete(...args),
    get: async (...args) => {
      const result = await h.objectStore.get(...args);
      fetchedBody = result.body;
      return result;
    },
  });
  const service = new SubtitleDeliveryService({
    repository,
    manifests: h.manifests,
    objectStore: capturingStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });

  await assert.rejects(
    service.read(h.binding, ready.artifactId, 1),
    (error) => error === releaseFailure
  );
  assert.ok(fetchedBody);
  assert.ok(fetchedBody.every((byte) => byte === 0));
});

test("read preserves its primary failure when lease release also fails", async () => {
  const h = await createHarness();
  const ready = await h.service.resolve(h.binding, resolution());
  const readFailure = Object.assign(new Error("object read failed"), {
    code: "object_store_unavailable",
  });
  const releaseFailure = new Error("lease release failed");
  const repository = new Proxy(h.repository, {
    get(target, property) {
      if (property === "releaseLease") {
        return async () => {
          throw releaseFailure;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const objectStore = assertObjectStore({
    createKey: (...args) => h.objectStore.createKey(...args),
    put: (...args) => h.objectStore.put(...args),
    head: (...args) => h.objectStore.head(...args),
    get: async () => {
      throw readFailure;
    },
    delete: (...args) => h.objectStore.delete(...args),
  });
  const service = new SubtitleDeliveryService({
    repository,
    manifests: h.manifests,
    objectStore,
    source: h.source,
    tokenService: h.tokenService,
    clock: h.now,
  });

  await assert.rejects(
    service.read(h.binding, ready.artifactId, 1),
    (error) => error === readFailure && error.cleanupError === releaseFailure
  );
});
