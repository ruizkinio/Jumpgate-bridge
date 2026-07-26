"use strict";

const crypto = require("node:crypto");
const { assertJsonValue } = require("./json-domain");
const {
  MemoryLifecycleInvalidationRepository,
  ProfileLifecycleCoordinator,
} = require("./lifecycle-invalidation");
const {
  addDuration,
  assertBoundedString,
  assertDisplayName,
  assertIdentifier,
  assertNonNegativeInteger,
  assertPlainObject,
  assertPositiveInteger,
  assertRevision,
  cloneJson,
  codedError,
  parseTimestamp,
  readClock,
  revisionConflict,
  stableScope,
} = require("./repository-utils");

const DEFAULT_DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_DEVICE_TOUCH_INTERVAL_MS = 15 * 60 * 1000;
const MAX_JSON_SNAPSHOT_BYTES = 64 * 1024;

function assertOptionalObject(value, name) {
  if (value === null) return null;
  const object = assertJsonValue(value, name, MAX_JSON_SNAPSHOT_BYTES);
  return assertPlainObject(object, name);
}

function assertRequiredObject(value, name) {
  const object = assertJsonValue(value, name, MAX_JSON_SNAPSHOT_BYTES);
  return assertPlainObject(object, name);
}

function assertProvider(value) {
  return assertBoundedString(value, "OAuth provider", 64, {
    pattern: /^[a-z][a-z0-9_-]{0,63}$/,
  });
}

function assertContentKey(value) {
  return assertBoundedString(value, "contentKey", 64, {
    pattern: /^[a-f0-9]{64}$/,
  });
}

function parseHistoryCursor(input) {
  if (input.cursor !== undefined && input.before !== undefined) {
    throw new TypeError("history cursor and before are mutually exclusive");
  }
  const value = input.cursor === undefined ? input.before : input.cursor;
  if (value === undefined) {
    return { lastPlayedAt: null, revision: null, contentKey: null };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      lastPlayedAt: parseTimestamp(value, "history before"),
      revision: null,
      contentKey: null,
    };
  }

  const cursor = assertPlainObject(value, "history cursor");
  return {
    lastPlayedAt: parseTimestamp(cursor.lastPlayedAt, "history cursor lastPlayedAt"),
    revision: assertPositiveInteger(cursor.revision, "history cursor revision"),
    contentKey: assertContentKey(cursor.contentKey),
  };
}

function assertSafePlaybackSnapshot(value) {
  const snapshot = assertRequiredObject(value, "playbackSnapshot");
  const stringFields = new Set([
    "providerNamespace",
    "sourceFingerprint",
    "subtitleTrackId",
    "audioTrackId",
    "videoTrackId",
    "edition",
    "quality",
    "resolution",
    "codec",
    "container",
  ]);
  const arrayFields = new Set(["subtitleLanguages", "audioLanguages"]);
  const booleanFields = new Set(["subtitlesEnabled", "hearingImpaired", "forced"]);
  for (const [key, item] of Object.entries(snapshot)) {
    if (key === "providerId") {
      assertIdentifier(item, "playbackSnapshot.providerId");
    } else if (stringFields.has(key)) {
      const maximum = key === "sourceFingerprint" ? 512 : 256;
      assertBoundedString(item, "playbackSnapshot." + key, maximum);
      if (/(?:[a-z][a-z0-9+.-]*:\/\/|magnet:|^\/\/)/i.test(item)) {
        throw new TypeError("playbackSnapshot must not contain source URLs");
      }
    } else if (arrayFields.has(key)) {
      if (!Array.isArray(item) || item.length > 32) {
        throw new TypeError("playbackSnapshot." + key + " is invalid");
      }
      for (const language of item) {
        assertBoundedString(language, "playbackSnapshot language", 32, {
          pattern: /^[A-Za-z0-9_-]+$/,
        });
      }
    } else if (booleanFields.has(key)) {
      if (typeof item !== "boolean") throw new TypeError("playbackSnapshot." + key + " is invalid");
    } else if (key === "playbackSpeed") {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0.25 || item > 4) {
        throw new TypeError("playbackSnapshot.playbackSpeed is invalid");
      }
    } else if (/(?:url|token|secret|authorization|cookie|credential|headers?)/i.test(key)) {
      throw new TypeError("playbackSnapshot contains a sensitive field");
    } else {
      throw new TypeError("playbackSnapshot contains an unsupported field: " + key);
    }
  }
  return snapshot;
}

