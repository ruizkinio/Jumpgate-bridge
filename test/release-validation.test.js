"use strict";

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const { after, before, test } = require("node:test");
const { fingerprintStream, hashOpaqueValue } = require("../lib/source-context");

process.env.NODE_ENV = "test";
process.env.CONFIG_SECRET = "release-validation-test-config-secret";
process.env.PUBLIC_BASE_URL = "https://jumpgate-uat.fly.dev";
process.env.JUMPGATE_UAT_MODE = "1";
process.env.JUMPGATE_UAT_VOBSUB_FIXTURE = "1";
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

app.setProviderGatewayFetchPolicyForTest({
  async fetchJson(url, options = {}) {
    const parsed = new URL(url);
    const response = await fetch(baseUrl + parsed.pathname + parsed.search, {
      signal: options.signal,
    });
    if (!response.ok) throw new Error("fixture provider request failed");
    return { value: await response.json() };
  },
});
app.setSubtitleSourceFetchPolicyForTest({
  async fetchBuffer(url, options = {}) {
    const parsed = new URL(url);
    const response = await fetch(baseUrl + parsed.pathname + parsed.search, {
      signal: options.signal,
    });
    if (!response.ok) throw new Error("fixture subtitle request failed");
    return {
      body: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "",
      finalUrl: url,
    };
  },
});

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

async function requestBytes(path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  return { response, body: Buffer.from(await response.arrayBuffer()) };
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
  assert.throws(
    () =>
      loadReleaseValidationConfig({
        NODE_ENV: "production",
        JUMPGATE_UAT_VOBSUB_FIXTURE: "1",
      }),
    /production refuses JUMPGATE_UAT_VOBSUB_FIXTURE/
  );
  assert.throws(
    () =>
      loadReleaseValidationConfig({
        NODE_ENV: "uat",
        JUMPGATE_UAT_VOBSUB_FIXTURE: "1",
      }),
    /requires JUMPGATE_UAT_MODE/
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
    installControls: { hidden: true },
    installAddon: { href: "" },
    copyManifest: { addEventListener() {} },
  };
  const context = {
    Uint8Array,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    crypto: { getRandomValues: (bytes) => bytes.fill(7) },
    document: { getElementById: (id) => elements[id] },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (_url, options) => {
      submitted = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          manifestUrl: "https://jumpgate-uat.fly.dev/_c/config/manifest.json",
          installUrl: "stremio://jumpgate-uat.fly.dev/_c/config/manifest.json",
        }),
      };
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
  assert.equal(elements.installControls.hidden, false);
  assert.match(elements.status.textContent, /fixture provider applied/i);
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
  assert.equal(blocked.response.status, 401);
  assert.equal(blocked.body.error, "device_auth_required");
  const unmanagedDelete = await request("/api/profile", { method: "DELETE" });
  assert.equal(unmanagedDelete.response.status, 401);
  assert.equal(unmanagedDelete.body.error, "management_auth_required");
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

