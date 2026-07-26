"use strict";

const crypto = require("node:crypto");
const { types } = require("node:util");
const { validateEnvelope } = require("./envelope-crypto");
const { assertJsonValue } = require("./json-domain");
const {
  MemoryLifecycleInvalidationRepository,
  ProfileLifecycleCoordinator,
} = require("./lifecycle-invalidation");
const {
  assertDisplayName,
  assertIdentifier,
  assertMutationFence,
  assertRevision,
  cloneJson,
  compareMutationFences,
  codedError,
  mutationFenceOption,
  nextMutationFence,
  providerSnapshotStaleFence,
  readClock,
  revisionConflict,
  stableScope,
} = require("./repository-utils");

const MAX_PROFILE_SETTINGS_BYTES = 1024 * 1024;
const MAX_PROVIDER_DESCRIPTOR_BYTES = 64 * 1024;

function assertOptionalHash(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertOptionalEnvelope(value, name) {
  if (value === null) return null;
  const canonical = assertJsonValue(value, name, MAX_PROFILE_SETTINGS_BYTES);
  try {
    validateEnvelope(canonical);
  } catch (_error) {
    throw new TypeError(name + " is invalid");
  }
  return canonical;
}

function assertDataObject(value, name, allowedFields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError(name + " is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " is invalid");
  }
  const output = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowedFields.has(key)) {
      throw new TypeError(name + " contains an unknown field: " + String(key));
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError(name + " contains an unsupported property");
    }
    output[key] = descriptor.value;
  }
  return output;
}

function assertProfileInput(value) {
  return assertDataObject(
    value,
    "profile input",
    new Set(["displayName", "settingsEnvelope", "legacyConfigHash"])
  );
}

function assertPatch(value) {
  return assertDataObject(
    value,
    "profile patch",
    new Set(["displayName", "settingsEnvelope"])
  );
}

function assertDescriptorSize(descriptor) {
  try {
    return assertJsonValue(
      descriptor,
      "provider descriptor",
      MAX_PROVIDER_DESCRIPTOR_BYTES
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new RangeError("provider descriptor exceeds 64 KiB");
    }
    throw error;
  }
}

class MemoryProfileRepository {
  constructor(options = {}) {
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._profiles = new Map();
    this._installIndex = new Map();
    this._eraser = async () => {};
    this._lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();
    this._lifecycleInvalidations =
      options.lifecycleInvalidations ||
      new MemoryLifecycleInvalidationRepository({ clock: this._clock });
    this._playbackSessions = options.playbackSessions || null;
    this._subtitleManifests = options.subtitleManifests || null;
  }

  async create(input = {}) {
    const safeInput = assertProfileInput(input);
    const displayName = assertDisplayName(safeInput.displayName);
    const settingsEnvelope = Object.prototype.hasOwnProperty.call(safeInput, "settingsEnvelope")
      ? assertOptionalEnvelope(safeInput.settingsEnvelope, "settingsEnvelope")
      : null;
    const legacyConfigHash = assertOptionalHash(
      safeInput.legacyConfigHash,
      "legacyConfigHash"
    );
    const now = readClock(this._clock);
    const id = assertIdentifier(this._idFactory("profile"), "profile id");
    if (this._profiles.has(id)) throw new Error("profile id collision");
    const issued = this._tokens.issue("install", 32);
    if (this._installIndex.has(issued.tokenHash)) throw new Error("install token collision");
    const record = {
      schemaVersion: 1,
      id,
      installTokenHash: issued.tokenHash,
      displayName,
      settingsEnvelope,
      legacyConfigHash,
      status: "active",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
      historyGeneration: 1,
      deletionState: "none",
      deletionStartedAt: null,
      durableErasedAt: null,
      erasureAttemptCount: 0,
      erasureNextAttemptAt: null,
    };
    this._profiles.set(id, record);
    this._installIndex.set(issued.tokenHash, id);
    return { profile: this._public(record), installToken: issued.token };
  }

  async getById(profileId) {
    const record = this._profiles.get(assertIdentifier(profileId, "profile id"));
    return record ? this._public(record) : null;
  }

  async getHistoryGeneration(profileId) {
    const record = this._profiles.get(assertIdentifier(profileId, "profile id"));
    return record && record.status === "active" ? record.historyGeneration : null;
  }