class MemoryDeviceRepository {
  constructor(options = {}) {
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._ttlMs = options.ttlMs ?? DEFAULT_DEVICE_TTL_MS;
    this._touchIntervalMs = options.touchIntervalMs ?? DEFAULT_DEVICE_TOUCH_INTERVAL_MS;
    this._maxDevicesPerProfile = options.maxDevicesPerProfile ?? 32;
    this._isProfileActive = options.isProfileActive || (async () => true);
    if (typeof this._isProfileActive !== "function") {
      throw new TypeError("isProfileActive must be a function");
    }
    this._getProfileBinding = options.getProfileBinding || (async (profileId) => ({
      id: profileId,
      status: (await this._isProfileActive(profileId)) ? "active" : "revoked",
      revision: 1,
    }));
    if (typeof this._getProfileBinding !== "function") {
      throw new TypeError("getProfileBinding must be a function");
    }
    this._lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();
    this._lifecycleInvalidations =
      options.lifecycleInvalidations ||
      new MemoryLifecycleInvalidationRepository({ clock: this._clock });
    this._playbackSessions = options.playbackSessions || null;
    this._subtitleManifests = options.subtitleManifests || null;
    assertPositiveInteger(this._ttlMs, "device ttl", 2 * 365 * 24 * 60 * 60 * 1000);
    assertPositiveInteger(this._touchIntervalMs, "device touch interval", this._ttlMs);
    assertPositiveInteger(this._maxDevicesPerProfile, "maxDevicesPerProfile", 1024);
    this._devices = new Map();
    this._tokenIndex = new Map();
    this._pairingIndex = new Map();
  }

  async register(profileId, input = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    if (!(await this._isProfileActive(scopedProfileId))) {
      throw codedError("profile_inactive", "profile is missing or inactive");
    }
    const details = assertPlainObject(input, "device input");
    const now = readClock(this._clock);
    this._expireIndexes(now);
    const pairingId =
      details.pairingId === undefined ? null : assertIdentifier(details.pairingId, "pairing id");
    let suppliedTokenHash = null;
    if (details.deviceToken !== undefined) {
      suppliedTokenHash = this._tokens.hashToken("device", details.deviceToken);
    }
    if (pairingId !== null) {
      const existingDeviceId = this._pairingIndex.get(pairingId);
      const existing = existingDeviceId ? this._devices.get(existingDeviceId) : null;
      if (existing) {
        if (
          existing.profileId !== scopedProfileId ||
          existing.revokedAt !== null ||
          suppliedTokenHash === null ||
          suppliedTokenHash !== existing.tokenHash ||
          (details.deviceId !== undefined && details.deviceId !== existing.id)
        ) {
          throw codedError("pairing_device_conflict", "pairing device registration conflicts with existing data");
        }
        return { device: this._public(existing), deviceToken: details.deviceToken };
      }
    }
    if (this._activeCount(scopedProfileId, now) >= this._maxDevicesPerProfile) {
      throw codedError("device_limit", "profile device limit reached");
    }
    const deviceId = assertIdentifier(
      details.deviceId === undefined ? this._idFactory("device") : details.deviceId,
      "device id"
    );
    if (this._devices.has(deviceId)) throw codedError("device_id_collision", "device id collision");
    const issued =
      details.deviceToken === undefined
        ? this._tokens.issue("device", 32)
        : { token: details.deviceToken, tokenHash: suppliedTokenHash };
    if (this._tokenIndex.has(issued.tokenHash)) {
      throw codedError("device_token_collision", "device token collision");
    }
    const record = {
      schemaVersion: 1,
      id: deviceId,
      profileId: scopedProfileId,
      pairingId,
      tokenHash: issued.tokenHash,
      generation: 1,
      displayName: assertDisplayName(details.displayName, "device displayName"),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: addDuration(now, this._ttlMs, "device expiry"),
      revokedAt: null,
    };
    this._devices.set(deviceId, record);
    this._tokenIndex.set(issued.tokenHash, deviceId);
    if (pairingId !== null) this._pairingIndex.set(pairingId, deviceId);
    return { device: this._public(record), deviceToken: issued.token };
  }

