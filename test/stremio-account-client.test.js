"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const {
  ACCOUNT_ORIGIN,
  LINK_ORIGIN,
  StremioAccountError,
  createStremioAccountClient,
} = require("../public/stremio-account-client");

const BASE_REQUEST_OPTIONS = Object.freeze({
  cache: "no-store",
  credentials: "omit",
  mode: "cors",
  redirect: "error",
  referrerPolicy: "no-referrer",
});

function response(body, options = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const result = {
    ok: options.ok !== false,
    status: options.status === undefined ? 200 : options.status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-length" && options.contentLength !== undefined) {
          return String(options.contentLength);
        }
        return null;
      },
    },
    async text() {
      return text;
    },
  };
  if (Object.prototype.hasOwnProperty.call(options, "body")) result.body = options.body;
  return result;
}

function linkResult() {
  return {
    result: {
      code: "ABCD",
      link: LINK_ORIGIN + "/?code=ABCD",
      qrcode: LINK_ORIGIN + "/qr/ABCD",
    },
  };
}

function validDescriptor(overrides = {}) {
  return {
    manifest: {
      id: "provider.example",
      version: "1.2.3",
      name: "Provider Example",
      types: ["movie"],
      resources: ["stream", { name: "subtitles", types: ["movie"], idPrefixes: ["tt"] }],
      futureManifestField: { retained: true },
    },
    transportUrl: "https://provider.example/manifest.json",
    flags: { official: false, protected: false },
    futureDescriptorField: ["retained"],
    ...overrides,
  };
}

function exactFetch(steps) {
  let index = 0;
  const calls = [];
  const fetchImpl = async (url, options) => {
    const step = steps[index];
    index += 1;
    assert.ok(step, "unexpected fetch call " + index + " to " + url);
    assert.equal(url, step.url, "fetch call " + index + " URL");

    const actualOptions = { ...options };
    const actualSignal = actualOptions.signal;
    delete actualOptions.signal;
    if (step.signal === "internal") {
      assert.ok(actualSignal, "fetch call " + index + " must include an internal signal");
      assert.equal(typeof actualSignal.addEventListener, "function");
    } else if (step.signal) {
      assert.strictEqual(actualSignal, step.signal, "fetch call " + index + " signal");
    } else {
      assert.equal(actualSignal, undefined, "fetch call " + index + " must not include a signal");
    }
    assert.deepEqual(actualOptions, { ...BASE_REQUEST_OPTIONS, ...step.options }, "fetch call " + index + " options");
    calls.push({ url, options: actualOptions });

    if (step.handle) return await step.handle({ options, signal: actualSignal, url });
    return response(step.reply, step.responseOptions);
  };
  fetchImpl.assertDone = () => assert.equal(index, steps.length, "all scripted fetch calls must run");
  fetchImpl.calls = calls;
  return fetchImpl;
}

function postOptions(body) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  };
}

function rejectsWithCode(code) {
  return (error) => error instanceof StremioAccountError && error.code === code;
}

function abortFailure() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortFailure());
      return;
    }
    signal.addEventListener("abort", () => reject(abortFailure()), { once: true });
  });
}

test("device link performs one read and keeps the auth key local", async () => {
  const addons = [validDescriptor()];
  const fetch = exactFetch([
    {
      url: LINK_ORIGIN + "/api/v2/create?type=Create",
      signal: "internal",
      options: { method: "GET" },
      reply: linkResult(),
    },
    {
      url: LINK_ORIGIN + "/api/v2/read?type=Read&code=ABCD",
      signal: "internal",
      options: { method: "GET" },
      reply: { error: { code: 101, message: "Pending" } },
    },
    {
      url: LINK_ORIGIN + "/api/v2/read?type=Read&code=ABCD",
      signal: "internal",
      options: { method: "GET" },
      reply: { result: { authKey: "account-secret" } },
    },
    {
      url: ACCOUNT_ORIGIN + "/api/addonCollectionGet",
      signal: "internal",
      options: postOptions(
        JSON.stringify({ type: "AddonCollectionGet", authKey: "account-secret", update: true })
      ),
      reply: {
        result: {
          addons,
          lastModified: "2026-07-12T10:00:00Z",
          authKey: "must-not-escape",
        },
      },
    },
  ]);
  let now = 1000;
  const accountClient = createStremioAccountClient({
    fetch,
    clock: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  });

  const session = await accountClient.createLinkSession();
  assert.deepEqual(Object.keys(session).sort(), ["code", "expiresAt", "link", "qrcode", "readAddonCollection"]);
  assert.equal(Object.hasOwn(session, "authKey"), false);
  assert.equal(session.setAddonCollection, undefined);

  const collection = await session.readAddonCollection();
  assert.deepEqual(collection, { addons, lastModified: "2026-07-12T10:00:00Z" });
  assert.equal(Object.hasOwn(collection, "authKey"), false);
  assert.deepEqual(collection.addons[0].futureDescriptorField, ["retained"]);
  assert.deepEqual(collection.addons[0].manifest.futureManifestField, { retained: true });
  await assert.rejects(() => session.readAddonCollection(), rejectsWithCode("session_consumed"));

  const secretCalls = fetch.calls.filter((call) => JSON.stringify(call.options).includes("account-secret"));
  assert.equal(secretCalls.length, 1);
  assert.equal(secretCalls[0].url, ACCOUNT_ORIGIN + "/api/addonCollectionGet");
  assert.deepEqual(JSON.parse(secretCalls[0].options.body), {
    type: "AddonCollectionGet",
    authKey: "account-secret",
    update: true,
  });
  fetch.assertDone();
});

