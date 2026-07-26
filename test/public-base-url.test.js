"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createPublicBaseUrlResolver,
  isLoopbackHostname,
  normalizePublicBaseUrl,
} = require("../lib/public-base-url");

function request(protocol, host, forwardedHost) {
  return {
    protocol,
    headers: { "x-forwarded-host": forwardedHost || "" },
    get(name) {
      return String(name).toLowerCase() === "host" ? host : "";
    },
  };
}

test("production requires one canonical HTTPS public origin", () => {
  assert.throws(
    () => createPublicBaseUrlResolver({ NODE_ENV: "production" }),
    /PUBLIC_BASE_URL is required/
  );
  assert.throws(
    () =>
      createPublicBaseUrlResolver({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "http://bridge.example",
      }),
    /must use HTTPS/
  );

  const resolve = createPublicBaseUrlResolver({
    NODE_ENV: "production",
    PUBLIC_BASE_URL: "https://bridge.example:8443/",
  });
  assert.equal(resolve(request("http", "attacker.example", "attacker.example")), "https://bridge.example:8443");
});

test("public origins reject embedded capabilities and ambiguous URL material", () => {
  for (const value of [
    "https://user@bridge.example",
    "https://bridge.example/path",
    "https://bridge.example/?config=secret",
    "https://bridge.example/#fragment",
    " https://bridge.example",
    "ftp://bridge.example",
  ]) {
    assert.throws(() => normalizePublicBaseUrl(value), /PUBLIC_BASE_URL/);
  }
  assert.equal(normalizePublicBaseUrl("https://BRIDGE.example/"), "https://bridge.example");
});

test("unconfigured development derives only a loopback Host and ignores forwarded host", () => {
  const resolve = createPublicBaseUrlResolver({ NODE_ENV: "development" });
  assert.equal(resolve(request("http", "localhost:7515", "attacker.example")), "http://localhost:7515");
  assert.equal(resolve(request("https", "127.23.45.67:7515")), "https://127.23.45.67:7515");
  assert.equal(resolve(request("http", "[::1]:7515")), "http://[::1]:7515");
  assert.throws(() => resolve(request("https", "attacker.example")), /required for non-loopback/);
  assert.throws(() => resolve(request("https", "localhost.attacker.example")), /required for non-loopback/);
});

test("loopback hostname classification is exact", () => {
  for (const value of ["localhost", "LOCALHOST", "127.0.0.1", "127.255.255.254", "[::1]"]) {
    assert.equal(isLoopbackHostname(value), true, value);
  }
  for (const value of ["localhost.example", "128.0.0.1", "0.0.0.0", "::ffff:127.0.0.1", "bridge.example"]) {
    assert.equal(isLoopbackHostname(value), false, value);
  }
});
