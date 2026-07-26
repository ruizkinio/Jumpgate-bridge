"use strict";

const { assertIdentifier, cloneJson, codedError, readClock } = require("../repository-utils");
const { withImmediateTransaction, withReadTransaction } = require("./connection");
const {
  assertContentKey,
  isActiveProfile,
  normalizeRepositoryOptions,
  prepareProfileStatus,
  requireActiveProfile,
  requireDatabase,
} = require("./helpers");

class SqliteLegacyConfigAliasRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    this._db = requireDatabase(options);
    this._clock = options.clock || Date.now;
    this._profileStatus = prepareProfileStatus(this._db);
    this._get = this._db.prepare(`
      SELECT profile_id FROM legacy_config_aliases WHERE legacy_config_hash = ?
    `);
    this._insert = this._db.prepare(`
      INSERT INTO legacy_config_aliases (
        legacy_config_hash, profile_id, schema_version, created_at
      ) VALUES (?, ?, 1, ?)
    `);
    this._snapshot = this._db.prepare(`
      SELECT legacy_config_hash, profile_id
      FROM legacy_config_aliases ORDER BY rowid
    `);
  }

  async getProfileId(legacyConfigHash) {
    const hash = assertContentKey(legacyConfigHash);
    return withReadTransaction(this._db, () => {
      const row = this._get.get(hash);
      return row && isActiveProfile(this._profileStatus, row.profile_id)
        ? row.profile_id
        : null;
    });
  }

  async bind(profileId, legacyConfigHash) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const hash = assertContentKey(legacyConfigHash);
    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, scopedProfileId);
      const existing = this._get.get(hash);
      if (existing && existing.profile_id !== scopedProfileId) {
        throw codedError(
          "legacy_alias_conflict",
          "legacy config alias belongs to another profile"
        );
      }
      if (!existing) this._insert.run(hash, scopedProfileId, readClock(this._clock));
      return { legacyConfigHash: hash, profileId: scopedProfileId };
    });
  }

  storageSnapshot() {
    return this._snapshot.all().map((row) =>
      cloneJson({
        legacyConfigHash: row.legacy_config_hash,
        profileId: row.profile_id,
      })
    );
  }
}

module.exports = {
  SqliteLegacyConfigAliasRepository,
};
