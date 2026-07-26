"use strict";

const assert = require("node:assert/strict");
const fetch = require("node-fetch");
const { test } = require("node:test");

const MANAGED_ENV = [
  "CONFIG_SECRET",
  "DATABASE_URL",
  "JUMPGATE_DURABLE_DRIVER",
  "JUMPGATE_ENVELOPE_KEYRING",
  "JUMPGATE_ENVELOPE_PRIMARY_KEY_ID",
  "JUMPGATE_SQLITE_PATH",
  "JUMPGATE_TOKEN_PEPPER",
  "JUMPGATE_TTL_DRIVER",
  "JUMPGATE_TRUST_PROXY",
  "JUMPGATE_PROVIDER_MUTATION_MODE",
  "JUMPGATE_POSTGRES_MIGRATION_CEILING",
  "JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION",
  "JUMPGATE_SUBTITLE_S3_BUCKET",
  "JUMPGATE_SUBTITLE_S3_REGION",
  "JUMPGATE_SUBTITLE_S3_ENDPOINT",
  "JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE",
  "JUMPGATE_SUBTITLE_S3_PRIVACY_MODE",
  "JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID",
  "JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY",
  "JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID",
  "JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING",
  "NODE_ENV",
  "PUBLIC_BASE_URL",
  "REDIS_URL",
  "TRAKT_CLIENT_ID",
  "TRAKT_CLIENT_SECRET",
];

function loadFreshApp(environment) {
  for (const name of MANAGED_ENV) delete process.env[name];
  Object.assign(process.env, environment);
  delete require.cache[require.resolve("../index")];
  return require("../index");
}

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    candidate.once("error", reject);
  });
  return {
    baseUrl: "http://127.0.0.1:" + String(server.address().port),
    server,
  };
}

