"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const client = require("../public/configure");

const publicPath = (name) => path.join(__dirname, "..", "public", name);

function descriptor(id, resources, transportUrl) {
  return {
    manifest: { id, name: id, version: "1.0.0", resources },
    transportUrl: transportUrl || `https://${id}.example/manifest.json`,
    flags: { official: false, protected: false },
  };
}

test("resource discovery keeps stream and subtitle descriptors and excludes Jumpgate", () => {
  const stream = descriptor("streamer", ["stream"]);
  const subtitles = descriptor("subber", [{ name: "subtitles", types: ["movie"] }]);
  const catalog = descriptor("catalog", ["catalog"]);
  const jumpgate = descriptor("com.jumpgate.bridge", ["stream", "subtitles"]);

  assert.deepEqual(
    client.resourceNames({
      manifest: {
        resources: ["stream", { name: "subtitles", types: ["movie"] }, { name: "stream" }, null],
      },
    }),
    ["stream", "subtitles"]
  );
  assert.deepEqual(client.gatewayCandidates([catalog, stream, jumpgate, subtitles]), [stream, subtitles]);
});

test("unsupported transport previews stay visible but cannot be selected", () => {
  const unsupported = descriptor(
    "unsupported",
    ["stream"],
    "https://provider.example/not-manifest"
  );

  assert.deepEqual(client.gatewayCandidates([unsupported]), [unsupported]);
  assert.deepEqual(
    client.defaultProviderSelection([
      { gatewayEligible: false, unsupportedTransport: true },
      { gatewayEligible: true, unsupportedTransport: false },
      { gatewayEligible: "true", unsupportedTransport: false },
    ]),
    [false, true, false]
  );
  assert.deepEqual(
    client.providerSelectionModel(
      [
        { gatewayEligible: false },
        { gatewayEligible: true },
        { gatewayEligible: true },
      ],
      [true, false, true]
    ),
    [
      { checked: false, enabled: false },
      { checked: false, enabled: true },
      { checked: true, enabled: true },
    ]
  );

  const configureSource = fs.readFileSync(publicPath("configure.js"), "utf8");
  assert.match(configureSource, /checkbox\.disabled = !selectionModel\[index\]\.enabled/);
  assert.match(configureSource, /if \(preview\.unsupportedTransport\) names\.push\("unsupported transport"\)/);
});

test("private install exposure requires the complete paired provider state", () => {
  const complete = {
    hasConfig: true,
    paired: true,
    providersReady: true,
    installUrl: "stremio://jumpgate.example/i/private/manifest.json",
  };
  assert.equal(client.canExposePrivateInstall(complete), true);
  for (const field of ["hasConfig", "paired", "providersReady", "installUrl"]) {
    assert.equal(client.canExposePrivateInstall({ ...complete, [field]: field === "installUrl" ? "" : false }), false);
  }
});

test("workspace footer reports the actual gated setup state", () => {
  assert.deepEqual(client.workspaceStatus({}), {
    state: "profile",
    label: "Profile required",
    text: "Generate a private playback profile to begin.",
  });
  assert.equal(client.workspaceStatus({ hasConfig: true }).state, "pair");
  assert.equal(client.workspaceStatus({ hasConfig: true, paired: true }).state, "providers");
  assert.equal(
    client.workspaceStatus({ hasConfig: true, paired: true, providersReady: true }).state,
    "ready"
  );
  assert.equal(
    client.workspaceStatus({
      hasConfig: true,
      paired: true,
      providersReady: true,
      installPromptOpened: true,
    }).state,
    "opened"
  );
});

test("manual parsing accepts descriptor shapes but rejects credentials", () => {
  const addon = descriptor("manual", ["stream"]);
  assert.deepEqual(client.parseManualCollection(JSON.stringify([addon])), [addon]);
  assert.deepEqual(client.parseManualCollection(JSON.stringify({ addons: [addon] })), [addon]);
  assert.throws(() => client.parseManualCollection("{"), /invalid/);
  assert.throws(
    () => client.parseManualCollection(JSON.stringify({ authKey: "secret", addons: [] })),
    /account key/
  );
  assert.throws(
    () => client.parseManualCollection(JSON.stringify({ auth_key: "secret", addons: [] })),
    /account key/
  );
});

