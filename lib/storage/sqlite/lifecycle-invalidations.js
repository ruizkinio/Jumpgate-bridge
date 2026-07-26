"use strict";

const {
  assertInvalidationId,
  assertInvalidationKind,
  createInvalidationRecord,
} = require("../lifecycle-invalidation");
const {
  assertIdentifier,
  cloneJson,
  parseTimestamp,
  readClock,
} = require("../repository-utils");
const { normalizeRepositoryOptions, requireDatabase } = require("./helpers");

function mapInvalidation(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    deviceId: row.device_id,
    deviceGeneration: row.device_generation,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class SqliteLifecycleInvalidationRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    this._db = requireDatabase(options);
    this._clock = options.clock || Date.now;
    this._insert = this._db.prepare(`
      INSERT INTO lifecycle_invalidations (
        id, kind, profile_id, profile_revision, device_id, device_generation,
        attempt_count, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING
    `);
    this._getById = this._db.prepare("SELECT * FROM lifecycle_invalidations WHERE id = ?");
    this._getPending = this._db.prepare(`
      SELECT * FROM lifecycle_invalidations
      WHERE kind = ? AND profile_id = ? AND device_id IS ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `);
    this._listPending = this._db.prepare(`
      SELECT * FROM lifecycle_invalidations
      WHERE next_attempt_at <= ?
      ORDER BY next_attempt_at, created_at, id LIMIT ?
    `);
    this._complete = this._db.prepare("DELETE FROM lifecycle_invalidations WHERE id = ?");
    this._defer = this._db.prepare(`
      UPDATE lifecycle_invalidations
      SET attempt_count = attempt_count + 1, next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND attempt_count = ?
    `);
    this._snapshot = this._db.prepare(
      "SELECT * FROM lifecycle_invalidations ORDER BY created_at, id"
    );
  }

  enqueueProfile(profileId, profileRevision) {
    return this._enqueue({ kind: "profile", profileId, profileRevision });
  }

  enqueueDevice(profileId, profileRevision, deviceId, deviceGeneration) {
    return this._enqueue({
      kind: "device",
      profileId,
      profileRevision,
      deviceId,
      deviceGeneration,
    });
  }

  async getPending(kind, profileId, deviceId = null) {
    return this.getPendingNow(kind, profileId, deviceId);
  }

  getPendingNow(kind, profileId, deviceId = null) {
    const scopedKind = assertInvalidationKind(kind);
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedDeviceId = scopedKind === "device"
      ? assertIdentifier(deviceId, "device id")
      : null;
    return mapInvalidation(this._getPending.get(scopedKind, scopedProfileId, scopedDeviceId));
  }

  async listPending(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("pending invalidation limit is invalid");
    }
    return this._listPending
      .all(readClock(this._clock), limit)
      .map((row) => mapInvalidation(row));
  }

  async complete(invalidationId) {
    return this._complete.run(assertInvalidationId(invalidationId)).changes === 1;
  }

  async defer(invalidationId, expectedAttemptCount, nextAttemptAt) {
    const id = assertInvalidationId(invalidationId);
    if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
      throw new TypeError("lifecycle invalidation attempt count is invalid");
    }
    const retryAt = parseTimestamp(nextAttemptAt, "lifecycle invalidation retry timestamp");
    return this._defer.run(
      retryAt,
      readClock(this._clock),
      id,
      expectedAttemptCount
    ).changes === 1;
  }

  storageSnapshot() {
    return this._snapshot.all().map((row) => cloneJson(mapInvalidation(row)));
  }

  _enqueue(input) {
    const record = createInvalidationRecord(input, readClock(this._clock));
    this._insert.run(
      record.id,
      record.kind,
      record.profileId,
      record.profileRevision,
      record.deviceId,
      record.deviceGeneration,
      record.nextAttemptAt,
      record.createdAt,
      record.updatedAt
    );
    return mapInvalidation(this._getById.get(record.id));
  }
}

module.exports = {
  SqliteLifecycleInvalidationRepository,
};
