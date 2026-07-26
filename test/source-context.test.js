"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { test } = require("node:test");
const {
  SourceContextStore,
  fingerprintStream,
  fingerprintExactUrl,
  hashOpaqueValue,
} = require("../lib/source-context");

const START_MS = Date.parse("2026-07-11T12:00:00.000Z");
const PROFILE_A = "profile-source-context-a";
const PROFILE_B = "profile-source-context-b";
const DEVICE_A = "device-source-context-a";
const DEVICE_B = "device-source-context-b";

function canonicalAttemptId(number, version = 4, variant = "8") {
  return (
    "00000000-0000-" +
    String(version) +
    "000-" +
    variant +
    "000-" +
    String(number).padStart(12, "0")
  );
}

function createHarness(options = {}) {
  let now = START_MS;
  let sequence = 0;
  let attemptSequence = 0;
  const store = new SourceContextStore({
    clock: () => now,
    idFactory: (kind) => `${kind}-${++sequence}`,
    ttlMs: 1_000,
    tombstoneTtlMs: 2_000,
    ...options,
  });
  return {
    store,
    now: () => now,
    nextAttemptId: () => canonicalAttemptId(++attemptSequence),
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

function contextFor(url, overrides = {}) {
  return {
    schemaVersion: 1,
    contentKey: hashOpaqueValue(`content:${url}`),
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
    display: { title: "The Matrix" },
    source: { type: "url", provider: "provider-a" },
    fingerprints: [fingerprintExactUrl(url)],
    inlineSubtitles: [],
    ...overrides,
  };
}

function claimFor(harness, url, overrides = {}) {
  return {
    attemptId: harness.nextAttemptId(),
    fingerprints: [fingerprintExactUrl(url)],
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: new Date(harness.now()).toISOString(),
    client: { platform: "android", version: "3.0.0" },
    ...overrides,
  };
}

function claimAuthority(profileId, deviceId, request, overrides = {}) {
  const requestDigest = createHash("sha256")
    .update(JSON.stringify(request), "utf8")
    .digest("hex");
  const sessionId = "session_" + createHash("sha256")
    .update(profileId + "\0" + deviceId + "\0" + requestDigest, "utf8")
    .digest("hex")
    .slice(0, 32);
  return { sessionId, requestDigest, ...overrides };
}

function claim(store, profileId, deviceId, request, options = {}) {
  return SourceContextStore.prototype.claim.call(
    store,
    profileId,
    deviceId,
    request,
    claimAuthority(profileId, deviceId, request, options)
  );
}

test("fingerprints preserve exact signed URL bytes without exposing the URL", () => {
  const first = "https://cdn.example/video.mkv?token=a%2Bb&expires=7&part=1";
  const reordered = "https://cdn.example/video.mkv?part=1&expires=7&token=a%2Bb";
  const decoded = "https://cdn.example/video.mkv?token=a+b&expires=7&part=1";

  const firstFingerprint = fingerprintExactUrl(first);
  assert.notEqual(firstFingerprint, fingerprintExactUrl(reordered));
  assert.notEqual(firstFingerprint, fingerprintExactUrl(decoded));
  assert.match(firstFingerprint, /^v1:url:sha256:[a-f0-9]{64}$/);
  assert.equal(firstFingerprint.includes(first), false);
  assert.equal(firstFingerprint.includes("token"), false);
});

test("stream fingerprints use Stremio source precedence and deduplicate candidates", () => {
  const result = fingerprintStream(
    {
      url: "https://media.example/direct",
      externalUrl: "https://player.example/frame?id=secret",
      ytId: "dQw4w9WgXcQ",
      infoHash: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
      fileIdx: 4,
    },
    ["custom-provider-secret", fingerprintExactUrl("https://media.example/direct")]
  );

  assert.equal(result.length, 2);
  assert.equal(new Set(result).size, result.length);
  assert.ok(result.some((value) => value.startsWith("v1:url:sha256:")));
  assert.ok(result.some((value) => value.startsWith("v1:opaque:sha256:")));
  assert.equal(result.some((value) => value.startsWith("v1:external-url:")), false);
  assert.equal(result.some((value) => value.startsWith("v1:yt-id:")), false);
  assert.equal(result.some((value) => value.startsWith("v1:info-hash:")), false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("fingerprints pin Stremio torrent indexes and every external source", () => {
  const infoHash = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  assert.deepEqual(fingerprintStream({ infoHash }), [
    "v1:info-hash:abcdef0123456789abcdef0123456789abcdef01:file-idx:-1",
  ]);
  assert.deepEqual(fingerprintStream({ infoHash, fileIdx: -1 }), [
    "v1:info-hash:abcdef0123456789abcdef0123456789abcdef01:file-idx:-1",
  ]);
  assert.deepEqual(fingerprintStream({ infoHash, fileIdx: 0 }), [
    "v1:info-hash:abcdef0123456789abcdef0123456789abcdef01:file-idx:0",
  ]);
  assert.deepEqual(fingerprintStream({ infoHash, fileIdx: 65535 }), [
    "v1:info-hash:abcdef0123456789abcdef0123456789abcdef01:file-idx:65535",
  ]);

  const fingerprints = fingerprintStream({
    externalUrl: "https://example.test/web",
    androidTvUrl: "intent://example.test/tv",
    tizenUrl: "tizen-payload",
    webosUrl: "webos-payload",
  });
  assert.equal(fingerprints.length, 4);
  for (const type of [
    "external-url",
    "android-tv-url",
    "tizen-url",
    "webos-url",
  ]) {
    assert.ok(fingerprints.some((value) => value.startsWith("v1:" + type + ":sha256:")));
  }
  assert.match(
    fingerprintStream({ playerFrameUrl: "https://example.test/frame" })[0],
    /^v1:player-frame-url:sha256:[a-f0-9]{64}$/
  );
});

test("archive, NZB, and proxy fingerprints are canonical, distinct, and secret-free", () => {
  const firstArchive = fingerprintStream({
    zipUrls: [["https://archive.example/a.zip?token=secret", 123]],
    fileIdx: 2,
    fileMustInclude: ["episode.mkv"],
  });
  const repeatedArchive = fingerprintStream({
    fileMustInclude: ["episode.mkv"],
    fileIdx: "2",
    zipUrls: [["https://archive.example/a.zip?token=secret", 123]],
  });
  assert.deepEqual(repeatedArchive, firstArchive);
  assert.match(firstArchive[0], /^v1:archive-zip:sha256:[a-f0-9]{64}$/);
  assert.equal(firstArchive[0].includes("secret"), false);
  assert.notDeepEqual(
    fingerprintStream({ zipUrls: [["https://archive.example/b.zip", 123]], fileIdx: 2 }),
    firstArchive
  );

  const nzbSource = {
    nzbUrl: "https://usenet.example/file.nzb?key=secret",
    nzbUrls: [],
    servers: ["nntps://user:pass@news.example"],
  };
  const nzb = fingerprintStream(nzbSource);
  assert.match(nzb[0], /^v1:nzb-source:sha256:[a-f0-9]{64}$/);
  assert.equal(nzb[0].includes("secret"), false);
  assert.notDeepEqual(fingerprintStream({ ...nzbSource, fileIdx: 3 }), nzb);
  const filteredNzb = fingerprintStream({
    ...nzbSource,
    fileIdx: -1,
    fileMustInclude: ["Season 02", "episode-private.mkv"],
  });
  assert.notDeepEqual(filteredNzb, nzb);
  assert.notDeepEqual(
    fingerprintStream({
      ...nzbSource,
      fileIdx: -1,
      fileMustInclude: ["episode-private.mkv", "Season 02"],
    }),
    filteredNzb
  );
  assert.deepEqual(
    fingerprintStream({ ...nzbSource, fileIdx: "3" }),
    fingerprintStream({ ...nzbSource, fileIdx: 3 })
  );

  const firstProxy = fingerprintStream({
    url: "https://media.example/video.mkv?token=secret",
    behaviorHints: {
      proxyHeaders: {
        request: {
          Authorization: "Bearer private",
          Range: "bytes=0-",
          "Z-Last": "z",
          "a-first": "a",
          "X_Trace": "trace",
        },
        response: { "Content-Type": "video/mp4" },
      },
    },
  });
  const reorderedProxy = fingerprintStream({
    url: "https://media.example/video.mkv?token=secret",
    behaviorHints: {
      proxyHeaders: {
        response: { "content-type": "video/mp4" },
        request: {
          x_trace: "trace",
          "A-FIRST": "a",
          range: "bytes=0-",
          authorization: "Bearer private",
          "z-last": "z",
        },
      },
    },
  });
  assert.deepEqual(reorderedProxy, firstProxy);
  assert.equal(firstProxy.length, 2);
  assert.equal(
    firstProxy[0],
    fingerprintExactUrl("https://media.example/video.mkv?token=secret")
  );
  assert.match(firstProxy[1], /^v1:proxy-source:sha256:[a-f0-9]{64}$/);
  assert.equal(firstProxy.join("|").includes("private"), false);
  assert.equal(firstProxy.join("|").includes("secret"), false);
  assert.throws(
    () =>
      fingerprintStream({
        url: "https://media.example/video.mkv",
        behaviorHints: {
          proxyHeaders: { request: { Authorization: "a", authorization: "b" } },
        },
      }),
    /duplicate case-insensitive header/
  );
  assert.throws(
    () =>
      fingerprintStream({
        url: "https://media.example/video.mkv",
        behaviorHints: { proxyHeaders: { request: { "Bad Header": "value" } } },
      }),
    /ASCII HTTP token/
  );
});

test("torrent pack filters are ordered, canonical, distinct, and secret-free", () => {
  const infoHash = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
  const filters = ["Season 02", "episode-2-private.mkv"];
  const fingerprint = fingerprintStream({ infoHash, fileMustInclude: filters })[0];

  assert.match(
    fingerprint,
    /^v1:info-hash:[a-f0-9]{40}:file-idx:-1:file-must-include:sha256:[a-f0-9]{64}$/
  );
  assert.equal(fingerprintStream({ infoHash, fileMustInclude: filters })[0], fingerprint);
  assert.notEqual(
    fingerprintStream({ infoHash, fileMustInclude: filters.slice().reverse() })[0],
    fingerprint
  );
  assert.notEqual(fingerprintStream({ infoHash })[0], fingerprint);
  assert.equal(fingerprint.includes("Season"), false);
  assert.equal(fingerprint.includes("private"), false);
  assert.deepEqual(fingerprintStream({}, [fingerprint]), [fingerprint]);
  assert.deepEqual(
    fingerprintStream({ infoHash, fileIdx: 4, fileMustInclude: filters }),
    fingerprintStream({ infoHash, fileIdx: 4 })
  );
  assert.throws(
    () => fingerprintStream({ infoHash, fileMustInclude: { f: "episode-2.mkv" } }),
    /bounded array/
  );
});

test("fingerprint validation rejects malformed source combinations", () => {
  assert.throws(() => fingerprintStream({}), /at least one playable-source fingerprint/);
  assert.throws(
    () => fingerprintStream({ fileMustInclude: ["Episode 03"] }),
    /at least one playable-source fingerprint/
  );
  assert.throws(() => fingerprintStream({ fileIdx: 1 }), /requires an infoHash, archive, or NZB/);
  assert.throws(() => fingerprintStream({ infoHash: "a".repeat(64), fileIdx: 1 }), /infoHash/);
  assert.throws(() => fingerprintStream({ infoHash: "a".repeat(40), fileIdx: 65536 }), /fileIdx/);
  const longHash = "v1:info-hash:" + "a".repeat(64) + ":file-idx:1";
  assert.deepEqual(fingerprintStream({}, [longHash]), [
    "v1:opaque:sha256:" + hashOpaqueValue(longHash),
  ]);
  const oversized = "v1:info-hash:" + "a".repeat(40) + ":file-idx:65536";
  assert.deepEqual(fingerprintStream({}, [oversized]), ["v1:opaque:sha256:" + hashOpaqueValue(oversized)]);
  const unselected = "v1:info-hash:" + "a".repeat(40) + ":file-idx:-1";
  assert.deepEqual(fingerprintStream({}, [unselected]), [unselected]);
  const invalidSelectedFilter =
    "v1:info-hash:" +
    "a".repeat(40) +
    ":file-idx:4:file-must-include:sha256:" +
    "b".repeat(64);
  assert.deepEqual(fingerprintStream({}, [invalidSelectedFilter]), [
    "v1:opaque:sha256:" + hashOpaqueValue(invalidSelectedFilter),
  ]);
  assert.throws(() => fingerprintStream({ rarUrls: [] }), /non-empty bounded array/);
  assert.throws(
    () => fingerprintStream({ nzbUrl: "https://nzb.example/file", servers: [] }),
    /servers must not be empty/
  );
});

test("record requires a playable source and returns defensive clones", () => {
  const harness = createHarness();
  const { store } = harness;
  assert.throws(
    () => store.record(PROFILE_A, { source: { type: "unknown" }, fingerprints: [] }),
    /playable-source fingerprint/
  );

  const input = contextFor("https://media.example/clone");
  const recorded = store.record(PROFILE_A, input);
  input.display.title = "Mutated input";
  recorded.display.title = "Mutated return";

  const response = claim(store, PROFILE_A, DEVICE_A, {
    ...claimFor(harness, "https://media.example/clone"),
  });
  assert.equal(response.status, "claimed");
  assert.equal(response.context.display.title, "The Matrix");
});

test("storage projects source and request metadata through explicit allowlists", () => {
  const { store } = createHarness();
  const url = "https://media.example/allowlist.mkv?token=source-secret";
  const recorded = store.record(
    PROFILE_A,
    contextFor(url, {
      request: {
        resource: "stream",
        type: "movie",
        metaId: "tt0133093",
        videoId: "tt0133093",
        metaProvider: "imdb",
        streamProvider: "provider-a",
        authorization: "Bearer request-secret",
        upstream: { password: "request-secret" },
      },
      source: {
        type: "url",
        provider: "provider-a",
        url,
        behaviorHints: {
          proxyHeaders: { request: { Authorization: "Bearer source-secret" } },
        },
        accessToken: "source-secret",
      },
    })
  );

  assert.deepEqual(recorded.source, { type: "url", provider: "provider-a" });
  assert.deepEqual(recorded.request, {
    resource: "stream",
    type: "movie",
    metaId: "tt0133093",
    videoId: "tt0133093",
    metaProvider: "imdb",
    streamProvider: "provider-a",
  });
  assert.equal(JSON.stringify(recorded).includes("source-secret"), false);
  assert.equal(JSON.stringify(recorded).includes("request-secret"), false);
});

test("record rejects invalid canonical and Trakt eligibility states", () => {
  const { store } = createHarness();
  const url = "https://media.example/canonical-validation";

  assert.throws(
    () => store.record(PROFILE_A, contextFor(url, { canonicalIdentity: null, traktEligible: true })),
    /requires a canonicalIdentity/
  );
  assert.throws(
    () =>
      store.record(
        PROFILE_A,
        contextFor(url, {
          canonicalIdentity: {
            provider: "imdb",
            id: "tt0133093:garbage",
            mediaType: "movie",
            season: null,
            episode: null,
            provenance: "metadata-request",
            confidence: "canonical",
          },
        })
      ),
    /exact IMDb id/
  );
});

test("claims are profile isolated, concurrent-device safe, and idempotent", () => {
  const harness = createHarness();
  const url = "https://media.example/profile-isolation";
  harness.store.record(PROFILE_A, contextFor(url));
  const request = claimFor(harness, url);

  const wrongProfile = claim(harness.store, PROFILE_B, DEVICE_A, request);
  assert.equal(wrongProfile.status, "not_found");

  const first = claim(harness.store, PROFILE_A, DEVICE_A, request);
  const replay = claim(harness.store, PROFILE_A, DEVICE_A, request);
  const secondDevice = claim(harness.store, PROFILE_A, DEVICE_B, request);
  assert.equal(first.status, "claimed");
  assert.deepEqual(replay, first);
  assert.equal(secondDevice.status, "claimed");
  assert.notEqual(secondDevice.sessionId, first.sessionId);
});

test("memory claim replay persists and compares every attempt-bound field", () => {
  const harness = createHarness();
  const url = "https://media.example/memory-replay-authority";
  harness.store.record(PROFILE_A, contextFor(url));
  const fingerprint = fingerprintExactUrl(url);
  const request = claimFor(harness, url, {
    attemptId: canonicalAttemptId(100),
    fingerprints: [fingerprint, fingerprint],
  });
  const generation = harness.store.getProfileGeneration(PROFILE_A);
  const authority = claimAuthority(PROFILE_A, DEVICE_A, request, {
    sessionId: "session_memory_replay_0001",
    generation,
    deviceGeneration: 1,
  });
  const first = harness.store.claim(PROFILE_A, DEVICE_A, request, authority);
  const replay = harness.store.claim(PROFILE_A, DEVICE_A, request, authority);
  assert.deepEqual(replay, first);

  const normalizedFingerprints = [fingerprint];
  const claimKey = JSON.stringify([PROFILE_A, DEVICE_A]);
  const attemptKey = JSON.stringify([PROFILE_A, DEVICE_A, request.attemptId]);
  const activeClaim = harness.store._claims.get(claimKey);
  const storedAttempt = harness.store._claimAttempts.get(attemptKey);
  for (const stored of [activeClaim, storedAttempt]) {
    assert.equal(stored.attemptId, request.attemptId);
    assert.deepEqual(stored.fingerprints, normalizedFingerprints);
    assert.equal(stored.intentUrlHash, request.intentUrlHash);
    assert.equal(stored.launchedAtMs, Date.parse(request.launchedAt));
    assert.equal(stored.requestDigest, authority.requestDigest);
    assert.equal(stored.sessionId, authority.sessionId);
    assert.equal(stored.generation, generation);
    assert.equal(stored.deviceGeneration, authority.deviceGeneration);
  }
  assert.deepEqual(activeClaim.response, first);

  const conflicts = [
    [
      "fingerprints",
      { ...request, fingerprints: [fingerprintExactUrl(url + "?changed=1")] },
      authority,
    ],
    [
      "intentUrlHash",
      { ...request, intentUrlHash: hashOpaqueValue("changed-intent") },
      authority,
    ],
    [
      "launchedAtMs",
      { ...request, launchedAt: new Date(harness.now() + 1).toISOString() },
      authority,
    ],
    ["requestDigest", request, { ...authority, requestDigest: "b".repeat(64) }],
    ["sessionId", request, { ...authority, sessionId: "session_memory_replay_0002" }],
    ["generation", request, { ...authority, generation: "g1:changed" }],
    ["deviceGeneration", request, { ...authority, deviceGeneration: 2 }],
  ];
  for (const [field, changedRequest, changedAuthority] of conflicts) {
    assert.throws(
      () => harness.store.claim(
        PROFILE_A,
        DEVICE_A,
        changedRequest,
        changedAuthority
      ),
      (error) => error.code === "claim_request_conflict",
      field + " must remain bound to the attempt"
    );
  }
});

test("different attempts with an identical transport tuple supersede at equal timestamps", () => {
  const harness = createHarness();
  const url = "https://media.example/equal-time-distinct-attempts";
  harness.store.record(PROFILE_A, contextFor(url));
  const firstRequest = claimFor(harness, url, { attemptId: canonicalAttemptId(110) });
  const secondRequest = {
    ...firstRequest,
    attemptId: canonicalAttemptId(111),
  };

  const first = claim(harness.store, PROFILE_A, DEVICE_A, firstRequest);
  const second = claim(harness.store, PROFILE_A, DEVICE_A, secondRequest);

  assert.equal(first.status, "claimed");
  assert.equal(second.status, "claimed");
  assert.notEqual(second.sessionId, first.sessionId);
  const active = harness.store._claims.get(JSON.stringify([PROFILE_A, DEVICE_A]));
  assert.equal(active.attemptId, secondRequest.attemptId);
  assert.equal(active.launchedAtMs, Date.parse(firstRequest.launchedAt));
  assert.equal(harness.store._claimAttempts.size, 2);
});

test("memory persists digest and reserved session for every claim decision", () => {
  const harness = createHarness();
  const firstUrl = "https://media.example/memory-decision-one";
  const secondUrl = "https://media.example/memory-decision-two";
  harness.store.record(PROFILE_A, contextFor(firstUrl));
  harness.store.record(
    PROFILE_A,
    contextFor(secondUrl, {
      contentKey: hashOpaqueValue("content:memory-decision-two"),
      canonicalIdentity: null,
      traktEligible: false,
    })
  );
  const requests = [
    [DEVICE_A, "claimed", claimFor(harness, firstUrl)],
    [
      DEVICE_B,
      "ambiguous",
      {
        ...claimFor(harness, firstUrl),
        fingerprints: [fingerprintExactUrl(firstUrl), fingerprintExactUrl(secondUrl)],
      },
    ],
    [
      "device-source-context-missing",
      "not_found",
      claimFor(harness, "https://media.example/memory-decision-missing"),
    ],
  ];

  for (const [deviceId, status, request] of requests) {
    const authority = claimAuthority(PROFILE_A, deviceId, request);
    const result = harness.store.claim(PROFILE_A, deviceId, request, authority);
    assert.equal(result.status, status);
    assert.equal(result.sessionId, authority.sessionId);
    const stored = harness.store._claims.get(JSON.stringify([PROFILE_A, deviceId]));
    assert.equal(stored.requestDigest, authority.requestDigest);
    assert.equal(stored.sessionId, authority.sessionId);
  }

  const expiredHarness = createHarness();
  const expiredUrl = "https://media.example/memory-decision-expired";
  expiredHarness.store.record(PROFILE_A, contextFor(expiredUrl));
  expiredHarness.advance(1_001);
  const expiredRequest = claimFor(expiredHarness, expiredUrl);
  const expiredAuthority = claimAuthority(PROFILE_A, DEVICE_A, expiredRequest);
  const expired = expiredHarness.store.claim(
    PROFILE_A,
    DEVICE_A,
    expiredRequest,
    expiredAuthority
  );
  assert.deepEqual(expired, { status: "expired", sessionId: expiredAuthority.sessionId });
  const storedExpired = expiredHarness.store._claims.get(JSON.stringify([PROFILE_A, DEVICE_A]));
  assert.equal(storedExpired.requestDigest, expiredAuthority.requestDigest);
  assert.equal(storedExpired.sessionId, expiredAuthority.sessionId);
});

test("memory claim options require exact authority fields", () => {
  const harness = createHarness();
  const request = claimFor(harness, "https://media.example/memory-strict-authority");
  assert.throws(
    () => harness.store.claim(PROFILE_A, DEVICE_A, request),
    /sessionId/
  );
  assert.throws(
    () => harness.store.claim(PROFILE_A, DEVICE_A, request, {
      sessionId: "session_memory_strict_0001",
      requestDigest: "A".repeat(64),
    }),
    /lowercase SHA-256/
  );
  assert.throws(
    () => harness.store.claim(PROFILE_A, DEVICE_A, request, {
      ...claimAuthority(PROFILE_A, DEVICE_A, request),
      ipAddress: "127.0.0.1",
    }),
    /unknown field/
  );
  assert.equal(harness.store.getStats().claims, 0);
});

test("memory claims require lowercase canonical UUID attempt IDs from versions 1 through 8", () => {
  const harness = createHarness();
  const url = "https://media.example/memory-attempt-id-validation";
  harness.store.record(PROFILE_A, contextFor(url));

  for (let version = 1; version <= 8; version += 1) {
    const result = claim(
      harness.store,
      PROFILE_A,
      DEVICE_A,
      claimFor(harness, url, { attemptId: canonicalAttemptId(version, version) })
    );
    assert.equal(result.status, "claimed");
  }
  for (const [index, variant] of ["8", "9", "a", "b"].entries()) {
    const result = claim(
      harness.store,
      PROFILE_A,
      DEVICE_A,
      claimFor(harness, url, {
        attemptId: canonicalAttemptId(10 + index, 4, variant),
      })
    );
    assert.equal(result.status, "claimed");
  }

  const base = claimFor(harness, url);
  const { attemptId: _attemptId, ...missingAttemptId } = base;
  const invalidRequests = [
    missingAttemptId,
    { ...base, attemptId: null },
    { ...base, attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase() },
    { ...base, attemptId: canonicalAttemptId(20, 0) },
    { ...base, attemptId: canonicalAttemptId(21, 9) },
    { ...base, attemptId: canonicalAttemptId(22, 4, "7") },
    { ...base, attemptId: canonicalAttemptId(23, 4, "c") },
    { ...base, attemptId: "not-a-uuid" },
  ];
  for (const invalidRequest of invalidRequests) {
    assert.throws(
      () => claim(harness.store, PROFILE_A, DEVICE_A, invalidRequest),
      /attemptId must be a lowercase canonical UUID/
    );
  }
});

test("device invalidation atomically fences stale claims from recreating state", () => {
  const harness = createHarness();
  const url = "https://media.example/device-generation-race";
  harness.store.record(PROFILE_A, contextFor(url));
  const first = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url), {
    deviceGeneration: 1,
  });
  assert.equal(first.status, "claimed");

  assert.equal(harness.store.invalidateDevice(PROFILE_A, DEVICE_A, 2), true);
  assert.equal(harness.store.invalidateDevice(PROFILE_A, DEVICE_A, 2), false);
  harness.advance(1);
  assert.throws(
    () => claim(harness.store,
      PROFILE_A,
      DEVICE_A,
      claimFor(harness, url, { intentUrlHash: hashOpaqueValue("stale-device-intent") }),
      { deviceGeneration: 1 }
    ),
    (error) => error.code === "device_generation_changed"
  );
  assert.equal(harness.store.getStats().claims, 0);
});

test("profile invalidation removes only that profile's device generation fences", () => {
  const harness = createHarness();
  const urlA = "https://media.example/device-generation-profile-a";
  const urlB = "https://media.example/device-generation-profile-b";
  claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, urlA), {
    deviceGeneration: 1,
  });
  claim(harness.store, PROFILE_B, DEVICE_B, claimFor(harness, urlB), {
    deviceGeneration: 1,
  });

  const generation = harness.store.invalidateProfile(PROFILE_A);
  assert.doesNotThrow(() =>
    claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, urlA), {
      generation,
      deviceGeneration: 2,
    })
  );
  assert.throws(
    () => claim(harness.store, PROFILE_B, DEVICE_B, claimFor(harness, urlB), {
      deviceGeneration: 2,
    }),
    (error) => error.code === "device_generation_changed"
  );
});