test("operation mutex and one-shot settlement keep one explicit owner", async () => {
  const mutex = client.createOperationMutex();
  const stremio = mutex.acquire("stremio");
  assert.ok(stremio);
  assert.equal(mutex.acquire("manual"), null);

  const events = [];
  const result = new Promise((resolve, reject) => {
    const settlement = client.createOneShotSettlement(
      (value) => {
        events.push("resolve");
        resolve(value);
      },
      reject,
      () => events.push("settled")
    );
    assert.equal(settlement.resolve("confirmed"), true);
    assert.equal(settlement.reject(new Error("late cancel")), false);
  });
  assert.equal(await result, "confirmed");
  assert.deepEqual(events, ["settled", "resolve"]);
  assert.equal(stremio.release(), true);
  assert.ok(mutex.acquire("manual"));
});

test("chunked previews preserve order and cap the default selection", async () => {
  const descriptors = Array.from({ length: 130 }, (_, index) => descriptor(`provider-${index}`, ["stream"]));
  const batches = [];
  const previews = await client.previewDescriptorBatches(descriptors, async (batch, offset) => {
    batches.push({ length: batch.length, offset });
    return batch.map((item) => ({ manifestId: item.manifest.id, gatewayEligible: true }));
  });

  assert.deepEqual(batches, [
    { length: 64, offset: 0 },
    { length: 64, offset: 64 },
    { length: 2, offset: 128 },
  ]);
  assert.equal(previews[129].manifestId, "provider-129");
  assert.equal(client.defaultProviderSelection(previews).filter(Boolean).length, 64);
  assert.throws(() => client.validateProviderSelection(descriptors.slice(0, 65)), /at most 64/);
});

test("approval countdown is explicitly local to this page", () => {
  const now = Date.UTC(2026, 6, 12, 12, 0, 0);
  assert.equal(
    client.localApprovalDeadlineMessage(now + 4 * 60 * 1000, now),
    "This page's local approval deadline: 4:00 remaining."
  );
  assert.equal(
    client.localApprovalDeadlineMessage(now, now),
    "This page's local approval deadline passed. Start a new read."
  );
});

test("pairing retry state uses 32 Web Crypto bytes and is durable before fetch", async () => {
  const events = [];
  let stored = null;
  const storage = {
    getItem() {
      events.push("get");
      return stored;
    },
    setItem(_key, value) {
      events.push("set");
      stored = value;
    },
    removeItem() {
      stored = null;
    },
  };
  let entropyLength = 0;
  const cryptoApi = {
    getRandomValues(bytes) {
      events.push("random");
      entropyLength = bytes.length;
      bytes.fill(0xa5);
      return bytes;
    },
  };
  const encode = (binary) => Buffer.from(binary, "binary").toString("base64");
  const attempt = client.preparePairingActivation(
    storage,
    cryptoApi,
    encode,
    { userCode: "ABCDEFGH", config: "private-config" },
    1000
  );
  const response = await client.requestPairingActivation(
    async (_url, options) => {
      events.push("fetch");
      return { options };
    },
    attempt,
    false
  );

  assert.equal(entropyLength, 32);
  assert.match(attempt.retryToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), [
    "config",
    "retryToken",
    "submittedAt",
    "userCode",
    "v",
  ]);
  assert.ok(events.indexOf("set") < events.indexOf("fetch"));
  assert.ok(events.lastIndexOf("get") < events.indexOf("fetch"));
  assert.deepEqual(JSON.parse(response.options.body), {
    userCode: "ABCDEFGH",
    config: "private-config",
    activationRetryToken: attempt.retryToken,
  });
  assert.equal(stored.includes("management"), false);
});

