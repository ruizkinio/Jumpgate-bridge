"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  MAX_RESPONSE_BYTES,
  ProviderResponseError,
  buildLegacyResourcePayload,
  buildLegacyResourceRequest,
  buildProviderResourceRequest,
  buildStandardResourceUrl,
  classifyTransportUrl,
  decodeResourceRequest,
  isCompatibleTransportUrl,
  isLegacyStreamIdSupported,
  normalizeLegacyResponse,
  normalizeProviderResponse,
  normalizeResourceRequest,
  normalizeStandardResponse,
} = require("../lib/stremio-transport");

// Golden values are pinned to stremio-core 9f5a21054035b2bb406b0710bdc25be0a5942461:
// src/addon_transport/http_transport/http_transport.rs
// src/types/query_params_encode.rs
// src/addon_transport/http_transport/legacy/mod.rs
const PINNED_LEGACY_STREAM_URL =
  "https://legacywatchhub.strem.io/stremio/v1/q.json?b=" +
  "eyJpZCI6MSwianNvbnJwYyI6IjIuMCIsIm1ldGhvZCI6InN0cmVhbS5maW5kIiwicGFyYW1zIjpbbnVsbCx7InF1ZXJ5Ijp7ImVwaXNvZGUiOjEsImltZGJfaWQiOiJ0dDAzODY2NzYiLCJzZWFzb24iOjUsInR5cGUiOiJzZXJpZXMifX1dfQ==";
const PINNED_LEGACY_SUBTITLES_URL =
  "https://legacywatchhub.strem.io/stremio/v1/q.json?b=" +
  "eyJpZCI6MSwianNvbnJwYyI6IjIuMCIsIm1ldGhvZCI6InN1YnRpdGxlcy5maW5kIiwicGFyYW1zIjpbbnVsbCx7InF1ZXJ5Ijp7Iml0ZW1IYXNoIjoidHQwMzg2Njc2IDUgMSIsInZpZGVvSGFzaCI6ImZmZmZmZmZmZmYiLCJ2aWRlb1NpemUiOjEwMDAwMDAwMDB9fV19";

test("resource decoding splits literal separators and preserves duplicate extras", () => {
  const request = decodeResourceRequest({
    resource: "stream",
    type: "movie%2Fspecial",
    id: "private%3Att0133093%252Fcut",
    extra: "token=first&token=second&filename=A%26B%3Dfinal.mkv&empty=",
  });

  assert.deepEqual(request, {
    resource: "stream",
    type: "movie/special",
    id: "private:tt0133093%2Fcut",
    extra: [
      { name: "token", value: "first" },
      { name: "token", value: "second" },
      { name: "filename", value: "A&B=final.mkv" },
      { name: "empty", value: "" },
    ],
  });
});

test("resource components are decoded exactly once", () => {
  const request = decodeResourceRequest("stream", "movie", "private%253Aitem", "x=%2526");
  assert.equal(request.id, "private%3Aitem");
  assert.deepEqual(request.extra, [{ name: "x", value: "%26" }]);
});

test("public decoded-request normalization never performs a second percent decode", () => {
  const request = normalizeResourceRequest({
    resource: "stream",
    type: "movie",
    id: "private%3Aitem",
    extra: [["token", "%26still-encoded"]],
  });

  assert.deepEqual(request, {
    resource: "stream",
    type: "movie",
    id: "private%3Aitem",
    extra: [{ name: "token", value: "%26still-encoded" }],
  });
});

test("resource decoding rejects malformed, oversized, and prototype-dangerous inputs", () => {
  assert.throws(
    () => decodeResourceRequest({ resource: "stream", type: "movie", id: "%C0%AF" }),
    /malformed/
  );
  assert.throws(
    () => decodeResourceRequest({ resource: "stream", type: "movie", id: "id", extra: "missing" }),
    /pair is malformed/
  );
  assert.throws(
    () => decodeResourceRequest({ resource: "stream", type: "movie", id: "id", extra: "__proto__=x" }),
    /prototype-dangerous/
  );
  assert.throws(
    () => decodeResourceRequest({ resource: "stream", type: "movie", id: "x".repeat(8 * 1024 + 1) }),
    /resource id is invalid/
  );
  const dangerous = JSON.parse(
    '{"resource":"stream","type":"movie","id":"id","prototype":"bad"}'
  );
  assert.throws(() => decodeResourceRequest(dangerous), /prototype-dangerous key/);
});