test("inactive memory device generation fences expire without weakening active fencing", () => {
  const harness = createHarness({ deviceGenerationTtlMs: 1_000 });
  const url = "https://media.example/device-generation-expiry";
  claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url), {
    deviceGeneration: 1,
  });
  assert.throws(
    () => claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url), {
      deviceGeneration: 2,
    }),
    (error) => error.code === "device_generation_changed"
  );

  harness.advance(1_001);
  harness.store.prune();
  assert.doesNotThrow(() =>
    claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url), {
      deviceGeneration: 2,
    })
  );
});

test("released playback sessions cannot be reclaimed by a stale launch", () => {
  const harness = createHarness();
  const context = harness.store.record(
    PROFILE_A,
    contextFor("https://cdn.example/release.mkv", { contentKey: "release-test" })
  );
  const request = {
    attemptId: harness.nextAttemptId(),
    fingerprints: context.fingerprints,
    intentUrlHash: "a".repeat(64),
    launchedAt: new Date(harness.now()).toISOString(),
  };
  const claimed = claim(harness.store, PROFILE_A, DEVICE_A, request);

  assert.equal(claimed.status, "claimed");
  assert.equal(harness.store.release(PROFILE_A, DEVICE_A, claimed.sessionId), true);
  assert.equal(harness.store.release(PROFILE_A, DEVICE_A, claimed.sessionId), false);
  assert.equal(claim(harness.store, PROFILE_A, DEVICE_A, request).status, "not_found");
  assert.equal(harness.store.release(PROFILE_A, DEVICE_B, claimed.sessionId), false);
});

