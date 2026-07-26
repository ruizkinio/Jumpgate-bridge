"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  DEFAULT_POLICY,
  UpstreamFetchPolicy,
  isGlobalUnicastAddress,
  resolveAndPin,
  validateEndpoint,
} = require("../lib/upstream-fetch-policy");

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

function response(status, value, headers = {}) {
  const body = bodyFrom(value === null ? [] : [typeof value === "string" ? value : JSON.stringify(value)]);
  const normalized = new Map(
    Object.entries(headers).map(([key, item]) => [key.toLowerCase(), String(item)])
  );
  return {
    status,
    body,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) || null },
  };
}

const publicResolver = async () => [{ address: "93.184.216.34", family: 4 }];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("global-address policy classifies an adversarial representation matrix by canonical bytes", () => {
  const matrix = [
    {
      expected: false,
      label: "IPv4 non-global",
      addresses: [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.1.1",
        "172.16.0.1",
        "192.0.2.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
      ],
    },
    {
      expected: false,
      label: "IPv4-mapped non-global",
      addresses: [
        "::ffff:127.0.0.1",
        "::FFFF:127.0.0.1",
        "::ffff:7f00:1",
        "0:0:0:0:0:ffff:7f00:1",
        "0000:0000:0000:0000:0000:ffff:7f00:0001",
        "0:0:0:0:0:FFFF:127.0.0.1",
        "::ffff:a00:1",
        "::ffff:6440:1",
        "::ffff:c0a8:101",
        "::ffff:c633:6401",
      ],
    },
    {
      expected: false,
      label: "IPv4-compatible",
      addresses: [
        "::127.0.0.1",
        "::7f00:1",
        "0:0:0:0:0:0:7f00:1",
        "::8.8.8.8",
        "0000:0000:0000:0000:0000:0000:0808:0808",
      ],
    },
    {
      expected: false,
      label: "IPv4 translation",
      addresses: [
        "::ffff:0:127.0.0.1",
        "0:0:0:0:ffff:0:7f00:1",
        "64:ff9b::127.0.0.1",
        "0064:ff9b:0000:0000:0000:0000:7f00:0001",
        "64:ff9b:1::7f00:1",
        "0064:ff9b:0001:0000:0000:0000:7f00:0001",
      ],
    },
    {
      expected: false,
      label: "IPv6 special, reserved, and documentation",
      addresses: [
        "::",
        "0:0:0:0:0:0:0:0",
        "::1",
        "0:0:0:0:0:0:0:1",
        "100::1",
        "100:0:0:1::1",
        "2001:2::1",
        "2001:10::1",
        "2001:db8::1",
        "2001:0db8:0000:0000:0000:0000:0000:0001",
        "2002:c000:201::1",
        "2d00::1",
        "2e00::1",
        "3000::1",
        "3ffd::1",
        "3fff:1000::1",
        "3ffe::1",
        "3fff::1",
        "4000::1",
        "5f00::1",
        "fc00::1",
        "fdff:ffff:ffff:ffff::1",
        "fe80::1",
        "fec0::1",
        "ff00::1",
      ],
    },
    {
      expected: false,
      label: "invalid or scoped",
      addresses: ["", "not-an-ip", "127.1", "2130706433", "fe80::1%eth0", "[fe80::1%25eth0]"],
    },
    {
      expected: true,
      label: "public IPv4 and IPv6",
      addresses: [
        "8.8.8.8",
        "93.184.216.34",
        "2606:4700:4700::1111",
        "2606:4700:4700:0000:0000:0000:0000:1111",
        "2606:4700:4700:0:0:0:0:ABCD",
        "[2001:4860:4860::8888]",
        "2a00:1450:4001:81b::200e",
      ],
    },
    {
      expected: true,
      label: "IPv4-mapped public",
      addresses: [
        "::ffff:8.8.8.8",
        "::ffff:808:808",
        "0:0:0:0:0:ffff:808:808",
        "0000:0000:0000:0000:0000:FFFF:0808:0808",
        "[::ffff:93.184.216.34]",
        "::ffff:5db8:d822",
      ],
    },
  ];

  for (const { addresses, expected, label } of matrix) {
    for (const address of addresses) {
      assert.equal(isGlobalUnicastAddress(address), expected, label + ": " + address);
    }
  }
});

