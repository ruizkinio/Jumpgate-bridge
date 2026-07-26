"use strict";

const crypto = require("node:crypto");
const {
  addDuration,
  assertIdentifier,
  assertPlainObject,
  assertPositiveInteger,
  codedError,
  readClock,
} = require("../repository-utils");
const {
  PostgresLifecycleInvalidationRepository,
  mapInvalidationRow,
} = require("./lifecycle-invalidation-repository");
const {
  PostgresSubtitleManifestRepository,
} = require("./subtitle-manifest-repository");
const {
  PostgresPlaybackSessionRepository,
} = require("./playback-session-repository");
const {
  affectedRows,
  assertDisplayName,
  dateParameter,
  firstRow,
  lockActiveProfile,
  mapDeviceRow,
  requireDatabase,
  toSafeInteger,
  toTimestamp,
  uniqueConstraint,
} = require("./repository-helpers");

const DEFAULT_DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_DEVICE_TOUCH_INTERVAL_MS = 15 * 60 * 1000;

function translateRegistrationError(error) {
  if (uniqueConstraint(error, "devices_pkey")) {
    throw codedError("device_id_collision", "device id collision");
  }
  if (uniqueConstraint(error, "devices_token_hash_key")) {
    throw codedError("device_token_collision", "device token collision");
  }
  if (uniqueConstraint(error, "devices_pairing_id_key")) {
    throw codedError(
      "pairing_device_conflict",
      "pairing device registration conflicts with existing data"
    );
  }
  throw error;
}

class PostgresDeviceRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._ttlMs = options.ttlMs ?? DEFAULT_DEVICE_TTL_MS;
    this._touchIntervalMs = options.touchIntervalMs ?? DEFAULT_DEVICE_TOUCH_INTERVAL_MS;
    this._maxDevicesPerProfile = options.maxDevicesPerProfile ?? 32;
    this._lifecycleInvalidations =
      options.lifecycleInvalidations ||
      new PostgresLifecycleInvalidationRepository({ database: this._db, clock: this._clock });
    this._playbackSessions =
      options.playbackSessions ||
      new PostgresPlaybackSessionRepository({
        database: this._db,
        tokenService: this._tokens,
        clock: this._clock,
      });
    this._subtitleManifests =
      options.subtitleManifests ||
      new PostgresSubtitleManifestRepository({
        database: this._db,
        tokenService: this._tokens,
        clock: this._clock,
      });
    assertPositiveInteger(this._ttlMs, "device ttl", 2 * 365 * 24 * 60 * 60 * 1000);
    assertPositiveInteger(this._touchIntervalMs, "device touch interval", this._ttlMs);
    assertPositiveInteger(this._maxDevicesPerProfile, "maxDevicesPerProfile", 1024);
  }

  async register(profileId, input = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const details = assertPlainObject(input, "device input");
    const now = readClock(this._clock);
    const pairingId = details.pairingId === undefined
      ? null
      : assertIdentifier(details.pairingId, "pairing id");
    const displayName = assertDisplayName(details.displayName, "device displayName");
    let suppliedTokenHash = null;
    if (details.deviceToken !== undefined) {
      suppliedTokenHash = this._tokens.hashToken("device", details.deviceToken);
    }

    let registered;
    try {
      registered = await this._db.transaction(async (transaction) => {
        await lockActiveProfile(transaction, scopedProfileId);
        if (pairingId !== null) {
          const existing = firstRow(
            await transaction.query(
              "SELECT * FROM devices WHERE pairing_id = $1 FOR UPDATE",
              [pairingId]
            )
          );
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
            return { row: existing, deviceToken: details.deviceToken };
          }
        }

        const countRow = firstRow(
          await transaction.query(
            `SELECT count(*)::bigint AS active_count
               FROM devices
              WHERE profile_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
            [scopedProfileId, dateParameter(now, "device count timestamp")]
          )
        );
        const activeCount = countRow
          ? toSafeInteger(countRow.active_count, "active device count")
          : 0;
        if (activeCount >= this._maxDevicesPerProfile) {
          throw codedError("device_limit", "profile device limit reached");
        }

        const deviceId = assertIdentifier(
          details.deviceId === undefined ? this._idFactory("device") : details.deviceId,
          "device id"
        );
        const issued = details.deviceToken === undefined
          ? this._tokens.issue("device", 32)
          : { token: details.deviceToken, tokenHash: suppliedTokenHash };
        const expiresAt = addDuration(now, this._ttlMs, "device expiry");
        const inserted = firstRow(
          await transaction.query(
            `INSERT INTO devices (
               id, profile_id, schema_version, token_hash, display_name, pairing_id,
               created_at, last_seen_at, expires_at, revoked_at
             ) VALUES ($1, $2, 1, $3, $4, $5, $6, $6, $7, NULL)
             RETURNING *`,
            [
              deviceId,
              scopedProfileId,
              issued.tokenHash,
              displayName,
              pairingId,
              dateParameter(now, "device createdAt"),
              dateParameter(expiresAt, "device expiresAt"),
            ]
          )
        );
        if (!inserted) throw new Error("device insert did not return a row");
        return { row: inserted, deviceToken: issued.token };
      });
    } catch (error) {
      translateRegistrationError(error);
    }
    return {
      device: mapDeviceRow(registered.row),
      deviceToken: registered.deviceToken,
    };
  }

  async authenticate(deviceToken) {
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("device", deviceToken);
    } catch (_err) {
      return null;
    }
    const now = readClock(this._clock);
    const row = await this._db.transaction(async (transaction) => {
      const owner = firstRow(
        await transaction.query(
          "SELECT profile_id FROM devices WHERE token_hash = $1",
          [tokenHash]
        )
      );
      if (!owner) return null;
      const profile = firstRow(
        await transaction.query(
          "SELECT id, status FROM profiles WHERE id = $1 FOR UPDATE",
          [owner.profile_id]
        )
      );
      if (!profile || profile.status !== "active") return null;
      let row = firstRow(
        await transaction.query(
          `SELECT * FROM devices
            WHERE token_hash = $1 AND profile_id = $2
            FOR UPDATE`,
          [tokenHash, owner.profile_id]
        )
      );
      if (
        !row ||
        row.revoked_at !== null ||
        toTimestamp(row.expires_at, "device expiresAt") <= now
      ) {
        return null;
      }

      const lastSeenAt = toTimestamp(row.last_seen_at, "device lastSeenAt");
      if (now - lastSeenAt >= this._touchIntervalMs) {
        const expiresAt = addDuration(now, this._ttlMs, "device expiry");
        const result = await transaction.query(
          `UPDATE devices
              SET last_seen_at = $3, expires_at = $4
            WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL
            RETURNING *`,
          [
            row.id,
            tokenHash,
            dateParameter(now, "device lastSeenAt"),
            dateParameter(expiresAt, "device expiresAt"),
          ]
        );
        if (affectedRows(result) !== 1) return null;
        row = firstRow(result);
      }
      return row;
    });
    return row ? mapDeviceRow(row) : null;
  }

  async revoke(profileId, deviceId) {
    const result = await this.revokeWithInvalidation(profileId, deviceId);
    return result.revoked;
  }

  async revokeWithInvalidation(profileId, deviceId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    const outcome = await this._db.transaction(async (transaction) => {
      const profile = firstRow(await transaction.query(
        "SELECT id, status, revision FROM profiles WHERE id = $1 FOR UPDATE",
        [scopedProfileId]
      ));
      if (!profile || profile.status !== "active") {
        throw codedError("profile_inactive", "profile is missing or inactive");
      }
      const current = firstRow(
        await transaction.query(
          "SELECT * FROM devices WHERE id = $1 AND profile_id = $2 FOR UPDATE",
          [id, scopedProfileId]
        )
      );
      if (!current) return { revoked: false, invalidationRow: null };
      if (current.revoked_at !== null) {
        await this._playbackSessions.invalidateDeviceInTransaction(
          transaction,
          scopedProfileId,
          id,
          toSafeInteger(current.generation, "device generation", 1)
        );
        await this._subtitleManifests.requestDeviceDeletionInTransaction(
          transaction,
          scopedProfileId,
          id,
          "device_revoked"
        );
        return {
          revoked: true,
          invalidationRow: await this._lifecycleInvalidations.getPendingRow(
            "device",
            scopedProfileId,
            id,
            transaction
          ),
        };
      }
      const generation = toSafeInteger(current.generation, "device generation", 1);
      if (generation >= Number.MAX_SAFE_INTEGER) {
        throw codedError("device_generation_exhausted", "device generation exhausted");
      }
      const now = readClock(this._clock);
      const result = await transaction.query(
        `UPDATE devices
            SET revoked_at = $3, generation = generation + 1
          WHERE id = $1 AND profile_id = $2 AND revoked_at IS NULL
            AND generation = $4
          RETURNING *`,
        [id, scopedProfileId, dateParameter(now, "device revokedAt"), generation]
      );
      if (affectedRows(result) !== 1) {
        throw codedError("device_generation_changed", "device generation changed during revocation");
      }
      const revokedGeneration = toSafeInteger(
        firstRow(result).generation,
        "device generation",
        1
      );
      await this._playbackSessions.invalidateDeviceInTransaction(
        transaction,
        scopedProfileId,
        id,
        revokedGeneration,
        now
      );
      await this._subtitleManifests.requestDeviceDeletionInTransaction(
        transaction,
        scopedProfileId,
        id,
        "device_revoked",
        now
      );
      const invalidationRow = await this._lifecycleInvalidations.enqueueDeviceRow(
        scopedProfileId,
        toSafeInteger(profile.revision, "profile revision", 1),
        id,
        revokedGeneration,
        transaction
      );
      return { revoked: true, invalidationRow };
    });
    return Object.freeze({
      revoked: outcome.revoked,
      invalidation: mapInvalidationRow(outcome.invalidationRow),
    });
  }

  async getGeneration(profileId, deviceId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    const row = firstRow(
      await this._db.query(
        `SELECT generation FROM devices WHERE id = $1 AND profile_id = $2
          AND EXISTS (
            SELECT 1 FROM profiles WHERE id = $2 AND status = 'active'
          )`,
        [id, scopedProfileId]
      )
    );
    return row ? toSafeInteger(row.generation, "device generation", 1) : null;
  }

  async isActiveBinding(profileId, deviceId, generation) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    const expected = assertPositiveInteger(
      generation,
      "device generation",
      Number.MAX_SAFE_INTEGER
    );
    const row = firstRow(
      await this._db.query(
        `SELECT generation FROM devices
          WHERE id = $1 AND profile_id = $2 AND generation = $3
            AND revoked_at IS NULL AND expires_at > $4
            AND EXISTS (
              SELECT 1 FROM profiles WHERE id = $2 AND status = 'active'
            )`,
        [
          id,
          scopedProfileId,
          expected,
          dateParameter(readClock(this._clock), "device binding timestamp"),
        ]
      )
    );
    return Boolean(row);
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
    const validate = () => this._db.transaction(async (transaction) => {
      await this._assertClaimBinding(
        transaction,
        scopedProfileId,
        id,
        expectedProfileRevision,
        expectedDeviceGeneration
      );
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
    return this._db.transaction(
      async (transaction) => {
        await this._assertDisclosureBinding(
          transaction,
          scopedProfileId,
          id,
          expectedProfileRevision,
          expectedDeviceGeneration
        );
        return true;
      },
      {
        beforeCommit() {
          const emitted = emitSync();
          if (emitted && typeof emitted.then === "function") {
            throw new TypeError("disclosure emitter must be synchronous");
          }
        },
      }
    );
  }

  async list(profileId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const result = await this._db.query(
      `SELECT d.* FROM devices d
        JOIN profiles p ON p.id = d.profile_id
        WHERE d.profile_id = $1 AND p.status = 'active'
          AND d.revoked_at IS NULL AND d.expires_at > $2
        ORDER BY d.created_at, d.id`,
      [scopedProfileId, dateParameter(readClock(this._clock), "device list timestamp")]
    );
    return (result.rows || []).map(mapDeviceRow);
  }

  async _assertClaimBinding(
    transaction,
    profileId,
    deviceId,
    expectedProfileRevision,
    expectedDeviceGeneration
  ) {
    const profile = firstRow(await transaction.query(
      "SELECT id, status, revision FROM profiles WHERE id = $1 FOR UPDATE",
      [profileId]
    ));
    if (
      !profile ||
      profile.status !== "active" ||
      toSafeInteger(profile.revision, "profile revision", 1) !== expectedProfileRevision
    ) {
      throw codedError(
        "profile_generation_changed",
        "profile generation changed before playback claim"
      );
    }
    const device = firstRow(await transaction.query(
      "SELECT * FROM devices WHERE id = $1 AND profile_id = $2 FOR UPDATE",
      [deviceId, profileId]
    ));
    if (
      !device ||
      device.revoked_at !== null ||
      toSafeInteger(device.generation, "device generation", 1) !== expectedDeviceGeneration ||
      toTimestamp(device.expires_at, "device expiresAt") <= readClock(this._clock)
    ) {
      throw codedError(
        "device_generation_changed",
        "device generation changed before playback claim"
      );
    }
  }

  async _assertDisclosureBinding(
    transaction,
    profileId,
    deviceId,
    expectedProfileRevision,
    expectedDeviceGeneration
  ) {
    const profile = firstRow(await transaction.query(
      "SELECT id, status, revision FROM profiles WHERE id = $1 FOR SHARE",
      [profileId]
    ));
    if (
      !profile ||
      profile.status !== "active" ||
      toSafeInteger(profile.revision, "profile revision", 1) !== expectedProfileRevision
    ) {
      throw codedError(
        "profile_generation_changed",
        "profile generation changed before disclosure"
      );
    }
    const device = firstRow(await transaction.query(
      "SELECT * FROM devices WHERE id = $1 AND profile_id = $2 FOR SHARE",
      [deviceId, profileId]
    ));
    if (
      !device ||
      device.revoked_at !== null ||
      toSafeInteger(device.generation, "device generation", 1) !== expectedDeviceGeneration ||
      toTimestamp(device.expires_at, "device expiresAt") <= readClock(this._clock)
    ) {
      throw codedError(
        "device_generation_changed",
        "device generation changed before disclosure"
      );
    }
  }
}

module.exports = {
  PostgresDeviceRepository,
};
