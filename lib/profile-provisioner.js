"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { assertRepository } = require("./storage/contracts");
const {
  assertDisplayName,
  assertPlainObject,
  codedError,
} = require("./storage/repository-utils");

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONFIG_BLOB_PATTERN = /^[A-Za-z0-9_-]{16,1048576}$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const PROFILE_SCOPE_PATTERN = /^[a-f0-9]{24}$/;
const INSTALL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const MAX_SETTINGS_BYTES = 64 * 1024;

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function assertHash(value, name) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertConfigBlob(value) {
  if (typeof value !== "string" || !CONFIG_BLOB_PATTERN.test(value)) {
    throw new TypeError("config blob is invalid");
  }
  return value;
}

function canonicalizeSettings(value) {
  const settings = assertPlainObject(value, "profile settings");
  let json;
  try {
    json = JSON.stringify(settings);
  } catch (_error) {
    throw new TypeError("profile settings are not JSON serializable");
  }
  if (json === undefined) throw new TypeError("profile settings are not JSON serializable");
  if (Buffer.byteLength(json, "utf8") > MAX_SETTINGS_BYTES) {
    throw new RangeError("profile settings exceeds " + MAX_SETTINGS_BYTES + " bytes");
  }

  let canonical;
  try {
    canonical = JSON.parse(json);
  } catch (_error) {
    throw new TypeError("profile settings are not JSON serializable");
  }
  return assertPlainObject(canonical, "profile settings");
}

function hashConfigBlob(configBlob) {
  return sha256(assertConfigBlob(configBlob));
}

function deriveProfileIdentityHash(config, configBlob) {
  const value = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const profileId = typeof value.profileId === "string" ? value.profileId : "";
  if (PROFILE_ID_PATTERN.test(profileId)) {
    return sha256("jumpgate-profile-id:v1\u0000" + profileId);
  }
  const profileScope = typeof value.profileScope === "string" ? value.profileScope : "";
  if (PROFILE_SCOPE_PATTERN.test(profileScope)) {
    return sha256("jumpgate-profile-scope:v1\u0000" + profileScope);
  }
  return sha256("jumpgate-legacy-profile:v1\u0000" + assertConfigBlob(configBlob));
}

function settingsPurpose(identityHash) {
  return "profile-settings:v1:" + assertHash(identityHash, "profile identity hash");
}

function provisioningPurpose(identityHash, configHash) {
  const identity = assertHash(identityHash, "profile identity hash");
  const config = assertHash(configHash, "config hash");
  return "profile-provisioning:v1:" + sha256(identity + "\u0000" + config);
}

function attachError(error, name, value) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, name, {
      configurable: true,
      enumerable: false,
      value,
    });
  } catch (_error) {
    // Preserve the actionable error when it cannot be extended.
  }
}

class ProfileProvisioner {
  constructor(options = {}) {
    this._profiles = assertRepository("profiles", options.profiles);
    this._aliases = assertRepository("legacyConfigAliases", options.legacyConfigAliases);
    if (
      !options.envelopeCrypto ||
      typeof options.envelopeCrypto.encryptJson !== "function" ||
      typeof options.envelopeCrypto.decryptJson !== "function" ||
      typeof options.envelopeCrypto.needsRotation !== "function"
    ) {
      throw new TypeError("envelopeCrypto is required");
    }
    this._crypto = options.envelopeCrypto;
    this._maxUpdateAttempts = options.maxUpdateAttempts ?? 4;
    if (
      !Number.isSafeInteger(this._maxUpdateAttempts) ||
      this._maxUpdateAttempts < 1 ||
      this._maxUpdateAttempts > 16
    ) {
      throw new TypeError("maxUpdateAttempts is invalid");
    }
    this._identityLocks = new Map();
  }

  async provision(input = {}) {
    const configBlob = assertConfigBlob(input.configBlob);
    const identityHash = deriveProfileIdentityHash(input.config, configBlob);
    const configHash = hashConfigBlob(configBlob);
    const displayName = assertDisplayName(input.displayName);
    const settings = canonicalizeSettings(input.settings === undefined ? {} : input.settings);
    const finalEnvelope = this._crypto.encryptJson(settings, settingsPurpose(identityHash));
    const pendingEnvelope = this._crypto.encryptJson(
      { schemaVersion: 1, displayName, settings },
      provisioningPurpose(identityHash, configHash)
    );

    return this._withIdentityLock(identityHash, () =>
      this._provisionLocked({
        identityHash,
        configHash,
        displayName,
        settings,
        finalEnvelope,
        pendingEnvelope,
      })
    );
  }