test("reopening the same stable URL creates a new playback session", () => {
  const harness = createHarness();
  const url = "https://media.example/stable-reopen";
  harness.store.record(PROFILE_A, contextFor(url));

  const first = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url));
  harness.advance(1);
  const reopened = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url));

  assert.equal(first.status, "claimed");
  assert.equal(reopened.status, "claimed");
  assert.notEqual(reopened.sessionId, first.sessionId);
});

test("duplicate candidates are unique and an overlapping context is rejected atomically", () => {
  const harness = createHarness();
  const url = "https://media.example/duplicate";
  const fingerprint = fingerprintExactUrl(url);
  harness.store.record(PROFILE_A, contextFor(url, { fingerprints: [fingerprint, fingerprint] }));

  const unique = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url));
  assert.equal(unique.status, "claimed");

  assert.throws(
    () =>
      harness.store.record(
        PROFILE_A,
        contextFor(url, {
          contentKey: hashOpaqueValue("different-content"),
          canonicalIdentity: null,
          traktEligible: false,
        })
      ),
    (error) => error.code === "context_overlap"
  );
  const claimed = claim(harness.store,
    PROFILE_A,
    DEVICE_B,
    claimFor(harness, url, { intentUrlHash: hashOpaqueValue("second-intent") })
  );
  assert.equal(claimed.status, "claimed");
  assert.equal(harness.store.getStats().contexts, 1);
});