  async authenticate(deviceToken) {
    const now = readClock(this._clock);
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("device", deviceToken);
    } catch (_err) {
      return null;
    }
    const deviceId = this._tokenIndex.get(tokenHash);
    const record = deviceId ? this._devices.get(deviceId) : null;
    if (
      !record ||
      record.revokedAt !== null ||
      record.expiresAt <= now ||
      !(await this._isProfileActive(record.profileId))
    ) {
      if (record) this._tokenIndex.delete(record.tokenHash);
      return null;
    }
    if (now - record.lastSeenAt >= this._touchIntervalMs) {
      record.lastSeenAt = now;
      record.expiresAt = addDuration(now, this._ttlMs, "device expiry");
    }
    return this._public(record);
  }

  async list(profileId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    if (!(await this._isProfileActive(scopedProfileId))) return [];
    const now = readClock(this._clock);
    this._expireIndexes(now);
    return Array.from(this._devices.values())
      .filter(
        (record) =>
          record.profileId === scopedProfileId &&
          record.revokedAt === null &&
          record.expiresAt > now
      )
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((record) => this._public(record));
  }

  async revoke(profileId, deviceId) {
    const result = await this.revokeWithInvalidation(profileId, deviceId);
    return result.revoked;
  }

  async revokeWithInvalidation(profileId, deviceId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    return this._lifecycleCoordinator.run(scopedProfileId, async () => {
      const profile = await this._getProfileBinding(scopedProfileId);
      if (!profile || profile.status !== "active") {
        throw codedError("profile_inactive", "profile is missing or inactive");
      }
      const record = this._devices.get(id);
      if (!record || record.profileId !== scopedProfileId) {
        return Object.freeze({ revoked: false, invalidation: null });
      }
      if (record.revokedAt !== null) {
        if (this._playbackSessions) {
          this._playbackSessions.invalidateDeviceNow(
            scopedProfileId,
            id,
            record.generation
          );
        }
        if (this._subtitleManifests) {
          this._subtitleManifests.requestDeviceDeletionNow(
            scopedProfileId,
            id,
            "device_revoked"
          );
        }
        return Object.freeze({
          revoked: true,
          invalidation: await this._lifecycleInvalidations.getPending(
            "device",
            scopedProfileId,
            id
          ),
        });
      }
      if (record.generation >= Number.MAX_SAFE_INTEGER) {
        throw codedError("device_generation_exhausted", "device generation exhausted");
      }
      const nextGeneration = record.generation + 1;
      const invalidation = this._lifecycleInvalidations.enqueueDevice(
        scopedProfileId,
        profile.revision,
        id,
        nextGeneration
      );
      record.generation = nextGeneration;
      record.revokedAt = readClock(this._clock);
      if (this._playbackSessions) {
        this._playbackSessions.invalidateDeviceNow(
          scopedProfileId,
          id,
          nextGeneration
        );
      }
      if (this._subtitleManifests) {
        this._subtitleManifests.requestDeviceDeletionNow(
          scopedProfileId,
          id,
          "device_revoked"
        );
      }
      this._tokenIndex.delete(record.tokenHash);
      return Object.freeze({ revoked: true, invalidation });
    });
  }

  async getGeneration(profileId, deviceId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    if (!(await this._isProfileActive(scopedProfileId))) return null;
    const record = this._devices.get(id);
    return record && record.profileId === scopedProfileId ? record.generation : null;
  }

  async isActiveBinding(profileId, deviceId, generation) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    const expected = assertPositiveInteger(
      generation,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    if (!(await this._isProfileActive(scopedProfileId))) return false;
    return this.isActiveBindingNow(scopedProfileId, id, expected);
  }

  async withClaimAdmission(
    profileId,
    deviceId,
    profileRevision,
    deviceGeneration,
    operation
  ) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    const expectedProfileRevision = assertRevision(profileRevision, false);
    const expectedDeviceGeneration = assertPositiveInteger(
      deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    if (typeof operation !== "function") throw new TypeError("claim admission operation is required");
    const validate = () => this._lifecycleCoordinator.run(scopedProfileId, async () => {
      const assertCurrentBinding = async () => {
        const profile = await this._getProfileBinding(scopedProfileId);
        if (
          !profile ||
          profile.status !== "active" ||
          profile.revision !== expectedProfileRevision
        ) {
          throw codedError(
            "profile_generation_changed",
            "profile generation changed before playback claim"
          );
        }
        if (!this.isActiveBindingNow(scopedProfileId, id, expectedDeviceGeneration)) {
          throw codedError(
            "device_generation_changed",
            "device generation changed before playback claim"
          );
        }
      };
      await assertCurrentBinding();
      return true;
    });
    await validate();
    const result = await operation();
    await validate();
    return result;
  }

  async commitDisclosure(
    profileId,
    deviceId,
    profileRevision,
    deviceGeneration,
    emitSync
  ) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    const expectedProfileRevision = assertRevision(profileRevision, false);
    const expectedDeviceGeneration = assertPositiveInteger(
      deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    if (typeof emitSync !== "function") throw new TypeError("disclosure emitter is required");
    return this._lifecycleCoordinator.run(scopedProfileId, async () => {
      const profile = await this._getProfileBinding(scopedProfileId);
      if (
        !profile ||
        profile.status !== "active" ||
        profile.revision !== expectedProfileRevision
      ) {
        throw codedError(
          "profile_generation_changed",
          "profile generation changed before disclosure"
        );
      }
      if (!this.isActiveBindingNow(scopedProfileId, id, expectedDeviceGeneration)) {
        throw codedError(
          "device_generation_changed",
          "device generation changed before disclosure"
        );
      }
      const emitted = emitSync();
      if (emitted && typeof emitted.then === "function") {
        throw new TypeError("disclosure emitter must be synchronous");
      }
      return true;
    });
  }

  isActiveBindingNow(profileId, deviceId, generation) {
    const record = this._devices.get(deviceId);
    return Boolean(
      record &&
      record.profileId === profileId &&
      record.generation === generation &&
      record.revokedAt === null &&
      record.expiresAt > readClock(this._clock)
    );
  }

  storageSnapshot() {
    return Array.from(this._devices.values(), (record) => cloneJson(record));
  }

  eraseProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    let removed = 0;
    for (const [deviceId, record] of this._devices) {
      if (record.profileId !== id) continue;
      this._devices.delete(deviceId);
      this._tokenIndex.delete(record.tokenHash);
      if (record.pairingId !== null) this._pairingIndex.delete(record.pairingId);
      removed += 1;
    }
    return removed;
  }

  _activeCount(profileId, now) {
    let count = 0;
    for (const record of this._devices.values()) {
      if (record.profileId === profileId && record.revokedAt === null && record.expiresAt > now) count += 1;
    }
    return count;
  }

  _expireIndexes(now) {
    for (const record of this._devices.values()) {
      if (record.expiresAt <= now) this._tokenIndex.delete(record.tokenHash);
    }
  }

  _public(record) {
    const result = cloneJson(record);
    delete result.tokenHash;
    return result;
  }
}