test("pairing retries reuse one token and reload recovery omits the short code", async () => {
  let stored = null;
  const storage = {
    getItem() {
      return stored;
    },
    setItem(_key, value) {
      stored = value;
    },
    removeItem() {
      stored = null;
    },
  };
  let randomCalls = 0;
  const cryptoApi = {
    getRandomValues(bytes) {
      randomCalls += 1;
      bytes.fill(0x5c);
      return bytes;
    },
  };
  const encode = (binary) => Buffer.from(binary, "binary").toString("base64");
  const input = { userCode: "ABCDEFGH", config: "private-config" };
  const first = client.preparePairingActivation(storage, cryptoApi, encode, input, 1000);
  const uncertainRetry = client.preparePairingActivation(storage, cryptoApi, encode, input, 1001);
  const reloaded = client.readPairingRecovery(storage, 1002);
  const requests = [];
  await client.requestPairingActivation(
    async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return {};
    },
    reloaded,
    true
  );

  assert.equal(randomCalls, 1);
  assert.equal(uncertainRetry.retryToken, first.retryToken);
  assert.deepEqual(requests, [
    { config: "private-config", activationRetryToken: first.retryToken },
  ]);
  assert.equal(Object.hasOwn(requests[0], "userCode"), false);
});

test("pairing fails closed when entropy or session persistence is unavailable", () => {
  const encode = (binary) => Buffer.from(binary, "binary").toString("base64");
  const input = { userCode: "ABCDEFGH", config: "private-config" };
  assert.throws(
    () => client.preparePairingActivation({ getItem: () => null }, null, encode, input, 1000),
    /storage|randomness/i
  );
  assert.throws(
    () =>
      client.preparePairingActivation(
        {
          getItem: () => null,
          setItem() {
            throw new Error("quota");
          },
          removeItem() {},
        },
        { getRandomValues: (bytes) => bytes.fill(1) },
        encode,
        input,
        1000
      ),
    /cannot start.*storage/i
  );
});

test("Bridge import backs up the exact source before a revision-checked PUT", async () => {
  const sourceCollection = {
    addons: [descriptor("source", ["stream"])],
    lastModified: "2026-07-12T10:00:00Z",
  };
  const selected = [descriptor("selected", ["subtitles"])];
  const calls = [];

  const result = await client.runBridgeProviderImport({
    sourceCollection,
    descriptors: selected,
    async getCurrentProviders() {
      calls.push(["get"]);
      return { revision: 7, providers: [] };
    },
    async createBackup(collection) {
      calls.push(["backup", collection]);
      return { id: "backup_safe_1" };
    },
    async putProviders(descriptors, revision) {
      calls.push(["put", descriptors, revision]);
      return { count: descriptors.length, revision: revision + 1 };
    },
  });

  assert.deepEqual(calls, [
    ["get"],
    ["backup", sourceCollection.addons],
    ["put", selected, 7],
  ]);
  assert.deepEqual(result, {
    backup: { id: "backup_safe_1" },
    imported: { count: 1, revision: 8 },
  });
});

test("Bridge backup failure prevents provider PUT and requires no account recovery", async () => {
  let putCalls = 0;
  await assert.rejects(
    () =>
      client.runBridgeProviderImport({
        sourceCollection: { addons: [descriptor("source", ["stream"])] },
        descriptors: [descriptor("selected", ["stream"])],
        getCurrentProviders: async () => ({ revision: 3 }),
        createBackup: async () => ({}),
        putProviders: async () => {
          putCalls += 1;
        },
      }),
    (error) => error && error.code === "backup_failed"
  );
  assert.equal(putCalls, 0);
});

test("Bridge PUT failure stops after the backup without any recovery write", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      client.runBridgeProviderImport({
        sourceCollection: { addons: [descriptor("source", ["stream"])] },
        descriptors: [descriptor("selected", ["stream"])],
        async getCurrentProviders() {
          calls.push("get");
          return { revision: 4 };
        },
        async createBackup() {
          calls.push("backup");
          return { id: "backup_safe_2" };
        },
        async putProviders() {
          calls.push("put");
          throw new Error("revision conflict");
        },
      }),
    /revision conflict/
  );
  assert.deepEqual(calls, ["get", "backup", "put"]);
});