test("equivalent repeated provider responses refresh one context instead of becoming ambiguous", () => {
  const harness = createHarness();
  const url = "https://media.example/repeated";
  const first = harness.store.record(PROFILE_A, contextFor(url));
  harness.advance(1);
  const refreshed = harness.store.record(PROFILE_A, contextFor(url));

  assert.equal(refreshed.contextId, first.contextId);
  assert.equal(harness.store.getStats().contexts, 1);
  assert.equal(claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url)).status, "claimed");
});

test("equivalent fingerprint comparison has set semantics independent of input order", () => {
  const harness = createHarness();
  const firstFingerprint = fingerprintExactUrl("https://media.example/set-a");
  const secondFingerprint = fingerprintExactUrl("https://media.example/set-b");
  const contentKey = hashOpaqueValue("set-equivalent-content");
  const first = harness.store.record(
    PROFILE_A,
    contextFor("https://media.example/unused-a", {
      contentKey,
      fingerprints: [firstFingerprint, secondFingerprint],
    })
  );
  harness.advance(1);
  const reordered = harness.store.record(
    PROFILE_A,
    contextFor("https://media.example/unused-b", {
      contentKey,
      fingerprints: [secondFingerprint, firstFingerprint],
    })
  );

  assert.equal(reordered.contextId, first.contextId);
  assert.deepEqual(reordered.fingerprints, [secondFingerprint, firstFingerprint]);
  assert.equal(harness.store.getStats().contexts, 1);
});

