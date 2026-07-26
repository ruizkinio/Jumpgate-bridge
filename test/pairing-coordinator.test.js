"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PairingCoordinator } = require("../lib/pairing-coordinator");
const { ProfileProvisioner } = require("../lib/profile-provisioner");
const { createMemoryRepositorySet, loadStorageConfig } = require("../lib/storage");

const CONFIG_A = "A".repeat(64);
const CONFIG_B = "B".repeat(64);
const RETRY_A = Buffer.alloc(32, 0x31).toString("base64url");
const RETRY_B = Buffer.alloc(32, 0x32).toString("base64url");

function fixture(options = {}) {
  let sequence = 0;
  const randomBytes = (length) => Buffer.alloc(length, (++sequence % 250) + 1);
  const storageConfig = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(storageConfig, {
    randomBytes,
    profileIdFactory: () => "profile_" + String(++sequence).padStart(8, "0"),
    pairingIdFactory: () => "pairing_" + String(++sequence).padStart(8, "0"),
    deviceIdFactory: () => "device_" + String(++sequence).padStart(8, "0"),
  });
  const configs = new Map([
    [
      CONFIG_A,
      {
        profileId: "configured_profile_1234",
        name: "Living room",
        settings: { subtitle_languages: "en,es", subtitles_enabled: true },
      },
    ],
    [
      CONFIG_B,
      {
        profileId: "configured_profile_5678",
        name: "Bedroom",
        settings: { subtitle_languages: "en", subtitles_enabled: false },
      },
    ],
  ]);
  const profileProvisioner = options.profileProvisioner || new ProfileProvisioner({
    profiles: storage.repositories.profiles,
    legacyConfigAliases: storage.repositories.legacyConfigAliases,
    envelopeCrypto: storage.envelopeCrypto,
  });
  const pairings = options.pairings || storage.repositories.pairings;
  const devices = options.devices || storage.repositories.devices;
  const coordinator = new PairingCoordinator({
    pairings,
    devices,
    managementSessions:
      options.managementSessions || storage.repositories.managementSessions,
    profiles: options.profiles || storage.repositories.profiles,
    profileProvisioner,
    decryptConfig(blob) {
      const config = configs.get(blob);
      if (!config) throw new Error("invalid config");
      return JSON.parse(JSON.stringify(config));
    },
    allowInsecureLoopback: true,
  });
  return { coordinator, configs, profileProvisioner, storage };
}

function bridgeUrl(blob) {
  return "http://127.0.0.1:7515/_c/" + blob;
}

test("invalid pairing codes do not create durable profiles", async () => {
  const { coordinator, storage } = fixture();
  const result = await coordinator.activate({
    userCode: "ABCD-EFGH",
    activationRetryToken: RETRY_A,
    configBlob: CONFIG_A,
    bridgeBaseUrl: bridgeUrl(CONFIG_A),
  });

  assert.equal(result.status, "not_found");
  assert.deepEqual(storage.repositories.profiles.storageSnapshot(), []);
});

test("activation registers and finalizes one recoverable profile/device tuple", async () => {
  const { coordinator, storage } = fixture();
  const issued = await coordinator.issue({ deviceName: "Kodi TV" });
  const activated = await coordinator.activate({
    userCode: issued.userCode,
    activationRetryToken: RETRY_A,
    configBlob: CONFIG_A,
    bridgeBaseUrl: bridgeUrl(CONFIG_A),
  });

  assert.equal(activated.status, "activated");
  assert.equal(activated.deviceId, issued.deviceId);
  assert.match(activated.profileId, /^[A-Za-z0-9_-]{8,128}$/);
  assert.equal(Object.hasOwn(activated, "deviceToken"), false);
  const snapshot = JSON.stringify(storage.repositories.pairings.storageSnapshot());
  assert.equal(snapshot.includes("deviceToken"), false);

  let disclosure = null;
  const redeemed = await coordinator.redeem(issued.deviceCode, (value) => {
    disclosure = value;
  });
  assert.equal(redeemed.status, "redeemed");
  assert.equal(disclosure.profileId, activated.profileId);
  assert.equal(disclosure.deviceId, activated.deviceId);
  assert.match(disclosure.deviceToken, /^[A-Za-z0-9_-]{32,128}$/);
  assert.equal((await coordinator.authenticate(disclosure.deviceToken)).profileId, activated.profileId);
  let repeatedDisclosure = null;
  assert.deepEqual(
    await coordinator.redeem(issued.deviceCode, (value) => {
      repeatedDisclosure = value;
    }),
    redeemed
  );
  assert.deepEqual(repeatedDisclosure, disclosure);
});

