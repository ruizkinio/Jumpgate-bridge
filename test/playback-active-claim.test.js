"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const {
  MAX_PUBLIC_CONTEXT_JSON_BYTES,
  projectPublicPlaybackClaim,
} = require("../lib/playback-claim-projection");
const { fingerprintExactUrl, hashOpaqueValue } = require("../lib/source-context");
const { REPOSITORY_CONTRACTS, assertRepository } = require("../lib/storage/contracts");
const { MemoryPlaybackContextRepository } = require("../lib/storage/memory-ttl-repositories");

const PROFILE = "profile_active_0001";
const OTHER_PROFILE = "profile_active_0002";
const DEVICE = "device_active_0001";
const OTHER_DEVICE = "device_active_0002";
let claimSessionSequence = 0;

function claimAuthority(request, overrides = {}) {
  if (!Object.hasOwn(request, "attemptId")) request.attemptId = crypto.randomUUID();
  return {
    generation: "g1:0",
    deviceGeneration: 1,
    sessionId:
      overrides.sessionId ||
      "session_active_" + String(++claimSessionSequence).padStart(8, "0"),
    requestDigest: overrides.requestDigest || hashOpaqueValue(JSON.stringify(request)),
    ...overrides,
  };
}

function createHarness(options = {}) {
  let now = options.now ?? 1000;
  let sequence = 0;
  const repository = new MemoryPlaybackContextRepository({
    clock: () => now,
    idFactory: (kind) => kind + "_active_" + String(++sequence).padStart(8, "0"),
    ttlMs: options.ttlMs ?? 1000,
    tombstoneTtlMs: options.tombstoneTtlMs ?? 1000,
    providerMutationLeaseMs: options.providerMutationLeaseMs ?? 1000,
  });
  return {
    repository,
    now: () => now,
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function privateContext(url, inlineSubtitles) {
  return {
    contentKey: hashOpaqueValue("movie:active-claim"),
    canonicalIdentity: {
      provider: "imdb",
      id: "tt0133093",
      mediaType: "movie",
      season: null,
      episode: null,
      confidence: "canonical",
      provenance: "metadata-request",
      privateAuthorityNote: "must-not-project",
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
    display: {
      title: "The Matrix",
      year: 1999,
      poster: "https://images.example/poster.jpg",
      background: "https://images.example/background.jpg?token=display-secret",
      authorization: "Bearer display-authorization-secret",
      nested: { token: "display-nested-secret" },
    },
    source: {
      type: "url",
      provider: "stream-provider",
      url,
      requestHeaders: { Authorization: "Bearer media-secret" },
    },
    fingerprints: [fingerprintExactUrl(url)],
    inlineSubtitles,
  };
}

async function recordAndClaim(harness, options = {}) {
  const url = options.url || "https://media.example/movie.mkv?token=media-secret";
  const inlineSubtitles = options.inlineSubtitles || [
    {
      id: "inline-en",
      lang: "eng",
      url: "https://subs.example/movie.vtt?token=subtitle-url-secret",
      headers: { Authorization: "Bearer subtitle-header-secret" },
      token: "subtitle-token-secret",
    },
  ];
  const recorded = await harness.repository.record(PROFILE, privateContext(url, inlineSubtitles));
  const request = {
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: harness.now(),
  };
  const authority = options.claimAuthority || claimAuthority(request);
  const claim = await harness.repository.claim(PROFILE, DEVICE, request, authority);
  assert.equal(claim.status, "claimed");
  return { recorded, claim, request, authority, url };
}

function collectKeys(value, keys = []) {
  if (!value || typeof value !== "object") return keys;
  for (const [key, item] of Object.entries(value)) {
    keys.push(key.toLowerCase());
    collectKeys(item, keys);
  }
  return keys;
}

test("memory provider snapshot mutation blocks playback writes until completion", async () => {
  const harness = createHarness();
  const url = "https://media.example/provider-snapshot-pending.mkv";
  const token = harness.repository._store.beginProviderSnapshotMutation(PROFILE);

  await assert.rejects(
    harness.repository.record(PROFILE, privateContext(url, [])),
    (error) => error.code === "provider_snapshot_busy"
  );
  const blockedRequest = {
      fingerprints: [fingerprintExactUrl(url)],
      intentUrlHash: hashOpaqueValue(url),
      launchedAt: harness.now(),
  };
  await assert.rejects(
    harness.repository.claim(PROFILE, DEVICE, blockedRequest, claimAuthority(blockedRequest)),
    (error) => error.code === "provider_snapshot_busy"
  );

  const stableGeneration = harness.repository._store.completeProviderSnapshotMutation(
    PROFILE,
    harness.repository._store.fenceProviderSnapshotMutation(PROFILE, token, "1").token
  );
  assert.notEqual(stableGeneration, token);
  const recorded = await harness.repository.record(PROFILE, privateContext(url, []));
  const claimRequest = {
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: harness.now(),
  };
  const claimed = await harness.repository.claim(
    PROFILE,
    DEVICE,
    claimRequest,
    claimAuthority(claimRequest, { generation: stableGeneration })
  );
  assert.equal(claimed.status, "claimed");
});

test("memory provider snapshot fencing rejects expired owners without disturbing takeover", () => {
  const harness = createHarness({ providerMutationLeaseMs: 10 });
  const authority = harness.repository._store;
  const stale = authority.beginProviderSnapshotMutation(PROFILE);
  assert.deepEqual(authority.renewProviderSnapshotMutation(PROFILE, stale), {
    renewed: true,
    expiresAt: 1010,
  });

  harness.advance(11);
  const current = authority.beginProviderSnapshotMutation(PROFILE);
  assert.notEqual(current, stale);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.deepEqual(authority.renewProviderSnapshotMutation(PROFILE, stale), { renewed: false });
    assert.equal(authority.releaseProviderSnapshotMutation(PROFILE, stale), false);
    assert.throws(
      () => authority.fenceProviderSnapshotMutation(PROFILE, stale, "1"),
      (error) => error.code === "provider_snapshot_changed"
    );
    assert.deepEqual(authority.getProviderSnapshotState(PROFILE), {
      generation: current,
      pending: true,
    });
  }

  const fenced = authority.fenceProviderSnapshotMutation(PROFILE, current, "2");
  assert.equal(fenced.token, current);
  assert.equal(fenced.fence, "2");
  harness.advance(1000);
  assert.deepEqual(authority.getProviderSnapshotState(PROFILE), {
    generation: current,
    pending: true,
  });
  const stable = authority.completeProviderSnapshotMutation(PROFILE, current);
  assert.deepEqual(authority.getProviderSnapshotState(PROFILE), {
    generation: stable,
    pending: false,
  });
});

test("memory provider snapshot recovery is idempotent and supersedes an orphaned fence", () => {
  const harness = createHarness({ providerMutationLeaseMs: 10 });
  const authority = harness.repository._store;
  const token = authority.beginProviderSnapshotMutation(PROFILE);
  const original = authority.fenceProviderSnapshotMutation(PROFILE, token, "1");
  assert.equal(original.fence, "1");
  assert.equal(authority.probeProviderSnapshotRecovery(PROFILE), null);

  harness.advance(11);
  assert.deepEqual(authority.probeProviderSnapshotRecovery(PROFILE), {
    token,
    fence: "1",
    phase: "fenced",
  });
  const recovery = authority.beginProviderSnapshotRecovery(PROFILE, "2");
  assert.deepEqual(recovery, { token, fence: "2" });
  assert.deepEqual(authority.beginProviderSnapshotRecovery(PROFILE, "1"), recovery);
  assert.throws(
    () => authority.completeProviderSnapshotRecovery(PROFILE, token, "3"),
    (error) => error.code === "provider_snapshot_changed"
  );
  assert.throws(
    () => authority.completeProviderSnapshotMutation(PROFILE, token),
    (error) => error.code === "provider_snapshot_changed"
  );

  const stable = authority.completeProviderSnapshotRecovery(PROFILE, token, recovery.fence);
  assert.deepEqual(authority.getProviderSnapshotState(PROFILE), {
    generation: stable,
    pending: false,
  });
  assert.equal(authority.probeProviderSnapshotRecovery(PROFILE), null);
  const next = authority.beginProviderSnapshotMutation(PROFILE);
  assert.equal(authority.fenceProviderSnapshotMutation(PROFILE, next, "3").fence, "3");
});

test("memory getActiveClaim enforces exact active profile, device, session, and release binding", async () => {
  const harness = createHarness();
  const { claim, url } = await recordAndClaim(harness);

  const active = await harness.repository.getActiveClaim(PROFILE, DEVICE, claim.sessionId);
  const { deliveryBinding, ...claimFields } = active;
  assert.deepEqual(claimFields, claim);
  assert.deepEqual(deliveryBinding, {
    profileId: PROFILE,
    deviceId: DEVICE,
    sessionId: claim.sessionId,
    generation: "g1:0",
    contextId: claim.context.contextId,
    contextRevision: "1",
    providerRevision: "0",
  });
  assert.equal(active.context.inlineSubtitles[0].url.includes("subtitle-url-secret"), true);
  assert.equal(
    active.context.inlineSubtitles[0].headers.Authorization,
    "Bearer subtitle-header-secret"
  );
  assert.equal(active.context.inlineSubtitles[0].token, "subtitle-token-secret");

  harness.advance(1);
  await harness.repository.record(PROFILE, privateContext(url, [
    {
      id: "inline-refreshed",
      lang: "nld",
      url: "https://subs.example/refreshed.vtt?token=refreshed-secret",
      headers: { Authorization: "Bearer refreshed-header-secret" },
    },
  ]));
  const refreshedActive = await harness.repository.getActiveClaim(PROFILE, DEVICE, claim.sessionId);
  assert.equal(refreshedActive.expiresAt, claim.expiresAt);
  assert.equal(refreshedActive.context.inlineSubtitles.length, 2);
  assert.notEqual(refreshedActive.context.expiresAt, claim.context.expiresAt);
  assert.equal(refreshedActive.deliveryBinding.contextRevision, "2");

  assert.equal(await harness.repository.getActiveClaim(OTHER_PROFILE, DEVICE, claim.sessionId), null);
  assert.equal(await harness.repository.getActiveClaim(PROFILE, OTHER_DEVICE, claim.sessionId), null);
  assert.equal(await harness.repository.getActiveClaim(PROFILE, DEVICE, "session_wrong_0001"), null);
  assert.equal(await harness.repository.release(PROFILE, DEVICE, claim.sessionId), true);
  assert.equal(await harness.repository.getActiveClaim(PROFILE, DEVICE, claim.sessionId), null);
});

test("memory getActiveClaim rejects expired, generation-stale, and missing-context claims", async () => {
  const expiredHarness = createHarness();
  const expired = await recordAndClaim(expiredHarness);
  expiredHarness.advance(1000);
  assert.equal(
    await expiredHarness.repository.getActiveClaim(PROFILE, DEVICE, expired.claim.sessionId),
    null
  );

  const generationHarness = createHarness();
  const stale = await recordAndClaim(generationHarness);
  generationHarness.repository._store._profileGenerations.set(PROFILE, "g1:new-generation");
  assert.equal(
    await generationHarness.repository.getActiveClaim(PROFILE, DEVICE, stale.claim.sessionId),
    null
  );

  const missingHarness = createHarness();
  const missing = await recordAndClaim(missingHarness);
  missingHarness.repository._store._contexts.delete(missing.recorded.contextId);
  assert.equal(
    await missingHarness.repository.getActiveClaim(PROFILE, DEVICE, missing.claim.sessionId),
    null
  );
});

test("memory claims retain exact private session supersession metadata", async () => {
  const harness = createHarness();
  const firstUrl = "https://media.example/superseded-first.mkv";
  const secondUrl = "https://media.example/superseded-second.mkv";
  const firstContext = await harness.repository.record(PROFILE, privateContext(firstUrl, []));
  const secondContext = await harness.repository.record(PROFILE, privateContext(secondUrl, []));
  const firstRequest = {
    fingerprints: firstContext.fingerprints,
    intentUrlHash: hashOpaqueValue(firstUrl),
    launchedAt: harness.now(),
  };
  const first = await harness.repository.claim(
    PROFILE,
    DEVICE,
    firstRequest,
    claimAuthority(firstRequest)
  );
  harness.advance(1);
  const request = {
    fingerprints: secondContext.fingerprints,
    intentUrlHash: hashOpaqueValue(secondUrl),
    launchedAt: harness.now(),
  };
  const secondAuthority = claimAuthority(request);
  const second = await harness.repository.claim(PROFILE, DEVICE, request, secondAuthority);
  assert.equal(Object.hasOwn(second, "supersededSessionId"), false);
  assert.deepEqual(
    await harness.repository.claim(PROFILE, DEVICE, request, secondAuthority),
    second
  );
  assert.equal(await harness.repository.getActiveClaim(PROFILE, DEVICE, first.sessionId), null);
  const active = await harness.repository.getActiveClaim(PROFILE, DEVICE, second.sessionId);
  assert.equal(active.deliveryBinding.supersededSessionId, first.sessionId);
  assert.equal(Object.hasOwn(active, "supersededSessionId"), false);
  assert.equal(Object.isFrozen(active), true);
  assert.equal(Object.isFrozen(active.context), true);
  assert.equal(Object.isFrozen(active.deliveryBinding), true);
  assert.equal(Object.hasOwn(projectPublicPlaybackClaim(second, PROFILE), "supersededSessionId"), false);
});

test("memory concurrent claims retain only the exact immediately superseded session", async () => {
  const harness = createHarness();
  const { recorded, claim: first } = await recordAndClaim(harness, {
    url: "https://media.example/concurrent-supersession.mkv",
  });
  harness.advance(1);
  const secondRequest = {
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue("concurrent-second"),
    launchedAt: harness.now(),
  };
  harness.advance(1);
  const thirdRequest = {
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue("concurrent-third"),
    launchedAt: harness.now(),
  };
  const [second, third] = await Promise.all([
    harness.repository.claim(PROFILE, DEVICE, secondRequest, claimAuthority(secondRequest)),
    harness.repository.claim(PROFILE, DEVICE, thirdRequest, claimAuthority(thirdRequest)),
  ]);

  assert.equal(Object.hasOwn(second, "supersededSessionId"), false);
  assert.equal(Object.hasOwn(third, "supersededSessionId"), false);
  assert.equal(await harness.repository.getActiveClaim(PROFILE, DEVICE, first.sessionId), null);
  assert.equal(await harness.repository.getActiveClaim(PROFILE, DEVICE, second.sessionId), null);
  const active = await harness.repository.getActiveClaim(PROFILE, DEVICE, third.sessionId);
  assert.equal(active.deliveryBinding.supersededSessionId, second.sessionId);
  assert.notEqual(active.deliveryBinding.supersededSessionId, first.sessionId);
});

test("memory getActiveClaim validates mutable context against independent identity", async () => {
  const corruptions = [
    ["contentKey", (stored) => {
      stored.context.contentKey = "0".repeat(64);
    }],
    ["fingerprints", (stored) => {
      stored.context.fingerprints = [
        fingerprintExactUrl("https://media.example/corrupt-fingerprint.mkv"),
      ];
    }],
    ["createdAt", (stored) => {
      stored.context.createdAt = new Date(Date.parse(stored.context.createdAt) + 1).toISOString();
    }],
    ["expiresAt", (stored) => {
      stored.context.expiresAt = new Date(Date.parse(stored.context.expiresAt) - 1).toISOString();
    }],
    ["profileId", (stored) => {
      stored.context.profileId = OTHER_PROFILE;
    }],
    ["contextId", (stored) => {
      stored.context.contextId = "context_mismatched_0001";
    }],
    ["malformed field", (stored) => {
      stored.context.request.streamProvider = {
        Authorization: "Bearer malformed-context-secret",
      };
    }],
    ["full context", (stored) => {
      stored.context = null;
    }],
  ];

  for (const [name, corrupt] of corruptions) {
    const harness = createHarness();
    const { recorded, claim } = await recordAndClaim(harness);
    const stored = harness.repository._store._contexts.get(recorded.contextId);
    assert.equal(Object.isFrozen(stored.identity), true);
    assert.equal(Object.isFrozen(stored.identity.fingerprints), true);
    assert.notEqual(stored.identity.fingerprints, stored.context.fingerprints);
    corrupt(stored);
    assert.equal(
      await harness.repository.getActiveClaim(PROFILE, DEVICE, claim.sessionId),
      null,
      name
    );
  }
});

test("public claim projection is deterministic, native-compatible, bounded, and secret-free", async () => {
  const harness = createHarness();
  const subtitles = Array.from({ length: 64 }, (_value, index) => ({
    id: "subtitle-" + index,
    lang: "eng",
    url: "https://subs.example/" + index + ".vtt?token=inline-url-secret-" + index,
    headers: { Authorization: "Bearer inline-header-secret-" + index },
    token: "inline-token-secret-" + index,
  }));
  const { claim } = await recordAndClaim(harness, { inlineSubtitles: subtitles });
  const privateActive = await harness.repository.getActiveClaim(PROFILE, DEVICE, claim.sessionId);
  assert.equal(privateActive.context.inlineSubtitles.length, 64);

  const first = projectPublicPlaybackClaim(privateActive, PROFILE);
  const second = projectPublicPlaybackClaim(privateActive, PROFILE);
  assert.deepEqual(second, first);
  assert.notEqual(first, privateActive);
  assert.notEqual(first.context, privateActive.context);
  assert.deepEqual(Object.keys(first).sort(), [
    "claimedAt",
    "context",
    "expiresAt",
    "sessionId",
    "status",
  ]);
  assert.deepEqual(Object.keys(first.context).sort(), [
    "canonicalIdentity",
    "contentKey",
    "contextId",
    "createdAt",
    "display",
    "expiresAt",
    "fingerprints",
    "inlineSubtitles",
    "profileId",
    "request",
    "schemaVersion",
    "source",
    "traktEligible",
  ]);
  assert.deepEqual(first.context.inlineSubtitles, []);
  assert.deepEqual(first.context.display, {
    title: "The Matrix",
    year: 1999,
  });
  assert.deepEqual(first.context.source, { type: "url", provider: "stream-provider" });
  assert.equal(first.context.profileId, PROFILE);
  assert.equal(first.context.fingerprints.length, 1);
  assert.equal(Object.hasOwn(first.context, "gatewayAvailable"), false);
  assert.equal(Buffer.byteLength(JSON.stringify(first.context), "utf8") < MAX_PUBLIC_CONTEXT_JSON_BYTES, true);

  const publicJson = JSON.stringify(first);
  for (const secret of [
    "media-secret",
    "subtitle-url-secret",
    "subtitle-header-secret",
    "subtitle-token-secret",
    "display-secret",
    "display-authorization-secret",
    "display-nested-secret",
    "must-not-project",
    "Authorization",
    "deliveryBinding",
    "providerRevision",
    "contextRevision",
  ]) {
    assert.equal(publicJson.includes(secret), false, secret);
  }
  assert.equal(privateActive.context.inlineSubtitles[0].headers.Authorization.includes("secret"), true);
  assert.equal(collectKeys(first).includes("ip"), false);
  assert.equal(collectKeys(first).includes("clientip"), false);
});

test("private active bindings use only server-owned bounded revisions", async () => {
  const harness = createHarness();
  const url = "https://media.example/private-binding.mkv?token=secret";
  const clientContext = {
    ...privateContext(url, []),
    generation: "g1:client-controlled",
    contextRevision: "8".repeat(128),
    providerRevision: "7".repeat(128),
    deliveryBinding: { providerRevision: "6".repeat(128) },
  };
  const providerRevision = "9".repeat(128);
  const recorded = await harness.repository.record(PROFILE, clientContext, { providerRevision });
  const request = {
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: harness.now(),
  };
  const claim = await harness.repository.claim(
    PROFILE,
    DEVICE,
    request,
    claimAuthority(request)
  );
  const active = await harness.repository.getActiveClaim(PROFILE, DEVICE, claim.sessionId);
  assert.equal(active.deliveryBinding.generation, "g1:0");
  assert.equal(active.deliveryBinding.contextRevision, "1");
  assert.equal(active.deliveryBinding.providerRevision, providerRevision);
  assert.equal(JSON.stringify(projectPublicPlaybackClaim(active, PROFILE)).includes("Revision"), false);

  await assert.rejects(
    harness.repository.record(PROFILE, privateContext(url, []), { providerRevision: "8" }),
    (error) => error.code === "provider_revision_changed"
  );
  await assert.rejects(
    harness.repository.record(PROFILE, privateContext(url, []), {
      providerRevision: "1" + "0".repeat(128),
    }),
    /provider revision is invalid/
  );

  const stored = harness.repository._store._contexts.get(recorded.contextId);
  stored.revision = "9".repeat(128);
  await assert.rejects(
    harness.repository.record(PROFILE, privateContext(url, []), { providerRevision }),
    (error) => error.code === "context_revision_exhausted"
  );
});

test("public claim projection enforces authenticated profile binding and minimal negative states", async () => {
  const harness = createHarness();
  const { claim } = await recordAndClaim(harness);
  assert.throws(
    () => projectPublicPlaybackClaim(claim, OTHER_PROFILE),
    /does not match the authenticated profile/
  );
  for (const status of ["ambiguous", "expired", "not_found"]) {
    assert.deepEqual(
      projectPublicPlaybackClaim({
        status,
        sessionId: "history_session_negative_0001",
        context: { token: "must-not-project" },
      }, PROFILE),
      { status, sessionId: "history_session_negative_0001" }
    );
  }
});

test("public projection omits nested secrets from allowlisted request and source fields", async () => {
  const harness = createHarness();
  const { claim } = await recordAndClaim(harness);
  const adversarial = JSON.parse(JSON.stringify(claim));
  adversarial.context.request = {
    resource: { Authorization: "Bearer nested-resource-secret" },
    type: { accessToken: "nested-type-secret" },
    metaId: { token: "nested-meta-secret" },
    videoId: ["nested-video-secret"],
    metaProvider: { nested: { token: "nested-provider-secret" } },
    streamProvider: "stream-provider",
    streamProviders: ["stream-provider", "subtitle-provider"],
  };
  adversarial.context.source = {
    type: { Authorization: "Bearer nested-source-secret" },
    provider: "stream-provider",
    providers: ["stream-provider", "fallback-provider"],
  };

  const projected = projectPublicPlaybackClaim(adversarial, PROFILE);
  assert.deepEqual(projected.context.request, {
    streamProvider: "stream-provider",
    streamProviders: ["stream-provider", "subtitle-provider"],
  });
  assert.deepEqual(projected.context.source, {
    provider: "stream-provider",
    providers: ["stream-provider", "fallback-provider"],
  });
  assert.equal(Array.isArray(projected.context.request.streamProviders), true);
  assert.equal(Array.isArray(projected.context.source.providers), true);
  assert.equal(typeof projected.context.request, "object");
  assert.equal(typeof projected.context.source, "object");
  for (const secret of [
    "nested-resource-secret",
    "nested-type-secret",
    "nested-meta-secret",
    "nested-video-secret",
    "nested-provider-secret",
    "nested-source-secret",
    "Authorization",
    "accessToken",
  ]) {
    assert.equal(JSON.stringify(projected).includes(secret), false, secret);
  }

  const invalidProvenance = JSON.parse(JSON.stringify(claim));
  invalidProvenance.context.request.streamProvider = {
    Authorization: "Bearer provenance-secret",
  };
  assert.throws(
    () => projectPublicPlaybackClaim(invalidProvenance, PROFILE),
    /streamProviders item must be a string/
  );
  invalidProvenance.context.request.streamProvider = "stream-provider";
  invalidProvenance.context.source.provider = { accessToken: "source-provider-secret" };
  assert.throws(
    () => projectPublicPlaybackClaim(invalidProvenance, PROFILE),
    /providers item must be a string/
  );
});

test("public projection omits private Stremio subtitle behavior hints", async () => {
  const harness = createHarness();
  const url = "https://media.example/private-subtitle-hints.mkv";
  const context = privateContext(url, []);
  context.request.videoHash = "0123456789abcdef";
  context.request.videoSize = 987654321;
  context.request.filename = "Private.Movie.mkv";
  const recorded = await harness.repository.record(PROFILE, context);
  const request = {
    fingerprints: recorded.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: harness.now(),
  };
  const claim = await harness.repository.claim(
    PROFILE,
    DEVICE,
    request,
    claimAuthority(request)
  );
  const active = await harness.repository.getActiveClaim(PROFILE, DEVICE, claim.sessionId);
  assert.equal(active.context.request.videoHash, "0123456789abcdef");
  assert.equal(active.context.request.videoSize, 987654321);
  assert.equal(active.context.request.filename, "Private.Movie.mkv");

  const projected = projectPublicPlaybackClaim(active, PROFILE);
  assert.equal(Object.hasOwn(projected.context.request, "videoHash"), false);
  assert.equal(Object.hasOwn(projected.context.request, "videoSize"), false);
  assert.equal(Object.hasOwn(projected.context.request, "filename"), false);
});

test("playback repository contract requires getActiveClaim", () => {
  assert.equal(REPOSITORY_CONTRACTS.playbackContexts.includes("getActiveClaim"), true);
  const incomplete = {};
  for (const method of REPOSITORY_CONTRACTS.playbackContexts) {
    if (method !== "getActiveClaim") incomplete[method] = () => {};
  }
  assert.throws(
    () => assertRepository("playbackContexts", incomplete),
    /must implement getActiveClaim\(\)/
  );
  assert.equal(assertRepository("playbackContexts", new MemoryPlaybackContextRepository()) instanceof MemoryPlaybackContextRepository, true);
});