test("equivalent provider contexts retain ordered provenance and inline subtitles", () => {
  const harness = createHarness();
  const url = "https://media.example/shared-provider-source";
  harness.store.record(
    PROFILE_A,
    contextFor(url, {
      request: {
        type: "movie",
        metaId: "tt0133093",
        videoId: "tt0133093",
        streamProvider: "provider-a",
      },
      source: { type: "url", provider: "provider-a" },
      inlineSubtitles: [{ id: "a", lang: "en", url: "https://subs.example/a.vtt" }],
    })
  );
  harness.advance(1);
  harness.store.record(
    PROFILE_A,
    contextFor(url, {
      request: {
        type: "movie",
        metaId: "tt0133093",
        videoId: "tt0133093",
        streamProvider: "provider-b",
      },
      source: { type: "url", provider: "provider-b" },
      inlineSubtitles: [
        { id: "a", lang: "en", url: "https://subs.example/a.vtt" },
        { id: "b", lang: "es", url: "https://subs.example/b.vtt" },
      ],
    })
  );

  const claimed = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url));
  assert.equal(claimed.status, "claimed");
  assert.deepEqual(claimed.context.source.providers, ["provider-a", "provider-b"]);
  assert.deepEqual(claimed.context.request.streamProviders, ["provider-a", "provider-b"]);
  assert.deepEqual(
    claimed.context.inlineSubtitles.map((subtitle) => subtitle.id),
    ["a", "b"]
  );
});