test("standard transport replaces only terminal manifest path and preserves query bytes", () => {
  const transportUrl =
    "https://provider.example/config%2Fopaque/manifest.json?token=a%2Bb&flag&empty=&token=second";
  const request = {
    resource: "stream",
    type: "movie/special",
    id: "private:tt0133093%2Fcut",
    extra: [
      { name: "token", value: "one two" },
      { name: "token", value: "a&b=c" },
    ],
  };

  assert.equal(
    buildStandardResourceUrl(transportUrl, request),
    "https://provider.example/config%2Fopaque/stream/movie%2Fspecial/" +
      "private%3Att0133093%252Fcut/token=one%20two&token=a%26b%3Dc.json" +
      "?token=a%2Bb&flag&empty=&token=second"
  );
});

test("standard transport uses encodeURIComponent semantics for every path value", () => {
  assert.equal(
    buildStandardResourceUrl("http://provider.example/manifest.json", {
      resource: "stream",
      type: "movie",
      id: "AZaz09-_.!~*'() :/",
      extra: [["na me", "!'()&="]],
    }),
    "http://provider.example/stream/movie/AZaz09-_.!~*'()%20%3A%2F/na%20me=!'()%26%3D.json"
  );
});

test("transport URL validation rejects userinfo, fragments, schemes, and terminal mismatches", () => {
  for (const value of [
    "https://user:secret@provider.example/manifest.json",
    "https://@provider.example/manifest.json",
    "https://provider.example/manifest.json#",
    "ftp://provider.example/manifest.json",
    "https://provider.example\\redirect/manifest.json",
    "https://provider.example/manifest.json/next",
    "https://provider.example/not-manifest.json",
  ]) {
    assert.throws(
      () => buildStandardResourceUrl(value, { resource: "stream", type: "movie", id: "id" }),
      /transport URL/
    );
  }
  assert.throws(
    () => buildLegacyResourceRequest("https://provider.example/stremio/v1?token=x", {
      resource: "stream",
      type: "movie",
      id: "tt0133093",
    }),
    /terminal path/
  );
});

test("compatibility predicate exactly matches runtime-supported terminal transports", () => {
  const supported = [
    "https://provider.example/manifest.json",
    "http://provider.example/config/manifest.json?token=a%2Bb&flag&empty=",
    "https://provider.example/stremio/v1",
  ];
  const unsupported = [
    "https://provider.example/not-manifest",
    "https://provider.example/MANIFEST.JSON",
    "https://provider.example/manifest.json/",
    "https://provider.example/%6danifest.json",
    "https://provider.example/stremio/V1",
    "https://provider.example/stremio/v1?token=private",
  ];
  const request = { resource: "stream", type: "movie", id: "tt0133093" };

  for (const transportUrl of supported) {
    assert.equal(isCompatibleTransportUrl(transportUrl), true, transportUrl);
    assert.doesNotThrow(() => buildProviderResourceRequest(transportUrl, request));
  }
  for (const transportUrl of unsupported) {
    assert.equal(isCompatibleTransportUrl(transportUrl), false, transportUrl);
    assert.throws(() => buildProviderResourceRequest(transportUrl, request), /transport URL/);
  }
});

test("legacy stream request exactly matches the pinned JSON-RPC golden", () => {
  const request = buildLegacyResourceRequest("https://legacywatchhub.strem.io/stremio/v1", {
    resource: "stream",
    type: "series",
    id: "tt0386676:5:1",
    extra: [],
  });

  assert.equal(request.url, PINNED_LEGACY_STREAM_URL);
  assert.equal(request.method, "GET");
  assert.deepEqual(JSON.parse(request.json), {
    id: 1,
    jsonrpc: "2.0",
    method: "stream.find",
    params: [
      null,
      { query: { episode: 1, imdb_id: "tt0386676", season: 5, type: "series" } },
    ],
  });
});