test("approval callback fires without secrets before the account collection request resolves", async () => {
  const events = [];
  let releaseAccountRequest;
  let accountRequestStartedResolve;
  const accountRequestStarted = new Promise((resolve) => {
    accountRequestStartedResolve = resolve;
  });
  const fetch = exactFetch([
    {
      url: LINK_ORIGIN + "/api/v2/create?type=Create",
      signal: "internal",
      options: { method: "GET" },
      reply: linkResult(),
    },
    {
      url: LINK_ORIGIN + "/api/v2/read?type=Read&code=ABCD",
      signal: "internal",
      options: { method: "GET" },
      reply: { result: { authKey: "transient-secret" } },
    },
    {
      url: ACCOUNT_ORIGIN + "/api/addonCollectionGet",
      signal: "internal",
      options: postOptions(
        JSON.stringify({ type: "AddonCollectionGet", authKey: "transient-secret", update: true })
      ),
      async handle() {
        events.push("account-request");
        accountRequestStartedResolve();
        return new Promise((resolve) => {
          releaseAccountRequest = () =>
            resolve(
              response({
                result: {
                  addons: [validDescriptor()],
                  lastModified: "2026-07-12T10:00:00Z",
                },
              })
            );
        });
      },
    },
  ]);
  const client = createStremioAccountClient({ fetch });
  const session = await client.createLinkSession();
  const read = session.readAddonCollection({
    onApproved(...args) {
      events.push("approved");
      assert.deepEqual(args, []);
    },
  });

  await accountRequestStarted;
  assert.deepEqual(events, ["approved", "account-request"]);
  releaseAccountRequest();
  const collection = await read;
  assert.equal(collection.addons.length, 1);
  fetch.assertDone();
});

test("production client has no collection-set, logout, persistence, or logging path", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "stremio-account-client.js"), "utf8");
  assert.doesNotMatch(source, /AddonCollectionSet|addonCollectionSet|setAddonCollection/i);
  assert.doesNotMatch(source, /\/api\/logout|type:\s*"Logout"/i);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|console\s*\./);
  assert.equal((source.match(/type:\s*"AddonCollectionGet"/g) || []).length, 1);
  assert.equal((source.match(/\/api\/addonCollectionGet/g) || []).length, 1);
});

test("default link deadline is four minutes and five minutes is rejected", async () => {
  const fetch = exactFetch([
    {
      url: LINK_ORIGIN + "/api/v2/create?type=Create",
      signal: "internal",
      options: { method: "GET" },
      reply: linkResult(),
    },
  ]);
  const accountClient = createStremioAccountClient({ fetch, clock: () => 5000 });
  const session = await accountClient.createLinkSession();
  assert.equal(session.expiresAt, 5000 + 4 * 60 * 1000);
  fetch.assertDone();

  let called = false;
  const rejectingClient = createStremioAccountClient({
    fetch: async () => {
      called = true;
      throw new Error("must not fetch");
    },
  });
  await assert.rejects(() => rejectingClient.createLinkSession({ expiresInMs: 5 * 60 * 1000 }), /invalid/);
  assert.equal(called, false);
});