test("equivalent subtitle unions reject a 65th identity without changing stored context", () => {
  const harness = createHarness();
  const url = "https://media.example/subtitle-capacity";
  const first = harness.store.record(
    PROFILE_A,
    contextFor(url, {
      inlineSubtitles: Array.from({ length: 64 }, (_value, index) => ({ id: "s" + index })),
    })
  );
  const before = JSON.stringify(harness.store._contexts.get(first.contextId));
  harness.advance(1);

  assert.throws(
    () =>
      harness.store.record(
        PROFILE_A,
        contextFor(url, { inlineSubtitles: [{ id: "s64" }] })
      ),
    /inlineSubtitles exceeds the maximum array length/
  );
  assert.equal(JSON.stringify(harness.store._contexts.get(first.contextId)), before);
  assert.equal(harness.store.getStats().contexts, 1);
});

test("equivalent subtitle unions reapply aggregate byte and node budgets atomically", () => {
  const cases = [
    {
      name: "bytes",
      expected: /maximum total byte size/,
      subtitles: (prefix) =>
        Array.from({ length: 16 }, (_value, index) => ({
          id: prefix + "-" + index,
          url: prefix.repeat(8_192),
        })),
    },
    {
      name: "nodes",
      expected: /maximum value count/,
      subtitles: (prefix) =>
        Array.from({ length: 16 }, (_value, index) => ({
          id: prefix + "-" + index,
          parts: Array.from({ length: 64 }, (_part, partIndex) => partIndex),
        })),
    },
  ];

  for (const scenario of cases) {
    const url = "https://media.example/aggregate-union-" + scenario.name;
    const firstSubtitles = scenario.subtitles("a");
    const secondSubtitles = scenario.subtitles("b");
    const standalone = createHarness();
    assert.doesNotThrow(() =>
      standalone.store.record(PROFILE_A, contextFor(url, { inlineSubtitles: secondSubtitles }))
    );

    const harness = createHarness();
    const first = harness.store.record(
      PROFILE_A,
      contextFor(url, { inlineSubtitles: firstSubtitles })
    );
    assert.throws(
      () => harness.store.record(PROFILE_A, contextFor(url, { inlineSubtitles: secondSubtitles })),
      scenario.expected
    );
    assert.equal(harness.store.getStats().contexts, 1);
    assert.deepEqual(
      harness.store._contexts.get(first.contextId).context.inlineSubtitles.map((item) => item.id),
      firstSubtitles.map((item) => item.id)
    );
  }
});

test("equivalent refresh rejects malformed candidate and stored provenance or depth", () => {
  const harness = createHarness();
  const url = "https://media.example/provenance-validation";
  const first = harness.store.record(PROFILE_A, contextFor(url));

  assert.throws(
    () =>
      harness.store.record(
        PROFILE_A,
        contextFor(url, { source: { type: "url", provider: "x".repeat(257) } })
      ),
    /providers item exceeds the maximum length/
  );
  assert.throws(
    () =>
      harness.store.record(
        PROFILE_A,
        contextFor(url, {
          request: {
            type: "movie",
            metaId: "tt0133093",
            videoId: "tt0133093",
            streamProviders: { invalid: "shape" },
          },
        })
      ),
    /streamProviders must be an array/
  );

  const stored = harness.store._contexts.get(first.contextId).context;
  stored.source.provider = 42;
  assert.throws(
    () => harness.store.record(PROFILE_A, contextFor(url)),
    /providers item must be a string/
  );

  stored.source.provider = "provider-a";
  stored.request.streamProviders = { invalid: "shape" };
  assert.throws(
    () => harness.store.record(PROFILE_A, contextFor(url)),
    /streamProviders must be an array/
  );

  delete stored.request.streamProviders;
  stored.inlineSubtitles = [{ id: "deep", nested: { a: { b: { c: { d: "too-deep" } } } } }];
  assert.throws(
    () => harness.store.record(PROFILE_A, contextFor(url)),
    /maximum nesting depth/
  );
  assert.equal(harness.store.getStats().contexts, 1);
});

