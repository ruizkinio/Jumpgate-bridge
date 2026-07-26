"use strict";

const {
  assertIdentifier,
  assertNonNegativeInteger,
  assertPlainObject,
  assertPositiveInteger,
  assertRevision,
  codedError,
  parseTimestamp,
  readClock,
  revisionConflict,
} = require("../repository-utils");
const {
  affectedRows,
  assertContentKey,
  assertOptionalObject,
  assertRequiredObject,
  assertSafePlaybackSnapshot,
  dateParameter,
  firstRow,
  lockActiveProfileHistoryGeneration,
  mapHistoryRow,
  requireDatabase,
  resultRows,
  toSafeInteger,
  toTimestamp,
} = require("./repository-helpers");

function translateSequenceError(error) {
  if (
    error &&
    error.code === "23514" &&
    error.constraint === "cloud_history_change_seq_js_safe"
  ) {
    throw codedError("history_sequence_exhausted", "history change sequence exhausted");
  }
  throw error;
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

function parseDeviceBinding(options) {
  const input = assertPlainObject(options || {}, "history write options");
  const hasDeviceId = Object.prototype.hasOwnProperty.call(input, "deviceId");
  const hasGeneration = Object.prototype.hasOwnProperty.call(input, "deviceGeneration");
  if (!hasDeviceId && !hasGeneration) return { input, binding: null };
  if (!hasDeviceId || !hasGeneration) {
    throw new TypeError("history device binding is incomplete");
  }
  return {
    input,
    binding: {
      deviceId: assertIdentifier(input.deviceId, "device id"),
      generation: assertPositiveInteger(
        input.deviceGeneration,
        "device generation",
        Number.MAX_SAFE_INTEGER
      ),
    },
  };
}

async function lockDeviceBinding(transaction, profileId, binding, now, operation) {
  if (binding === null) return;
  const row = firstRow(
    await transaction.query(
      `SELECT generation FROM devices
        WHERE id = $1 AND profile_id = $2 AND generation = $3
          AND revoked_at IS NULL AND expires_at > $4
        FOR UPDATE`,
      [
        binding.deviceId,
        profileId,
        binding.generation,
        dateParameter(now, "device binding timestamp"),
      ]
    )
  );
  if (!row || toSafeInteger(row.generation, "device generation", 1) !== binding.generation) {
    throw codedError(
      "device_generation_changed",
      "device binding changed before history " + operation
    );
  }
}

class PostgresHistoryRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    this._clock = options.clock || Date.now;
  }

  async getGeneration(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const row = firstRow(
      await this._db.query(
        "SELECT history_generation FROM profiles WHERE id = $1 AND status = 'active'",
        [id]
      )
    );
    return row ? toSafeInteger(row.history_generation, "history generation", 1) : null;
  }

  async upsert(profileId, entry, expectedRevision, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(entry, "history entry");
    const contentKey = assertContentKey(input.contentKey);
    const expected = assertRevision(expectedRevision, false);
    const write = parseDeviceBinding(options);
    if (typeof input.completed !== "boolean") throw new TypeError("completed is invalid");
    const lastPlayedAt = parseTimestamp(input.lastPlayedAt, "lastPlayedAt");
    const canonicalIdentity = Object.prototype.hasOwnProperty.call(input, "canonicalIdentity")
      ? assertOptionalObject(input.canonicalIdentity, "canonicalIdentity")
      : null;
    const displaySnapshot = assertRequiredObject(
      Object.prototype.hasOwnProperty.call(input, "displaySnapshot") ? input.displaySnapshot : {},
      "displaySnapshot"
    );
    const playbackSnapshot = assertSafePlaybackSnapshot(
      Object.prototype.hasOwnProperty.call(input, "playbackSnapshot") ? input.playbackSnapshot : {}
    );
    const positionMs = assertNonNegativeInteger(input.positionMs, "positionMs");
    const durationMs = assertNonNegativeInteger(input.durationMs, "durationMs");
    const watchedMs = assertNonNegativeInteger(input.watchedMs, "watchedMs");

    let row;
    try {
      row = await this._db.transaction(async (transaction) => {
        const profile = await lockActiveProfileHistoryGeneration(transaction, scopedProfileId);
        const generation = toSafeInteger(profile.history_generation, "history generation", 1);
        if (write.input.generation !== undefined && write.input.generation !== generation) {
          throw codedError("history_generation_changed", "history generation changed before write");
        }
        const now = readClock(this._clock);
        await lockDeviceBinding(transaction, scopedProfileId, write.binding, now, "write");
        const current = firstRow(
          await transaction.query(
            `SELECT * FROM cloud_history
              WHERE profile_id = $1 AND content_key = $2
              FOR UPDATE`,
            [scopedProfileId, contentKey]
          )
        );
        const currentRevision = current
          ? toSafeInteger(current.revision, "history revision", 1)
          : 0;
        if (currentRevision !== expected) throw revisionConflict();
        if (
          current &&
          lastPlayedAt < toTimestamp(current.last_played_at, "history lastPlayedAt")
        ) {
          throw codedError("stale_history", "history event predates stored state");
        }
        if (currentRevision >= Number.MAX_SAFE_INTEGER) {
          throw codedError("revision_exhausted", "history revision exhausted");
        }
        let result;
        if (!current) {
          result = await transaction.query(
            `INSERT INTO cloud_history (
               profile_id, content_key, schema_version, canonical_identity,
               display_snapshot, playback_snapshot, position_ms, duration_ms,
               watched_ms, completed, revision, last_played_at, updated_at, deleted_at
             ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, NULL)
             RETURNING *`,
            [
              scopedProfileId,
              contentKey,
              canonicalIdentity,
              displaySnapshot,
              playbackSnapshot,
              positionMs,
              durationMs,
              watchedMs,
              input.completed,
              dateParameter(lastPlayedAt, "history lastPlayedAt"),
              dateParameter(now, "history updatedAt"),
            ]
          );
        } else {
          result = await transaction.query(
            `UPDATE cloud_history
                SET schema_version = 1,
                    canonical_identity = $4,
                    display_snapshot = $5,
                    playback_snapshot = $6,
                    position_ms = $7,
                    duration_ms = $8,
                    watched_ms = $9,
                    completed = $10,
                    revision = revision + 1,
                    change_seq = nextval('cloud_history_change_seq'),
                    last_played_at = $11,
                    updated_at = $12,
                    deleted_at = NULL
              WHERE profile_id = $1 AND content_key = $2 AND revision = $3
              RETURNING *`,
            [
              scopedProfileId,
              contentKey,
              expected,
              canonicalIdentity,
              displaySnapshot,
              playbackSnapshot,
              positionMs,
              durationMs,
              watchedMs,
              input.completed,
              dateParameter(lastPlayedAt, "history lastPlayedAt"),
              dateParameter(now, "history updatedAt"),
            ]
          );
        }
        if (affectedRows(result) !== 1) throw revisionConflict();
        return firstRow(result);
      });
    } catch (error) {
      translateSequenceError(error);
    }
    return mapHistoryRow(row);
  }

  async get(profileId, contentKey) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedContentKey = assertContentKey(contentKey);
    const row = firstRow(
      await this._db.query(
        `SELECT h.*
           FROM cloud_history h
           JOIN profiles p ON p.id = h.profile_id
          WHERE h.profile_id = $1
            AND h.content_key = $2
            AND h.deleted_at IS NULL
            AND p.status = 'active'`,
        [scopedProfileId, scopedContentKey]
      )
    );
    return row ? mapHistoryRow(row) : null;
  }

  async getForWrite(profileId, contentKey) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedContentKey = assertContentKey(contentKey);
    const row = firstRow(
      await this._db.query(
        `SELECT h.*
           FROM cloud_history h
           JOIN profiles p ON p.id = h.profile_id
          WHERE h.profile_id = $1
            AND h.content_key = $2
            AND p.status = 'active'`,
        [scopedProfileId, scopedContentKey]
      )
    );
    return row ? mapHistoryRow(row) : null;
  }

  async list(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(options, "history list options");
    const limit = input.limit === undefined
      ? 50
      : assertPositiveInteger(input.limit, "history limit", 500);
    const cursor = parseHistoryCursor(input);
    const rows = resultRows(
      await this._db.query(
        `SELECT h.*
           FROM cloud_history h
           JOIN profiles p ON p.id = h.profile_id
          WHERE h.profile_id = $1
            AND h.deleted_at IS NULL
            AND p.status = 'active'
            AND (
              $2::timestamptz IS NULL
              OR h.last_played_at < $2
              OR (
                $3::bigint IS NOT NULL
                AND h.last_played_at = $2
                AND (
                  h.revision < $3
                  OR (h.revision = $3 AND h.content_key > $4)
                )
              )
            )
          ORDER BY h.last_played_at DESC, h.revision DESC, h.content_key ASC
          LIMIT $5`,
        [
          scopedProfileId,
          cursor.lastPlayedAt === null
            ? null
            : dateParameter(cursor.lastPlayedAt, "history cursor lastPlayedAt"),
          cursor.revision,
          cursor.contentKey,
          limit,
        ]
      )
    );
    return rows.map(mapHistoryRow);
  }

  async remove(profileId, contentKey, expectedRevision, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedContentKey = assertContentKey(contentKey);
    const expected = assertRevision(expectedRevision, false);
    const write = parseDeviceBinding(options);
    try {
      return await this._db.transaction(async (transaction) => {
        const profile = await lockActiveProfileHistoryGeneration(transaction, scopedProfileId);
        const generation = toSafeInteger(profile.history_generation, "history generation", 1);
        if (write.input.generation !== undefined && write.input.generation !== generation) {
          throw codedError("history_generation_changed", "history generation changed before delete");
        }
        const now = readClock(this._clock);
        await lockDeviceBinding(transaction, scopedProfileId, write.binding, now, "delete");
        const current = firstRow(
          await transaction.query(
            `SELECT * FROM cloud_history
              WHERE profile_id = $1 AND content_key = $2
              FOR UPDATE`,
            [scopedProfileId, scopedContentKey]
          )
        );
        if (!current || current.deleted_at !== null) return false;
        const currentRevision = toSafeInteger(current.revision, "history revision", 1);
        if (currentRevision !== expected) throw revisionConflict();
        if (currentRevision >= Number.MAX_SAFE_INTEGER) {
          throw codedError("revision_exhausted", "history revision exhausted");
        }
        const lastPlayedAt = toTimestamp(current.last_played_at, "history lastPlayedAt");
        const deletedAt = Math.max(now, lastPlayedAt);
        const result = await transaction.query(
          `UPDATE cloud_history
              SET canonical_identity = NULL,
                  display_snapshot = '{}'::jsonb,
                  playback_snapshot = '{}'::jsonb,
                  position_ms = 0,
                  duration_ms = 0,
                  watched_ms = 0,
                  completed = false,
                  revision = revision + 1,
                  change_seq = nextval('cloud_history_change_seq'),
                  updated_at = $4,
                  deleted_at = $5
            WHERE profile_id = $1 AND content_key = $2 AND revision = $3
            RETURNING change_seq`,
          [
            scopedProfileId,
            scopedContentKey,
            expected,
            dateParameter(now, "history updatedAt"),
            dateParameter(deletedAt, "history deletedAt"),
          ]
        );
        if (affectedRows(result) !== 1) throw revisionConflict();
        toSafeInteger(firstRow(result).change_seq, "history changeSequence", 1);
        return true;
      });
    } catch (error) {
      translateSequenceError(error);
    }
  }

  async clear(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return this._db.transaction(async (transaction) => {
      const profile = await lockActiveProfileHistoryGeneration(transaction, id);
      const generation = toSafeInteger(profile.history_generation, "history generation", 1);
      if (generation >= Number.MAX_SAFE_INTEGER) {
        throw codedError("history_generation_exhausted", "history generation exhausted");
      }
      await transaction.query("DELETE FROM cloud_history WHERE profile_id = $1", [id]);
      const result = await transaction.query(
        `UPDATE profiles
            SET history_generation = history_generation + 1, updated_at = $2
          WHERE id = $1 AND status = 'active' AND history_generation = $3
          RETURNING history_generation`,
        [id, dateParameter(readClock(this._clock), "history clearedAt"), generation]
      );
      if (affectedRows(result) !== 1) throw revisionConflict();
      return toSafeInteger(firstRow(result).history_generation, "history generation", 1);
    });
  }

  async changes(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(options, "history change options");
    const afterSequence = input.afterSequence === undefined
      ? 0
      : assertNonNegativeInteger(input.afterSequence, "history afterSequence");
    const limit = input.limit === undefined
      ? 100
      : assertPositiveInteger(input.limit, "history limit", 1000);
    const rows = resultRows(
      await this._db.query(
        `SELECT h.*
           FROM cloud_history h
           JOIN profiles p ON p.id = h.profile_id
          WHERE h.profile_id = $1 AND h.change_seq > $2 AND p.status = 'active'
          ORDER BY h.change_seq ASC
          LIMIT $3`,
        [scopedProfileId, afterSequence, limit]
      )
    );
    return rows.map(mapHistoryRow);
  }
}

module.exports = {
  PostgresHistoryRepository,
};
