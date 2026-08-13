"use strict";

const { isDeepStrictEqual } = require("node:util");
const {
  deriveProfileIdentityHash,
  hashConfigBlob,
} = require("./profile-provisioner");
const { assertRepository } = require("./storage/contracts");
const { assertActivationRetryToken } = require("./storage/pairing-replay");
const {
  assertDisplayName,
  assertIdentifier,
  assertJsonSize,
  assertPlainObject,
  cloneJson,
  codedError,
} = require("./storage/repository-utils");

const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

function normalizeBridgeBaseUrl(value, configBlob, allowInsecureLoopback) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.trim() !== value) {
    throw new TypeError("bridgeBaseUrl is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new TypeError("bridgeBaseUrl is invalid");
  }
  const insecureLoopback =
    parsed.protocol === "http:" &&
    allowInsecureLoopback === true &&
    LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (
    (parsed.protocol !== "https:" && !insecureLoopback) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("bridgeBaseUrl is invalid");
  }
  const expectedCanonicalPath = "/_c/" + configBlob;
  const expectedLegacyPath = "/" + configBlob;
  if (parsed.pathname !== expectedCanonicalPath && parsed.pathname !== expectedLegacyPath) {
    throw new TypeError("bridgeBaseUrl does not match config");
  }
  return parsed.origin + parsed.pathname;
}

function assertDeviceToken(value) {
  if (typeof value !== "string" || !DEVICE_TOKEN_PATTERN.test(value)) {
    throw codedError("pairing_protocol", "pairing activation has an invalid device token");
  }
  return value;
}

class PairingCoordinator {
  constructor(options = {}) {
    this._pairings = assertRepository("pairings", options.pairings);
    this._devices = assertRepository("devices", options.devices);
    this._managementSessions = assertRepository(
      "managementSessions",
      options.managementSessions
    );
    if (!options.profiles || typeof options.profiles.getById !== "function") {
      throw new TypeError("profiles repository is required");
    }
    this._profileRepository = options.profiles;
    if (!options.profileProvisioner || typeof options.profileProvisioner.provision !== "function") {
      throw new TypeError("profileProvisioner is required");
    }
    if (typeof options.decryptConfig !== "function") throw new TypeError("decryptConfig is required");
    this._profiles = options.profileProvisioner;
    this._decryptConfig = options.decryptConfig;
    this._allowInsecureLoopback = options.allowInsecureLoopback === true;
  }

  issue(input) {
    return this._pairings.issue(input);
  }

  cancel(deviceCode) {
    return this._pairings.cancel(deviceCode);
  }

  claimValidation(deviceCode) {
    return this._pairings.claimValidation(deviceCode);
  }

  authenticate(deviceToken) {
    return this._devices.authenticate(deviceToken);
  }