test("retry after post-registration completion failure reuses the exact device bearer", async () => {
  const base = fixture();
  const realPairings = base.storage.repositories.pairings;
  let completionCalls = 0;
  const observedTokens = [];
  const pairings = {
    issue: (...args) => realPairings.issue(...args),
    activate: (...args) => realPairings.activate(...args),
    recoverActivation: (...args) => realPairings.recoverActivation(...args),
    completeActivation: async (...args) => {
      completionCalls += 1;
      if (completionCalls === 1) throw new Error("simulated crash before completion");
      return realPairings.completeActivation(...args);
    },
    redeem: (...args) => realPairings.redeem(...args),
    cancel: (...args) => realPairings.cancel(...args),
  };
  const realDevices = base.storage.repositories.devices;
  const devices = {
    register: async (...args) => {
      observedTokens.push(args[1].deviceToken);
      return realDevices.register(...args);
    },
    authenticate: (...args) => realDevices.authenticate(...args),
    list: (...args) => realDevices.list(...args),
    getGeneration: (...args) => realDevices.getGeneration(...args),
    isActiveBinding: (...args) => realDevices.isActiveBinding(...args),
    revoke: (...args) => realDevices.revoke(...args),
    revokeWithInvalidation: (...args) => realDevices.revokeWithInvalidation(...args),
    commitDisclosure: (...args) => realDevices.commitDisclosure(...args),
    withClaimAdmission: (...args) => realDevices.withClaimAdmission(...args),
  };
  const { coordinator } = fixture({
    pairings,
    devices,
    profiles: base.storage.repositories.profiles,
    managementSessions: base.storage.repositories.managementSessions,
    profileProvisioner: base.profileProvisioner,
  });
  const issued = await coordinator.issue();
  const activationInput = {
    userCode: issued.userCode,
    activationRetryToken: RETRY_A,
    configBlob: CONFIG_A,
    bridgeBaseUrl: bridgeUrl(CONFIG_A),
  };

  await assert.rejects(coordinator.activate(activationInput), /simulated crash/);
  const recovered = await coordinator.activate(activationInput);
  assert.equal(recovered.status, "activated");
  assert.equal(observedTokens.length, 2);
  assert.equal(observedTokens[0], observedTokens[1]);
});

test("activation conflicts cannot silently switch config or profile", async () => {
  const { coordinator } = fixture();
  const issued = await coordinator.issue();
  await coordinator.activate({
    userCode: issued.userCode,
    activationRetryToken: RETRY_A,
    configBlob: CONFIG_A,
    bridgeBaseUrl: bridgeUrl(CONFIG_A),
  });

  await assert.rejects(
    coordinator.activate({
      userCode: issued.userCode,
      activationRetryToken: RETRY_A,
      configBlob: CONFIG_B,
      bridgeBaseUrl: bridgeUrl(CONFIG_B),
    }),
    (error) => error.code === "pairing_conflict"
  );
});

test("same retry token races converge on one exact management session", async () => {
  const { coordinator, storage } = fixture();
  const issued = await coordinator.issue();
  const input = {
    userCode: issued.userCode,
    activationRetryToken: RETRY_A,
    configBlob: CONFIG_A,
    bridgeBaseUrl: bridgeUrl(CONFIG_A),
  };

  const [first, second] = await Promise.all([
    coordinator.activate(input),
    coordinator.activate(input),
  ]);
  assert.deepEqual(second.management, first.management);
  assert.equal(first.profileId, second.profileId);
  assert.equal(storage.repositories.managementSessions.storageSnapshot().length, 1);
});

test("different retry token race loses short-code authority with a generic miss", async () => {
  const { coordinator, storage } = fixture();
  const issued = await coordinator.issue();
  const base = {
    userCode: issued.userCode,
    configBlob: CONFIG_A,
    bridgeBaseUrl: bridgeUrl(CONFIG_A),
  };

  const [first, second] = await Promise.all([
    coordinator.activate({ ...base, activationRetryToken: RETRY_A }),
    coordinator.activate({ ...base, activationRetryToken: RETRY_B }),
  ]);
  assert.equal(first.status, "activated");
  assert.equal(second.status, "not_found");
  assert.equal(storage.repositories.managementSessions.storageSnapshot().length, 1);
});