  async advanceHistoryGeneration(profileId, expectedGeneration) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedGeneration, false);
    const record = this._profiles.get(id);
    if (!record || record.status !== "active") {
      throw codedError("profile_inactive", "profile is missing or inactive");
    }
    if (record.historyGeneration !== expected) {
      throw codedError("history_generation_changed", "history generation changed before clear");
    }
    if (record.historyGeneration >= Number.MAX_SAFE_INTEGER) {
      throw codedError("history_generation_exhausted", "history generation exhausted");
    }
    record.historyGeneration += 1;
    record.updatedAt = readClock(this._clock);
    return record.historyGeneration;
  }

  async getByInstallToken(token) {
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("install", token);
    } catch (_error) {
      return null;
    }
    const id = this._installIndex.get(tokenHash);
    const record = id ? this._profiles.get(id) : null;
    return record && record.status === "active" ? this._public(record) : null;
  }

  async update(profileId, patch = {}, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const safePatch = assertPatch(patch);
    const hasDisplayName = Object.prototype.hasOwnProperty.call(safePatch, "displayName");
    const hasSettingsEnvelope = Object.prototype.hasOwnProperty.call(
      safePatch,
      "settingsEnvelope"
    );
    const displayName = hasDisplayName
      ? assertDisplayName(safePatch.displayName)
      : undefined;
    const settingsEnvelope = hasSettingsEnvelope
      ? assertOptionalEnvelope(safePatch.settingsEnvelope, "settingsEnvelope")
      : undefined;
    const expected = assertRevision(expectedRevision, false);
    return this._lifecycleCoordinator.run(id, async () => {
      const record = this._profiles.get(id);
      if (!record || record.status !== "active") return null;
      if (record.revision !== expected) throw revisionConflict();
      const now = readClock(this._clock);

      if (hasDisplayName) record.displayName = displayName;
      if (hasSettingsEnvelope) record.settingsEnvelope = settingsEnvelope;
      record.revision += 1;
      record.updatedAt = now;
      if (this._playbackSessions) {
        this._playbackSessions.invalidateProfileNow(id, record.revision);
      }
      return this._public(record);
    });
  }

  async rotateInstallToken(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);
    return this._lifecycleCoordinator.run(id, async () => {
      const record = this._profiles.get(id);
      if (!record || record.status !== "active") return null;
      if (record.revision !== expected) throw revisionConflict();
      const issued = this._tokens.issue("install", 32);
      if (this._installIndex.has(issued.tokenHash)) throw new Error("install token collision");
      const now = readClock(this._clock);
      this._installIndex.delete(record.installTokenHash);
      record.installTokenHash = issued.tokenHash;
      record.revision += 1;
      record.updatedAt = now;
      this._installIndex.set(issued.tokenHash, id);
      if (this._playbackSessions) {
        this._playbackSessions.invalidateProfileNow(id, record.revision);
      }
      return { profile: this._public(record), installToken: issued.token };
    });
  }

  async revoke(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);
    return this._lifecycleCoordinator.run(id, async () => {
      const record = this._profiles.get(id);
      if (!record) return false;
      if (record.revision !== expected) throw revisionConflict();
      if (record.status === "revoked") {
        if (this._playbackSessions) {
          this._playbackSessions.invalidateProfileNow(id, record.revision);
        }
        if (this._subtitleManifests) {
          this._subtitleManifests.requestProfileDeletionNow(id, "profile_revoked");
        }
        return true;
      }
      const now = readClock(this._clock);
      this._lifecycleInvalidations.enqueueProfile(id, record.revision + 1);
      record.status = "revoked";
      record.revokedAt = now;
      record.updatedAt = now;
      record.revision += 1;
      if (this._playbackSessions) {
        this._playbackSessions.invalidateProfileNow(id, record.revision);
      }
      if (this._subtitleManifests) {
        this._subtitleManifests.requestProfileDeletionNow(id, "profile_revoked");
      }
      this._installIndex.delete(record.installTokenHash);
      return true;
    });
  }

  setEraser(eraser) {
    if (typeof eraser !== "function") throw new TypeError("profile eraser is required");
    this._eraser = eraser;
  }

  async beginErasure(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);
    return this._lifecycleCoordinator.run(id, async () => {
      const record = this._profiles.get(id);
      if (!record) return null;
      if (record.deletionState === "pending" || record.deletionState === "deleted") {
        if (record.deletionState === "pending" && this._subtitleManifests) {
          this._subtitleManifests.requestProfileDeletionNow(id, "profile_erasure");
        }
        return this._public(record);
      }
      if (record.status !== "active") return null;
      if (record.revision !== expected) throw revisionConflict();
      const now = readClock(this._clock);
      this._lifecycleInvalidations.enqueueProfile(id, record.revision + 1);
      record.status = "revoked";
      record.revokedAt = now;
      record.updatedAt = now;
      record.deletionState = "pending";
      record.deletionStartedAt = now;
      record.erasureAttemptCount = 0;
      record.erasureNextAttemptAt = now;
      record.revision += 1;
      if (this._playbackSessions) {
        this._playbackSessions.invalidateProfileNow(id, record.revision);
      }
      if (this._subtitleManifests) {
        this._subtitleManifests.requestProfileDeletionNow(id, "profile_erasure");
      }
      this._installIndex.delete(record.installTokenHash);
      return this._public(record);
    });
  }

  async erase(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(id, async () => {
      const record = this._profiles.get(id);
      if (!record) return false;
      if (record.deletionState === "deleted") return true;
      if (record.deletionState !== "pending") return false;
      if (this._subtitleManifests && this._subtitleManifests.hasProfileNow(id)) {
        throw codedError(
          "profile_erasure_pending",
          "subtitle object deletion is still pending"
        );
      }
      await this._eraser(id);
      const replacement = this._tokens.issue("install", 32);
      if (this._installIndex.has(replacement.tokenHash)) {
        throw new Error("install token collision");
      }
      const now = readClock(this._clock);
      this._installIndex.delete(record.installTokenHash);
      record.installTokenHash = replacement.tokenHash;
      record.displayName = "";
      record.settingsEnvelope = null;
      record.status = "revoked";
      record.deletionState = "deleted";
      record.durableErasedAt = now;
      record.updatedAt = now;
      record.revision += 1;
      return true;
    });
  }

  async getErasureStatus(profileId) {
    const record = this._profiles.get(assertIdentifier(profileId, "profile id"));
    if (!record || record.deletionState === "none") return null;
    return {
      status: record.deletionState,
      startedAt: record.deletionStartedAt,
      durableErasedAt: record.durableErasedAt,
      attemptCount: record.erasureAttemptCount,
      nextAttemptAt: record.erasureNextAttemptAt,
    };
  }

  async listPendingErasures(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("pending erasure limit is invalid");
    }
    const now = readClock(this._clock);
    return Array.from(this._profiles.values())
      .filter((record) =>
        record.deletionState === "pending" && record.erasureNextAttemptAt <= now
      )
      .sort((left, right) =>
        left.erasureNextAttemptAt - right.erasureNextAttemptAt ||
        left.deletionStartedAt - right.deletionStartedAt ||
        left.id.localeCompare(right.id)
      )
      .slice(0, limit)
      .map((record) => ({
        profileId: record.id,
        startedAt: record.deletionStartedAt,
        attemptCount: record.erasureAttemptCount,
        nextAttemptAt: record.erasureNextAttemptAt,
      }));
  }

  async deferErasure(profileId, expectedAttemptCount, nextAttemptAt) {
    const id = assertIdentifier(profileId, "profile id");
    if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
      throw new TypeError("profile erasure attempt count is invalid");
    }
    if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0) {
      throw new TypeError("profile erasure retry timestamp is invalid");
    }
    const record = this._profiles.get(id);
    if (
      !record ||
      record.deletionState !== "pending" ||
      record.erasureAttemptCount !== expectedAttemptCount
    ) {
      return false;
    }
    record.erasureAttemptCount += 1;
    record.erasureNextAttemptAt = nextAttemptAt;
    record.updatedAt = readClock(this._clock);
    return true;
  }

  storageSnapshot() {
    return Array.from(this._profiles.values(), (record) => cloneJson(record));
  }

  _public(record) {
    const copy = cloneJson(record);
    delete copy.installTokenHash;
    return copy;
  }
}

