"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const zlib = require("node:zlib");

const { UpstreamFetchPolicy } = require("../lib/upstream-fetch-policy");

function bodyFrom(chunks) {
  let destroyed = false;
  return {
    get destroyed() {
      return destroyed;
    },
    destroy() {
      destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk);
    },
  };
}

function response(status, chunks, headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])
  );
  return {
    body: bodyFrom(chunks === null ? [] : Array.isArray(chunks) ? chunks : [chunks]),
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) || null },
    status,
  };
}

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("fetchBuffer pins DNS, forwards only explicit safe headers, and decodes bytes", async () => {
  const plain = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
  const compressed = zlib.gzipSync(plain);
  const calls = [];
  const policy = new UpstreamFetchPolicy({
    resolver: async (hostname) => {
      calls.push(["resolve", hostname]);
      return publicResolver();
    },
    fetch: async (url, options) => {
      calls.push(["fetch", url, options.headers]);
      assert.equal(options.compress, false);
      assert.equal(options.redirect, "manual");
      const pinned = await new Promise((resolve, reject) =>
        options.agent.options.lookup(
          "provider.example",
          { family: 4 },
          (error, address) => (error ? reject(error) : resolve(address))
        )
      );
      assert.equal(pinned, "93.184.216.34");
      return response(200, compressed, {
        "content-encoding": "gzip",
        "content-length": compressed.length,
        "content-type": "application/x-subrip; charset=UTF-8",
      });
    },
  });

  const result = await policy.fetchBuffer("https://provider.example/subtitle?id=private", {
    admissionKey: "profile-a",
    allowedHeaderNames: ["authorization", "referer"],
    upstreamHeaders: {
      Authorization: "Bearer provider-secret",
      Referer: "https://provider.example/",
      "X-Untrusted": "must-not-forward",
    },
  });

  assert.deepEqual(result.body, plain);
  assert.equal(result.contentType, "application/x-subrip");
  assert.equal(result.charset, "utf-8");
  assert.equal(result.status, 200);
  assert.equal(result.redirects, 0);
  assert.equal(calls[1][2].authorization, "Bearer provider-secret");
  assert.equal(calls[1][2].referer, "https://provider.example/");
  assert.equal(Object.hasOwn(calls[1][2], "x-untrusted"), false);
  assert.equal(calls[1][2]["accept-encoding"], "gzip, deflate, br, identity");
  assert.equal(Object.hasOwn(result, "url"), false);
  assert.equal(Object.hasOwn(result, "headers"), false);
});

test("fetchBuffer rejects unsafe headers before I/O", async () => {
  let fetchCalls = 0;
  const policy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () => {
      fetchCalls += 1;
      return response(200, "unused");
    },
  });

  for (const options of [
    {
      allowedHeaderNames: ["authorization"],
      upstreamHeaders: { Authorization: "Bearer safe\r\nX-Evil: injected" },
    },
    {
      allowedHeaderNames: ["connection"],
      upstreamHeaders: { Connection: "keep-alive" },
    },
    {
      allowedHeaderNames: ["proxy-connection"],
      upstreamHeaders: { "Proxy-Connection": "keep-alive" },
    },
    {
      allowedHeaderNames: ["host"],
      upstreamHeaders: { Host: "attacker.example" },
    },
    {
      allowedHeaderNames: ["x-safe"],
      upstreamHeaders: { "Bad Header": "value" },
    },
  ]) {
    await assert.rejects(
      policy.fetchBuffer("https://provider.example/subtitle", options),
      (error) =>
        error.code === "upstream_header_invalid" || error.code === "upstream_header_blocked"
    );
  }
  assert.equal(fetchCalls, 0);
});

