"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const {
  SourceContextStore,
  fingerprintExactUrl,
  hashOpaqueValue,
} = require("../lib/source-context");
const { assertRepository } = require("../lib/storage/contracts");
const {
  DEFAULT_MEMORY_SUBTITLE_DELIVERY_LIMITS,
  MemorySubtitleDeliveryRepository,
} = require("../lib/storage/memory-subtitle-delivery-repository");
const { OpaqueObjectKeyFactory } = require("../lib/storage/object-store");
const { TokenService } = require("../lib/storage/token-service");

const PROFILE = "profile_memory_subtitles";
const DEVICE = "device_memory_subtitles";

function deterministicBytes(seed = 1) {
  let value = seed;
  return (length) => {
    const result = Buffer.alloc(length, value);
    value = value === 255 ? 1 : value + 1;
    return result;
  };
}

function privateContext(url) {
  return {
    contentKey: hashOpaqueValue("movie:memory-subtitles"),
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
    source: { type: "url", provider: "stream-provider", url },
    fingerprints: [fingerprintExactUrl(url)],
    inlineSubtitles: [],
  };
}

async function harness(overrides = {}) {
  let now = 1000;
  let contextSequence = 0;
  let artifactSequence = 0;
  const tokenService = new TokenService({
    pepper: Buffer.alloc(32, 0x51),
    randomBytes: deterministicBytes(1),
  });
  const objectKeyFactory = new OpaqueObjectKeyFactory({
    currentKeyId: "memory-subtitle",
    keyring: [{ id: "memory-subtitle", secret: Buffer.alloc(32, 0x62) }],
    prefix: "subtitles/v1",
  });
  const sourceContextStore = new SourceContextStore({
    clock: () => now,
    idFactory: (kind) => kind + "_memory_" + String(++contextSequence).padStart(8, "0"),
    ttlMs: 10_000,
    tombstoneTtlMs: 10_000,
  });
  const url = "https://media.example/matrix.mkv?source=memory";
  const recorded = sourceContextStore.record(PROFILE, privateContext(url));
  const claimRequest = {
    attemptId: crypto.randomUUID(),
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: now,
  };
  const claim = sourceContextStore.claim(PROFILE, DEVICE, claimRequest, {
    sessionId: "session_memory_subtitles_0001",
    requestDigest: hashOpaqueValue(JSON.stringify(claimRequest)),
  });
  assert.equal(claim.status, "claimed");
  const binding = sourceContextStore.getActiveClaim(PROFILE, DEVICE, claim.sessionId).deliveryBinding;
  const repository = new MemorySubtitleDeliveryRepository({
    tokenService,
    objectKeyFactory,
    sourceContextStore,
    clock: () => now,
    idFactory: () => "artifact_memory_" + String(++artifactSequence).padStart(8, "0"),
    logicalTtlMs: 1000,
    absoluteTtlMs: 5000,
    fetchLeaseTtlMs: 10,
    uploadLeaseTtlMs: 10,
    maxPutLifetimeMs: 10,
    uploadSettlementGraceMs: 5,
    ioLeaseTtlMs: 10,
    deletionLeaseTtlMs: 10,
    maxDeletionRetryMs: 100,
    ...overrides,
  });
  await repository.reconcileAuthority({
    profileId: PROFILE,
    providerRevision: binding.providerRevision,
    generation: binding.generation,
  });
  return {
    repository,
    tokenService,
    sourceContextStore,
    binding,
    now: () => now,
    advance(milliseconds) { now += milliseconds; },
  };
}

function source(number = 1) {
  return {
    url: "https://subs.example/subtitle-" + number + ".srt?token=private-" + number,
    headers: { Authorization: "Bearer secret-" + number, "X-Provider": "memory" },
  };
}

function textPart(body = "subtitle") {
  const data = Buffer.from(body);
  return {
    partNumber: 1,
    sizeBytes: data.length,
    checksum: crypto.createHash("sha256").update(data).digest("hex"),
    role: "subtitle",
    extension: ".srt",
    mediaType: "application/x-subrip",
  };
}

function receipts(parts) {
  return parts.map((part) => ({
    partNumber: part.partNumber,
    objectKey: part.objectKey,
    sizeBytes: part.sizeBytes,
    checksum: part.checksum,
    mediaType: part.mediaType,
  }));
}

