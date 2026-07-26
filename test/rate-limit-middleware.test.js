"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRateLimitMiddleware } = require("../lib/rate-limit-middleware");

const CLIENT_IP = "203.0.113.42";
const CLIENT_HASH = "a".repeat(64);

class FakeResponse {
  constructor() {
    this.body = null;
    this.headers = new Map();
    this.statusCode = 200;
  }

  setHeader(name, value) {
    this.headers.set(String(name).toLowerCase(), String(value));
    return this;
  }

  getHeader(name) {
    return this.headers.get(String(name).toLowerCase());
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    return this;
  }
}

class SharedFixedWindowRepository {
  constructor(clock) {
    this.clock = clock;
    this.calls = [];
    this.entries = new Map();
  }

  async consume(scope, key, limit, windowMs) {
    this.calls.push({ scope, key, limit, windowMs });
    const now = this.clock();
    const storageKey = scope + ":" + key;
    let entry = this.entries.get(storageKey);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(storageKey, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= limit,
      remaining: Math.max(0, limit - entry.count),
      resetAt: entry.resetAt,
    };
  }
}

function middleware(repository, options = {}) {
  return createRateLimitMiddleware({
    scope: options.scope || "http-global",
    limit: options.limit || 2,
    windowMs: 60_000,
    message: options.message || "Rate limit exceeded.",
    getRepository: () => repository,
    keyGenerator: options.keyGenerator || (() => CLIENT_IP),
    hashClientKey: options.hashClientKey || (() => CLIENT_HASH),
    skip: options.skip,
    clock: options.clock || (() => 1_000),
  });
}

async function invoke(handler) {
  const res = new FakeResponse();
  let nextCalls = 0;
  await handler({ path: "/version", ip: CLIENT_IP }, res, () => {
    nextCalls += 1;
  });
  return { nextCalls, res };
}

test("middleware instances aggregate through their shared repository and emit standard headers", async () => {
  const repository = new SharedFixedWindowRepository(() => 1_000);
  const firstInstance = middleware(repository);
  const secondInstance = middleware(repository);

  const first = await invoke(firstInstance);
  const second = await invoke(secondInstance);
  const blocked = await invoke(firstInstance);

  assert.equal(first.nextCalls, 1);
  assert.equal(second.nextCalls, 1);
  assert.equal(blocked.nextCalls, 0);
  assert.equal(blocked.res.statusCode, 429);
  assert.deepEqual(blocked.res.body, {
    ok: false,
    error: "Rate limit exceeded.",
    retryAfterSec: 60,
  });
  assert.equal(blocked.res.getHeader("RateLimit-Policy"), "2;w=60");
  assert.equal(blocked.res.getHeader("RateLimit-Limit"), "2");
  assert.equal(blocked.res.getHeader("RateLimit-Remaining"), "0");
  assert.equal(blocked.res.getHeader("RateLimit-Reset"), "60");
  assert.equal(blocked.res.getHeader("Retry-After"), "60");
  assert.equal(blocked.res.getHeader("X-RateLimit-Limit"), undefined);
  assert.equal(repository.calls.every((call) => call.key === CLIENT_HASH), true);
  assert.equal(JSON.stringify(repository.calls).includes(CLIENT_IP), false);
});

test("pair route scopes remain independent for the same purpose-hashed client", async () => {
  const repository = new SharedFixedWindowRepository(() => 1_000);
  const code = middleware(repository, { scope: "pair-device-code", limit: 1 });
  const token = middleware(repository, { scope: "pair-device-token", limit: 1 });

  assert.equal((await invoke(code)).nextCalls, 1);
  assert.equal((await invoke(token)).nextCalls, 1);
  assert.equal((await invoke(code)).res.statusCode, 429);
  assert.equal((await invoke(token)).res.statusCode, 429);
  assert.deepEqual(
    repository.calls.map((call) => call.scope),
    ["pair-device-code", "pair-device-token", "pair-device-code", "pair-device-token"]
  );
});

test("skip bypasses key derivation and repository consumption", async () => {
  let hashCalls = 0;
  const handler = middleware(null, {
    skip: () => true,
    keyGenerator: () => {
      throw new Error("key generation must not run");
    },
    hashClientKey: () => {
      hashCalls += 1;
      return CLIENT_HASH;
    },
  });

  const result = await invoke(handler);
  assert.equal(result.nextCalls, 1);
  assert.equal(result.res.body, null);
  assert.equal(result.res.headers.size, 0);
  assert.equal(hashCalls, 0);
});

test("repository errors fail closed without exposing client or storage details", async () => {
  const privateDetail = "redis://user:secret@private.example/0";
  const repository = {
    async consume() {
      throw new Error(privateDetail + " client=" + CLIENT_IP);
    },
  };
  const result = await invoke(middleware(repository));

  assert.equal(result.nextCalls, 0);
  assert.equal(result.res.statusCode, 503);
  assert.deepEqual(result.res.body, { ok: false, error: "service_unavailable" });
  assert.equal(result.res.getHeader("Cache-Control"), "no-store");
  assert.equal(JSON.stringify(result.res.body).includes(privateDetail), false);
  assert.equal(JSON.stringify(result.res.body).includes(CLIENT_IP), false);
});

test("allowed and skipped requests do not reinterpret downstream failures as limiter outages", async () => {
  const repository = new SharedFixedWindowRepository(() => 1_000);
  const downstreamError = new Error("downstream route failure");

  await assert.rejects(
    middleware(repository)({ path: "/version", ip: CLIENT_IP }, new FakeResponse(), () => {
      throw downstreamError;
    }),
    downstreamError
  );

  await assert.rejects(
    middleware(null, { skip: () => true })(
      { path: "/pair/device/token", ip: CLIENT_IP },
      new FakeResponse(),
      () => {
        throw downstreamError;
      }
    ),
    downstreamError
  );
});