test("fetchBuffer retains headers on same-origin redirects and strips them permanently at CDN boundaries", async () => {
  const seen = [];
  const sameOrigin = new UpstreamFetchPolicy({
    resolver: async (hostname) => {
      seen.push(["resolve", hostname]);
      return publicResolver();
    },
    fetch: async (url, options) => {
      seen.push(["fetch", url, options.headers.authorization]);
      return url.endsWith("/start")
        ? response(302, null, { location: "/final" })
        : response(200, "subtitle");
    },
  });
  const result = await sameOrigin.fetchBuffer("https://provider.example/start", {
    allowedHeaderNames: ["authorization"],
    upstreamHeaders: { Authorization: "Bearer provider-secret" },
  });
  assert.equal(result.body.toString(), "subtitle");
  assert.equal(result.redirects, 1);
  assert.deepEqual(seen, [
    ["resolve", "provider.example"],
    ["fetch", "https://provider.example/start", "Bearer provider-secret"],
    ["resolve", "provider.example"],
    ["fetch", "https://provider.example/final", "Bearer provider-secret"],
  ]);

  const crossOriginRequests = [];
  const crossOrigin = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async (url, options) => {
      crossOriginRequests.push([url, options.headers]);
      if (url.includes("provider.example")) {
        return response(302, null, { location: "https://cdn-one.example/subtitle" });
      }
      if (url.includes("cdn-one.example")) {
        return response(302, null, { location: "https://cdn-two.example/subtitle" });
      }
      return response(200, "cdn subtitle");
    },
  });
  const crossOriginResult = await crossOrigin.fetchBuffer("https://provider.example/start", {
    allowedHeaderNames: ["authorization", "cookie", "referer", "x-provider-token"],
    upstreamHeaders: {
      Authorization: "Bearer provider-secret",
      Cookie: "session=provider-secret",
      Referer: "https://provider.example/private",
      "X-Provider-Token": "custom-secret",
    },
  });
  assert.equal(crossOriginResult.body.toString(), "cdn subtitle");
  assert.equal(crossOriginResult.redirects, 2);
  assert.equal(crossOriginRequests[0][1].authorization, "Bearer provider-secret");
  assert.equal(crossOriginRequests[0][1].cookie, "session=provider-secret");
  for (const [, headers] of crossOriginRequests.slice(1)) {
    assert.equal(Object.hasOwn(headers, "authorization"), false);
    assert.equal(Object.hasOwn(headers, "cookie"), false);
    assert.equal(Object.hasOwn(headers, "referer"), false);
    assert.equal(Object.hasOwn(headers, "x-provider-token"), false);
    assert.equal(headers.accept, "*/*");
    assert.equal(headers["accept-encoding"], "gzip, deflate, br, identity");
  }
});

test("fetchBuffer allows a headerless CDN transition but rejects HTTPS downgrade", async () => {
  const observed = [];
  const headerless = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async (url, options) => {
      observed.push(options.headers);
      return url.includes("provider.example")
        ? response(302, null, { location: "https://cdn.example/subtitle" })
        : response(200, "headerless");
    },
  });
  const result = await headerless.fetchBuffer("https://provider.example/start");
  assert.equal(result.body.toString(), "headerless");
  assert.equal(observed.length, 2);
  assert.deepEqual(Object.keys(observed[1]).sort(), ["accept", "accept-encoding"]);

  const downgrade = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () =>
      response(302, null, { location: "http://cdn.example/subtitle" }),
  });
  await assert.rejects(
    downgrade.fetchBuffer("https://provider.example/start"),
    (error) => error.code === "upstream_redirect_downgrade"
  );
});