test("endpoint validation rejects credentials, fragments, controls, and unsupported schemes", () => {
  assert.throws(() => validateEndpoint("https://user:pass@example.com/a"), /credentials/);
  assert.throws(() => validateEndpoint("https://example.com/a#fragment"), /fragment/);
  assert.throws(() => validateEndpoint("file:///etc/passwd"), /scheme/);
  assert.throws(() => validateEndpoint(" https://example.com/a"), /invalid/);
});

test("resolution rejects any mixed private answer and pins every accepted answer", async () => {
  await assert.rejects(
    resolveAndPin("https://provider.example/manifest.json", {
      resolver: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    }),
    (error) => error.code === "upstream_address_blocked"
  );

  const pinned = await resolveAndPin("https://provider.example/manifest.json", {
    resolver: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ],
  });
  assert.equal(pinned.addresses.length, 2);
  const selected = await new Promise((resolve, reject) =>
    pinned.lookup("provider.example", { family: 4 }, (error, address, family) =>
      error ? reject(error) : resolve({ address, family })
    )
  );
  assert.deepEqual(selected, { address: "93.184.216.34", family: 4 });
  await assert.rejects(
    new Promise((resolve, reject) =>
      pinned.lookup("attacker.example", {}, (error) => (error ? reject(error) : resolve()))
    ),
    (error) => error.code === "upstream_pin_mismatch"
  );
});

test("resolution rejects non-canonical IPv6 spellings of embedded non-global addresses", async () => {
  for (const address of [
    "0:0:0:0:0:ffff:7f00:1",
    "0000:0000:0000:0000:0000:0000:7f00:0001",
    "0:0:0:0:ffff:0:7f00:1",
  ]) {
    await assert.rejects(
      resolveAndPin("https://provider.example/manifest.json", {
        resolver: async () => [{ address, family: 6 }],
      }),
      (error) => error.code === "upstream_address_blocked",
      address
    );
  }
});

test("resolution rejects reserved global-unicast space before creating a pinned lookup", async () => {
  for (const address of ["2d00::1", "2e00::1", "3000::1", "3ffd::1", "3fff:1000::1"]) {
    await assert.rejects(
      resolveAndPin("https://provider.example/manifest.json", {
        resolver: async () => [{ address, family: 6 }],
      }),
      (error) => error.code === "upstream_address_blocked",
      address
    );
  }

  const pinned = await resolveAndPin("https://provider.example/manifest.json", {
    resolver: async () => [{ address: "2606:4700:4700::1111", family: 6 }],
  });
  const selected = await new Promise((resolve, reject) =>
    pinned.lookup("provider.example", { family: 6 }, (error, address, family) =>
      error ? reject(error) : resolve({ address, family })
    )
  );
  assert.deepEqual(selected, { address: "2606:4700:4700::1111", family: 6 });
});

test("fetch preserves the exact URL and uses the pinned lookup", async () => {
  const observed = [];
  const policy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async (url, options) => {
      observed.push(url);
      const lookup = options.agent.options.lookup;
      const pinned = await new Promise((resolve, reject) =>
        lookup("provider.example", { family: 4 }, (error, address) =>
          error ? reject(error) : resolve(address)
        )
      );
      assert.equal(pinned, "93.184.216.34");
      assert.equal(options.headers.Accept, "application/json");
      assert.equal(Object.hasOwn(options.headers, "Cookie"), false);
      return response(200, { streams: [{ url: "https://cdn.example/a" }] });
    },
  });
  const exact = "https://provider.example/stream/movie/id.json?token=a%2Bb&x=1";
  const result = await policy.fetchJson(exact);
  assert.deepEqual(observed, [exact]);
  assert.deepEqual(result.value.streams[0], { url: "https://cdn.example/a" });
});