  async _provisionLocked(context) {
    const {
      identityHash,
      configHash,
      displayName,
      settings,
      finalEnvelope,
      pendingEnvelope,
    } = context;
    const [identityOwner, configOwner] = await Promise.all([
      this._aliases.getProfileId(identityHash),
      this._aliases.getProfileId(configHash),
    ]);
    if (identityOwner && configOwner && identityOwner !== configOwner) {
      throw codedError("profile_alias_conflict", "profile identity and config aliases disagree");
    }
    if (!identityOwner && configOwner) {
      const configProfile = await this._requireActiveProfile(configOwner);
      if (configProfile.legacyConfigHash !== identityHash) {
        throw codedError("profile_alias_conflict", "config alias belongs to another profile identity");
      }
    }

    let profile;
    let installToken = null;
    let createdNow = false;
    const existingId = identityOwner || configOwner;
    if (existingId) {
      profile = await this._requireActiveProfile(existingId);
    } else {
      try {
        const result = await this._profiles.create({
          displayName,
          settingsEnvelope: pendingEnvelope,
          legacyConfigHash: identityHash,
        });
        try {
          profile = this._assertCreatedResult(result).profile;
        } catch (error) {
          if (result && result.profile && typeof result.profile.id === "string") {
            await this._compensateOrRequireTransaction(result.profile.id, error);
          }
          throw error;
        }
        installToken = result.installToken;
        createdNow = true;
      } catch (error) {
        if (!error || error.code !== "legacy_alias_conflict") throw error;
        const winnerId = await this._aliases.getProfileId(identityHash);
        if (!winnerId) throw error;
        profile = await this._requireActiveProfile(winnerId);
      }
    }

    if (createdNow) {
      let identityBinding;
      try {
        identityBinding = await this._bindAliasVerified(profile.id, identityHash);
      } catch (error) {
        await this._compensateOrRequireTransaction(profile.id, error);
      }
      if (identityBinding.owner !== profile.id) {
        await this._compensateCreatedProfile(profile.id);
        profile = await this._requireActiveProfile(identityBinding.owner);
        installToken = null;
        createdNow = false;
      }
    } else {
      const identityBinding = await this._bindAliasVerified(profile.id, identityHash);
      if (identityBinding.owner !== profile.id) {
        throw codedError("profile_alias_conflict", "profile identity alias belongs to another profile");
      }
    }

    const settled = await this._readSettledProfileState(profile, context);
    profile = settled.profile;
    const profileState = settled.state;
    const configBinding = await this._bindAliasVerified(profile.id, configHash);
    if (configBinding.owner !== profile.id) {
      const conflict = codedError("profile_alias_conflict", "config alias belongs to another profile");
      if (createdNow) {
        await this._compensateCreatedProfile(profile.id);
        throw this._transactionRequired(conflict);
      }
      throw conflict;
    }

    if (profileState.kind === "pending") {
      this._assertPendingMatches(profileState.payload, displayName, settings);
      if (!createdNow) {
        const rotated = await this._rotatePendingInstallToken(profile);
        profile = rotated.profile;
        installToken = rotated.installToken;
      }
      profile = await this._finalizePendingProfile(
        profile,
        displayName,
        settings,
        finalEnvelope,
        identityHash
      );
      return {
        profile,
        installToken,
        created: true,
        identityHash,
        configHash,
      };
    }

    profile = await this._synchronizeProfile(
      profile,
      displayName,
      settings,
      finalEnvelope,
      identityHash
    );
    return { profile, installToken: null, created: false, identityHash, configHash };
  }

  _assertCreatedResult(result) {
    if (
      !result ||
      !result.profile ||
      result.profile.status !== "active" ||
      typeof result.profile.id !== "string" ||
      typeof result.installToken !== "string" ||
      !INSTALL_TOKEN_PATTERN.test(result.installToken)
    ) {
      throw codedError("profile_create_invalid", "profile creation returned an invalid result");
    }
    return result;
  }

