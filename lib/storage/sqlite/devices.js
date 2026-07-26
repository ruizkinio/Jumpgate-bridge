"use strict";

const crypto = require("node:crypto");

const { ProfileLifecycleCoordinator } = require("../lifecycle-invalidation");
const {
  addDuration,
  assertDisplayName,
  assertIdentifier,
  assertPlainObject,
  assertPositiveInteger,
  cloneJson,
  codedError,
  readClock,
} = require("../repository-utils");
const { withImmediateTransaction } = require("./connection");
const { SqliteLifecycleInvalidationRepository } = require("./lifecycle-invalidations");
const { SqlitePlaybackSessionRepository } = require("./playback-sessions");
const { SqliteSubtitleManifestRepository } = require("./subtitle-manifests");
const {
  isActiveProfile,
  normalizeRepositoryOptions,
  prepareProfileStatus,
  requireActiveProfile,
  requireDatabase,
} = require("./helpers");

const DEFAULT_DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_DEVICE_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

function mapDevice(row, includeTokenHash = false) {
  if (!row) return null;
  const device = {
    schemaVersion: row.schema_version,
    id: row.id,
    profileId: row.profile_id,
    pairingId: row.pairing_id,
    generation: row.generation,
    displayName: row.display_name,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
  if (includeTokenHash) device.tokenHash = row.token_hash;
  return device;
}

class SqliteDeviceRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._db = requireDatabase(options);
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._ttlMs = options.ttlMs ?? DEFAULT_DEVICE_TTL_MS;
    this._touchIntervalMs = options.touchIntervalMs ?? DEFAULT_DEVICE_TOUCH_INTERVAL_MS;
    this._maxDevicesPerProfile = options.maxDevicesPerProfile ?? 32;
    this._lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();
    this._lifecycleInvalidations =
      options.lifecycleInvalidations ||
      new SqliteLifecycleInvalidationRepository({ database: this._db, clock: this._clock });
    this._playbackSessions =
      options.playbackSessions ||
      new SqlitePlaybackSessionRepository({
        database: this._db,
        tokenService: this._tokens,
        clock: this._clock,
        lifecycleCoordinator: this._lifecycleCoordinator,
      });
    this._subtitleManifests =
      options.subtitleManifests ||
      new SqliteSubtitleManifestRepository({
        database: this._db,
        tokenService: this._tokens,
        clock: this._clock,
        lifecycleCoordinator: this._lifecycleCoordinator,
      });
    assertPositiveInteger(this._ttlMs, "device ttl", 2 * 365 * 24 * 60 * 60 * 1000);
    assertPositiveInteger(this._touchIntervalMs, "device touch interval", this._ttlMs);
    assertPositiveInteger(this._maxDevicesPerProfile, "maxDevicesPerProfile", 1024);

    this._profileStatus = prepareProfileStatus(this._db);
    this._getById = this._db.prepare("SELECT * FROM devices WHERE id = ?");
    this._getByPairing = this._db.prepare("SELECT * FROM devices WHERE pairing_id = ?");
    this._getByTokenHash = this._db.prepare("SELECT * FROM devices WHERE token_hash = ?");
    this._list = this._db.prepare(`
      SELECT * FROM devices
      WHERE profile_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at, id
    `);
    this._hasId = this._db.prepare("SELECT 1 AS present FROM devices WHERE id = ?");
    this._hasTokenHash = this._db.prepare(
      "SELECT 1 AS present FROM devices WHERE token_hash = ?"
    );
    this._activeCount = this._db.prepare(`
      SELECT count(*) AS count
      FROM devices
      WHERE profile_id = ? AND revoked_at IS NULL AND expires_at > ?
    `);
    this._insert = this._db.prepare(`
      INSERT INTO devices (
        id, profile_id, schema_version, pairing_id, token_hash, display_name,
        created_at, last_seen_at, expires_at, revoked_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, NULL)
    `);
    this._touch = this._db.prepare(`
      UPDATE devices SET last_seen_at = ?, expires_at = ?
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ?
    `);
    this._revoke = this._db.prepare(`
      UPDATE devices SET revoked_at = ?, generation = generation + 1
      WHERE id = ? AND profile_id = ? AND revoked_at IS NULL AND generation < ?
    `);
    this._activeBinding = this._db.prepare(`
      SELECT generation FROM devices
      WHERE id = ? AND profile_id = ? AND generation = ?
        AND revoked_at IS NULL AND expires_at > ?
    `);
    this._snapshot = this._db.prepare("SELECT * FROM devices ORDER BY rowid");
  }

  async register(profileId, input = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const details = assertPlainObject(input, "device input");
    const now = readClock(this._clock);
    const pairingId =
      details.pairingId === undefined
        ? null
        : assertIdentifier(details.pairingId, "pairing id");
    let suppliedTokenHash = null;
    if (details.deviceToken !== undefined) {
      suppliedTokenHash = this._tokens.hashToken("device", details.deviceToken);
    }

    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, scopedProfileId);
      if (pairingId !== null) {
        const existing = this._getByPairing.get(pairingId);
        if (existing) {
          if (
            existing.profile_id !== scopedProfileId ||
            existing.revoked_at !== null ||
            suppliedTokenHash === null ||
            suppliedTokenHash !== existing.token_hash ||
            (details.deviceId !== undefined && details.deviceId !== existing.id)
          ) {
            throw codedError(
              "pairing_device_conflict",
              "pairing device registration conflicts with existing data"
            );
          }
          return { device: mapDevice(existing), deviceToken: details.deviceToken };
        }
      }

      if (this._activeCount.get(scopedProfileId, now).count >= this._maxDevicesPerProfile) {
        throw codedError("device_limit", "profile device limit reached");
      }
      const deviceId = assertIdentifier(
        details.deviceId === undefined ? this._idFactory("device") : details.deviceId,
        "device id"
      );
      if (this._hasId.get(deviceId)) {
        throw codedError("device_id_collision", "device id collision");
      }
      const issued =
        details.deviceToken === undefined
          ? this._tokens.issue("device", 32)
          : { token: details.deviceToken, tokenHash: suppliedTokenHash };
      if (this._hasTokenHash.get(issued.tokenHash)) {
        throw codedError("device_token_collision", "device token collision");
      }
      const expiresAt = addDuration(now, this._ttlMs, "device expiry");
      this._insert.run(
        deviceId,
        scopedProfileId,
        pairingId,
        issued.tokenHash,
        assertDisplayName(details.displayName, "device displayName"),
        now,
        now,
        expiresAt
      );
      return {
        device: mapDevice(this._getById.get(deviceId)),
        deviceToken: issued.token,
      };
    });
  }

  async authenticate(deviceToken) {
    const now = readClock(this._clock);
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("device", deviceToken);
    } catch (_error) {
      return null;
    }

    return withImmediateTransaction(this._db, () => {
      let record = this._getByTokenHash.get(tokenHash);
      if (!record || record.revoked_at !== null || record.expires_at <= now) return null;
      if (!isActiveProfile(this._profileStatus, record.profile_id)) return null;
      if (now - record.last_seen_at >= this._touchIntervalMs) {
        const expiresAt = addDuration(now, this._ttlMs, "device expiry");
        this._touch.run(now, expiresAt, record.id, now);
        record = this._getById.get(record.id);
      }
      return mapDevice(record);
    });
  }

  async revoke(profileId, deviceId) {
    const result = await this.revokeWithInvalidation(profileId, deviceId);
    return result.revoked;
  }

  async revokeWithInvalidation(profileId, deviceId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    return this._lifecycleCoordinator.run(scopedProfileId, async () =>
      withImmediateTransaction(this._db, () => {
        const profile = requireActiveProfile(this._profileStatus, scopedProfileId);
        const current = this._getById.get(id);
        if (!current || current.profile_id !== scopedProfileId) {
          return Object.freeze({ revoked: false, invalidation: null });
        }
        if (current.revoked_at !== null) {
          this._playbackSessions.invalidateDeviceInTransaction(
            scopedProfileId,
            id,
            current.generation
          );
          this._subtitleManifests.requestDeviceDeletionNow(
            scopedProfileId,
            id,
            "device_revoked"
          );
          return Object.freeze({
            revoked: true,
            invalidation: this._lifecycleInvalidations.getPendingNow(
              "device",
              scopedProfileId,
              id
            ),
          });
        }
        if (current.generation >= Number.MAX_SAFE_INTEGER) {
          throw codedError("device_generation_exhausted", "device generation exhausted");
        }
        const nextGeneration = current.generation + 1;
        const now = readClock(this._clock);
        const result = this._revoke.run(
          now,
          id,
          scopedProfileId,
          Number.MAX_SAFE_INTEGER
        );
        if (result.changes !== 1) {
          throw codedError("device_generation_exhausted", "device generation exhausted");
        }
        this._playbackSessions.invalidateDeviceInTransaction(
          scopedProfileId,
          id,
          nextGeneration,
          now
        );
        this._subtitleManifests.requestDeviceDeletionNow(
          scopedProfileId,
          id,
          "device_revoked",
          now
        );
        const invalidation = this._lifecycleInvalidations.enqueueDevice(
          scopedProfileId,
          profile.revision,
          id,
          nextGeneration
        );
        return Object.freeze({ revoked: true, invalidation });
      })
    );
  }

  async getGeneration(profileId, deviceId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    return withImmediateTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return null;
      const row = this._getById.get(id);
      return row && row.profile_id === scopedProfileId ? row.generation : null;
    });
  }

  async isActiveBinding(profileId, deviceId, generation) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    const expected = assertPositiveInteger(
      generation,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    return withImmediateTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return false;
      return Boolean(
        this._activeBinding.get(
          id,
          scopedProfileId,
          expected,
          readClock(this._clock)
        )
      );
    });
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
    const expectedProfileRevision = assertPositiveInteger(
      profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    );
    const expectedDeviceGeneration = assertPositiveInteger(
      deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    if (typeof operation !== "function") throw new TypeError("claim admission operation is required");
    const validate = () => this._lifecycleCoordinator.run(scopedProfileId, async () => {
      const assertCurrentBinding = () => {
        const profile = this._profileStatus.get(scopedProfileId);
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
        const record = this._activeBinding.get(
          id,
          scopedProfileId,
          expectedDeviceGeneration,
          readClock(this._clock)
        );
        if (!record) {
          throw codedError(
            "device_generation_changed",
            "device generation changed before playback claim"
          );
        }
      };
      assertCurrentBinding();
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
    const expectedProfileRevision = assertPositiveInteger(
      profileRevision,
      "profile revision",
      Number.MAX_SAFE_INTEGER
    );
    const expectedDeviceGeneration = assertPositiveInteger(
      deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    if (typeof emitSync !== "function") throw new TypeError("disclosure emitter is required");
    return this._lifecycleCoordinator.run(scopedProfileId, async () =>
      withImmediateTransaction(this._db, () => {
        const profile = this._profileStatus.get(scopedProfileId);
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
        const record = this._activeBinding.get(
          id,
          scopedProfileId,
          expectedDeviceGeneration,
          readClock(this._clock)
        );
        if (!record) {
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
      })
    );
  }

  async list(profileId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    return withImmediateTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return [];
      return this._list
        .all(scopedProfileId, readClock(this._clock))
        .map((row) => mapDevice(row));
    });
  }

  storageSnapshot() {
    return this._snapshot.all().map((row) => cloneJson(mapDevice(row, true)));
  }
}

module.exports = {
  DEFAULT_DEVICE_TOUCH_INTERVAL_MS,
  DEFAULT_DEVICE_TTL_MS,
  SqliteDeviceRepository,
};