async function closeServer(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson(baseUrl, route) {
  const response = await fetch(baseUrl + route);
  const text = await response.text();
  return { body: JSON.parse(text), response, text };
}

function assertHealthContract(result, options) {
  const expectedText = JSON.stringify(options.body);
  assert.equal(result.response.status, options.status);
  assert.equal(result.text, expectedText);
  assert.deepEqual(result.body, options.body);
  assert.equal(result.response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(result.response.headers.get("content-length"), String(Buffer.byteLength(expectedText)));
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(result.response.headers.get("x-frame-options"), "DENY");
  assert.equal(
    result.response.headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  assert.equal(
    result.response.headers.get("strict-transport-security"),
    options.production ? "max-age=31536000; includeSubDomains" : null
  );
  for (const name of [
    "access-control-allow-origin",
    "ratelimit-limit",
    "ratelimit-policy",
    "ratelimit-remaining",
    "ratelimit-reset",
    "x-powered-by",
  ]) {
    assert.equal(result.response.headers.get(name), null);
  }
}

test("health routes separate liveness from redacted storage readiness", async () => {
  const originalEnvironment = new Map(MANAGED_ENV.map((name) => [name, process.env[name]]));
  let app;
  let baseUrl;
  let server;

  try {
    app = loadFreshApp({
      NODE_ENV: "test",
      CONFIG_SECRET: "health-route-test-config-secret",
      TRAKT_CLIENT_SECRET: "health-route-test-trakt-secret",
    });
    ({ server, baseUrl } = await listen(app));

    const live = await getJson(baseUrl, "/health/live");
    assertHealthContract(live, {
      status: 200,
      body: { ok: true, status: "live" },
      production: false,
    });

    const ready = await getJson(baseUrl, "/health/ready");
    assertHealthContract(ready, {
      status: 200,
      body: { ok: true, status: "ready" },
      production: false,
    });
    assert.equal(JSON.stringify(ready.body).includes("Driver"), false);

    const ordinary = await getJson(baseUrl, "/version");
    assert.equal(ordinary.response.status, 200);
    assert.equal(ordinary.response.headers.get("ratelimit-limit"), "300");
    assert.equal(ordinary.response.headers.get("x-powered-by"), null);
    assert.equal(ordinary.response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(ordinary.response.headers.get("access-control-allow-origin"), null);

    const publicManifest = await getJson(baseUrl, "/manifest.json");
    assert.equal(publicManifest.response.status, 200);
    assert.equal(publicManifest.response.headers.get("access-control-allow-origin"), "*");

    const publicPreflight = await fetch(baseUrl + "/stream/movie/tt1234567.json", {
      method: "OPTIONS",
    });
    assert.equal(publicPreflight.status, 204);
    assert.equal(publicPreflight.headers.get("access-control-allow-origin"), "*");

    const privatePreflight = await fetch(baseUrl + "/api/profile/providers", {
      method: "OPTIONS",
    });
    assert.equal(privatePreflight.status, 404);
    assert.equal(privatePreflight.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await privatePreflight.json(), { ok: false, error: "not_found" });

    const missing = await getJson(baseUrl, "/definitely-not-a-route");
    assert.equal(missing.response.status, 404);
    assert.deepEqual(missing.body, { ok: false, error: "not_found" });

    await closeServer(server);
    server = null;
    await app.closeStorage();
    app = null;

    app = loadFreshApp({
      NODE_ENV: "production",
      CONFIG_SECRET: "health-route-production-config-secret",
      JUMPGATE_TRUST_PROXY: "1",
      PUBLIC_BASE_URL: "https://health-route.example",
      TRAKT_CLIENT_ID: "health-route-production-client-id",
      TRAKT_CLIENT_SECRET: "health-route-production-trakt-secret",
    });
    const productionRuntime = await listen(app);
    server = productionRuntime.server;

    assertHealthContract(await getJson(productionRuntime.baseUrl, "/health/live"), {
      status: 200,
      body: { ok: true, status: "live" },
      production: true,
    });
    assertHealthContract(await getJson(productionRuntime.baseUrl, "/health/ready"), {
      status: 503,
      body: { ok: false, status: "not_ready" },
      production: true,
    });

    await closeServer(server);
    server = null;
    await app.closeStorage();
    app = null;

    const privatePepper = "private-invalid-token-pepper";
    const privateEnvelopeKey = "private-invalid-envelope-key";
    app = loadFreshApp({
      NODE_ENV: "development",
      CONFIG_SECRET: "health-route-failure-config-secret",
      TRAKT_CLIENT_SECRET: "health-route-failure-trakt-secret",
      JUMPGATE_DURABLE_DRIVER: "sqlite",
      JUMPGATE_TTL_DRIVER: "memory",
      JUMPGATE_TOKEN_PEPPER: privatePepper,
      JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "broken-key",
      JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([
        { id: "broken-key", key: privateEnvelopeKey },
      ]),
    });
    const failedRuntime = await listen(app);
    server = failedRuntime.server;

    const liveBefore = await getJson(failedRuntime.baseUrl, "/health/live");
    const notReady = await getJson(failedRuntime.baseUrl, "/health/ready");
    const ordinaryFailure = await getJson(failedRuntime.baseUrl, "/version");
    const liveAfter = await getJson(failedRuntime.baseUrl, "/health/live");

    assertHealthContract(liveBefore, {
      status: 200,
      body: { ok: true, status: "live" },
      production: false,
    });
    assertHealthContract(notReady, {
      status: 503,
      body: { ok: false, status: "not_ready" },
      production: false,
    });
    assert.equal(ordinaryFailure.response.status, 503);
    assert.deepEqual(ordinaryFailure.body, { ok: false, error: "service_unavailable" });
    assertHealthContract(liveAfter, {
      status: 200,
      body: { ok: true, status: "live" },
      production: false,
    });
    const publicBodies = JSON.stringify([notReady.body, ordinaryFailure.body]);
    assert.equal(publicBodies.includes(privatePepper), false);
    assert.equal(publicBodies.includes(privateEnvelopeKey), false);
  } finally {
    if (server) await closeServer(server);
    if (app) await app.closeStorage();
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