test("crash after management issuance replays exact credentials without session growth", async () => {
  const base = fixture();
  const real = base.storage.repositories.managementSessions;
  let issuedManagement = null;
  let failAfterIssue = true;
  const managementSessions = {
    issue: (...args) => real.issue(...args),
    issueForPairing: async (...args) => {
      const result = await real.issueForPairing(...args);
      issuedManagement = result;
      if (failAfterIssue) {
        failAfterIssue = false;
        throw new Error("simulated crash after management issuance");
      }
      return result;
    },
    recoverPairing: (...args) => real.recoverPairing(...args),
    revokePairing: (...args) => real.revokePairing(...args),
    authenticate: (...args) => real.authenticate(...args),
    revoke: (...args) => real.revoke(...args),
    revokeProfile: (...args) => real.revokeProfile(...args),
  };
  const { coordinator } = fixture({
    pairings: base.storage.repositories.pairings,
    devices: base.storage.repositories.devices,
    profiles: base.storage.repositories.profiles,
    managementSessions,
    profileProvisioner: base.profileProvisioner,
  });
  const issued = await coordinator.issue();
  const input = {
    userCode: issued.userCode,
    activationRetryToken: RETRY_A,
    configBlob: CONFIG_A,
    bridgeBaseUrl: bridgeUrl(CONFIG_A),
  };

  await assert.rejects(coordinator.activate(input), /simulated crash after management issuance/);
  const recovered = await coordinator.activate(input);
  assert.deepEqual(recovered.management, {
    sessionToken: issuedManagement.sessionToken,
    csrfToken: issuedManagement.csrfToken,
    expiresAt: issuedManagement.expiresAt,
  });
  assert.equal(base.storage.repositories.managementSessions.storageSnapshot().length, 1);
});

test("revoked pairing management authority cannot be reminted", async () => {
  const { coordinator, storage } = fixture();
  const issued = await coordinator.issue();
  const input = {
    userCode: issued.userCode,
    activationRetryToken: RETRY_A,
    configBlob: CONFIG_A,
    bridgeBaseUrl: bridgeUrl(CONFIG_A),
  };
  const activated = await coordinator.activate(input);
  assert.equal(await storage.repositories.managementSessions.revoke(activated.management.sessionToken), true);

  assert.deepEqual(await coordinator.activate(input), { status: "not_found" });
  assert.equal(storage.repositories.managementSessions.storageSnapshot().length, 0);
});

test("bridge URLs must be HTTPS or explicit loopback and match the exact config", async () => {
  const { coordinator } = fixture();
  const issued = await coordinator.issue();
  await assert.rejects(
    coordinator.activate({
      userCode: issued.userCode,
      activationRetryToken: RETRY_A,
      configBlob: CONFIG_A,
      bridgeBaseUrl: "http://bridge.example/_c/" + CONFIG_A,
    }),
    /bridgeBaseUrl is invalid/
  );
  await assert.rejects(
    coordinator.activate({
      userCode: issued.userCode,
      activationRetryToken: RETRY_A,
      configBlob: CONFIG_A,
      bridgeBaseUrl: "https://bridge.example/_c/" + CONFIG_B,
    }),
    /does not match config/
  );
});

test("activation rejects coerced config blobs and non-object settings", async () => {
  const first = fixture();
  const issued = await first.coordinator.issue();
  await assert.rejects(
    first.coordinator.activate({
      userCode: issued.userCode,
      activationRetryToken: RETRY_A,
      configBlob: { toString: () => CONFIG_A },
      bridgeBaseUrl: bridgeUrl(CONFIG_A),
    }),
    /configBlob is invalid/
  );
  assert.deepEqual(first.storage.repositories.profiles.storageSnapshot(), []);

  const second = fixture();
  second.configs.get(CONFIG_A).settings = null;
  const issuedSecond = await second.coordinator.issue();
  await assert.rejects(
    second.coordinator.activate({
      userCode: issuedSecond.userCode,
      activationRetryToken: RETRY_A,
      configBlob: CONFIG_A,
      bridgeBaseUrl: bridgeUrl(CONFIG_A),
    }),
    /profile settings must be an object/
  );
  assert.deepEqual(second.storage.repositories.profiles.storageSnapshot(), []);
});

test("explicit IPv6 loopback is accepted in test mode", async () => {
  const { coordinator } = fixture();
  const issued = await coordinator.issue();
  const activated = await coordinator.activate({
    userCode: issued.userCode,
    activationRetryToken: RETRY_A,
    configBlob: CONFIG_A,
    bridgeBaseUrl: "http://[::1]:7515/_c/" + CONFIG_A,
  });
  assert.equal(activated.status, "activated");
});