async function reserve(h, number = 1) {
  return h.repository.reserve({
    ...h.binding,
    discoveryKey: "discovery-" + number,
    sourceCapability: source(number),
  });
}

async function stageText(h, artifact, body = "subtitle") {
  const fetch = await h.repository.beginFetch({ artifactId: artifact.artifactId, ...h.binding });
  const staged = await h.repository.stageUpload({
    artifactId: artifact.artifactId,
    ...h.binding,
    fetchToken: fetch.fetchToken,
    parts: [textPart(body)],
  });
  return { fetch, staged };
}

test("memory subtitle delivery exposes the complete repository contract and bounded defaults", async () => {
  const h = await harness();
  assert.equal(assertRepository("subtitleDeliveries", h.repository), h.repository);
  assert.equal(DEFAULT_MEMORY_SUBTITLE_DELIVERY_LIMITS.artifactParts, 2);
  assert.equal(DEFAULT_MEMORY_SUBTITLE_DELIVERY_LIMITS.artifactBytes, 12 * 1024 * 1024);
  assert.throws(
    () => new MemorySubtitleDeliveryRepository({}),
    /tokenService/
  );
  assert.throws(
    () => new MemorySubtitleDeliveryRepository({
      tokenService: h.tokenService,
      objectKeyFactory: {},
      sourceContextStore: h.sourceContextStore,
    }),
    /objectKeyFactory/
  );
  assert.throws(
    () => new MemorySubtitleDeliveryRepository({
      tokenService: h.tokenService,
      objectKeyFactory: new OpaqueObjectKeyFactory({
        currentKeyId: "test",
        keyring: [{ id: "test", secret: Buffer.alloc(32, 1) }],
        prefix: "subtitles/v1",
      }),
      sourceContextStore: h.sourceContextStore,
      maxArtifactParts: 3,
    }),
    /maxArtifactParts/
  );
});

