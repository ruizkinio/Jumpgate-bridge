"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  computeAdvertisedCapabilities,
  isProviderResourceSupported,
  isResourceSupported,
  providerGatewayCapabilities,
} = require("../lib/provider-support");

// These fixtures pin Manifest::is_resource_supported from stremio-core
// 9f5a21054035b2bb406b0710bdc25be0a5942461:
// src/types/addon/manifest.rs
function manifest(overrides = {}) {
  return {
    id: "org.example.provider",
    version: "1.0.0",
    name: "Provider",
    types: ["movie", "series"],
    resources: ["stream", "subtitles"],
    idPrefixes: ["tt"],
    catalogs: [],
    addonCatalogs: [],
    ...overrides,
  };
}

function descriptor(transportUrl, manifestOverrides = {}) {
  return {
    transportUrl,
    manifest: manifest(manifestOverrides),
    unknownDescriptorField: { retained: true },
  };
}

function request(resource, type, id, extra = []) {
  return { resource, type, id, extra };
}

test("short resources use manifest-global types and exact id prefix matching", () => {
  const value = manifest({
    types: ["movie", "series"],
    resources: ["stream"],
    idPrefixes: ["tt", "kitsu:"],
  });

  assert.equal(isResourceSupported(value, request("stream", "movie", "tt0133093")), true);
  assert.equal(isResourceSupported(value, request("stream", "series", "kitsu:42")), true);
  assert.equal(isResourceSupported(value, request("stream", "anime", "kitsu:42")), false);
  assert.equal(isResourceSupported(value, request("stream", "movie", "TT0133093")), false);
  assert.equal(isResourceSupported(value, request("subtitles", "movie", "tt0133093")), false);
});

test("short resources accept every id when global prefixes are absent or empty", () => {
  for (const idPrefixes of [undefined, null, []]) {
    const value = manifest({ resources: ["stream"], idPrefixes });
    assert.equal(
      isResourceSupported(value, request("stream", "movie", "addon-private:tt0133093")),
      true
    );
  }
});

test("full resources require their own non-null types and do not inherit global prefixes", () => {
  const missingTypes = manifest({
    types: ["movie"],
    idPrefixes: ["tt"],
    resources: [{ name: "stream", idPrefixes: ["tt"] }],
  });
  assert.equal(
    isResourceSupported(missingTypes, request("stream", "movie", "tt0133093")),
    false
  );

  const ownTypes = manifest({
    types: ["series"],
    idPrefixes: ["tt"],
    resources: [{ name: "stream", types: ["movie"], idPrefixes: null }],
  });
  assert.equal(
    isResourceSupported(ownTypes, request("stream", "movie", "addon-private:42")),
    true
  );
  assert.equal(
    isResourceSupported(ownTypes, request("stream", "series", "tt0133093")),
    false
  );

  const emptyPrefixes = manifest({
    resources: [{ name: "stream", types: ["movie"], idPrefixes: [] }],
  });
  assert.equal(
    isResourceSupported(emptyPrefixes, request("stream", "movie", "private:item")),
    true
  );
});

test("only the first matching resource controls support", () => {
  const value = manifest({
    types: ["movie", "series"],
    idPrefixes: [],
    resources: [
      { name: "stream", types: ["movie"], idPrefixes: ["tt"] },
      "stream",
      { name: "stream", types: ["series"], idPrefixes: [] },
    ],
  });

  assert.equal(isResourceSupported(value, request("stream", "movie", "tt0133093")), true);
  assert.equal(isResourceSupported(value, request("stream", "movie", "private:item")), false);
  assert.equal(isResourceSupported(value, request("stream", "series", "tt0133093")), false);
});

test("catalog and addon_catalog support matches type, id, and required extras", () => {
  const value = manifest({
    resources: [],
    catalogs: [
      {
        type: "movie",
        id: "top",
        extra: [
          { name: "genre", isRequired: true },
          { name: "skip", isRequired: false },
        ],
      },
    ],
    addonCatalogs: [
      {
        type: "movie",
        id: "community",
        extraRequired: ["search"],
        extraSupported: ["search", "skip"],
      },
    ],
  });

  assert.equal(
    isResourceSupported(value, request("catalog", "movie", "top", [{ name: "genre", value: "Drama" }])),
    true
  );
  assert.equal(isResourceSupported(value, request("catalog", "movie", "top")), false);
  assert.equal(
    isResourceSupported(value, request("catalog", "movie", "top", [{ name: "search", value: "x" }])),
    false
  );
  assert.equal(
    isResourceSupported(
      value,
      request("addon_catalog", "movie", "community", [["search", "provider"]])
    ),
    true
  );
});

