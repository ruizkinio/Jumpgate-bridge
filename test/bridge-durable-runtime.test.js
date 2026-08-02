"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { fingerprintStream, hashOpaqueValue } = require("../lib/source-context");

let Database = null;
try {
  Database = require("better-sqlite3");
} catch (_error) {
  // The durable process tests are skipped when the optional SQLite driver is absent.
}

const ROOT = path.resolve(__dirname, "..");
const RESUME_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PEPPER = Buffer.alloc(32, 0x41).toString("base64url");
const ENVELOPE_KEY = Buffer.alloc(32, 0x42).toString("base64url");
const CONFIG_SECRET = "bridge-durable-runtime-config-secret";
const TRAKT_CLIENT_ID = "bridge-durable-runtime-client-id";
const BRIDGE_START_TIMEOUT_MS = 30_000;
const DURABLE_STREAM = Object.freeze({
  name: "Durable fixture provider",
  title: "1080p",
  url: "https://media.example/durable-fixture.mkv?token=fixture-private",
  behaviorHints: Object.freeze({ notWebReady: true }),
});
let protocolUuidSequence = 0;

function nextProtocolUuid() {
  protocolUuidSequence += 1;
  return `00000000-0000-4000-8000-${protocolUuidSequence.toString(16).padStart(12, "0")}`;
}

function durableTest(name, callback) {
  test(name, { skip: Database ? false : "better-sqlite3 is not installed" }, callback);
}

async function reservePort() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const server = http.createServer((_req, res) => res.writeHead(204).end());
    await new Promise((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    const port = server.address().port;
    try {
      await fetch(`http://127.0.0.1:${port}`, { method: "HEAD" });
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      return port;
    } catch (error) {
      await new Promise((resolve) => server.close(resolve));
      if (!error || !error.cause || error.cause.message !== "bad port") throw error;
    }
  }
  throw new Error("could not reserve a Fetch-compatible loopback port");
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("bridge process did not exit")), timeoutMs)
    ),
  ]);
}

async function startBridge(options) {
  const port = Object.hasOwn(options, "port") ? options.port : await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const environment = {
    ...process.env,
    NODE_ENV: options.environment || "test",
    PORT: String(port),
    PUBLIC_BASE_URL:
      options.publicBaseUrl ||
      ((options.environment || "test") === "production" ? "https://bridge.example" : baseUrl),
    CONFIG_SECRET,
    TRAKT_CLIENT_ID,
    TRAKT_CLIENT_SECRET: "bridge-durable-runtime-trakt-secret",
    ...((options.environment || "test") === "production"
      ? { JUMPGATE_TRUST_PROXY: "0" }
      : {}),
    JUMPGATE_DURABLE_DRIVER: "sqlite",
    JUMPGATE_TTL_DRIVER: "memory",
    JUMPGATE_SQLITE_PATH: options.databasePath,
    JUMPGATE_TOKEN_PEPPER: TOKEN_PEPPER,
    JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "runtime-key",
    JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([
      { id: "runtime-key", key: ENVELOPE_KEY },
    ]),
    ...(options.traktTokenUrl
      ? { JUMPGATE_TEST_TRAKT_TOKEN_URL: options.traktTokenUrl }
      : {}),
    ...(options.traktScrobbleBaseUrl
      ? { JUMPGATE_TEST_TRAKT_SCROBBLE_BASE_URL: options.traktScrobbleBaseUrl }
      : {}),
    ...(options.refreshWaitTimeoutMs
      ? { JUMPGATE_TEST_TRAKT_REFRESH_WAIT_TIMEOUT_MS: String(options.refreshWaitTimeoutMs) }
      : {}),
  };
  delete environment.HOST;
  if (Object.hasOwn(options, "host")) environment.HOST = options.host;
  const entry = options.providerFixture
    ? path.join("test", "fixtures", "bridge-durable-runtime-entry")
    : "index.js";
  const child = spawn(process.execPath, [entry], {
    cwd: ROOT,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    try {
      await waitForExit(child, 5000);
    } catch (error) {
      child.kill();
      await waitForExit(child, 5000).catch(() => {});
      throw error;
    }
  }
  async function crash() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child, 5000);
  }
  const deadline = Date.now() + BRIDGE_START_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("bridge exited during startup:\n" + output.join(""));
    }
    try {
      const response = await fetch(baseUrl + "/health/ready");
      if (response.status === 200) {
        const listeningDeadline = Date.now() + 2000;
        while (
          Date.now() < listeningDeadline &&
          !output.join("").includes("[startup] listening address=")
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const listeningMatch = output
          .join("")
          .match(/\[startup\] listening address=([^\s]+) port=(\d+)/);
        if (!listeningMatch) throw new Error("bridge did not report its listening address");
        return {
          baseUrl,
          child,
          output,
          stop,
          crash,
          listeningAddress: listeningMatch[1],
          listeningPort: Number(listeningMatch[2]),
        };
      }
      lastError = new Error("readiness returned " + response.status);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stop();
  throw new Error(
    "bridge readiness timed out: " +
      (lastError ? lastError.message : "unknown") +
      "\n" +
      output.join("")
  );
}

async function startTrackedBridge(instances, options) {
  const instance = await startBridge(options);
  instances.push(instance);
  return instance;
}

async function requestJson(instance, pathname, options = {}) {
  const response = await fetch(instance.baseUrl + pathname, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_error) {
      body = text;
    }
  }
  return { response, body };
}

