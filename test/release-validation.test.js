"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const { after, before, test } = require("node:test");

process.env.NODE_ENV = "test";
process.env.CONFIG_SECRET = "release-validation-test-config-secret";
process.env.PUBLIC_BASE_URL = "https://jumpgate-uat.fly.dev";
process.env.JUMPGATE_UAT_MODE = "1";
process.env.JUMPGATE_TEST_UAT_ISSUE_DELAY_MS = "80";
process.env.JUMPGATE_TEST_UAT_POLL_DELAY_MS = "60";
process.env.JUMPGATE_TEST_UAT_EXPIRY_MS = "50";
process.env.JUMPGATE_TEST_GLOBAL_RATE_LIMIT = "10000";

const app = require("../index");
const {
  UAT_SCENARIOS,
  loadReleaseValidationConfig,
} = require("../lib/release-validation");

let server;
let baseUrl;

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await app.closeStorage();
});

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch (_error) {}
  return { response, body };
}

function post(path, body, options = {}) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...options,
  });
}

function configFromPage(html) {
  const match = html.match(
    /<script id="jumpgate-uat-bootstrap"[^>]*>([^<]+)<\/script>/
  );
  assert.ok(match, "release-validation bootstrap is missing");
  const bootstrap = JSON.parse(match[1]);
  assert.match(bootstrap.config, /^[A-Za-z0-9_-]+$/);
  return bootstrap.config;
}

test("UAT configuration is exact and production refuses fault mode", () => {
  assert.deepEqual(UAT_SCENARIOS, [
    "normal",
    "delayed-issue",
    "delayed-poll",
    "short-expiry",
    "rate-limit",
    "terminal-failure",
    "apply-delay",
    "apply-failure",
  ]);
  assert.throws(
    () => loadReleaseValidationConfig({ NODE_ENV: "production", JUMPGATE_UAT_MODE: "1" }),
    /production refuses/
  );
  assert.throws(
    () =>
      loadReleaseValidationConfig({
        NODE_ENV: "uat",
        JUMPGATE_UAT_MODE: "1",
        PUBLIC_BASE_URL: "https://jumpgate-bridge.fly.dev",
      }),
    /exact UAT public origin/
  );
  assert.throws(
    () =>
      loadReleaseValidationConfig({
        NODE_ENV: "uat",
        JUMPGATE_UAT_MODE: "1",
        PUBLIC_BASE_URL: "https://jumpgate-uat.fly.dev",
        JUMPGATE_DURABLE_DRIVER: "postgres",
        JUMPGATE_TTL_DRIVER: "redis",
        TRAKT_CLIENT_SECRET: "must-not-be-used",
      }),
    /refuses external account credentials/
  );
});

test("unknown scenarios fail before pairing state and normal issuance stays unannotated", async () => {
  const repositories = await app.repositoriesForTest();
  const before = repositories.pairings.storageSnapshot().records.length;
  const unknown = await post("/pair/device/code", { validationScenario: "unknown" });
  assert.equal(unknown.response.status, 400);
  assert.equal(repositories.pairings.storageSnapshot().records.length, before);

  const normal = await post("/pair/device/code", {});
  assert.equal(normal.response.status, 200);
  const records = repositories.pairings.storageSnapshot().records;
  assert.equal(records.length, before + 1);
  const record = records.at(-1);
  assert.equal(record.validationScenario, undefined);
  assert.equal(record.validationRateLimitClaimed, undefined);
  const claimed = await repositories.pairings.claimValidation(normal.body.deviceCode);
  assert.equal(claimed, null);
});

