"use strict";

const crypto = require("node:crypto");
const {
  assertIdentifier,
  assertRevision,
  codedError,
  readClock,
  revisionConflict,
} = require("../repository-utils");
const {
  PostgresLifecycleInvalidationRepository,
} = require("./lifecycle-invalidation-repository");
const {
  PostgresSubtitleManifestRepository,
} = require("./subtitle-manifest-repository");
const {
  PostgresPlaybackSessionRepository,
} = require("./playback-session-repository");
const {
  affectedRows,
  assertDisplayName,
  assertOptionalEnvelope,
  assertOptionalHash,
  assertProfilePatch,
  dateParameter,
  firstRow,
  mapProfileRow,
  requireDatabase,
  toSafeInteger,
  toTimestamp,
  uniqueConstraint,
} = require("./repository-helpers");

function translateCreateError(error) {
  if (uniqueConstraint(error, "profiles_pkey")) throw new Error("profile id collision");
  if (uniqueConstraint(error, "profiles_install_token_hash_key")) {
    throw new Error("install token collision");
  }
  if (
    uniqueConstraint(
      error,
      "profiles_legacy_config_hash_key",
      "legacy_config_aliases_pkey"
    )
  ) {
    error.code = "legacy_alias_conflict";
    error.message = "legacy config alias belongs to another profile";
  }
  throw error;
}

class PostgresProfileRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._lifecycleInvalidations =
      options.lifecycleInvalidations ||
      new PostgresLifecycleInvalidationRepository({ database: this._db, clock: this._clock });
    this._playbackSessions =
      options.playbackSessions ||
      new PostgresPlaybackSessionRepository({
        database: this._db,
        tokenService: this._tokens,
        clock: this._clock,
      });
    this._subtitleManifests =
      options.subtitleManifests ||
      new PostgresSubtitleManifestRepository({
        database: this._db,
        tokenService: this._tokens,
        clock: this._clock,
      });
  }

  async create(input = {}) {
    const now = readClock(this._clock);
    const id = assertIdentifier(this._idFactory("profile"), "profile id");
    const issued = this._tokens.issue("install", 32);
    const displayName = assertDisplayName(input.displayName);
    const settingsEnvelope = Object.prototype.hasOwnProperty.call(input, "settingsEnvelope")
      ? assertOptionalEnvelope(input.settingsEnvelope, "settingsEnvelope")
      : null;
    const legacyConfigHash = assertOptionalHash(input.legacyConfigHash, "legacyConfigHash");

    let row;
    try {
      row = await this._db.transaction(async (transaction) => {
        const inserted = firstRow(
          await transaction.query(
            `INSERT INTO profiles (
               id, schema_version, install_token_hash, display_name, settings_envelope,
               legacy_config_hash, status, revision, created_at, updated_at, revoked_at
             ) VALUES ($1, 1, $2, $3, $4, $5, 'active', 1, $6, $6, NULL)
             RETURNING *`,
            [
              id,
              issued.tokenHash,
              displayName,
              settingsEnvelope,
              legacyConfigHash,
              dateParameter(now, "profile createdAt"),
            ]
          )
        );
        if (!inserted) throw new Error("profile insert did not return a row");
        if (legacyConfigHash !== null) {
          await transaction.query(
            `INSERT INTO legacy_config_aliases (
               legacy_config_hash, profile_id, schema_version, created_at
             ) VALUES ($1, $2, 1, $3)`,
            [legacyConfigHash, id, dateParameter(now, "legacy alias createdAt")]
          );
        }
        return inserted;
      });
    } catch (error) {
      translateCreateError(error);
    }
    return { profile: mapProfileRow(row), installToken: issued.token };
  }

  async getById(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const row = firstRow(await this._db.query("SELECT * FROM profiles WHERE id = $1", [id]));
    return row ? mapProfileRow(row) : null;
  }

  async getByInstallToken(token) {
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("install", token);
    } catch (_err) {
      return null;
    }
    const row = firstRow(
      await this._db.query(
        "SELECT * FROM profiles WHERE install_token_hash = $1 AND status = 'active'",
        [tokenHash]
      )
    );
    return row ? mapProfileRow(row) : null;
  }

  async update(profileId, patch = {}, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const safePatch = assertProfilePatch(patch);
    const expected = assertRevision(expectedRevision, false);
    const hasDisplayName = Object.prototype.hasOwnProperty.call(safePatch, "displayName");
    const hasSettingsEnvelope = Object.prototype.hasOwnProperty.call(safePatch, "settingsEnvelope");
    const nextDisplayName = hasDisplayName
      ? assertDisplayName(safePatch.displayName)
      : undefined;
    const nextSettingsEnvelope = hasSettingsEnvelope
      ? assertOptionalEnvelope(safePatch.settingsEnvelope, "settingsEnvelope")
      : undefined;

    const row = await this._db.transaction(async (transaction) => {
      const current = firstRow(
        await transaction.query("SELECT * FROM profiles WHERE id = $1 FOR UPDATE", [id])
      );
      if (!current || current.status !== "active") return null;
      if (toSafeInteger(current.revision, "profile revision", 1) !== expected) {
        throw revisionConflict();
      }
      const now = readClock(this._clock);
      const result = await transaction.query(
        `UPDATE profiles
            SET display_name = $3,
                settings_envelope = $4,
                revision = revision + 1,
                updated_at = $5
          WHERE id = $1 AND revision = $2 AND status = 'active'
          RETURNING *`,
        [
          id,
          expected,
          hasDisplayName ? nextDisplayName : current.display_name,
          hasSettingsEnvelope ? nextSettingsEnvelope : current.settings_envelope,
          dateParameter(now, "profile updatedAt"),
        ]
      );
      if (affectedRows(result) !== 1) throw revisionConflict();
      await this._playbackSessions.invalidateProfileInTransaction(
        transaction,
        id,
        expected + 1,
        now
      );
      return firstRow(result);
    });
    return row ? mapProfileRow(row) : null;
  }

  async rotateInstallToken(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);
    let rotated;
    try {
      rotated = await this._db.transaction(async (transaction) => {
        const current = firstRow(
          await transaction.query("SELECT * FROM profiles WHERE id = $1 FOR UPDATE", [id])
        );
        if (!current || current.status !== "active") return null;
        if (toSafeInteger(current.revision, "profile revision", 1) !== expected) {
          throw revisionConflict();
        }
        const issued = this._tokens.issue("install", 32);
        const now = readClock(this._clock);
        const result = await transaction.query(
          `UPDATE profiles
              SET install_token_hash = $3,
                  revision = revision + 1,
                  updated_at = $4
            WHERE id = $1 AND revision = $2 AND status = 'active'
            RETURNING *`,
          [id, expected, issued.tokenHash, dateParameter(now, "profile updatedAt")]
        );
        if (affectedRows(result) !== 1) throw revisionConflict();
        await this._playbackSessions.invalidateProfileInTransaction(
          transaction,
          id,
          expected + 1,
          now
        );
        return { row: firstRow(result), installToken: issued.token };
      });
    } catch (error) {
      if (uniqueConstraint(error, "profiles_install_token_hash_key")) {
        throw new Error("install token collision");
      }
      throw error;
    }
    return rotated
      ? { profile: mapProfileRow(rotated.row), installToken: rotated.installToken }
      : null;
  }

  async revoke(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);
    const row = await this._db.transaction(async (transaction) => {
      const current = firstRow(
        await transaction.query("SELECT * FROM profiles WHERE id = $1 FOR UPDATE", [id])
      );
      if (!current) return false;
      if (toSafeInteger(current.revision, "profile revision", 1) !== expected) {
        throw revisionConflict();
      }
      if (current.status === "revoked") {
        await this._playbackSessions.invalidateProfileInTransaction(
          transaction,
          id,
          toSafeInteger(current.revision, "profile revision", 1)
        );
        await this._subtitleManifests.requestProfileDeletionInTransaction(
          transaction,
          id,
          "profile_revoked"
        );
        return true;
      }
      const now = readClock(this._clock);
      const result = await transaction.query(
        `UPDATE profiles
            SET status = 'revoked',
                revoked_at = $3,
                updated_at = $3,
                revision = revision + 1
          WHERE id = $1 AND revision = $2 AND status = 'active'
          RETURNING *`,
        [id, expected, dateParameter(now, "profile revokedAt")]
      );
      if (affectedRows(result) !== 1) throw revisionConflict();
      const revoked = firstRow(result);
      await this._playbackSessions.invalidateProfileInTransaction(
        transaction,
        id,
        toSafeInteger(revoked.revision, "profile revision", 1),
        now
      );
      await this._lifecycleInvalidations.enqueueProfileRow(
        id,
        toSafeInteger(revoked.revision, "profile revision", 1),
        transaction
      );
      await this._subtitleManifests.requestProfileDeletionInTransaction(
        transaction,
        id,
        "profile_revoked",
        now
      );
      return true;
    });
    return row;
  }

  async beginErasure(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);
    const row = await this._db.transaction(async (transaction) => {
      const current = firstRow(
        await transaction.query("SELECT * FROM profiles WHERE id = $1 FOR UPDATE", [id])
      );
      if (!current) return null;
      if (current.deletion_state === "pending" || current.deletion_state === "deleted") {
        if (current.deletion_state === "pending") {
          await this._subtitleManifests.requestProfileDeletionInTransaction(
            transaction,
            id,
            "profile_erasure"
          );
        }
        return current;
      }
      if (current.status !== "active") return null;
      if (toSafeInteger(current.revision, "profile revision", 1) !== expected) {
        throw revisionConflict();
      }
      const now = readClock(this._clock);
      const result = await transaction.query(
        `UPDATE profiles
            SET status = 'revoked', revoked_at = $3, updated_at = $3,
                revision = revision + 1, deletion_state = 'pending',
                deletion_started_at = $3, erasure_attempt_count = 0,
                erasure_next_attempt_at = $3
          WHERE id = $1 AND revision = $2 AND status = 'active'
            AND deletion_state = 'none'
          RETURNING *`,
        [id, expected, dateParameter(now, "profile deletionStartedAt")]
      );
      if (affectedRows(result) !== 1) throw revisionConflict();
      const pending = firstRow(result);
      await this._playbackSessions.invalidateProfileInTransaction(
        transaction,
        id,
        toSafeInteger(pending.revision, "profile revision", 1),
        now
      );
      await this._lifecycleInvalidations.enqueueProfileRow(
        id,
        toSafeInteger(pending.revision, "profile revision", 1),
        transaction
      );
      await this._subtitleManifests.requestProfileDeletionInTransaction(
        transaction,
        id,
        "profile_erasure",
        now
      );
      return pending;
    });
    return row ? mapProfileRow(row) : null;
  }

  async erase(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    try {
      return await this._db.transaction(async (transaction) => {
        const current = firstRow(
          await transaction.query("SELECT * FROM profiles WHERE id = $1 FOR UPDATE", [id])
        );
        if (!current) return false;
        if (current.deletion_state === "deleted") return true;
        if (current.deletion_state !== "pending" || current.status !== "revoked") return false;
        if (await this._subtitleManifests.hasProfileInTransaction(transaction, id)) {
          throw codedError(
            "profile_erasure_pending",
            "protected subtitle objects are still pending deletion"
          );
        }
        await this._playbackSessions.eraseProfileInTransaction(transaction, id);
        for (const table of [
          "devices",
          "providers",
          "provider_collections",
          "oauth_credentials",
          "cloud_history",
          "addon_collection_backups",
        ]) {
          await transaction.query(`DELETE FROM ${table} WHERE profile_id = $1`, [id]);
        }
        const replacement = this._tokens.issue("install", 32);
        const now = readClock(this._clock);
        const result = await transaction.query(
          `UPDATE profiles
              SET install_token_hash = $2, display_name = '', settings_envelope = NULL,
                  deletion_state = 'deleted', durable_erased_at = $3, updated_at = $3,
                  revision = revision + 1
            WHERE id = $1 AND deletion_state = 'pending' AND status = 'revoked'
            RETURNING id`,
          [id, replacement.tokenHash, dateParameter(now, "profile durableErasedAt")]
        );
        if (affectedRows(result) !== 1) throw revisionConflict();
        return true;
      });
    } catch (error) {
      if (uniqueConstraint(error, "profiles_install_token_hash_key")) {
        throw new Error("install token collision");
      }
      throw error;
    }
  }

  async getErasureStatus(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const row = firstRow(
      await this._db.query(
        `SELECT deletion_state, deletion_started_at, durable_erased_at,
                erasure_attempt_count, erasure_next_attempt_at
           FROM profiles WHERE id = $1`,
        [id]
      )
    );
    if (!row || row.deletion_state === "none") return null;
    return {
      status: row.deletion_state,
      startedAt: row.deletion_started_at === null
        ? null
        : toTimestamp(row.deletion_started_at, "profile deletionStartedAt"),
      durableErasedAt: row.durable_erased_at === null
        ? null
        : toTimestamp(row.durable_erased_at, "profile durableErasedAt"),
      attemptCount: toSafeInteger(
        row.erasure_attempt_count === undefined ? 0 : row.erasure_attempt_count,
        "profile erasureAttemptCount"
      ),
      nextAttemptAt: row.erasure_next_attempt_at === null || row.erasure_next_attempt_at === undefined
        ? null
        : toTimestamp(row.erasure_next_attempt_at, "profile erasureNextAttemptAt"),
    };
  }

  async listPendingErasures(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("pending erasure limit is invalid");
    }
    const result = await this._db.query(
      `SELECT id, deletion_started_at, erasure_attempt_count, erasure_next_attempt_at
         FROM profiles
        WHERE deletion_state = 'pending' AND erasure_next_attempt_at <= $1
        ORDER BY erasure_next_attempt_at, deletion_started_at, id LIMIT $2`,
      [dateParameter(readClock(this._clock), "profile erasure timestamp"), limit]
    );
    return (result.rows || []).map((row) => ({
      profileId: row.id,
      startedAt: toTimestamp(row.deletion_started_at, "profile deletionStartedAt"),
      attemptCount: toSafeInteger(row.erasure_attempt_count, "profile erasureAttemptCount"),
      nextAttemptAt: toTimestamp(row.erasure_next_attempt_at, "profile erasureNextAttemptAt"),
    }));
  }

  async deferErasure(profileId, expectedAttemptCount, nextAttemptAt) {
    const id = assertIdentifier(profileId, "profile id");
    if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
      throw new TypeError("profile erasure attempt count is invalid");
    }
    if (!Number.isSafeInteger(nextAttemptAt) || nextAttemptAt < 0) {
      throw new TypeError("profile erasure retry timestamp is invalid");
    }
    const result = await this._db.query(
      `UPDATE profiles
          SET erasure_attempt_count = erasure_attempt_count + 1,
              erasure_next_attempt_at = $2, updated_at = $3
        WHERE id = $1 AND deletion_state = 'pending' AND erasure_attempt_count = $4`,
      [
        id,
        dateParameter(nextAttemptAt, "profile erasure retry timestamp"),
        dateParameter(readClock(this._clock), "profile erasure updatedAt"),
        expectedAttemptCount,
      ]
    );
    return affectedRows(result) === 1;
  }
}

module.exports = {
  PostgresProfileRepository,
};