test("fetchBuffer revalidates SSRF targets and bounds status, wire, and decoded bytes", async () => {
  let fetchCalls = 0;
  const blocked = new UpstreamFetchPolicy({
    fetch: async () => {
      fetchCalls += 1;
      return response(200, "unused");
    },
  });
  await assert.rejects(
    blocked.fetchBuffer("http://127.0.0.1/subtitle"),
    (error) => error.code === "upstream_address_blocked"
  );
  assert.equal(fetchCalls, 0);

  const statusPolicy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () => response(403, "provider token rejected"),
  });
  await assert.rejects(
    statusPolicy.fetchBuffer("https://provider.example/subtitle"),
    (error) =>
      error.code === "upstream_http_status" && !error.message.includes("token")
  );

  const wireBody = bodyFrom([Buffer.alloc(5), Buffer.alloc(5)]);
  const wirePolicy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxWireBytes: 8,
    fetch: async () => ({
      body: wireBody,
      headers: { get: () => null },
      status: 200,
    }),
  });
  await assert.rejects(
    wirePolicy.fetchBuffer("https://provider.example/subtitle"),
    (error) => error.code === "upstream_wire_body_too_large"
  );
  assert.equal(wireBody.destroyed, true);

  const compressed = zlib.gzipSync(Buffer.alloc(4096, 0x41));
  const decodedPolicy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxBinaryDecodedBytes: 1024,
    maxContentEncodingRatio: 100,
    fetch: async () =>
      response(200, compressed, {
        "content-encoding": "gzip",
        "content-length": compressed.length,
      }),
  });
  await assert.rejects(
    decodedPolicy.fetchBuffer("https://provider.example/subtitle"),
    (error) => error.code === "upstream_decoded_body_too_large"
  );

  for (const contentLength of ["-1", "01", "1, 2", "not-a-number"]) {
    const invalidLength = new UpstreamFetchPolicy({
      resolver: publicResolver,
      fetch: async () => response(200, "subtitle", { "content-length": contentLength }),
    });
    await assert.rejects(
      invalidLength.fetchBuffer("https://provider.example/subtitle"),
      (error) => error.code === "upstream_content_length_invalid",
      contentLength
    );
  }
  for (const contentLength of ["3", "99"]) {
    const mismatchedLength = new UpstreamFetchPolicy({
      resolver: publicResolver,
      fetch: async () => response(200, "subtitle", { "content-length": contentLength }),
    });
    await assert.rejects(
      mismatchedLength.fetchBuffer("https://provider.example/subtitle"),
      (error) => error.code === "upstream_content_length_invalid",
      contentLength
    );
  }
});

test("fetchBuffer rejects malformed or stacked encodings and releases admission on timeout", async () => {
  for (const [encoding, body, code] of [
    ["gzip, br", Buffer.from("bad"), "upstream_content_encoding_blocked"],
    ["compress", Buffer.from("bad"), "upstream_content_encoding_blocked"],
    ["gzip", Buffer.from("not-gzip"), "upstream_content_encoding_invalid"],
    [
      "gzip",
      zlib.gzipSync(Buffer.from("truncated")).subarray(0, -4),
      "upstream_content_encoding_invalid",
    ],
  ]) {
    const policy = new UpstreamFetchPolicy({
      resolver: publicResolver,
      fetch: async () => response(200, body, { "content-encoding": encoding }),
    });
    await assert.rejects(
      policy.fetchBuffer("https://provider.example/subtitle"),
      (error) => error.code === code
    );
  }

  const timeoutPolicy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    totalTimeoutMs: 20,
    fetch: async () => new Promise(() => {}),
  });
  await assert.rejects(
    timeoutPolicy.fetchBuffer("https://provider.example/subtitle"),
    (error) => error.code === "upstream_timeout"
  );
  assert.equal(timeoutPolicy._semaphore._active, 0);
  assert.equal(timeoutPolicy._semaphore._groupsByKey.size, 0);
});

test("fetchBuffer cancels a stalled body, releases admission, and remains reusable", async () => {
  let releaseBody;
  let destroyed = false;
  let calls = 0;
  const stalledBody = {
    get destroyed() {
      return destroyed;
    },
    destroy() {
      destroyed = true;
      releaseBody();
    },
    async *[Symbol.asyncIterator]() {
      await new Promise((resolve) => {
        releaseBody = resolve;
      });
    },
  };
  const policy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    totalTimeoutMs: 20,
    maxConcurrent: 1,
    maxQueued: 1,
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? { body: stalledBody, headers: { get: () => null }, status: 200 }
        : response(200, "recovered");
    },
  });
  await assert.rejects(
    policy.fetchBuffer("https://provider.example/stalled"),
    (error) => error.code === "upstream_timeout"
  );
  assert.equal(stalledBody.destroyed, true);
  assert.equal(policy._semaphore._active, 0);
  assert.equal(policy._semaphore._groupsByKey.size, 0);
  const recovered = await policy.fetchBuffer("https://provider.example/recovered");
  assert.equal(recovered.body.toString(), "recovered");
});

