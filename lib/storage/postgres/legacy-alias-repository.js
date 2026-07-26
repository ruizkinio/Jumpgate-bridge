"use strict";

const { assertIdentifier, codedError, readClock } = require("../repository-utils");
const {
  affectedRows,
  assertContentKey,
  dateParameter,
  firstRow,
  lockActiveProfile,
  requireDatabase,
} = require("./repository-helpers");

class PostgresLegacyConfigAliasRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    this._clock = options.clock || Date.now;
  }

  async getProfileId(legacyConfigHash) {
    const hash = assertContentKey(legacyConfigHash);
    const row = firstRow(
      await this._db.query(
        `SELECT a.profile_id
           FROM legacy_config_aliases a
           JOIN profiles p ON p.id = a.profile_id
          WHERE a.legacy_config_hash = $1 AND p.status = 'active'`,
        [hash]
      )
    );
    return row ? row.profile_id : null;
  }

  async bind(profileId, legacyConfigHash) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const hash = assertContentKey(legacyConfigHash);
    return this._db.transaction(async (transaction) => {
      await lockActiveProfile(transaction, scopedProfileId);
      const now = readClock(this._clock);
      const inserted = await transaction.query(
        `INSERT INTO legacy_config_aliases (
           legacy_config_hash, profile_id, schema_version, created_at
         ) VALUES ($1, $2, 1, $3)
         ON CONFLICT (legacy_config_hash) DO NOTHING
         RETURNING profile_id`,
        [hash, scopedProfileId, dateParameter(now, "legacy alias createdAt")]
      );
      if (affectedRows(inserted) === 0) {
        const existing = firstRow(
          await transaction.query(
            `SELECT profile_id FROM legacy_config_aliases
              WHERE legacy_config_hash = $1
              FOR UPDATE`,
            [hash]
          )
        );
        if (!existing || existing.profile_id !== scopedProfileId) {
          throw codedError(
            "legacy_alias_conflict",
            "legacy config alias belongs to another profile"
          );
        }
      }
      return { legacyConfigHash: hash, profileId: scopedProfileId };
    });
  }
}

module.exports = {
  PostgresLegacyConfigAliasRepository,
};
