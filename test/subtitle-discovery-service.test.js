"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizePrivateSubtitleCandidate } = require("../lib/provider-gateway-service");
const { SourceContextStore, fingerprintExactUrl, hashOpaqueValue } = require("../lib/source-context");
const {
  deriveSubtitleFileName,
  SubtitleDiscoveryService,
} = require("../lib/subtitle-discovery-service");
const { MemorySubtitleDeliveryRepository } = require("../lib/storage/memory-subtitle-delivery-repository");
const { OpaqueObjectKeyFactory } = require("../lib/storage/object-store");
const { TokenService } = require("../lib/storage/token-service");

const PROFILE = "profile_discovery_service";
const DEVICE = "device_discovery_service";

function bytes(seed = 1) {
  let value = seed;
  return (length) => Buffer.alloc(length, value++);
}

function context(url) {
  return {
    contentKey: hashOpaqueValue("subtitle-discovery-context"),
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
      streamProvider: "provider-stream-private",
      videoHash: "0123456789abcdef",
      videoSize: 987654321,
      filename: "Private.Movie.mkv",
    },
    display: { title: "Private Movie", year: 1999 },
    source: { type: "url", provider: "provider-stream-private" },
    fingerprints: [fingerprintExactUrl(url)],
    inlineSubtitles: [
      {
        id: "inline-secret-id",
        lang: "eng",
        url: "https://inline.example/movie.vtt?token=inline-url-secret",
        headers: { Authorization: "Bearer inline-header-secret" },
        token: "inline-arbitrary-secret",
        objectKey: "inline-storage-secret",
      },
      {
        id: "inline-vobsub-idx",
        lang: "en",
        url: "https://inline.example/pairs/Movie.idx?token=inline-idx-secret",
      },
      {
        id: "inline-vobsub-sub",
        lang: "en",
        url: "https://inline.example/parts/Movie.sub?token=inline-sub-secret",
      },
      { lang: "en", url: "http://127.0.0.1/rejected.srt" },
    ],
  };
}

async function harness() {
  let now = 1000;
  let sequence = 0;
  const tokens = new TokenService({ pepper: Buffer.alloc(32, 0x41), randomBytes: bytes(1) });
  const contexts = new SourceContextStore({
    clock: () => now,
    idFactory: (kind) => kind + "_discovery_" + String(++sequence).padStart(8, "0"),
    ttlMs: 10_000,
    tombstoneTtlMs: 10_000,
  });
  const mediaUrl = "https://media.example/private.mkv?token=media-secret";
  const recorded = contexts.record(PROFILE, context(mediaUrl), { providerRevision: "3" });
  const claimRequest = {
    attemptId: "00000000-0000-4000-8000-000000000102",
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(mediaUrl),
    launchedAt: now,
  };
  const claimed = contexts.claim(PROFILE, DEVICE, claimRequest, {
    generation: contexts.getProfileGeneration(PROFILE),
    deviceGeneration: 1,
    sessionId: "session_discovery_service_0001",
    requestDigest: hashOpaqueValue(JSON.stringify(claimRequest)),
  });
  const objectKeys = new OpaqueObjectKeyFactory({
    currentKeyId: "discovery-test",
    keyring: [{ id: "discovery-test", secret: Buffer.alloc(32, 0x42) }],
    prefix: "subtitles/v1",
  });
  const repository = new MemorySubtitleDeliveryRepository({
    tokenService: tokens,
    objectKeyFactory: objectKeys,
    sourceContextStore: contexts,
    clock: () => now,
  });
  const providerCandidate = normalizePrivateSubtitleCandidate("provider-private-0001", {
    id: "provider-secret-id",
    lang: "es-MX",
    url: "https://provider.example/movie.srt?token=provider-url-secret",
    headers: { Authorization: "Bearer provider-header-secret" },
    objectKey: "provider-storage-secret",
    arbitrary: { token: "provider-arbitrary-secret" },
  });
  let snapshot = { providerRevision: "3", generation: "g1:0" };
  const gatewayCalls = [];
  const gateway = {
    async discoverSubtitles(profileId, request) {
      gatewayCalls.push({ profileId, request });
      return { response: { candidates: [providerCandidate] }, snapshot: { ...snapshot } };
    },
  };
  const deliveryCalls = [];
  let ready = {
    status: "ready",
    artifactId: "artifact_discovery_0001",
    expiresAt: now + 5000,
    parts: [{
      partNumber: 1,
      sizeBytes: 12,
      checksum: "a".repeat(64),
      role: "subtitle",
      extension: ".srt",
      mediaType: "application/x-subrip",
    }],
  };
  const delivery = {
    async resolve(binding, request) {
      deliveryCalls.push({ operation: "resolve", binding, request });
      return ready;
    },
    async read(binding, artifactId, partNumber, options) {
      deliveryCalls.push({ operation: "read", binding, artifactId, partNumber, options });
      return {
        artifactId,
        partNumber,
        role: "subtitle",
        extension: ".srt",
        mediaType: "application/x-subrip",
        checksum: "b".repeat(64),
        sizeBytes: 12,
        ...(options.method === "GET" ? { body: Buffer.from("subtitle-ok") } : {}),
      };
    },
  };
  const service = new SubtitleDiscoveryService({
    playbackContexts: contexts,
    subtitleDeliveries: repository,
    gateway,
    delivery,
    tokenService: tokens,
  });
  return {
    service,
    contexts,
    repository,
    tokens,
    gatewayCalls,
    deliveryCalls,
    claimed,
    setSnapshot(value) { snapshot = value; },
    setReady(value) { ready = value; },
    advance(value) { now += value; },
  };
}

