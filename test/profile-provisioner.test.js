"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  ProfileProvisioner,
  deriveProfileIdentityHash,
  hashConfigBlob,
  settingsPurpose,
} = require("../lib/profile-provisioner");
const { createMemoryRepositorySet, loadStorageConfig } = require("../lib/storage");

function wrapRepository(repository, overrides = {}) {
  return new Proxy(repository, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) return overrides[property];
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createProvisioner(storage, overrides = {}) {
  return new ProfileProvisioner({
    profiles: overrides.profiles || storage.repositories.profiles,
    legacyConfigAliases:
      overrides.legacyConfigAliases || storage.repositories.legacyConfigAliases,
    envelopeCrypto: storage.envelopeCrypto,
    maxUpdateAttempts: overrides.maxUpdateAttempts,
  });
}

function fixture() {
  let id = 0;
  const randomBytes = (length) => Buffer.alloc(length, ++id);
  const config = loadStorageConfig({ NODE_ENV: "test" }, { randomBytes });
  const storage = createMemoryRepositorySet(config, {
    randomBytes,
    profileIdFactory: () => "profile_" + String(++id).padStart(8, "0"),
  });
  return {
    ...storage,
    provisioner: createProvisioner(storage),
  };
}

const CONFIG_A = "A".repeat(64);
const CONFIG_B = "B".repeat(64);

test("profile identity hashes are domain separated and config hashes use all bytes", () => {
  const profileId = "profile_identity_123456";
  const fromId = deriveProfileIdentityHash({ profileId }, CONFIG_A);
  const fromScope = deriveProfileIdentityHash({ profileScope: "a".repeat(24) }, CONFIG_A);
  const legacy = deriveProfileIdentityHash({}, CONFIG_A);

  assert.match(fromId, /^[a-f0-9]{64}$/);
  assert.notEqual(fromId, fromScope);
  assert.notEqual(fromScope, legacy);
  assert.notEqual(hashConfigBlob(CONFIG_A), hashConfigBlob(CONFIG_A.slice(0, -1) + "C"));
  assert.throws(() => hashConfigBlob("not a blob"), /config blob is invalid/);
});

test("first provisioning atomically adopts identity and encrypts profile settings", async () => {
  const { provisioner, repositories, envelopeCrypto } = fixture();
  const identityHash = deriveProfileIdentityHash(
    { profileId: "profile_identity_123456" },
    CONFIG_A
  );
  const configHash = hashConfigBlob(CONFIG_A);
  const settings = { subtitle_languages: "en,es", subtitles_enabled: true };

  const result = await provisioner.provision({
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_A,
    displayName: "Living room",
    settings,
  });

  assert.equal(result.created, true);
  assert.match(result.installToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(await repositories.legacyConfigAliases.getProfileId(identityHash), result.profile.id);
  assert.equal(await repositories.legacyConfigAliases.getProfileId(configHash), result.profile.id);
  assert.deepEqual(
    envelopeCrypto.decryptJson(result.profile.settingsEnvelope, settingsPurpose(identityHash)),
    settings
  );
  assert.equal(
    (await repositories.profiles.getByInstallToken(result.installToken)).id,
    result.profile.id
  );
});

test("regenerated config blobs converge on one profile and synchronize settings with CAS", async () => {
  const { provisioner, repositories } = fixture();
  const first = await provisioner.provision({
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_A,
    displayName: "Phone",
    settings: { subtitles_enabled: true },
  });
  const second = await provisioner.provision({
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_B,
    displayName: "Phone updated",
    settings: { subtitles_enabled: false },
  });

  assert.equal(second.profile.id, first.profile.id);
  assert.equal(second.created, false);
  assert.equal(second.installToken, null);
  assert.equal(second.profile.revision, first.profile.revision + 1);
  assert.equal(
    await repositories.legacyConfigAliases.getProfileId(hashConfigBlob(CONFIG_B)),
    first.profile.id
  );
  assert.equal((await repositories.profiles.getById(first.profile.id)).displayName, "Phone updated");
});

test("concurrent first adoption converges without cross-profile activation", async () => {
  const { provisioner, repositories } = fixture();
  const [first, second] = await Promise.all([
    provisioner.provision({
      config: { profileId: "profile_identity_123456" },
      configBlob: CONFIG_A,
      displayName: "Concurrent",
      settings: { subtitles_enabled: true },
    }),
    provisioner.provision({
      config: { profileId: "profile_identity_123456" },
      configBlob: CONFIG_B,
      displayName: "Concurrent",
      settings: { subtitles_enabled: true },
    }),
  ]);

  assert.equal(first.profile.id, second.profile.id);
  assert.equal(
    await repositories.legacyConfigAliases.getProfileId(hashConfigBlob(CONFIG_A)),
    first.profile.id
  );
  assert.equal(
    await repositories.legacyConfigAliases.getProfileId(hashConfigBlob(CONFIG_B)),
    first.profile.id
  );
  const active = repositories.profiles.storageSnapshot().filter((profile) => profile.status === "active");
  assert.equal(active.length, 1);
});

test("a config alias owned by another identity fails closed", async () => {
  const { provisioner, repositories } = fixture();
  const first = await provisioner.provision({
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_A,
    displayName: "First",
    settings: {},
  });
  await repositories.legacyConfigAliases.bind(first.profile.id, hashConfigBlob(CONFIG_B));

  await assert.rejects(
    provisioner.provision({
      config: { profileId: "profile_identity_654321" },
      configBlob: CONFIG_B,
      displayName: "Second",
      settings: {},
    }),
    (error) => error.code === "profile_alias_conflict"
  );
  assert.equal(
    await repositories.legacyConfigAliases.getProfileId(hashConfigBlob(CONFIG_B)),
    first.profile.id
  );
});

test("revoked aliases never reactivate or cross-bind a profile", async () => {
  const { provisioner, repositories } = fixture();
  const first = await provisioner.provision({
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_A,
    displayName: "Revoked",
    settings: {},
  });
  await repositories.profiles.revoke(first.profile.id, first.profile.revision);

  await assert.rejects(
    provisioner.provision({
      config: { profileId: "profile_identity_123456" },
      configBlob: CONFIG_A,
      displayName: "Must stay revoked",
      settings: {},
    }),
    (error) => error.code === "profile_unavailable"
  );
});

test("pre-alias failures compensate the created profile and invalidate its install token", async () => {
  const storage = fixture();
  const identityHash = deriveProfileIdentityHash(
    { profileId: "profile_identity_123456" },
    CONFIG_A
  );
  let issuedToken = null;
  const profiles = wrapRepository(storage.repositories.profiles, {
    create: async (...args) => {
      const result = await storage.repositories.profiles.create(...args);
      issuedToken = result.installToken;
      return result;
    },
  });
  const aliases = wrapRepository(storage.repositories.legacyConfigAliases, {
    bind: async (profileId, hash) => {
      if (hash === identityHash) throw new Error("identity alias unavailable");
      return storage.repositories.legacyConfigAliases.bind(profileId, hash);
    },
  });
  const provisioner = createProvisioner(storage, { profiles, legacyConfigAliases: aliases });

  await assert.rejects(
    provisioner.provision({
      config: { profileId: "profile_identity_123456" },
      configBlob: CONFIG_A,
      displayName: "Compensated",
      settings: {},
    }),
    (error) =>
      error.code === "profile_transaction_required" &&
      error.cause &&
      error.cause.message === "identity alias unavailable"
  );

  assert.equal(
    storage.repositories.profiles.storageSnapshot().filter((profile) => profile.status === "active").length,
    0
  );
  assert.equal(await storage.repositories.profiles.getByInstallToken(issuedToken), null);
});

test("a failed config bind remains identity-addressable and retry rotates the lost capability", async () => {
  const storage = fixture();
  const configHash = hashConfigBlob(CONFIG_A);
  let failed = false;
  let firstToken = null;
  const profiles = wrapRepository(storage.repositories.profiles, {
    create: async (...args) => {
      const result = await storage.repositories.profiles.create(...args);
      firstToken = result.installToken;
      return result;
    },
  });
  const aliases = wrapRepository(storage.repositories.legacyConfigAliases, {
    bind: async (profileId, hash) => {
      if (hash === configHash && !failed) {
        failed = true;
        throw new Error("config alias unavailable");
      }
      return storage.repositories.legacyConfigAliases.bind(profileId, hash);
    },
  });
  const provisioner = createProvisioner(storage, { profiles, legacyConfigAliases: aliases });
  const input = {
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_A,
    displayName: "Retryable",
    settings: { subtitles_enabled: true },
  };

  await assert.rejects(provisioner.provision(input), /config alias unavailable/);
  const identityHash = deriveProfileIdentityHash(input.config, CONFIG_A);
  const pendingId = await storage.repositories.legacyConfigAliases.getProfileId(identityHash);
  assert.ok(pendingId);
  assert.equal(
    storage.repositories.profiles.storageSnapshot().filter((profile) => profile.status === "active").length,
    1
  );

  const recovered = await provisioner.provision(input);
  assert.equal(recovered.created, true);
  assert.match(recovered.installToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.notEqual(recovered.installToken, firstToken);
  assert.equal(await storage.repositories.profiles.getByInstallToken(firstToken), null);
  assert.equal(
    (await storage.repositories.profiles.getByInstallToken(recovered.installToken)).id,
    recovered.profile.id
  );
  assert.equal(await storage.repositories.legacyConfigAliases.getProfileId(configHash), recovered.profile.id);
});

test("throw-after-commit alias faults are verified and do not duplicate profiles", async () => {
  const storage = fixture();
  const configHash = hashConfigBlob(CONFIG_A);
  let injected = false;
  const aliases = wrapRepository(storage.repositories.legacyConfigAliases, {
    bind: async (profileId, hash) => {
      const result = await storage.repositories.legacyConfigAliases.bind(profileId, hash);
      if (hash === configHash && !injected) {
        injected = true;
        throw new Error("ambiguous alias acknowledgement");
      }
      return result;
    },
  });
  const provisioner = createProvisioner(storage, { legacyConfigAliases: aliases });

  const result = await provisioner.provision({
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_A,
    displayName: "Committed",
    settings: {},
  });

  assert.equal(result.created, true);
  assert.match(result.installToken, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(await storage.repositories.legacyConfigAliases.getProfileId(configHash), result.profile.id);
  assert.equal(storage.repositories.profiles.storageSnapshot().length, 1);
});

test("failed finalization is retryable and ambiguous committed finalization preserves the token", async () => {
  const storage = fixture();
  let failBeforeCommit = true;
  const profiles = wrapRepository(storage.repositories.profiles, {
    update: async (...args) => {
      if (failBeforeCommit) {
        failBeforeCommit = false;
        throw new Error("finalization unavailable");
      }
      return storage.repositories.profiles.update(...args);
    },
  });
  const provisioner = createProvisioner(storage, { profiles });
  const input = {
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_A,
    displayName: "Finalize",
    settings: { subtitles_enabled: true },
  };

  await assert.rejects(provisioner.provision(input), /finalization unavailable/);
  const recovered = await provisioner.provision(input);
  assert.equal(recovered.created, true);
  assert.match(recovered.installToken, /^[A-Za-z0-9_-]{32,}$/);

  const secondStorage = fixture();
  let throwAfterCommit = true;
  const ambiguousProfiles = wrapRepository(secondStorage.repositories.profiles, {
    update: async (...args) => {
      const result = await secondStorage.repositories.profiles.update(...args);
      if (throwAfterCommit) {
        throwAfterCommit = false;
        throw new Error("lost update acknowledgement");
      }
      return result;
    },
  });
  const ambiguous = createProvisioner(secondStorage, { profiles: ambiguousProfiles });
  const committed = await ambiguous.provision(input);
  assert.equal(
    (await secondStorage.repositories.profiles.getByInstallToken(committed.installToken)).id,
    committed.profile.id
  );

  const indeterminateStorage = fixture();
  let readbackUnavailable = false;
  const indeterminateProfiles = wrapRepository(indeterminateStorage.repositories.profiles, {
    update: async (...args) => {
      await indeterminateStorage.repositories.profiles.update(...args);
      readbackUnavailable = true;
      throw new Error("lost finalization acknowledgement");
    },
    getById: async (...args) => {
      if (readbackUnavailable) throw new Error("finalization readback unavailable");
      return indeterminateStorage.repositories.profiles.getById(...args);
    },
  });
  const indeterminate = createProvisioner(indeterminateStorage, {
    profiles: indeterminateProfiles,
  });
  await assert.rejects(
    indeterminate.provision(input),
    (error) =>
      error.code === "profile_transaction_required" && Boolean(error.verificationError)
  );
});

test("independent provisioners race to one active profile without cross-binding", async () => {
  const storage = fixture();
  const firstProvisioner = createProvisioner(storage);
  const secondProvisioner = createProvisioner(storage);
  const [first, second] = await Promise.all([
    firstProvisioner.provision({
      config: { profileId: "profile_identity_123456" },
      configBlob: CONFIG_A,
      displayName: "Cross-process race",
      settings: { subtitles_enabled: true },
    }),
    secondProvisioner.provision({
      config: { profileId: "profile_identity_123456" },
      configBlob: CONFIG_B,
      displayName: "Cross-process race",
      settings: { subtitles_enabled: true },
    }),
  ]);

  assert.equal(first.profile.id, second.profile.id);
  assert.equal(
    storage.repositories.profiles.storageSnapshot().filter((profile) => profile.status === "active").length,
    1
  );
  assert.equal(
    await storage.repositories.legacyConfigAliases.getProfileId(hashConfigBlob(CONFIG_A)),
    first.profile.id
  );
  assert.equal(
    await storage.repositories.legacyConfigAliases.getProfileId(hashConfigBlob(CONFIG_B)),
    first.profile.id
  );
});

test("unprovable compensation fails closed with an explicit transaction requirement", async () => {
  const storage = fixture();
  const identityHash = deriveProfileIdentityHash(
    { profileId: "profile_identity_123456" },
    CONFIG_A
  );
  const profiles = wrapRepository(storage.repositories.profiles, {
    revoke: async () => {
      throw new Error("revoke unavailable");
    },
  });
  const aliases = wrapRepository(storage.repositories.legacyConfigAliases, {
    bind: async (profileId, hash) => {
      if (hash === identityHash) throw new Error("identity alias unavailable");
      return storage.repositories.legacyConfigAliases.bind(profileId, hash);
    },
  });
  const provisioner = createProvisioner(storage, {
    profiles,
    legacyConfigAliases: aliases,
    maxUpdateAttempts: 2,
  });

  await assert.rejects(
    provisioner.provision({
      config: { profileId: "profile_identity_123456" },
      configBlob: CONFIG_A,
      displayName: "Indeterminate",
      settings: {},
    }),
    (error) => error.code === "profile_transaction_required" && Boolean(error.cleanupError)
  );
});

test("lossy JSON settings are canonicalized before encryption and do not consume retry revisions", async () => {
  const { provisioner, envelopeCrypto } = fixture();
  const input = {
    config: { profileId: "profile_identity_123456" },
    configBlob: CONFIG_A,
    displayName: "Canonical",
    settings: {
      keep: "value",
      omitted: undefined,
      nested: { nan: Number.NaN, omitted: undefined },
      array: [undefined, Number.POSITIVE_INFINITY],
    },
  };

  const first = await provisioner.provision(input);
  const second = await provisioner.provision(input);
  const identityHash = deriveProfileIdentityHash(input.config, input.configBlob);
  assert.deepEqual(
    envelopeCrypto.decryptJson(first.profile.settingsEnvelope, settingsPurpose(identityHash)),
    { keep: "value", nested: { nan: null }, array: [null, null] }
  );
  assert.equal(second.profile.revision, first.profile.revision);
  await assert.rejects(
    provisioner.provision({ ...input, settings: { invalid: 1n } }),
    /not JSON serializable/
  );
});