test("pending approval polling stops at the conservative local deadline", async () => {
  let now = 0;
  let reads = 0;
  const sleeps = [];
  const fetch = async (url) => {
    if (url.includes("/create?")) return response(linkResult());
    reads += 1;
    return response({ error: { code: 101, message: "Pending" } });
  };
  const accountClient = createStremioAccountClient({
    fetch,
    clock: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  const session = await accountClient.createLinkSession({ expiresInMs: 60 * 1000, pollIntervalMs: 10 * 1000 });

  await assert.rejects(() => session.readAddonCollection(), rejectsWithCode("link_expired"));
  assert.equal(now, 60 * 1000);
  assert.equal(reads, 6);
  assert.deepEqual(sleeps, Array(6).fill(10 * 1000));
});

test("caller abort cancels a hanging link creation", async () => {
  const caller = new AbortController();
  const fetch = exactFetch([
    {
      url: LINK_ORIGIN + "/api/v2/create?type=Create",
      signal: "internal",
      options: { method: "GET" },
      async handle({ signal }) {
        setImmediate(() => caller.abort());
        return waitForAbort(signal);
      },
    },
  ]);
  const accountClient = createStremioAccountClient({ fetch });
  await assert.rejects(() => accountClient.createLinkSession({ signal: caller.signal }), rejectsWithCode("aborted"));
  fetch.assertDone();
});

test("caller abort cancels the sole collection read without retrying or mutating", async () => {
  const caller = new AbortController();
  const fetch = exactFetch([
    {
      url: LINK_ORIGIN + "/api/v2/create?type=Create",
      signal: "internal",
      options: { method: "GET" },
      reply: linkResult(),
    },
    {
      url: LINK_ORIGIN + "/api/v2/read?type=Read&code=ABCD",
      signal: "internal",
      options: { method: "GET" },
      reply: { result: { authKey: "account-secret" } },
    },
    {
      url: ACCOUNT_ORIGIN + "/api/addonCollectionGet",
      signal: "internal",
      options: postOptions(
        JSON.stringify({ type: "AddonCollectionGet", authKey: "account-secret", update: true })
      ),
      async handle({ signal }) {
        setImmediate(() => caller.abort());
        return waitForAbort(signal);
      },
    },
  ]);
  const accountClient = createStremioAccountClient({ fetch });
  const session = await accountClient.createLinkSession({ signal: caller.signal });
  await assert.rejects(() => session.readAddonCollection(), rejectsWithCode("aborted"));
  fetch.assertDone();
});

test("invalid collection data is rejected and never exposed", async (t) => {
  const cases = [
    { name: "missing timestamp", value: { addons: [validDescriptor()] } },
    { name: "missing addons", value: { lastModified: "2026-07-12T10:00:00Z" } },
    {
      name: "invalid descriptor",
      value: {
        addons: [{ manifest: null, transportUrl: "https://provider.example/manifest.json" }],
        lastModified: "2026-07-12T10:00:00Z",
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fetch = exactFetch([
        {
          url: LINK_ORIGIN + "/api/v2/create?type=Create",
          signal: "internal",
          options: { method: "GET" },
          reply: linkResult(),
        },
        {
          url: LINK_ORIGIN + "/api/v2/read?type=Read&code=ABCD",
          signal: "internal",
          options: { method: "GET" },
          reply: { result: { authKey: "account-secret" } },
        },
        {
          url: ACCOUNT_ORIGIN + "/api/addonCollectionGet",
          signal: "internal",
          options: postOptions(
            JSON.stringify({ type: "AddonCollectionGet", authKey: "account-secret", update: true })
          ),
          reply: { result: item.value },
        },
      ]);
      const session = await createStremioAccountClient({ fetch }).createLinkSession();
      await assert.rejects(() => session.readAddonCollection(), rejectsWithCode("invalid_collection"));
      fetch.assertDone();
    });
  }
});

test("invalid transient auth values are rejected before any account request", async () => {
  const fetch = exactFetch([
    {
      url: LINK_ORIGIN + "/api/v2/create?type=Create",
      signal: "internal",
      options: { method: "GET" },
      reply: linkResult(),
    },
    {
      url: LINK_ORIGIN + "/api/v2/read?type=Read&code=ABCD",
      signal: "internal",
      options: { method: "GET" },
      reply: { result: { authKey: " bad " } },
    },
  ]);
  const session = await createStremioAccountClient({ fetch }).createLinkSession();
  await assert.rejects(() => session.readAddonCollection(), /auth key is invalid/);
  fetch.assertDone();
});

test("declared oversized link responses are rejected", async () => {
  const fetch = exactFetch([
    {
      url: LINK_ORIGIN + "/api/v2/create?type=Create",
      signal: "internal",
      options: { method: "GET" },
      reply: linkResult(),
      responseOptions: { contentLength: 70 * 1024 },
    },
  ]);
  await assert.rejects(
    () => createStremioAccountClient({ fetch }).createLinkSession(),
    rejectsWithCode("response_too_large")
  );
  fetch.assertDone();
});

test("browser global loads without touching browser storage or console", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "stremio-account-client.js"), "utf8");
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error("forbidden global access");
      },
      set() {
        throw new Error("forbidden global write");
      },
    }
  );
  const context = {
    AbortController,
    ArrayBuffer,
    clearTimeout,
    console: forbidden,
    localStorage: forbidden,
    sessionStorage: forbidden,
    setTimeout,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    URL,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.equal(typeof context.JumpgateStremioAccount.createStremioAccountClient, "function");
  assert.equal(context.JumpgateStremioAccount.setAddonCollection, undefined);
});
