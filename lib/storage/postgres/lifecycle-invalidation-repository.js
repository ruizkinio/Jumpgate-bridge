"use strict";

const {
  assertInvalidationId,
  assertInvalidationKind,
  createInvalidationRecord,
} = require("../lifecycle-invalidation");
const {
  assertIdentifier,
  parseTimestamp,
  readClock,
} = require("../repository-utils");
const {
  affectedRows,
  dateParameter,
  firstRow,
  requireDatabase,
  toSafeInteger,
  toTimestamp,
} = require("./repository-helpers");

function mapInvalidationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    profileId: row.profile_id,
    profileRevision: toSafeInteger(row.profile_revision, "profile revision", 1),
    deviceId: row.device_id,
    deviceGeneration: row.device_generation === null
      ? null
      : toSafeInteger(row.device_generation, "device generation", 1),
    attemptCount: toSafeInteger(row.attempt_count, "lifecycle invalidation attempt count"),
    nextAttemptAt: toTimestamp(row.next_attempt_at, "lifecycle invalidation nextAttemptAt"),
    createdAt: toTimestamp(row.created_at, "lifecycle invalidation createdAt"),
    updatedAt: toTimestamp(row.updated_at, "lifecycle invalidation updatedAt"),
  };
}

class PostgresLifecycleInvalidationRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    this._clock = options.clock || Date.now;
  }

  async enqueueProfile(profileId, profileRevision, queryTarget = this._db) {
    return mapInvalidationRow(await this.enqueueProfileRow(
      profileId,
      profileRevision,
      queryTarget
    ));
  }

  enqueueProfileRow(profileId, profileRevision, queryTarget = this._db) {
    return this._enqueueRow({ kind: "profile", profileId, profileRevision }, queryTarget);
  }

  async enqueueDevice(
    profileId,
    profileRevision,
    deviceId,
    deviceGeneration,
    queryTarget = this._db
  ) {
    return mapInvalidationRow(await this.enqueueDeviceRow(
      profileId,
      profileRevision,
      deviceId,
      deviceGeneration,
      queryTarget
    ));
  }

  enqueueDeviceRow(
    profileId,
    profileRevision,
    deviceId,
    deviceGeneration,
    queryTarget = this._db
  ) {
    return this._enqueueRow(
      { kind: "device", profileId, profileRevision, deviceId, deviceGeneration },
      queryTarget
    );
  }

  async getPending(kind, profileId, deviceId = null, queryTarget = this._db) {
    return mapInvalidationRow(await this.getPendingRow(
      kind,
      profileId,
      deviceId,
      queryTarget
    ));
  }

  async getPendingRow(kind, profileId, deviceId = null, queryTarget = this._db) {
    const scopedKind = assertInvalidationKind(kind);
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedDeviceId = scopedKind === "device"
      ? assertIdentifier(deviceId, "device id")
      : null;
    return firstRow(await queryTarget.query(
      `SELECT * FROM lifecycle_invalidations
        WHERE kind = $1 AND profile_id = $2 AND device_id IS NOT DISTINCT FROM $3
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [scopedKind, scopedProfileId, scopedDeviceId]
    ));
  }

  async listPending(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("pending invalidation limit is invalid");
    }
    const result = await this._db.query(
      `SELECT * FROM lifecycle_invalidations
        WHERE next_attempt_at <= $1
        ORDER BY next_attempt_at, created_at, id LIMIT $2`,
      [dateParameter(readClock(this._clock), "lifecycle invalidation timestamp"), limit]
    );
    return (result.rows || []).map(mapInvalidationRow);
  }

  async complete(invalidationId) {
    const result = await this._db.query(
      "DELETE FROM lifecycle_invalidations WHERE id = $1",
      [assertInvalidationId(invalidationId)]
    );
    return affectedRows(result) === 1;
  }

  async defer(invalidationId, expectedAttemptCount, nextAttemptAt) {
    const id = assertInvalidationId(invalidationId);
    if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
      throw new TypeError("lifecycle invalidation attempt count is invalid");
    }
    const retryAt = parseTimestamp(nextAttemptAt, "lifecycle invalidation retry timestamp");
    const result = await this._db.query(
      `UPDATE lifecycle_invalidations
          SET attempt_count = attempt_count + 1, next_attempt_at = $2, updated_at = $3
        WHERE id = $1 AND attempt_count = $4`,
      [
        id,
        dateParameter(retryAt, "lifecycle invalidation retry timestamp"),
        dateParameter(readClock(this._clock), "lifecycle invalidation updatedAt"),
        expectedAttemptCount,
      ]
    );
    return affectedRows(result) === 1;
  }

  async _enqueueRow(input, queryTarget) {
    if (!queryTarget || typeof queryTarget.query !== "function") {
      throw new TypeError("lifecycle invalidation query target is invalid");
    }
    const record = createInvalidationRecord(input, readClock(this._clock));
    const result = await queryTarget.query(
      `INSERT INTO lifecycle_invalidations (
         id, kind, profile_id, profile_revision, device_id, device_generation,
         attempt_count, next_attempt_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [
        record.id,
        record.kind,
        record.profileId,
        record.profileRevision,
        record.deviceId,
        record.deviceGeneration,
        dateParameter(record.createdAt, "lifecycle invalidation createdAt"),
      ]
    );
    const inserted = firstRow(result);
    if (inserted) return inserted;
    return firstRow(await queryTarget.query(
      "SELECT * FROM lifecycle_invalidations WHERE id = $1",
      [record.id]
    ));
  }
}

module.exports = {
  PostgresLifecycleInvalidationRepository,
  mapInvalidationRow,
};
