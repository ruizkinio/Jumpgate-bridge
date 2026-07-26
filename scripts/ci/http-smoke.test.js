"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const BUILD_SHA = "0123456789abcdef".repeat(2) + "01234567";
const SCRIPT = path.join(__dirname, "http-smoke.js");
const HEALTH_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  server: "Fly/test-edge",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

function runSmoke(baseUrl, options = {}) {
  const deadlineMs = options.deadlineMs || 3000;
  const expectedReadiness = options.expectedReadiness || "ready";
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      SCRIPT,
      "--base-url=" + baseUrl,
      "--expected-version=3.0.0",
      "--expected-build-sha=" + BUILD_SHA,
      "--expected-readiness=" + expectedReadiness,
      "--deadline-ms=" + deadlineMs,
      "--delay-ms=10",
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(body);
}

function sendHealth(res, value, status = 200, overrides = {}) {
  const body = Object.hasOwn(overrides, "body") ? overrides.body : JSON.stringify(value);
  res.statusCode = status;
  for (const [name, headerValue] of Object.entries(HEALTH_HEADERS)) {
    res.setHeader(name, headerValue);
  }
  for (const [name, headerValue] of Object.entries(overrides.headers || {})) {
    if (headerValue === null) res.removeHeader(name);
    else res.setHeader(name, headerValue);
  }
  res.setHeader("content-length", Buffer.byteLength(body));
  res.end(body);
}

function completeHandler(options = {}) {
  return (req, res) => {
    options.onRequest?.(req);
    if (req.url === "/health/live") {
      options.onLive?.();
      return sendHealth(
        res,
        { ok: true, status: "live" },
        200,
        options.liveOverrides
      );
    }
    if (req.url === "/health/ready") {
      const result = options.ready?.() || { value: { ok: true, status: "ready" }, status: 200 };
      return sendHealth(res, result.value, result.status, result.overrides);
    }
    if (req.url === "/version") {
      return sendJson(res, {
        version: "3.0.0",
        major: 3,
        minor: 0,
        patch: 0,
        buildSha: BUILD_SHA,
      });
    }
    if (req.url === "/manifest.json") {
      return sendJson(res, {
        id: "com.jumpgate.bridge",
        version: "3.0.0",
        behaviorHints: { configurable: true, configurationRequired: true },
      });
    }
    if (req.url === "/configure") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(
        '<title>Jumpgate Bridge Configure</title><button id="connectStremioBtn"></button>'
      );
    }
    res.statusCode = 404;
    res.end();
  };
}

test("semantic smoke retries the complete contract and requires exact provenance", async () => {
  let liveRequests = 0;
  let readyRequests = 0;
  const acceptEncodings = [];
  const fixture = await listen(
    completeHandler({
      onRequest: (request) => {
        acceptEncodings.push(request.headers["accept-encoding"]);
      },
      onLive: () => {
        liveRequests += 1;
      },
      ready: () => {
        readyRequests += 1;
        if (readyRequests === 1) {
          return { value: { ok: false, status: "not_ready" }, status: 503 };
        }
        return { value: { ok: true, status: "ready" }, status: 200 };
      },
    })
  );

  try {
    const result = await runSmoke(fixture.baseUrl);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /HTTP smoke passed/);
    assert.equal(liveRequests >= 2, true);
    assert.equal(acceptEncodings.length > 0, true);
    assert.equal(acceptEncodings.every((value) => value === "identity"), true);
  } finally {
    await close(fixture.server);
  }
});

test("negative mode requires exact live and public-attestation not-ready contracts only", async () => {
  let ordinaryRequests = 0;
  const fixture = await listen((req, res) => {
    if (req.url === "/health/live") {
      return sendHealth(res, { ok: true, status: "live" });
    }
    if (req.url === "/health/ready") {
      return sendHealth(res, { ok: false, status: "not_ready" }, 503);
    }
    ordinaryRequests += 1;
    res.statusCode = 500;
    res.end();
  });
  try {
    const result = await runSmoke(fixture.baseUrl, { expectedReadiness: "not-ready" });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /negative readiness attestation/);
    assert.equal(ordinaryRequests, 0);
  } finally {
    await close(fixture.server);
  }
});

test("health smoke rejects non-exact bodies, security headers, and forbidden public headers", async (t) => {
  const cases = [
    ["body", { body: '{"ok":true,"status":"live"}\n' }],
    ["content type", { headers: { "content-type": "application/json" } }],
    ["cache", { headers: { "cache-control": "max-age=1" } }],
    ["HSTS", { headers: { "strict-transport-security": null } }],
    ["frame", { headers: { "x-frame-options": "SAMEORIGIN" } }],
    ["CORS", { headers: { "access-control-allow-origin": "*" } }],
    ["rate limit", { headers: { "ratelimit-limit": "300" } }],
    ["rate policy", { headers: { "ratelimit-policy": "300;w=60" } }],
    ["rate remaining", { headers: { "ratelimit-remaining": "299" } }],
    ["rate reset", { headers: { "ratelimit-reset": "60" } }],
    ["powered by", { headers: { "x-powered-by": "Express" } }],
  ];
  for (const [name, liveOverrides] of cases) {
    await t.test(name, async () => {
      const fixture = await listen(completeHandler({ liveOverrides }));
      try {
        const result = await runSmoke(fixture.baseUrl, { deadlineMs: 200 });
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /^HTTP smoke failed: health-live\//);
      } finally {
        await close(fixture.server);
      }
    });
  }
});

test("smoke failures never echo malformed or secret response bodies", async () => {
  const secret = "trakt-" + "super-secret-body-value";
  const fixture = await listen((_req, res) => {
    for (const [name, value] of Object.entries(HEALTH_HEADERS)) res.setHeader(name, value);
    res.end('{"leak":"' + secret);
  });

  try {
    const result = await runSmoke(fixture.baseUrl, { deadlineMs: 250 });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.match(result.stderr, /^HTTP smoke failed: health-live\/(?:content-type|size|body|transport)\s*$/);
  } finally {
    await close(fixture.server);
  }
});