async function postJson(instance, pathname, body, headers = {}) {
  return requestJson(instance, pathname, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function putJson(instance, pathname, body, headers = {}) {
  return requestJson(instance, pathname, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function waitFor(predicate, message, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message + (lastError ? `: ${lastError.message}` : ""));
}

function readDispatch(databasePath, profileId, dispatchId) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare(`
      SELECT status, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt,
             created_at AS createdAt, payload
        FROM scrobble_dispatches
       WHERE profile_id = ? AND id = ?
    `).get(profileId, dispatchId);
  } finally {
    database.close();
  }
}

async function encryptConfig(instance, profileId, trakt = {}, name = "Durable Profile") {
  const encrypted = await postJson(instance, "/test-encrypt", {
    v: 2,
    profileId,
    name,
    trakt,
    settings: {
      subtitle_languages: "en",
      subtitles_enabled: true,
      trakt_enabled: true,
    },
  });
  assert.equal(encrypted.response.status, 200, JSON.stringify(encrypted.body));
  return encrypted.body.blob;
}

async function pair(instance, config) {
  const issued = await postJson(instance, "/pair/device/code", {});
  assert.equal(issued.response.status, 200, JSON.stringify(issued.body));
  const activated = await postJson(instance, "/pair/activate", {
    userCode: issued.body.userCode,
    config,
    activationRetryToken: crypto.randomBytes(32).toString("base64url"),
  });
  assert.equal(activated.response.status, 200, JSON.stringify(activated.body));
  const managementCookie = (activated.response.headers.get("set-cookie") || "").split(";", 1)[0];
  assert.match(managementCookie, /^jg_management_session=/);
  const redeemed = await postJson(instance, "/pair/device/token", {
    deviceCode: issued.body.deviceCode,
  });
  assert.equal(redeemed.response.status, 200, JSON.stringify(redeemed.body));
  return {
    ...activated.body,
    deviceId: redeemed.body.deviceId,
    deviceToken: redeemed.body.deviceToken,
    managementCookie,
  };
}

function bearer(deviceToken) {
  return { authorization: `Bearer ${deviceToken}` };
}

async function importCanonicalProvider(instance, paired) {
  const result = await requestJson(instance, "/api/profile/providers", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: paired.managementCookie,
      "x-jumpgate-csrf": paired.managementCsrf,
    },
    body: JSON.stringify({
      expectedRevision: 0,
      descriptors: [
        {
          transportUrl: "https://durable-provider.invalid/manifest.json",
          manifest: {
            id: "org.jumpgate.durable.fixture",
            version: "1.0.0",
            name: "Durable fixture provider",
            types: ["movie", "series"],
            resources: ["stream"],
          },
        },
      ],
    }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.count, 1);
}

async function createCanonicalClaim(instance, config, paired, options = {}) {
  const type = options.type || "movie";
  const id = options.id || "tt0133093";
  if (options.observe !== false) {
    const observed = await requestJson(
      instance,
      `/_c/${config}/stream/${type}/${id}.json`
    );
    assert.equal(observed.response.status, 200, JSON.stringify(observed.body));
    assert.deepEqual(
      observed.body.streams,
      [DURABLE_STREAM],
      (options.label || `${type}/${id} observation did not yield the fixture stream`) +
        "\n" + instance.output.join("")
    );
  }
  const claimRequest = options.claimRequest || {
    attemptId: nextProtocolUuid(),
    fingerprints: fingerprintStream(DURABLE_STREAM),
    intentUrlHash: hashOpaqueValue(DURABLE_STREAM.url),
    launchedAt: new Date().toISOString(),
  };
  const claim = await postJson(
    instance,
    "/v1/playback/claim",
    claimRequest,
    bearer(paired.deviceToken)
  );
  assert.equal(claim.response.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.status, "claimed", JSON.stringify(claim.body));
  assert.equal(claim.body.historyGrantKind, options.expectedGrantKind || "canonical");
  assert.match(claim.body.historyGrant, /^hg1_/);
  assert.equal(claim.body.context.traktEligible, claim.body.historyGrantKind === "canonical");
  return { ...claim.body, claimRequest };
}

function historyEventBody(claim, input = {}) {
  if (input.requestBody) return input.requestBody;
  return {
    event: input.event || "start",
    sessionRevision: input.sessionRevision || claim.sessionRevision,
    positionMs: input.positionMs ?? 10_000,
    durationMs: input.durationMs ?? 100_000,
    watchedMs: input.watchedMs ?? input.positionMs ?? 10_000,
    ...(input.playbackPreferences
      ? { playbackPreferences: input.playbackPreferences }
      : {}),
  };
}

async function postHistoryEvent(instance, paired, claim, input = {}) {
  const requestBody = historyEventBody(claim, input);
  const idempotencyKey = input.idempotencyKey || nextProtocolUuid();
  const result = await postJson(
    instance,
    "/v1/history/events",
    requestBody,
    {
      ...bearer(paired.deviceToken),
      "x-jumpgate-history-grant": claim.historyGrant,
      "idempotency-key": idempotencyKey,
    }
  );
  return { ...result, idempotencyKey, requestBody };
}

function assertHistoryEventResponse(result, claim, expectedEvent = "start") {
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, "applied");
  assert.equal(result.body.grantKind, "canonical");
  assert.equal(result.body.event, expectedEvent);
  assert.equal(result.body.sessionId, claim.sessionId);
  assert.equal(result.body.history.contentKey, claim.context.contentKey);
  assert.deepEqual(result.body.history.canonicalIdentity, claim.context.canonicalIdentity);
  assert.equal(result.body.dispatchIntent.sessionId, claim.sessionId);
  assert.equal(result.body.dispatchIntent.event, expectedEvent === "progress" ? "start" : expectedEvent);
  assert.doesNotMatch(JSON.stringify(result.body), /access_token|refresh_token|client_id/i);
}

function assertLegacyLifecycleGone(result) {
  assert.equal(result.response.status, 410, JSON.stringify(result.body));
  assert.deepEqual(result.body, { ok: false, error: "history_grant_required" });
  assert.equal(result.response.headers.get("cache-control"), "no-store");
}