test("private discovery builds only from the active claim and exposes bounded selectors", async () => {
  const h = await harness();
  const request = { sessionId: h.claimed.sessionId };
  const first = await h.service.discover({ profileId: PROFILE, deviceId: DEVICE }, request);
  const second = await h.service.discover({ profileId: PROFILE, deviceId: DEVICE }, request);

  assert.deepEqual(second, first);
  assert.deepEqual(Object.keys(first).sort(), ["schemaVersion", "subtitles"]);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.subtitles.length, 2);
  assert.deepEqual(
    Object.keys(first.subtitles[0]).sort(),
    ["format", "label", "language", "rank", "selector"]
  );
  assert.match(first.subtitles[0].selector, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.subtitles.map((item) => item.language), ["eng", "es-mx"]);
  assert.deepEqual(first.subtitles.map((item) => item.rank), [1, 2]);
  assert.deepEqual(first.subtitles.map((item) => item.label), ["eng - VTT", "es-mx - SRT"]);
  assert.ok(first.subtitles.every((item) => item.label.length <= 64));
  assert.deepEqual(h.gatewayCalls[0], {
    profileId: PROFILE,
    request: {
      resource: "subtitles",
      type: "movie",
      id: "tt0133093",
      extra: [
        { name: "videoHash", value: "0123456789abcdef" },
        { name: "videoSize", value: "987654321" },
        { name: "filename", value: "Private.Movie.mkv" },
      ],
    },
  });
  const json = JSON.stringify(first);
  for (const secret of [
    "https://",
    "inline-url-secret",
    "inline-header-secret",
    "inline-idx-secret",
    "inline-sub-secret",
    "provider-url-secret",
    "provider-header-secret",
    "arbitrary-secret",
    "storage-secret",
    "Authorization",
    "provider-private",
    "generation",
    "objectKey",
  ]) {
    assert.equal(json.includes(secret), false, secret);
  }
  await assert.rejects(
    h.service.discover(
      { profileId: PROFILE, deviceId: DEVICE },
      { sessionId: h.claimed.sessionId, url: "https://attacker.example/owned.srt" }
    ),
    /unsupported fields/
  );
});

test("resolve requeries selectors and rejects tamper, cross-binding, and stale snapshots", async () => {
  const h = await harness();
  const binding = { profileId: PROFILE, deviceId: DEVICE };
  const discovered = await h.service.discover(binding, { sessionId: h.claimed.sessionId });
  const selector = discovered.subtitles[1].selector;

  assert.equal(await h.service.resolve(binding, {
    sessionId: h.claimed.sessionId,
    selector: selector.slice(0, -1) + (selector.endsWith("0") ? "1" : "0"),
  }), null);
  assert.equal(await h.service.resolve(
    { profileId: PROFILE, deviceId: "device_discovery_other" },
    { sessionId: h.claimed.sessionId, selector }
  ), null);
  h.setSnapshot({ providerRevision: "4", generation: "g1:0" });
  assert.equal(await h.service.resolve(binding, { sessionId: h.claimed.sessionId, selector }), null);
  h.setSnapshot({ providerRevision: "3", generation: "g1:stale" });
  assert.equal(await h.service.resolve(binding, { sessionId: h.claimed.sessionId, selector }), null);
  h.setSnapshot({ providerRevision: "3", generation: "g1:0" });

  const legacyReady = await h.service.resolve(binding, {
    sessionId: h.claimed.sessionId,
    selector,
  });
  assert.equal(legacyReady.schemaVersion, 1);
  assert.equal(Object.hasOwn(legacyReady.parts[0], "sha256"), false);

  const ready = await h.service.resolve(binding, {
    sessionId: h.claimed.sessionId,
    selector,
    responseSchemaVersion: 2,
  });
  assert.deepEqual(
    Object.keys(ready).sort(),
    ["artifactId", "expiresAt", "expiresAtUnit", "parts", "schemaVersion", "status"]
  );
  assert.equal(ready.schemaVersion, 2);
  assert.equal(ready.status, "ready");
  assert.equal(ready.expiresAt, 6000);
  assert.equal(ready.expiresAtUnit, "unix_ms");
  assert.equal(ready.parts[0].sha256, "a".repeat(64));
  assert.equal(h.gatewayCalls.length >= 5, true);
  const call = h.deliveryCalls.find((item) => item.operation === "resolve");
  assert.equal(call.binding.profileId, PROFILE);
  assert.equal(call.binding.deviceId, DEVICE);
  assert.equal(call.binding.sessionId, h.claimed.sessionId);
  assert.equal(call.request.sourceCapability.url.includes("provider-url-secret"), true);
  assert.equal(call.request.sourceCapability.headers.authorization.includes("provider-header-secret"), true);
  assert.match(call.request.discoveryKey, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(ready).includes("provider-url-secret"), false);
  for (const responseSchemaVersion of [1, 3, "2", null]) {
    await assert.rejects(
      h.service.resolve(binding, {
        sessionId: h.claimed.sessionId,
        selector,
        responseSchemaVersion,
      }),
      /schema version is invalid/
    );
  }
});