test("memory text delivery fences fetch/stage/commit replays and leases exact reads", async () => {
  const h = await harness();
  const artifact = await reserve(h);
  assert.equal(artifact.status, "reserved");
  assert.equal(artifact.duplicate, false);
  assert.equal(typeof artifact.reservationToken, "string");
  h.advance(1);
  const duplicate = await reserve(h);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.artifactId, artifact.artifactId);
  assert.equal(duplicate.expiresAt, artifact.expiresAt + 1);
  assert.equal(typeof duplicate.reservationToken, "string");
  assert.notEqual(duplicate.reservationToken, artifact.reservationToken);
  assert.equal(
    await h.repository.cancelReservation(artifact.artifactId, h.binding, artifact.reservationToken),
    null
  );

  const fetch = await h.repository.beginFetch({ artifactId: artifact.artifactId, ...h.binding });
  assert.equal(fetch.status, "fetching");
  assert.equal(fetch.sourceCapability.url.includes("private-1"), true);
  assert.deepEqual(fetch.parts, []);
  const replayFetch = await h.repository.beginFetch({
    artifactId: artifact.artifactId,
    ...h.binding,
    fetchToken: fetch.fetchToken,
  });
  assert.equal(replayFetch.replay, true);
  const competingFetch = h.tokenService.issue("subtitle-fetch", 32).token;
  await assert.rejects(
    h.repository.beginFetch({ artifactId: artifact.artifactId, ...h.binding, fetchToken: competingFetch }),
    (error) => error.code === "subtitle_fetch_busy"
  );

  const part = textPart("hello world");
  const staged = await h.repository.stageUpload({
    artifactId: artifact.artifactId,
    ...h.binding,
    fetchToken: fetch.fetchToken,
    parts: [part],
  });
  assert.equal(staged.status, "uploading");
  assert.equal(staged.parts.length, 1);
  assert.equal(staged.parts[0].role, "subtitle");
  assert.equal(staged.parts[0].objectKey.includes("private-1"), false);
  const replayStage = await h.repository.stageUpload({
    artifactId: artifact.artifactId,
    ...h.binding,
    fetchToken: fetch.fetchToken,
    uploadToken: staged.uploadToken,
    parts: [part],
  });
  assert.equal(replayStage.replay, true);
  await assert.rejects(
    h.repository.stageUpload({
      artifactId: artifact.artifactId,
      ...h.binding,
      fetchToken: fetch.fetchToken,
      uploadToken: staged.uploadToken,
      parts: [textPart("different")],
    }),
    (error) => error.code === "subtitle_stage_conflict"
  );

  const committed = await h.repository.commit({
    artifactId: artifact.artifactId,
    ...h.binding,
    uploadToken: staged.uploadToken,
    receipts: receipts(staged.parts),
  });
  assert.equal(committed.status, "committed");
  assert.equal(committed.sizeBytes, part.sizeBytes);
  const commitReplay = await h.repository.commit({
    artifactId: artifact.artifactId,
    ...h.binding,
    uploadToken: staged.uploadToken,
    receipts: receipts(staged.parts),
  });
  assert.equal(commitReplay.replay, true);
  await assert.rejects(
    h.repository.commit({
      artifactId: artifact.artifactId,
      ...h.binding,
      uploadToken: staged.uploadToken,
      receipts: [{ ...receipts(staged.parts)[0], mediaType: "text/plain" }],
    }),
    (error) => error.code === "subtitle_commit_conflict"
  );
  await assert.rejects(
    h.repository.commit({
      artifactId: artifact.artifactId,
      ...h.binding,
      uploadToken: staged.uploadToken,
      receipts: [{ ...receipts(staged.parts)[0], unexpected: true }],
    }),
    /unsupported field/
  );
  await assert.rejects(
    h.repository.commit({
      artifactId: artifact.artifactId,
      ...h.binding,
      uploadToken: staged.uploadToken,
      receipts: [{ ...receipts(staged.parts)[0], key: staged.parts[0].objectKey }],
    }),
    /duplicate fields/
  );
  await assert.rejects(
    h.repository.commit({
      artifactId: artifact.artifactId,
      ...h.binding,
      uploadToken: staged.uploadToken,
      parts: receipts(staged.parts),
    }),
    (error) => error.code === "subtitle_commit_conflict"
  );

  const lease = await h.repository.authorize({ artifactId: artifact.artifactId, ...h.binding, method: "GET" });
  assert.equal(lease.status, "authorized");
  assert.equal(lease.parts[0].mediaType, "application/x-subrip");
  const checked = await h.repository.revalidate({
    artifactId: artifact.artifactId,
    ...h.binding,
    leaseToken: lease.leaseToken,
  });
  assert.equal(checked.status, "revalidated");
  assert.equal(await h.repository.releaseLease(artifact.artifactId, lease.leaseToken), true);
  assert.equal(await h.repository.releaseLease(artifact.artifactId, lease.leaseToken), false);
});

test("memory delivery validates canonical text and VobSub metadata before exposing keys", async () => {
  const h = await harness();
  const text = await reserve(h, 1);
  const textFetch = await h.repository.beginFetch({ artifactId: text.artifactId, ...h.binding });
  await assert.rejects(
    h.repository.stageUpload({
      artifactId: text.artifactId,
      ...h.binding,
      fetchToken: textFetch.fetchToken,
      parts: [{ ...textPart(), mediaType: "text/plain" }],
    }),
    (error) => error.code === "subtitle_invalid_parts"
  );
  await assert.rejects(
    h.repository.stageUpload({
      artifactId: text.artifactId,
      ...h.binding,
      fetchToken: textFetch.fetchToken,
      parts: [{ ...textPart(), checksum: "A".repeat(64) }],
    }),
    /checksum/
  );
  await assert.rejects(
    h.repository.stageUpload({
      artifactId: text.artifactId,
      ...h.binding,
      fetchToken: textFetch.fetchToken,
      parts: [{ ...textPart(), size: textPart().sizeBytes }],
    }),
    /unsupported fields/
  );

  const vob = await reserve(h, 2);
  const vobFetch = await h.repository.beginFetch({ artifactId: vob.artifactId, ...h.binding });
  const files = [
    {
      partNumber: 1,
      sizeBytes: 40,
      checksum: "1".repeat(64),
      role: "index",
      extension: ".idx",
      mediaType: "application/x-vobsub",
    },
    {
      partNumber: 2,
      sizeBytes: 100,
      checksum: "2".repeat(64),
      role: "sub",
      extension: ".sub",
      mediaType: "application/octet-stream",
    },
  ];
  const staged = await h.repository.stageUpload({
    artifactId: vob.artifactId,
    ...h.binding,
    fetchToken: vobFetch.fetchToken,
    parts: files,
  });
  assert.deepEqual(staged.parts.map((part) => part.role), ["index", "sub"]);
  assert.notEqual(staged.parts[0].objectKey, staged.parts[1].objectKey);
});