test("synthetic activation reuses a valid uncertain-attempt capability after reload", async () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "public", "release-validation.js"),
    "utf8"
  );
  const stored = {
    code: "ABCD2345",
    config: "previousSyntheticConfig",
    retryToken: "r".repeat(43),
  };
  let click;
  let submitted;
  const elements = {
    "jumpgate-uat-bootstrap": { textContent: JSON.stringify({ config: "newSyntheticConfig" }) },
    pairCode: { value: "ABCD-2345" },
    activateBtn: {
      disabled: false,
      addEventListener(name, listener) {
        assert.equal(name, "click");
        click = listener;
      },
    },
    status: { textContent: "" },
  };
  const context = {
    Uint8Array,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    crypto: { getRandomValues: (bytes) => bytes.fill(7) },
    document: { getElementById: (id) => elements[id] },
    fetch: async (_url, options) => {
      submitted = JSON.parse(options.body);
      return { ok: true, json: async () => ({ ok: true }) };
    },
    sessionStorage: {
      getItem: () => JSON.stringify(stored),
      setItem: () => assert.fail("valid recovery state must not be replaced"),
      removeItem() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await click();
  assert.deepEqual(submitted, {
    userCode: stored.code,
    config: stored.config,
    activationRetryToken: stored.retryToken,
  });
});

test("rate-limit scenario is device-code scoped, occurs once, and preserves expiry", async () => {
  const limited = await post("/pair/device/code", { validationScenario: "rate-limit" });
  const normal = await post("/pair/device/code", { validationScenario: "normal" });
  assert.equal(limited.response.status, 200);
  assert.equal(normal.response.status, 200);

  const normalPoll = await post("/pair/device/token", { deviceCode: normal.body.deviceCode });
  assert.equal(normalPoll.response.status, 200);
  assert.equal(normalPoll.body.paired, false);

  const first = await post("/pair/device/token", { deviceCode: limited.body.deviceCode });
  assert.equal(first.response.status, 429);
  assert.equal(first.response.headers.get("retry-after"), "4");
  const second = await post("/pair/device/token", { deviceCode: limited.body.deviceCode });
  assert.equal(second.response.status, 200);
  assert.equal(second.body.paired, false);
  assert.equal(second.body.expiresAt, limited.body.expiresAt);
});

test("aborting delayed issuance leaves no pairing state", async () => {
  const repositories = await app.repositoriesForTest();
  const before = repositories.pairings.storageSnapshot().records.length;
  const controller = new AbortController();
  const pending = post(
    "/pair/device/code",
    { validationScenario: "delayed-issue" },
    { signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(pending, /abort/i);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(repositories.pairings.storageSnapshot().records.length, before);
});

test("short-expiry delayed poll rejects the late response", async () => {
  const issued = await post("/pair/device/code", { validationScenario: "short-expiry" });
  const started = Date.now();
  const result = await post("/pair/device/token", { deviceCode: issued.body.deviceCode });
  assert.equal(result.response.status, 410);
  assert.ok(Date.now() - started >= 40);
  assert.equal(result.body.error, "Pairing expired");
});

test("terminal failure and synthetic-only route boundaries fail closed", async () => {
  const issued = await post("/pair/device/code", { validationScenario: "terminal-failure" });
  const terminal = await post("/pair/device/token", { deviceCode: issued.body.deviceCode });
  assert.equal(terminal.response.status, 422);

  const page = await request("/configure");
  assert.equal(page.response.status, 200);
  assert.match(page.body, /synthetic profile only/i);
  assert.doesNotMatch(page.body, /TMDB v3 API key|Choose Stremio providers|Connect Trakt/);
  const blocked = await request("/v1/playback/claim", { method: "POST" });
  assert.equal(blocked.response.status, 404);
  const generated = await post("/configure/generate", { name: "real profile" });
  assert.equal(generated.response.status, 404);

  const invalidActivation = await post("/pair/activate", {
    userCode: issued.body.userCode,
    config: "not-a-synthetic-config",
    activationRetryToken: Buffer.alloc(32, 7).toString("base64url"),
  });
  assert.equal(invalidActivation.response.status, 400);
  assert.equal(invalidActivation.body.error, "synthetic_config_required");

  const syntheticConfig = configFromPage(page.body);
  assert.match(syntheticConfig, /^[A-Za-z0-9_-]+$/);
});