  async activate(input = {}) {
    const activationRetryToken = assertActivationRetryToken(input.activationRetryToken);
    if (typeof input.configBlob !== "string") throw new TypeError("configBlob is invalid");
    const configBlob = input.configBlob;
    const configHash = hashConfigBlob(configBlob);
    const config = assertPlainObject(this._decryptConfig(configBlob), "decrypted config");
    const profileIdentityHash = deriveProfileIdentityHash(config, configBlob);
    const name = assertDisplayName(config.name);
    const settings = assertPlainObject(
      config.settings === undefined ? {} : config.settings,
      "profile settings"
    );
    assertJsonSize(settings, "profile settings", 64 * 1024);
    const bridgeBaseUrl = normalizeBridgeBaseUrl(
      input.bridgeBaseUrl,
      configBlob,
      this._allowInsecureLoopback
    );
    const stableActivation = {
      schemaVersion: 1,
      profileIdentityHash,
      configHash,
      configBlob,
      bridgeBaseUrl,
      name,
      settings: cloneJson(settings),
    };
    assertJsonSize(stableActivation, "pairing activation", 64 * 1024);

    const activating = input.userCode
      ? await this._pairings.activate(input.userCode, stableActivation, {
          activationRetryToken,
        })
      : await this._pairings.recoverActivation(activationRetryToken, stableActivation);
    if (!activating || activating.status === "not_found" || activating.status === "expired") {
      return activating || { status: "not_found" };
    }
    if (activating.status !== "activating" && activating.status !== "activated") {
      throw codedError("pairing_protocol", "pairing activation returned an invalid state");
    }
    const activation = this._validateActivation(activating.activation, config);
    if (!isDeepStrictEqual(this._stableActivation(activation), stableActivation)) {
      throw codedError("pairing_protocol", "pairing activation payload changed");
    }

    if (activation.profileId) {
      const recovered = await this._managementSessions.recoverPairing({
        pairingId: activating.pairingId,
        profileId: activation.profileId,
        configHash,
        activationRetryToken,
        activationRetryExpiresAt: activating.activationRetryExpiresAt,
      });
      if (recovered && recovered.status === "replayed") {
        return this._activationResult(recovered, stableActivation, activating);
      }
      if (recovered && recovered.status === "denied") return { status: "not_found" };
      if (recovered && recovered.status !== "not_found") {
        throw codedError("pairing_protocol", "pairing replay returned an invalid state");
      }
    }

    const provisioned = await this._profiles.provision({
      configBlob,
      config,
      displayName: name,
      settings,
    });
    if (
      provisioned.identityHash !== profileIdentityHash ||
      provisioned.configHash !== configHash
    ) {
      throw codedError("pairing_protocol", "profile provisioning scope changed");
    }
    if (activation.profileId && activation.profileId !== provisioned.profile.id) {
      throw codedError("pairing_conflict", "pairing was finalized for another profile");
    }

    const registered = await this._devices.register(provisioned.profile.id, {
      pairingId: activating.pairingId,
      deviceId: activating.deviceId,
      deviceToken: activation.deviceToken,
      displayName: "Jumpgate",
    });
    if (
      !registered ||
      !registered.device ||
      registered.device.id !== activating.deviceId ||
      registered.device.profileId !== provisioned.profile.id ||
      registered.deviceToken !== activation.deviceToken
    ) {
      throw codedError("pairing_protocol", "durable device registration changed identity");
    }

    const completed = await this._pairings.completeActivation(
      activating.pairingId,
      activating.activationDigest,
      { profileId: provisioned.profile.id }
    );
    if (!completed || completed.status !== "activated") {
      throw codedError("pairing_protocol", "pairing activation did not complete");
    }
    const finalized = this._validateActivation(completed.activation, config, true);
    if (
      finalized.profileId !== provisioned.profile.id ||
      finalized.deviceToken !== activation.deviceToken
    ) {
      throw codedError("pairing_protocol", "pairing finalization changed identity");
    }

    const authority = {
      schemaVersion: 1,
      pairingId: activating.pairingId,
      deviceId: activating.deviceId,
      profileId: provisioned.profile.id,
      configHash,
      configBlob,
      bridgeBaseUrl: finalized.bridgeBaseUrl,
      name: finalized.name,
      settings: cloneJson(finalized.settings),
      profileRevision: provisioned.profile.revision,
      deviceGeneration: registered.device.generation,
      installToken: provisioned.installToken,
    };
    assertJsonSize(authority, "pairing response authority", 64 * 1024);
    const management = await this._managementSessions.issueForPairing({
      pairingId: activating.pairingId,
      profileId: provisioned.profile.id,
      configHash,
      activationRetryToken,
      activationRetryExpiresAt: activating.activationRetryExpiresAt,
      authority,
    });
    if (!management || (management.status !== "issued" && management.status !== "replayed")) {
      if (management && management.status === "denied") return { status: "not_found" };
      throw codedError("pairing_protocol", "pairing management issuance returned an invalid state");
    }
    return this._activationResult(management, stableActivation, activating);
  }

  async redeem(deviceCode, emitSync, authorizeDisclosure) {
    const result = await this._pairings.redeem(deviceCode);
    if (!result || result.status !== "redeemed") return result || { status: "not_found" };
    if (typeof emitSync !== "function") {
      throw new TypeError("pairing redemption disclosure emitter is required");
    }
    const activation = this._validateActivation(result.activation, null, true);
    const config = assertPlainObject(this._decryptConfig(activation.configBlob), "decrypted config");
    const expectedIdentity = deriveProfileIdentityHash(config, activation.configBlob);
    if (
      activation.profileIdentityHash !== expectedIdentity ||
      activation.configHash !== hashConfigBlob(activation.configBlob)
    ) {
      throw codedError("pairing_protocol", "redeemed pairing scope is invalid");
    }
    if (authorizeDisclosure !== undefined) {
      if (typeof authorizeDisclosure !== "function") {
        throw new TypeError("pairing disclosure authorizer must be a function");
      }
      await authorizeDisclosure(Object.freeze({
        profileId: activation.profileId,
        bridgeBaseUrl: activation.bridgeBaseUrl,
        configBlob: activation.configBlob,
      }));
    }
    const device = await this._devices.authenticate(activation.deviceToken);
    if (
      !device ||
      device.id !== result.deviceId ||
      device.profileId !== activation.profileId
    ) {
      throw codedError("pairing_protocol", "redeemed device credential is unavailable");
    }
    const profile = await this._profileRepository.getById(activation.profileId);
    if (
      !profile ||
      profile.status !== "active" ||
      !Number.isSafeInteger(profile.revision) ||
      profile.revision < 1 ||
      !Number.isSafeInteger(device.generation) ||
      device.generation < 1
    ) {
      throw codedError("pairing_protocol", "redeemed profile binding is unavailable");
    }
    const disclosure = Object.freeze({
      status: "redeemed",
      pairingId: result.pairingId,
      profileId: activation.profileId,
      deviceId: result.deviceId,
      deviceToken: activation.deviceToken,
      bridgeBaseUrl: activation.bridgeBaseUrl,
      config: activation.configBlob,
      name: activation.name,
      settings: cloneJson(activation.settings),
    });
    await this._devices.commitDisclosure(
      activation.profileId,
      result.deviceId,
      profile.revision,
      device.generation,
      () => emitSync(disclosure)
    );
    return { status: "redeemed" };
  }