class MemoryOAuthCredentialRepository {
  constructor(options = {}) {
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
    this._isProfileActive = options.isProfileActive || (async () => true);
    if (typeof this._isProfileActive !== "function") {
      throw new TypeError("isProfileActive must be a function");
    }
    this._credentials = new Map();
    this._erasedProfiles = new Set();
  }

  async put(profileId, provider, credentials, expectedRevision) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    const value = assertRequiredObject(credentials, "OAuth credentials");
    const expected = assertRevision(expectedRevision, false);
    if (this._erasedProfiles.has(scopedProfileId)) {
      throw codedError("profile_inactive", "profile is missing or inactive");
    }
    if (!(await this._isProfileActive(scopedProfileId))) {
      throw codedError("profile_inactive", "profile is missing or inactive");
    }
    const key = this._key(scopedProfileId, scopedProvider);
    const current = this._credentials.get(key);
    const currentRevision = current ? current.revision : 0;
    if (currentRevision !== expected) throw revisionConflict();
    const now = readClock(this._clock);
    const record = {
      schemaVersion: 1,
      profileId: scopedProfileId,
      provider: scopedProvider,
      credentialEnvelope: this._crypto.encryptJson(value, this._purpose(scopedProfileId, scopedProvider)),
      revision: currentRevision + 1,
      createdAt: current ? current.createdAt : now,
      updatedAt: now,
    };
    if (this._erasedProfiles.has(scopedProfileId)) {
      throw codedError("profile_inactive", "profile is missing or inactive");
    }
    this._credentials.set(key, record);
    return this._public(record);
  }

  async get(profileId, provider) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    if (!(await this._isProfileActive(scopedProfileId))) return null;
    const record = this._credentials.get(this._key(scopedProfileId, scopedProvider));
    return record ? this._public(record) : null;
  }

  async remove(profileId, provider, expectedRevision) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    const expected = assertRevision(expectedRevision, false);
    if (!(await this._isProfileActive(scopedProfileId))) {
      throw codedError("profile_inactive", "profile is missing or inactive");
    }
    const key = this._key(scopedProfileId, scopedProvider);
    const current = this._credentials.get(key);
    if (!current) return false;
    if (current.revision !== expected) throw revisionConflict();
    return this._credentials.delete(key);
  }

  storageSnapshot() {
    return Array.from(this._credentials.values(), (record) => cloneJson(record));
  }

  eraseProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    this._erasedProfiles.add(id);
    let removed = 0;
    for (const [key, record] of this._credentials) {
      if (record.profileId !== id) continue;
      this._credentials.delete(key);
      removed += 1;
    }
    return removed;
  }

  _key(profileId, provider) {
    return JSON.stringify([profileId, provider]);
  }

  _purpose(profileId, provider) {
    return "oauth-credential:" + stableScope("oauth", profileId, provider);
  }

  _public(record) {
    return {
      schemaVersion: record.schemaVersion,
      profileId: record.profileId,
      provider: record.provider,
      credentials: this._crypto.decryptJson(
        record.credentialEnvelope,
        this._purpose(record.profileId, record.provider)
      ),
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
}

class MemoryHistoryRepository {
  constructor(options = {}) {
    this._clock = options.clock || Date.now;
    this._lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();
    this._isProfileActive = options.isProfileActive || (async () => true);
    if (typeof this._isProfileActive !== "function") {
      throw new TypeError("isProfileActive must be a function");
    }
    this._isDeviceBindingActive = options.isDeviceBindingActive || (() => true);
    if (typeof this._isDeviceBindingActive !== "function") {
      throw new TypeError("isDeviceBindingActive must be a function");
    }
    this._getGeneration = options.getGeneration || null;
    this._advanceGeneration = options.advanceGeneration || null;
    if (this._getGeneration !== null && typeof this._getGeneration !== "function") {
      throw new TypeError("getGeneration must be a function");
    }
    if (this._advanceGeneration !== null && typeof this._advanceGeneration !== "function") {
      throw new TypeError("advanceGeneration must be a function");
    }
    this._entries = new Map();
    this._generations = new Map();
    this._changeSequence = 0;
  }

  async getGeneration(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    if (this._getGeneration) return this._getGeneration(id);
    if (!(await this._isProfileActive(id))) return null;
    return this._generations.get(id) || 1;
  }

  async upsert(profileId, entry, expectedRevision, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(scopedProfileId, () =>
      this.upsertNow(scopedProfileId, entry, expectedRevision, options)
    );
  }

  async upsertNow(profileId, entry, expectedRevision, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const deviceBinding = this._deviceBinding(options);
    const generation = await this.getGeneration(scopedProfileId);
    if (generation === null) throw codedError("profile_inactive", "profile is missing or inactive");
    if (options.generation !== undefined && options.generation !== generation) {
      throw codedError("history_generation_changed", "history generation changed before write");
    }
    const input = assertPlainObject(entry, "history entry");
    const contentKey = assertContentKey(input.contentKey);
    const expected = assertRevision(expectedRevision, false);
    if (typeof input.completed !== "boolean") throw new TypeError("completed is invalid");
    const lastPlayedAt = parseTimestamp(input.lastPlayedAt, "lastPlayedAt");
    const canonicalIdentity = Object.prototype.hasOwnProperty.call(input, "canonicalIdentity")
      ? assertOptionalObject(input.canonicalIdentity, "canonicalIdentity")
      : null;
    const displaySnapshot = assertRequiredObject(
      Object.prototype.hasOwnProperty.call(input, "displaySnapshot")
        ? input.displaySnapshot
        : {},
      "displaySnapshot"
    );
    const playbackSnapshot = assertSafePlaybackSnapshot(
      Object.prototype.hasOwnProperty.call(input, "playbackSnapshot")
        ? input.playbackSnapshot
        : {}
    );
    const positionMs = assertNonNegativeInteger(input.positionMs, "positionMs");
    const durationMs = assertNonNegativeInteger(input.durationMs, "durationMs");
    const watchedMs = assertNonNegativeInteger(input.watchedMs, "watchedMs");
    const bindingCheck = this._checkDeviceBinding(scopedProfileId, deviceBinding);
    if (bindingCheck) await bindingCheck;
    const key = this._key(scopedProfileId, contentKey);
    const current = this._entries.get(key);
    const currentRevision = current ? current.revision : 0;
    if (currentRevision !== expected) throw revisionConflict();
    if (current && lastPlayedAt < current.lastPlayedAt) {
      throw codedError("stale_history", "history event predates stored state");
    }
    const now = readClock(this._clock);
    const record = {
      schemaVersion: 1,
      profileId: scopedProfileId,
      contentKey,
      canonicalIdentity,
      displaySnapshot,
      playbackSnapshot,
      positionMs,
      durationMs,
      watchedMs,
      completed: input.completed,
      revision: currentRevision + 1,
      changeSequence: this._nextChangeSequence(),
      lastPlayedAt,
      updatedAt: now,
      deletedAt: null,
    };
    this._entries.set(key, record);
    return cloneJson(record);
  }

  async get(profileId, contentKey) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    if (!(await this._isProfileActive(scopedProfileId))) return null;
    const key = this._key(scopedProfileId, assertContentKey(contentKey));
    const record = this._entries.get(key);
    return record && record.deletedAt === null ? cloneJson(record) : null;
  }

  async getForWrite(profileId, contentKey) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    if (!(await this._isProfileActive(scopedProfileId))) return null;
    const key = this._key(scopedProfileId, assertContentKey(contentKey));
    const record = this._entries.get(key);
    return record ? cloneJson(record) : null;
  }

  async list(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    if (!(await this._isProfileActive(scopedProfileId))) return [];
    const input = assertPlainObject(options, "history list options");
    const limit = input.limit === undefined ? 50 : assertPositiveInteger(input.limit, "history limit", 500);
    const cursor = parseHistoryCursor(input);
    return Array.from(this._entries.values())
      .filter(
        (record) =>
          record.profileId === scopedProfileId &&
          record.deletedAt === null &&
          (cursor.lastPlayedAt === null ||
            record.lastPlayedAt < cursor.lastPlayedAt ||
            (cursor.revision !== null &&
              record.lastPlayedAt === cursor.lastPlayedAt &&
              (record.revision < cursor.revision ||
                (record.revision === cursor.revision &&
                  record.contentKey > cursor.contentKey))))
      )
      .sort(
        (left, right) =>
          right.lastPlayedAt - left.lastPlayedAt ||
          right.revision - left.revision ||
          (left.contentKey < right.contentKey ? -1 : left.contentKey > right.contentKey ? 1 : 0)
      )
      .slice(0, limit)
      .map((record) => cloneJson(record));
  }

  async remove(profileId, contentKey, expectedRevision, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(scopedProfileId, () =>
      this.removeNow(scopedProfileId, contentKey, expectedRevision, options)
    );
  }

  async removeNow(profileId, contentKey, expectedRevision, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const deviceBinding = this._deviceBinding(options);
    const generation = await this.getGeneration(scopedProfileId);
    if (generation === null) throw codedError("profile_inactive", "profile is missing or inactive");
    if (options.generation !== undefined && options.generation !== generation) {
      throw codedError("history_generation_changed", "history generation changed before delete");
    }
    const scopedContentKey = assertContentKey(contentKey);
    const expected = assertRevision(expectedRevision, false);
    const bindingCheck = this._checkDeviceBinding(scopedProfileId, deviceBinding);
    if (bindingCheck) await bindingCheck;
    const key = this._key(scopedProfileId, scopedContentKey);
    const current = this._entries.get(key);
    if (!current || current.deletedAt !== null) return false;
    if (current.revision !== expected) throw revisionConflict();
    const now = readClock(this._clock);
    current.canonicalIdentity = null;
    current.displaySnapshot = {};
    current.playbackSnapshot = {};
    current.positionMs = 0;
    current.durationMs = 0;
    current.watchedMs = 0;
    current.completed = false;
    current.revision += 1;
    current.changeSequence = this._nextChangeSequence();
    current.updatedAt = now;
    current.deletedAt = Math.max(now, current.lastPlayedAt);
    return true;
  }

  async clear(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(id, () => this.clearNow(id));
  }

  async clearNow(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const current = await this.getGeneration(id);
    if (current === null) throw codedError("profile_inactive", "profile is missing or inactive");
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw codedError("history_generation_exhausted", "history generation exhausted");
    }
    const snapshot = this.snapshotProfileNow(id);
    this.deleteProfileEntriesNow(id);
    try {
      return await this.advanceGenerationNow(id, current);
    } catch (error) {
      this.restoreProfileNow(id, snapshot);
      throw error;
    }
  }

  snapshotProfileNow(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return {
      entries: Array.from(this._entries, ([key, record]) => [key, cloneJson(record)])
        .filter(([, record]) => record.profileId === id),
      hasLocalGeneration: this._generations.has(id),
      localGeneration: this._generations.get(id),
    };
  }

  restoreProfileNow(profileId, snapshot) {
    const id = assertIdentifier(profileId, "profile id");
    this.deleteProfileEntriesNow(id);
    for (const [key, record] of snapshot.entries) {
      this._entries.set(key, cloneJson(record));
    }
    if (snapshot.hasLocalGeneration) {
      this._generations.set(id, snapshot.localGeneration);
    } else {
      this._generations.delete(id);
    }
  }

  deleteProfileEntriesNow(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    for (const [key, record] of this._entries) {
      if (record.profileId === id) this._entries.delete(key);
    }
  }

  async advanceGenerationNow(profileId, expectedGeneration) {
    const id = assertIdentifier(profileId, "profile id");
    const current = assertPositiveInteger(
      expectedGeneration,
      "history generation",
      Number.MAX_SAFE_INTEGER
    );
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw codedError("history_generation_exhausted", "history generation exhausted");
    }
    const next = this._advanceGeneration
      ? await this._advanceGeneration(id, current)
      : current + 1;
    if (next !== current + 1) {
      throw codedError("history_generation_changed", "history generation changed during clear");
    }
    if (!this._advanceGeneration) this._generations.set(id, next);
    return next;
  }

  async changes(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    if (!(await this._isProfileActive(scopedProfileId))) return [];
    const input = assertPlainObject(options, "history change options");
    const afterSequence =
      input.afterSequence === undefined
        ? 0
        : assertNonNegativeInteger(input.afterSequence, "history afterSequence");
    const limit = input.limit === undefined ? 100 : assertPositiveInteger(input.limit, "history limit", 1000);
    return Array.from(this._entries.values())
      .filter(
        (record) => record.profileId === scopedProfileId && record.changeSequence > afterSequence
      )
      .sort((left, right) => left.changeSequence - right.changeSequence)
      .slice(0, limit)
      .map((record) => cloneJson(record));
  }

  storageSnapshot() {
    return Array.from(this._entries.values(), (record) => cloneJson(record));
  }

  eraseProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    for (const [key, record] of this._entries) {
      if (record.profileId === id) this._entries.delete(key);
    }
    this._generations.delete(id);
  }

  _key(profileId, contentKey) {
    return JSON.stringify([profileId, contentKey]);
  }

  _deviceBinding(options) {
    const input = assertPlainObject(options || {}, "history write options");
    const hasDeviceId = Object.prototype.hasOwnProperty.call(input, "deviceId");
    const hasGeneration = Object.prototype.hasOwnProperty.call(input, "deviceGeneration");
    if (!hasDeviceId && !hasGeneration) return null;
    if (!hasDeviceId || !hasGeneration) {
      throw new TypeError("history device binding is incomplete");
    }
    return {
      deviceId: assertIdentifier(input.deviceId, "device id"),
      generation: assertPositiveInteger(
        input.deviceGeneration,
        "device generation",
        Number.MAX_SAFE_INTEGER
      ),
    };
  }

  _checkDeviceBinding(profileId, binding) {
    if (binding === null) return null;
    const result = this._isDeviceBindingActive(
      profileId,
      binding.deviceId,
      binding.generation
    );
    if (result && typeof result.then === "function") {
      return Promise.resolve(result).then((active) => {
        if (!active) {
          throw codedError("device_generation_changed", "device binding changed before write");
        }
      });
    }
    if (!result) {
      throw codedError("device_generation_changed", "device binding changed before write");
    }
    return null;
  }

  _nextChangeSequence() {
    if (this._changeSequence >= Number.MAX_SAFE_INTEGER) {
      throw codedError("history_sequence_exhausted", "history change sequence exhausted");
    }
    this._changeSequence += 1;
    return this._changeSequence;
  }
}