test("fetch release and expiry fence stale owners without consuming object quota", async () => {
  const h = await harness();
  const artifact = await reserve(h);
  const first = await h.repository.beginFetch({ artifactId: artifact.artifactId, ...h.binding });
  assert.equal(await h.repository.releaseFetch(artifact.artifactId, first.fetchToken), true);
  assert.equal(await h.repository.releaseFetch(artifact.artifactId, first.fetchToken), false);
  await assert.rejects(
    h.repository.beginFetch({
      artifactId: artifact.artifactId,
      ...h.binding,
      fetchToken: first.fetchToken,
    }),
    (error) => error.code === "subtitle_fetch_conflict"
  );
  const second = await h.repository.beginFetch({ artifactId: artifact.artifactId, ...h.binding });
  await assert.rejects(
    h.repository.stageUpload({
      artifactId: artifact.artifactId,
      ...h.binding,
      fetchToken: first.fetchToken,
      parts: [textPart()],
    }),
    (error) => error.code === "subtitle_stage_conflict"
  );
  h.advance(10);
  const pruned = await h.repository.prune();
  assert.equal(pruned.fetches, 1);
  await assert.rejects(
    h.repository.beginFetch({
      artifactId: artifact.artifactId,
      ...h.binding,
      fetchToken: second.fetchToken,
    }),
    (error) => error.code === "subtitle_fetch_conflict"
  );
  await assert.rejects(
    h.repository.stageUpload({
      artifactId: artifact.artifactId,
      ...h.binding,
      fetchToken: second.fetchToken,
      parts: [textPart()],
    }),
    (error) => error.code === "subtitle_stage_conflict"
  );
  const third = await h.repository.beginFetch({ artifactId: artifact.artifactId, ...h.binding });
  assert.notEqual(third.fetchToken, second.fetchToken);
});

test("profile quota is held conservatively then released exactly on cancellation", async () => {
  const h = await harness({
    maxProfileArtifacts: 1,
    maxProfileObjects: 2,
    maxProfileBytes: 100,
    maxArtifactBytes: 100,
  });
  const first = await reserve(h, 1);
  await assert.rejects(
    reserve(h, 2),
    (error) => error.code === "subtitle_profile_capacity" && error.statusCode === 429
  );
  const canceled = await h.repository.cancelReservation({
    artifactId: first.artifactId,
    ...h.binding,
    reservationToken: first.reservationToken,
  });
  assert.deepEqual(canceled.released, { artifacts: 1, objects: 2, bytes: 100 });
  assert.equal((await reserve(h, 2)).status, "reserved");
});

test("claim, generation, and authority changes fail closed without source leakage", async () => {
  const h = await harness();
  const artifact = await reserve(h);
  assert.equal(await h.sourceContextStore.release(PROFILE, DEVICE, h.binding.sessionId), true);
  assert.equal(await h.repository.beginFetch({ artifactId: artifact.artifactId, ...h.binding }), null);

  const fresh = await harness();
  const freshArtifact = await reserve(fresh);
  await fresh.repository.reconcileAuthority({
    profileId: PROFILE,
    providerRevision: "1",
    generation: fresh.binding.generation,
  });
  assert.equal(await fresh.repository.beginFetch({
    artifactId: freshArtifact.artifactId,
    ...fresh.binding,
  }), null);
  await assert.rejects(
    fresh.repository.reconcileAuthority({
      profileId: PROFILE,
      providerRevision: "0",
      generation: fresh.binding.generation,
    }),
    (error) => error.code === "subtitle_authority_stale"
  );
});