durableTest("CLI listener defaults and HOST overrides bind only as explicitly requested", async (t) => {
  const instances = [];
  t.after(async () => {
    for (const instance of instances.reverse()) await instance.stop();
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-listener-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const development = await startTrackedBridge(instances, {
    databasePath: path.join(directory, "development.sqlite3"),
    environment: "development",
  });
  assert.equal(development.listeningAddress, "127.0.0.1");
  assert.match(development.output.join(""), /listening address=127\.0\.0\.1/);

  await assert.rejects(
    startBridge({
      databasePath: path.join(directory, "production.sqlite3"),
      environment: "production",
    }),
    (error) => {
      assert.match(error.message, /\[startup\] listening address=0\.0\.0\.0/);
      assert.match(error.message, /storage initialization failed/);
      return true;
    }
  );

  const explicitWide = await startTrackedBridge(instances, {
    databasePath: path.join(directory, "override.sqlite3"),
    environment: "development",
    host: "0.0.0.0",
  });
  assert.equal(explicitWide.listeningAddress, "0.0.0.0");

  await assert.rejects(
    startBridge({
      databasePath: path.join(directory, "invalid.sqlite3"),
      environment: "development",
      host: " 0.0.0.0",
    }),
    /\[startup\] invalid HOST/
  );

  for (const port of ["named-pipe", "0", "65536", " 7515"]) {
    await assert.rejects(
      startBridge({
        databasePath: path.join(directory, "invalid-port.sqlite3"),
        environment: "development",
        port,
        publicBaseUrl: "http://127.0.0.1:7515",
      }),
      /\[startup\] invalid PORT/
    );
  }
});

durableTest(
  "HTTP loopback pairing keeps Trakt server-side and persists profile history across instances",
  async (t) => {
    const instances = [];
    t.after(async () => {
      for (const instance of instances.reverse()) await instance.stop();
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-history-"));
    const databasePath = path.join(directory, "runtime.sqlite3");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const scrobbleRequests = [];
    const traktServer = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        scrobbleRequests.push({
          authorization: req.headers.authorization || "",
          body: body ? JSON.parse(body) : null,
          url: req.url,
        });
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ action: "scrobble" }));
      });
    });
    await new Promise((resolve, reject) => {
      traktServer.listen(0, "127.0.0.1", resolve);
      traktServer.once("error", reject);
    });
    t.after(
      () =>
        new Promise((resolve, reject) =>
          traktServer.close((error) => (error ? reject(error) : resolve()))
        )
    );
    const traktScrobbleBaseUrl =
      `http://127.0.0.1:${traktServer.address().port}/scrobble`;

    const first = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    const nowSec = Math.floor(Date.now() / 1000);
    const profileIdentity = "durable_profile_alpha";
    const accessToken = "durable-access-token";
    const config = await encryptConfig(first, profileIdentity, {
      access_token: accessToken,
      refresh_token: "durable-refresh-secret",
      token_expiry: nowSec + 3600,
    });
    const paired = await pair(first, config);
    assert.match(paired.bridgeBaseUrl, /^http:\/\/127\.0\.0\.1:\d+\/_c\//);

    const tokenlessConfig = await encryptConfig(first, profileIdentity);
    await importCanonicalProvider(first, paired);
    assertLegacyLifecycleGone(
      await postJson(first, `/_c/${config}/resume`, {
        imdb: "tt0133093",
        position: 25.5,
        duration: 100,
      })
    );
    assertLegacyLifecycleGone(
      await postJson(
        first,
        "/v1/trakt/scrobble/start",
        { callerSelectedIdentity: "tt0133093" },
        bearer(paired.deviceToken)
      )
    );
    const firstClaim = await createCanonicalClaim(first, config, paired);
    const firstHistory = await postHistoryEvent(first, paired, firstClaim, {
      positionMs: 25_500,
      durationMs: 100_000,
      watchedMs: 25_500,
    });
    assertHistoryEventResponse(firstHistory, firstClaim);
    await waitFor(() => scrobbleRequests.length === 1, "first Trakt dispatch was not delivered");
    assert.equal(scrobbleRequests[0].authorization, `Bearer ${accessToken}`);
    assert.deepEqual(scrobbleRequests[0].body, {
      movie: { ids: { imdb: "tt0133093" } },
      progress: 25.5,
    });
    for (const pathname of [
      "/v1/trakt/token",
      `/_c/${tokenlessConfig}/auth/token`,
      `/${tokenlessConfig}/auth/token`,
    ]) {
      const removed = await requestJson(first, pathname, {
        headers: bearer(paired.deviceToken),
      });
      assert.equal(removed.response.status, 404, pathname);
      assert.doesNotMatch(JSON.stringify(removed.body), /access_token|refresh_token|client_id/i);
    }

    const second = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    const secondDevice = await pair(second, tokenlessConfig);
    assert.equal(secondDevice.profileId, paired.profileId);
    assert.notEqual(secondDevice.deviceId, paired.deviceId);
    const secondClaim = await createCanonicalClaim(
      second,
      tokenlessConfig,
      secondDevice
    );
    const secondHistory = await postHistoryEvent(second, secondDevice, secondClaim, {
      positionMs: 25_500,
      durationMs: 100_000,
      watchedMs: 25_500,
    });
    assertHistoryEventResponse(secondHistory, secondClaim);
    await waitFor(() => scrobbleRequests.length === 2, "second Trakt dispatch was not delivered");
    assert.equal(scrobbleRequests[1].authorization, `Bearer ${accessToken}`);
    const canonicalHistory = await requestJson(
      second,
      `/v1/history/${secondClaim.context.contentKey}`,
      { headers: bearer(secondDevice.deviceToken) }
    );
    assert.equal(canonicalHistory.response.status, 200, JSON.stringify(canonicalHistory.body));
    assert.deepEqual(canonicalHistory.body, secondHistory.body.history);
    const visible = await requestJson(
      second,
      `/_c/${tokenlessConfig}/catalog/movie/jumpgate-continue.json`
    );
    assert.equal(visible.response.status, 200, JSON.stringify(visible.body));
    assert.deepEqual(visible.body.metas.map((meta) => meta.id), ["tt0133093"]);
    assert.equal(visible.body.metas[0].description, "26% watched");

    const isolatedConfig = await encryptConfig(second, "durable_profile_bravo", {}, "Other Profile");
    const isolated = await pair(second, isolatedConfig);
    const missing = await requestJson(second, "/v1/trakt/token", {
      headers: bearer(isolated.deviceToken),
    });
    assert.equal(missing.response.status, 404);
    assert.equal(JSON.stringify(missing.body).includes(accessToken), false);
    assert.equal(JSON.stringify(missing.body).includes("refresh"), false);
    const isolatedCatalog = await requestJson(
      second,
      `/_c/${isolatedConfig}/catalog/movie/jumpgate-continue.json`
    );
    assert.deepEqual(isolatedCatalog.body, { metas: [] });

    const completed = await postHistoryEvent(second, secondDevice, secondClaim, {
      event: "completion",
      positionMs: 95_000,
      durationMs: 100_000,
      watchedMs: 95_000,
    });
    assertHistoryEventResponse(completed, secondClaim, "completion");
    assert.equal(completed.body.history.completed, true);
    await waitFor(() => scrobbleRequests.length === 3, "completion was not dispatched");
    assert.equal(scrobbleRequests[2].url, "/scrobble/stop");
    assert.equal(scrobbleRequests[2].body.progress, 100);
    const cleared = await requestJson(
      first,
      `/_c/${config}/catalog/movie/jumpgate-continue.json`
    );
    assert.deepEqual(cleared.body, { metas: [] });

    const resumedClaim = await createCanonicalClaim(first, config, paired);
    const resumedAgain = await postHistoryEvent(first, paired, resumedClaim, {
      positionMs: 30_000,
      durationMs: 100_000,
      watchedMs: 30_000,
    });
    assertHistoryEventResponse(resumedAgain, resumedClaim);
    await waitFor(() => scrobbleRequests.length === 4, "resumed playback was not dispatched");
    const visibleAgain = await requestJson(
      second,
      `/_c/${tokenlessConfig}/catalog/movie/jumpgate-continue.json`
    );
    assert.deepEqual(visibleAgain.body.metas.map((meta) => meta.id), ["tt0133093"]);

    await first.stop();
    await second.stop();
    const restarted = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    const restartedClaim = await createCanonicalClaim(
      restarted,
      tokenlessConfig,
      secondDevice
    );
    const restartedHistory = await postHistoryEvent(
      restarted,
      secondDevice,
      restartedClaim,
      { positionMs: 30_000, durationMs: 100_000, watchedMs: 30_000 }
    );
    assertHistoryEventResponse(restartedHistory, restartedClaim);
    await waitFor(() => scrobbleRequests.length === 5, "restart dispatch was not delivered");
    assert.equal(scrobbleRequests[4].authorization, `Bearer ${accessToken}`);
    const afterRestart = await requestJson(
      restarted,
      `/_c/${tokenlessConfig}/catalog/movie/jumpgate-continue.json`
    );
    assert.deepEqual(afterRestart.body.metas.map((meta) => meta.id), ["tt0133093"]);

    await restarted.stop();
    const database = new Database(databasePath);
    database
      .prepare("UPDATE cloud_history SET last_played_at = ? WHERE profile_id = ?")
      .run(Date.now() - RESUME_TTL_MS - 1000, paired.profileId);
    database.close();

    const expiredInstance = await startTrackedBridge(instances, {
      databasePath,
      environment: "development",
    });
    const expired = await requestJson(
      expiredInstance,
      `/_c/${tokenlessConfig}/catalog/movie/jumpgate-continue.json`
    );
    assert.deepEqual(expired.body, { metas: [] });
    await expiredInstance.stop();

    const combinedOutput = [first, second, restarted, expiredInstance]
      .flatMap((instance) => instance.output)
      .join("");
    assert.equal(combinedOutput.includes(accessToken), false);
    assert.equal(combinedOutput.includes("durable-refresh-secret"), false);
  }
);