class MemoryProviderRepository {
  constructor(options = {}) {
    if (!options.envelopeCrypto || !options.tokenService) {
      throw new TypeError("envelopeCrypto and tokenService are required");
    }
    this._crypto = options.envelopeCrypto;
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._collections = new Map();
    this._mutationFenceCounter = "0";
  }

  async allocateMutationFence(profileId) {
    assertIdentifier(profileId, "profile id");
    const allocated = nextMutationFence(this._mutationFenceCounter);
    this._mutationFenceCounter = allocated;
    return allocated;
  }

  async replaceAll(profileId, descriptors, expectedRevision, options) {
    const id = assertIdentifier(profileId, "profile id");
    const safeDescriptors = assertJsonValue(descriptors, "provider descriptors");
    if (!Array.isArray(safeDescriptors) || safeDescriptors.length > 64) {
      throw new TypeError("descriptors must be an array of at most 64 entries");
    }
    const boundedDescriptors = safeDescriptors.map(assertDescriptorSize);
    const expected = assertRevision(expectedRevision, false);
    const mutationFence = mutationFenceOption(options);
    const current = this._collections.get(id) || {
      mutationFence: "0",
      revision: 0,
      records: [],
    };
    const currentFence = assertMutationFence(
      current.mutationFence ?? "0",
      "stored provider mutation fence"
    );
    if (compareMutationFences(mutationFence, currentFence) < 0) {
      throw providerSnapshotStaleFence();
    }
    if (current.revision !== expected) throw revisionConflict();

    const transportHashes = new Set();
    const providerIds = new Set();
    for (const [collectionProfileId, collection] of this._collections) {
      if (collectionProfileId === id) continue;
      for (const record of collection.records) providerIds.add(record.providerId);
    }
    const envelopePurpose = this._providerPurpose(id);
    const records = boundedDescriptors.map((descriptor, ordinal) => {
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        throw new TypeError("provider descriptor is invalid");
      }
      const transportUrl = descriptor.transportUrl;
      if (typeof transportUrl !== "string" || !transportUrl) {
        throw new TypeError("provider transportUrl is required");
      }
      const transportHash = this._tokens.hashOpaque("provider-transport", transportUrl, 8192);
      if (transportHashes.has(transportHash)) throw new TypeError("duplicate provider transportUrl");
      transportHashes.add(transportHash);
      const providerId = assertIdentifier(this._idFactory("provider"), "provider id");
      if (providerIds.has(providerId)) throw new Error("provider id collision");
      providerIds.add(providerId);
      const manifestId =
        descriptor.manifest && typeof descriptor.manifest.id === "string"
          ? descriptor.manifest.id.slice(0, 256)
          : "";
      return {
        schemaVersion: 1,
        providerId,
        profileId: id,
        ordinal,
        manifestId,
        transportHash,
        descriptorEnvelope: this._crypto.encryptJson(descriptor, envelopePurpose),
      };
    });