test("redirects are re-resolved and downgrade, credentials, loops, and excess are blocked", async () => {
  const resolutions = [];
  const resolver = async (hostname) => {
    resolutions.push(hostname);
    return publicResolver();
  };
  const success = new UpstreamFetchPolicy({
    resolver,
    fetch: async (url) =>
      url.includes("first.example")
        ? response(302, null, { location: "https://second.example/result?token=a%2Bb" })
        : response(200, { ok: true }),
  });
  assert.deepEqual((await success.fetchJson("https://first.example/start")).value, { ok: true });
  assert.deepEqual(resolutions, ["first.example", "second.example"]);

  const downgrade = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () => response(302, null, { location: "http://second.example/result" }),
  });
  await assert.rejects(
    downgrade.fetchJson("https://first.example/start"),
    (error) => error.code === "upstream_redirect_downgrade"
  );

  const credentials = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () => response(302, null, { location: "https://user:pass@second.example/result" }),
  });
  await assert.rejects(
    credentials.fetchJson("https://first.example/start"),
    (error) => error.code === "upstream_credentials_blocked"
  );

  const loop = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () => response(302, null, { location: "https://first.example/start" }),
  });
  await assert.rejects(
    loop.fetchJson("https://first.example/start"),
    (error) => error.code === "upstream_redirect_loop"
  );

  let redirectSequence = 0;
  const excess = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxRedirects: 1,
    fetch: async () => response(302, null, { location: "https://next.example/" + ++redirectSequence }),
  });
  await assert.rejects(
    excess.fetchJson("https://first.example/start"),
    (error) => error.code === "upstream_redirect_limit"
  );

  let reservedCalls = 0;
  const reserved = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () => {
      reservedCalls += 1;
      return response(302, null, { location: "https://[2d00::1]/result" });
    },
  });
  await assert.rejects(
    reserved.fetchJson("https://first.example/start"),
    (error) => error.code === "upstream_address_blocked"
  );
  assert.equal(reservedCalls, 1, "reserved redirect targets must fail before a second fetch");
});

test("decoded bodies, malformed JSON, HTTP status, and total time are bounded", async () => {
  const oversizedBody = bodyFrom(["12345", "67890"]);
  const oversized = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxDecodedBytes: 8,
    fetch: async () => ({
      status: 200,
      body: oversizedBody,
      headers: { get: () => null },
    }),
  });
  await assert.rejects(
    oversized.fetchJson("https://provider.example/data"),
    (error) => error.code === "upstream_body_too_large"
  );
  assert.equal(oversizedBody.destroyed, true);

  const malformed = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () => response(200, "{"),
  });
  await assert.rejects(
    malformed.fetchJson("https://provider.example/data"),
    (error) => error.code === "upstream_json_invalid"
  );

  const badStatus = new UpstreamFetchPolicy({
    resolver: publicResolver,
    fetch: async () => response(503, { error: "secret details" }),
  });
  await assert.rejects(
    badStatus.fetchJson("https://provider.example/data"),
    (error) => error.code === "upstream_http_status" && !error.message.includes("secret")
  );

  const hanging = new UpstreamFetchPolicy({
    resolver: publicResolver,
    totalTimeoutMs: 10,
    fetch: async () => new Promise(() => {}),
  });
  await assert.rejects(
    hanging.fetchJson("https://provider.example/data"),
    (error) => error.code === "upstream_timeout"
  );
  assert.equal(hanging._semaphore._active, 0);
  assert.equal(hanging._semaphore._groupsByKey.size, 0);
});

test("per-key admission defaults reserve capacity and reject unsafe limits", () => {
  assert.ok(DEFAULT_POLICY.maxConcurrentPerKey < DEFAULT_POLICY.maxConcurrent);
  assert.ok(DEFAULT_POLICY.maxQueuedPerKey < DEFAULT_POLICY.maxQueued);

  const policy = new UpstreamFetchPolicy({ resolver: publicResolver });
  assert.equal(policy._semaphore._maxConcurrentPerKey, DEFAULT_POLICY.maxConcurrentPerKey);
  assert.equal(policy._semaphore._maxQueuedPerKey, DEFAULT_POLICY.maxQueuedPerKey);

  for (const options of [
    { maxConcurrent: 2, maxConcurrentPerKey: 2 },
    { maxConcurrentPerKey: 0 },
    { maxConcurrentPerKey: 1025 },
    { maxQueued: 2, maxQueuedPerKey: 2 },
    { maxQueuedPerKey: 0 },
    { maxQueuedPerKey: 100001 },
  ]) {
    assert.throws(() => new UpstreamFetchPolicy(options), TypeError);
  }
});

