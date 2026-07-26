"use strict";

const crypto = require("node:crypto");

const {
  assertBoundedString,
  assertIdentifier,
  assertPlainObject,
  assertPositiveInteger,
  cloneJson,
  codedError,
  readClock,
  stableScope,
} = require("../repository-utils");
const { withImmediateTransaction, withReadTransaction } = require("./connection");
const {
  assertJsonValue,
  isActiveProfile,
  MAX_BACKUP_ENVELOPE_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
  normalizeRepositoryOptions,
  parseJson,
  prepareProfileStatus,
  requireActiveProfile,
  requireDatabase,
  stringifyJson,
} = require("./helpers");

class SqliteAddonCollectionBackupRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    this._db = requireDatabase(options);
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._maxBackupsPerProfile = options.maxBackupsPerProfile ?? 64;
    assertPositiveInteger(this._maxBackupsPerProfile, "maxBackupsPerProfile", 1024);

    this._profileStatus = prepareProfileStatus(this._db);
    this._getById = this._db.prepare(
      "SELECT * FROM addon_collection_backups WHERE id = ?"
    );
    this._countByProfile = this._db.prepare(`
      SELECT count(*) AS count FROM addon_collection_backups WHERE profile_id = ?
    `);
    this._insert = this._db.prepare(`
      INSERT INTO addon_collection_backups (
        id, profile_id, schema_version, collection_envelope,
        reason, created_at, restored_at
      ) VALUES (?, ?, 1, ?, ?, ?, NULL)
    `);
    this._list = this._db.prepare(`
      SELECT * FROM addon_collection_backups
      WHERE profile_id = ?
      ORDER BY created_at DESC, id
      LIMIT ?
    `);
    this._restore = this._db.prepare(`
      UPDATE addon_collection_backups SET restored_at = ?
      WHERE id = ? AND profile_id = ? AND restored_at IS NULL
    `);
    this._snapshot = this._db.prepare(
      "SELECT * FROM addon_collection_backups ORDER BY rowid"
    );
  }

  async create(profileId, collection, reason) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    if (!Array.isArray(collection) || collection.length > 256) {
      throw new TypeError("addon collection must be an array of at most 256 entries");
    }
    const safeCollection = assertJsonValue(
      collection,
      "addon collection",
      MAX_BACKUP_PLAINTEXT_BYTES
    );
    const scopedReason = assertBoundedString(reason, "backup reason", 256);

    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, scopedProfileId);
      if (this._countByProfile.get(scopedProfileId).count >= this._maxBackupsPerProfile) {
        throw codedError("backup_limit", "profile backup limit reached");
      }
      const id = assertIdentifier(this._idFactory("backup"), "backup id");
      if (this._getById.get(id)) {
        throw codedError("backup_id_collision", "backup id collision");
      }
      const now = readClock(this._clock);
      const envelope = this._crypto.encryptJson(
        safeCollection,
        this._purpose(scopedProfileId, id)
      );
      const envelopeText = stringifyJson(
        envelope,
        "addon collection envelope",
        MAX_BACKUP_ENVELOPE_BYTES
      );
      this._insert.run(id, scopedProfileId, envelopeText, scopedReason, now);
      return this._metadata(this._getById.get(id));
    });
  }

  async get(profileId, backupId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(backupId, "backup id");
    return withReadTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return null;
      const record = this._getById.get(id);
      if (!record || record.profile_id !== scopedProfileId) return null;
      return {
        ...this._metadata(record),
        collection: this._crypto.decryptJson(
          parseJson(record.collection_envelope, "addon collection envelope"),
          this._purpose(scopedProfileId, id)
        ),
      };
    });
  }

  async list(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(options, "backup list options");
    const limit =
      input.limit === undefined
        ? 20
        : assertPositiveInteger(input.limit, "backup limit", 100);
    return withReadTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return [];
      return this._list.all(scopedProfileId, limit).map((row) => this._metadata(row));
    });
  }

  async markRestored(profileId, backupId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(backupId, "backup id");
    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, scopedProfileId);
      const record = this._getById.get(id);
      if (!record || record.profile_id !== scopedProfileId) return false;
      if (record.restored_at === null) {
        this._restore.run(readClock(this._clock), id, scopedProfileId);
      }
      return true;
    });
  }

  storageSnapshot() {
    return this._snapshot.all().map((row) =>
      cloneJson({
        schemaVersion: row.schema_version,
        id: row.id,
        profileId: row.profile_id,
        collectionEnvelope: parseJson(row.collection_envelope, "addon collection envelope"),
        reason: row.reason,
        createdAt: row.created_at,
        restoredAt: row.restored_at,
      })
    );
  }

  _metadata(record) {
    return {
      schemaVersion: record.schema_version,
      id: record.id,
      profileId: record.profile_id,
      reason: record.reason,
      createdAt: record.created_at,
      restoredAt: record.restored_at,
    };
  }

  _purpose(profileId, backupId) {
    return "addon-backup:" + stableScope("addon-backup", profileId, backupId);
  }
}

module.exports = {
  SqliteAddonCollectionBackupRepository,
};