test("equivalent refresh preserves first-observed time for an in-flight launch", () => {
  const harness = createHarness({ ttlMs: 30_000, maxLaunchAgeMs: 60_000 });
  const url = "https://media.example/refresh-race";
  const first = harness.store.record(PROFILE_A, contextFor(url));
  harness.advance(1);
  const launchedAt = new Date(harness.now()).toISOString();
  harness.advance(16_000);
  const refreshed = harness.store.record(PROFILE_A, contextFor(url));

  assert.equal(refreshed.contextId, first.contextId);
  assert.equal(refreshed.createdAt, first.createdAt);
  const claimed = claim(harness.store,
    PROFILE_A,
    DEVICE_A,
    claimFor(harness, url, { launchedAt })
  );
  assert.equal(claimed.status, "claimed");
});

test("newer intents replace active claims and stale switches fail closed", () => {
  const harness = createHarness();
  const firstUrl = "https://media.example/first";
  const secondUrl = "https://media.example/second";
  harness.store.record(PROFILE_A, contextFor(firstUrl));
  harness.store.record(PROFILE_A, contextFor(secondUrl));

  const first = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, firstUrl));
  assert.equal(first.status, "claimed");

  harness.advance(1);
  const second = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, secondUrl));
  assert.equal(second.status, "claimed");
  assert.equal(second.context.fingerprints[0], fingerprintExactUrl(secondUrl));

  const stale = claim(harness.store,
    PROFILE_A,
    DEVICE_A,
    claimFor(harness, firstUrl, {
      intentUrlHash: hashOpaqueValue("stale-third-intent"),
      launchedAt: new Date(START_MS).toISOString(),
    })
  );
  assert.equal(stale.status, "not_found");
});

test("expired fingerprints are distinguished from never-seen fingerprints", () => {
  const harness = createHarness({ ttlMs: 10, tombstoneTtlMs: 20 });
  const url = "https://media.example/expires";
  harness.store.record(PROFILE_A, contextFor(url));
  harness.advance(11);

  const expired = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url));
  assert.equal(expired.status, "expired");

  const unknownUrl = "https://media.example/never-seen";
  const unknown = claim(harness.store, PROFILE_A, DEVICE_B, claimFor(harness, unknownUrl));
  assert.equal(unknown.status, "not_found");

  harness.advance(20);
  const afterTombstone = claim(harness.store,
    PROFILE_A,
    DEVICE_A,
    claimFor(harness, url, {
      intentUrlHash: hashOpaqueValue("post-tombstone-intent"),
      launchedAt: new Date(harness.now()).toISOString(),
    })
  );
  assert.equal(afterTombstone.status, "not_found");
});

test("claims enforce launch freshness and reject contexts created after the launch window", () => {
  const harness = createHarness();
  const url = "https://media.example/late-context";
  const launchedAt = new Date(harness.now()).toISOString();
  harness.advance(15_001);
  harness.store.record(PROFILE_A, contextFor(url));

  const late = claim(harness.store,
    PROFILE_A,
    DEVICE_A,
    claimFor(harness, url, { launchedAt })
  );
  assert.equal(late.status, "not_found");

  assert.throws(
    () =>
      claim(harness.store,
        PROFILE_A,
        DEVICE_B,
        claimFor(harness, url, { launchedAt: new Date(harness.now() + 30_001).toISOString() })
      ),
    /future/
  );
  assert.throws(
    () =>
      claim(harness.store,
        PROFILE_A,
        DEVICE_B,
        claimFor(harness, url, { launchedAt: new Date(harness.now() - 31_001).toISOString() })
      ),
    /too old/
  );
});

test("per-profile capacity rejects newcomers without evicting live contexts or claims", () => {
  const harness = createHarness({
    maxContexts: 2,
    maxContextsPerProfile: 1,
    maxClaims: 2,
    maxClaimsPerProfile: 1,
  });
  const a1 = "https://media.example/a1";
  const a2 = "https://media.example/a2";
  const b1 = "https://media.example/b1";
  harness.store.record(PROFILE_A, contextFor(a1));
  assert.throws(
    () => harness.store.record(PROFILE_A, contextFor(a2)),
    (error) => error.code === "context_capacity"
  );
  harness.store.record(PROFILE_B, contextFor(b1));
  assert.equal(harness.store.getStats().contexts, 2);

  const firstRequest = claimFor(harness, a1);
  const firstClaim = claim(harness.store, PROFILE_A, DEVICE_A, firstRequest);
  assert.equal(firstClaim.status, "claimed");
  harness.advance(1);
  assert.equal(claim(harness.store, PROFILE_B, DEVICE_B, claimFor(harness, b1)).status, "claimed");
  assert.throws(
    () => claim(harness.store, PROFILE_A, "device-source-context-c", claimFor(harness, a1)),
    (error) => error.code === "claim_capacity"
  );
  assert.deepEqual(claim(harness.store, PROFILE_A, DEVICE_A, firstRequest), firstClaim);
  assert.equal(harness.store.getStats().claims, 2);
});

test("profile generations reject late records and invalidation removes claimability", () => {
  let generationSequence = 0;
  const harness = createHarness({
    generationFactory: () => "g1:" + String(++generationSequence),
  });
  const url = "https://media.example/generation-race";
  const staleGeneration = harness.store.getProfileGeneration(PROFILE_A);
  harness.store.record(PROFILE_A, contextFor(url), { generation: staleGeneration });
  const nextGeneration = harness.store.invalidateProfile(PROFILE_A);

  assert.notEqual(nextGeneration, staleGeneration);
  assert.throws(
    () => harness.store.record(PROFILE_A, contextFor(url), { generation: staleGeneration }),
    (error) => error.code === "profile_generation_changed"
  );
  assert.equal(claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url)).status, "not_found");
  harness.store.record(PROFILE_A, contextFor(url), { generation: nextGeneration });
  harness.advance(1);
  assert.equal(
    claim(harness.store,
      PROFILE_A,
      DEVICE_A,
      claimFor(harness, url, { intentUrlHash: hashOpaqueValue("post-clear-intent") })
    ).status,
    "claimed"
  );
});