test("concurrency and queue capacity are bounded", async () => {
  const releases = [];
  const policy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxConcurrent: 1,
    maxQueued: 1,
    totalTimeoutMs: 1000,
    fetch: async () =>
      new Promise((resolve) => {
        releases.push(() => resolve(response(200, { ok: true })));
      }),
  });
  const first = policy.fetchJson("https://one.example/data");
  const second = policy.fetchJson("https://two.example/data");
  await assert.rejects(
    policy.fetchJson("https://three.example/data"),
    (error) => error.code === "upstream_queue_full"
  );
  while (releases.length < 1) await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  assert.deepEqual((await first).value, { ok: true });
  while (releases.length < 1) await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  assert.deepEqual((await second).value, { ok: true });
});

test("admission timeout stays distinct while total timeout includes admission", async () => {
  let fetchCalls = 0;
  const timeoutPolicy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxConcurrent: 1,
    maxQueued: 1,
    admissionTimeoutMs: 10,
    totalTimeoutMs: 100,
    fetch: async () => {
      fetchCalls += 1;
      return response(200, { ok: true });
    },
  });
  const releaseTimeoutSlot = await timeoutPolicy._semaphore.acquire(undefined, "blocker");
  await assert.rejects(
    timeoutPolicy.fetchJson("https://queued.example/data", { admissionKey: "profile-b" }),
    (error) => error.code === "upstream_admission_timeout"
  );
  assert.equal(fetchCalls, 0, "admission failure must not execute the provider");
  releaseTimeoutSlot();

  let deadlineFetchCalls = 0;
  const deadlinePolicy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxConcurrent: 1,
    maxQueued: 1,
    admissionTimeoutMs: 100,
    totalTimeoutMs: 10,
    fetch: async () => {
      deadlineFetchCalls += 1;
      return response(200, { ok: true });
    },
  });
  const releaseDeadlineSlot = await deadlinePolicy._semaphore.acquire(undefined, "profile-a");
  const totalTimedOut = assert.rejects(
    deadlinePolicy.fetchJson("https://fast.example/data", { admissionKey: "profile-b" }),
    (error) => error.code === "upstream_admission_timeout"
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseDeadlineSlot();
  await totalTimedOut;
  assert.equal(deadlineFetchCalls, 0, "the total deadline must expire while waiting for admission");
  assert.equal(deadlinePolicy._semaphore._active, 0);
  assert.equal(deadlinePolicy._semaphore._queued, 0);
  assert.equal(deadlinePolicy._semaphore._groupsByKey.size, 0);
});

test("an abusive key cannot consume reserved active or queue capacity", async () => {
  const starts = [];
  const executions = new Map();
  const policy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxConcurrent: 3,
    maxConcurrentPerKey: 2,
    maxQueued: 4,
    maxQueuedPerKey: 2,
    admissionTimeoutMs: 1000,
    totalTimeoutMs: 1000,
    fetch: async (url) => {
      const hostname = new URL(url).hostname;
      starts.push(hostname);
      const execution = deferred();
      executions.set(hostname, execution);
      return execution.promise;
    },
  });
  const finish = (hostname) => {
    executions.get(hostname).resolve(response(200, { hostname }));
  };

  const firstA = policy.fetchJson("https://a1.example/data", { admissionKey: "profile-a" });
  const secondA = policy.fetchJson("https://a2.example/data", { admissionKey: "profile-a" });
  await waitFor(() => starts.length === 2, "the abusive profile did not fill its active quota");

  const queuedController = new AbortController();
  const thirdA = policy.fetchJson("https://a3.example/data", {
    admissionKey: "profile-a",
    signal: queuedController.signal,
  });
  const fourthA = policy.fetchJson("https://a4.example/data", { admissionKey: "profile-a" });
  await waitFor(() => policy._semaphore._queued === 2, "the abusive profile queue did not fill");
  await assert.rejects(
    policy.fetchJson("https://a5.example/data", { admissionKey: "profile-a" }),
    (error) => error.code === "upstream_queue_full"
  );

  const firstB = policy.fetchJson("https://b1.example/data", { admissionKey: "profile-b" });
  await waitFor(() => starts.length === 3, "reserved active capacity did not admit a late profile");
  assert.equal(starts[2], "b1.example");
  const secondB = policy.fetchJson("https://b2.example/data", { admissionKey: "profile-b" });
  await waitFor(() => policy._semaphore._queued === 3, "late profile work did not queue");

  const canceled = assert.rejects(thirdA, (error) => error.code === "upstream_aborted");
  queuedController.abort();
  await canceled;
  assert.equal(policy._semaphore._queued, 2);

  finish("a1.example");
  await firstA;
  await waitFor(() => starts.includes("a4.example"), "remaining profile-a work did not drain");
  finish("a2.example");
  await secondA;
  await waitFor(() => starts.includes("b2.example"), "round-robin queue did not admit profile-b");

  finish("a4.example");
  finish("b1.example");
  finish("b2.example");
  await Promise.all([fourthA, firstB, secondB]);

  assert.deepEqual(starts, [
    "a1.example",
    "a2.example",
    "b1.example",
    "a4.example",
    "b2.example",
  ]);
  assert.equal(policy._semaphore._active, 0);
  assert.equal(policy._semaphore._queued, 0);
  assert.equal(policy._semaphore._queueGroups.length, 0);
  assert.equal(policy._semaphore._groupsByKey.size, 0);

  const afterDrain = policy.fetchJson("https://after.example/data", {
    admissionKey: "profile-after",
  });
  await waitFor(() => starts.includes("after.example"), "a permit leaked after the queue drained");
  finish("after.example");
  assert.deepEqual((await afterDrain).value, { hostname: "after.example" });
  assert.equal(policy._semaphore._active, 0);
  assert.equal(policy._semaphore._groupsByKey.size, 0);
});