test("provider setup unlocks install only after a confirmed usable import", async () => {
  const initial = { providersReady: false, installPromptOpened: true, retained: "yes" };
  const options = {
    sourceCollection: { addons: [descriptor("source", ["stream"])] },
    descriptors: [descriptor("selected", ["stream"])],
    getCurrentProviders: async () => ({ revision: 2 }),
    createBackup: async () => ({ id: "backup-safe" }),
    putProviders: async () => ({ count: 1, revision: 3 }),
  };
  const completed = await client.runProviderSetupTransition(initial, options);
  assert.deepEqual(completed.state, {
    providersReady: true,
    installPromptOpened: false,
    retained: "yes",
  });
  assert.deepEqual(initial, {
    providersReady: false,
    installPromptOpened: true,
    retained: "yes",
  });

  await assert.rejects(
    client.runProviderSetupTransition(initial, {
      ...options,
      putProviders: async () => {
        throw new Error("import failed");
      },
    }),
    /import failed/
  );
  assert.equal(initial.providersReady, false);
  await assert.rejects(
    client.runProviderSetupTransition(initial, {
      ...options,
      putProviders: async () => ({ count: 0, revision: 3 }),
    }),
    /did not confirm a usable provider import/
  );
  assert.equal(initial.providersReady, false);
});

test("paired-profile lifecycle client uses fixed methods, CSRF, and same-origin session requests", async () => {
  const calls = [];
  const responses = new Map([
    ["GET /api/profile/devices", { status: 200, body: { ok: true, devices: [], traktLinked: false } }],
    ["DELETE /api/profile/devices/device_safe_1", { status: 200, body: { ok: true } }],
    ["DELETE /api/profile/history", { status: 200, body: { ok: true } }],
    ["DELETE /api/profile/trakt", { status: 200, body: { ok: true } }],
    ["POST /api/profile/trakt/connect", { status: 200, body: { ok: true, url: "/api/profile/trakt/connect/continue" } }],
    ["DELETE /api/profile", { status: 202, body: { ok: true, status: "pending" } }],
  ]);
  const api = client.createProfileManagementApi({
    csrf: "csrf_private_value",
    origin: "https://bridge.example",
    async fetch(url, options) {
      calls.push({ url, options });
      const fixture = responses.get(`${options.method} ${url}`);
      assert.ok(fixture, `unexpected request ${options.method} ${url}`);
      return {
        ok: fixture.status >= 200 && fixture.status < 300,
        status: fixture.status,
        async json() {
          return fixture.body;
        },
      };
    },
  });

  await api.getDevices();
  await api.revokeDevice("device_safe_1");
  await api.clearHistory();
  await api.disconnectTrakt();
  assert.equal(
    await api.connectTrakt(),
    "https://bridge.example/api/profile/trakt/connect/continue"
  );
  await api.deleteProfile();

  assert.deepEqual(
    calls.map((call) => [call.options.method, call.url]),
    [
      ["GET", "/api/profile/devices"],
      ["DELETE", "/api/profile/devices/device_safe_1"],
      ["DELETE", "/api/profile/history"],
      ["DELETE", "/api/profile/trakt"],
      ["POST", "/api/profile/trakt/connect"],
      ["DELETE", "/api/profile"],
    ]
  );
  for (const call of calls) {
    assert.equal(call.options.headers.get("X-Jumpgate-CSRF"), "csrf_private_value");
    assert.equal(call.options.credentials, "same-origin");
    assert.equal(call.options.cache, "no-store");
  }
});

