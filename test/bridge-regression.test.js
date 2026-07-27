"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { fingerprintStream, hashOpaqueValue } = require("../lib/source-context");

process.env.NODE_ENV = "test";
process.env.CONFIG_SECRET = "jumpgate-regression-test-secret";
process.env.TRAKT_CLIENT_SECRET = "jumpgate-regression-test-trakt-secret";
process.env.PUBLIC_BASE_URL = "https://jumpgate.test";
process.env.JUMPGATE_TEST_ALLOW_LOOPBACK = "1";
process.env.JUMPGATE_TEST_GLOBAL_RATE_LIMIT = "10000";
process.env.JUMPGATE_DEPLOYMENT_STATUS = "Pre-release hosted instance";
process.env.JUMPGATE_PRIVACY_POLICY_URL = "https://policies.jumpgate.test/privacy";
process.env.JUMPGATE_SECURITY_POLICY_URL = "https://policies.jumpgate.test/security";
process.env.JUMPGATE_SUPPORT_POLICY_URL = "https://policies.jumpgate.test/support";
const TEST_BUILD_SHA = "0123456789abcdef".repeat(2) + "01234567";
const REQUEST_ABORT_PROPAGATION_TOLERANCE_MS = 250;
process.env.JUMPGATE_BUILD_SHA = TEST_BUILD_SHA;

const app = require("../index");

let server;
let baseUrl;
let upstreamServer;
let upstreamBaseUrl;
const upstreamRequests = [];
const subtitleSourceRequests = [];
const subtitleSourceBodies = [];
let subtitleSourceFailure = null;
let subtitleSourcePause = null;

const PLAYABLE_STREAM = {
  name: "Test provider",
  title: "1080p",
  url: "https://media.example/video.mkv?token=abc123&expires=9999999999",
  subtitles: [{ id: "inline-en", lang: "eng", url: "https://media.example/subtitle.vtt?token=sub" }],
  behaviorHints: { notWebReady: true, unknownProviderField: "preserve-me" },
};

const UNKNOWN_STREAM = {
  name: "Unknown provider",
  url: "https://media.example/unknown.mkv?signature=raw%2Bbytes&part=1",
};

async function listenOnFetchableLoopback(currentServer) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    await new Promise((resolve, reject) => {
      currentServer.listen(0, "127.0.0.1", resolve);
      currentServer.once("error", reject);
    });
    const base = `http://127.0.0.1:${currentServer.address().port}`;
    try {
      await fetch(base + "/__jumpgate_port_probe__", { method: "HEAD" });
      return base;
    } catch (error) {
      if (!error || !error.cause || error.cause.message !== "bad port") throw error;
      await new Promise((resolve, reject) =>
        currentServer.close((closeError) => (closeError ? reject(closeError) : resolve()))
      );
    }
  }
  throw new Error("could not reserve a Fetch-compatible loopback port");
}

before(async () => {
  upstreamServer = http.createServer((req, res) => {
    upstreamRequests.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/subtitles/")) {
      return res.end(
        JSON.stringify({
          subtitles: [
            { id: "en", lang: "en", url: "https://subs.example/movie-en.srt" },
            { id: "es", lang: "es", url: "https://subs.example/movie-es.srt" },
          ],
        })
      );
    }
    if (req.url.includes("empty-source")) return res.end(JSON.stringify({ streams: [] }));
    if (req.url.includes("only-malformed")) return res.end(JSON.stringify({ streams: [null] }));
    if (req.url.includes("mixed-malformed")) {
      return res.end(JSON.stringify({ streams: [PLAYABLE_STREAM, { name: "not playable" }] }));
    }
    if (req.url.includes("addon-private")) return res.end(JSON.stringify({ streams: [UNKNOWN_STREAM] }));
    return res.end(JSON.stringify({ streams: [PLAYABLE_STREAM] }));
  });
  upstreamBaseUrl = await listenOnFetchableLoopback(upstreamServer);
  upstreamRequests.length = 0;
  app.setProviderGatewayFetchPolicyForTest({
    async fetchJson(url, options = {}) {
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: options.signal,
      });
      if (!response.ok) throw new Error("test upstream returned " + response.status);
      return { value: await response.json() };
    },
  });
  app.setSubtitleSourceFetchPolicyForTest({
    async fetchBuffer(url, options = {}) {
      subtitleSourceRequests.push({ url, options });
      if (subtitleSourceFailure === "source") {
        throw Object.assign(new Error("https://private.example/source?token=secret"), {
          code: "upstream_fetch_failed",
        });
      }
      const pause = subtitleSourcePause;
      if (pause) {
        pause.started();
        await pause.wait;
      }
      const pathname = new URL(url).pathname.toLowerCase();
      const body = subtitleSourceFailure === "payload"
        ? Buffer.alloc(0)
        : pathname.endsWith(".vtt")
          ? Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nBridge subtitle\n")
          : Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nBridge subtitle\n");
      subtitleSourceBodies.push(body);
      return {
        body,
        contentType: pathname.endsWith(".vtt") ? "text/vtt" : "application/x-subrip",
        charset: "utf-8",
        redirects: 0,
        status: 200,
      };
    },
  });

  server = http.createServer(app);
  baseUrl = await listenOnFetchableLoopback(server);
});

after(async () => {
  for (const current of [server, upstreamServer]) {
    if (!current) continue;
    if (typeof current.closeAllConnections === "function") current.closeAllConnections();
    await new Promise((resolve, reject) => current.close((error) => (error ? reject(error) : resolve())));
  }
  await app.closeStorage();
});

async function request(path, options = {}) {
  const response = await fetch(baseUrl + path, options);
  const contentType = response.headers.get("content-type") || "";
  const body = options.method === "HEAD"
    ? await response.text()
    : contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return { response, body };
}

async function requestRawTarget(target, options = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method || "GET",
        path: target,
        headers: options.headers || {},
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve({ status: response.statusCode }));
      }
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function postJson(path, body, headers = {}) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function postClaim(body, headers = {}) {
  if (!Object.hasOwn(body, "attemptId")) body.attemptId = crypto.randomUUID();
  return postJson("/v1/playback/claim", body, headers);
}

async function postHistoryEvent(
  claim,
  event,
  headers = {},
  overrides = {},
  idempotencyKey = crypto.randomUUID()
) {
  const requestBody = {
    event,
    sessionRevision: claim.sessionRevision,
    positionMs: 0,
    durationMs: 0,
    watchedMs: 0,
    ...overrides,
  };
  const result = await postJson("/v1/history/events", requestBody, {
    "x-jumpgate-history-grant": claim.historyGrant,
    "idempotency-key": idempotencyKey,
    ...headers,
  });
  return { ...result, idempotencyKey, requestBody };
}

function historyPayload(overrides = {}) {
  return {
    canonicalIdentity: {
      provider: "imdb",
      id: "tt0133093",
      mediaType: "movie",
      provenance: "metadata-request",
      confidence: "canonical",
    },
    displaySnapshot: {
      title: "The Matrix",
      year: 1999,
      poster: "https://images.example/matrix.jpg",
    },
    playbackSnapshot: {
      providerNamespace: "org.example.playback",
      sourceFingerprint: "v1:url:sha256:" + "a".repeat(64),
      subtitleLanguages: ["en"],
    },
    positionMs: 25000,
    durationMs: 100000,
    watchedMs: 25000,
    completed: false,
    ...overrides,
  };
}

async function createConfig(name, upstream = "", settingsOverrides = {}, trakt = {}, tmdbKey = "") {
  const settings = {
    subtitle_languages: "en,es",
    subtitles_enabled: true,
    trakt_enabled: true,
    auto_update_check: true,
    ...settingsOverrides,
  };
  const { response, body } = await postJson("/test-encrypt", {
    v: 2,
    profileId: Buffer.from(`profile:${name}`).toString("base64url"),
    name,
    tmdbKey,
    trakt,
    upstream,
    settings,
  });
  assert.equal(response.status, 200);
  assert.equal(body.roundTrip.name, name);
  assert.equal(body.roundTrip.tmdbKey, tmdbKey);
  assert.equal(body.roundTrip.settings.subtitle_languages, settings.subtitle_languages);
  assert.match(body.blob, /^[A-Za-z0-9_-]+$/);
  return body.blob;
}

function activationRetryToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function pairDevice(config) {
  const issued = await postJson("/pair/device/code", {});
  const activated = await postJson("/pair/activate", {
    userCode: issued.body.userCode,
    config,
    activationRetryToken: activationRetryToken(),
  });
  assert.equal(activated.response.status, 200, JSON.stringify(activated.body));
  const managementSetCookie = activated.response.headers.get("set-cookie") || "";
  const managementCookie = managementSetCookie.split(";")[0];
  assert.match(managementCookie, /^jg_management_session=/);
  assert.match(activated.body.managementCsrf, /^[A-Za-z0-9_-]{24,}$/);

  const paired = await postJson("/pair/device/token", { deviceCode: issued.body.deviceCode });
  assert.equal(paired.response.status, 200);
  assert.match(paired.body.deviceToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(paired.body.deviceId, /^[A-Za-z0-9_-]{16,}$/);
  return {
    ...paired.body,
    managementCookie,
    managementSetCookie,
    managementCsrf: activated.body.managementCsrf,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function settledWithin(promise, timeoutMs = 50) {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function responseCookie(response, name) {
  const values = responseSetCookies(response);
  const prefix = name + "=";
  const value = values.find((candidate) => candidate.startsWith(prefix));
  return value ? value.split(";", 1)[0] : "";
}

async function requestFromLocalAddress(path, localAddress, options = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        localAddress,
        method: options.method || "GET",
        path,
        headers: options.headers || {},
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    outgoing.once("error", reject);
    outgoing.end(options.body || "");
  });
}

function responseSetCookies(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
}

function responseCookieWithPrefix(response, prefix) {
  const value = responseSetCookies(response).find((candidate) => candidate.startsWith(prefix));
  return value ? value.split(";", 1)[0] : "";
}

function applyResponseCookies(jar, response) {
  for (const value of responseSetCookies(response)) {
    if (!value) continue;
    const pair = value.split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator);
    const cookieValue = pair.slice(separator + 1);
    if (!cookieValue || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(value)) jar.delete(name);
    else jar.set(name, cookieValue);
  }
}

function cookieJarHeader(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function postManagementTraktConnect(device, overrides = {}) {
  const headers = {
    cookie: device.managementCookie,
    origin: "https://jumpgate.test",
    "content-type": "application/x-www-form-urlencoded",
    ...(overrides.headers || {}),
  };
  return request("/api/profile/trakt/connect", {
    method: "POST",
    headers,
    body: overrides.body === undefined
      ? new URLSearchParams({ csrf: device.managementCsrf }).toString()
      : overrides.body,
    redirect: "manual",
  });
}

async function postLegacyManagementTraktConnect(device, overrides = {}) {
  return request("/api/profile/trakt/connect", {
    method: "POST",
    headers: {
      cookie: device.managementCookie,
      origin: "https://jumpgate.test",
      "x-jumpgate-csrf": device.managementCsrf,
      ...(overrides.headers || {}),
    },
    redirect: "manual",
  });
}

async function postManagementTraktConnectFromAddress(device, localAddress) {
  const body = new URLSearchParams({ csrf: device.managementCsrf }).toString();
  return requestFromLocalAddress("/api/profile/trakt/connect", localAddress, {
    method: "POST",
    headers: {
      cookie: device.managementCookie,
      origin: "https://jumpgate.test",
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(body),
    },
    body,
  });
}

async function beginManagementTraktConnect(device) {
  const started = await postManagementTraktConnect(device);
  assert.equal(started.response.status, 303);
  const authorization = new URL(started.response.headers.get("location"));
  assert.equal(authorization.origin, "https://trakt.tv");
  const state = authorization.searchParams.get("state");
  assert.match(state, /^m2\.[A-Za-z0-9_-]{43}$/);
  const bindingCookie = responseCookieWithPrefix(
    started.response,
    "jg_management_oauth_binding_"
  );
  assert.match(
    bindingCookie,
    /^jg_management_oauth_binding_[A-Za-z0-9_-]{22}=[A-Za-z0-9_-]{43}$/
  );
  const bindingCookieName = bindingCookie.split("=", 1)[0];
  const setCookies = responseSetCookies(started.response);
  assert.equal(setCookies.some((value) => value.startsWith("jg_management_oauth_state=")), false);
  assert.match(setCookies.join("\n"), /Path=\/auth\/trakt\/callback/i);
  assert.match(setCookies.join("\n"), /HttpOnly/i);
  assert.match(setCookies.join("\n"), /SameSite=Lax/i);
  assert.match(setCookies.join("\n"), /Expires=/i);
  assert.match(setCookies.join("\n"), /Max-Age=(?:[0-9]|[1-5][0-9]{1,2}|600)/i);

  return { authorization, bindingCookie, bindingCookieName, state, started };
}

function providerDescriptor(id = "org.example.streams") {
  return {
    transportUrl: `https://provider.example/${id}/manifest.json?token=provider-secret`,
    manifest: {
      id,
      version: "1.2.3",
      name: "Provider " + id,
      types: ["movie", "series"],
      resources: ["stream", { name: "subtitles", types: ["movie", "series"] }],
      behaviorHints: { configurable: true },
    },
    flags: { official: false, protected: false },
    unknownField: { preserved: true },
  };
}

function playbackProviderDescriptor(pathname = "") {
  return {
    transportUrl: upstreamBaseUrl + pathname + "/manifest.json",
    manifest: {
      id: "org.example.playback" + pathname.replace(/[^a-z0-9]+/gi, "."),
      version: "1.0.0",
      name: "Playback provider",
      types: ["movie", "series"],
      resources: ["stream", "subtitles"],
    },
  };
}

async function importPlaybackProvider(device, pathname = "") {
  const imported = await request("/api/profile/providers", {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: device.managementCookie,
      "x-jumpgate-csrf": device.managementCsrf,
    },
    body: JSON.stringify({
      expectedRevision: 0,
      descriptors: [playbackProviderDescriptor(pathname)],
    }),
  });
  assert.equal(imported.response.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.count, 1);
}

async function claimConfiguredPlayback(config, device, options = {}) {
  const streamPath = options.streamPath || "movie/tt0133093";
  const stream = options.stream || PLAYABLE_STREAM;
  const observed = await request(`/_c/${config}/stream/${streamPath}.json`);
  assert.equal(observed.response.status, 200, JSON.stringify(observed.body));
  const claimed = await postClaim(
    {
      fingerprints: fingerprintStream(stream),
      intentUrlHash: hashOpaqueValue(stream.url),
      launchedAt: options.launchedAt || new Date().toISOString(),
    },
    { authorization: `Bearer ${device.deviceToken}` }
  );
  assert.equal(claimed.response.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.status, "claimed", JSON.stringify(claimed.body));
  assert.match(claimed.body.historyGrant, /^hg1_/);
  return claimed.body;
}

async function generateConfig(name, existingConfig = "") {
  const generated = await postJson("/configure/generate", {
    name,
    upstream: upstreamBaseUrl,
    existingConfig,
    settings: { subtitle_languages: "en", subtitles_enabled: true },
  });
  assert.equal(generated.response.status, 200);
  assert.equal(generated.body.ok, true);
  assert.equal(Object.hasOwn(generated.body, "bridgeBaseUrl"), false);
  assert.equal(Object.hasOwn(generated.body, "manifestUrl"), false);
  assert.equal(Object.hasOwn(generated.body, "installUrl"), false);
  return generated.body.config;
}

test("version is synchronized across runtime and manifests", async () => {
  const version = await request("/version");
  const manifest = await request("/manifest.json");

  assert.equal(version.response.status, 200);
  assert.match(version.response.headers.get("cache-control") || "", /no-store/);
  assert.equal(manifest.response.status, 200);
  assert.equal(version.body.version, "3.0.0");
  assert.equal(version.body.buildSha, TEST_BUILD_SHA);
  assert.equal(version.body.capabilities.managementTraktOAuth, "m1-m2-v1");
  assert.equal(manifest.body.version, version.body.version);
  assert.equal(require("../package.json").version, version.body.version);
  assert.equal(manifest.body.logo, "https://jumpgate.test/assets/jumpgate-mark.png");
  assert.equal(manifest.body.background, "https://jumpgate.test/assets/jumpgate-backdrop.jpg");
  assert.equal(app.parseBuildShaForTest(undefined), null);
  assert.equal(app.parseBuildShaForTest(""), null);
  assert.deepEqual(app.createVersionPayloadForTest(null), {
    version: "3.0.0",
    major: 3,
    minor: 0,
    patch: 0,
    buildSha: null,
    capabilities: {
      managementTraktOAuth: "m1-m2-v1",
    },
  });
  for (const invalid of [" ", TEST_BUILD_SHA.toUpperCase(), "a".repeat(39), "g".repeat(40)]) {
    assert.throws(() => app.parseBuildShaForTest(invalid), /invalid JUMPGATE_BUILD_SHA/);
  }
});

test("Trakt authorize overrides are loopback-only in tests and ignored in production", () => {
  const probe = [
    'const { resolveTraktAuthorizeUrl } = require("./lib/trakt-authorize-url");',
    "const actual = resolveTraktAuthorizeUrl(process.env);",
    "if (actual !== process.env.EXPECTED_TRAKT_AUTHORIZE_URL) process.exit(2);",
  ].join("");
  const run = (nodeEnv, override, expected) =>
    spawnSync(process.execPath, ["-e", probe], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: nodeEnv,
        JUMPGATE_TEST_TRAKT_AUTHORIZE_URL: override,
        EXPECTED_TRAKT_AUTHORIZE_URL: expected,
      },
      windowsHide: true,
    });

  const loopback = "https://127.0.0.1:9443/oauth/authorize";
  const accepted = run("test", loopback, loopback);
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const invalid of [
    "http://127.0.0.1:9443/oauth/authorize",
    "https://localhost:9443/oauth/authorize",
    "https://127.0.0.1:9443/not-authorize",
    "https://user@127.0.0.1:9443/oauth/authorize",
    "https://127.0.0.1:9443/oauth/authorize?scope=private",
  ]) {
    const rejected = run("test", invalid, loopback);
    assert.notEqual(rejected.status, 0, invalid);
    assert.match(rejected.stderr, /JUMPGATE_TEST_TRAKT_AUTHORIZE_URL/);
  }

  const production = run(
    "production",
    "https://attacker.example/not-authorize?state=ignored",
    "https://trakt.tv/oauth/authorize"
  );
  assert.equal(production.status, 0, production.stderr);
});

test("Trakt form clients remain test-only until the explicit switch release", () => {
  const {
    resolveManagementTraktClientProtocol,
  } = require("../lib/management-trakt-client-protocol");
  assert.equal(resolveManagementTraktClientProtocol({}), "ajax-v1");
  assert.equal(
    resolveManagementTraktClientProtocol({
      NODE_ENV: "production",
      JUMPGATE_TEST_MANAGEMENT_TRAKT_CLIENT_PROTOCOL: "form-v2",
    }),
    "ajax-v1"
  );
  assert.equal(
    resolveManagementTraktClientProtocol({
      NODE_ENV: "test",
      JUMPGATE_TEST_MANAGEMENT_TRAKT_CLIENT_PROTOCOL: "unknown",
    }),
    "ajax-v1"
  );
  assert.equal(
    resolveManagementTraktClientProtocol({
      NODE_ENV: "test",
      JUMPGATE_TEST_MANAGEMENT_TRAKT_CLIENT_PROTOCOL: "form-v2",
    }),
    "form-v2"
  );
});