test("synthetic activation seeds one exact provider and exposes only private fixture media", async () => {
  const page = await request("/configure");
  const config = configFromPage(page.body);
  const issued = await post("/pair/device/code", { validationScenario: "normal" });
  const activationRetryToken = Buffer.alloc(32, 19).toString("base64url");
  const activationRequest = {
    userCode: issued.body.userCode,
    config,
    activationRetryToken,
  };
  const activated = await post("/pair/activate", activationRequest);
  assert.equal(activated.response.status, 200);
  assert.equal(activated.body.ok, true);
  assert.equal(activated.body.paired, true);
  assert.match(activated.body.manifestUrl, new RegExp("/_c/" + config + "/manifest\\.json$"));
  assert.match(activated.body.installUrl, /^stremio:\/\//);

  const repositories = await app.repositoriesForTest();
  const providers = await repositories.providers.list(activated.body.profileId);
  assert.equal(providers.revision, 1);
  assert.equal(providers.providers.length, 1);
  assert.equal(providers.providers[0].descriptor.manifest.id, "com.jumpgate.uat.vobsub-fixture");
  assert.equal(
    providers.providers[0].descriptor.transportUrl,
    `https://jumpgate-uat.fly.dev/_c/${config}/uat-vobsub/manifest.json`
  );

  const retried = await post("/pair/activate", activationRequest);
  assert.equal(retried.response.status, 200);
  const afterRetry = await repositories.providers.list(activated.body.profileId);
  assert.equal(afterRetry.revision, 1);
  assert.equal(afterRetry.providers.length, 1);

  const manifest = await request(`/_c/${config}/manifest.json`);
  assert.equal(manifest.response.status, 200);
  assert.ok(manifest.body.catalogs.some((entry) => entry.id === "jumpgate-uat-vobsub"));
  assert.ok(manifest.body.resources.some((entry) =>
    typeof entry === "object" && entry.name === "subtitles"
  ));

  const providerManifest = await request(`/_c/${config}/uat-vobsub/manifest.json`);
  assert.equal(providerManifest.response.status, 200);
  assert.equal(providerManifest.body.id, "com.jumpgate.uat.vobsub-fixture");
  const catalog = await request(`/_c/${config}/catalog/movie/jumpgate-uat-vobsub.json`);
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.body.metas[0].id, "jumpgate-uat-vobsub-v1");
  const stream = await request(
    `/_c/${config}/uat-vobsub/stream/movie/jumpgate-uat-vobsub-v1.json`
  );
  assert.equal(stream.response.status, 200);
  assert.match(stream.body.streams[0].url, /jumpgate-uat-vobsub-v1\.mp4$/);
  const subtitles = await request(
    `/_c/${config}/uat-vobsub/subtitles/movie/jumpgate-uat-vobsub-v1.json`
  );
  assert.equal(subtitles.response.status, 200);
  assert.match(subtitles.body.subtitles[0].url, /jumpgate-uat-vobsub-v1\.zip$/);
  for (const separator of ["=", "%3D"]) {
    const aggregate = await request(
      `/_c/${config}/subtitles/movie/jumpgate-uat-vobsub-v1/filename${separator}jumpgate-uat-vobsub-v1.mp4.json`
    );
    assert.equal(aggregate.response.status, 200);
    assert.equal(aggregate.body.subtitles.length, 1);
  }
  const arbitraryExtra = await request(
    `/_c/${config}/subtitles/movie/jumpgate-uat-vobsub-v1/filename=other.mp4.json`
  );
  assert.equal(arbitraryExtra.response.status, 404);
  const allowedPreflight = await request(
    `/_c/${config}/subtitles/movie/jumpgate-uat-vobsub-v1/filename=jumpgate-uat-vobsub-v1.mp4.json`,
    { method: "OPTIONS" }
  );
  assert.equal(allowedPreflight.response.status, 204);
  const blockedPreflight = await request(
    `/_c/${config}/subtitles/movie/jumpgate-uat-vobsub-v1/filename=other.mp4.json`,
    { method: "OPTIONS" }
  );
  assert.equal(blockedPreflight.response.status, 404);

  const mediaPath = `/_c/${config}/uat-vobsub/media/jumpgate-uat-vobsub-v1.mp4`;
  const mediaHead = await request(mediaPath, { method: "HEAD" });
  assert.equal(mediaHead.response.status, 200);
  assert.equal(mediaHead.response.headers.get("content-length"), "2930299");
  assert.equal(mediaHead.response.headers.get("accept-ranges"), "bytes");
  const mediaRange = await request(mediaPath, { headers: { range: "bytes=0-31" } });
  assert.equal(mediaRange.response.status, 206);
  assert.equal(mediaRange.response.headers.get("content-range"), "bytes 0-31/2930299");
  assert.equal(Buffer.byteLength(mediaRange.body), 32);
  const archive = await request(
    `/_c/${config}/uat-vobsub/subtitles/jumpgate-uat-vobsub-v1.zip`
  );
  assert.equal(archive.response.status, 200);
  assert.equal(archive.response.headers.get("content-length"), "2249");
  assert.equal((await request(
    `/_c/${config}/uat-vobsub/subtitles/jumpgate-uat-vobsub-v1.zip`,
    { method: "HEAD" }
  )).response.status, 200);

  const redeemed = await post("/pair/device/token", { deviceCode: issued.body.deviceCode });
  assert.equal(redeemed.response.status, 200);
  const auth = { authorization: `Bearer ${redeemed.body.deviceToken}` };
  const observed = await request(`/_c/${config}/stream/movie/jumpgate-uat-vobsub-v1.json`);
  assert.equal(observed.response.status, 200);
  assert.equal(observed.body.streams.length, 1);
  const playable = observed.body.streams[0];
  const claimed = await post(
    "/v1/playback/claim",
    {
      attemptId: crypto.randomUUID(),
      fingerprints: fingerprintStream(playable),
      intentUrlHash: hashOpaqueValue(playable.url),
      launchedAt: new Date().toISOString(),
    },
    { headers: { "content-type": "application/json", ...auth } }
  );
  assert.equal(claimed.response.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.status, "claimed");
  assert.equal(claimed.body.context.traktEligible, false);
  const discovered = await post(
    "/v1/subtitles/discover",
    { sessionId: claimed.body.sessionId },
    { headers: { "content-type": "application/json", ...auth } }
  );
  assert.equal(discovered.response.status, 200, JSON.stringify(discovered.body));
  assert.equal(discovered.body.subtitles.length, 1);
  assert.equal(discovered.body.subtitles[0].format, "archive");
  const resolved = await post(
    "/v1/subtitles/resolve",
    {
      sessionId: claimed.body.sessionId,
      selector: discovered.body.subtitles[0].selector,
      responseSchemaVersion: 2,
    },
    { headers: { "content-type": "application/json", ...auth } }
  );
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.status, "ready");
  assert.deepEqual(
    resolved.body.parts.map((part) => ({
      fileName: part.fileName,
      sha256: part.sha256,
    })),
    [
      {
        fileName: resolved.body.parts[0].fileName,
        sha256: "b53142fdfd9bafed6ada88752081b08d59f34f0504597784619df2f038f0a5d9",
      },
      {
        fileName: resolved.body.parts[1].fileName,
        sha256: "1ba391e3399b837f217f2f117be44a3b3f00f7286778567a5da23e70954a13b4",
      },
    ]
  );
  assert.match(resolved.body.parts[0].fileName, /\.idx$/);
  assert.match(resolved.body.parts[1].fileName, /\.sub$/);
  for (const [index, part] of resolved.body.parts.entries()) {
    const delivered = await requestBytes(part.path, { headers: auth });
    assert.equal(delivered.response.status, 200);
    assert.equal(delivered.body.length, index === 0 ? 1874 : 12288);
    assert.equal(nodeCrypto.createHash("sha256").update(delivered.body).digest("hex"), part.sha256);
  }

  const blocked = await request(`/_c/${config}/uat-vobsub/media/not-the-fixture.mp4`);
  assert.equal(blocked.response.status, 404);
  const unpaired = await request(
    `/_c/${"x".repeat(32)}/uat-vobsub/manifest.json`
  );
  assert.notEqual(unpaired.response.status, 200);
});