test("committed invalidation observes leases and the late-PUT two-pass deletion barrier", async () => {
  const h = await harness();
  const artifact = await reserve(h);
  const { staged } = await stageText(h, artifact, "barrier");
  await h.repository.commit({
    artifactId: artifact.artifactId,
    ...h.binding,
    uploadToken: staged.uploadToken,
    receipts: receipts(staged.parts),
  });
  const lease = await h.repository.authorize({ artifactId: artifact.artifactId, ...h.binding });
  assert.equal(await h.repository.invalidateSession(PROFILE, h.binding.sessionId), 1);
  assert.equal(await h.repository.claimDeletion("worker_memory_0001"), null);
  assert.equal(await h.repository.releaseLease(artifact.artifactId, lease.leaseToken), true);
  h.advance(25);
  const first = await h.repository.claimDeletion("worker_memory_0001");
  assert.equal(first.phase, "first");
  assert.equal(first.parts.length, 1);
  const secondDue = await h.repository.recordDeletionAbsence({
    artifactId: artifact.artifactId,
    deletionToken: first.deletionToken,
    verifiedAbsent: true,
  });
  assert.equal(secondDue.status, "awaiting_second_pass");
  assert.equal(await h.repository.claimDeletion("worker_memory_0002"), null);
  h.advance(5);
  const second = await h.repository.claimDeletion("worker_memory_0002");
  assert.equal(second.phase, "second");
  const confirmed = await h.repository.confirmDeletion({
    artifactId: artifact.artifactId,
    deletionToken: second.deletionToken,
    verifiedAbsent: true,
  });
  assert.deepEqual(confirmed.released, {
    artifacts: 1,
    objects: 1,
    bytes: Buffer.byteLength("barrier"),
  });
  assert.equal(await h.repository.authorize({ artifactId: artifact.artifactId, ...h.binding }), null);
});

test("reserved invalidation and expired deletion claims preserve the required phase", async () => {
  const h = await harness();
  const artifact = await reserve(h);
  assert.equal(await h.repository.invalidateRelease(PROFILE, DEVICE, h.binding.sessionId), 1);
  const first = await h.repository.claimDeletion({ workerId: "worker_memory_0003", leaseTtlMs: 10 });
  assert.equal(first.phase, "first");
  h.advance(10);
  const pruned = await h.repository.prune();
  assert.equal(pruned.deletionClaims, 1);
  const retry = await h.repository.claimDeletion("worker_memory_0004");
  assert.equal(retry.phase, "first");
  const delayed = await h.repository.retryDeletion({
    artifactId: artifact.artifactId,
    deletionToken: retry.deletionToken,
    retryDelayMs: 7,
  });
  assert.equal(delayed.retryAt, h.now() + 7);
  assert.equal(await h.repository.claimDeletion("worker_memory_0005"), null);
  h.advance(7);
  const firstAgain = await h.repository.claimDeletion("worker_memory_0005");
  await h.repository.recordDeletionAbsence({
    artifactId: artifact.artifactId,
    deletionToken: firstAgain.deletionToken,
    verifiedAbsent: true,
  });
  h.advance(5);
  const second = await h.repository.claimDeletion("worker_memory_0006");
  await h.repository.confirmDeletion({
    artifactId: artifact.artifactId,
    deletionToken: second.deletionToken,
    verifiedAbsent: true,
  });
  assert.equal(await h.repository.getAuthority(PROFILE).then((value) => value.providerRevision), "0");
});

test("authority compare-and-set is monotonic and invalidates only stale artifacts", async () => {
  const h = await harness();
  const artifact = await reserve(h);
  const unchanged = await h.repository.transitionAuthority({
    profileId: PROFILE,
    expectedProviderRevision: "0",
    expectedGeneration: h.binding.generation,
    providerRevision: "0",
    generation: h.binding.generation,
  });
  assert.equal(unchanged.status, "unchanged");
  await assert.rejects(
    h.repository.transitionAuthority({
      profileId: PROFILE,
      expectedProviderRevision: "9",
      expectedGeneration: h.binding.generation,
      providerRevision: "1",
      generation: h.binding.generation,
    }),
    (error) => error.code === "subtitle_authority_conflict"
  );
  const updated = await h.repository.transitionAuthority({
    profileId: PROFILE,
    expectedProviderRevision: "0",
    expectedGeneration: h.binding.generation,
    providerRevision: "1",
    generation: h.binding.generation,
  });
  assert.equal(updated.invalidated, 1);
  assert.equal((await h.repository.getAuthority(PROFILE)).providerRevision, "1");
  assert.equal(await h.repository.beginFetch({ artifactId: artifact.artifactId, ...h.binding }), null);
});