    const next = {
      mutationFence,
      revision: current.revision + 1,
      updatedAt: readClock(this._clock),
      records,
    };
    this._collections.set(id, next);
    this._rebaseMutationFenceCounter(mutationFence);
    return { revision: next.revision, count: records.length };
  }

  async list(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const collection = this._collections.get(id) || { revision: 0, records: [] };
    const envelopePurpose = this._providerPurpose(id);
    return {
      revision: collection.revision,
      providers: collection.records.map((record) => ({
        providerId: record.providerId,
        ordinal: record.ordinal,
        descriptor: this._crypto.decryptJson(record.descriptorEnvelope, envelopePurpose),
      })),
    };
  }

  async removeAll(profileId, expectedRevision, options) {
    return this.replaceAll(profileId, [], expectedRevision, options);
  }

  eraseProfile(profileId) {
    return this._collections.delete(assertIdentifier(profileId, "profile id"));
  }

  async advanceMutationFence(profileId, mutationFence) {
    const id = assertIdentifier(profileId, "profile id");
    const nextFence = assertMutationFence(mutationFence);
    const current = this._collections.get(id);
    const currentFence = assertMutationFence(
      current ? current.mutationFence ?? "0" : "0",
      "stored provider mutation fence"
    );
    const comparison = compareMutationFences(nextFence, currentFence);
    if (comparison < 0) throw providerSnapshotStaleFence();
    if (!current) {
      this._collections.set(id, {
        mutationFence: nextFence,
        revision: 0,
        updatedAt: readClock(this._clock),
        records: [],
      });
    } else if (comparison > 0) {
      current.mutationFence = nextFence;
      current.updatedAt = readClock(this._clock);
    }
    this._rebaseMutationFenceCounter(nextFence);
    return { revision: current ? current.revision : 0, mutationFence: nextFence };
  }

  storageSnapshot(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return cloneJson(this._collections.get(id) || {
      mutationFence: "0",
      revision: 0,
      records: [],
    });
  }

  _providerPurpose(profileId) {
    const profileScope = stableScope("profile", profileId);
    return "provider-descriptor:" + profileScope;
  }

  _rebaseMutationFenceCounter(mutationFence) {
    if (compareMutationFences(mutationFence, this._mutationFenceCounter) > 0) {
      this._mutationFenceCounter = mutationFence;
    }
  }
}

module.exports = {
  MemoryProfileRepository,
  MemoryProviderRepository,
};
