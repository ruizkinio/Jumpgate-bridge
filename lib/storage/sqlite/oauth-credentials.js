"use strict";

const {
  assertIdentifier,
  assertRevision,
  cloneJson,
  codedError,
  readClock,
  revisionConflict,
  stableScope,
} = require("../repository-utils");
const { withImmediateTransaction, withReadTransaction } = require("./connection");
const {
  assertProvider,
  assertRequiredObject,
  isActiveProfile,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
  normalizeRepositoryOptions,
  parseJson,
  prepareProfileStatus,
  requireActiveProfile,
  requireDatabase,
  stringifyJson,
} = require("./helpers");

class SqliteOAuthCredentialRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    this._db = requireDatabase(options);
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;

    this._profileStatus = prepareProfileStatus(this._db);
    this._get = this._db.prepare(
      "SELECT * FROM oauth_credentials WHERE profile_id = ? AND provider = ?"
    );
    this._insert = this._db.prepare(`
      INSERT INTO oauth_credentials (
        profile_id, provider, schema_version, credential_envelope,
        revision, created_at, updated_at
      ) VALUES (?, ?, 1, ?, 1, ?, ?)
    `);
    this._update = this._db.prepare(`
      UPDATE oauth_credentials
      SET credential_envelope = ?, revision = revision + 1, updated_at = ?
      WHERE profile_id = ? AND provider = ? AND revision = ?
    `);
    this._remove = this._db.prepare(`
      DELETE FROM oauth_credentials
      WHERE profile_id = ? AND provider = ? AND revision = ?
    `);
    this._snapshot = this._db.prepare(
      "SELECT * FROM oauth_credentials ORDER BY rowid"
    );
  }

  async put(profileId, provider, credentials, expectedRevision) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    const value = assertRequiredObject(credentials, "OAuth credentials");
    const expected = assertRevision(expectedRevision, false);

    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, scopedProfileId);
      const current = this._get.get(scopedProfileId, scopedProvider);
      const currentRevision = current ? current.revision : 0;
      if (currentRevision !== expected) throw revisionConflict();
      if (currentRevision >= Number.MAX_SAFE_INTEGER) {
        throw codedError("revision_exhausted", "OAuth credential revision exhausted");
      }
      const now = readClock(this._clock);
      const envelope = this._crypto.encryptJson(
        value,
        this._purpose(scopedProfileId, scopedProvider)
      );
      const envelopeText = stringifyJson(
        envelope,
        "OAuth credential envelope",
        MAX_JSON_SNAPSHOT_ENVELOPE_BYTES
      );
      if (current) {
        const result = this._update.run(
          envelopeText,
          now,
          scopedProfileId,
          scopedProvider,
          expected
        );
        if (result.changes !== 1) throw revisionConflict();
      } else {
        this._insert.run(
          scopedProfileId,
          scopedProvider,
          envelopeText,
          now,
          now
        );
      }
      return this._public(this._get.get(scopedProfileId, scopedProvider));
    });
  }

  async get(profileId, provider) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    return withReadTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, scopedProfileId)) return null;
      const record = this._get.get(scopedProfileId, scopedProvider);
      return record ? this._public(record) : null;
    });
  }

  async remove(profileId, provider, expectedRevision) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    const expected = assertRevision(expectedRevision, false);
    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, scopedProfileId);
      const current = this._get.get(scopedProfileId, scopedProvider);
      if (!current) return false;
      if (current.revision !== expected) throw revisionConflict();
      const result = this._remove.run(scopedProfileId, scopedProvider, expected);
      if (result.changes !== 1) throw revisionConflict();
      return true;
    });
  }

  storageSnapshot() {
    return this._snapshot.all().map((row) => cloneJson(this._stored(row)));
  }

  _purpose(profileId, provider) {
    return "oauth-credential:" + stableScope("oauth", profileId, provider);
  }

  _stored(row) {
    return {
      schemaVersion: row.schema_version,
      profileId: row.profile_id,
      provider: row.provider,
      credentialEnvelope: parseJson(row.credential_envelope, "OAuth credential envelope"),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  _public(row) {
    const stored = this._stored(row);
    return {
      schemaVersion: stored.schemaVersion,
      profileId: stored.profileId,
      provider: stored.provider,
      credentials: this._crypto.decryptJson(
        stored.credentialEnvelope,
        this._purpose(stored.profileId, stored.provider)
      ),
      revision: stored.revision,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    };
  }
}

module.exports = {
  SqliteOAuthCredentialRepository,
};