test("profile invalidation fails finitely when the generation factory cannot advance", () => {
  const harness = createHarness({ generationFactory: () => "g1:0" });
  assert.throws(
    () => harness.store.invalidateProfile(PROFILE_A),
    (error) => error.code === "profile_generation_collision"
  );
  assert.equal(harness.store.getProfileGeneration(PROFILE_A), "g1:0");
  assert.deepEqual(harness.store.getStats(), { claims: 0, contexts: 0, tombstones: 0 });
});

test("global capacity rejects newcomers instead of evicting another profile", () => {
  const harness = createHarness({
    maxContexts: 2,
    maxContextsPerProfile: 2,
    maxClaims: 2,
    maxClaimsPerProfile: 2,
  });
  const a = "https://media.example/capacity-a";
  const b = "https://media.example/capacity-b";
  const c = "https://media.example/capacity-c";
  harness.store.record(PROFILE_A, contextFor(a));
  harness.store.record(PROFILE_B, contextFor(b));

  assert.throws(
    () => harness.store.record("profile-source-context-c", contextFor(c)),
    (error) => error.code === "context_capacity"
  );
  assert.equal(claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, a)).status, "claimed");
  assert.equal(claim(harness.store, PROFILE_B, DEVICE_B, claimFor(harness, b)).status, "claimed");
  assert.throws(
    () => claim(harness.store, PROFILE_A, "device-source-context-c", claimFor(harness, a)),
    (error) => error.code === "claim_capacity"
  );
  assert.equal(harness.store.getStats().contexts, 2);
  assert.equal(harness.store.getStats().claims, 2);
});

test("claim validation rejects IP, malformed, oversized, and prototype inputs", () => {
  const harness = createHarness();
  const url = "https://media.example/validate";
  harness.store.record(PROFILE_A, contextFor(url));
  const valid = claimFor(harness, url);

  assert.throws(() => claim(harness.store, PROFILE_A, DEVICE_A, { ...valid, ip: "127.0.0.1" }), /IP inputs/);
  assert.throws(
    () => claim(harness.store, PROFILE_A, DEVICE_A, { ...valid, client: { ipAddress: "127.0.0.1" } }),
    /IP inputs/
  );
  assert.throws(() => claim(harness.store, PROFILE_A, DEVICE_A, { ...valid, fingerprints: [] }), /non-empty array/);
  assert.throws(() => claim(harness.store, PROFILE_A, DEVICE_A, { ...valid, intentUrlHash: "not-a-hash" }), /SHA-256/);
  assert.throws(() => claim(harness.store, PROFILE_A, DEVICE_A, { ...valid, launchedAt: "invalid" }), /valid timestamp/);
  assert.throws(
    () => claim(harness.store, PROFILE_A, DEVICE_A, { ...valid, client: { note: "x".repeat(9_000) } }),
    /maximum length/
  );
  assert.throws(() => claim(harness.store, PROFILE_A, DEVICE_A, Object.create({ fingerprints: [] })), /plain object/);
});

test("context validation enforces an aggregate byte budget", () => {
  const harness = createHarness();
  const url = "https://media.example/aggregate-size";
  const inlineSubtitles = Array.from({ length: 40 }, (_value, index) => ({
    id: String(index),
    lang: "eng",
    url: "x".repeat(8_192),
  }));

  assert.throws(
    () => harness.store.record(PROFILE_A, contextFor(url, { inlineSubtitles })),
    /maximum total byte size/
  );
});

test("context validation rejects unsafe numbers and empty objects in array fields", () => {
  const harness = createHarness();
  const url = "https://media.example/strict-json-shape";
  assert.throws(
    () => harness.store.record(PROFILE_A, contextFor(url, { inlineSubtitles: {} })),
    /inlineSubtitles must be an array/
  );
  assert.throws(
    () =>
      harness.store.record(
        PROFILE_A,
        contextFor(url, { source: { type: "url", providers: {} } })
      ),
    /providers must be an array/
  );
  assert.throws(
    () => harness.store.record(PROFILE_A, contextFor(url, { display: { score: 1.5 } })),
    /non-safe integer/
  );
  assert.throws(
    () =>
      harness.store.record(
        PROFILE_A,
        contextFor(url, {
          source: {
            type: "url",
            provider: "provider-a",
            ignoredSequence: Number.MAX_SAFE_INTEGER + 1,
          },
        })
      ),
    /non-safe integer/
  );
  assert.throws(
    () =>
      harness.store.record(
        PROFILE_A,
        contextFor(url, {
          request: { type: "movie", ignoredVersion: 1.5 },
        })
      ),
    /non-safe integer/
  );
  assert.throws(
    () =>
      harness.store.record(
        PROFILE_A,
        contextFor(url, { display: { score: Number.MAX_SAFE_INTEGER + 1 } })
      ),
    /non-safe integer/
  );
  assert.equal(harness.store.getStats().contexts, 0);
});

test("unknown canonical identity remains local-only and claim metadata does not leak media URL", () => {
  const harness = createHarness();
  const url = "https://media.example/private?token=do-not-return";
  harness.store.record(
    PROFILE_A,
    contextFor(url, {
      canonicalIdentity: null,
      traktEligible: false,
      source: { type: "url", provider: "opaque-provider" },
    })
  );

  const response = claim(harness.store, PROFILE_A, DEVICE_A, claimFor(harness, url));
  assert.equal(response.status, "claimed");
  assert.equal(response.context.canonicalIdentity, null);
  assert.equal(response.context.traktEligible, false);
  assert.equal(JSON.stringify(response).includes(url), false);
  assert.equal(JSON.stringify(response).includes("do-not-return"), false);
});
