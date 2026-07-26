"use strict";

const crypto = require("node:crypto");
const {
  assertBoundedString,
  assertIdentifier,
  assertPlainObject,
  assertPositiveInteger,
  codedError,
  readClock,
  stableScope,
} = require("../repository-utils");
const {
  affectedRows,
  assertEnvelopeStorageSize,
  assertJsonValue,
  dateParameter,
  firstRow,
  jsonValue,
  lockActiveProfile,
  mapBackupMetadata,
  MAX_BACKUP_ENVELOPE_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
  requireDatabase,
  resultRows,
  toSafeInteger,
  uniqueConstraint,
} = require("./repository-helpers");

class PostgresAddonCollectionBackupRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._maxBackupsPerProfile = options.maxBackupsPerProfile ?? 64;
    assertPositiveInteger(this._maxBackupsPerProfile, "maxBackupsPerProfile", 1024);
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
    const id = assertIdentifier(this._idFactory("backup"), "backup id");
    const envelope = this._crypto.encryptJson(
      safeCollection,
      this._purpose(scopedProfileId, id)
    );
    assertEnvelopeStorageSize(
      envelope,
      "addon collection envelope",
      MAX_BACKUP_ENVELOPE_BYTES
    );

    let row;
    try {
      row = await this._db.transaction(async (transaction) => {
        await lockActiveProfile(transaction, scopedProfileId);
        const countRow = firstRow(
          await transaction.query(
            `SELECT count(*)::bigint AS backup_count
               FROM addon_collection_backups
              WHERE profile_id = $1`,
            [scopedProfileId]
          )
        );
        const count = countRow
          ? toSafeInteger(countRow.backup_count, "backup count")
          : 0;
        if (count >= this._maxBackupsPerProfile) {
          throw codedError("backup_limit", "profile backup limit reached");
        }
        const now = readClock(this._clock);
        const inserted = firstRow(
          await transaction.query(
            `INSERT INTO addon_collection_backups (
               id, profile_id, schema_version, collection_envelope,
               reason, created_at, restored_at
             ) VALUES ($1, $2, 1, $3, $4, $5, NULL)
             RETURNING *`,
            [
              id,
              scopedProfileId,
              envelope,
              scopedReason,
              dateParameter(now, "backup createdAt"),
            ]
          )
        );
        if (!inserted) throw new Error("backup insert did not return a row");
        return inserted;
      });
    } catch (error) {
      if (uniqueConstraint(error, "addon_collection_backups_pkey")) {
        throw codedError("backup_id_collision", "backup id collision");
      }
      throw error;
    }
    return mapBackupMetadata(row);
  }

  async get(profileId, backupId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(backupId, "backup id");
    const row = firstRow(
      await this._db.query(
        `SELECT b.*
           FROM addon_collection_backups b
           JOIN profiles p ON p.id = b.profile_id
          WHERE b.id = $1 AND b.profile_id = $2 AND p.status = 'active'`,
        [id, scopedProfileId]
      )
    );
    if (!row) return null;
    return {
      ...mapBackupMetadata(row),
      collection: this._crypto.decryptJson(
        jsonValue(row.collection_envelope, "backup collectionEnvelope"),
        this._purpose(scopedProfileId, id)
      ),
    };
  }

  async list(profileId, options = {}) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(options, "backup list options");
    const limit = input.limit === undefined
      ? 20
      : assertPositiveInteger(input.limit, "backup limit", 100);
    const rows = resultRows(
      await this._db.query(
        `SELECT b.*
           FROM addon_collection_backups b
           JOIN profiles p ON p.id = b.profile_id
          WHERE b.profile_id = $1 AND p.status = 'active'
          ORDER BY b.created_at DESC, b.id ASC
          LIMIT $2`,
        [scopedProfileId, limit]
      )
    );
    return rows.map(mapBackupMetadata);
  }

  async markRestored(profileId, backupId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(backupId, "backup id");
    return this._db.transaction(async (transaction) => {
      await lockActiveProfile(transaction, scopedProfileId);
      const current = firstRow(
        await transaction.query(
          `SELECT id, restored_at FROM addon_collection_backups
            WHERE id = $1 AND profile_id = $2
            FOR UPDATE`,
          [id, scopedProfileId]
        )
      );
      if (!current) return false;
      if (current.restored_at !== null) return true;
      const now = readClock(this._clock);
      const result = await transaction.query(
        `UPDATE addon_collection_backups
            SET restored_at = $3
          WHERE id = $1 AND profile_id = $2 AND restored_at IS NULL
          RETURNING id`,
        [id, scopedProfileId, dateParameter(now, "backup restoredAt")]
      );
      return affectedRows(result) === 1;
    });
  }

  _purpose(profileId, backupId) {
    return "addon-backup:" + stableScope("addon-backup", profileId, backupId);
  }
}

module.exports = {
  PostgresAddonCollectionBackupRepository,
};