test("fetchBuffer decodes each explicitly supported content encoding", async () => {
  const source = Buffer.from("bounded subtitle bytes");
  const encodings = [
    ["identity", source],
    ["gzip", zlib.gzipSync(source)],
    ["x-gzip", zlib.gzipSync(source)],
    ["deflate", zlib.deflateSync(source)],
    ["br", zlib.brotliCompressSync(source)],
  ];
  for (const [encoding, encoded] of encodings) {
    const policy = new UpstreamFetchPolicy({
      resolver: publicResolver,
      fetch: async () =>
        response(200, encoded, {
          "content-encoding": encoding,
          "content-length": encoded.length,
        }),
    });
    const result = await policy.fetchBuffer("https://provider.example/subtitle");
    assert.deepEqual(result.body, source, encoding);
  }
});

test("fetchBuffer sanitizes transport and resolver errors that may contain provider secrets", async () => {
  for (const policy of [
    new UpstreamFetchPolicy({
      resolver: async () => {
        throw new Error("lookup failed for provider.example?token=resolver-secret");
      },
    }),
    new UpstreamFetchPolicy({
      resolver: publicResolver,
      fetch: async () => {
        throw new Error("failed https://provider.example/subtitle?token=fetch-secret");
      },
    }),
  ]) {
    await assert.rejects(
      policy.fetchBuffer("https://provider.example/subtitle?token=request-secret"),
      (error) =>
        error.code === "upstream_fetch_failed" &&
        !/resolver-secret|fetch-secret|request-secret|provider\.example/.test(error.message)
    );
  }
});

test("fetchBuffer bounds same-origin redirects and shares bounded admission", async () => {
  let redirectCount = 0;
  const redirectPolicy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxRedirects: 1,
    fetch: async () =>
      response(302, null, { location: "/redirect-" + (redirectCount += 1) }),
  });
  await assert.rejects(
    redirectPolicy.fetchBuffer("https://provider.example/start"),
    (error) => error.code === "upstream_redirect_limit"
  );

  const executions = [];
  const admissionPolicy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxConcurrent: 1,
    maxQueued: 1,
    totalTimeoutMs: 1000,
    fetch: async () => {
      const execution = deferred();
      executions.push(execution);
      return execution.promise;
    },
  });
  const first = admissionPolicy.fetchBuffer("https://provider.example/one");
  const second = admissionPolicy.fetchBuffer("https://provider.example/two");
  await assert.rejects(
    admissionPolicy.fetchBuffer("https://provider.example/three"),
    (error) => error.code === "upstream_queue_full"
  );
  while (executions.length < 1) await new Promise((resolve) => setImmediate(resolve));
  executions.shift().resolve(response(200, "one"));
  assert.equal((await first).body.toString(), "one");
  while (executions.length < 1) await new Promise((resolve) => setImmediate(resolve));
  executions.shift().resolve(response(200, "two"));
  assert.equal((await second).body.toString(), "two");
  assert.equal(admissionPolicy._semaphore._active, 0);
  assert.equal(admissionPolicy._semaphore._queued, 0);
});

test("fetchBuffer re-resolves every redirect hop and blocks DNS rebinding", async () => {
  let resolutions = 0;
  let fetchCalls = 0;
  const policy = new UpstreamFetchPolicy({
    resolver: async () => {
      resolutions += 1;
      return resolutions === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    },
    fetch: async () => {
      fetchCalls += 1;
      return response(302, null, { location: "/same-origin-next" });
    },
  });
  await assert.rejects(
    policy.fetchBuffer("https://provider.example/start"),
    (error) => error.code === "upstream_address_blocked"
  );
  assert.equal(resolutions, 2);
  assert.equal(fetchCalls, 1);
});