test("legacy subtitles request exactly matches the pinned JSON-RPC golden", () => {
  const request = buildLegacyResourceRequest("https://legacywatchhub.strem.io/stremio/v1", {
    resource: "subtitles",
    type: "series",
    id: "tt0386676:5:1",
    extra: [
      { name: "videoHash", value: "ffffffffff" },
      { name: "videoSize", value: "1000000000" },
    ],
  });

  assert.equal(request.url, PINNED_LEGACY_SUBTITLES_URL);
  assert.deepEqual(request.payload, {
    params: [
      null,
      {
        query: {
          itemHash: "tt0386676 5 1",
          videoHash: "ffffffffff",
          videoSize: 1000000000,
        },
      },
    ],
    method: "subtitles.find",
    id: 1,
    jsonrpc: "2.0",
  });
});

test("legacy payload maps private IDs and only the first matching subtitle extra", () => {
  assert.deepEqual(
    buildLegacyResourcePayload({
      resource: "stream",
      type: "anime",
      id: "kitsu:42:episode-7",
      extra: [],
    }).params[1].query,
    { kitsu: "42", video_id: "episode-7", type: "anime" }
  );
  assert.deepEqual(
    buildLegacyResourcePayload({
      resource: "subtitles",
      type: "movie",
      id: "private:item",
      extra: [
        { name: "videoHash", value: "first" },
        { name: "videoHash", value: "second" },
        { name: "videoSize", value: "not-a-number" },
        { name: "filename", value: "Movie.mkv" },
      ],
    }).params[1].query,
    { itemHash: "private item", videoHash: "first", filename: "Movie.mkv" }
  );
  assert.throws(
    () =>
      buildLegacyResourcePayload({
        resource: "stream",
        type: "movie",
        id: "__proto__:value",
      }),
    /prototype-dangerous prefix/
  );
});

test("legacy stream support accepts only safely representable ID shapes", () => {
  for (const id of ["tt0133093", "tt0386676:5:1", "UC123", "UC123:video", "kitsu:42", "kitsu:42:7"]) {
    assert.equal(isLegacyStreamIdSupported(id), true, id);
    assert.doesNotThrow(() =>
      buildLegacyResourcePayload({ resource: "stream", type: "movie", id })
    );
  }
  for (const id of [
    "local-id",
    "a:b:c:d",
    "__proto__:value",
    "ttbad",
    "tt0133093:2",
    "tt0133093:2:3:4",
    "tt0133093:not-a-season:7",
    "tt0133093:70000:1",
    "tt0133093:1:-1",
    "UC123:",
    "UC123:video:ignored",
    "kitsu:",
    "kitsu:42:",
  ]) {
    assert.equal(isLegacyStreamIdSupported(id), false, id);
    assert.throws(
      () => buildLegacyResourcePayload({ resource: "stream", type: "movie", id }),
      /supported id shape|prototype-dangerous prefix/
    );
  }
});

test("legacy videoSize serialization matches pinned serde_json number forms", () => {
  const fixtures = new Map([
    ["1.0", "1.0"],
    ["1e3", "1000.0"],
    ["1e-6", "1e-6"],
    ["9007199254740992", "9007199254740992"],
    ["18446744073709551615", "18446744073709551615"],
    ["18446744073709551616", "1.8446744073709552e19"],
    ["-9223372036854775809", "-9.223372036854776e18"],
  ]);

  for (const [input, serialized] of fixtures) {
    const built = buildLegacyResourceRequest("https://legacy.example/stremio/v1", {
      resource: "subtitles",
      type: "movie",
      id: "private:item",
      extra: [{ name: "videoSize", value: input }],
    });
    assert.match(built.json, new RegExp('"videoSize":' + serialized.replace(".", "\\.")));
    assert.equal(Buffer.from(built.encodedPayload, "base64").toString("utf8"), built.json);
  }
});

test("provider request selection is pure and transport-specific", () => {
  assert.equal(classifyTransportUrl("https://provider.example/manifest.json?token=x"), "v3");
  assert.equal(classifyTransportUrl("http://provider.example/stremio/v1"), "legacy");
  assert.deepEqual(
    buildProviderResourceRequest("https://provider.example/manifest.json", {
      resource: "stream",
      type: "movie",
      id: "private:id",
    }),
    {
      protocol: "v3",
      method: "GET",
      url: "https://provider.example/stream/movie/private%3Aid.json",
    }
  );
});