test("a queued-only key remains active-quota tracked after admission", async () => {
  const policy = new UpstreamFetchPolicy({
    maxConcurrent: 2,
    maxConcurrentPerKey: 1,
    maxQueued: 2,
    maxQueuedPerKey: 1,
  });
  const semaphore = policy._semaphore;
  const releaseA = await semaphore.acquire(undefined, "profile-a");
  const releaseC = await semaphore.acquire(undefined, "profile-c");
  const firstB = semaphore.acquire(undefined, "profile-b");
  assert.equal(semaphore._queued, 1);

  releaseA();
  const releaseFirstB = await firstB;
  releaseC();
  assert.equal(semaphore._active, 1);

  const secondB = semaphore.acquire(undefined, "profile-b");
  assert.equal(semaphore._active, 1, "same-key work bypassed the active quota");
  assert.equal(semaphore._queued, 1);
  releaseFirstB();
  const releaseSecondB = await secondB;
  releaseSecondB();

  assert.equal(semaphore._active, 0);
  assert.equal(semaphore._queued, 0);
  assert.equal(semaphore._queueGroups.length, 0);
  assert.equal(semaphore._groupsByKey.size, 0);
});

test("profile-keyed admission rotates queued profiles without unbounded state", async () => {
  const starts = [];
  const executions = [];
  const policy = new UpstreamFetchPolicy({
    resolver: publicResolver,
    maxConcurrent: 1,
    maxQueued: 4,
    admissionTimeoutMs: 1000,
    totalTimeoutMs: 1000,
    fetch: async (url) => {
      starts.push(new URL(url).hostname);
      const execution = deferred();
      executions.push(execution);
      return execution.promise;
    },
  });

  const firstA = policy.fetchJson("https://a1.example/data", { admissionKey: "profile-a" });
  await waitFor(() => starts.length === 1, "first profile did not start");
  const secondA = policy.fetchJson("https://a2.example/data", { admissionKey: "profile-a" });
  const thirdA = policy.fetchJson("https://a3.example/data", { admissionKey: "profile-a" });
  const firstB = policy.fetchJson("https://b1.example/data", { admissionKey: "profile-b" });

  executions[0].resolve(response(200, { id: "a1" }));
  await firstA;
  await waitFor(() => starts.length === 2, "second admission did not start");
  assert.equal(starts[1], "a2.example");
  executions[1].resolve(response(200, { id: "a2" }));
  await secondA;
  await waitFor(() => starts.length === 3, "other profile did not rotate in");
  assert.equal(starts[2], "b1.example");
  executions[2].resolve(response(200, { id: "b1" }));
  await firstB;
  await waitFor(() => starts.length === 4, "remaining profile work did not resume");
  assert.equal(starts[3], "a3.example");
  executions[3].resolve(response(200, { id: "a3" }));
  await thirdA;
  assert.equal(policy._semaphore._queued, 0);
  assert.equal(policy._semaphore._queueGroups.length, 0);
  assert.equal(policy._semaphore._groupsByKey.size, 0);
});