class MemoryAddonCollectionBackupRepository {
  constructor(options = {}) {
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._maxBackupsPerProfile = options.maxBackupsPerProfile ?? 64;
    assertPositiveInteger(this._maxBackupsPerProfile, "maxBackupsPerProfile", 1024);
    this._backups = new Map();
  }

  async create(profileId, collection, reason) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const safeCollection = assertJsonValue(
      collection,
      "addon collection",
      4 * 1024 * 1024
    );
    if (!Array.isArray(safeCollection) || safeCollection.length > 256) {
      throw new TypeError("addon collection must be an array of at most 256 entries");
    }
    const scopedReason = assertBoundedString(reason, "backup reason", 256);
    if (this._profileCount(scopedProfileId) >= this._maxBackupsPerProfile) {
      throw codedError("backup_limit", "profile backup limit reached");
    }
    const id = assertIdentifier(this._idFactory("backup"), "backup id");
    if (this._backups.has(id)) throw codedError("backup_id_collision", "backup id collision");
    const now = readClock(this._clock);
    const record = {
      schemaVersion: 1,
      id,
      profileId: scopedProfileId,
      collectionEnvelope: this._crypto.encryptJson(
        safeCollection,
        this._purpose(scopedProfileId, id)
      ),
      reason: scopedReason,
      createdAt: now,
      restoredAt: null,
    };
    this._backups.set(id, record);
    return this._metadata(record);
  }

  async get(profileId, backupId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(backupId, "backup id");
    const record = this._backups.get(id);
    if (!record || record.profileId !== scopedProfileId) return null;
    return {
      ...this._metadata(record),
      collection: this._crypto.decryptJson(
        record.collectionEnvelope,
        this._purpose(scopedProfileId, id)
      ),
    };
  }

  async list(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(options, "backup list options");
    const limit = input.limit === undefined ? 20 : assertPositiveInteger(input.limit, "backup limit", 100);
    return Array.from(this._backups.values())
      .filter((record) => record.profileId === scopedProfileId)
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((record) => this._metadata(record));
  }

  async markRestored(profileId, backupId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(backupId, "backup id");
    const record = this._backups.get(id);
    if (!record || record.profileId !== scopedProfileId) return false;
    if (record.restoredAt === null) record.restoredAt = readClock(this._clock);
    return true;
  }

  storageSnapshot() {
    return Array.from(this._backups.values(), (record) => cloneJson(record));
  }

  eraseProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    let removed = 0;
    for (const [key, record] of this._backups) {
      if (record.profileId !== id) continue;
      this._backups.delete(key);
      removed += 1;
    }
    return removed;
  }

  _metadata(record) {
    return {
      schemaVersion: record.schemaVersion,
      id: record.id,
      profileId: record.profileId,
      reason: record.reason,
      createdAt: record.createdAt,
      restoredAt: record.restoredAt,
    };
  }

  _purpose(profileId, backupId) {
    return "addon-backup:" + stableScope("addon-backup", profileId, backupId);
  }

  _profileCount(profileId) {
    let count = 0;
    for (const record of this._backups.values()) {
      if (record.profileId === profileId) count += 1;
    }
    return count;
  }
}

class MemoryLegacyConfigAliasRepository {
  constructor() {
    this._aliases = new Map();
  }

  async getProfileId(legacyConfigHash) {
    return this._aliases.get(assertContentKey(legacyConfigHash)) || null;
  }

  async bind(profileId, legacyConfigHash) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const hash = assertContentKey(legacyConfigHash);
    const existing = this._aliases.get(hash);
    if (existing && existing !== scopedProfileId) {
      throw codedError("legacy_alias_conflict", "legacy config alias belongs to another profile");
    }
    this._aliases.set(hash, scopedProfileId);
    return { legacyConfigHash: hash, profileId: scopedProfileId };
  }

  storageSnapshot() {
    return Array.from(this._aliases.entries(), ([legacyConfigHash, profileId]) => ({
      legacyConfigHash,
      profileId,
    }));
  }
}

module.exports = {
  MemoryAddonCollectionBackupRepository,
  MemoryDeviceRepository,
  MemoryHistoryRepository,
  MemoryLegacyConfigAliasRepository,
  MemoryOAuthCredentialRepository,
};