test("configured capability unions include only HTTP(S) compatible descriptors", () => {
  const selected = [
    descriptor("https://one.example/secret/manifest.json?token=a%2Bb", {
      types: ["movie"],
      resources: ["stream"],
      idPrefixes: ["tt"],
    }),
    descriptor("http://two.example/stremio/v1", {
      resources: [
        { name: "stream", types: ["series"], idPrefixes: ["tmdb:"] },
        { name: "subtitles", types: ["movie"], idPrefixes: ["tt"] },
      ],
    }),
    descriptor("https://three.example/manifest.json", {
      types: ["series"],
      resources: [
        { name: "stream", types: ["anime"] },
        "subtitles",
      ],
      idPrefixes: [],
    }),
    descriptor("ws://ignored.example/manifest.json", {
      types: ["tv"],
      resources: ["stream"],
      idPrefixes: [],
    }),
    descriptor("https://user:secret@ignored.example/manifest.json", {
      types: ["channel"],
      resources: ["subtitles"],
      idPrefixes: [],
    }),
  ];

  assert.deepEqual(computeAdvertisedCapabilities(selected), {
    types: ["movie", "series", "anime"],
    idPrefixes: [],
    resources: [
      {
        name: "stream",
        types: ["movie", "series", "anime"],
        idPrefixes: [],
      },
      {
        name: "subtitles",
        types: ["movie", "series"],
        idPrefixes: [],
      },
    ],
  });
});

test("effective capabilities exclude unusable first resources and narrow legacy streams", () => {
  const unusable = descriptor("https://empty.example/manifest.json", {
    types: [],
    resources: ["stream", { name: "subtitles", types: [] }],
  });
  assert.deepEqual(providerGatewayCapabilities(unusable), []);

  const firstWins = descriptor("https://first.example/manifest.json", {
    resources: [
      { name: "stream", types: [] },
      { name: "stream", types: ["movie"], idPrefixes: ["tt"] },
      { name: "subtitles", types: ["series"], idPrefixes: ["tt"] },
    ],
  });
  assert.deepEqual(providerGatewayCapabilities(firstWins), [
    {
      name: "subtitles",
      types: ["series"],
      idPrefixes: ["tt"],
      transportKind: "v3",
    },
  ]);

  const legacy = descriptor("https://legacy.example/stremio/v1", {
    types: ["movie"],
    resources: ["stream"],
    idPrefixes: [],
  });
  assert.deepEqual(providerGatewayCapabilities(legacy), [
    {
      name: "stream",
      types: ["movie"],
      idPrefixes: [],
      transportKind: "legacy",
    },
  ]);
  assert.deepEqual(computeAdvertisedCapabilities([legacy]), {
    types: ["movie"],
    idPrefixes: [],
    resources: [{ name: "stream", types: ["movie"], idPrefixes: [] }],
  });
  assert.equal(isProviderResourceSupported(legacy, request("stream", "movie", "tt0133093")), true);
  assert.equal(isProviderResourceSupported(legacy, request("stream", "movie", "kitsu:42")), true);
  assert.equal(isProviderResourceSupported(legacy, request("stream", "movie", "local-id")), false);
  assert.equal(isProviderResourceSupported(legacy, request("stream", "movie", "a:b:c:d")), false);

  const genericLegacy = descriptor("https://legacy.example/stremio/v1", {
    types: ["anime"],
    resources: ["stream"],
    idPrefixes: ["kitsu:"],
  });
  assert.deepEqual(providerGatewayCapabilities(genericLegacy), [
    {
      name: "stream",
      types: ["anime"],
      idPrefixes: ["kitsu:"],
      transportKind: "legacy",
    },
  ]);
  assert.equal(
    isProviderResourceSupported(genericLegacy, request("stream", "anime", "kitsu:42")),
    true
  );
  assert.equal(
    isProviderResourceSupported(genericLegacy, request("stream", "anime", "kitsu:42:7:extra")),
    false
  );
});