durableTest(
  "claim-bound history is cross-device and durable across SQLite Bridge instances",
  async (t) => {
    const instances = [];
    t.after(async () => {
      for (const instance of instances.reverse()) await instance.stop();
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-history-api-"));
    const databasePath = path.join(directory, "runtime.sqlite3");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const first = await startTrackedBridge(instances, { databasePath, providerFixture: true });
    const config = await encryptConfig(first, "durable_history_api_profile");
    const firstDevice = await pair(first, config);
    await importCanonicalProvider(first, firstDevice);
    const second = await startTrackedBridge(instances, { databasePath, providerFixture: true });
    const secondDevice = await pair(second, config);
    assert.equal(secondDevice.profileId, firstDevice.profileId);
    assert.notEqual(secondDevice.deviceId, firstDevice.deviceId);

    const claim = await createCanonicalClaim(first, config, firstDevice);
    const written = await postHistoryEvent(first, firstDevice, claim, {
      positionMs: 25_000,
      durationMs: 100_000,
      watchedMs: 25_000,
    });
    assertHistoryEventResponse(written, claim);
    const key = claim.context.contentKey;

    assertLegacyLifecycleGone(
      await putJson(
        first,
        `/v1/history/${key}`,
        { canonicalIdentity: { imdb: "tt9999999" }, positionMs: 99_000 },
        bearer(firstDevice.deviceToken)
      )
    );
    assertLegacyLifecycleGone(
      await postJson(second, `/_c/${config}/resume`, {
        imdb: "tt9999999",
        position: 20,
        duration: 100,
      })
    );

    const crossDevice = await requestJson(second, `/v1/history/${key}`, {
      headers: {
        ...bearer(secondDevice.deviceToken),
        "x-forwarded-for": "198.51.100.90",
      },
    });
    assert.equal(crossDevice.response.status, 200, JSON.stringify(crossDevice.body));
    assert.equal(crossDevice.response.headers.get("cache-control"), "no-store");
    assert.deepEqual(crossDevice.body, written.body.history);

    const catalog = await requestJson(
      second,
      `/_c/${config}/catalog/movie/jumpgate-continue.json`
    );
    assert.deepEqual(catalog.body.metas.map((meta) => meta.id), ["tt0133093"]);

    await first.stop();
    await second.stop();
    const restarted = await startTrackedBridge(instances, { databasePath });
    const afterRestart = await requestJson(restarted, `/v1/history/${key}`, {
      headers: bearer(secondDevice.deviceToken),
    });
    assert.equal(afterRestart.response.status, 200, JSON.stringify(afterRestart.body));
    assert.deepEqual(afterRestart.body, written.body.history);
  }
);

durableTest(
  "claim-bound identities preserve specials, reject malformed delimiters, and converge under concurrency",
  async (t) => {
    const instances = [];
    t.after(async () => {
      for (const instance of instances.reverse()) await instance.stop();
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-identity-"));
    const databasePath = path.join(directory, "runtime.sqlite3");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const bridgeOptions = { databasePath, providerFixture: true };
    let first = await startTrackedBridge(instances, bridgeOptions);
    const config = await encryptConfig(first, "durable_identity_profile");
    const paired = await pair(first, config);
    const second = await startTrackedBridge(instances, bridgeOptions);
    const special = {
      imdb: "tt7654321",
      season: 0,
      episode: 0,
      position: 10,
      duration: 100,
    };

    const devices = [paired];
    for (let index = 1; index < 12; index += 1) {
      devices.push(await pair(index % 2 ? second : first, config));
    }
    assert.equal(devices.every((device) => device.profileId === paired.profileId), true);
    assert.equal(new Set(devices.map((device) => device.deviceId)).size, 12);
    await importCanonicalProvider(second, devices.at(-1));
    await first.stop();
    first = await startTrackedBridge(instances, bridgeOptions);

    const claims = [];
    for (let index = 0; index < devices.length; index += 1) {
      claims.push(
        await createCanonicalClaim(index % 2 ? second : first, config, devices[index], {
          type: "series",
          id: "tt7654321:0:0",
          observe: index < 2,
          label: `special claim ${index} on ${index % 2 ? "second" : "first"} instance`,
        })
      );
    }
    const concurrent = await Promise.all(
      claims.map((claim, index) =>
        postHistoryEvent(index % 2 ? second : first, devices[index], claim, {
          positionMs: 10_000,
          durationMs: 100_000,
          watchedMs: 10_000,
        })
      )
    );
    for (let index = 0; index < concurrent.length; index += 1) {
      assertHistoryEventResponse(concurrent[index], claims[index]);
    }

    const third = await startTrackedBridge(instances, bridgeOptions);
    const nextDevice = await pair(third, config);
    const nextClaim = await createCanonicalClaim(third, config, nextDevice, {
      type: "series",
      id: "tt7654321:0:1",
    });
    const nextSpecial = await postHistoryEvent(third, nextDevice, nextClaim, {
      positionMs: 10_000,
      durationMs: 100_000,
      watchedMs: 10_000,
    });
    assertHistoryEventResponse(nextSpecial, nextClaim);

    const malformed = [
      { ...special, imdb: "tt7654321:0:0" },
      { ...special, season: "0:1" },
      { ...special, season: -1 },
      { ...special, episode: 0.5 },
      { imdb: special.imdb, season: 0, position: 10, duration: 100 },
      { imdb: special.imdb, episode: 0, position: 10, duration: 100 },
    ];
    for (const body of malformed) {
      const rejected = await postJson(first, `/_c/${config}/resume`, body);
      assertLegacyLifecycleGone(rejected);
      assert.equal(JSON.stringify(rejected.body).includes("0:1"), false);
    }

    const malformedInstance = await startTrackedBridge(instances, bridgeOptions);
    const malformedDevice = await pair(malformedInstance, config);
    const malformedClaim = await createCanonicalClaim(
      malformedInstance,
      config,
      malformedDevice,
      {
        type: "series",
        id: "tt7654321:0:0:1",
        expectedGrantKind: "local",
      }
    );
    assert.equal(malformedClaim.context.canonicalIdentity, null);
    assert.equal(malformedClaim.context.traktEligible, false);

    const catalog = await requestJson(
      second,
      `/_c/${config}/catalog/series/jumpgate-continue.json`
    );
    assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
    assert.deepEqual(
      catalog.body.metas.map((meta) => meta.id).sort(),
      ["tt7654321:0:0", "tt7654321:0:1"]
    );
    assert.match(catalog.body.metas.find((meta) => meta.id.endsWith(":0:0")).name, /S0E0$/);

    const database = new Database(databasePath);
    const records = database
      .prepare(
        "SELECT content_key, canonical_identity, revision FROM cloud_history WHERE profile_id = ? ORDER BY content_key"
      )
      .all(paired.profileId);
    database.close();
    assert.equal(records.length, 2);
    assert.equal(new Set(records.map((record) => record.content_key)).size, 2);
    assert.deepEqual(
      records
        .map((record) => ({
          identity: JSON.parse(record.canonical_identity),
          revision: record.revision,
        }))
        .sort((a, b) => a.identity.episode - b.identity.episode),
      [
        {
          identity: {
            provider: "imdb",
            id: "tt7654321",
            mediaType: "episode",
            season: 0,
            episode: 0,
            provenance: "metadata-request",
            confidence: "canonical",
          },
          revision: 12,
        },
        {
          identity: {
            provider: "imdb",
            id: "tt7654321",
            mediaType: "episode",
            season: 0,
            episode: 1,
            provenance: "metadata-request",
            confidence: "canonical",
          },
          revision: 1,
        },
      ]
    );
  }
);

durableTest("Continue Watching scans stable history pages beyond the 500-record boundary", async (t) => {
  const instances = [];
  t.after(async () => {
    for (const instance of instances.reverse()) await instance.stop();
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-pagination-"));
  const databasePath = path.join(directory, "runtime.sqlite3");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const first = await startTrackedBridge(instances, { databasePath });
  const config = await encryptConfig(first, "durable_pagination_profile");
  const paired = await pair(first, config);
  await first.stop();

  const database = new Database(databasePath);
  const insert = database.prepare(`
    INSERT INTO cloud_history (
      profile_id, content_key, schema_version, canonical_identity,
      display_snapshot, playback_snapshot, position_ms, duration_ms,
      watched_ms, completed, revision, change_sequence, last_played_at,
      updated_at, deleted_at
    ) VALUES (?, ?, 1, ?, '{}', '{}', 10000, 100000, 10000, ?, 1, ?, ?, ?, NULL)
  `);
  const now = Date.now();
  database.transaction(() => {
    for (let index = 0; index < 501; index += 1) {
      const imdb = "tt" + String(1000000 + index);
      const contentKey = crypto
        .createHash("sha256")
        .update("pagination:" + index)
        .digest("hex");
      insert.run(
        paired.profileId,
        contentKey,
        JSON.stringify({ imdb }),
        index < 500 ? 1 : 0,
        index + 1,
        now - index,
        now - index
      );
    }
    database.prepare("UPDATE history_sequence SET value = 501 WHERE singleton = 1").run();
  })();
  database.close();

  const restarted = await startTrackedBridge(instances, { databasePath });
  const catalog = await requestJson(
    restarted,
    `/_c/${config}/catalog/movie/jumpgate-continue.json`
  );
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.metas.length, 1);
  assert.equal(catalog.body.metas.some((meta) => meta.id === "tt1000500"), true);
  assert.equal(new Set(catalog.body.metas.map((meta) => meta.id)).size, 1);
});

durableTest(
  "concurrent instances refresh once and persist the rotated token without disclosing refresh credentials",
  async (t) => {
    const instances = [];
    t.after(async () => {
      for (const instance of instances.reverse()) await instance.stop();
    });
    const refreshRequests = [];
    const scrobbleRequests = [];
    const traktServer = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        if (req.url.startsWith("/scrobble/")) {
          scrobbleRequests.push({
            authorization: req.headers.authorization || "",
            userAgent: req.headers["user-agent"] || "",
            traktApiKey: req.headers["trakt-api-key"] || "",
            payload,
            url: req.url,
          });
          res.statusCode = 201;
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ action: "scrobble" }));
        }
        refreshRequests.push({
          ...payload,
          userAgent: req.headers["user-agent"] || "",
          traktApiKey: req.headers["trakt-api-key"] || "",
        });
        if (payload.refresh_token === "failing-refresh-secret") {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          return res.end(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "sensitive upstream refresh diagnostics",
            })
          );
        }
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              access_token: "rotated-access-token",
              refresh_token: "rotated-refresh-secret",
              created_at: Math.floor(Date.now() / 1000),
              expires_in: 3600,
            })
          );
        }, 100);
      });
    });
    await new Promise((resolve, reject) => {
      traktServer.listen(0, "127.0.0.1", resolve);
      traktServer.once("error", reject);
    });
    t.after(
      () =>
        new Promise((resolve, reject) =>
          traktServer.close((error) => (error ? reject(error) : resolve()))
        )
    );
    const traktTokenUrl = `http://127.0.0.1:${traktServer.address().port}/oauth/token`;
    const traktScrobbleBaseUrl =
      `http://127.0.0.1:${traktServer.address().port}/scrobble`;
    const bridgeOptions = {
      providerFixture: true,
      traktScrobbleBaseUrl,
      traktTokenUrl,
    };

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-oauth-"));
    const databasePath = path.join(directory, "runtime.sqlite3");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const first = await startTrackedBridge(instances, { databasePath, ...bridgeOptions });
    const expiredConfig = await encryptConfig(first, "durable_refresh_profile", {
      access_token: "expired-access-token",
      refresh_token: "expired-refresh-secret",
      token_expiry: Math.floor(Date.now() / 1000) - 60,
    });
    const paired = await pair(first, expiredConfig);
    await importCanonicalProvider(first, paired);
    const tokenlessConfig = await encryptConfig(first, "durable_refresh_profile");
    const second = await startTrackedBridge(instances, { databasePath, ...bridgeOptions });
    const secondDevice = await pair(second, tokenlessConfig);
    assert.equal(secondDevice.profileId, paired.profileId);
    assert.notEqual(secondDevice.deviceId, paired.deviceId);
    const firstClaim = await createCanonicalClaim(first, expiredConfig, paired);
    const secondClaim = await createCanonicalClaim(second, tokenlessConfig, secondDevice);

    for (const headers of [
      {},
      { authorization: `Basic ${paired.deviceToken}` },
      { authorization: `Bearer ${paired.deviceToken} trailing` },
      { authorization: "Bearer " + "x".repeat(32) },
    ]) {
      const rejected = await postJson(
        second,
        "/v1/history/events",
        historyEventBody(secondClaim),
        {
          "x-jumpgate-history-grant": secondClaim.historyGrant,
          "idempotency-key": nextProtocolUuid(),
          ...headers,
        }
      );
      assert.equal(rejected.response.status, 401, JSON.stringify(rejected.body));
      assert.deepEqual(rejected.body, { ok: false, error: "device_auth_required" });
      assert.equal(JSON.stringify(rejected.body).includes(paired.deviceToken), false);
    }

    const [fromFirst, fromSecond] = await Promise.all([
      postHistoryEvent(first, paired, firstClaim),
      postHistoryEvent(second, secondDevice, secondClaim),
    ]);
    assertHistoryEventResponse(fromFirst, firstClaim);
    assertHistoryEventResponse(fromSecond, secondClaim);
    await waitFor(
      () => refreshRequests.length === 1 && scrobbleRequests.length === 2,
      "concurrent refresh dispatches did not converge",
      10_000
    );
    assert.equal(refreshRequests.length, 1);
    assert.equal(refreshRequests[0].refresh_token, "expired-refresh-secret");
    assert.equal(refreshRequests[0].userAgent, "Jumpgate-Bridge/3.0.0");
    assert.equal(refreshRequests[0].traktApiKey, TRAKT_CLIENT_ID);
    assert.equal(scrobbleRequests.length, 2);
    assert.equal(
      scrobbleRequests.every(
        (request) => request.authorization === "Bearer rotated-access-token"
      ),
      true
    );
    assert.equal(
      scrobbleRequests.every(
        (request) =>
          request.userAgent === "Jumpgate-Bridge/3.0.0" &&
          request.traktApiKey === TRAKT_CLIENT_ID
      ),
      true
    );

    const configured = await requestJson(second, `/_c/${tokenlessConfig}/auth/token`);
    assert.equal(configured.response.status, 404);
    assert.doesNotMatch(JSON.stringify(configured.body), /access_token|refresh_token|client_id/i);

    await first.stop();
    await second.stop();
    const restarted = await startTrackedBridge(instances, { databasePath, ...bridgeOptions });
    const persistedClaim = await createCanonicalClaim(restarted, tokenlessConfig, paired);
    const persisted = await postHistoryEvent(restarted, paired, persistedClaim);
    assertHistoryEventResponse(persisted, persistedClaim);
    await waitFor(() => scrobbleRequests.length === 3, "persisted token was not dispatched");
    assert.equal(refreshRequests.length, 1);
    assert.equal(scrobbleRequests.length, 3);
    assert.equal(scrobbleRequests[2].authorization, "Bearer rotated-access-token");

    const failingConfig = await encryptConfig(restarted, "durable_failure_profile", {
      access_token: "failing-access-token",
      refresh_token: "failing-refresh-secret",
      token_expiry: Math.floor(Date.now() / 1000) - 60,
    });
    const failingProfile = await pair(restarted, failingConfig);
    await importCanonicalProvider(restarted, failingProfile);
    const failingClaim = await createCanonicalClaim(
      restarted,
      failingConfig,
      failingProfile
    );
    const unavailable = await postHistoryEvent(
      restarted,
      failingProfile,
      failingClaim
    );
    assertHistoryEventResponse(unavailable, failingClaim);
    await waitFor(
      () =>
        refreshRequests.filter(
          (request) => request.refresh_token === "failing-refresh-secret"
        ).length === 1,
      "failed refresh was not attempted"
    );
    assert.equal(JSON.stringify(unavailable.body).includes("sensitive upstream"), false);
    assert.equal(refreshRequests.length, 2);
    assert.equal(scrobbleRequests.length, 3);
    await restarted.stop();

    const failureRestart = await startTrackedBridge(instances, {
      databasePath,
      ...bridgeOptions,
    });
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const stillUnavailable = await requestJson(
      failureRestart,
      `/v1/history/${failingClaim.context.contentKey}`,
      { headers: bearer(failingProfile.deviceToken) }
    );
    assert.equal(stillUnavailable.response.status, 200, JSON.stringify(stillUnavailable.body));
    assert.deepEqual(stillUnavailable.body, unavailable.body.history);
    assert.equal(
      refreshRequests.filter(
        (request) => request.refresh_token === "failing-refresh-secret"
      ).length,
      1
    );
    assert.equal(scrobbleRequests.length, 3);
    assert.equal(refreshRequests.length, 2);
    await failureRestart.stop();

    const output = [first, second, restarted, failureRestart]
      .flatMap((instance) => instance.output)
      .join("");
    for (const secret of [
      "expired-access-token",
      "expired-refresh-secret",
      "rotated-access-token",
      "rotated-refresh-secret",
      "failing-access-token",
      "failing-refresh-secret",
      "sensitive upstream refresh diagnostics",
    ]) {
      assert.equal(output.includes(secret), false);
    }
  }
);

