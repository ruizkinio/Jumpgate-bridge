"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  isPublicAddonPath,
  resolveTrustProxy,
  setBaselineSecurityHeaders,
  setPublicAddonCors,
} = require("../lib/http-boundary");

function headerRecorder() {
  const headers = new Map();
  return {
    headers,
    response: {
      setHeader(name, value) {
        headers.set(String(name).toLowerCase(), String(value));
      },
    },
  };
}

test("proxy trust defaults closed and is explicit in production", () => {
  assert.equal(resolveTrustProxy({ NODE_ENV: "development" }), false);
  assert.equal(resolveTrustProxy({ NODE_ENV: "test", JUMPGATE_TRUST_PROXY: "off" }), false);
  assert.equal(resolveTrustProxy({ NODE_ENV: "production", JUMPGATE_TRUST_PROXY: "1" }), 1);
  assert.equal(resolveTrustProxy({ NODE_ENV: "production", JUMPGATE_TRUST_PROXY: "16" }), 16);
  assert.throws(
    () => resolveTrustProxy({ NODE_ENV: "production" }),
    /JUMPGATE_TRUST_PROXY is required/
  );
  for (const value of ["true", "-1", "17", "loopback", "1,2"]) {
    assert.throws(
      () => resolveTrustProxy({ NODE_ENV: "production", JUMPGATE_TRUST_PROXY: value }),
      /JUMPGATE_TRUST_PROXY/
    );
  }
});

test("CORS classification includes only public Stremio manifest and resource paths", () => {
  for (const path of [
    "/manifest.json",
    "/stream/movie/tt1234567.json",
    "/subtitles/series/tt1234567:1:2.json",
    "/catalog/movie/continue-watching.json",
    "/_c/privateBlob/manifest.json",
    "/_c/privateBlob/stream/movie/tt1234567.json",
    "/privateBlob/subtitles/series/tt1234567:1:2.json",
  ]) {
    assert.equal(isPublicAddonPath(path), true, path);
  }
  for (const path of [
    "/configure",
    "/api/profile/trakt/connect",
    "/auth/trakt/callback",
    "/pair/activate",
    "/api/profile/providers",
    "/v1/playback/claim",
    "/v1/trakt/scrobble/start",
    "/v1/history/" + "a".repeat(64),
    "/pair/device/token",
    "/privateBlob/configure",
    "/unknown",
  ]) {
    assert.equal(isPublicAddonPath(path), false, path);
  }
});

test("HTTP boundary headers are deterministic and HSTS is production-only", () => {
  const development = headerRecorder();
  setBaselineSecurityHeaders(development.response, false);
  assert.equal(development.headers.get("x-content-type-options"), "nosniff");
  assert.equal(development.headers.get("x-frame-options"), "DENY");
  assert.equal(development.headers.has("strict-transport-security"), false);

  const production = headerRecorder();
  setBaselineSecurityHeaders(production.response, true);
  setPublicAddonCors(production.response);
  assert.equal(
    production.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains"
  );
  assert.equal(production.headers.get("access-control-allow-origin"), "*");
  assert.equal(production.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  assert.equal(production.headers.get("access-control-allow-headers"), "Accept, Content-Type");
});