test("paired-device parsing exposes display metadata only and trusts only explicit current markers", () => {
  const parsed = client.parseManagedDevicesResponse({
    ok: true,
    traktLinked: true,
    devices: [
      {
        deviceId: "device_safe_2",
        displayName: "Living\u0000 Room TV",
        current: true,
        lastSeenAt: "2026-07-15T10:00:00.000Z",
        bearerToken: "must-not-render",
        capability: "must-not-render-either",
      },
      {
        id: "device_safe_3",
        displayName: "Bedroom",
        currentDevice: true,
        lastSeenAt: null,
      },
    ],
  });

  assert.deepEqual(parsed, {
    devices: [
      {
        id: "device_safe_2",
        displayName: "Living Room TV",
        current: true,
        lastSeenAt: "2026-07-15T10:00:00.000Z",
      },
      {
        id: "device_safe_3",
        displayName: "Bedroom",
        current: false,
        lastSeenAt: null,
      },
    ],
    traktLinked: true,
  });
  assert.equal(Object.hasOwn(parsed.devices[0], "bearerToken"), false);
  assert.equal(Object.hasOwn(parsed.devices[0], "capability"), false);
  assert.throws(
    () =>
      client.parseManagedDevicesResponse({
        ok: true,
        devices: [{ deviceId: "bad/id", displayName: "Invalid" }],
      }),
    /invalid paired device/
  );
  assert.throws(
    () =>
      client.parseManagedDevicesResponse({
        ok: true,
        devices: [{ deviceId: "device_safe_4", displayName: "TV", current: "true" }],
      }),
    /invalid current-device marker/
  );
});

test("management errors are sanitized and Trakt redirects fail closed across origins", async () => {
  assert.equal(
    client.safeSameOriginRedirect("/continue", "https://bridge.example"),
    "https://bridge.example/continue"
  );
  assert.throws(
    () => client.safeSameOriginRedirect("https://attacker.example/steal", "https://bridge.example"),
    /unsafe Trakt connection route/
  );

  const api = client.createProfileManagementApi({
    csrf: "csrf_value",
    origin: "https://bridge.example",
    async fetch() {
      return {
        ok: false,
        status: 500,
        async json() {
          return { ok: false, error: "device_private_identifier_and_stack_trace" };
        },
      };
    },
  });
  await assert.rejects(
    () => api.clearHistory(),
    (error) =>
      error.message === "Jumpgate could not complete this profile action." &&
      !error.message.includes("device_private_identifier")
  );

  const synchronousDelete = client.createProfileManagementApi({
    csrf: "csrf_value",
    origin: "https://bridge.example",
    async fetch() {
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true };
        },
      };
    },
  });
  await assert.rejects(
    () => synchronousDelete.deleteProfile(),
    /Jumpgate could not complete this profile action/
  );
});