test("capability unions exclude HTTP transports the runtime cannot build", () => {
  const resource = {
    types: ["movie"],
    resources: ["stream"],
    idPrefixes: ["tt"],
  };
  const selected = [
    descriptor("https://standard.example/manifest.json?token=private", resource),
    descriptor("https://legacy.example/stremio/v1", resource),
    descriptor("https://provider.example/not-manifest", resource),
    descriptor("https://case.example/MANIFEST.JSON", resource),
    descriptor("https://legacy-query.example/stremio/v1?token=private", resource),
  ];

  assert.deepEqual(computeAdvertisedCapabilities(selected), {
    types: ["movie"],
    idPrefixes: ["tt"],
    resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
  });
});

test("advertised unions intentionally form a routing-filtered type/prefix superset", () => {
  const movieProvider = descriptor("https://movie.example/manifest.json", {
    resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
  });
  const seriesProvider = descriptor("https://series.example/manifest.json", {
    resources: [{ name: "stream", types: ["series"], idPrefixes: ["tmdb:"] }],
  });
  const advertised = computeAdvertisedCapabilities([movieProvider, seriesProvider]);

  assert.deepEqual(advertised, {
    types: ["movie", "series"],
    idPrefixes: ["tt", "tmdb:"],
    resources: [
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
      },
    ],
  });
  assert.equal(
    isResourceSupported(movieProvider.manifest, request("stream", "movie", "tmdb:550")),
    false
  );
  assert.equal(
    isResourceSupported(seriesProvider.manifest, request("stream", "movie", "tmdb:550")),
    false
  );
  assert.equal(isResourceSupported(advertised, request("stream", "movie", "tmdb:550")), true);
});

test("capability extraction honors first-resource precedence and wrapper selections", () => {
  const wrapped = {
    providerId: "provider-one",
    ordinal: 0,
    descriptor: descriptor("https://provider.example/manifest.json", {
      types: ["series"],
      idPrefixes: [],
      resources: [
        { name: "stream", types: null, idPrefixes: [] },
        "stream",
        { name: "subtitles", types: ["series"], idPrefixes: ["tt"] },
      ],
    }),
  };

  assert.deepEqual(computeAdvertisedCapabilities([wrapped]), {
    types: ["series"],
    idPrefixes: ["tt"],
    resources: [
      { name: "subtitles", types: ["series"], idPrefixes: ["tt"] },
    ],
  });
});

test("capability computation performs no runtime provider fetching", () => {
  const originalFetch = global.fetch;
  global.fetch = () => {
    throw new Error("fetch must not be called");
  };
  try {
    assert.deepEqual(
      computeAdvertisedCapabilities([
        descriptor("https://provider.example/manifest.json", {
          types: ["movie"],
          resources: ["stream"],
          idPrefixes: ["tt"],
        }),
      ]),
      {
        types: ["movie"],
        idPrefixes: ["tt"],
        resources: [{ name: "stream", types: ["movie"], idPrefixes: ["tt"] }],
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("malformed manifests fail closed and descriptor collection size is bounded", () => {
  assert.equal(isResourceSupported(null, request("stream", "movie", "tt0133093")), false);
  assert.equal(
    isResourceSupported(
      manifest({ resources: [{ name: "stream", types: "movie" }] }),
      request("stream", "movie", "tt0133093")
    ),
    false
  );
  assert.deepEqual(
    computeAdvertisedCapabilities([
      null,
      { transportUrl: "https://provider.example/manifest.json", manifest: null },
      descriptor("https://provider.example/not-manifest.json"),
    ]),
    { types: [], idPrefixes: [], resources: [] }
  );
  assert.throws(() => computeAdvertisedCapabilities(new Array(65).fill(null)), /at most 64/);
});

test("manifest support never reads prototype-polluted inherited constraints", () => {
  const inheritedTypes = Object.prototype.types;
  const inheritedPrefixes = Object.prototype.idPrefixes;
  Object.prototype.types = ["movie"];
  Object.prototype.idPrefixes = [];
  try {
    assert.equal(
      isResourceSupported(
        { resources: ["stream"] },
        request("stream", "movie", "private:item")
      ),
      false
    );
    assert.deepEqual(
      computeAdvertisedCapabilities([
        {
          transportUrl: "https://inherited.example/manifest.json",
          manifest: { resources: ["stream"] },
        },
      ]),
      { types: [], idPrefixes: [], resources: [] }
    );
  } finally {
    if (inheritedTypes === undefined) delete Object.prototype.types;
    else Object.prototype.types = inheritedTypes;
    if (inheritedPrefixes === undefined) delete Object.prototype.idPrefixes;
    else Object.prototype.idPrefixes = inheritedPrefixes;
  }
});