  async _bindAliasVerified(profileId, hash) {
    let bindError = null;
    try {
      await this._aliases.bind(profileId, hash);
    } catch (error) {
      bindError = error;
    }

    let owner;
    try {
      owner = await this._aliases.getProfileId(hash);
    } catch (lookupError) {
      if (bindError) {
        attachError(bindError, "verificationError", lookupError);
        throw bindError;
      }
      throw lookupError;
    }
    if (owner) return { owner, bindError };
    if (bindError) throw bindError;
    throw codedError("profile_alias_unconfirmed", "profile alias binding could not be confirmed");
  }

  async _readSettledProfileState(profile, context) {
    let current = profile;
    let lastError = null;
    for (let attempt = 0; attempt < this._maxUpdateAttempts; attempt += 1) {
      try {
        return {
          profile: current,
          state: this._readProfileState(current, context.identityHash, context.configHash),
        };
      } catch (error) {
        if (!error || error.code !== "profile_provisioning_incomplete") throw error;
        lastError = error;
        if (attempt + 1 < this._maxUpdateAttempts) {
          await Promise.resolve();
          current = await this._requireActiveProfile(current.id);
        }
      }
    }
    throw lastError;
  }

  _readProfileState(profile, identityHash, configHash) {
    if (!profile.settingsEnvelope) return { kind: "final", settings: null };
    try {
      return {
        kind: "final",
        settings: this._crypto.decryptJson(profile.settingsEnvelope, settingsPurpose(identityHash)),
      };
    } catch (finalError) {
      try {
        const payload = this._crypto.decryptJson(
          profile.settingsEnvelope,
          provisioningPurpose(identityHash, configHash)
        );
        return { kind: "pending", payload };
      } catch (pendingError) {
        const error = codedError(
          "profile_provisioning_incomplete",
          "profile is awaiting another provisioning transaction"
        );
        attachError(error, "finalEnvelopeError", finalError);
        attachError(error, "pendingEnvelopeError", pendingError);
        throw error;
      }
    }
  }

  _assertPendingMatches(payload, displayName, settings) {
    let safePayload;
    try {
      safePayload = assertPlainObject(payload, "profile provisioning state");
    } catch (cause) {
      const error = codedError("profile_provisioning_corrupt", "profile provisioning state is invalid");
      error.cause = cause;
      throw error;
    }
    const fields = Object.keys(safePayload).sort();
    if (
      fields.length !== 3 ||
      fields[0] !== "displayName" ||
      fields[1] !== "schemaVersion" ||
      fields[2] !== "settings" ||
      safePayload.schemaVersion !== 1 ||
      safePayload.displayName !== displayName ||
      !isDeepStrictEqual(safePayload.settings, settings)
    ) {
      throw codedError(
        "profile_provisioning_conflict",
        "profile provisioning retry does not match the pending request"
      );
    }
  }

  async _rotatePendingInstallToken(profile) {
    try {
      const rotated = await this._profiles.rotateInstallToken(profile.id, profile.revision);
      if (!rotated) throw codedError("profile_unavailable", "profile is unavailable");
      return this._assertCreatedResult(rotated);
    } catch (error) {
      if (error && error.code === "revision_conflict") {
        const race = codedError(
          "profile_install_token_race",
          "another provisioning attempt changed the install capability"
        );
        race.cause = error;
        throw race;
      }
      const current = await this._profiles.getById(profile.id).catch(() => null);
      if (current && current.status === "active" && current.revision !== profile.revision) {
        const indeterminate = codedError(
          "profile_install_token_indeterminate",
          "install capability rotation could not be confirmed"
        );
        indeterminate.cause = error;
        throw indeterminate;
      }
      throw error;
    }
  }

  async _finalizePendingProfile(
    profile,
    displayName,
    settings,
    finalEnvelope,
    identityHash
  ) {
    try {
      const updated = await this._profiles.update(
        profile.id,
        { displayName, settingsEnvelope: finalEnvelope },
        profile.revision
      );
      if (!updated) throw codedError("profile_unavailable", "profile is unavailable");
      this._assertExactFinalization(updated, profile.revision, displayName, settings, identityHash);
      return updated;
    } catch (error) {
      if (error && error.code === "revision_conflict") {
        const race = codedError(
          "profile_install_token_race",
          "another provisioning attempt changed the pending profile"
        );
        race.cause = error;
        throw race;
      }
      let current = null;
      try {
        current = await this._profiles.getById(profile.id);
      } catch (verificationError) {
        const indeterminate = this._transactionRequired(error);
        attachError(indeterminate, "verificationError", verificationError);
        throw indeterminate;
      }
      if (current && current.status === "active" && current.revision === profile.revision) {
        throw error;
      }
      try {
        this._assertExactFinalization(
          current,
          profile.revision,
          displayName,
          settings,
          identityHash
        );
      } catch (verificationError) {
        const indeterminate = this._transactionRequired(error);
        attachError(indeterminate, "verificationError", verificationError);
        throw indeterminate;
      }
      return current;
    }
  }

