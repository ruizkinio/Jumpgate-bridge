"use strict";

const {
  assertIdentifier,
  assertRevision,
  codedError,
  readClock,
  revisionConflict,
  stableScope,
} = require("../repository-utils");
const {
  affectedRows,
  assertEnvelopeStorageSize,
  assertProvider,
  assertRequiredObject,
  dateParameter,
  firstRow,
  jsonValue,
  lockActiveProfile,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
  requireDatabase,
  toSafeInteger,
  toTimestamp,
} = require("./repository-helpers");

class PostgresOAuthCredentialRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    if (!options.envelopeCrypto) throw new TypeError("envelopeCrypto is required");
    this._crypto = options.envelopeCrypto;
    this._clock = options.clock || Date.now;
  }

  async put(profileId, provider, credentials, expectedRevision) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    const value = assertRequiredObject(credentials, "OAuth credentials");
    const expected = assertRevision(expectedRevision, false);
    const credentialEnvelope = this._crypto.encryptJson(
      value,
      this._purpose(scopedProfileId, scopedProvider)
    );
    assertEnvelopeStorageSize(
      credentialEnvelope,
      "OAuth credential envelope",
      MAX_JSON_SNAPSHOT_ENVELOPE_BYTES
    );

    const row = await this._db.transaction(async (transaction) => {
      await lockActiveProfile(transaction, scopedProfileId);
      const current = firstRow(
        await transaction.query(
          `SELECT * FROM oauth_credentials
            WHERE profile_id = $1 AND provider = $2
            FOR UPDATE`,
          [scopedProfileId, scopedProvider]
        )
      );
      const currentRevision = current
        ? toSafeInteger(current.revision, "OAuth credential revision", 1)
        : 0;
      if (currentRevision !== expected) throw revisionConflict();
      if (currentRevision >= Number.MAX_SAFE_INTEGER) {
        throw codedError("revision_exhausted", "OAuth credential revision exhausted");
      }
      const now = readClock(this._clock);
      let result;
      if (!current) {
        result = await transaction.query(
          `INSERT INTO oauth_credentials (
             profile_id, provider, schema_version, credential_envelope,
             revision, created_at, updated_at
           ) VALUES ($1, $2, 1, $3, 1, $4, $4)
           RETURNING *`,
          [
            scopedProfileId,
            scopedProvider,
            credentialEnvelope,
            dateParameter(now, "OAuth credential createdAt"),
          ]
        );
      } else {
        result = await transaction.query(
          `UPDATE oauth_credentials
              SET credential_envelope = $4,
                  revision = revision + 1,
                  updated_at = $5
            WHERE profile_id = $1 AND provider = $2 AND revision = $3
            RETURNING *`,
          [
            scopedProfileId,
            scopedProvider,
            expected,
            credentialEnvelope,
            dateParameter(now, "OAuth credential updatedAt"),
          ]
        );
      }
      if (affectedRows(result) !== 1) throw revisionConflict();
      return firstRow(result);
    });
    return this._public(row);
  }

  async get(profileId, provider) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    const row = firstRow(
      await this._db.query(
        `SELECT oc.*
           FROM oauth_credentials oc
           JOIN profiles p ON p.id = oc.profile_id
          WHERE oc.profile_id = $1 AND oc.provider = $2 AND p.status = 'active'`,
        [scopedProfileId, scopedProvider]
      )
    );
    return row ? this._public(row) : null;
  }

  async remove(profileId, provider, expectedRevision) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedProvider = assertProvider(provider);
    const expected = assertRevision(expectedRevision, false);
    return this._db.transaction(async (transaction) => {
      await lockActiveProfile(transaction, scopedProfileId);
      const current = firstRow(
        await transaction.query(
          `SELECT revision FROM oauth_credentials
            WHERE profile_id = $1 AND provider = $2
            FOR UPDATE`,
          [scopedProfileId, scopedProvider]
        )
      );
      if (!current) return false;
      if (toSafeInteger(current.revision, "OAuth credential revision", 1) !== expected) {
        throw revisionConflict();
      }
      const result = await transaction.query(
        `DELETE FROM oauth_credentials
          WHERE profile_id = $1 AND provider = $2 AND revision = $3
          RETURNING profile_id`,
        [scopedProfileId, scopedProvider, expected]
      );
      if (affectedRows(result) !== 1) throw revisionConflict();
      return true;
    });
  }

  _purpose(profileId, provider) {
    return "oauth-credential:" + stableScope("oauth", profileId, provider);
  }

  _public(row) {
    return {
      schemaVersion: toSafeInteger(row.schema_version, "OAuth credential schemaVersion", 1),
      profileId: row.profile_id,
      provider: row.provider,
      credentials: this._crypto.decryptJson(
        jsonValue(row.credential_envelope, "OAuth credential envelope"),
        this._purpose(row.profile_id, row.provider)
      ),
      revision: toSafeInteger(row.revision, "OAuth credential revision", 1),
      createdAt: toTimestamp(row.created_at, "OAuth credential createdAt"),
      updatedAt: toTimestamp(row.updated_at, "OAuth credential updatedAt"),
    };
  }
}

module.exports = {
  PostgresOAuthCredentialRepository,
};