durableTest(
  "ambiguous, crashed, and unpersisted refresh attempts fail closed without replay",
  async (t) => {
    const instances = [];
    t.after(async () => {
      for (const instance of instances.reverse()) await instance.stop();
    });
    const refreshRequests = [];
    const scrobbleRequests = [];
    let resolveCrashRequest;
    const crashRequestReceived = new Promise((resolve) => {
      resolveCrashRequest = resolve;
    });
    const traktServer = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const payload = JSON.parse(body);
        if (req.url.startsWith("/scrobble/")) {
          scrobbleRequests.push(payload);
          res.statusCode = 201;
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify({ action: "scrobble" }));
        }
        refreshRequests.push(payload);
        if (payload.refresh_token === "ambiguous-parse-refresh-secret") {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          return res.end("{not-json");
        }
        if (payload.refresh_token === "crash-window-refresh-secret") {
          resolveCrashRequest();
          return;
        }
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            access_token: "unpersisted-rotated-access-secret",
            refresh_token: "unpersisted-rotated-refresh-secret",
            created_at: Math.floor(Date.now() / 1000),
            expires_in: 3600,
          })
        );
      });
    });
    await new Promise((resolve, reject) => {
      traktServer.listen(0, "127.0.0.1", resolve);
      traktServer.once("error", reject);
    });
    t.after(
      () =>
        new Promise((resolve, reject) =>
          traktServer.close((error) => (error ? reject(error) : resolve()))
        )
    );
    const traktTokenUrl = `http://127.0.0.1:${traktServer.address().port}/oauth/token`;
    const traktScrobbleBaseUrl =
      `http://127.0.0.1:${traktServer.address().port}/scrobble`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-failclosed-"));
    const databasePath = path.join(directory, "runtime.sqlite3");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const bridgeOptions = {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
      traktTokenUrl,
      refreshWaitTimeoutMs: 150,
    };

    let active = await startTrackedBridge(instances, bridgeOptions);
    const parseConfig = await encryptConfig(active, "durable_parse_failure", {
      access_token: "ambiguous-parse-access-secret",
      refresh_token: "ambiguous-parse-refresh-secret",
      token_expiry: Math.floor(Date.now() / 1000) - 60,
    });
    const parseProfile = await pair(active, parseConfig);
    await importCanonicalProvider(active, parseProfile);
    const parseClaim = await createCanonicalClaim(active, parseConfig, parseProfile);
    const parseFailure = await postHistoryEvent(active, parseProfile, parseClaim);
    assertHistoryEventResponse(parseFailure, parseClaim);
    await waitFor(
      () =>
        refreshRequests.filter(
          (request) => request.refresh_token === "ambiguous-parse-refresh-secret"
        ).length === 1,
      "malformed refresh response was not attempted"
    );
    await active.stop();

    active = await startTrackedBridge(instances, bridgeOptions);
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const parseRestart = await requestJson(
      active,
      `/v1/history/${parseClaim.context.contentKey}`,
      { headers: bearer(parseProfile.deviceToken) }
    );
    assert.equal(parseRestart.response.status, 200, JSON.stringify(parseRestart.body));
    assert.deepEqual(parseRestart.body, parseFailure.body.history);
    assert.equal(
      refreshRequests.filter(
        (request) => request.refresh_token === "ambiguous-parse-refresh-secret"
      ).length,
      1
    );

    const crashConfig = await encryptConfig(active, "durable_crash_failure", {
      access_token: "crash-window-access-secret",
      refresh_token: "crash-window-refresh-secret",
      token_expiry: Math.floor(Date.now() / 1000) - 60,
    });
    const crashProfile = await pair(active, crashConfig);
    await importCanonicalProvider(active, crashProfile);
    const crashClaim = await createCanonicalClaim(active, crashConfig, crashProfile);
    const crashEvent = await postHistoryEvent(active, crashProfile, crashClaim);
    assertHistoryEventResponse(crashEvent, crashClaim);
    await Promise.race([
      crashRequestReceived,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("refresh request was not observed")), 5000)
      ),
    ]);
    await active.crash();

    active = await startTrackedBridge(instances, bridgeOptions);
    const crashRestartClaim = await createCanonicalClaim(
      active,
      crashConfig,
      crashProfile
    );
    const crashRestart = await postHistoryEvent(active, crashProfile, crashRestartClaim);
    assertHistoryEventResponse(crashRestart, crashRestartClaim);
    await waitFor(
      () => {
        const row = readDispatch(
          databasePath,
          crashProfile.profileId,
          crashRestart.body.dispatchIntent.id
        );
        return row && row.status === "queued" && row.attemptCount >= 1;
      },
      "crashed refresh state was not failed closed"
    );
    assert.equal(
      refreshRequests.filter(
        (request) => request.refresh_token === "crash-window-refresh-secret"
      ).length,
      1
    );

    const persistenceConfig = await encryptConfig(active, "durable_persist_failure", {
      access_token: "unpersisted-access-secret",
      refresh_token: "unpersisted-refresh-secret",
      token_expiry: Math.floor(Date.now() / 1000) - 60,
    });
    const persistenceProfile = await pair(active, persistenceConfig);
    await importCanonicalProvider(active, persistenceProfile);
    const persistenceClaim = await createCanonicalClaim(
      active,
      persistenceConfig,
      persistenceProfile
    );
    const database = new Database(databasePath);
    database.exec(`
      CREATE TRIGGER reject_refreshed_oauth
      BEFORE UPDATE ON oauth_credentials
      WHEN OLD.profile_id = '${persistenceProfile.profileId}' AND OLD.revision >= 2
      BEGIN
        SELECT RAISE(FAIL, 'sensitive persistence diagnostic');
      END;
    `);
    database.close();

    const persistenceFailure = await postHistoryEvent(
      active,
      persistenceProfile,
      persistenceClaim
    );
    assertHistoryEventResponse(persistenceFailure, persistenceClaim);
    await waitFor(
      () => {
        const row = readDispatch(
          databasePath,
          persistenceProfile.profileId,
          persistenceFailure.body.dispatchIntent.id
        );
        return row && row.status === "queued" && row.attemptCount >= 1;
      },
      "unpersisted refresh was not failed closed"
    );
    const cleanupDatabase = new Database(databasePath);
    cleanupDatabase.exec("DROP TRIGGER reject_refreshed_oauth");
    cleanupDatabase.close();
    await active.stop();

    active = await startTrackedBridge(instances, bridgeOptions);
    await new Promise((resolve) => setTimeout(resolve, 1250));
    const persistenceRestart = await requestJson(
      active,
      `/v1/history/${persistenceClaim.context.contentKey}`,
      { headers: bearer(persistenceProfile.deviceToken) }
    );
    assert.equal(
      persistenceRestart.response.status,
      200,
      JSON.stringify(persistenceRestart.body)
    );
    assert.deepEqual(persistenceRestart.body, persistenceFailure.body.history);
    assert.equal(
      refreshRequests.filter((request) => request.refresh_token === "unpersisted-refresh-secret")
        .length,
      1
    );
    assert.deepEqual(scrobbleRequests, []);

    const output = instances.flatMap((instance) => instance.output).join("");
    for (const secret of [
      "ambiguous-parse-access-secret",
      "ambiguous-parse-refresh-secret",
      "crash-window-access-secret",
      "crash-window-refresh-secret",
      "unpersisted-access-secret",
      "unpersisted-refresh-secret",
      "unpersisted-rotated-access-secret",
      "unpersisted-rotated-refresh-secret",
      "sensitive persistence diagnostic",
    ]) {
      assert.equal(output.includes(secret), false);
    }
  }
);