test("delivery filenames are cosmetic, cross-bound, and pair VobSub basenames", async () => {
  const h = await harness();
  const binding = { profileId: PROFILE, deviceId: DEVICE };
  const discovered = await h.service.discover(binding, { sessionId: h.claimed.sessionId });
  const selector = discovered.subtitles[0].selector;
  h.setReady({
    status: "ready",
    artifactId: "artifact_discovery_vobsub",
    expiresAt: 9000,
    parts: [
      { partNumber: 1, sizeBytes: 10, checksum: "b".repeat(64), role: "index", extension: ".idx", mediaType: "application/x-vobsub" },
      { partNumber: 2, sizeBytes: 20, checksum: "c".repeat(64), role: "sub", extension: ".sub", mediaType: "application/octet-stream" },
    ],
  });
  const ready = await h.service.resolve(binding, {
    sessionId: h.claimed.sessionId,
    selector,
    responseSchemaVersion: 2,
  });
  assert.equal(ready.schemaVersion, 2);
  assert.equal(ready.expiresAtUnit, "unix_ms");
  assert.equal(ready.parts[0].fileName.slice(0, -4), ready.parts[1].fileName.slice(0, -4));
  assert.match(ready.parts[0].fileName, /^[a-f0-9]{64}\.idx$/);
  assert.match(ready.parts[1].fileName, /^[a-f0-9]{64}\.sub$/);
  assert.deepEqual(ready.parts.map((part) => part.sha256), ["b".repeat(64), "c".repeat(64)]);

  const artifactId = "artifact_discovery_0001";
  const fileName = deriveSubtitleFileName(h.tokens, artifactId, ".srt");
  const read = await h.service.read(binding, {
    sessionId: h.claimed.sessionId,
    artifactId,
    partNumber: 1,
    fileName,
    method: "GET",
  });
  assert.equal(read.body.toString(), "subtitle-ok");
  assert.equal(await h.service.read(binding, {
    sessionId: h.claimed.sessionId,
    artifactId,
    partNumber: 1,
    fileName: "0".repeat(64) + ".srt",
    method: "GET",
  }), null);

  h.contexts.release(PROFILE, DEVICE, h.claimed.sessionId);
  assert.equal(await h.service.read(binding, {
    sessionId: h.claimed.sessionId,
    artifactId,
    partNumber: 1,
    fileName,
    method: "HEAD",
  }), null);
});

test("schema v2 rejects missing digests and enforces part and aggregate caps", async () => {
  const h = await harness();
  const binding = { profileId: PROFILE, deviceId: DEVICE };
  const discovered = await h.service.discover(binding, { sessionId: h.claimed.sessionId });
  const selector = discovered.subtitles[0].selector;
  const resolveV2 = () => h.service.resolve(binding, {
    sessionId: h.claimed.sessionId,
    selector,
    responseSchemaVersion: 2,
  });

  h.setReady({
    status: "ready",
    artifactId: "artifact_discovery_missing_digest",
    expiresAt: 9000,
    parts: [{
      partNumber: 1,
      sizeBytes: 12,
      role: "subtitle",
      extension: ".srt",
      mediaType: "application/x-subrip",
    }],
  });
  await assert.rejects(resolveV2(), /subtitle sha256/);

  h.setReady({
    status: "ready",
    artifactId: "artifact_discovery_oversized_part",
    expiresAt: 9000,
    parts: [{
      partNumber: 1,
      sizeBytes: 8 * 1024 * 1024 + 1,
      checksum: "d".repeat(64),
      role: "subtitle",
      extension: ".srt",
      mediaType: "application/x-subrip",
    }],
  });
  await assert.rejects(resolveV2(), /content length/);

  h.setReady({
    status: "ready",
    artifactId: "artifact_discovery_oversized_aggregate",
    expiresAt: 9000,
    parts: [
      { partNumber: 1, sizeBytes: 7 * 1024 * 1024, checksum: "e".repeat(64), role: "index", extension: ".idx", mediaType: "application/x-vobsub" },
      { partNumber: 2, sizeBytes: 6 * 1024 * 1024, checksum: "f".repeat(64), role: "sub", extension: ".sub", mediaType: "application/octet-stream" },
    ],
  });
  await assert.rejects(resolveV2(), /aggregate content length/);
});