test("v3 stream and subtitles responses are deep-cloned with unknown fields", () => {
  const streamsInput = {
    streams: [
      {
        url: "https://cdn.example/video?token=private",
        behaviorHints: { proxyHeaders: { request: { Authorization: "secret" } } },
        futureSource: { mode: "preserve-me" },
      },
    ],
    cacheMaxAge: 30,
    futureRoot: { retained: true },
  };
  const subtitlesInput = {
    subtitles: [
      {
        id: "sub-1",
        lang: "en",
        url: "https://sub.example/one.vtt",
        futureSubtitleField: ["retained"],
      },
    ],
    staleRevalidate: 60,
  };
  const streams = normalizeStandardResponse("stream", streamsInput);
  const subtitles = normalizeProviderResponse("v3", "subtitles", subtitlesInput);

  assert.deepEqual(streams, streamsInput);
  assert.deepEqual(subtitles, subtitlesInput);
  assert.notStrictEqual(streams, streamsInput);
  assert.notStrictEqual(streams.streams[0], streamsInput.streams[0]);
  streamsInput.streams[0].futureSource.mode = "changed";
  subtitlesInput.subtitles[0].futureSubtitleField.push("changed");
  assert.equal(streams.streams[0].futureSource.mode, "preserve-me");
  assert.deepEqual(subtitles.subtitles[0].futureSubtitleField, ["retained"]);
});

test("v3 null stream and subtitle roots normalize to empty arrays like pinned Core", () => {
  const streamsInput = { streams: null, cacheMaxAge: 30 };
  const subtitlesInput = { subtitles: null, staleRevalidate: 60 };

  assert.deepEqual(normalizeStandardResponse("stream", streamsInput), {
    streams: [],
    cacheMaxAge: 30,
  });
  assert.deepEqual(normalizeProviderResponse("v3", "subtitles", subtitlesInput), {
    subtitles: [],
    staleRevalidate: 60,
  });
  assert.equal(streamsInput.streams, null);
  assert.equal(subtitlesInput.subtitles, null);
});

test("legacy response roots normalize without narrowing stream or subtitle items", () => {
  const streams = normalizeLegacyResponse("stream", {
    jsonrpc: "2.0",
    id: 1,
    result: [
      {
        url: "https://cdn.example/private",
        unknownStreamSource: { future: true },
      },
    ],
  });
  const subtitles = normalizeLegacyResponse("subtitles", {
    result: {
      id: "tt0386676 5 1",
      all: [
        {
          id: "legacy-sub",
          lang: "en",
          url: "https://sub.example/legacy.srt",
          unknownSubtitleField: 7,
        },
      ],
    },
  });

  assert.deepEqual(streams, {
    streams: [
      {
        url: "https://cdn.example/private",
        unknownStreamSource: { future: true },
      },
    ],
  });
  assert.deepEqual(subtitles, {
    subtitles: [
      {
        id: "legacy-sub",
        lang: "en",
        url: "https://sub.example/legacy.srt",
        unknownSubtitleField: 7,
      },
    ],
  });
});

test("response normalization rejects wrong roots and malformed providers locally", () => {
  for (const operation of [
    () => normalizeStandardResponse("stream", { subtitles: [] }),
    () => normalizeStandardResponse("stream", { streams: {} }),
    () => normalizeStandardResponse("subtitles", { subtitles: [null] }),
    () => normalizeLegacyResponse("stream", { result: {} }),
    () => normalizeLegacyResponse("subtitles", { result: { all: [] } }),
    () => normalizeLegacyResponse("subtitles", { result: { id: "id", all: {} } }),
  ]) {
    assert.throws(operation, ProviderResponseError);
  }
  assert.throws(
    () => normalizeLegacyResponse("stream", { error: { code: -32603, message: "provider failed" } }),
    (error) => error instanceof ProviderResponseError && error.rpcCode === -32603
  );
  const dangerous = JSON.parse('{"streams":[{"__proto__":{"polluted":true}}]}');
  assert.throws(() => normalizeStandardResponse("stream", dangerous), /prototype-dangerous/);
});

test("response normalization rejects oversized response objects", () => {
  assert.throws(
    () =>
      normalizeStandardResponse("stream", {
        streams: [{ futureField: "x".repeat(MAX_RESPONSE_BYTES) }],
      }),
    /size limit/
  );
});