durableTest(
  "proven pre-effect failure retries once across restart and duplicate workers",
  async (t) => {
    const instances = [];
    t.after(async () => {
      for (const instance of instances.reverse()) await instance.stop();
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-retry-"));
    const databasePath = path.join(directory, "runtime.sqlite3");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const traktPort = await reservePort();
    const traktScrobbleBaseUrl = `http://127.0.0.1:${traktPort}/scrobble`;

    const first = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    const config = await encryptConfig(first, "durable_pre_effect_retry", {
      access_token: "pre-effect-retry-access",
      refresh_token: "pre-effect-retry-refresh",
      token_expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const paired = await pair(first, config);
    await importCanonicalProvider(first, paired);
    const claim = await createCanonicalClaim(first, config, paired);
    const event = await postHistoryEvent(first, paired, claim);
    assertHistoryEventResponse(event, claim);
    const exactReplay = await postHistoryEvent(first, paired, claim, {
      requestBody: event.requestBody,
      idempotencyKey: event.idempotencyKey,
    });
    assert.deepEqual(exactReplay.body, event.body);
    const dispatchId = event.body.dispatchIntent.id;
    await waitFor(
      () => {
        const row = readDispatch(databasePath, paired.profileId, dispatchId);
        return (
          row &&
          row.status === "queued" &&
          row.attemptCount === 1 &&
          row.nextAttemptAt > row.createdAt
        );
      },
      "pre-effect dispatch was not durably scheduled for one retry"
    );
    await first.stop();

    let successfulEffects = 0;
    const traktServer = http.createServer((req, res) => {
      req.resume();
      req.once("end", () => {
        successfulEffects += 1;
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ action: "scrobble" }));
      });
    });
    await new Promise((resolve, reject) => {
      traktServer.listen(traktPort, "127.0.0.1", resolve);
      traktServer.once("error", reject);
    });
    t.after(
      () =>
        new Promise((resolve, reject) =>
          traktServer.close((error) => (error ? reject(error) : resolve()))
        )
    );

    const second = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    const third = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    await waitFor(() => successfulEffects === 1, "pre-effect retry was not delivered");
    assert.equal(successfulEffects, 1);
    await new Promise((resolve) => setTimeout(resolve, 1250));
    assert.equal(successfulEffects, 1);
    await second.stop();
    await third.stop();

    const row = readDispatch(databasePath, paired.profileId, dispatchId);
    assert.equal(row.status, "delivered");
    assert.equal(row.attemptCount, 2);
    assert.doesNotMatch(row.payload, /token|authorization|provider|source|url/i);
  }
);

durableTest(
  "ambiguous Trakt delivery is terminal across a process restart and duplicate workers",
  async (t) => {
    const instances = [];
    t.after(async () => {
      for (const instance of instances.reverse()) await instance.stop();
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-runtime-scrobble-"));
    const databasePath = path.join(directory, "runtime.sqlite3");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    let upstreamAttempts = 0;
    const traktServer = http.createServer((req, res) => {
      req.resume();
      req.once("end", () => {
        upstreamAttempts += 1;
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "outcome intentionally ambiguous" }));
      });
    });
    await new Promise((resolve, reject) => {
      traktServer.listen(0, "127.0.0.1", resolve);
      traktServer.once("error", reject);
    });
    t.after(
      () =>
        new Promise((resolve, reject) =>
          traktServer.close((error) => (error ? reject(error) : resolve()))
        )
    );
    const traktScrobbleBaseUrl =
      `http://127.0.0.1:${traktServer.address().port}/scrobble`;

    const first = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    const config = await encryptConfig(first, "durable_ambiguous_scrobble", {
      access_token: "ambiguous-delivery-access",
      refresh_token: "ambiguous-delivery-refresh",
      token_expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const paired = await pair(first, config);
    await importCanonicalProvider(first, paired);
    const claim = await createCanonicalClaim(first, config, paired);
    const event = await postHistoryEvent(first, paired, claim);
    assertHistoryEventResponse(event, claim);
    const dispatchId = event.body.dispatchIntent.id;
    await waitFor(
      () => {
        const row = readDispatch(databasePath, paired.profileId, dispatchId);
        return upstreamAttempts === 1 && row && row.status === "delivered";
      },
      "ambiguous dispatch was not terminalized"
    );
    assert.equal(upstreamAttempts, 1);
    await first.stop();

    const second = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    const third = await startTrackedBridge(instances, {
      databasePath,
      providerFixture: true,
      traktScrobbleBaseUrl,
    });
    await new Promise((resolve) => setTimeout(resolve, 1250));
    assert.equal(upstreamAttempts, 1);
    await second.stop();
    await third.stop();

    const database = new Database(databasePath, { readonly: true });
    const rows = database.prepare(`
      SELECT status, attempt_count AS attemptCount, payload
        FROM scrobble_dispatches
       WHERE profile_id = ? AND id = ?
    `).all(paired.profileId, dispatchId);
    database.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "delivered");
    assert.equal(rows[0].attemptCount, 1);
    assert.doesNotMatch(rows[0].payload, /token|authorization|provider|source|url/i);
  }
);
