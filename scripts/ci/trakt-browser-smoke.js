"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash, X509Certificate } = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");

process.env.NODE_ENV = "test";
process.env.CONFIG_SECRET = "jumpgate-browser-smoke-test-only";
process.env.TRAKT_CLIENT_SECRET = "jumpgate-browser-smoke-test-only";
process.env.JUMPGATE_DURABLE_DRIVER = "memory";
process.env.JUMPGATE_TTL_DRIVER = "memory";
process.env.JUMPGATE_TEST_MANAGEMENT_TRAKT_CLIENT_PROTOCOL = "form-v2";
delete process.env.PUBLIC_BASE_URL;

const CONNECT_PATH = "/api/profile/trakt/connect";
const CONFIGURE_PATH = "/configure";
const TRAKT_AUTHORIZE_PATH = "/oauth/authorize";
const PROBE_BINDING = "__jumpgateRecordTraktSmoke";

function findOpenSsl() {
  if (process.platform !== "win32") return "openssl";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const candidates = [
    path.join(programFiles, "Git", "usr", "bin", "openssl.exe"),
    path.join(programFiles, "Git", "mingw64", "bin", "openssl.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "openssl.exe";
}

function createEphemeralTlsMaterial(directory) {
  const keyPath = path.join(directory, "loopback-key.pem");
  const certPath = path.join(directory, "loopback-cert.pem");
  const result = spawnSync(
    findOpenSsl(),
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore", windowsHide: true }
  );
  assert.equal(result.status, 0, "could not create the ephemeral loopback TLS certificate");
  const cert = fs.readFileSync(certPath);
  const publicKey = new X509Certificate(cert).publicKey.export({ format: "der", type: "spki" });
  return {
    cert,
    key: fs.readFileSync(keyPath),
    spkiSha256: createHash("sha256").update(publicKey).digest("base64"),
  };
}

function cookieNames(header) {
  if (typeof header !== "string" || !header) return [];
  return header
    .split(";")
    .map((field) => field.slice(0, field.indexOf("=")).trim())
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
    .sort();
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `https://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server || !server.listening) return;
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

test("real Chromium proves the expanded AJAX m1 and native-form m2 Trakt launches", {
  timeout: 120000,
}, async (t) => {
  assert.equal(Number(process.versions.node.split(".", 1)[0]), 24);
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-trakt-browser-"));
  const connectRequests = [];
  const authorizationRequests = [];
  const probeEvents = [];
  let resolveConnectFinished;
  const connectFinished = new Promise((resolve) => {
    resolveConnectFinished = resolve;
  });
  let app = null;
  let authorizationServer = null;
  let browser = null;
  let bridgeServer = null;

  t.after(async () => {
    if (browser) await browser.close();
    await close(bridgeServer);
    await close(authorizationServer);
    if (app) await app.closeStorage();
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  });

  const tls = createEphemeralTlsMaterial(temporaryDirectory);
  authorizationServer = https.createServer(tls, (request, response) => {
    const target = new URL(request.url, "https://127.0.0.1");
    if (target.pathname !== TRAKT_AUTHORIZE_PATH) {
      response.writeHead(404).end();
      return;
    }
    const clientIds = target.searchParams.getAll("client_id");
    const redirectUris = target.searchParams.getAll("redirect_uri");
    const responseTypes = target.searchParams.getAll("response_type");
    const states = target.searchParams.getAll("state");
    authorizationRequests.push({
      clientIdMatches: clientIds.length === 1 && /^[a-f0-9]{64}$/.test(clientIds[0]),
      cookieNames: cookieNames(request.headers.cookie),
      method: request.method,
      origin: request.headers.origin || null,
      pathname: target.pathname,
      queryKeys: [...target.searchParams.keys()].sort(),
      redirectUriMatches:
        redirectUris.length === 1 && redirectUris[0] === origin + "/auth/trakt/callback",
      referer: request.headers.referer || null,
      responseTypeMatches: responseTypes.length === 1 && responseTypes[0] === "code",
      stateMatches: states.length === 1 && /^m[12]\.[A-Za-z0-9_-]{43}$/.test(states[0]),
      stateVersion: states.length === 1 ? states[0].slice(0, 2) : null,
    });
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><title>Trakt authorization stub</title>");
  });
  const authorizationOrigin = await listen(authorizationServer);
  process.env.JUMPGATE_TEST_TRAKT_AUTHORIZE_URL =
    authorizationOrigin + TRAKT_AUTHORIZE_PATH;
  app = require("../../index");

  bridgeServer = https.createServer(tls, (request, response) => {
    if (request.url === CONNECT_PATH) {
      const observation = {
        cookieNames: cookieNames(request.headers.cookie),
        destination: null,
        method: request.method,
        origin: request.headers.origin || null,
        protocol:
          request.headers["content-type"] === "application/x-www-form-urlencoded"
            ? "form-v2"
            : "ajax-v1",
        status: null,
      };
      connectRequests.push(observation);
      response.once("finish", () => {
        observation.status = response.statusCode;
        const location = response.getHeader("location");
        const target = typeof location === "string" ? new URL(location, origin) : null;
        observation.destination =
          target &&
          target.origin === authorizationOrigin &&
          target.pathname === TRAKT_AUTHORIZE_PATH
            ? "authorize"
            : "other";
        resolveConnectFinished();
      });
    }
    app(request, response);
  });
  const origin = await listen(bridgeServer);

  browser = await chromium.launch({
    args: ["--ignore-certificate-errors-spki-list=" + tls.spkiSha256],
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.exposeBinding(PROBE_BINDING, (_source, event) => {
    probeEvents.push(event);
  });
  await page.addInitScript(
    ({ binding, buttonId, configurePath, connectPath }) => {
      if (window.location.pathname !== configurePath) return;
      let clickCount = 0;
      let nativeSubmitCount = 0;
      const record = (event) => {
        void window[binding](event);
      };
      document.addEventListener("click", (event) => {
        const button = event.target && event.target.closest
          ? event.target.closest("#" + buttonId)
          : null;
        if (!button) return;
        clickCount += 1;
        record({ clickCount, kind: "click" });
      }, true);

      const nativeSubmit = HTMLFormElement.prototype.submit;
      HTMLFormElement.prototype.submit = function submit() {
        nativeSubmitCount += 1;
        record({
          actionMatches: new URL(this.action, document.baseURI).pathname === connectPath,
          connected: this.isConnected,
          kind: "native-submit",
          methodMatches: this.method.toLowerCase() === "post",
          nativeSubmitCount,
          ownedByDocument: this.ownerDocument === document,
          underBody: Boolean(document.body && document.body.contains(this)),
        });
        return Reflect.apply(nativeSubmit, this, []);
      };
    },
    {
      binding: PROBE_BINDING,
      buttonId: "reconnectTraktBtn",
      configurePath: CONFIGURE_PATH,
      connectPath: CONNECT_PATH,
    }
  );

  await page.goto(origin + CONFIGURE_PATH, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const response = await fetch("/pair/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName: "Browser smoke" }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || typeof body.userCode !== "string") {
      throw new Error("pairing bootstrap failed");
    }
    const input = document.getElementById("pairCode");
    input.value = body.userCode;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await page.locator('label[for="skipTraktAcknowledge"]').click();
  await page.locator("#skipTraktBtn").click();
  await page.waitForFunction(() => Boolean(document.getElementById("configBlob").value));
  await page.locator("#pairBtn").click();
  await page.waitForFunction(() => {
    const panel = document.getElementById("profileManagement");
    const button = document.getElementById("reconnectTraktBtn");
    return panel && !panel.classList.contains("hidden") && button && !button.disabled;
  });

  let resolveAuthorizationRequest;
  const authorizationRequest = new Promise((resolve) => {
    resolveAuthorizationRequest = resolve;
  });
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin === authorizationOrigin && target.pathname === TRAKT_AUTHORIZE_PATH) {
      resolveAuthorizationRequest(request);
    }
  });
  await page.evaluate(() => {
    const button = document.getElementById("reconnectTraktBtn");
    button.click();
    button.click();
  });
  await connectFinished;
  assert.deepEqual(connectRequests, [
    {
      cookieNames: ["jg_management_session"],
      destination: "authorize",
      method: "POST",
      origin,
      protocol: "form-v2",
      status: 303,
    },
  ]);
  let authorizationTimeout;
  let authorizationNavigation;
  try {
    authorizationNavigation = await Promise.race([
      authorizationRequest,
      new Promise((_, reject) => {
        authorizationTimeout = setTimeout(
          () => reject(new Error("authorization redirect was not requested")),
          10000
        );
      }),
    ]);
  } finally {
    clearTimeout(authorizationTimeout);
  }
  assert.equal(authorizationNavigation.method(), "GET");
  const redirectedFrom = authorizationNavigation.redirectedFrom();
  assert.ok(redirectedFrom);
  assert.equal(redirectedFrom.method(), "POST");
  assert.equal(new URL(redirectedFrom.url()).pathname, CONNECT_PATH);
  assert.equal((await redirectedFrom.response()).status(), 303);
  assert.equal((await authorizationNavigation.response()).status(), 200);
  assert.deepEqual(probeEvents.filter((event) => event.kind === "click"), [
    { clickCount: 1, kind: "click" },
  ]);
  assert.deepEqual(probeEvents.filter((event) => event.kind === "native-submit"), [
    {
      actionMatches: true,
      connected: true,
      kind: "native-submit",
      methodMatches: true,
      nativeSubmitCount: 1,
      ownedByDocument: true,
      underBody: true,
    },
  ]);
  assert.deepEqual(authorizationRequests, [
    {
      clientIdMatches: true,
      cookieNames: [],
      method: "GET",
      origin: null,
      pathname: TRAKT_AUTHORIZE_PATH,
      queryKeys: ["client_id", "redirect_uri", "response_type", "state"],
      redirectUriMatches: true,
      referer: null,
      responseTypeMatches: true,
      stateMatches: true,
      stateVersion: "m2",
    },
  ]);

  const legacyContext = await browser.newContext();
  const legacyPage = await legacyContext.newPage();
  let resolveLegacyAuthorization;
  const legacyAuthorization = new Promise((resolve) => {
    resolveLegacyAuthorization = resolve;
  });
  legacyPage.on("request", (request) => {
    const target = new URL(request.url());
    if (target.origin === authorizationOrigin && target.pathname === TRAKT_AUTHORIZE_PATH) {
      resolveLegacyAuthorization(request);
    }
  });
  await legacyPage.goto(origin + CONFIGURE_PATH, { waitUntil: "networkidle" });
  await legacyPage.evaluate(async () => {
    const parse = async (response, label) => {
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) throw new Error(label + " failed");
      return body;
    };
    const generated = await parse(
      await fetch("/configure/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Cached browser smoke" }),
      }),
      "generation"
    );
    const issued = await parse(
      await fetch("/pair/device/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      "pair code"
    );
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);
    const retryToken = btoa(String.fromCharCode(...entropy))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    entropy.fill(0);
    const activated = await parse(
      await fetch("/pair/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          userCode: issued.userCode,
          config: generated.config,
          activationRetryToken: retryToken,
        }),
      }),
      "pair activation"
    );
    const started = await parse(
      await fetch("/api/profile/trakt/connect", {
        method: "POST",
        headers: { "X-Jumpgate-CSRF": activated.managementCsrf },
        credentials: "same-origin",
        cache: "no-store",
      }),
      "cached-client Trakt launch"
    );
    if (started.url !== "/api/profile/trakt/connect/continue") {
      throw new Error("cached-client continuation was not fixed and same-origin");
    }
    setTimeout(() => window.location.assign(started.url), 0);
  });
  const legacyNavigation = await legacyAuthorization;
  assert.equal(legacyNavigation.method(), "GET");
  assert.equal((await legacyNavigation.response()).status(), 200);
  assert.deepEqual(connectRequests[1], {
    cookieNames: ["jg_management_session"],
    destination: "other",
    method: "POST",
    origin,
    protocol: "ajax-v1",
    status: 200,
  });
  assert.deepEqual(authorizationRequests[1], {
    clientIdMatches: true,
    cookieNames: [],
    method: "GET",
    origin: null,
    pathname: TRAKT_AUTHORIZE_PATH,
    queryKeys: ["client_id", "redirect_uri", "response_type", "state"],
    redirectUriMatches: true,
    referer: null,
    responseTypeMatches: true,
    stateMatches: true,
    stateVersion: "m1",
  });
});