  _assertExactFinalization(profile, previousRevision, displayName, settings, identityHash) {
    if (
      !profile ||
      profile.status !== "active" ||
      profile.revision !== previousRevision + 1 ||
      profile.displayName !== displayName
    ) {
      throw codedError("profile_finalization_unconfirmed", "profile finalization could not be confirmed");
    }
    const stored = this._crypto.decryptJson(profile.settingsEnvelope, settingsPurpose(identityHash));
    if (!isDeepStrictEqual(stored, settings)) {
      throw codedError("profile_finalization_unconfirmed", "profile finalization changed settings");
    }
  }

  async _compensateOrRequireTransaction(profileId, cause) {
    try {
      await this._compensateCreatedProfile(profileId);
    } catch (cleanupError) {
      throw this._transactionRequired(cause, cleanupError);
    }
    throw this._transactionRequired(cause);
  }

  async _compensateCreatedProfile(profileId) {
    let lastError = null;
    for (let attempt = 0; attempt < this._maxUpdateAttempts; attempt += 1) {
      let current;
      try {
        current = await this._profiles.getById(profileId);
      } catch (error) {
        lastError = error;
        continue;
      }
      if (!current || current.status !== "active") return;
      try {
        await this._profiles.revoke(profileId, current.revision);
      } catch (error) {
        lastError = error;
        if (error && error.code === "revision_conflict") continue;
      }
      try {
        const verified = await this._profiles.getById(profileId);
        if (!verified || verified.status !== "active") return;
      } catch (error) {
        lastError = error;
      }
    }
    const error = codedError(
      "profile_compensation_failed",
      "created profile could not be proven inactive"
    );
    if (lastError) error.cause = lastError;
    throw error;
  }

  _transactionRequired(cause, cleanupError) {
    const error = codedError(
      "profile_transaction_required",
      "profile provisioning requires an atomic profile-and-alias transaction"
    );
    error.cause = cause;
    if (cleanupError) attachError(error, "cleanupError", cleanupError);
    return error;
  }

  async _requireActiveProfile(profileId) {
    const profile = await this._profiles.getById(profileId);
    if (!profile || profile.status !== "active") {
      throw codedError("profile_unavailable", "profile is unavailable");
    }
    return profile;
  }

  async _synchronizeProfile(profile, displayName, settings, freshEnvelope, identityHash) {
    let current = profile;
    for (let attempt = 0; attempt < this._maxUpdateAttempts; attempt += 1) {
      let storedSettings = null;
      if (current.settingsEnvelope) {
        storedSettings = this._crypto.decryptJson(
          current.settingsEnvelope,
          settingsPurpose(identityHash)
        );
      }
      const settingsChanged =
        !isDeepStrictEqual(storedSettings, settings) ||
        (current.settingsEnvelope && this._crypto.needsRotation(current.settingsEnvelope));
      const nameChanged = current.displayName !== displayName;
      if (!settingsChanged && !nameChanged) return current;

      try {
        const updated = await this._profiles.update(
          current.id,
          {
            displayName,
            settingsEnvelope: settingsChanged ? freshEnvelope : current.settingsEnvelope,
          },
          current.revision
        );
        if (!updated) throw codedError("profile_unavailable", "profile is unavailable");
        return updated;
      } catch (error) {
        if (!error || error.code !== "revision_conflict") throw error;
        current = await this._requireActiveProfile(current.id);
      }
    }
    throw codedError("profile_update_conflict", "profile changed too many times");
  }

  async _withIdentityLock(identityHash, work) {
    const previous = this._identityLocks.get(identityHash) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this._identityLocks.set(identityHash, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this._identityLocks.get(identityHash) === current) {
        this._identityLocks.delete(identityHash);
      }
    }
  }
}

module.exports = {
  ProfileProvisioner,
  canonicalizeSettings,
  deriveProfileIdentityHash,
  hashConfigBlob,
  provisioningPurpose,
  settingsPurpose,
};
