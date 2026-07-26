"use strict";

const {
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
} = require("../repository-utils");
const { withImmediateTransaction, withReadTransaction } = require("./connection");
const {
  assertContentKey,
  assertOptionalObject,
  assertRequiredObject,
  assertSafePlaybackSnapshot,
  isActiveProfile,
  normalizeRepositoryOptions,
  parseJson,
  prepareProfileStatus,
  requireActiveProfile,
  requireDatabase,
  stringifyJson,
} = require("./helpers");

function mapHistory(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    profileId: row.profile_id,
    contentKey: row.content_key,
    canonicalIdentity:
      row.canonical_identity === null
        ? null
        : parseJson(row.canonical_identity, "history canonical identity"),
    displaySnapshot: parseJson(row.display_snapshot, "history display snapshot"),
    playbackSnapshot: parseJson(row.playback_snapshot, "history playback snapshot"),
    positionMs: row.position_ms,
    durationMs: row.duration_ms,
    watchedMs: row.watched_ms,
    completed: row.completed === 1,
    revision: row.revision,
    changeSequence: row.change_sequence,
    lastPlayedAt: row.last_played_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
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

class SqliteHistoryRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    this._db = requireDatabase(options);
    this._clock = options.clock || Date.now;

    this._profileStatus = prepareProfileStatus(this._db);
    this._getAny = this._db.prepare(`
      SELECT * FROM cloud_history WHERE profile_id = ? AND content_key = ?
    `);
    this._getActive = this._db.prepare(`
      SELECT * FROM cloud_history
      WHERE profile_id = ? AND content_key = ? AND deleted_at IS NULL
    `);
    this._activeDeviceBinding = this._db.prepare(`
      SELECT generation FROM devices
      WHERE id = ? AND profile_id = ? AND generation = ?
        AND revoked_at IS NULL AND expires_at > ?
    `);
    this._insert = this._db.prepare(`
      INSERT INTO cloud_history (
        profile_id, content_key, schema_version, canonical_identity,
        display_snapshot, playback_snapshot, position_ms, duration_ms,
        watched_ms, completed, revision, change_sequence, last_played_at,
        updated_at, deleted_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, NULL)
    `);
    this._update = this._db.prepare(`
      UPDATE cloud_history SET
        schema_version = 1,
        canonical_identity = ?,
        display_snapshot = ?,
        playback_snapshot = ?,
        position_ms = ?,
        duration_ms = ?,
        watched_ms = ?,
        completed = ?,
        revision = revision + 1,
        change_sequence = ?,
        last_played_at = ?,
        updated_at = ?,
        deleted_at = NULL
      WHERE profile_id = ? AND content_key = ? AND revision = ?
    `);
    this._list = this._db.prepare(`
      SELECT * FROM cloud_history
      WHERE profile_id = ? AND deleted_at IS NULL
        AND (
          ? IS NULL
          OR last_played_at < ?
          OR (
            ? IS NOT NULL
            AND last_played_at = ?
            AND (
              revision < ?
              OR (revision = ? AND content_key > ?)
            )
          )
        )
      ORDER BY last_played_at DESC, revision DESC, content_key
      LIMIT ?
    `);
    this._tombstone = this._db.prepare(`
      UPDATE cloud_history SET
        canonical_identity = NULL,
        display_snapshot = '{}',
        playback_snapshot = '{}',
        position_ms = 0,
        duration_ms = 0,
        watched_ms = 0,
        completed = 0,
        revision = revision + 1,
        change_sequence = ?,
        updated_at = ?,
        deleted_at = ?
      WHERE profile_id = ? AND content_key = ?
        AND revision = ? AND deleted_at IS NULL
    `);
    this._changes = this._db.prepare(`
      SELECT * FROM cloud_history
      WHERE profile_id = ? AND change_sequence > ?
      ORDER BY change_sequence
      LIMIT ?
    `);
    this._snapshot = this._db.prepare(
      "SELECT * FROM cloud_history ORDER BY change_sequence"
    );
    this._advanceSequence = this._db.prepare(`
      UPDATE history_sequence SET value = value + 1
      WHERE singleton = 1 AND value < ?
    `);
    this._readSequence = this._db.prepare(
      "SELECT value FROM history_sequence WHERE singleton = 1"
    );
    this._clear = this._db.prepare("DELETE FROM cloud_history WHERE profile_id = ?");
    this._advanceGeneration = this._db.prepare(`
      UPDATE profiles SET history_generation = history_generation + 1, updated_at = ?
      WHERE id = ? AND status = 'active' AND history_generation < ?
    `);
  }

  async getGeneration(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return withReadTransaction(this._db, () => {
      const profile = this._profileStatus.get(id);
      return profile && profile.status === "active" ? profile.history_generation : null;
    });
  }

  async upsert(profileId, entry, expectedRevision, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(entry, "history entry");
    const contentKey = assertContentKey(input.contentKey);
    const expected = assertRevision(expectedRevision, false);
    const write = parseDeviceBinding(options);

    return withImmediateTransaction(this._db, () => {
      const profile = requireActiveProfile(this._profileStatus, scopedProfileId);
      if (write.input.generation !== undefined && write.input.generation !== profile.history_generation) {
        throw codedError("history_generation_changed", "history generation changed before write");
      }
      const now = readClock(this._clock);
      if (
        write.binding &&
        !this._activeDeviceBinding.get(
          write.binding.deviceId,
          scopedProfileId,
          write.binding.generation,
          now
        )
      ) {
        throw codedError("device_generation_changed", "device binding changed before write");
      }
      const current = this._getAny.get(scopedProfileId, contentKey);
      const currentRevision = current ? current.revision : 0;
      if (currentRevision !== expected) throw revisionConflict();
      if (currentRevision >= Number.MAX_SAFE_INTEGER) {
        throw codedError("revision_exhausted", "history revision exhausted");
      }
      if (typeof input.completed !== "boolean") throw new TypeError("completed is invalid");
      const lastPlayedAt = parseTimestamp(input.lastPlayedAt, "lastPlayedAt");
      if (current && lastPlayedAt < current.last_played_at) {
        throw codedError("stale_history", "history event predates stored state");
      }

      const canonicalIdentity = assertOptionalObject(
        Object.prototype.hasOwnProperty.call(input, "canonicalIdentity")
          ? input.canonicalIdentity
          : null,
        "canonicalIdentity"
      );
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
      const canonicalText =
        canonicalIdentity === null
          ? null
          : stringifyJson(canonicalIdentity, "canonicalIdentity", 64 * 1024);
      const displayText = stringifyJson(displaySnapshot, "displaySnapshot", 64 * 1024);
      const playbackText = stringifyJson(playbackSnapshot, "playbackSnapshot", 64 * 1024);
      const changeSequence = this._nextChangeSequence();

      if (current) {
        const result = this._update.run(
          canonicalText,
          displayText,
          playbackText,
          positionMs,
          durationMs,
          watchedMs,
          input.completed ? 1 : 0,
          changeSequence,
          lastPlayedAt,
          now,
          scopedProfileId,
          contentKey,
          expected
        );
        if (result.changes !== 1) throw revisionConflict();
      } else {
        this._insert.run(
          scopedProfileId,
          contentKey,
          canonicalText,
          displayText,
          playbackText,
          positionMs,
          durationMs,
          watchedMs,
          input.completed ? 1 : 0,
          changeSequence,
          lastPlayedAt,
          now
        );
      }
      return mapHistory(this._getAny.get(scopedProfileId, contentKey));
    });
  }

  async get(profileId, contentKey) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedContentKey = assertContentKey(contentKey);
    return withReadTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return null;
      return mapHistory(this._getActive.get(scopedProfileId, scopedContentKey));
    });
  }

  async getForWrite(profileId, contentKey) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedContentKey = assertContentKey(contentKey);
    return withReadTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return null;
      return mapHistory(this._getAny.get(scopedProfileId, scopedContentKey));
    });
  }

  async list(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(options, "history list options");
    const limit =
      input.limit === undefined
        ? 50
        : assertPositiveInteger(input.limit, "history limit", 500);
    const cursor = parseHistoryCursor(input);
    return withReadTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return [];
      return this._list
        .all(
          scopedProfileId,
          cursor.lastPlayedAt,
          cursor.lastPlayedAt,
          cursor.revision,
          cursor.lastPlayedAt,
          cursor.revision,
          cursor.revision,
          cursor.contentKey,
          limit
        )
        .map((row) => cloneJson(mapHistory(row)));
    });
  }

  async remove(profileId, contentKey, expectedRevision, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedContentKey = assertContentKey(contentKey);
    const expected = assertRevision(expectedRevision, false);
    const write = parseDeviceBinding(options);

    return withImmediateTransaction(this._db, () => {
      const profile = requireActiveProfile(this._profileStatus, scopedProfileId);
      if (write.input.generation !== undefined && write.input.generation !== profile.history_generation) {
        throw codedError("history_generation_changed", "history generation changed before delete");
      }
      const now = readClock(this._clock);
      if (
        write.binding &&
        !this._activeDeviceBinding.get(
          write.binding.deviceId,
          scopedProfileId,
          write.binding.generation,
          now
        )
      ) {
        throw codedError("device_generation_changed", "device binding changed before delete");
      }
      const current = this._getAny.get(scopedProfileId, scopedContentKey);
      if (!current || current.deleted_at !== null) return false;
      if (current.revision !== expected) throw revisionConflict();
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw codedError("revision_exhausted", "history revision exhausted");
      }
      const deletedAt = Math.max(now, current.last_played_at);
      const changeSequence = this._nextChangeSequence();
      const result = this._tombstone.run(
        changeSequence,
        now,
        deletedAt,
        scopedProfileId,
        scopedContentKey,
        expected
      );
      if (result.changes !== 1) throw revisionConflict();
      return true;
    });
  }

  async clear(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return withImmediateTransaction(this._db, () => {
      const profile = requireActiveProfile(this._profileStatus, id);
      if (profile.history_generation >= Number.MAX_SAFE_INTEGER) {
        throw codedError("history_generation_exhausted", "history generation exhausted");
      }
      this._clear.run(id);
      const result = this._advanceGeneration.run(
        readClock(this._clock),
        id,
        Number.MAX_SAFE_INTEGER
      );
      if (result.changes !== 1) {
        throw codedError("history_generation_exhausted", "history generation exhausted");
      }
      return profile.history_generation + 1;
    });
  }

  async changes(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(options, "history change options");
    const afterSequence =
      input.afterSequence === undefined
        ? 0
        : assertNonNegativeInteger(input.afterSequence, "history afterSequence");
    const limit =
      input.limit === undefined
        ? 100
        : assertPositiveInteger(input.limit, "history limit", 1000);
    return withReadTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return [];
      return this._changes
        .all(scopedProfileId, afterSequence, limit)
        .map((row) => cloneJson(mapHistory(row)));
    });
  }

  storageSnapshot() {
    return this._snapshot.all().map((row) => cloneJson(mapHistory(row)));
  }

  _nextChangeSequence() {
    const result = this._advanceSequence.run(Number.MAX_SAFE_INTEGER);
    if (result.changes !== 1) {
      throw codedError("history_sequence_exhausted", "history change sequence exhausted");
    }
    const row = this._readSequence.get();
    if (!row || !Number.isSafeInteger(row.value) || row.value < 1) {
      throw codedError("history_sequence_exhausted", "history change sequence exhausted");
    }
    return row.value;
  }
}

module.exports = {
  SqliteHistoryRepository,
};