test("synthetic activation fails closed instead of replacing an unexpected provider collection", async () => {
  const page = await request("/configure");
  const config = configFromPage(page.body);
  const issued = await post("/pair/device/code", { validationScenario: "normal" });
  const repositories = await app.repositoriesForTest();

  const originalList = repositories.providers.list.bind(repositories.providers);
  repositories.providers.list = async () => ({
    revision: 9,
    providers: [{
      providerId: "unexpected-provider",
      ordinal: 0,
      descriptor: {
        transportUrl: "https://unexpected.example/manifest.json",
        manifest: {
          id: "unexpected.provider",
          version: "1.0.0",
          name: "Unexpected provider",
          types: ["movie"],
          resources: ["stream"],
        },
      },
    }],
  });
  const activationRequest = {
      userCode: issued.body.userCode,
      config,
      activationRetryToken: Buffer.alloc(32, 23).toString("base64url"),
  };
  try {
    const result = await post("/pair/activate", activationRequest);
    assert.equal(result.response.status, 500);
    assert.equal(result.body.error, "Pairing is temporarily unavailable");

    const blocked = await post("/pair/device/token", { deviceCode: issued.body.deviceCode });
    assert.equal(blocked.response.status, 500);
    assert.equal(blocked.body.error, "Pairing is temporarily unavailable");
    assert.equal(Object.hasOwn(blocked.body, "deviceToken"), false);
  } finally {
    repositories.providers.list = originalList;
  }

  const recovered = await post("/pair/activate", activationRequest);
  assert.equal(recovered.response.status, 200);
  const redeemed = await post("/pair/device/token", { deviceCode: issued.body.deviceCode });
  assert.equal(redeemed.response.status, 200);
  assert.match(redeemed.body.deviceToken, /^[A-Za-z0-9_-]{32,128}$/);
});

test("concurrent synthetic activations converge on one exact provider collection", async () => {
  const page = await request("/configure");
  const config = configFromPage(page.body);
  const first = await post("/pair/device/code", { validationScenario: "normal" });
  const second = await post("/pair/device/code", { validationScenario: "normal" });
  const repositories = await app.repositoriesForTest();
  const originalList = repositories.providers.list.bind(repositories.providers);
  let initialReads = 0;
  let releaseReads;
  const readsReady = new Promise((resolve) => { releaseReads = resolve; });

  repositories.providers.list = async (...args) => {
    if (initialReads >= 2) return originalList(...args);
    const snapshot = await originalList(...args);
    initialReads += 1;
    if (initialReads === 2) releaseReads();
    await readsReady;
    return snapshot;
  };

  let results;
  try {
    results = await Promise.all([
      post("/pair/activate", {
        userCode: first.body.userCode,
        config,
        activationRetryToken: Buffer.alloc(32, 29).toString("base64url"),
      }),
      post("/pair/activate", {
        userCode: second.body.userCode,
        config,
        activationRetryToken: Buffer.alloc(32, 31).toString("base64url"),
      }),
    ]);
  } finally {
    repositories.providers.list = originalList;
  }

  assert.deepEqual(results.map((result) => result.response.status), [200, 200]);
  assert.equal(results[0].body.profileId, results[1].body.profileId);
  const providers = await originalList(results[0].body.profileId);
  assert.equal(providers.revision, 1);
  assert.equal(providers.providers.length, 1);
  assert.equal(
    providers.providers[0].descriptor.manifest.id,
    "com.jumpgate.uat.vobsub-fixture"
  );
});