test("profile management UI requires confirmations, disables pending actions, and clears private state", () => {
  const html = fs.readFileSync(publicPath("configure.html"), "utf8");
  const configureSource = fs.readFileSync(publicPath("configure.js"), "utf8");

  assert.match(html, /id="profileManagement"[^>]*hidden[^>]*aria-busy="false"/);
  assert.doesNotMatch(html, /<input[^>]+(?:profileId|profile_id)/i);
  assert.match(html, /revokes its Bridge bearer credential/i);
  assert.match(html, /does not revoke already-issued links or tokens/i);
  assert.match(html, /clearing history removes current Bridge history/i);
  assert.match(html, /future playback creates new entries/i);
  assert.match(html, /disconnecting Trakt does not delete history already stored by Trakt/i);
  assert.match(html, /Profile deletion is destructive and may finish asynchronously/i);
  assert.match(html, /id="deleteProfileDialog"[^>]*aria-labelledby="deleteDialogHeading"/);
  assert.match(html, /Type <strong>DELETE PROFILE<\/strong> to confirm/);
  assert.match(html, /id="confirmDeleteProfileBtn"[^>]*disabled/);
  assert.match(configureSource, /browser\.confirm\([\s\S]*?Bridge bearer credential/);
  assert.match(configureSource, /browser\.confirm\([\s\S]*?Future playback creates new entries/);
  assert.match(configureSource, /browser\.confirm\([\s\S]*?does not delete history already stored by Trakt/);
  assert.match(configureSource, /profileManagementBusy \|\| byId\("deleteProfileConfirmation"\)\.value !== PROFILE_DELETE_CONFIRMATION/);
  assert.match(configureSource, /button\.disabled = profileManagementBusy \|\| !profileManagementApi/);
  assert.match(configureSource, /setAttribute\("aria-busy", profileManagementBusy \? "true" : "false"\)/);
  assert.match(configureSource, /privateBridgeBaseUrl = "";[\s\S]*?privateInstallUrl = "";[\s\S]*?privateManifestUrl = "";/);
  assert.match(configureSource, /managementCsrf = "";[\s\S]*?profileManagementApi = null/);
  assert.match(configureSource, /bootstrap = \{\};[\s\S]*?bootstrapElement\.textContent = "\{\}"/);
  assert.match(configureSource, /byId\("skipTraktAcknowledge"\)\.checked = false/);
  assert.match(configureSource, /setHidden\(byId\("result"\), true\)/);
  assert.match(configureSource, /refreshSteps\(\);[\s\S]*?byId\("name"\)\.focus\(\)/);
  assert.doesNotMatch(configureSource, /console\s*\./);
});

test("owned production sources contain no Stremio mutation or rollback path", () => {
  const configureSource = fs.readFileSync(publicPath("configure.js"), "utf8");
  const accountSource = fs.readFileSync(publicPath("stremio-account-client.js"), "utf8");
  const productionSource = configureSource + "\n" + accountSource;

  assert.doesNotMatch(productionSource, /AddonCollectionSet|addonCollectionSet|setAddonCollection/i);
  assert.doesNotMatch(configureSource, /rollback|automatic recovery|markBackupRestored/i);
  assert.doesNotMatch(accountSource, /localStorage|sessionStorage|indexedDB|console\s*\./);
  assert.doesNotMatch(configureSource, /\.authKey|authKey\s*[:=]/);
  assert.equal((accountSource.match(/type:\s*"AddonCollectionGet"/g) || []).length, 1);
  assert.equal((accountSource.match(/\/api\/addonCollectionGet/g) || []).length, 1);
  assert.match(configureSource, /const collection = await session\.readAddonCollection\(\{/);
  assert.match(configureSource, /onApproved\(\) \{\s*clearApprovalMaterial\(operation\)/);
  assert.match(configureSource, /const completed = await persistSelection\(decision, operation\)/);
  assert.match(configureSource, /installConfigured\(\)/);
  assert.match(configureSource, /Provider import failed\. Your Stremio account was not changed\./);
});

test("safe-flow UI is pair-gated, accessible, read-only, and profile-specific", () => {
  const html = fs.readFileSync(publicPath("configure.html"), "utf8");
  const css = fs.readFileSync(publicPath("configure.css"), "utf8");
  const configureSource = fs.readFileSync(publicPath("configure.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

  assert.doesNotMatch(html, /installViaAccount|auto.?install|logged out|logout|fallback|ten minutes/i);
  assert.match(html, /profile active during approval/i);
  assert.match(html, /keep that same profile active/i);
  assert.match(html, /private, profile-specific/i);
  assert.match(html, /do not share them or apply them across profiles/i);
  assert.match(html, /id="connectStremioBtn"[^>]*disabled/);
  assert.match(html, /id="previewManualBtn"[^>]*disabled/);
  assert.match(html, /id="installConfiguredBtn"[^>]*disabled/);
  assert.match(html, /id="install"[^>]*readonly[^>]*disabled/);
  assert.match(html, /id="installManifest"[^>]*readonly[^>]*disabled/);
  assert.match(html, /id="copyInstallBtn"[^>]*data-copy="install"[^>]*disabled/);
  assert.match(html, /id="copyManifestBtn"[^>]*data-copy="installManifest"[^>]*disabled/);
  assert.match(html, /id="installMaterial"[^>]*hidden/);
  assert.match(html, /id="technicalDetails"[^>]*hidden/);
  assert.match(html, /id="bridge"[^>]*readonly[^>]*disabled/);
  assert.match(html, /id="manifest"[^>]*readonly[^>]*disabled/);
  assert.match(html, /id="copyBridgeBtn"[^>]*data-copy="bridge"[^>]*disabled/);
  assert.match(html, /id="copyTechnicalManifestBtn"[^>]*data-copy="manifest"[^>]*disabled/);
  assert.match(html, /id="stremioStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="workspaceStatus"[^>]*data-state="profile"/);
  assert.match(html, /id="workspaceStatusLabel"/);
  assert.match(html, /id="workspaceStatusText"/);
  assert.doesNotMatch(html, /id="pairTimer"[^>]*(?:role|aria-live)=/);
  assert.doesNotMatch(html, /id="stremioTimer"[^>]*(?:role|aria-live)=/);
  assert.match(html, /id="stremioQr"[^>]*alt="[^"]+"/);
  assert.match(
    html,
    /id="connectTraktBtn"[^>]*aria-label="Connect account with Trakt to sync scrobbles and watched history"/
  );
  assert.match(
    html,
    /class="trakt-brand-panel"[^>]*aria-hidden="true"[\s\S]*?class="trakt-lockup"[^>]*alt=""/
  );
  assert.match(html, /class="trakt-action-copy"[^>]*aria-hidden="true"[\s\S]*?<strong>Connect account<\/strong>/);
  assert.doesNotMatch(html, /trakt-action-main|trakt-connect/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width:/);
  assert.match(indexSource, /fs\.readFileSync\(CONFIGURE_TEMPLATE_PATH, "utf8"\)/);
  assert.doesNotMatch(indexSource, /res\.end\(`<!DOCTYPE html>/);
  assert.doesNotMatch(configureSource, /\.style\./);
  assert.match(configureSource, /setInterval\(renderPairTimer, 1000\)/);
  assert.doesNotMatch(configureSource, /setInterval\(renderPairStatus, 1000\)/);
  assert.match(configureSource, /pairExpiryAnnounced/);
  assert.match(configureSource, /function clearApprovalMaterial\(operation\)/);
  assert.match(configureSource, /link\.removeAttribute\("href"\)/);
  assert.match(configureSource, /code\.textContent = ""/);
  assert.match(configureSource, /setHidden\(byId\("installMaterial"\), !installReady\)/);
  assert.match(configureSource, /privateInstallUrl = body\.installUrl/);
  assert.match(configureSource, /privateManifestUrl = body\.manifestUrl/);
  assert.match(configureSource, /privateBridgeBaseUrl = body\.bridgeBaseUrl/);
  assert.doesNotMatch(configureSource, /privateInstallUrl = value\.installUrl/);
  assert.match(configureSource, /setHidden\(byId\("technicalDetails"\), !technicalReady\)/);
  assert.match(configureSource, /const manifestReady = installReady && Boolean\(privateManifestUrl\)/);
  assert.match(configureSource, /const technicalReady = manifestReady && Boolean\(privateBridgeBaseUrl\)/);
  assert.match(configureSource, /manifestInput\.value = manifestReady \? privateManifestUrl : ""/);
  assert.doesNotMatch(configureSource, /byId\("(?:bridge|manifest)"\)\.value = value\./);
  assert.match(configureSource, /document\.execCommand\("copy"\)/);
  assert.equal((configureSource.match(/installConfigured\(\)/g) || []).length, 1);
  assert.match(configureSource, /if \(!button\.disabled\) copyField\(button\.dataset\.copy\)/);
  assert.match(
    configureSource,
    /connectStremioBtn"\)\.disabled = providerBusy \|\| !\(hasConfig && pairedForConfig && managementCsrf\)/
  );
  assert.match(
    configureSource,
    /previewManualBtn"\)\.disabled = providerBusy \|\| !\(hasConfig && pairedForConfig && managementCsrf\)/
  );
  assert.match(configureSource, /if \(!profileManagementApi \|\| !managementCsrf\)/);
  assert.match(configureSource, /await profileManagementApi\.connectTrakt\(\)/);
  assert.doesNotMatch(configureSource, /fetch\("\/auth\/trakt\/start"/);
  assert.doesNotMatch(indexSource, /app\.(?:get|post)\("\/auth\/trakt(?:\/start)?"/);
  assert.doesNotMatch(indexSource, /\/v1\/trakt\/token|\/auth\/token/);
});