test("GET /configure renders the canonical safe template under a per-response nonce", async () => {
  const first = await request("/configure");
  const second = await request("/configure");

  assert.equal(first.response.status, 200);
  assert.match(first.response.headers.get("content-type") || "", /^text\/html\b/i);
  assert.match(first.response.headers.get("cache-control") || "", /no-store/);
  assert.equal(first.response.headers.get("pragma"), "no-cache");
  assert.equal(first.response.headers.get("referrer-policy"), "same-origin");
  assert.equal(first.response.headers.get("x-content-type-options"), "nosniff");

  const csp = first.response.headers.get("content-security-policy") || "";
  const secondCsp = second.response.headers.get("content-security-policy") || "";
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp);
  const secondNonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(secondCsp);
  assert.ok(nonce);
  assert.ok(secondNonce);
  assert.notEqual(secondNonce[1], nonce[1]);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /font-src 'self'/);
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, /style-src-attr 'none'/);
  assert.match(csp, /https:\/\/link\.stremio\.com/);
  assert.match(csp, /https:\/\/api\.strem\.io/);
  assert.equal(csp.includes("unsafe-inline"), false);
  assert.equal(csp.includes("script-src 'self'"), false);

  const scripts = [...first.body.matchAll(/<script\b[^>]*\bnonce="([^"]+)"[^>]*>/gi)];
  assert.equal(scripts.length, 3);
  assert.equal(scripts.every((match) => match[1] === nonce[1]), true);
  const stylesheetRevision = /<link rel="stylesheet" href="\/assets\/configure\.css\?v=([A-Za-z0-9._-]+)">/.exec(
    first.body
  );
  assert.ok(stylesheetRevision);
  assert.equal(stylesheetRevision[1], `${require("../package.json").version}-r14`);
  const versionedScripts = [
    ...first.body.matchAll(
      /<script\b[^>]*src="\/assets\/(?:stremio-account-client|configure)\.js\?v=([A-Za-z0-9._-]+)"[^>]*><\/script>/g
    ),
  ];
  assert.equal(versionedScripts.length, 2);
  assert.equal(versionedScripts.every((match) => match[1] === stylesheetRevision[1]), true);
  assert.doesNotMatch(first.body, /<style\b|\sstyle=|\son(?:click|change|input)=/i);
  assert.match(first.body, /<html lang="en">/);
  assert.match(first.body, /<main\b/);
  assert.match(first.body, /Route Stremio through Jumpgate/);
  assert.match(first.body, /Pre-release hosted instance/);
  assert.match(first.body, /class="publication-footer"[^>]*aria-label="Bridge deployment status and policies"/);
  for (const document of ["privacy", "security", "support"]) {
    assert.match(
      first.body,
      new RegExp(`href="https://policies\\.jumpgate\\.test/${document}"`)
    );
  }
  assert.doesNotMatch(first.body, /github\.com\/ruizkinio\/jumpgate-bridge/i);
  assert.match(first.body, /id="connectStremioBtn"[^>]*disabled/);
  assert.match(first.body, /id="previewManualBtn"[^>]*disabled/);
  assert.match(first.body, /id="installConfiguredBtn"[^>]*disabled/);
  assert.match(first.body, /id="install"[^>]*readonly[^>]*disabled/);
  assert.match(first.body, /id="installManifest"[^>]*readonly[^>]*disabled/);
  assert.match(first.body, /id="copyInstallBtn"[^>]*disabled/);
  assert.match(first.body, /id="copyManifestBtn"[^>]*disabled/);
  assert.match(first.body, /id="installMaterial"[^>]*hidden/);
  assert.match(first.body, /id="technicalDetails"[^>]*hidden/);
  assert.match(first.body, /id="bridge"[^>]*readonly[^>]*disabled/);
  assert.match(first.body, /id="manifest"[^>]*readonly[^>]*disabled/);
  assert.match(first.body, /id="copyBridgeBtn"[^>]*disabled/);
  assert.match(first.body, /id="copyTechnicalManifestBtn"[^>]*disabled/);
  assert.match(first.body, /id="pairStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(first.body, /id="pairTimer"[^>]*class="small"/);
  assert.doesNotMatch(first.body, /id="pairTimer"[^>]*(?:role|aria-live)=/);
  assert.doesNotMatch(first.body, /id="stremioTimer"[^>]*(?:role|aria-live)=/);
  assert.match(first.body, /id="stremioStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(first.body, /id="stremioQr"[^>]*alt="[^"]+"/);
  const labels = first.body.match(/<label\b[^>]*>/gi) || [];
  assert.ok(labels.length > 0);
  assert.equal(labels.every((label) => /\bfor="[^"]+"/i.test(label)), true);

  for (const forbidden of [
    /installViaAccount/i,
    /AddonCollectionSet|setAddonCollection/i,
    /\bmutation\b/i,
    /\blog(?:ged)?\s*out\b|\blogout\b/i,
    /\bfallback\b/i,
    /\binstalled\b|\bverified\b|\bverification\b/i,
    /quick install/i,
    /zero-config is unchanged/i,
    /legacy IP-matched/i,
  ]) {
    assert.doesNotMatch(first.body, forbidden);
  }

  const favicon = await request("/favicon.ico");
  assert.equal(favicon.response.status, 204);
  assert.equal(favicon.body, "");
});

test("GET /configure safely renders dynamic prefills, messages, and bootstrap data", async () => {
  const name = 'Profile"></script><script>alert(1)</script>';
  const config = await createConfig(name, "", {
    subtitle_languages: "pt-br",
    subtitles_enabled: false,
  });
  const pairExpiresAt = Date.now() + 90 * 1000;
  const query = new URLSearchParams({
    config,
    notice: 'Ready <strong>now</strong> & "private"',
    error: "Problem </script><script>alert(2)</script>",
    pairCode: "ABCD-EFGH",
    pairExpiresAt: String(pairExpiresAt),
  });
  const { response, body } = await request("/configure?" + query.toString());

  assert.equal(response.status, 200);
  assert.match(body, /id="stepGenerate" class="done"/);
  assert.match(
    body,
    /id="name"[^>]*value="Profile&quot;&gt;&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/
  );
  assert.match(body, /id="subtitleLanguages"[^>]*value="pt-br"/);
  assert.match(body, /id="subtitlesEnabled" type="checkbox">/);
  assert.doesNotMatch(body, /id="subtitlesEnabled"[^>]*checked/);
  assert.match(body, /Ready &lt;strong&gt;now&lt;\/strong&gt; &amp; &quot;private&quot;/);
  assert.match(body, /Problem &lt;\/script&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.doesNotMatch(body, /<script>alert\([12]\)<\/script>/);

  const bootstrapTag = /<script id="jumpgate-bootstrap" nonce="([A-Za-z0-9_-]+)" type="application\/json">([\s\S]*?)<\/script>/.exec(
    body
  );
  assert.ok(bootstrapTag);
  const bootstrap = JSON.parse(bootstrapTag[2]);
  assert.equal(bootstrap.managementTraktConnect, "ajax-v1");
  assert.equal(bootstrap.initial.name, name);
  assert.equal(bootstrap.initial.subtitleLanguages, "pt-br");
  assert.equal(bootstrap.initial.subtitlesEnabled, false);
  assert.equal(bootstrap.initial.config, config);
  assert.equal(Object.hasOwn(bootstrap.initial, "bridgeBaseUrl"), false);
  assert.equal(Object.hasOwn(bootstrap.initial, "manifestUrl"), false);
  assert.equal(Object.hasOwn(bootstrap.initial, "installUrl"), false);
  assert.equal(bootstrap.pairPrefill.code, "ABCD-EFGH");
  assert.equal(bootstrap.pairPrefill.expiresAt, pairExpiresAt);
  assert.equal(body.includes("</script><script>alert(1)</script>"), false);
  assert.match(bootstrapTag[2], /\\u003c\/script\\u003e/);
});

test("configure CSS and JavaScript assets use explicit safe MIME and privacy headers", async () => {
  const css = await request("/assets/configure.css");
  assert.equal(css.response.status, 200);
  assert.match(css.response.headers.get("content-type") || "", /^text\/css\b/i);
  assert.match(css.response.headers.get("cache-control") || "", /public, max-age=300/);
  assert.equal(css.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(css.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(css.response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(css.body, /:focus-visible/);
  assert.match(css.body, /@media \(max-width:\s*720px\)/);
  assert.match(css.body, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css.body, /\.status-error/);

  const accountAsset = await request("/assets/stremio-account-client.js");
  assert.equal(accountAsset.response.status, 200);
  assert.match(accountAsset.response.headers.get("content-type") || "", /^application\/javascript\b/i);
  assert.equal(accountAsset.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(accountAsset.response.headers.get("referrer-policy"), "no-referrer");
  assert.match(accountAsset.body, /JumpgateStremioAccount/);

  const configureAsset = await request("/assets/configure.js");
  assert.equal(configureAsset.response.status, 200);
  assert.match(configureAsset.response.headers.get("content-type") || "", /^application\/javascript\b/i);
  assert.match(configureAsset.body, /gatewayCandidates/);

  const mark = await request("/assets/jumpgate-mark.png");
  assert.equal(mark.response.status, 200);
  assert.equal(mark.response.headers.get("content-type"), "image/png");
  assert.match(mark.response.headers.get("cache-control") || "", /public, max-age=86400/);
  assert.equal(mark.response.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(mark.response.headers.get("access-control-allow-origin"), "*");

  const backdrop = await request("/assets/jumpgate-backdrop.jpg");
  assert.equal(backdrop.response.status, 200);
  assert.equal(backdrop.response.headers.get("content-type"), "image/jpeg");

  const traktMark = await request("/assets/trakt-lockup-negative.svg");
  assert.equal(traktMark.response.status, 200);
  assert.match(traktMark.response.headers.get("content-type") || "", /^image\/svg\+xml\b/i);
  assert.equal(traktMark.response.headers.get("cross-origin-resource-policy"), "same-origin");

  const traktProvenance = await request("/assets/Trakt-BRANDING.txt");
  assert.equal(traktProvenance.response.status, 200);
  assert.match(traktProvenance.response.headers.get("content-type") || "", /^text\/plain\b/i);
  assert.match(traktProvenance.body, /https:\/\/trakt\.tv\/branding/);
  assert.match(traktProvenance.body, /logo\.default\.negative/);

  const font = await request("/assets/RobotoCondensed-Variable.ttf");
  assert.equal(font.response.status, 200);
  assert.equal(font.response.headers.get("content-type"), "font/ttf");
  assert.equal(font.response.headers.get("cross-origin-resource-policy"), "same-origin");

  for (const asset of ["Oxanium-Variable.ttf", "SourceSans3-Variable.ttf"]) {
    const displayFont = await request("/assets/" + asset);
    assert.equal(displayFont.response.status, 200);
    assert.equal(displayFont.response.headers.get("content-type"), "font/ttf");
    assert.equal(displayFont.response.headers.get("cross-origin-resource-policy"), "same-origin");
  }

  for (const asset of ["RobotoCondensed-OFL.txt", "Oxanium-OFL.txt", "SourceSans3-OFL.txt"]) {
    const license = await request("/assets/" + asset);
    assert.equal(license.response.status, 200);
    assert.match(license.response.headers.get("content-type") || "", /^text\/plain\b/i);
  }

  const unknownAsset = await request("/assets/not-allowed.js");
  assert.equal(unknownAsset.response.status, 404);
});

test("configured playback is source-claimed and profile isolated without IP", async () => {
  const profileA = await createConfig("Profile A", upstreamBaseUrl);
  const profileB = await createConfig("Profile B", upstreamBaseUrl);
  const deviceA = await pairDevice(profileA);
  const deviceA2 = await pairDevice(profileA);
  const deviceB = await pairDevice(profileB);
  await importPlaybackProvider(deviceA);

  const observed = await request(`/_c/${profileA}/stream/movie/tt0133093.json`, {
    headers: { "x-forwarded-for": "198.51.100.10" },
  });
  assert.equal(observed.response.status, 200);
  assert.deepEqual(observed.body.streams[0], PLAYABLE_STREAM);
  assert.equal(observed.response.headers.get("cache-control"), "no-store");

  const configuredIdentify = await request(`/_c/${profileA}/identify`, {
    headers: { "x-forwarded-for": "203.0.113.20" },
  });
  assert.equal(configuredIdentify.response.status, 410);
  assert.deepEqual(configuredIdentify.body, { ok: false, error: "source_claim_required" });

  const claimRequest = {
    fingerprints: fingerprintStream(PLAYABLE_STREAM),
    intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
    launchedAt: new Date().toISOString(),
    client: { platform: "android", version: "3.0.0" },
  };
  const claimed = await postClaim(claimRequest, {
    authorization: `Bearer ${deviceA.deviceToken}`,
    "x-forwarded-for": "203.0.113.20",
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.body.status, "claimed");
  assert.equal(claimed.body.context.canonicalIdentity.id, "tt0133093");
  assert.equal(claimed.body.context.traktEligible, true);
  assert.deepEqual(claimed.body.context.inlineSubtitles, []);
  assert.match(claimed.body.historyGrant, /^hg1_/);
  assert.equal(claimed.body.historyGrantKind, "canonical");
  assert.equal(claimed.body.sessionRevision, 1);
  const publicClaimJson = JSON.stringify(claimed.body);
  assert.equal(publicClaimJson.includes("abc123"), false);
  assert.equal(publicClaimJson.includes("token=sub"), false);

  const unauthenticatedOversized = await request("/v1/playback/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(16 * 1024) }),
  });
  assert.equal(unauthenticatedOversized.response.status, 401);

  const terminal = await postHistoryEvent(
    claimed.body,
    "stop",
    { authorization: `Bearer ${deviceA.deviceToken}` },
    { positionMs: 30_000, durationMs: 120_000, watchedMs: 30_000 }
  );
  assert.equal(terminal.response.status, 200, JSON.stringify(terminal.body));
  assert.equal(terminal.body.sessionState, "released");

  for (const device of [deviceA2, deviceB]) {
    const crossDeviceReplay = await postJson(
      "/v1/history/events",
      terminal.requestBody,
      {
        authorization: `Bearer ${device.deviceToken}`,
        "x-jumpgate-history-grant": claimed.body.historyGrant,
        "idempotency-key": terminal.idempotencyKey,
      }
    );
    assert.equal(crossDeviceReplay.response.status, 401);
    assert.deepEqual(crossDeviceReplay.body, {
      ok: false,
      error: "history_grant_invalid",
    });
  }

  const wrongDeviceRelease = await postJson(
    "/v1/playback/release",
    {
      sessionId: claimed.body.sessionId,
      terminalReceiptId: terminal.idempotencyKey,
    },
    { authorization: `Bearer ${deviceB.deviceToken}` }
  );
  assert.equal(wrongDeviceRelease.response.status, 200);
  assert.equal(wrongDeviceRelease.body.status, "not_found");

  const missingReceipt = await postJson(
    "/v1/playback/release",
    { sessionId: claimed.body.sessionId },
    { authorization: `Bearer ${deviceA.deviceToken}` }
  );
  assert.equal(missingReceipt.response.status, 409);
  assert.equal(missingReceipt.body.error, "history_terminal_receipt_required");
  const wrongReceipt = await postJson(
    "/v1/playback/release",
    {
      sessionId: claimed.body.sessionId,
      terminalReceiptId: crypto.randomUUID(),
    },
    { authorization: `Bearer ${deviceA.deviceToken}` }
  );
  assert.equal(wrongReceipt.response.status, 409);
  assert.equal(wrongReceipt.body.error, "history_terminal_receipt_required");

  const releaseOrder = [];
  const storage = await app.repositoriesForTest();
  const originalGrantRelease = storage.historyGrants.release.bind(storage.historyGrants);
  const originalSubtitleRelease = storage.subtitleDeliveries.invalidateRelease.bind(
    storage.subtitleDeliveries
  );
  const originalContextRelease = storage.playbackContexts.release.bind(storage.playbackContexts);
  storage.historyGrants.release = async (...args) => {
    releaseOrder.push("grant");
    return originalGrantRelease(...args);
  };
  storage.subtitleDeliveries.invalidateRelease = async (...args) => {
    releaseOrder.push("subtitle");
    return originalSubtitleRelease(...args);
  };
  storage.playbackContexts.release = async (...args) => {
    releaseOrder.push("context");
    return originalContextRelease(...args);
  };
  let released;
  try {
    released = await postJson(
      "/v1/playback/release",
      {
        sessionId: claimed.body.sessionId,
        terminalReceiptId: terminal.idempotencyKey,
      },
      { authorization: `Bearer ${deviceA.deviceToken}` }
    );
  } finally {
    storage.historyGrants.release = originalGrantRelease;
    storage.subtitleDeliveries.invalidateRelease = originalSubtitleRelease;
    storage.playbackContexts.release = originalContextRelease;
  }
  assert.equal(released.response.status, 200);
  assert.equal(released.body.status, "released");
  assert.deepEqual(releaseOrder, ["grant", "subtitle", "context"]);
  const releasedAgain = await postJson(
    "/v1/playback/release",
    {
      sessionId: claimed.body.sessionId,
      terminalReceiptId: terminal.idempotencyKey,
    },
    { authorization: `Bearer ${deviceA.deviceToken}` }
  );
  assert.equal(releasedAgain.body.status, "released");

  const repeatedPlayback = await postClaim(
    {
      ...claimRequest,
      attemptId: crypto.randomUUID(),
      launchedAt: new Date(Date.parse(claimRequest.launchedAt) + 1000).toISOString(),
    },
    { authorization: `Bearer ${deviceA.deviceToken}` }
  );
  assert.equal(repeatedPlayback.body.status, "claimed", JSON.stringify(repeatedPlayback.body));
  assert.notEqual(repeatedPlayback.body.sessionId, claimed.body.sessionId);
  const repeatedTerminal = await postHistoryEvent(
    repeatedPlayback.body,
    "stop",
    { authorization: `Bearer ${deviceA.deviceToken}` }
  );
  assert.equal(repeatedTerminal.response.status, 200, JSON.stringify(repeatedTerminal.body));
  assert.equal((await postJson(
    "/v1/playback/release",
    {
      sessionId: repeatedPlayback.body.sessionId,
      terminalReceiptId: repeatedTerminal.idempotencyKey,
    },
    { authorization: `Bearer ${deviceA.deviceToken}` }
  )).body.status, "released");

  const otherProfile = await postClaim(claimRequest, {
    authorization: `Bearer ${deviceB.deviceToken}`,
    "x-forwarded-for": "198.51.100.10",
  });
  assert.equal(otherProfile.response.status, 200);
  assert.equal(otherProfile.body.status, "not_found");

  const publicStore = await request("/identify", {
    headers: { "x-forwarded-for": "198.51.100.10" },
  });
  assert.equal(publicStore.response.status, 410);
  assert.deepEqual(publicStore.body, { ok: false, error: "source_claim_required" });
});

test("TMDB metadata returns only valid release and first-air years", async () => {
  const tmdbKey = "1".repeat(32);
  const tmdbFetch = (resultKey, item) => async (url) => ({
    ok: true,
    async json() {
      return url.includes("/find/")
        ? { movie_results: [], tv_results: [], [resultKey]: [item] }
        : { logos: [] };
    },
  });

  const movie = await app.getTmdbMetaForTest("tt9000001", tmdbKey, {
    fetch: tmdbFetch("movie_results", {
      id: 900001,
      title: "Release Year",
      release_date: "1999-03-31",
      poster_path: "/release-year.jpg",
    }),
  });
  const series = await app.getTmdbMetaForTest("tt9000002", tmdbKey, {
    fetch: tmdbFetch("tv_results", {
      id: 900002,
      name: "First Air Year",
      first_air_date: "2016-07-15",
      poster_path: "/first-air-year.jpg",
    }),
  });
  const invalid = await app.getTmdbMetaForTest("tt9000003", tmdbKey, {
    fetch: tmdbFetch("movie_results", {
      id: 900003,
      title: "Invalid Date",
      release_date: "2023-02-29",
    }),
  });

  assert.equal(movie.year, 1999);
  assert.equal(series.year, 2016);
  assert.equal(invalid.year, null);
});

test("configured streams carry approved TMDB display metadata without Trakt", async () => {
  const tmdbKey = "a".repeat(32);
  const config = await createConfig(
    "Display Without Trakt",
    upstreamBaseUrl,
    { trakt_enabled: false },
    {},
    tmdbKey
  );
  const device = await pairDevice(config);
  await importPlaybackProvider(device);
  const calls = [];
  app.setTmdbMetaLoaderForTest(async (imdbId, apiKey, options) => {
    calls.push({ imdbId, apiKey, signal: options.signal });
    return {
      name: "The Matrix",
      year: 1999,
      poster: "https://image.tmdb.org/t/p/w342/matrix.jpg",
      logo: "https://image.tmdb.org/t/p/w185/matrix-logo.png",
      canonicalIdentity: { provider: "tmdb", id: "unsafe-display-identity" },
      traktEligible: false,
    };
  });

  let observed;
  let claimed;
  try {
    observed = await request(`/_c/${config}/stream/movie/tt0133093.json`);
    claimed = await postClaim(
      {
        fingerprints: fingerprintStream(PLAYABLE_STREAM),
        intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
        launchedAt: new Date().toISOString(),
      },
      { authorization: `Bearer ${device.deviceToken}` }
    );
  } finally {
    app.setTmdbMetaLoaderForTest(null);
  }

  assert.equal(observed.response.status, 200);
  assert.deepEqual(observed.body.streams, [PLAYABLE_STREAM]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].imdbId, "tt0133093");
  assert.equal(calls[0].apiKey, tmdbKey);
  assert.equal(calls[0].signal instanceof AbortSignal, true);
  assert.equal(claimed.body.status, "claimed");
  assert.equal(claimed.body.context.canonicalIdentity.id, "tt0133093");
  assert.equal(claimed.body.context.traktEligible, true);
  assert.deepEqual(claimed.body.context.display, {
    title: "The Matrix",
    year: 1999,
    poster: "https://image.tmdb.org/t/p/w342/matrix.jpg",
    logo: "https://image.tmdb.org/t/p/w185/matrix-logo.png",
  });
});

test("configured stream display drops unsafe TMDB artwork and unrelated fields", async () => {
  const tmdbKey = "b".repeat(32);
  const config = await createConfig("Unsafe Display Artwork", upstreamBaseUrl, {}, {}, tmdbKey);
  const device = await pairDevice(config);
  await importPlaybackProvider(device);
  app.setTmdbMetaLoaderForTest(async () => ({
    name: "Safe Display",
    year: 1995,
    poster: "https://image.tmdb.org.evil.example/poster.jpg",
    logo: "https://image.tmdb.org@evil.example/logo.png",
    background: "https://image.tmdb.org/t/p/w780/ignored-background.jpg",
    authorization: "Bearer must-not-cross",
  }));

  let observed;
  let claimed;
  try {
    observed = await request(`/_c/${config}/stream/movie/tt0133093.json`);
    claimed = await postClaim(
      {
        fingerprints: fingerprintStream(PLAYABLE_STREAM),
        intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
        launchedAt: new Date().toISOString(),
      },
      { authorization: `Bearer ${device.deviceToken}` }
    );
  } finally {
    app.setTmdbMetaLoaderForTest(null);
  }

  assert.equal(observed.response.status, 200);
  assert.deepEqual(observed.body.streams, [PLAYABLE_STREAM]);
  assert.equal(claimed.body.status, "claimed");
  assert.deepEqual(claimed.body.context.display, { title: "Safe Display", year: 1995 });
  assert.equal(JSON.stringify(claimed.body).includes("must-not-cross"), false);
});

test(
  "configured stream display failures, aborts, malformed results, and timeout fail open",
  { timeout: 10000 },
  async () => {
    const tmdbKey = "c".repeat(32);
    const config = await createConfig("Display Failure Modes", upstreamBaseUrl, {}, {}, tmdbKey);
    const device = await pairDevice(config);
    await importPlaybackProvider(device);

    const immediateFailures = [
      async () => {
        throw new Error("TMDB unavailable");
      },
      async () => {
        const error = new Error("TMDB lookup aborted");
        error.name = "AbortError";
        throw error;
      },
      async () => "malformed metadata",
    ];
    try {
      for (const loader of immediateFailures) {
        app.setTmdbMetaLoaderForTest(loader);
        const observed = await request(`/_c/${config}/stream/movie/tt0133093.json`);
        assert.equal(observed.response.status, 200);
        assert.deepEqual(observed.body.streams, [PLAYABLE_STREAM]);
      }

      let timeoutSignal = null;
      app.setTmdbMetaLoaderForTest(async (_imdbId, _apiKey, options) => {
        timeoutSignal = options.signal;
        await new Promise(() => {});
      });
      const startedAt = Date.now();
      const timedOut = await request(`/_c/${config}/stream/movie/tt0133093.json`);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(timedOut.response.status, 200);
      assert.deepEqual(timedOut.body.streams, [PLAYABLE_STREAM]);
      assert.equal(timeoutSignal.aborted, true);
      assert.ok(elapsedMs >= app.configuredStreamDisplayTimeoutMsForTest - 100);
      assert.ok(elapsedMs < app.configuredStreamDisplayTimeoutMsForTest + 1500);
    } finally {
      app.setTmdbMetaLoaderForTest(null);
    }
  }
);

test("Trakt credentials are never delivered by device or configured-addon routes", async () => {
  const accessToken = "raw-token-delivery-must-not-escape";
  const refreshToken = "raw-refresh-delivery-must-not-escape";
  const config = await createConfig("No Raw Trakt Delivery", "", {}, {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const device = await pairDevice(config);
  const routes = [
    ["/v1/trakt/token", { authorization: `Bearer ${device.deviceToken}` }],
    [`/_c/${config}/auth/token`, {}],
    [`/${config}/auth/token`, {}],
  ];

  for (const [pathname, headers] of routes) {
    const response = await request(pathname, { headers });
    assert.equal(response.response.status, 404, pathname + " " + JSON.stringify(response.body));
    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes(accessToken), false);
    assert.equal(serialized.includes(refreshToken), false);
    assert.doesNotMatch(serialized, /access_token|refresh_token|client_id/i);
  }
});

test("claim-bound history queues Bridge-owned Trakt intents only for the exact canonical device grant", async () => {
  const accessToken = "server-only-scrobble-access";
  const refreshToken = "server-only-scrobble-refresh";
  const config = await createConfig("Claim-bound Trakt", upstreamBaseUrl, {}, {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  const device = await pairDevice(config);
  const otherConfig = await createConfig("Other Trakt Device");
  const otherDevice = await pairDevice(otherConfig);
  await importPlaybackProvider(device);
  const claimed = await claimConfiguredPlayback(config, device);
  assert.equal(claimed.sessionRevision, 1);
  assert.equal(claimed.historyGrantKind, "canonical");

  const eventBody = {
    event: "start",
    sessionRevision: claimed.sessionRevision,
    positionMs: 12_500,
    durationMs: 100_000,
    watchedMs: 12_500,
  };
  const unauthenticated = await postJson("/v1/history/events", eventBody, {
    "x-jumpgate-history-grant": claimed.historyGrant,
    "idempotency-key": crypto.randomUUID(),
  });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.body.error, "device_auth_required");

  const arbitrary = await postJson(
    "/v1/history/events",
    {
      ...eventBody,
      title: "Caller title",
      ids: { imdb: "tt9999999" },
      paused: true,
      backgrounded: true,
    },
    {
      authorization: "Bearer " + device.deviceToken,
      "x-jumpgate-history-grant": claimed.historyGrant,
      "idempotency-key": crypto.randomUUID(),
    }
  );
  assert.equal(arbitrary.response.status, 400);
  assert.deepEqual(arbitrary.body, { ok: false, error: "invalid_history_event" });

  const crossDevice = await postJson("/v1/history/events", eventBody, {
    authorization: "Bearer " + otherDevice.deviceToken,
    "x-jumpgate-history-grant": claimed.historyGrant,
    "idempotency-key": crypto.randomUUID(),
  });
  assert.equal(crossDevice.response.status, 401);
  assert.deepEqual(crossDevice.body, { ok: false, error: "history_grant_invalid" });

  const started = await postHistoryEvent(
    claimed,
    "start",
    { authorization: "Bearer " + device.deviceToken },
    { positionMs: 12_500, durationMs: 100_000, watchedMs: 12_500 }
  );
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, "applied");
  assert.equal(started.body.grantKind, "canonical");
  assert.equal(started.body.sessionRevision, 1);
  assert.equal(started.body.dispatchIntent.event, "start");
  assert.equal(started.body.dispatchIntent.progress, 12.5);
  assert.deepEqual(started.body.dispatchIntent.canonicalIdentity, claimed.context.canonicalIdentity);

  const exactReplay = await postJson("/v1/history/events", started.requestBody, {
    authorization: "Bearer " + device.deviceToken,
    "x-jumpgate-history-grant": claimed.historyGrant,
    "idempotency-key": started.idempotencyKey,
  });
  assert.deepEqual(exactReplay.body, started.body);
  const idempotencyConflict = await postJson(
    "/v1/history/events",
    { ...started.requestBody, positionMs: 13_000, watchedMs: 13_000 },
    {
      authorization: "Bearer " + device.deviceToken,
      "x-jumpgate-history-grant": claimed.historyGrant,
      "idempotency-key": started.idempotencyKey,
    }
  );
  assert.equal(idempotencyConflict.response.status, 409);
  assert.deepEqual(idempotencyConflict.body, {
    ok: false,
    error: "history_event_idempotency_conflict",
  });

  const paused = await postHistoryEvent(
    claimed,
    "pause",
    { authorization: "Bearer " + device.deviceToken },
    {
      sessionRevision: started.body.sessionRevision,
      positionMs: 25_000,
      durationMs: 100_000,
      watchedMs: 25_000,
    }
  );
  assert.equal(paused.response.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body.sessionRevision, 2);
  assert.equal(paused.body.dispatchIntent.event, "pause");

  const staleUpdate = await postHistoryEvent(
    claimed,
    "progress",
    { authorization: "Bearer " + device.deviceToken },
    { positionMs: 30_000, durationMs: 100_000, watchedMs: 30_000 }
  );
  assert.equal(staleUpdate.response.status, 409);
  assert.deepEqual(staleUpdate.body, { ok: false, error: "history_session_stale" });

  const resumed = await postHistoryEvent(
    claimed,
    "resume",
    { authorization: "Bearer " + device.deviceToken },
    {
      sessionRevision: paused.body.sessionRevision,
      positionMs: 30_000,
      durationMs: 100_000,
      watchedMs: 30_000,
    }
  );
  assert.equal(resumed.response.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.sessionRevision, 3);
  assert.equal(resumed.body.dispatchIntent.event, "resume");

  const terminal = await postHistoryEvent(
    claimed,
    "stop",
    { authorization: "Bearer " + device.deviceToken },
    {
      sessionRevision: resumed.body.sessionRevision,
      positionMs: 50_000,
      durationMs: 100_000,
      watchedMs: 50_000,
    }
  );
  assert.equal(terminal.response.status, 200, JSON.stringify(terminal.body));
  assert.equal(terminal.body.sessionState, "released");
  assert.equal(terminal.body.dispatchIntent.event, "stop");

  const afterTerminal = await postHistoryEvent(
    claimed,
    "progress",
    { authorization: "Bearer " + device.deviceToken },
    {
      sessionRevision: terminal.body.sessionRevision,
      positionMs: 51_000,
      durationMs: 100_000,
      watchedMs: 51_000,
    }
  );
  assert.equal(afterTerminal.response.status, 409);
  assert.deepEqual(afterTerminal.body, { ok: false, error: "history_grant_released" });

  const released = await postJson(
    "/v1/playback/release",
    { sessionId: claimed.sessionId, terminalReceiptId: terminal.idempotencyKey },
    { authorization: "Bearer " + device.deviceToken }
  );
  assert.equal(released.body.status, "released");

  const repositorySet = await app.repositoriesForTest();
  const intents = await repositorySet.historyGrants.listDispatchIntents(
    device.profileId,
    claimed.sessionId
  );
  assert.deepEqual(intents.map((intent) => intent.event), ["start", "pause", "resume", "stop"]);
  assert.equal(intents.every((intent) => intent.canonicalIdentity.id === "tt0133093"), true);

  const localOnly = await claimConfiguredPlayback(config, device, {
    streamPath: "movie/addon-private:thing",
    stream: UNKNOWN_STREAM,
    launchedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.equal(localOnly.context.canonicalIdentity, null);
  assert.equal(localOnly.context.traktEligible, false);
  assert.equal(localOnly.historyGrantKind, "local");
  const localEvent = await postHistoryEvent(
    localOnly,
    "start",
    { authorization: "Bearer " + device.deviceToken },
    { positionMs: 1_000, durationMs: 100_000, watchedMs: 1_000 }
  );
  assert.equal(localEvent.response.status, 200, JSON.stringify(localEvent.body));
  assert.equal(localEvent.body.grantKind, "local");
  assert.equal(localEvent.body.dispatchIntent, null);

  const serialized = JSON.stringify([
    started.body,
    paused.body,
    resumed.body,
    terminal.body,
    localEvent.body,
    intents,
  ]);
  assert.equal(serialized.includes(accessToken), false);
  assert.equal(serialized.includes(refreshToken), false);
  assert.doesNotMatch(serialized, /access_token|refresh_token|client_id/i);
});
test("legacy Trakt OAuth entry points cannot start an unfenced browser flow", async () => {
  const directPost = await postJson("/auth/trakt/start", { name: "Unfenced" });
  assert.equal(directPost.response.status, 404);
  const directGet = await request("/auth/trakt?name=Unfenced", { redirect: "manual" });
  assert.equal(directGet.response.status, 404);

  const legacyCallback = await request(
    "/auth/trakt/callback?code=unused&state=v1.legacy-unfenced-state",
    { redirect: "manual" }
  );
  assert.equal(legacyCallback.response.status, 303);
  assert.match(legacyCallback.response.headers.get("location") || "", /Trakt.*start.*again/i);

  const config = await createConfig("Managed OAuth Only");
  const device = await pairDevice(config);
  const managed = await postManagementTraktConnect(device);
  assert.equal(managed.response.status, 303);
  assert.match(managed.response.headers.get("location"), /^https:\/\/trakt\.tv\//);
});

test("pair activation discloses no private capability when revocation wins final emission", async () => {
  const config = await createConfig("Activation Disclosure Fence");
  const issued = await postJson("/pair/device/code", {});
  const repositorySet = await app.repositoriesForTest();
  const original = repositorySet.devices.commitDisclosure;
  let intercepted = 0;
  repositorySet.devices.commitDisclosure = async function (...args) {
    intercepted += 1;
    await app.revokeDeviceForTest(args[0], args[1]);
    return original.apply(this, args);
  };

  try {
    const activated = await postJson("/pair/activate", {
      userCode: issued.body.userCode,
      config,
      activationRetryToken: activationRetryToken(),
    });
    assert.equal(intercepted, 1);
    assert.equal(activated.response.status, 409, JSON.stringify(activated.body));
    assert.equal(JSON.stringify(activated.body).includes(config), false);
    assert.doesNotMatch(
      JSON.stringify(activated.body),
      /bridgeBaseUrl|manifestUrl|installUrl|managementCsrf|deviceToken|device_token/
    );
  } finally {
    repositorySet.devices.commitDisclosure = original;
  }
});

test("pair redemption discloses no device capability when revocation wins final emission", async () => {
  const config = await createConfig("Redemption Disclosure Fence");
  const issued = await postJson("/pair/device/code", {});
  const activated = await postJson("/pair/activate", {
    userCode: issued.body.userCode,
    config,
    activationRetryToken: activationRetryToken(),
  });
  assert.equal(activated.response.status, 200, JSON.stringify(activated.body));

  const repositorySet = await app.repositoriesForTest();
  const original = repositorySet.devices.commitDisclosure;
  let intercepted = 0;
  repositorySet.devices.commitDisclosure = async function (...args) {
    intercepted += 1;
    await app.revokeDeviceForTest(args[0], args[1]);
    return original.apply(this, args);
  };

  try {
    const redeemed = await postJson("/pair/device/token", {
      deviceCode: issued.body.deviceCode,
    });
    assert.equal(intercepted, 1);
    assert.equal(redeemed.response.status, 409, JSON.stringify(redeemed.body));
    assert.equal(JSON.stringify(redeemed.body).includes(config), false);
    assert.doesNotMatch(
      JSON.stringify(redeemed.body),
      /bridgeBaseUrl|config|deviceToken|device_token/
    );
  } finally {
    repositorySet.devices.commitDisclosure = original;
  }
});

test("configured manifest and subtitle routes reflect imported provider capabilities", async () => {
  const config = await createConfig("Gateway Routes", upstreamBaseUrl + "/must-not-be-used");
  const device = await pairDevice(config);
  await importPlaybackProvider(device);

  const manifest = await request(`/_c/${config}/manifest.json`);
  assert.equal(manifest.response.status, 200);
  assert.deepEqual(manifest.body.types, ["movie", "series"]);
  assert.deepEqual(manifest.body.resources, [
    { name: "stream", types: ["movie", "series"], idPrefixes: [] },
    { name: "subtitles", types: ["movie", "series"], idPrefixes: [] },
    "catalog",
  ]);

  const before = upstreamRequests.length;
  const subtitles = await request(
    `/_c/${config}/subtitles/movie/tt0133093/videoHash=ab%252Fcd&filename=A%26B.mkv.json`
  );
  assert.equal(subtitles.response.status, 200);
  assert.deepEqual(subtitles.body.subtitles, [
    { id: "en", lang: "en", url: "https://subs.example/movie-en.srt" },
    { id: "es", lang: "es", url: "https://subs.example/movie-es.srt" },
  ]);
  assert.equal(upstreamRequests.length, before + 1);
  assert.match(
    upstreamRequests.at(-1),
    /\/subtitles\/movie\/tt0133093\/videoHash=ab%252Fcd&filename=A%26B\.mkv\.json$/
  );
  assert.equal(upstreamRequests.at(-1).includes("must-not-be-used"), false);

  const invalidExtra = await request(
    `/_c/${config}/subtitles/movie/tt0133093/filename-without-value.json`
  );
  assert.equal(invalidExtra.response.status, 400);
  assert.deepEqual(invalidExtra.body, { subtitles: [] });

  const alias = await request(`/${config}/stream/movie/tt0133093.json`);
  assert.equal(alias.response.status, 200);
  assert.deepEqual(alias.body.streams, [PLAYABLE_STREAM]);
});

test("empty and unknown configured sources never reuse an older canonical identity", async () => {
  const profile = await createConfig("Unknown Profile", upstreamBaseUrl);
  const device = await pairDevice(profile);
  await importPlaybackProvider(device);

  const empty = await request(`/_c/${profile}/stream/movie/empty-source.json`);
  assert.deepEqual(empty.body.streams, []);
  const emptyClaim = await postClaim(
    {
      fingerprints: ["v1:url:sha256:" + "0".repeat(64)],
      intentUrlHash: "0".repeat(64),
      launchedAt: new Date().toISOString(),
    },
    { authorization: `Bearer ${device.deviceToken}` }
  );
  assert.equal(emptyClaim.body.status, "not_found");

  const unknown = await request(`/_c/${profile}/stream/movie/addon-private:thing.json`);
  assert.deepEqual(unknown.body.streams[0], UNKNOWN_STREAM);
  const unknownClaim = await postClaim(
    {
      fingerprints: fingerprintStream(UNKNOWN_STREAM),
      intentUrlHash: hashOpaqueValue(UNKNOWN_STREAM.url),
      launchedAt: new Date(Date.now() + 1000).toISOString(),
    },
    { authorization: `Bearer ${device.deviceToken}` }
  );
  assert.equal(unknownClaim.body.status, "claimed");
  assert.equal(unknownClaim.body.context.traktEligible, false);
  assert.equal(unknownClaim.body.context.canonicalIdentity, null);
});

test("addon-private IDs containing an IMDb substring never become Trakt eligible", async () => {
  const profile = await createConfig(
    "Private ID Collision",
    upstreamBaseUrl,
    {},
    {},
    "d".repeat(32)
  );
  const device = await pairDevice(profile);
  await importPlaybackProvider(device);
  let metadataCalls = 0;
  app.setTmdbMetaLoaderForTest(async () => {
    metadataCalls += 1;
    return { name: "Must Not Load", year: 1999 };
  });
  let response;
  try {
    response = await request(`/_c/${profile}/stream/movie/addon-private:tt0133093.json`);
  } finally {
    app.setTmdbMetaLoaderForTest(null);
  }
  assert.deepEqual(response.body.streams[0], UNKNOWN_STREAM);
  assert.equal(metadataCalls, 0);

  const claim = await postClaim(
    {
      fingerprints: fingerprintStream(UNKNOWN_STREAM),
      intentUrlHash: hashOpaqueValue(UNKNOWN_STREAM.url),
      launchedAt: new Date().toISOString(),
    },
    { authorization: `Bearer ${device.deviceToken}` }
  );
  assert.equal(claim.body.status, "claimed");
  assert.equal(claim.body.context.canonicalIdentity, null);
  assert.equal(claim.body.context.traktEligible, false);
});

test("malformed IMDb suffixes are not canonical for movies or episodes", async () => {
  const cases = [
    { profile: "Malformed Movie ID", type: "movie", id: "tt0133093:garbage" },
    { profile: "Malformed Episode ID", type: "series", id: "tt0133093:1:2:garbage" },
  ];
  for (const item of cases) {
    const profile = await createConfig(item.profile, upstreamBaseUrl);
    const device = await pairDevice(profile);
    await importPlaybackProvider(device);
    const response = await request(`/_c/${profile}/stream/${item.type}/${item.id}.json`);
    assert.deepEqual(response.body.streams[0], PLAYABLE_STREAM);
    const claim = await postClaim(
      {
        fingerprints: fingerprintStream(PLAYABLE_STREAM),
        intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
        launchedAt: new Date().toISOString(),
      },
      { authorization: `Bearer ${device.deviceToken}` }
    );
    assert.equal(claim.body.status, "claimed");
    assert.equal(claim.body.context.canonicalIdentity, null);
    assert.equal(claim.body.context.traktEligible, false);
  }
});

test("malformed provider entries cannot create hidden claimable contexts", async () => {
  const invalidProfile = await createConfig("Malformed Only", upstreamBaseUrl);
  const invalidDevice = await pairDevice(invalidProfile);
  await importPlaybackProvider(invalidDevice);
  const invalid = await request(`/_c/${invalidProfile}/stream/movie/only-malformed.json`);
  assert.deepEqual(invalid.body.streams, []);
  const hidden = await postClaim(
    {
      fingerprints: fingerprintStream(PLAYABLE_STREAM),
      intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
      launchedAt: new Date().toISOString(),
    },
    { authorization: `Bearer ${invalidDevice.deviceToken}` }
  );
  assert.equal(hidden.body.status, "not_found");

  const mixedProfile = await createConfig("Malformed Mixed", upstreamBaseUrl);
  const mixedDevice = await pairDevice(mixedProfile);
  await importPlaybackProvider(mixedDevice, "/mixed-malformed");
  const mixed = await request(`/_c/${mixedProfile}/stream/movie/tt0133093.json`);
  assert.deepEqual(mixed.body.streams, [PLAYABLE_STREAM]);
  const visible = await postClaim(
    {
      fingerprints: fingerprintStream(PLAYABLE_STREAM),
      intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
      launchedAt: new Date().toISOString(),
    },
    { authorization: `Bearer ${mixedDevice.deviceToken}` }
  );
  assert.equal(visible.body.status, "claimed");
});

test("regeneration preserves the paired profile scope", async () => {
  const firstConfig = await generateConfig("Continuity A");
  const device = await pairDevice(firstConfig);
  await importPlaybackProvider(device);
  const regenerated = await generateConfig("Continuity B", firstConfig);
  await request(`/_c/${regenerated}/stream/movie/tt0133093.json`);

  const claim = await postClaim(
    {
      fingerprints: fingerprintStream(PLAYABLE_STREAM),
      intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
      launchedAt: new Date().toISOString(),
    },
    { authorization: `Bearer ${device.deviceToken}` }
  );
  assert.equal(claim.body.status, "claimed");
  assert.equal(claim.body.context.canonicalIdentity.id, "tt0133093");
});

test("expanded server preserves the cached AJAX m1 launch and callback contract", async () => {
  const device = await pairDevice(await generateConfig("OAuth AJAX Compatibility"));
  const repositorySet = await app.repositoriesForTest();
  const before = repositorySet.oauthStates.storageSnapshot().length;

  const wrongOrigin = await postLegacyManagementTraktConnect(device, {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(wrongOrigin.response.status, 403);
  assert.deepEqual(wrongOrigin.body, { ok: false, error: "origin_not_allowed" });
  assert.equal(wrongOrigin.response.headers.get("set-cookie"), null);
  assert.equal(repositorySet.oauthStates.storageSnapshot().length, before);

  const started = await postLegacyManagementTraktConnect(device);
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body, {
    ok: true,
    url: "/api/profile/trakt/connect/continue",
  });
  assert.doesNotMatch(
    JSON.stringify(started.body),
    /m[12]\.|stateToken|binding|profileId|csrf/i
  );
  const stateCookie = responseCookie(started.response, "jg_management_oauth_state");
  const bindingCookie = responseCookie(started.response, "jg_management_oauth_binding");
  assert.match(stateCookie, /^jg_management_oauth_state=[A-Za-z0-9_-]{43}$/);
  assert.match(bindingCookie, /^jg_management_oauth_binding=[A-Za-z0-9_-]{43}$/);
  assert.equal(
    responseSetCookies(started.response).some((value) =>
      value.startsWith("jg_management_oauth_binding_")
    ),
    false
  );
  const stateToken = stateCookie.split("=", 2)[1];

  const continued = await request(started.body.url, {
    headers: { cookie: stateCookie },
    redirect: "manual",
  });
  assert.equal(continued.response.status, 303);
  assert.match(
    responseSetCookies(continued.response).join("\n"),
    /jg_management_oauth_state=;.*Max-Age=0/i
  );
  const authorization = new URL(continued.response.headers.get("location"));
  assert.equal(authorization.origin, "https://trakt.tv");
  assert.deepEqual(
    [...authorization.searchParams.keys()].sort(),
    ["client_id", "redirect_uri", "response_type", "state"]
  );
  assert.equal(authorization.searchParams.get("state"), "m1." + stateToken);

  const callback = await request(
    "/auth/trakt/callback?error=access_denied&state=" + encodeURIComponent("m1." + stateToken),
    {
      headers: { cookie: bindingCookie },
      redirect: "manual",
    }
  );
  assert.equal(callback.response.status, 303);
  assert.match(callback.response.headers.get("location"), /^\/configure\?error=/);
  assert.match(
    responseSetCookies(callback.response).join("\n"),
    /jg_management_oauth_binding=;.*Max-Age=0/i
  );
  assert.equal(
    responseSetCookies(callback.response).some((value) =>
      value.startsWith("jg_management_oauth_binding_")
    ),
    false
  );
});

test("management Trakt navigation POST rejects unsafe requests before state issuance", async () => {
  const device = await pairDevice(await generateConfig("OAuth Launch Rejections"));
  const repositorySet = await app.repositoriesForTest();
  const before = repositorySet.oauthStates.storageSnapshot().length;
  const encodedCsrf = encodeURIComponent(device.managementCsrf);
  const cases = [
    {
      name: "missing Origin",
      headers: {
        cookie: device.managementCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${encodedCsrf}`,
    },
    {
      name: "wrong Origin",
      headers: {
        cookie: device.managementCookie,
        origin: "https://attacker.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${encodedCsrf}`,
    },
    {
      name: "Origin with path",
      headers: {
        cookie: device.managementCookie,
        origin: "https://jumpgate.test/not-an-origin",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${encodedCsrf}`,
    },
    {
      name: "wrong content type",
      headers: {
        cookie: device.managementCookie,
        origin: "https://jumpgate.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ csrf: device.managementCsrf }),
    },
    {
      name: "header-only CSRF",
      headers: {
        cookie: device.managementCookie,
        origin: "https://jumpgate.test",
        "content-type": "application/x-www-form-urlencoded",
        "x-jumpgate-csrf": device.managementCsrf,
      },
      body: "",
    },
    {
      name: "duplicate CSRF fields",
      headers: {
        cookie: device.managementCookie,
        origin: "https://jumpgate.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${encodedCsrf}&csrf=${encodedCsrf}`,
    },
    {
      name: "extra profile field",
      headers: {
        cookie: device.managementCookie,
        origin: "https://jumpgate.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${encodedCsrf}&profileId=other-profile`,
    },
    {
      name: "wrong body CSRF despite valid header",
      headers: {
        cookie: device.managementCookie,
        origin: "https://jumpgate.test",
        "content-type": "application/x-www-form-urlencoded",
        "x-jumpgate-csrf": device.managementCsrf,
      },
      body: "csrf=wrong",
    },
    {
      name: "missing management session",
      headers: {
        origin: "https://jumpgate.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `csrf=${encodedCsrf}`,
    },
    {
      name: "oversized body",
      headers: {
        cookie: device.managementCookie,
        origin: "https://jumpgate.test",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "csrf=" + "x".repeat(2048),
    },
  ];

  for (const item of cases) {
    const rejected = await request("/api/profile/trakt/connect", {
      method: "POST",
      headers: item.headers,
      body: item.body,
      redirect: "manual",
    });
    assert.equal(rejected.response.status, 303, item.name);
    const destination = new URL(
      rejected.response.headers.get("location"),
      "https://jumpgate.test"
    );
    assert.equal(destination.origin, "https://jumpgate.test", item.name);
    assert.equal(destination.pathname, "/configure", item.name);
    assert.deepEqual([...destination.searchParams.keys()], ["error"], item.name);
    assert.equal(rejected.response.headers.get("set-cookie"), null, item.name);
    assert.doesNotMatch(rejected.response.headers.get("content-type") || "", /json/i, item.name);
  }
  assert.equal(repositorySet.oauthStates.storageSnapshot().length, before);
});

test("management Trakt issue failures use a sanitized 303 without cookies", async () => {
  const device = await pairDevice(await generateConfig("OAuth Issue Failure"));
  const repositorySet = await app.repositoriesForTest();
  const originalIssue = repositorySet.oauthStates.issue;
  repositorySet.oauthStates.issue = async () => {
    throw new Error("simulated issue failure");
  };
  try {
    const rejected = await postManagementTraktConnect(device);
    assert.equal(rejected.response.status, 303);
    assert.match(rejected.response.headers.get("location"), /^\/configure\?error=/);
    assert.equal(rejected.response.headers.get("set-cookie"), null);
    assert.doesNotMatch(rejected.response.headers.get("content-type") || "", /json/i);
  } finally {
    repositorySet.oauthStates.issue = originalIssue;
  }
});

test("management Trakt launch limiting is authenticated and profile-scoped", async () => {
  const first = await pairDevice(await generateConfig("OAuth Limited Profile A"));
  const second = await pairDevice(await generateConfig("OAuth Limited Profile B"));
  const repositorySet = await app.repositoriesForTest();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const allowed = await postManagementTraktConnect(first);
    assert.equal(allowed.response.status, 303);
    assert.match(allowed.response.headers.get("location"), /^https:\/\/trakt\.tv\//);
  }
  const issuedBeforeLimit = repositorySet.oauthStates.storageSnapshot().length;
  const legacyLimited = await postLegacyManagementTraktConnect(first);
  assert.equal(legacyLimited.response.status, 429);
  assert.deepEqual(legacyLimited.body, { ok: false, error: "rate_limited" });
  assert.equal(legacyLimited.response.headers.get("ratelimit-limit"), "8");
  assert.equal(legacyLimited.response.headers.get("set-cookie"), null);
  assert.equal(repositorySet.oauthStates.storageSnapshot().length, issuedBeforeLimit);

  const limited = await postManagementTraktConnect(first);
  assert.equal(limited.response.status, 303);
  assert.match(limited.response.headers.get("location"), /^\/configure\?error=/);
  assert.equal(limited.response.headers.get("ratelimit-limit"), "8");
  assert.equal(limited.response.headers.get("set-cookie"), null);
  assert.equal(repositorySet.oauthStates.storageSnapshot().length, issuedBeforeLimit);

  const isolated = await postManagementTraktConnect(second);
  assert.equal(isolated.response.status, 303);
  assert.match(isolated.response.headers.get("location"), /^https:\/\/trakt\.tv\//);
});

test("management Trakt IP launch limiting isolates source addresses", async () => {
  const device = await pairDevice(await generateConfig("OAuth IP Limited Profile"));
  const repositorySet = await app.repositoriesForTest();
  app.setManagementTraktIpLaunchLimitForTest(2);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const allowed = await postManagementTraktConnectFromAddress(device, "127.0.0.2");
      assert.equal(allowed.status, 303);
      assert.match(allowed.headers.location, /^https:\/\/trakt\.tv\//);
      assert.equal(allowed.headers["ratelimit-limit"], "8");
    }

    const issuedBeforeLimit = repositorySet.oauthStates.storageSnapshot().length;
    const limited = await postManagementTraktConnectFromAddress(device, "127.0.0.2");
    assert.equal(limited.status, 303);
    assert.match(limited.headers.location, /^\/configure\?error=/);
    assert.equal(limited.headers["ratelimit-limit"], "2");
    assert.equal(limited.headers["set-cookie"], undefined);
    assert.equal(repositorySet.oauthStates.storageSnapshot().length, issuedBeforeLimit);

    const isolated = await postManagementTraktConnectFromAddress(device, "127.0.0.3");
    assert.equal(isolated.status, 303);
    assert.match(isolated.headers.location, /^https:\/\/trakt\.tv\//);
    assert.equal(isolated.headers["ratelimit-limit"], "8");
  } finally {
    app.setManagementTraktIpLaunchLimitForTest(null);
  }
});

test("slotted OAuth cookies support reversed callbacks and exact profile isolation", async () => {
  const first = await pairDevice(await generateConfig("OAuth Slotted Profile A"));
  const second = await pairDevice(await generateConfig("OAuth Slotted Profile B"));
  const firstFlow = await beginManagementTraktConnect(first);
  const secondFlow = await beginManagementTraktConnect(second);
  assert.equal(firstFlow.authorization.searchParams.has("scope"), false);
  assert.equal(secondFlow.authorization.searchParams.has("scope"), false);
  assert.notEqual(firstFlow.state, secondFlow.state);
  assert.notEqual(firstFlow.bindingCookieName, secondFlow.bindingCookieName);

  const jar = new Map();
  applyResponseCookies(jar, firstFlow.started.response);
  applyResponseCookies(jar, secondFlow.started.response);
  assert.equal(jar.size, 2);
  let exchanges = 0;
  app.setTraktAuthCodeExchangeForTest(async (code) => {
    exchanges += 1;
    return {
      access_token: `slotted-access-${code}`,
      refresh_token: `slotted-refresh-${code}`,
      token_expiry: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  try {
    const secondCallback = await request(
      `/auth/trakt/callback?code=second&state=${encodeURIComponent(secondFlow.state)}`,
      { headers: { cookie: cookieJarHeader(jar) }, redirect: "manual" }
    );
    assert.equal(secondCallback.response.status, 303);
    assert.match(secondCallback.response.headers.get("location"), /[?&]notice=/);
    const secondClears = responseSetCookies(secondCallback.response);
    assert.equal(secondClears.length, 1);
    assert.match(secondClears[0], new RegExp(`^${secondFlow.bindingCookieName}=;`));
    assert.equal(secondClears[0].includes(firstFlow.bindingCookieName), false);
    applyResponseCookies(jar, secondCallback.response);
    assert.equal(jar.has(firstFlow.bindingCookieName), true);
    assert.equal(jar.has(secondFlow.bindingCookieName), false);

    const firstCallback = await request(
      `/auth/trakt/callback?code=first&state=${encodeURIComponent(firstFlow.state)}`,
      { headers: { cookie: cookieJarHeader(jar) }, redirect: "manual" }
    );
    assert.equal(firstCallback.response.status, 303);
    assert.match(firstCallback.response.headers.get("location"), /[?&]notice=/);
    const firstClears = responseSetCookies(firstCallback.response);
    assert.equal(firstClears.length, 1);
    assert.match(firstClears[0], new RegExp(`^${firstFlow.bindingCookieName}=;`));
    applyResponseCookies(jar, firstCallback.response);
    assert.equal(jar.size, 0);
    assert.equal(exchanges, 2);
  } finally {
    app.setTraktAuthCodeExchangeForTest(null);
  }

  const firstStatus = await request("/api/profile/devices", {
    headers: {
      cookie: first.managementCookie,
      "x-jumpgate-csrf": first.managementCsrf,
    },
  });
  const secondStatus = await request("/api/profile/devices", {
    headers: {
      cookie: second.managementCookie,
      "x-jumpgate-csrf": second.managementCsrf,
    },
  });
  assert.equal(firstStatus.body.traktLinked, true);
  assert.equal(secondStatus.body.traktLinked, true);
});

test("OAuth callback rejects a wrong binding and clears only the selected slot", async () => {
  const first = await pairDevice(await generateConfig("OAuth Wrong Binding A"));
  const second = await pairDevice(await generateConfig("OAuth Wrong Binding B"));
  const firstFlow = await beginManagementTraktConnect(first);
  const secondFlow = await beginManagementTraktConnect(second);
  const secondBindingValue = secondFlow.bindingCookie.slice(
    secondFlow.bindingCookie.indexOf("=") + 1
  );
  const cookies = [
    `${firstFlow.bindingCookieName}=${secondBindingValue}`,
    secondFlow.bindingCookie,
  ].join("; ");
  let exchanges = 0;
  app.setTraktAuthCodeExchangeForTest(async () => {
    exchanges += 1;
    return {
      access_token: "wrong-binding-access",
      refresh_token: "wrong-binding-refresh",
      token_expiry: Math.floor(Date.now() / 1000) + 3600,
    };
  });
  try {
    const rejected = await request(
      `/auth/trakt/callback?code=wrong&state=${encodeURIComponent(firstFlow.state)}`,
      { headers: { cookie: cookies }, redirect: "manual" }
    );
    assert.equal(rejected.response.status, 303);
    assert.match(rejected.response.headers.get("location"), /[?&]error=/);
    const clears = responseSetCookies(rejected.response);
    assert.equal(clears.length, 1);
    assert.match(clears[0], new RegExp(`^${firstFlow.bindingCookieName}=;`));
    assert.equal(clears[0].includes(secondFlow.bindingCookieName), false);
    assert.equal(exchanges, 0);
  } finally {
    app.setTraktAuthCodeExchangeForTest(null);
  }
});

test("form-v2 callbacks never fall back to the fixed legacy binding cookie", async () => {
  const device = await pairDevice(await generateConfig("OAuth Form Cookie Scheme"));
  const flow = await beginManagementTraktConnect(device);
  const unrelatedFlow = await beginManagementTraktConnect(device);
  const flowBindingValue = flow.bindingCookie.slice(flow.bindingCookie.indexOf("=") + 1);
  const unrelatedBindingValue = unrelatedFlow.bindingCookie.slice(
    unrelatedFlow.bindingCookie.indexOf("=") + 1
  );
  const jar = new Map([
    ["jg_management_oauth_binding", flowBindingValue],
    [unrelatedFlow.bindingCookieName, unrelatedBindingValue],
  ]);
  let exchanges = 0;
  app.setTraktAuthCodeExchangeForTest(async () => {
    exchanges += 1;
    throw new Error("unexpected Trakt token exchange");
  });
  try {
    const rejected = await request(
      `/auth/trakt/callback?code=wrong-scheme&state=${encodeURIComponent(flow.state)}`,
      { headers: { cookie: cookieJarHeader(jar) }, redirect: "manual" }
    );
    assert.equal(rejected.response.status, 303);
    assert.match(rejected.response.headers.get("location"), /[?&]error=/);
    const clears = responseSetCookies(rejected.response);
    assert.equal(clears.length, 1);
    assert.match(clears[0], new RegExp(`^${flow.bindingCookieName}=;`));
    applyResponseCookies(jar, rejected.response);
    assert.equal(jar.has("jg_management_oauth_binding"), true);
    assert.equal(jar.has(unrelatedFlow.bindingCookieName), true);
    assert.equal(exchanges, 0);
  } finally {
    app.setTraktAuthCodeExchangeForTest(null);
  }
});

test("ajax-v1 callbacks never fall back to slotted binding cookies", async () => {
  const device = await pairDevice(await generateConfig("OAuth AJAX Cookie Scheme"));
  const started = await postLegacyManagementTraktConnect(device);
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  const stateCookie = responseCookie(started.response, "jg_management_oauth_state");
  const bindingCookie = responseCookie(started.response, "jg_management_oauth_binding");
  const continued = await request(started.body.url, {
    headers: { cookie: stateCookie },
    redirect: "manual",
  });
  const state = new URL(continued.response.headers.get("location")).searchParams.get("state");
  assert.match(state, /^m1\.[A-Za-z0-9_-]{43}$/);
  const stateToken = state.slice(3);
  const slottedCookieName = "jg_management_oauth_binding_" + crypto
    .createHash("sha256")
    .update(stateToken, "ascii")
    .digest("base64url")
    .slice(0, 22);
  const jar = new Map([
    [slottedCookieName, bindingCookie.slice(bindingCookie.indexOf("=") + 1)],
  ]);
  let exchanges = 0;
  app.setTraktAuthCodeExchangeForTest(async () => {
    exchanges += 1;
    throw new Error("unexpected Trakt token exchange");
  });
  try {
    const rejected = await request(
      `/auth/trakt/callback?code=wrong-scheme&state=${encodeURIComponent(state)}`,
      { headers: { cookie: cookieJarHeader(jar) }, redirect: "manual" }
    );
    assert.equal(rejected.response.status, 303);
    assert.match(rejected.response.headers.get("location"), /[?&]error=/);
    const clears = responseSetCookies(rejected.response);
    assert.equal(clears.length, 1);
    assert.match(clears[0], /^jg_management_oauth_binding=;/);
    applyResponseCookies(jar, rejected.response);
    assert.equal(jar.has(slottedCookieName), true);
    assert.equal(exchanges, 0);
  } finally {
    app.setTraktAuthCodeExchangeForTest(null);
  }
});

test("management OAuth state payload protocols cannot be relabeled", async () => {
  const device = await pairDevice(await generateConfig("OAuth State Protocol Mismatch"));
  const flow = await beginManagementTraktConnect(device);
  const bindingValue = flow.bindingCookie.slice(flow.bindingCookie.indexOf("=") + 1);
  const mismatchedState = "m1." + flow.state.slice(3);
  let exchanges = 0;
  app.setTraktAuthCodeExchangeForTest(async () => {
    exchanges += 1;
    throw new Error("unexpected Trakt token exchange");
  });
  try {
    const rejected = await request(
      `/auth/trakt/callback?code=wrong-protocol&state=${encodeURIComponent(mismatchedState)}`,
      {
        headers: { cookie: `jg_management_oauth_binding=${bindingValue}` },
        redirect: "manual",
      }
    );
    assert.equal(rejected.response.status, 303);
    assert.match(rejected.response.headers.get("location"), /[?&]error=/);
    const clears = responseSetCookies(rejected.response);
    assert.equal(clears.length, 1);
    assert.match(clears[0], /^jg_management_oauth_binding=;/);
    assert.equal(exchanges, 0);
  } finally {
    app.setTraktAuthCodeExchangeForTest(null);
  }
});

test("malformed management OAuth state cannot select or clear a cookie slot", async () => {
  const device = await pairDevice(await generateConfig("OAuth Malformed State"));
  const flow = await beginManagementTraktConnect(device);
  const malformed = "m1." + "a".repeat(42) + ".unexpected";
  const rejected = await request(
    `/auth/trakt/callback?code=ignored&state=${encodeURIComponent(malformed)}`,
    { headers: { cookie: flow.bindingCookie }, redirect: "manual" }
  );
  assert.equal(rejected.response.status, 303);
  assert.match(rejected.response.headers.get("location"), /[?&]error=/);
  assert.equal(rejected.response.headers.get("set-cookie"), null);
});

test("configured request logs omit client IPs", async () => {
  const profile = await createConfig("Log Privacy", upstreamBaseUrl);
  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(" "));
  try {
    await request(`/_c/${profile}/stream/movie/tt0133093.json`, {
      headers: { "x-forwarded-for": "198.51.100.77" },
    });
    await request(
      `/_c/${profile}/subtitles/movie/tt0133093/videoHash=private%252Fhash&filename=secret-file.mkv&token=sensitive-token.json`
    );
    const retiredResume = await postJson(`/_c/${profile}/resume`, {
      imdb: "tt0133093",
      position: 12.5,
      duration: 100,
    });
    assert.equal(retiredResume.response.status, 410);
    assert.deepEqual(retiredResume.body, { ok: false, error: "history_grant_required" });
  } finally {
    console.log = original;
  }
  assert.equal(messages.some((line) => line.includes("198.51.100.77")), false);
  assert.equal(messages.some((line) => line.includes(profile)), false);
  assert.equal(messages.some((line) => line.includes("tt0133093")), false);
  for (const secret of ["private", "hash", "secret-file", "sensitive-token", "videoHash", "filename"]) {
    assert.equal(messages.some((line) => line.includes(secret)), false);
  }
  assert.equal(messages.some((line) => line.includes("<redacted>/<redacted>.json")), true);
  assert.equal(messages.some((line) => line.includes("pos=") || line.includes("dur=") || line.includes("%")), false);
});

test("history request logs redact content keys", async () => {
  const config = await createConfig("History Log Privacy");
  const device = await pairDevice(config);
  const key = hashOpaqueValue("history-log-private-key");
  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(" "));
  try {
    await request(`/v1/history/${key}`, {
      headers: { authorization: `Bearer ${device.deviceToken}` },
    });
  } finally {
    console.log = original;
  }
  assert.equal(messages.some((line) => line.includes(key)), false);
  assert.equal(messages.some((line) => line.includes("/v1/history/<redacted>")), true);
});

test("pairing codes are redacted from request logs", async () => {
  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(" "));
  try {
    await request("/p/ABCD-EFGH", { redirect: "manual" });
  } finally {
    console.log = original;
  }
  assert.equal(messages.some((line) => line.includes("ABCD-EFGH")), false);
  assert.equal(messages.some((line) => line.includes("/p/<redacted>")), true);
});

test("repeated-slash origin-form request logs redact every private route family", async () => {
  const alias = "legacy-alias-origin-private-" + "a".repeat(40);
  const cases = [
    {
      target: "//p/ORIGIN-PAIR-PRIVATE",
      expected: "/p/<redacted>",
      secrets: ["ORIGIN-PAIR-PRIVATE"],
    },
    {
      target: "//api/profile/backups/origin-backup-private/restored",
      expected: "/api/profile/backups/<redacted>/restored",
      secrets: ["origin-backup-private"],
    },
    {
      target: "//_c/origin-config-private/manifest.json",
      expected: "/_c/<redacted>/manifest.json",
      secrets: ["origin-config-private"],
    },
    {
      target: `//${alias}/manifest.json`,
      expected: "/<redacted>/manifest.json",
      secrets: [alias],
    },
    {
      target: "//stream/movie/origin-stream-private.json",
      expected: "/stream/movie/<redacted>",
      secrets: ["origin-stream-private"],
    },
    {
      target: "//subtitles/movie/origin-subtitle-private/videoHash=origin-extra-private.json",
      expected: "/subtitles/movie/<redacted>/<redacted>.json",
      secrets: ["origin-subtitle-private", "origin-extra-private", "videoHash"],
    },
    {
      target: "//meta/origin-metadata-private.json",
      expected: "/meta/<redacted>",
      secrets: ["origin-metadata-private"],
    },
    {
      target: "//v1/history/origin-history-private",
      expected: "/v1/history/<redacted>",
      secrets: ["origin-history-private"],
    },
    {
      target: "//v1/subtitles/origin-session-private/origin-artifact-private/0/origin-file-private.srt",
      expected: "/v1/subtitles/<redacted>",
      secrets: ["origin-session-private", "origin-artifact-private", "origin-file-private"],
    },
  ];
  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(" "));
  try {
    for (const entry of cases) await requestRawTarget(entry.target);
  } finally {
    console.log = original;
  }

  for (const entry of cases) {
    assert.equal(messages.includes(`[REQ] GET ${entry.expected}`), true, entry.target);
    for (const secret of entry.secrets) {
      assert.equal(messages.some((line) => line.includes(secret)), false, secret);
    }
  }
});

test("backup request logs redact IDs while preserving route diagnostics", async () => {
  const config = await createConfig("Backup Log Privacy");
  const profile = await pairDevice(config);
  const authHeaders = {
    cookie: profile.managementCookie,
    "x-jumpgate-csrf": profile.managementCsrf,
    origin: "https://jumpgate.test",
  };
  const backedUp = await postJson(
    "/api/profile/backups",
    { collection: [providerDescriptor("org.example.backup-log")], reason: "log-redaction-test" },
    authHeaders
  );
  assert.equal(backedUp.response.status, 200);
  const backupId = backedUp.body.backup.id;
  assert.match(backupId, /^[A-Za-z0-9_-]{16,}$/);
  const malformedSuffixId = "malformed-suffix-backup-private";
  const encodedId = "encoded-backup-private";
  const absoluteId = "absolute-form-backup-private";

  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args.join(" "));
  try {
    const fetched = await request(`/api/profile/backups/${backupId}`, {
      headers: authHeaders,
    });
    assert.equal(fetched.response.status, 200);
    const restored = await postJson(
      `/api/profile/backups/${backupId}/restored`,
      {},
      authHeaders
    );
    assert.equal(restored.response.status, 200);
    await request(`/api/profile/backups/${malformedSuffixId}/restored/unexpected`, {
      headers: authHeaders,
    });
    await request(`/api/profile/backups/${encodedId}%2Fshadow/restored`, {
      headers: authHeaders,
    });
    const absolute = await requestRawTarget(
      `http://jumpgate.test/api/profile/backups/${absoluteId}/diagnostic-tail?ignored=1`
    );
    assert.equal(absolute.status, 404);
  } finally {
    console.log = original;
  }

  for (const privateId of [backupId, malformedSuffixId, encodedId, absoluteId]) {
    assert.equal(messages.some((line) => line.includes(privateId)), false, privateId);
  }
  assert.equal(messages.some((line) => line.includes("jumpgate.test")), false);
  assert.equal(messages.includes("[REQ] GET /api/profile/backups/<redacted>"), true);
  assert.equal(
    messages.includes("[REQ] POST /api/profile/backups/<redacted>/restored"),
    true
  );
  assert.equal(
    messages.includes("[REQ] GET /api/profile/backups/<redacted>/restored/unexpected"),
    true
  );
  assert.equal(
    messages.includes("[REQ] GET /api/profile/backups/<redacted>/restored"),
    true
  );
  assert.equal(
    messages.includes("[REQ] GET /api/profile/backups/<redacted>/diagnostic-tail"),
    true
  );

  const malformedAbsoluteId = "malformed-absolute-backup-private";
  const malformedHostId = "malformed-host-backup-private";
  const schemeRelativeId = "scheme-relative-backup-private";
  const invalidAuthorityId = "invalid-authority-backup-private";
  const encodedRouteId = "encoded-route-backup-private";
  const directCases = [
    {
      target: `http:///api/profile/backups/${malformedAbsoluteId}/tail?ignored=1`,
      privateId: malformedAbsoluteId,
      expected: "/api/profile/backups/<redacted>/tail",
    },
    {
      target: `http:////malformed.example/api/profile/backups/${malformedHostId}/tail`,
      privateId: malformedHostId,
      expected: "/api/profile/backups/<redacted>/tail",
    },
    {
      target: `//relative.example/api/profile/backups/${schemeRelativeId}/tail`,
      privateId: schemeRelativeId,
      expected: "/api/profile/backups/<redacted>/tail",
    },
    {
      target: `http://invalid.example:bad/api/profile/backups/${invalidAuthorityId}/tail`,
      privateId: invalidAuthorityId,
      expected: "/api/profile/backups/<redacted>/tail",
    },
    {
      target: `http://encoded.example/%61pi%2Fprofile%2Fbackups%2F${encodedRouteId}%2Fshadow/restored?ignored=1`,
      privateId: encodedRouteId,
      expected: "/api/profile/backups/<redacted>/restored",
    },
  ];
  for (const { target, privateId, expected } of directCases) {
    const redacted = app.redactPathForLogForTest(target);
    assert.equal(redacted, expected, target);
    assert.equal(redacted.includes(privateId), false, privateId);
    for (const host of [
      "malformed.example",
      "relative.example",
      "invalid.example",
      "encoded.example",
    ]) {
      assert.equal(redacted.includes(host), false, host);
    }
  }
});

test("cleanup runner prunes every pass and contains prune and timer failures", async (t) => {
  await t.test("overlapping timer passes prune while durable cleanup is hung", async () => {
    let releaseDurable;
    let markDurableStarted;
    let markAllPrunes;
    let pruneCalls = 0;
    let durableCalls = 0;
    const expectedPrunes = 6;
    const durableStarted = new Promise((resolve) => {
      markDurableStarted = resolve;
    });
    const allPrunes = new Promise((resolve) => {
      markAllPrunes = resolve;
    });
    const durableWait = new Promise((resolve) => {
      releaseDurable = resolve;
    });
    t.after(() => releaseDurable());
    const runner = app.createStorageCleanupRunnerForTest({
      runEveryPass() {
        pruneCalls += 1;
        if (pruneCalls === expectedPrunes) markAllPrunes();
      },
      async runDurableCleanup() {
        durableCalls += 1;
        markDurableStarted();
        await durableWait;
      },
      onPassError() {},
      onTimerError() {},
    });

    const first = runner.runTimerPass();
    await durableStarted;
    const overlaps = Array.from({ length: expectedPrunes - 1 }, () => runner.runTimerPass());
    await allPrunes;
    await Promise.all(overlaps);
    assert.equal(pruneCalls, expectedPrunes);
    assert.equal(durableCalls, 1);
    assert.ok(runner.getActivePromise());
    assert.deepEqual(runner.getState(), {
      durableCleanupActive: true,
      timerObserverCount: 1,
    });
    releaseDurable();
    await first;
    assert.equal(runner.getActivePromise(), null);
  });

  await t.test("permanently hung durable cleanup keeps timer observer state bounded", async () => {
    let markDurableStarted;
    let pruneCalls = 0;
    let durableCalls = 0;
    const durableStarted = new Promise((resolve) => {
      markDurableStarted = resolve;
    });
    const runner = app.createStorageCleanupRunnerForTest({
      runEveryPass() {
        pruneCalls += 1;
      },
      async runDurableCleanup() {
        durableCalls += 1;
        markDurableStarted();
        await new Promise(() => {});
      },
      onPassError() {},
      onTimerError() {},
    });

    void runner.runTimerPass();
    await durableStarted;
    const timerPasses = Array.from({ length: 1_000 }, () => runner.runTimerPass());
    await Promise.all(timerPasses);
    assert.equal(pruneCalls, 1_001);
    assert.equal(durableCalls, 1);
    assert.deepEqual(runner.getState(), {
      durableCleanupActive: true,
      timerObserverCount: 1,
    });
  });

  await t.test("sync and async prune faults cannot suppress cleanup or escape diagnostics", async () => {
    const syncPruneError = new Error("private sync prune detail");
    const asyncPruneError = new Error("private async prune detail");
    const reported = [];
    let pruneCalls = 0;
    let durableCalls = 0;
    let reportCalls = 0;
    const runner = app.createStorageCleanupRunnerForTest({
      runEveryPass() {
        pruneCalls += 1;
        if (pruneCalls === 1) throw syncPruneError;
        return Promise.reject(asyncPruneError);
      },
      async runDurableCleanup() {
        durableCalls += 1;
      },
      onPassError(error) {
        reported.push(error);
        reportCalls += 1;
        if (reportCalls === 1) throw new Error("sync diagnostic sink unavailable");
        return Promise.reject(new Error("diagnostic sink unavailable"));
      },
      onTimerError() {},
    });

    await runner.run();
    await runner.run();
    assert.deepEqual(reported, [syncPruneError, asyncPruneError]);
    assert.equal(durableCalls, 2);
  });

  await t.test("timer execution contains sync and async cleanup and diagnostic rejection", async () => {
    const syncCleanupError = new Error("private sync durable detail");
    const asyncCleanupError = new Error("private async durable detail");
    const reported = [];
    let durableCalls = 0;
    let reportCalls = 0;
    const runner = app.createStorageCleanupRunnerForTest({
      runEveryPass() {},
      runDurableCleanup() {
        durableCalls += 1;
        if (durableCalls === 1) throw syncCleanupError;
        return Promise.reject(asyncCleanupError);
      },
      onPassError() {},
      onTimerError(error) {
        reported.push(error);
        reportCalls += 1;
        if (reportCalls === 1) throw new Error("sync timer diagnostic sink unavailable");
        return Promise.reject(new Error("timer diagnostic sink unavailable"));
      },
    });

    await runner.runTimerPass();
    await runner.runTimerPass();
    assert.deepEqual(reported, [syncCleanupError, asyncCleanupError]);
    assert.equal(runner.getActivePromise(), null);
  });

  await t.test("direct execution propagates durable rejection and resets coalescing", async () => {
    const cleanupError = new Error("private direct durable detail");
    const runner = app.createStorageCleanupRunnerForTest({
      runEveryPass() {},
      runDurableCleanup() {
        return Promise.reject(cleanupError);
      },
      onPassError() {},
      onTimerError() {},
    });

    await assert.rejects(runner.run(), cleanupError);
    assert.equal(runner.getActivePromise(), null);
  });
});

test("deployment policy presentation is all-or-none and safe by default", () => {
  const resolvePresentation = app.resolvePublicationPresentationForTest;
  assert.deepEqual(resolvePresentation({}), {
    status: "Pre-release deployment",
    policyUrls: null,
  });
  const unconfiguredMarkup = app.renderPublicationPolicyLinksForTest(resolvePresentation({}));
  assert.match(unconfiguredMarkup, /policy links are not published for this deployment/i);
  assert.doesNotMatch(unconfiguredMarkup, /<a\b|href=/i);
  const complete = {
    JUMPGATE_DEPLOYMENT_STATUS: "Pre-release self-hosted instance",
    JUMPGATE_PRIVACY_POLICY_URL: "https://self-host.example/privacy",
    JUMPGATE_SECURITY_POLICY_URL: "https://self-host.example/security",
    JUMPGATE_SUPPORT_POLICY_URL: "http://127.0.0.1:7515/support",
  };
  assert.deepEqual(resolvePresentation(complete), {
    status: complete.JUMPGATE_DEPLOYMENT_STATUS,
    policyUrls: {
      privacy: complete.JUMPGATE_PRIVACY_POLICY_URL,
      security: complete.JUMPGATE_SECURITY_POLICY_URL,
      support: complete.JUMPGATE_SUPPORT_POLICY_URL,
    },
  });

  const policyNames = [
    "JUMPGATE_PRIVACY_POLICY_URL",
    "JUMPGATE_SECURITY_POLICY_URL",
    "JUMPGATE_SUPPORT_POLICY_URL",
  ];
  for (let mask = 1; mask < 2 ** policyNames.length - 1; mask += 1) {
    const partial = {};
    for (let index = 0; index < policyNames.length; index += 1) {
      if ((mask & (1 << index)) !== 0) partial[policyNames[index]] = complete[policyNames[index]];
    }
    assert.throws(
      () => resolvePresentation(partial),
      /must be configured together/
    );
  }
  assert.throws(
    () =>
      resolvePresentation({
        ...complete,
        JUMPGATE_PRIVACY_POLICY_URL: 42,
      }),
    /JUMPGATE_PRIVACY_POLICY_URL/
  );
  for (const unsafe of [
    "http://policies.example/privacy",
    "javascript:alert(1)",
    "https://user@policies.example/privacy",
    "https://policies.example/privacy?profile=private",
    "https://policies.example/privacy#private",
  ]) {
    assert.throws(
      () => resolvePresentation({ ...complete, JUMPGATE_PRIVACY_POLICY_URL: unsafe }),
      /must use HTTPS|valid absolute URL/
    );
  }
  for (const status of [" pre-release", "x".repeat(81), "pre\nrelease"]) {
    assert.throws(
      () => resolvePresentation({ JUMPGATE_DEPLOYMENT_STATUS: status }),
      /JUMPGATE_DEPLOYMENT_STATUS/
    );
  }
});

test("pairing rate limits isolate normalized flows behind a shared IP", () => {
  const shared = { ip: "198.51.100.10" };
  const first = app.getPairRateLimitSignalsForTest({
    ...shared,
    body: { userCode: "ABCD-EFGH", deviceCode: "device-code-a" },
  });
  const compact = app.getPairRateLimitSignalsForTest({
    ip: "203.0.113.20",
    body: { user_code: "ABCDEFGH", device_code: "device-code-a" },
  });
  const second = app.getPairRateLimitSignalsForTest({
    ...shared,
    body: { pairCode: "WXYZ-1234", deviceCode: "device-code-b" },
  });

  assert.equal(first.activation, compact.activation);
  assert.equal(first.token, compact.token);
  assert.notEqual(first.activation, second.activation);
  assert.notEqual(first.token, second.token);
});

test("route-specific JSON body limits are enforced", async () => {
  const profile = await createConfig("Claim Body Limit");
  const device = await pairDevice(profile);
  const oversized = await request("/v1/playback/claim", {
    method: "POST",
    headers: {
      authorization: `Bearer ${device.deviceToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ padding: "x".repeat(9_000) }),
  });
  assert.equal(oversized.response.status, 413);
});

test("claim endpoint requires a paired device bearer", async () => {
  const missing = await postClaim({
    fingerprints: fingerprintStream(PLAYABLE_STREAM),
    intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
    launchedAt: new Date().toISOString(),
  });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.error, "device_auth_required");
});

test("retired identity and caller-selected lifecycle routes are unconditional 410", async () => {
  const configured = await createConfig("Retired protocol routes");
  const device = await pairDevice(configured);
  const contentKey = "a".repeat(64);
  const malformedBody = "{";
  const oversizedBody = JSON.stringify({ padding: "x".repeat(32 * 1024) });
  const validBody = JSON.stringify({
    event: "start",
    sessionId: "caller-selected-session",
    imdb: "tt0133093",
    position: 10,
    duration: 100,
  });
  const bearer = { authorization: `Bearer ${device.deviceToken}` };
  const cases = [
    { method: "GET", path: "/identify", error: "source_claim_required" },
    { method: "POST", path: "/resume", body: malformedBody, error: "history_grant_required" },
    { method: "POST", path: "/resume", body: oversizedBody, error: "history_grant_required" },
    {
      method: "POST",
      path: "/resume",
      body: validBody,
      headers: bearer,
      error: "history_grant_required",
    },
    {
      method: "POST",
      path: "/v1/trakt/scrobble/start",
      body: malformedBody,
      error: "history_grant_required",
    },
    {
      method: "POST",
      path: "/v1/trakt/scrobble/start",
      body: oversizedBody,
      error: "history_grant_required",
    },
    ...["start", "pause", "resume", "stop", "completion", "caller-selected"].map((event) => ({
      method: "POST",
      path: `/v1/trakt/scrobble/${event}`,
      body: validBody,
      headers: bearer,
      error: "history_grant_required",
    })),
    {
      method: "PUT",
      path: `/v1/history/${contentKey}`,
      body: malformedBody,
      error: "history_grant_required",
    },
    {
      method: "PUT",
      path: `/v1/history/${contentKey}`,
      body: validBody,
      headers: bearer,
      error: "history_grant_required",
    },
    {
      method: "DELETE",
      path: `/v1/history/${contentKey}`,
      headers: bearer,
      error: "history_grant_required",
    },
    { method: "GET", path: "/_c/not-a-config/identify", error: "source_claim_required" },
    {
      method: "POST",
      path: "/_c/not-a-config/resume",
      body: malformedBody,
      error: "history_grant_required",
    },
    { method: "GET", path: "/not-a-config/identify", error: "source_claim_required" },
    {
      method: "POST",
      path: "/not-a-config/resume",
      body: oversizedBody,
      error: "history_grant_required",
    },
    { method: "GET", path: `/_c/${configured}/identify`, error: "source_claim_required" },
    {
      method: "POST",
      path: `/_c/${configured}/resume`,
      body: malformedBody,
      error: "history_grant_required",
    },
    { method: "GET", path: `/${configured}/identify`, error: "source_claim_required" },
    {
      method: "POST",
      path: `/${configured}/resume`,
      body: oversizedBody,
      error: "history_grant_required",
    },
  ];

  for (const item of cases) {
    const controller = new AbortController();
    const headers = {
      ...(item.body === undefined ? {} : { "content-type": "application/json" }),
      ...item.headers,
    };
    const pending = request(item.path, {
      method: item.method,
      headers,
      ...(item.body === undefined ? {} : { body: item.body }),
      signal: controller.signal,
    });
    const settled = await settledWithin(pending, 1_000);
    if (!settled) {
      controller.abort();
      await pending.catch(() => {});
    }
    assert.equal(
      settled,
      true,
      `${item.method} ${item.path} did not settle through the retirement handler`
    );
    const result = await pending;
    assert.equal(result.response.status, 410, `${item.method} ${item.path}`);
    assert.deepEqual(result.body, { ok: false, error: item.error }, `${item.method} ${item.path}`);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("pragma"), "no-cache");
  }
});

test("authenticated subtitle discovery, resolution, and delivery stay claim-bound and secret-free", async () => {
  const config = await createConfig("Authenticated Subtitles");
  const device = await pairDevice(config);
  const sameProfileDevice = await pairDevice(config);
  const otherConfig = await createConfig("Other Subtitle Profile");
  const otherProfileDevice = await pairDevice(otherConfig);
  await importPlaybackProvider(device);
  const observed = await request(`/_c/${config}/stream/movie/tt0133093.json`);
  assert.equal(observed.response.status, 200);
  const firstLaunch = Date.now();
  const claimed = await postClaim(
    {
      fingerprints: fingerprintStream(PLAYABLE_STREAM),
      intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
      launchedAt: firstLaunch,
    },
    { authorization: `Bearer ${device.deviceToken}` }
  );
  assert.equal(claimed.body.status, "claimed");
  const sessionId = claimed.body.sessionId;
  const auth = { authorization: `Bearer ${device.deviceToken}` };

  const missingAuth = await postJson("/v1/subtitles/discover", { sessionId });
  assert.equal(missingAuth.response.status, 401);
  assert.match(missingAuth.response.headers.get("cache-control") || "", /no-store/);
  const malicious = await postJson(
    "/v1/subtitles/discover",
    { sessionId, url: "https://attacker.example/subtitle.srt", headers: { Authorization: "secret" } },
    auth
  );
  assert.equal(malicious.response.status, 400);

  const discovered = await postJson("/v1/subtitles/discover", { sessionId }, auth);
  assert.equal(discovered.response.status, 200, JSON.stringify(discovered.body));
  assert.deepEqual(Object.keys(discovered.body).sort(), ["schemaVersion", "subtitles"]);
  assert.equal(discovered.body.schemaVersion, 1);
  assert.equal(discovered.body.subtitles.length, 3);
  assert.deepEqual(
    Object.keys(discovered.body.subtitles[0]).sort(),
    ["format", "label", "language", "rank", "selector"]
  );
  assert.match(discovered.body.subtitles[0].selector, /^[a-f0-9]{64}$/);
  assert.deepEqual(discovered.body.subtitles.map((item) => item.rank), [1, 2, 3]);
  assert.ok(discovered.body.subtitles.every((item) => item.label.length <= 64));
  const discoveryJson = JSON.stringify(discovered.body);
  for (const secret of [
    "https://",
    "token",
    "Authorization",
    "headers",
    "provider",
    "objectKey",
    "generation",
    "contextRevision",
  ]) {
    assert.equal(discoveryJson.includes(secret), false, secret);
  }

  const crossDevice = await postJson(
    "/v1/subtitles/discover",
    { sessionId },
    { authorization: `Bearer ${sameProfileDevice.deviceToken}` }
  );
  assert.equal(crossDevice.response.status, 404);
  const crossProfile = await postJson(
    "/v1/subtitles/discover",
    { sessionId },
    { authorization: `Bearer ${otherProfileDevice.deviceToken}` }
  );
  assert.equal(crossProfile.response.status, 404);

  const selector = discovered.body.subtitles[0].selector;
  const tampered = await postJson(
    "/v1/subtitles/resolve",
    {
      sessionId,
      selector: selector.slice(0, -1) + (selector.endsWith("0") ? "1" : "0"),
    },
    auth
  );
  assert.equal(tampered.response.status, 404);
  const rejectedCapability = await postJson(
    "/v1/subtitles/resolve",
    { sessionId, selector, sourceCapability: { url: "https://attacker.example/owned.srt" } },
    auth
  );
  assert.equal(rejectedCapability.response.status, 400);
  const rejectedSchema = await postJson(
    "/v1/subtitles/resolve",
    { sessionId, selector, responseSchemaVersion: 1 },
    auth
  );
  assert.equal(rejectedSchema.response.status, 400);

  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  const fetchWait = new Promise((resolve) => { releaseFetch = resolve; });
  subtitleSourcePause = {
    started: markFetchStarted,
    wait: fetchWait,
  };
  const resolving = postJson(
    "/v1/subtitles/resolve",
    { sessionId, selector, responseSchemaVersion: 2 },
    auth
  );
  await fetchStarted;
  const busy = await postJson(
    "/v1/subtitles/resolve",
    { sessionId, selector, responseSchemaVersion: 2 },
    auth
  );
  assert.equal(busy.response.status, 409, JSON.stringify(busy.body));
  assert.deepEqual(busy.body, { ok: false, error: "subtitle_busy" });
  assert.match(busy.response.headers.get("retry-after") || "", /^[1-9][0-9]?$/);
  assert.ok(Number(busy.response.headers.get("retry-after")) <= 60);
  subtitleSourcePause = null;
  releaseFetch();
  const resolved = await resolving;
  assert.equal(resolved.response.status, 200, JSON.stringify(resolved.body));
  assert.deepEqual(
    Object.keys(resolved.body).sort(),
    ["artifactId", "expiresAt", "expiresAtUnit", "parts", "schemaVersion", "status"]
  );
  assert.equal(resolved.body.schemaVersion, 2);
  assert.equal(resolved.body.status, "ready");
  assert.equal(resolved.body.expiresAtUnit, "unix_ms");
  assert.ok(Number.isSafeInteger(resolved.body.expiresAt));
  assert.equal(resolved.body.parts.length, 1);
  assert.equal(
    resolved.body.parts[0].sha256,
    crypto.createHash("sha256")
      .update("WEBVTT\n\n00:00.000 --> 00:01.000\nBridge subtitle\n")
      .digest("hex")
  );
  assert.match(resolved.body.parts[0].fileName, /^[a-f0-9]{64}\.vtt$/);
  assert.equal(resolved.body.parts[0].path.includes(sessionId), true);
  const resolutionJson = JSON.stringify(resolved.body);
  for (const secret of ["media.example", "token=sub", "Authorization", "objectKey", "generation"]) {
    assert.equal(resolutionJson.includes(secret), false, secret);
  }
  assert.equal(subtitleSourceRequests.at(-1).url.includes("token=sub"), true);
  assert.ok(subtitleSourceBodies.at(-1).every((byte) => byte === 0));

  subtitleSourceFailure = "source";
  const unavailable = await postJson(
    "/v1/subtitles/resolve",
    { sessionId, selector: discovered.body.subtitles[1].selector },
    auth
  );
  subtitleSourceFailure = null;
  assert.equal(unavailable.response.status, 502);
  assert.deepEqual(unavailable.body, { ok: false, error: "subtitle_source_unavailable" });
  assert.equal(JSON.stringify(unavailable.body).includes("private.example"), false);

  subtitleSourceFailure = "payload";
  const rejectedPayload = await postJson(
    "/v1/subtitles/resolve",
    { sessionId, selector: discovered.body.subtitles[2].selector },
    auth
  );
  subtitleSourceFailure = null;
  assert.equal(rejectedPayload.response.status, 422);
  assert.deepEqual(rejectedPayload.body, { ok: false, error: "subtitle_payload_rejected" });

  const deliveryPath = resolved.body.parts[0].path;
  const unauthenticatedRead = await request(deliveryPath);
  assert.equal(unauthenticatedRead.response.status, 401);
  assert.match(unauthenticatedRead.response.headers.get("cache-control") || "", /private/);
  const head = await request(deliveryPath, { method: "HEAD", headers: auth });
  assert.equal(head.response.status, 200);
  assert.equal(head.body, "");
  assert.equal(head.response.headers.get("content-type"), resolved.body.parts[0].contentType);
  assert.equal(Number(head.response.headers.get("content-length")), resolved.body.parts[0].contentLength);
  assert.equal(head.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(head.response.headers.get("accept-ranges"), "none");
  assert.equal(head.response.headers.get("content-encoding"), "identity");

  const rejectedRange = await request(deliveryPath, {
    headers: { ...auth, range: "bytes=1-" },
  });
  assert.equal(rejectedRange.response.status, 416);
  const zeroRange = await request(deliveryPath, {
    headers: { ...auth, range: "bytes=0-" },
  });
  assert.equal(zeroRange.response.status, 200);
  assert.equal(zeroRange.response.headers.get("accept-ranges"), "none");

  const logged = [];
  const originalLog = console.log;
  let delivered;
  console.log = (...args) => logged.push(args.join(" "));
  try {
    delivered = await request(deliveryPath, { headers: auth });
  } finally {
    console.log = originalLog;
  }
  assert.equal(delivered.response.status, 200);
  assert.match(delivered.body, /Bridge subtitle/);
  assert.equal(Buffer.byteLength(delivered.body), resolved.body.parts[0].contentLength);
  for (const privateValue of [sessionId, resolved.body.artifactId, resolved.body.parts[0].fileName]) {
    assert.equal(logged.some((line) => line.includes(privateValue)), false, privateValue);
  }
  assert.equal(logged.some((line) => line.includes("/v1/subtitles/<redacted>")), true);

  const wrongFile = deliveryPath.replace(/[^/]+$/, "0".repeat(64) + ".vtt");
  assert.equal((await request(wrongFile, { headers: auth })).response.status, 404);
  assert.equal((await request(deliveryPath, {
    headers: { authorization: `Bearer ${sameProfileDevice.deviceToken}` },
  })).response.status, 404);

  const superseded = await postClaim(
    {
      fingerprints: fingerprintStream(PLAYABLE_STREAM),
      intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url + ":superseding-launch"),
      launchedAt: firstLaunch + 1000,
    },
    auth
  );
  assert.equal(superseded.body.status, "claimed");
  assert.notEqual(superseded.body.sessionId, sessionId);
  assert.equal((await request(deliveryPath, { headers: auth })).response.status, 404);

  const terminal = await postHistoryEvent(
    superseded.body,
    "stop",
    auth,
    { positionMs: 1_000, durationMs: 10_000, watchedMs: 1_000 }
  );
  assert.equal(terminal.response.status, 200, JSON.stringify(terminal.body));
  const released = await postJson(
    "/v1/playback/release",
    {
      sessionId: superseded.body.sessionId,
      terminalReceiptId: terminal.idempotencyKey,
    },
    auth
  );
  assert.equal(released.body.status, "released");
  assert.equal((await postJson(
    "/v1/subtitles/discover",
    { sessionId: superseded.body.sessionId },
    auth
  )).response.status, 404);
  await Promise.all([app.runStorageCleanupForTest(), app.runStorageCleanupForTest()]);
});

test("claim-bound history authenticates devices, isolates profiles on shared IPs, and shares within a profile", async () => {
  const sharedIp = "198.51.100.81";
  const configA = await createConfig("History Profile A", upstreamBaseUrl);
  const deviceA = await pairDevice(configA);
  const deviceA2 = await pairDevice(configA);
  const configB = await createConfig("History Profile B");
  const deviceB = await pairDevice(configB);
  await importPlaybackProvider(deviceA);
  const claimA = await claimConfiguredPlayback(configA, deviceA);
  const key = claimA.context.contentKey;
  assert.match(key, /^[a-f0-9]{64}$/);

  const missing = await request("/v1/history/" + key);
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.error, "device_auth_required");
  assert.equal(missing.response.headers.get("cache-control"), "no-store");
  for (const authorization of ["Bearer short", "Basic " + "a".repeat(40), "Bearer bad.token"]) {
    const malformed = await request("/v1/history/" + key, {
      headers: { authorization },
    });
    assert.equal(malformed.response.status, 401);
    assert.equal(malformed.body.error, "device_auth_required");
  }

  const eventBody = {
    event: "progress",
    sessionRevision: claimA.sessionRevision,
    positionMs: 25_000,
    durationMs: 100_000,
    watchedMs: 25_000,
  };
  for (const authorization of [null, "Bearer short", "Basic " + "a".repeat(40)]) {
    const headers = {
      "x-jumpgate-history-grant": claimA.historyGrant,
      "idempotency-key": crypto.randomUUID(),
    };
    if (authorization) headers.authorization = authorization;
    const rejected = await postJson("/v1/history/events", eventBody, headers);
    assert.equal(rejected.response.status, 401);
    assert.equal(rejected.body.error, "device_auth_required");
    assert.equal(rejected.response.headers.get("cache-control"), "no-store");
  }

  const before = Date.now();
  const saved = await postHistoryEvent(
    claimA,
    "progress",
    {
      authorization: "Bearer " + deviceA.deviceToken,
      "x-forwarded-for": sharedIp,
    },
    { positionMs: 25_000, durationMs: 100_000, watchedMs: 25_000 }
  );
  const after = Date.now();
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.response.headers.get("cache-control"), "no-store");
  assert.equal(saved.response.headers.get("access-control-allow-origin"), null);
  assert.ok(saved.body.history.lastPlayedAt >= before && saved.body.history.lastPlayedAt <= after);
  assert.deepEqual(Object.keys(saved.body.history).sort(), [
    "canonicalIdentity",
    "completed",
    "contentKey",
    "displaySnapshot",
    "durationMs",
    "lastPlayedAt",
    "playbackSnapshot",
    "positionMs",
    "watchedMs",
  ]);
  assert.equal(JSON.stringify(saved.body.history).length < 12 * 1024, true);
  for (const internal of ["profileId", "deviceId", "revision", "changeSequence", "updatedAt"]) {
    assert.equal(Object.hasOwn(saved.body.history, internal), false);
  }

  for (const replayDevice of [deviceA2, deviceB]) {
    const crossDeviceReplay = await postJson("/v1/history/events", saved.requestBody, {
      authorization: "Bearer " + replayDevice.deviceToken,
      "x-jumpgate-history-grant": claimA.historyGrant,
      "idempotency-key": saved.idempotencyKey,
      "x-forwarded-for": sharedIp,
    });
    assert.equal(crossDeviceReplay.response.status, 401);
    assert.deepEqual(crossDeviceReplay.body, { ok: false, error: "history_grant_invalid" });
  }

  const sameProfile = await request("/v1/history/" + key, {
    headers: {
      authorization: "Bearer " + deviceA2.deviceToken,
      "x-forwarded-for": sharedIp,
    },
  });
  assert.equal(sameProfile.response.status, 200);
  assert.deepEqual(sameProfile.body, saved.body.history);

  const otherProfile = await request("/v1/history/" + key, {
    headers: {
      authorization: "Bearer " + deviceB.deviceToken,
      "x-forwarded-for": sharedIp,
    },
  });
  assert.equal(otherProfile.response.status, 404);
  assert.deepEqual(otherProfile.body, { ok: false, error: "history_not_found" });

  const claimA2 = await claimConfiguredPlayback(configA, deviceA2, {
    launchedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.equal(claimA2.context.contentKey, key);
  const updated = await postHistoryEvent(
    claimA2,
    "progress",
    { authorization: "Bearer " + deviceA2.deviceToken },
    { positionMs: 30_000, durationMs: 100_000, watchedMs: 30_000 }
  );
  assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
  assert.ok(updated.body.history.lastPlayedAt > saved.body.history.lastPlayedAt);
  const updatedRead = await request("/v1/history/" + key, {
    headers: { authorization: "Bearer " + deviceA.deviceToken },
  });
  assert.deepEqual(updatedRead.body, updated.body.history);

  await app.revokeDeviceForTest(deviceA.profileId, deviceA.deviceId);
  const revoked = await request("/v1/history/" + key, {
    headers: { authorization: "Bearer " + deviceA.deviceToken },
  });
  assert.equal(revoked.response.status, 401);
  assert.equal(revoked.body.error, "device_auth_required");
});

test("history reads and claim-bound events reject invalid keys, caller identity, timestamps, conflicts, and oversized bodies", async () => {
  const config = await createConfig("History Validation", upstreamBaseUrl);
  const device = await pairDevice(config);
  const authorization = "Bearer " + device.deviceToken;
  await importPlaybackProvider(device);
  const claim = await claimConfiguredPlayback(config, device);
  const key = claim.context.contentKey;

  for (const invalidKey of [key.toUpperCase(), "a".repeat(63), "g".repeat(64)]) {
    const rejected = await request("/v1/history/" + invalidKey, {
      headers: { authorization },
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error, "invalid_content_key");
  }

  const validEvent = {
    event: "progress",
    sessionRevision: claim.sessionRevision,
    positionMs: 25_000,
    durationMs: 100_000,
    watchedMs: 25_000,
  };
  const invalidBodies = [
    { ...validEvent, unknown: true },
    { ...validEvent, lastPlayedAt: Date.now() },
    { ...validEvent, profileId: device.profileId },
    { ...validEvent, deviceId: device.deviceId },
    { ...validEvent, canonicalIdentity: { provider: "imdb", id: "tt0234215" } },
    { ...validEvent, playbackPreferences: { sourceUrl: "https://secret.example/video" } },
  ];
  for (const body of invalidBodies) {
    const rejected = await postJson("/v1/history/events", body, {
      authorization,
      "x-jumpgate-history-grant": claim.historyGrant,
      "idempotency-key": crypto.randomUUID(),
    });
    assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error, "invalid_history_event");
  }

  await app.upsertHistoryForTest(device.profileId, {
    contentKey: key,
    ...historyPayload({
      canonicalIdentity: {
        ...historyPayload().canonicalIdentity,
        id: "tt0234215",
      },
    }),
    lastPlayedAt: Date.now(),
  });
  const identityConflict = await postHistoryEvent(
    claim,
    "progress",
    { authorization },
    { positionMs: 25_000, durationMs: 100_000, watchedMs: 25_000 }
  );
  assert.equal(identityConflict.response.status, 409);
  assert.deepEqual(identityConflict.body, { ok: false, error: "invalid_request" });
  const unchanged = await request("/v1/history/" + key, { headers: { authorization } });
  assert.equal(unchanged.response.status, 200);
  assert.equal(unchanged.body.canonicalIdentity.id, "tt0234215");

  const oversized = await request("/v1/history/events", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      "x-jumpgate-history-grant": claim.historyGrant,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ ...validEvent, padding: "x".repeat(13 * 1024) }),
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error, "request_too_large");
  assert.equal(oversized.response.headers.get("cache-control"), "no-store");
});

test("claim-bound history retry exhaustion is returned as 409 rather than service unavailable", async () => {
  const config = await createConfig("History Conflict", upstreamBaseUrl);
  const device = await pairDevice(config);
  await importPlaybackProvider(device);
  const claim = await claimConfiguredPlayback(config, device);
  const repositorySet = await app.repositoriesForTest();
  const originalUpsertNow = repositorySet.history.upsertNow;
  let attempts = 0;
  repositorySet.history.upsertNow = async () => {
    attempts += 1;
    const error = new Error("exhausted");
    if (attempts < 5) {
      error.code = "revision_conflict";
    } else {
      error.code = "history_conflict";
      error.status = 409;
    }
    throw error;
  };
  try {
    const conflict = await postHistoryEvent(
      claim,
      "progress",
      { authorization: "Bearer " + device.deviceToken },
      { positionMs: 25_000, durationMs: 100_000, watchedMs: 25_000 }
    );
    assert.equal(attempts, 5);
    assert.equal(conflict.response.status, 409);
    assert.deepEqual(conflict.body, { ok: false, error: "invalid_request" });
    const unchanged = await request("/v1/history/" + claim.context.contentKey, {
      headers: { authorization: "Bearer " + device.deviceToken },
    });
    assert.equal(unchanged.response.status, 404);
    assert.deepEqual(
      await repositorySet.historyGrants.listDispatchIntents(device.profileId, claim.sessionId),
      []
    );
  } finally {
    repositorySet.history.upsertNow = originalUpsertNow;
  }
});

test("device authentication binds the durable generation before claim-bound history dispatch", async () => {
  const config = await createConfig("History Device Generation", upstreamBaseUrl);
  const device = await pairDevice(config);
  await importPlaybackProvider(device);
  const claim = await claimConfiguredPlayback(config, device);
  const repositorySet = await app.repositoriesForTest();
  const originalUpsertNow = repositorySet.history.upsertNow;
  let capturedWrite = null;
  repositorySet.history.upsertNow = async function (...args) {
    capturedWrite = args;
    return originalUpsertNow.apply(repositorySet.history, args);
  };
  try {
    const result = await postHistoryEvent(
      claim,
      "progress",
      { authorization: "Bearer " + device.deviceToken },
      { positionMs: 25_000, durationMs: 100_000, watchedMs: 25_000 }
    );
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.ok(capturedWrite);
    const [profileId, entry, expectedRevision, options] = capturedWrite;
    assert.equal(profileId, device.profileId);
    assert.equal(entry.contentKey, claim.context.contentKey);
    assert.equal(expectedRevision, 0);
    assert.equal(options.deviceId, device.deviceId);
    assert.equal(options.deviceGeneration, 1);
    assert.equal(Number.isSafeInteger(options.generation), true);
    assert.equal(result.body.dispatchIntent.profileId, device.profileId);
    assert.equal(result.body.dispatchIntent.deviceId, device.deviceId);
    assert.equal(result.body.dispatchIntent.deviceGeneration, 1);
    assert.equal(result.body.dispatchIntent.historyGeneration, options.generation);
    assert.equal(Number.isSafeInteger(result.body.dispatchIntent.profileRevision), true);
    assert.equal(typeof result.body.dispatchIntent.playbackGeneration, "string");
  } finally {
    repositorySet.history.upsertNow = originalUpsertNow;
  }
});
test("durable revocation suppresses every paused terminal device disclosure", async (t) => {
  const repositorySet = await app.repositoriesForTest();

  async function revokeAfterEntered(device, gate, pendingRequest) {
    await gate.entered.promise;
    const revocation = app.revokeDeviceForTest(device.profileId, device.deviceId);
    assert.equal(await settledWithin(revocation, 250), true);
    await revocation;
    gate.release.resolve();
    return pendingRequest;
  }

  function pauseOnce(operation) {
    const entered = deferred();
    const release = deferred();
    let paused = false;
    return {
      entered,
      release,
      async run(...args) {
        const result = await operation(...args);
        if (!paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    };
  }

  await t.test("claim-bound history event", async () => {
    const accessToken = crypto.randomBytes(24).toString("base64url");
    const refreshToken = crypto.randomBytes(24).toString("base64url");
    const config = await createConfig("Disclosure fence history event", upstreamBaseUrl, {}, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_expiry: Math.floor(Date.now() / 1000) + 3600,
    });
    const device = await pairDevice(config);
    await importPlaybackProvider(device);
    const claim = await claimConfiguredPlayback(config, device);
    const originalUpsertNow = repositorySet.history.upsertNow;
    const gate = pauseOnce((...args) =>
      originalUpsertNow.apply(repositorySet.history, args)
    );
    repositorySet.history.upsertNow = gate.run.bind(gate);
    try {
      const pending = postHistoryEvent(
        claim,
        "pause",
        { authorization: `Bearer ${device.deviceToken}` },
        { positionMs: 25_000, durationMs: 100_000, watchedMs: 25_000 }
      );
      await gate.entered.promise;
      const revocation = app.revokeDeviceForTest(device.profileId, device.deviceId);
      assert.equal(await settledWithin(revocation, 250), false);
      gate.release.resolve();
      await revocation;
      const result = await pending;
      assert.notEqual(result.response.status, 200);
      const intents = await repositorySet.historyGrants.listDispatchIntents(
        device.profileId,
        claim.sessionId
      );
      assert.equal(intents.length, 1);
      assert.equal(intents[0].status, "queued");
      const afterRevocation = await postHistoryEvent(
        claim,
        "progress",
        { authorization: `Bearer ${device.deviceToken}` },
        { positionMs: 26_000, durationMs: 100_000, watchedMs: 26_000 }
      );
      assert.notEqual(afterRevocation.response.status, 200);
      const serialized = JSON.stringify([result.body, intents]);
      assert.equal(serialized.includes(accessToken), false);
      assert.equal(serialized.includes(refreshToken), false);
      assert.doesNotMatch(serialized, /access_token|refresh_token/i);
    } finally {
      gate.release.resolve();
      repositorySet.history.upsertNow = originalUpsertNow;
    }
  });

  await t.test("history", async () => {
    const device = await pairDevice(await createConfig("Disclosure fence history"));
    const gate = pauseOnce(async () => ({
      contentKey: "a".repeat(64),
      canonicalIdentity: null,
      displaySnapshot: {},
      playbackSnapshot: {},
      positionMs: 1,
      durationMs: 2,
      watchedMs: 1,
      completed: false,
      lastPlayedAt: 1,
    }));
    app.setHistoryServiceForTest({
      get: gate.run.bind(gate),
      async put() { throw new Error("not used"); },
    });
    try {
      const pending = request("/v1/history/" + "a".repeat(64), {
        headers: { authorization: `Bearer ${device.deviceToken}` },
      });
      const result = await revokeAfterEntered(device, gate, pending);
      assert.notEqual(result.response.status, 200);
      assert.equal(Object.hasOwn(result.body, "positionMs"), false);
    } finally {
      app.setHistoryServiceForTest(null);
    }
  });

  await t.test("claim finalization", async () => {
    const config = await createConfig("Disclosure fence claim");
    const device = await pairDevice(config);
    await importPlaybackProvider(device);
    await request(`/_c/${config}/stream/movie/tt0133093.json`);
    const original = repositorySet.playbackContexts.getActiveClaim;
    const gate = pauseOnce((...args) => original.apply(repositorySet.playbackContexts, args));
    repositorySet.playbackContexts.getActiveClaim = gate.run.bind(gate);
    try {
      const pending = postClaim(
        {
          fingerprints: fingerprintStream(PLAYABLE_STREAM),
          intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
          launchedAt: Date.now(),
        },
        { authorization: `Bearer ${device.deviceToken}` }
      );
      const result = await revokeAfterEntered(device, gate, pending);
      assert.notEqual(result.response.status, 200);
      assert.equal(Object.hasOwn(result.body, "sessionId"), false);
    } finally {
      repositorySet.playbackContexts.getActiveClaim = original;
    }
  });

  for (const operation of ["discover", "resolve"]) {
    await t.test("subtitle " + operation, async () => {
      const device = await pairDevice(await createConfig("Disclosure fence " + operation));
      const service = await app.subtitleDiscoveryServiceForTest();
      const original = service[operation];
      const originalInvalidateRelease = repositorySet.subtitleDeliveries.invalidateRelease;
      let cleanupCalls = 0;
      if (operation === "resolve") {
        repositorySet.subtitleDeliveries.invalidateRelease = async (...args) => {
          cleanupCalls += 1;
          return originalInvalidateRelease.apply(repositorySet.subtitleDeliveries, args);
        };
      }
      const gate = pauseOnce(async () => operation === "discover"
        ? { schemaVersion: 1, subtitles: [] }
        : { schemaVersion: 2, status: "ready", artifactId: "artifact_fenced", parts: [] });
      service[operation] = gate.run.bind(gate);
      try {
        const pending = postJson(
          "/v1/subtitles/" + operation,
          operation === "discover"
            ? { sessionId: "session_fenced" }
            : { sessionId: "session_fenced", selector: "a".repeat(64) },
          { authorization: `Bearer ${device.deviceToken}` }
        );
        const result = await revokeAfterEntered(device, gate, pending);
        assert.notEqual(result.response.status, 200);
        assert.equal(Object.hasOwn(result.body, "schemaVersion"), false);
        if (operation === "resolve") assert.equal(cleanupCalls, 1);
      } finally {
        service[operation] = original;
        repositorySet.subtitleDeliveries.invalidateRelease = originalInvalidateRelease;
      }
    });
  }

  for (const method of ["GET", "HEAD"]) {
    await t.test("subtitle " + method, async () => {
      const device = await pairDevice(await createConfig("Disclosure fence read " + method));
      const service = await app.subtitleDiscoveryServiceForTest();
      const original = service.read;
      const body = Buffer.from("private subtitle bytes");
      const gate = pauseOnce(async () => ({
        mediaType: "text/plain",
        sizeBytes: body.length,
        body,
      }));
      service.read = gate.run.bind(gate);
      try {
        const path = "/v1/subtitles/session_fenced/artifact_fenced/1/subtitle.txt";
        const pending = method === "HEAD"
          ? fetch(baseUrl + path, {
              method,
              headers: { authorization: `Bearer ${device.deviceToken}` },
            }).then((response) => ({ response, body: "" }))
          : request(path, {
              method,
              headers: { authorization: `Bearer ${device.deviceToken}` },
            });
        const result = await revokeAfterEntered(device, gate, pending);
        assert.notEqual(result.response.status, 200);
        if (method === "GET") {
          assert.equal(JSON.stringify(result.body).includes("private subtitle"), false);
        }
        assert.equal(body.every((byte) => byte === 0), true);
      } finally {
        service.read = original;
        body.fill(0);
      }
    });
  }

  await t.test("release", async () => {
    const config = await createConfig("Disclosure fence release", upstreamBaseUrl);
    const device = await pairDevice(config);
    await importPlaybackProvider(device);
    const claim = await claimConfiguredPlayback(config, device);
    const terminal = await postHistoryEvent(
      claim,
      "stop",
      { authorization: `Bearer ${device.deviceToken}` },
      { positionMs: 25_000, durationMs: 100_000, watchedMs: 25_000 }
    );
    assert.equal(terminal.response.status, 200, JSON.stringify(terminal.body));
    const original = repositorySet.playbackContexts.release;
    const gate = pauseOnce((...args) =>
      original.apply(repositorySet.playbackContexts, args)
    );
    repositorySet.playbackContexts.release = gate.run.bind(gate);
    try {
      const pending = postJson(
        "/v1/playback/release",
        { sessionId: claim.sessionId, terminalReceiptId: terminal.idempotencyKey },
        { authorization: `Bearer ${device.deviceToken}` }
      );
      const result = await revokeAfterEntered(device, gate, pending);
      assert.notEqual(result.response.status, 200);
      assert.equal(Object.hasOwn(result.body, "status"), false);
    } finally {
      repositorySet.playbackContexts.release = original;
    }
  });
});

test("aborted playback claim requests cancel repository work without final disclosure", async () => {
  const device = await pairDevice(await createConfig("Aborted playback claim"));
  const repositorySet = await app.repositoriesForTest();
  const originalClaim = repositorySet.playbackContexts.claim;
  const originalCommitDisclosure = repositorySet.devices.commitDisclosure;
  const entered = deferred();
  const release = deferred();
  let claimSignal = null;
  let disclosureCalls = 0;
  repositorySet.playbackContexts.claim = async (_profileId, _deviceId, _request, options) => {
    claimSignal = options.signal;
    entered.resolve();
    await release.promise;
    return { status: "not_found" };
  };
  repositorySet.devices.commitDisclosure = async (...args) => {
    disclosureCalls += 1;
    return originalCommitDisclosure.apply(repositorySet.devices, args);
  };
  const controller = new AbortController();
  try {
    const pending = fetch(baseUrl + "/v1/playback/claim", {
      method: "POST",
      headers: {
        authorization: `Bearer ${device.deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        attemptId: crypto.randomUUID(),
        fingerprints: fingerprintStream(PLAYABLE_STREAM),
        intentUrlHash: hashOpaqueValue(PLAYABLE_STREAM.url),
        launchedAt: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    await assert.rejects(pending, (error) => error.name === "AbortError");
    assert.ok(claimSignal instanceof AbortSignal);
    if (!claimSignal.aborted) {
      await Promise.race([
        new Promise((resolve) => claimSignal.addEventListener("abort", resolve, { once: true })),
        new Promise((resolve) =>
          setTimeout(resolve, REQUEST_ABORT_PROPAGATION_TOLERANCE_MS)
        ),
      ]);
    }
    assert.equal(claimSignal.aborted, true);
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(disclosureCalls, 0);
  } finally {
    release.resolve();
    repositorySet.playbackContexts.claim = originalClaim;
    repositorySet.devices.commitDisclosure = originalCommitDisclosure;
  }
});

test("claim-bound source history deduplicates Continue Watching entries across progress, completion, and replay", async () => {
  const config = await createConfig("History Compatibility", upstreamBaseUrl);
  const device = await pairDevice(config);
  const authorization = "Bearer " + device.deviceToken;
  await importPlaybackProvider(device);
  const claim = await claimConfiguredPlayback(config, device);

  const firstProgress = await postHistoryEvent(
    claim,
    "progress",
    { authorization },
    { positionMs: 20_000, durationMs: 100_000, watchedMs: 20_000 }
  );
  assert.equal(firstProgress.response.status, 200, JSON.stringify(firstProgress.body));
  const source = await postHistoryEvent(
    claim,
    "progress",
    { authorization },
    {
      sessionRevision: firstProgress.body.sessionRevision,
      positionMs: 40_000,
      durationMs: 100_000,
      watchedMs: 40_000,
    }
  );
  assert.equal(source.response.status, 200, JSON.stringify(source.body));
  const sourceKey = source.body.history.contentKey;
  assert.equal(sourceKey, claim.context.contentKey);

  const tmdbKey = hashOpaqueValue("source-backed-tmdb-history");
  await app.upsertHistoryForTest(device.profileId, {
    contentKey: tmdbKey,
    ...historyPayload({
      canonicalIdentity: {
        provider: "tmdb",
        id: "603",
        mediaType: "movie",
        provenance: "verified-external-id",
        confidence: "canonical",
      },
      displaySnapshot: { title: "TMDB Source" },
    }),
    lastPlayedAt: source.body.history.lastPlayedAt + 1,
  });

  const catalog = await request("/_c/" + config + "/catalog/movie/jumpgate-continue.json");
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.response.headers.get("cache-control"), "no-store");
  assert.equal(catalog.response.headers.get("pragma"), "no-cache");
  assert.deepEqual(catalog.body.metas.map((meta) => meta.id).sort(), ["tmdb:603", "tt0133093"]);
  assert.equal(catalog.body.metas.filter((meta) => meta.id === "tt0133093").length, 1);
  assert.equal(catalog.body.metas.find((meta) => meta.id === "tt0133093").description, "40% watched");
  assert.equal(catalog.body.metas.find((meta) => meta.id === "tmdb:603").name, "TMDB Source");

  const aliasCatalog = await request("/" + config + "/catalog/movie/jumpgate-continue.json");
  assert.equal(aliasCatalog.response.status, 200, JSON.stringify(aliasCatalog.body));
  assert.equal(aliasCatalog.response.headers.get("cache-control"), "no-store");
  assert.equal(aliasCatalog.response.headers.get("pragma"), "no-cache");
  assert.deepEqual(aliasCatalog.body, catalog.body);

  const completed = await postHistoryEvent(
    claim,
    "completion",
    { authorization },
    {
      sessionRevision: source.body.sessionRevision,
      positionMs: 100_000,
      durationMs: 100_000,
      watchedMs: 100_000,
    }
  );
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.history.completed, true);
  const afterCompletion = await request("/_c/" + config + "/catalog/movie/jumpgate-continue.json");
  assert.deepEqual(afterCompletion.body.metas.map((meta) => meta.id), ["tmdb:603"]);

  const released = await postJson(
    "/v1/playback/release",
    { sessionId: claim.sessionId, terminalReceiptId: completed.idempotencyKey },
    { authorization }
  );
  assert.equal(released.body.status, "released");
  const replayClaim = await claimConfiguredPlayback(config, device, {
    launchedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  const replayed = await postHistoryEvent(
    replayClaim,
    "progress",
    { authorization },
    { positionMs: 30_000, durationMs: 100_000, watchedMs: 30_000 }
  );
  assert.equal(replayed.response.status, 200, JSON.stringify(replayed.body));
  const afterReplay = await request("/_c/" + config + "/catalog/movie/jumpgate-continue.json");
  assert.equal(afterReplay.body.metas.filter((meta) => meta.id === "tt0133093").length, 1);
});
test("memory-backed Continue Watching traverses a second tied page and caps results", async () => {
  const config = await createConfig("History Pagination");
  const device = await pairDevice(config);
  const lastPlayedAt = Date.now();
  const count = 500 + app.historyCatalogLimitsForTest.maxMetas + 1;
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      app.upsertHistoryForTest(
        device.profileId,
        {
          contentKey: index.toString(16).padStart(64, "0"),
          canonicalIdentity: {
            provider: "tmdb",
            id: String(1000000 + index),
            mediaType: "movie",
            provenance: "verified-external-id",
            confidence: "canonical",
          },
          displaySnapshot: { title: "History Page " + index },
          playbackSnapshot: {},
          positionMs: 20000,
          durationMs: 100000,
          watchedMs: 20000,
          completed: index < 500,
          lastPlayedAt,
        },
        0
      )
    )
  );

  const catalog = await request(`/_c/${config}/catalog/movie/jumpgate-continue.json`);
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.metas.length, app.historyCatalogLimitsForTest.maxMetas);
  assert.equal(
    new Set(catalog.body.metas.map((meta) => meta.id)).size,
    app.historyCatalogLimitsForTest.maxMetas
  );
  assert.equal(catalog.body.metas.some((meta) => meta.id === "tmdb:1000600"), true);
  assert.equal(catalog.body.metas.some((meta) => meta.id === "tmdb:1000500"), false);
});

test("Continue Watching never scans beyond the durable history hard cap", async () => {
  const config = await createConfig("History Scan Cap");
  const device = await pairDevice(config);
  const lastPlayedAt = Date.now();
  const count = app.historyCatalogLimitsForTest.maxScannedRecords + 1;
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      app.upsertHistoryForTest(
        device.profileId,
        {
          contentKey: index.toString(16).padStart(64, "0"),
          canonicalIdentity: {
            provider: "tmdb",
            id: String(2000000 + index),
            mediaType: "movie",
            provenance: "verified-external-id",
            confidence: "canonical",
          },
          displaySnapshot: {},
          playbackSnapshot: {},
          positionMs: 20000,
          durationMs: 100000,
          watchedMs: 20000,
          completed: index < app.historyCatalogLimitsForTest.maxScannedRecords,
          lastPlayedAt,
        },
        0
      )
    )
  );

  const catalog = await request(`/_c/${config}/catalog/movie/jumpgate-continue.json`);
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
  assert.deepEqual(catalog.body.metas, []);
});

test("Continue Watching bounds concurrent TMDB metadata enrichment", async () => {
  const config = await createConfig("History TMDB Concurrency");
  const device = await pairDevice(config);
  const count = app.historyCatalogLimitsForTest.tmdbConcurrency * 3;
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      app.upsertHistoryForTest(
        device.profileId,
        {
          contentKey: hashOpaqueValue("tmdb-fanout-" + index),
          canonicalIdentity: {
            provider: "imdb",
            id: "tt" + String(3000000 + index),
            mediaType: "movie",
            provenance: "metadata-request",
            confidence: "canonical",
          },
          displaySnapshot: {},
          playbackSnapshot: {},
          positionMs: 20000,
          durationMs: 100000,
          watchedMs: 20000,
          completed: false,
          lastPlayedAt: Date.now(),
        },
        0
      )
    )
  );

  let active = 0;
  let peak = 0;
  let calls = 0;
  app.setTmdbMetaLoaderForTest(async () => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return null;
  });
  try {
    const catalog = await request(`/_c/${config}/catalog/movie/jumpgate-continue.json`);
    assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
    assert.equal(catalog.body.metas.length, count);
  } finally {
    app.setTmdbMetaLoaderForTest(null);
  }
  assert.equal(calls, count);
  assert.equal(peak, app.historyCatalogLimitsForTest.tmdbConcurrency);
});

test("catalog concurrency stops dequeuing on first error and rejects only after workers drain", async () => {
  const ordered = await app.mapWithConcurrencyForTest([0, 1, 2, 3], 2, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, (3 - value) * 2));
    return value * 10;
  });
  assert.deepEqual(ordered, [0, 10, 20, 30]);

  const concurrency = 3;
  const firstError = new Error("deterministic catalog mapper failure");
  const started = [];
  const drained = [];
  let releaseFailure;
  let releaseDrain;
  let signalInitialWorkers;
  let signalFailureThrown;
  const failureGate = new Promise((resolve) => {
    releaseFailure = resolve;
  });
  const drainGate = new Promise((resolve) => {
    releaseDrain = resolve;
  });
  const initialWorkersStarted = new Promise((resolve) => {
    signalInitialWorkers = resolve;
  });
  const failureThrown = new Promise((resolve) => {
    signalFailureThrown = resolve;
  });

  const operation = app.mapWithConcurrencyForTest(
    Array.from({ length: 12 }, (_, index) => index),
    concurrency,
    async (value) => {
      started.push(value);
      if (started.length === concurrency) signalInitialWorkers();
      try {
        if (value === 0) {
          await failureGate;
          signalFailureThrown();
          throw firstError;
        }
        await drainGate;
        return value;
      } finally {
        drained.push(value);
      }
    }
  );
  let operationSettled = false;
  operation.then(
    () => {
      operationSettled = true;
    },
    () => {
      operationSettled = true;
    }
  );

  await initialWorkersStarted;
  releaseFailure();
  await failureThrown;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(drained, [0]);
  assert.equal(operationSettled, false);

  releaseDrain();
  await assert.rejects(() => operation, (error) => error === firstError);
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(new Set(drained), new Set([0, 1, 2]));
  assert.equal(operationSettled, true);
});

test("configured catalog privacy headers cover canonical and alias error paths", async () => {
  function assertPrivateHeaders(result) {
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("pragma"), "no-cache");
  }

  const malformedCanonical = await request(
    "/_c/not-a-config/catalog/movie/jumpgate-continue.json"
  );
  assert.equal(malformedCanonical.response.status, 400);
  assertPrivateHeaders(malformedCanonical);

  const unpairedConfig = await createConfig("Catalog Headers Unpaired");
  const unpairedCanonical = await request(
    `/_c/${unpairedConfig}/catalog/movie/jumpgate-continue.json`
  );
  assert.equal(unpairedCanonical.response.status, 403);
  assertPrivateHeaders(unpairedCanonical);

  const malformedAlias = await request(
    "/not-a-config/catalog/movie/jumpgate-continue.json"
  );
  assert.equal(malformedAlias.response.status, 404);
  assertPrivateHeaders(malformedAlias);

  const unpairedAlias = await request(
    `/${unpairedConfig}/catalog/movie/jumpgate-continue.json`
  );
  assert.equal(unpairedAlias.response.status, 404);
  assertPrivateHeaders(unpairedAlias);

  const pairedConfig = await createConfig("Catalog Headers Failure");
  const device = await pairDevice(pairedConfig);
  await app.upsertHistoryForTest(
    device.profileId,
    {
      contentKey: hashOpaqueValue("catalog-header-failure"),
      canonicalIdentity: {
        provider: "imdb",
        id: "tt3456789",
        mediaType: "movie",
        provenance: "metadata-request",
        confidence: "canonical",
      },
      displaySnapshot: {},
      playbackSnapshot: {},
      positionMs: 20000,
      durationMs: 100000,
      watchedMs: 20000,
      completed: false,
      lastPlayedAt: Date.now(),
    },
    0
  );
  app.setTmdbMetaLoaderForTest(async () => {
    throw new Error("forced catalog metadata failure");
  });
  try {
    const handlerFailure = await request(
      `/_c/${pairedConfig}/catalog/movie/jumpgate-continue.json`
    );
    assert.equal(handlerFailure.response.status, 503);
    assertPrivateHeaders(handlerFailure);
  } finally {
    app.setTmdbMetaLoaderForTest(null);
  }
});

test("release endpoint requires a paired device bearer and validates its body", async () => {
  const missing = await postJson("/v1/playback/release", { sessionId: "session_00000001" });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body.error, "device_auth_required");

  const config = await createConfig("Release Validation", upstreamBaseUrl);
  const device = await pairDevice(config);
  const invalid = await postJson(
    "/v1/playback/release",
    { sessionId: "not valid" },
    { authorization: `Bearer ${device.deviceToken}` }
  );
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error, "invalid_release_request");
});

test("public compatibility endpoints never correlate playback by client IP", async () => {
  const sourceIp = "198.51.100.30";
  const otherIp = "203.0.113.40";

  const stream = await request("/stream/movie/tt0234215.json", {
    headers: { "x-forwarded-for": sourceIp },
  });
  assert.deepEqual(stream.body, { streams: [] });

  const miss = await request("/identify", {
    headers: { "x-forwarded-for": otherIp },
  });
  assert.equal(miss.response.status, 410);
  assert.deepEqual(miss.body, { ok: false, error: "source_claim_required" });

  const sameAddress = await request("/identify", {
    headers: { "x-forwarded-for": sourceIp },
  });
  assert.deepEqual(sameAddress.body, miss.body);

  const resume = await postJson("/resume", {
    imdb: "tt0234215",
    position: 10,
    duration: 100,
  });
  assert.equal(resume.response.status, 410);
  assert.equal(resume.body.error, "history_grant_required");
});

test("legacy encoded upstream wrappers are removed", async () => {
  const encoded = Buffer.from("https://provider.example/private-token", "utf8").toString("base64url");
  const manifest = await request(`/${encoded}/manifest.json`);
  const stream = await request(`/${encoded}/stream/movie/tt0242653.json`);
  assert.equal(manifest.response.status, 404);
  assert.equal(stream.response.status, 404);
});

test("pairing accepts compact codes and returns configured settings", async () => {
  const config = await createConfig("Paired Profile");
  const issued = await postJson("/pair/device/code", {});
  const retryToken = activationRetryToken();

  assert.equal(issued.response.status, 200);
  assert.match(issued.body.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(issued.body.deviceCode, /^[A-Za-z0-9_-]+$/);

  const pending = await postJson("/pair/device/token", {
    deviceCode: issued.body.deviceCode,
  });
  assert.equal(pending.body.paired, false);

  const activated = await postJson("/pair/activate", {
    userCode: issued.body.userCode.replace("-", ""),
    config,
    activationRetryToken: retryToken,
  });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.body.paired, true);
  const activationCookie = activated.response.headers.get("set-cookie") || "";
  assert.match(activationCookie, /Path=\/api\/profile/);
  assert.match(activationCookie, /HttpOnly/);
  assert.match(activationCookie, /Secure/);
  assert.match(activationCookie, /SameSite=Strict/);
  assert.match(activationCookie, /Expires=/);
  assert.doesNotMatch(activationCookie, /Max-Age=/i);
  assert.equal(activated.response.headers.get("cache-control"), "no-store");
  assert.equal(activated.response.headers.get("pragma"), "no-cache");
  assert.equal(JSON.stringify(activated.body).includes(retryToken), false);
  assert.equal(activationCookie.includes(retryToken), false);
  assert.match(activated.body.profileId, /^[A-Za-z0-9_-]{16,64}$/);
  const manifestUrl = new URL(activated.body.manifestUrl);
  assert.equal(
    activated.body.installUrl,
    "stremio://" + manifestUrl.host + manifestUrl.pathname + manifestUrl.search
  );
  assert.doesNotMatch(activated.body.installUrl, /^stremio:\/\/https?:\/\//i);

  const replay = await postJson("/pair/activate", {
    userCode: issued.body.userCode,
    config,
    activationRetryToken: retryToken,
  });
  assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body, activated.body);
  assert.equal(replay.response.headers.get("set-cookie"), activationCookie);

  const managementSessions = (await app.repositoriesForTest()).managementSessions;
  const sessionCount = managementSessions.storageSnapshot().length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const recovered = await postJson("/pair/activate", {
    config,
    activationRetryToken: retryToken,
  });
  assert.equal(recovered.response.status, 200);
  assert.deepEqual(recovered.body, activated.body);
  assert.equal(recovered.response.headers.get("set-cookie"), activationCookie);
  assert.equal(managementSessions.storageSnapshot().length, sessionCount);

  const wrongToken = await postJson("/pair/activate", {
    userCode: issued.body.userCode,
    config,
    activationRetryToken: activationRetryToken(),
  });
  assert.equal(wrongToken.response.status, 404);
  assert.deepEqual(wrongToken.body, { ok: false, error: "Invalid pair code" });

  const differentConfig = await createConfig("Different Profile");
  const overwrite = await postJson("/pair/activate", {
    userCode: issued.body.userCode,
    config: differentConfig,
    activationRetryToken: retryToken,
  });
  assert.equal(overwrite.response.status, 409);

  const paired = await postJson("/pair/device/token", {
    deviceCode: issued.body.deviceCode,
  });
  assert.equal(paired.response.status, 200);
  assert.equal(paired.body.paired, true);
  assert.equal(paired.body.name, "Paired Profile");
  assert.equal(paired.body.settings.subtitle_languages, "en,es");
  assert.equal(paired.body.settings.subtitles_enabled, true);
  assert.match(paired.body.deviceToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(paired.body.deviceId, /^[A-Za-z0-9_-]{16,}$/);
  assert.equal(paired.body.profileId, activated.body.profileId);

  const redeemedAgain = await postJson("/pair/device/token", {
    deviceCode: issued.body.deviceCode,
  });
  assert.equal(redeemedAgain.response.status, 200);
  assert.equal(redeemedAgain.body.profileId, paired.body.profileId);
  assert.equal(redeemedAgain.body.deviceId, paired.body.deviceId);
  assert.equal(redeemedAgain.body.deviceToken, paired.body.deviceToken);
});

test("pair activation rate limits initial codes and recovery token hashes separately", () => {
  const retryToken = activationRetryToken();
  const initial = app.getPairRateLimitSignalsForTest({
    body: { userCode: "ABCD-EFGH", activationRetryToken: retryToken },
    ip: "127.0.0.1",
  }).activation;
  const recovery = app.getPairRateLimitSignalsForTest({
    body: { activationRetryToken: retryToken },
    ip: "127.0.0.1",
  }).activation;
  assert.equal(initial, "code:ABCDEFGH");
  assert.match(recovery, /^retry:[a-f0-9]{64}$/);
  assert.equal(recovery.includes(retryToken), false);
});

test("profile provider APIs are CSRF-bound, isolated, encrypted, and revocable", async () => {
  const configA = await createConfig("Provider Profile A");
  const configB = await createConfig("Provider Profile B");
  const profileA = await pairDevice(configA);
  const profileB = await pairDevice(configB);
  const authHeadersA = {
    cookie: profileA.managementCookie,
    "x-jumpgate-csrf": profileA.managementCsrf,
    origin: "https://jumpgate.test",
  };
  const authHeadersB = {
    cookie: profileB.managementCookie,
    "x-jumpgate-csrf": profileB.managementCsrf,
    origin: "https://jumpgate.test",
  };
  const provider = providerDescriptor();

  const wrongCsrf = await request("/api/profile/providers", {
    headers: { ...authHeadersA, "x-jumpgate-csrf": "wrong" },
  });
  assert.equal(wrongCsrf.response.status, 401);
  const wrongOrigin = await request("/api/profile/providers", {
    headers: { ...authHeadersA, origin: "https://attacker.example" },
  });
  assert.equal(wrongOrigin.response.status, 403);
  const wrongScheme = await request("/api/profile/providers", {
    headers: { ...authHeadersA, origin: "http://jumpgate.test" },
  });
  assert.equal(wrongScheme.response.status, 403);
  const originWithPath = await request("/api/profile/providers", {
    headers: { ...authHeadersA, origin: "https://jumpgate.test/not-an-origin" },
  });
  assert.equal(originWithPath.response.status, 403);

  const preview = await postJson(
    "/api/profile/providers/preview",
    { descriptors: [provider] },
    authHeadersA
  );
  assert.equal(preview.response.status, 200);
  assert.equal(preview.body.providers[0].supportsStream, true);
  assert.equal(preview.body.providers[0].supportsSubtitles, true);
  assert.equal(JSON.stringify(preview.body).includes("provider-secret"), false);

  const ipfsPreview = await postJson(
    "/api/profile/providers/preview",
    {
      descriptors: [
        {
          ...provider,
          transportUrl: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3pte3b5/manifest.json",
          manifest: { ...provider.manifest, id: "org.example.ipfs" },
        },
      ],
    },
    authHeadersA
  );
  assert.equal(ipfsPreview.response.status, 200);
  assert.equal(ipfsPreview.body.providers[0].gatewayEligible, false);
  assert.equal(ipfsPreview.body.providers[0].unsupportedTransport, true);

  const backedUp = await postJson(
    "/api/profile/backups",
    { collection: [provider], reason: "before-browser-account-mutation" },
    authHeadersA
  );
  assert.equal(backedUp.response.status, 200);
  const backupId = backedUp.body.backup.id;
  assert.match(backupId, /^[A-Za-z0-9_-]{16,}$/);

  const imported = await request("/api/profile/providers", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeadersA },
    body: JSON.stringify({
      descriptors: [provider],
      expectedRevision: 0,
    }),
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.body.revision, 1);
  assert.equal(imported.body.count, 1);
  assert.equal(Object.hasOwn(imported.body, "backup"), false);
  assert.equal(JSON.stringify(imported.body).includes("provider-secret"), false);

  const combinedOperation = await request("/api/profile/providers", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeadersA },
    body: JSON.stringify({ descriptors: [provider], expectedRevision: 1, backupCollection: [provider] }),
  });
  assert.equal(combinedOperation.response.status, 400);

  const revisionConflict = await request("/api/profile/providers", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeadersA },
    body: JSON.stringify({ descriptors: [provider], expectedRevision: 0 }),
  });
  assert.equal(revisionConflict.response.status, 409);
  const backupsAfterConflict = await request("/api/profile/backups", { headers: authHeadersA });
  assert.equal(backupsAfterConflict.response.status, 200);
  assert.equal(backupsAfterConflict.body.backups.length, 1);

  const listed = await request("/api/profile/providers", { headers: authHeadersA });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.revision, 1);
  assert.equal(listed.body.providers.length, 1);
  assert.equal(JSON.stringify(listed.body).includes("provider-secret"), false);

  const otherProfile = await request("/api/profile/providers", { headers: authHeadersB });
  assert.deepEqual(otherProfile.body, { ok: true, revision: 0, providers: [] });
  const crossProfileBackup = await request(
    `/api/profile/backups/${backupId}`,
    { headers: authHeadersB }
  );
  assert.equal(crossProfileBackup.response.status, 404);

  const recovered = await request(`/api/profile/backups/${backupId}`, {
    headers: authHeadersA,
  });
  assert.equal(recovered.response.status, 200);
  assert.deepEqual(recovered.body.backup.collection, [provider]);

  const revoked = await postJson("/api/profile/session/revoke", {}, authHeadersA);
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.response.headers.get("set-cookie"), null);
  const afterRevoke = await request("/api/profile/providers", { headers: authHeadersA });
  assert.equal(afterRevoke.response.status, 401);
});