  _stableActivation(activation) {
    const stable = cloneJson(activation);
    delete stable.deviceToken;
    delete stable.profileId;
    return stable;
  }

  _activationResult(management, stableActivation, activating) {
    const authority = assertPlainObject(management.authority, "pairing response authority");
    if (
      authority.schemaVersion !== 1 ||
      authority.pairingId !== activating.pairingId ||
      authority.deviceId !== activating.deviceId ||
      authority.configHash !== stableActivation.configHash ||
      authority.configBlob !== stableActivation.configBlob ||
      authority.bridgeBaseUrl !== stableActivation.bridgeBaseUrl ||
      authority.name !== stableActivation.name ||
      !isDeepStrictEqual(authority.settings, stableActivation.settings)
    ) {
      throw codedError("pairing_protocol", "pairing response authority changed");
    }
    assertIdentifier(authority.profileId, "profile id");
    if (!Number.isSafeInteger(authority.profileRevision) || authority.profileRevision < 1) {
      throw codedError("pairing_protocol", "pairing profile revision is invalid");
    }
    if (!Number.isSafeInteger(authority.deviceGeneration) || authority.deviceGeneration < 1) {
      throw codedError("pairing_protocol", "pairing device generation is invalid");
    }
    if (
      typeof management.sessionToken !== "string" ||
      typeof management.csrfToken !== "string" ||
      !Number.isSafeInteger(management.expiresAt)
    ) {
      throw codedError("pairing_protocol", "pairing management credentials are invalid");
    }
    return {
      status: "activated",
      pairingId: authority.pairingId,
      deviceId: authority.deviceId,
      profileId: authority.profileId,
      installToken: authority.installToken === null ? null : authority.installToken,
      bridgeBaseUrl: authority.bridgeBaseUrl,
      name: authority.name,
      settings: cloneJson(authority.settings),
      expiresAt: activating.expiresAt,
      profileRevision: authority.profileRevision,
      deviceGeneration: authority.deviceGeneration,
      management: {
        sessionToken: management.sessionToken,
        csrfToken: management.csrfToken,
        expiresAt: management.expiresAt,
      },
    };
  }

  _validateActivation(value, knownConfig, requireProfileId = false) {
    const activation = assertPlainObject(value, "pairing activation");
    if (activation.schemaVersion !== 1) {
      throw codedError("pairing_protocol", "pairing activation version is unsupported");
    }
    if (
      typeof activation.profileIdentityHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(activation.profileIdentityHash) ||
      typeof activation.configHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(activation.configHash)
    ) {
      throw codedError("pairing_protocol", "pairing activation scope is invalid");
    }
    hashConfigBlob(activation.configBlob);
    normalizeBridgeBaseUrl(
      activation.bridgeBaseUrl,
      activation.configBlob,
      this._allowInsecureLoopback
    );
    assertDisplayName(activation.name);
    assertPlainObject(activation.settings, "pairing settings");
    assertDeviceToken(activation.deviceToken);
    if (requireProfileId) assertIdentifier(activation.profileId, "profile id");
    else if (activation.profileId !== undefined) assertIdentifier(activation.profileId, "profile id");
    if (knownConfig) {
      const expectedIdentity = deriveProfileIdentityHash(knownConfig, activation.configBlob);
      if (expectedIdentity !== activation.profileIdentityHash) {
        throw codedError("pairing_protocol", "pairing activation identity is invalid");
      }
    }
    return activation;
  }
}

module.exports = {
  PairingCoordinator,
  normalizeBridgeBaseUrl,
};