test("profile lifecycle APIs enforce exact management scope, CSRF, isolation, and redaction", async () => {
  const configA = await createConfig("Lifecycle Route Profile A", upstreamBaseUrl);
  const deviceA = await pairDevice(configA);
  const deviceA2 = await pairDevice(configA);
  const configB = await createConfig("Lifecycle Route Profile B", upstreamBaseUrl);
  const deviceB = await pairDevice(configB);
  const authA = {
    cookie: deviceA.managementCookie,
    "x-jumpgate-csrf": deviceA.managementCsrf,
    origin: "https://jumpgate.test",
  };
  const bearerA = { authorization: `Bearer ${deviceA.deviceToken}` };
  const bearerA2 = { authorization: `Bearer ${deviceA2.deviceToken}` };
  const bearerB = { authorization: `Bearer ${deviceB.deviceToken}` };

  assert.match(deviceA.managementSetCookie, /Path=\/api\/profile/i);
  assert.match(deviceA.managementSetCookie, /HttpOnly/i);
  assert.match(deviceA.managementSetCookie, /Secure/i);
  assert.match(deviceA.managementSetCookie, /SameSite=Strict/i);

  const missingAuth = await request("/api/profile/devices");
  assert.equal(missingAuth.response.status, 401);
  const missingCsrf = await request("/api/profile/devices", {
    headers: { cookie: deviceA.managementCookie },
  });
  assert.equal(missingCsrf.response.status, 401);
  const hostileOrigin = await request("/api/profile/history", {
    method: "DELETE",
    headers: { ...authA, origin: "https://attacker.example" },
  });
  assert.equal(hostileOrigin.response.status, 403);

  const listed = await request("/api/profile/devices", { headers: authA });
  assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(
    new Set(listed.body.devices.map((device) => device.deviceId)),
    new Set([deviceA.deviceId, deviceA2.deviceId])
  );
  assert.equal(listed.body.devices.some((device) => device.deviceId === deviceB.deviceId), false);
  for (const secret of [
    deviceA.deviceToken,
    deviceA2.deviceToken,
    deviceB.deviceToken,
    deviceA.managementCsrf,
    deviceA.managementCookie.split("=")[1],
  ]) {
    assert.equal(JSON.stringify(listed.body).includes(secret), false);
  }
  assert.doesNotMatch(
    JSON.stringify(listed.body),
    /access_token|refresh_token|deviceToken|device_token|managementCsrf|csrfToken/i
  );

  const crossProfile = await request(`/api/profile/devices/${deviceB.deviceId}`, {
    method: "DELETE",
    headers: authA,
  });
  assert.equal(crossProfile.response.status, 404);
  assert.equal((await request(`/v1/history/${"b".repeat(64)}`, { headers: bearerB })).response.status, 404);

  const messages = [];
  const originalLog = console.log;
  let revoked;
  console.log = (...args) => messages.push(args.join(" "));
  try {
    revoked = await request(`/api/profile/devices/${deviceA2.deviceId}`, {
      method: "DELETE",
      headers: authA,
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(revoked.response.status, 200);
  assert.deepEqual(revoked.body, { ok: true, status: "revoked" });
  assert.equal(messages.some((message) => message.includes(deviceA2.deviceId)), false);
  assert.equal(messages.includes("[REQ] DELETE /api/profile/devices/<redacted>"), true);
  assert.equal((await request(`/v1/history/${"a".repeat(64)}`, { headers: bearerA2 })).response.status, 401);

  const afterRevoke = await request("/api/profile/devices", { headers: authA });
  assert.equal(afterRevoke.response.status, 200);
  assert.deepEqual(afterRevoke.body.devices.map((device) => device.deviceId), [deviceA.deviceId]);
  assert.equal(
    (await request(`/api/profile/devices/${deviceA2.deviceId}`, {
      method: "DELETE",
      headers: authA,
    })).response.status,
    200
  );

  await importPlaybackProvider(deviceA);
  await importPlaybackProvider(deviceB);
  const claimA = await claimConfiguredPlayback(configA, deviceA);
  const claimB = await claimConfiguredPlayback(configB, deviceB);
  const sharedKey = claimA.context.contentKey;
  assert.equal(claimB.context.contentKey, sharedKey);
  const historyA = await postHistoryEvent(
    claimA,
    "progress",
    bearerA,
    { positionMs: 25_000, durationMs: 100_000, watchedMs: 25_000 }
  );
  const historyB = await postHistoryEvent(
    claimB,
    "progress",
    bearerB,
    { positionMs: 40_000, durationMs: 100_000, watchedMs: 40_000 }
  );
  assert.equal(historyA.response.status, 200, JSON.stringify(historyA.body));
  assert.equal(historyB.response.status, 200, JSON.stringify(historyB.body));

  const retiredDelete = await request(`/v1/history/${sharedKey}`, {
    method: "DELETE",
    headers: bearerA,
  });
  assert.equal(retiredDelete.response.status, 410);
  assert.deepEqual(retiredDelete.body, { ok: false, error: "history_grant_required" });
  assert.equal((await request(`/v1/history/${sharedKey}`, { headers: bearerA })).response.status, 200);

  const cleared = await request(`/api/profile/history?profileId=${encodeURIComponent(deviceB.profileId)}`, {
    method: "DELETE",
    headers: authA,
  });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body.ok, true);
  assert.equal(Number.isSafeInteger(cleared.body.historyGeneration), true);
  assert.equal((await request(`/v1/history/${sharedKey}`, { headers: bearerA })).response.status, 404);
  assert.equal((await request(`/v1/history/${sharedKey}`, { headers: bearerB })).response.status, 200);
  const staleGrant = await postHistoryEvent(
    claimA,
    "progress",
    bearerA,
    { positionMs: 30_000, durationMs: 100_000, watchedMs: 30_000 }
  );
  assert.equal(staleGrant.response.status, 409);
  assert.deepEqual(staleGrant.body, { ok: false, error: "history_grant_stale" });

  const freshClaimA = await claimConfiguredPlayback(configA, deviceA, {
    launchedAt: new Date(Date.now() + 1_000).toISOString(),
  });
  const freshHistoryA = await postHistoryEvent(
    freshClaimA,
    "progress",
    bearerA,
    { positionMs: 30_000, durationMs: 100_000, watchedMs: 30_000 }
  );
  assert.equal(freshHistoryA.response.status, 200, JSON.stringify(freshHistoryA.body));
  assert.equal((await request(`/v1/history/${sharedKey}`, { headers: bearerA })).response.status, 200);

  for (const response of [revoked, cleared]) {
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /access_token|refresh_token|deviceToken|device_token|managementCsrf|csrfToken/i
    );
  }
});

test("Trakt disconnect fences stale OAuth callbacks and permits only an explicit reconnect", async () => {
  const config = await createConfig("Lifecycle OAuth Callback");
  const device = await pairDevice(config);
  const auth = {
    cookie: device.managementCookie,
    "x-jumpgate-csrf": device.managementCsrf,
    origin: "https://jumpgate.test",
  };

  const initialDisconnect = await request("/api/profile/trakt", { method: "DELETE", headers: auth });
  assert.deepEqual(initialDisconnect.body, { ok: true, status: "disconnected" });
  const staleFlow = await beginManagementTraktConnect(device);
  const entered = deferred();
  const release = deferred();
  app.setTraktAuthCodeExchangeForTest(async () => {
    entered.resolve();
    await release.promise;
    return {
      access_token: "stale-callback-access",
      refresh_token: "stale-callback-refresh",
      token_expiry: Math.floor(Date.now() / 1000) + 3600,
    };
  });

  let callbackPromise;
  try {
    callbackPromise = request(
      `/auth/trakt/callback?code=stale-code&state=${encodeURIComponent(staleFlow.state)}`,
      { headers: { cookie: staleFlow.bindingCookie }, redirect: "manual" }
    );
    await entered.promise;
    const disconnect = await request("/api/profile/trakt", { method: "DELETE", headers: auth });
    assert.deepEqual(disconnect.body, { ok: true, status: "disconnected" });
    release.resolve();
    const callback = await callbackPromise;
    assert.equal(callback.response.status, 303);
    assert.match(callback.response.headers.get("location"), /[?&]error=/);
  } finally {
    release.resolve();
    if (callbackPromise) await callbackPromise.catch(() => {});
    app.setTraktAuthCodeExchangeForTest(null);
  }

  const disconnected = await request("/api/profile/devices", { headers: auth });
  assert.equal(disconnected.body.traktLinked, false);
  assert.equal(JSON.stringify(disconnected.body).includes("stale-callback-access"), false);

  app.setTraktAuthCodeExchangeForTest(async () => ({
    access_token: "explicit-reconnect-access",
    refresh_token: "explicit-reconnect-refresh",
    token_expiry: Math.floor(Date.now() / 1000) + 3600,
  }));
  try {
    const reconnect = await beginManagementTraktConnect(device);
    const callback = await request(
      `/auth/trakt/callback?code=fresh-code&state=${encodeURIComponent(reconnect.state)}`,
      { headers: { cookie: reconnect.bindingCookie }, redirect: "manual" }
    );
    assert.equal(callback.response.status, 303);
    assert.match(callback.response.headers.get("location"), /[?&]notice=/);
  } finally {
    app.setTraktAuthCodeExchangeForTest(null);
  }
  const linked = await request("/api/profile/devices", { headers: auth });
  assert.equal(linked.body.traktLinked, true);
  assert.equal(JSON.stringify(linked.body).includes("explicit-reconnect-access"), false);
});

test("Trakt disconnect during an in-flight claim-bound event prevents config reseeding and secret disclosure", async () => {
  const expiredAccessToken = "expired-config-access";
  const encryptedRefreshToken = "encrypted-config-refresh";
  const config = await createConfig(
    "Lifecycle OAuth Refresh",
    upstreamBaseUrl,
    {},
    {
      access_token: expiredAccessToken,
      refresh_token: encryptedRefreshToken,
      token_expiry: 1,
    }
  );
  const device = await pairDevice(config);
  await importPlaybackProvider(device);
  const claim = await claimConfiguredPlayback(config, device);
  const auth = {
    cookie: device.managementCookie,
    "x-jumpgate-csrf": device.managementCsrf,
    origin: "https://jumpgate.test",
  };
  const repositorySet = await app.repositoriesForTest();
  const originalUpsertNow = repositorySet.history.upsertNow;
  const entered = deferred();
  const release = deferred();
  repositorySet.history.upsertNow = async function (...args) {
    const stored = await originalUpsertNow.apply(repositorySet.history, args);
    entered.resolve();
    await release.promise;
    return stored;
  };

  let eventPromise;
  let event;
  try {
    eventPromise = postHistoryEvent(
      claim,
      "progress",
      { authorization: "Bearer " + device.deviceToken },
      { positionMs: 10_000, durationMs: 100_000, watchedMs: 10_000 }
    );
    await entered.promise;
    const disconnected = await request("/api/profile/trakt", {
      method: "DELETE",
      headers: auth,
    });
    assert.deepEqual(disconnected.body, { ok: true, status: "disconnected" });
    release.resolve();
    event = await eventPromise;
    assert.equal(event.response.status, 200, JSON.stringify(event.body));
    assert.equal(event.body.status, "applied");
    assert.equal(event.body.dispatchIntent.status, "queued");
  } finally {
    release.resolve();
    if (eventPromise) await eventPromise.catch(() => {});
    repositorySet.history.upsertNow = originalUpsertNow;
  }

  for (const pathname of ["/v1/trakt/token", "/_c/" + config + "/auth/token", "/" + config + "/auth/token"]) {
    const oldCapability = await request(pathname, {
      headers: {
        origin: "https://jumpgate.test",
        authorization: "Bearer " + device.deviceToken,
      },
    });
    assert.equal(oldCapability.response.status, 404);
  }
  const listed = await request("/api/profile/devices", { headers: auth });
  assert.equal(listed.body.traktLinked, false);
  const intents = await repositorySet.historyGrants.listDispatchIntents(
    device.profileId,
    claim.sessionId
  );
  assert.equal(intents.length, 1);
  assert.equal(intents[0].status, "queued");
  const serialized = JSON.stringify([event.body, intents, listed.body]);
  assert.equal(serialized.includes(expiredAccessToken), false);
  assert.equal(serialized.includes(encryptedRefreshToken), false);
  assert.doesNotMatch(serialized, /access_token|refresh_token|client_id/i);
});

test("a delayed profile deletion response cannot clear a newly paired management session", async () => {
  const oldDevice = await pairDevice(await createConfig("Delayed Delete Old Profile"));
  const repositorySet = await app.repositoriesForTest();
  const originalErase = repositorySet.profiles.erase;
  const entered = deferred();
  const release = deferred();
  repositorySet.profiles.erase = async function (profileId) {
    if (profileId === oldDevice.profileId) {
      entered.resolve();
      await release.promise;
    }
    return originalErase.apply(this, arguments);
  };

  let deletionPromise;
  try {
    deletionPromise = request("/api/profile", {
      method: "DELETE",
      headers: {
        cookie: oldDevice.managementCookie,
        "x-jumpgate-csrf": oldDevice.managementCsrf,
        origin: "https://jumpgate.test",
      },
    });
    await entered.promise;

    const newDevice = await pairDevice(await createConfig("Delayed Delete New Profile"));
    const newAuth = {
      cookie: newDevice.managementCookie,
      "x-jumpgate-csrf": newDevice.managementCsrf,
      origin: "https://jumpgate.test",
    };
    assert.equal((await request("/api/profile/devices", { headers: newAuth })).response.status, 200);

    release.resolve();
    const deleted = await deletionPromise;
    assert.equal(deleted.response.status, 202);
    assert.equal(deleted.response.headers.get("set-cookie"), null);
    assert.equal((await request("/api/profile/devices", { headers: newAuth })).response.status, 200);
  } finally {
    release.resolve();
    if (deletionPromise) await deletionPromise.catch(() => {});
    repositorySet.profiles.erase = originalErase;
  }
});

test("profile deletion fences all auth and tombstones configured identities against reprovisioning", async () => {
  const config = await createConfig("Lifecycle Profile Erasure", upstreamBaseUrl);
  const deviceA = await pairDevice(config);
  const deviceB = await pairDevice(config);
  const authA = {
    cookie: deviceA.managementCookie,
    "x-jumpgate-csrf": deviceA.managementCsrf,
    origin: "https://jumpgate.test",
  };
  const authB = {
    cookie: deviceB.managementCookie,
    "x-jumpgate-csrf": deviceB.managementCsrf,
    origin: "https://jumpgate.test",
  };
  await importPlaybackProvider(deviceA);
  const claim = await claimConfiguredPlayback(config, deviceA);
  const key = claim.context.contentKey;
  const history = await postHistoryEvent(
    claim,
    "progress",
    { authorization: `Bearer ${deviceA.deviceToken}` },
    { positionMs: 25_000, durationMs: 100_000, watchedMs: 25_000 }
  );
  assert.equal(history.response.status, 200, JSON.stringify(history.body));

  const erased = await request("/api/profile", { method: "DELETE", headers: authA });
  assert.equal(erased.response.status, 202, JSON.stringify(erased.body));
  assert.deepEqual(erased.body, { ok: true, status: "pending" });
  assert.equal(erased.response.headers.get("set-cookie"), null);

  for (const device of [deviceA, deviceB]) {
    const rejected = await request(`/v1/history/${key}`, {
      headers: { authorization: `Bearer ${device.deviceToken}` },
    });
    assert.equal(rejected.response.status, 401);
  }
  assert.equal((await request("/api/profile/devices", { headers: authA })).response.status, 401);
  assert.equal((await request("/api/profile/devices", { headers: authB })).response.status, 401);
  assert.equal((await request(`/_c/${config}/manifest.json`)).response.status, 403);

  const regenerated = await postJson("/configure/generate", {
    name: "Lifecycle Profile Erasure Regenerated",
    existingConfig: config,
    settings: { subtitle_languages: "en", subtitles_enabled: true },
  });
  assert.equal(regenerated.response.status, 200);
  assert.equal((await request(`/_c/${regenerated.body.config}/manifest.json`)).response.status, 403);
  const pairing = await postJson("/pair/device/code", {});
  const reprovision = await postJson("/pair/activate", {
    userCode: pairing.body.userCode,
    config: regenerated.body.config,
    activationRetryToken: activationRetryToken(),
  });
  assert.equal(reprovision.response.status, 403);
  assert.deepEqual(reprovision.body, { ok: false, error: "profile_unavailable" });
  const pending = await postJson("/pair/device/token", { deviceCode: pairing.body.deviceCode });
  assert.equal(pending.response.status, 200);
  assert.equal(pending.body.paired, false);
  assert.equal(Object.hasOwn(pending.body, "deviceToken"), false);
  assert.equal((await request("/api/profile", { method: "DELETE", headers: authA })).response.status, 401);
});

test("valid configured URLs remain locked until their profile is paired", async () => {
  const config = await createConfig("Not Paired Yet");
  const locked = await request(`/_c/${config}/manifest.json`);
  assert.equal(locked.response.status, 403);
  assert.equal(locked.body.error, "Configuration is not paired with Jumpgate");
});

test("corrupted configured URLs fail closed", async () => {
  const { response, body } = await request("/_c/not-a-config/manifest.json");
  assert.equal(response.status, 400);
  assert.equal(body.error, "Invalid or corrupted configuration");

  const config = await createConfig("Canonical Blob");
  const padded = await request(`/_c/${config}=/manifest.json`);
  assert.equal(padded.response.status, 400);
  assert.equal(padded.body.error, "Invalid or corrupted configuration");
});
