"use strict";

const crypto = require("node:crypto");

const { ProfileLifecycleCoordinator } = require("../lifecycle-invalidation");
const {
  assertDisplayName,
  assertIdentifier,
  assertRevision,
  cloneJson,
  codedError,
  readClock,
  revisionConflict,
} = require("../repository-utils");
const { SqliteSubtitleManifestRepository } = require("./subtitle-manifests");
const { withImmediateTransaction } = require("./connection");
const { SqliteLifecycleInvalidationRepository } = require("./lifecycle-invalidations");
const { SqlitePlaybackSessionRepository } = require("./playback-sessions");
const {
  assertOptionalEnvelope,
  assertOptionalHash,
  assertProfilePatch,
  normalizeRepositoryOptions,
  parseJson,
  requireDatabase,
  stringifyJson,
} = require("./helpers");

function mapProfile(row, includeTokenHash = false) {
  if (!row) return null;
  const profile = {
    schemaVersion: row.schema_version,
    id: row.id,
    displayName: row.display_name,
    settingsEnvelope:
      row.settings_envelope === null
        ? null
        : parseJson(row.settings_envelope, "settings envelope"),
    legacyConfigHash: row.legacy_config_hash,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    historyGeneration: row.history_generation,
    deletionState: row.deletion_state,
    deletionStartedAt: row.deletion_started_at,
    durableErasedAt: row.durable_erased_at,
    erasureAttemptCount: row.erasure_attempt_count,
    erasureNextAttemptAt: row.erasure_next_attempt_at,
  };
  if (includeTokenHash) profile.installTokenHash = row.install_token_hash;
  return profile;
}

class SqliteProfileRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._db = requireDatabase(options);
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    this._lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();
    this._lifecycleInvalidations =
      options.lifecycleInvalidations ||
      new SqliteLifecycleInvalidationRepository({ database: this._db, clock: this._clock });
    this._playbackSessions =
      options.playbackSessions ||
      new SqlitePlaybackSessionRepository({
        database: this._db,
        tokenService: this._tokens,
        clock: this._clock,
        lifecycleCoordinator: this._lifecycleCoordinator,
      });
    this._subtitleManifests =
      options.subtitleManifests ||
      new SqliteSubtitleManifestRepository({
        database: this._db,
        tokenService: this._tokens,
        clock: this._clock,
        lifecycleCoordinator: this._lifecycleCoordinator,
      });

    this._getById = this._db.prepare("SELECT * FROM profiles WHERE id = ?");
    this._getByTokenHash = this._db.prepare(
      "SELECT * FROM profiles WHERE install_token_hash = ? AND status = 'active'"
    );
    this._hasId = this._db.prepare("SELECT 1 AS present FROM profiles WHERE id = ?");
    this._hasTokenHash = this._db.prepare(
      "SELECT 1 AS present FROM profiles WHERE install_token_hash = ?"
    );
    this._getAlias = this._db.prepare(
      "SELECT profile_id FROM legacy_config_aliases WHERE legacy_config_hash = ?"
    );
    this._insert = this._db.prepare(`
      INSERT INTO profiles (
        id, schema_version, install_token_hash, display_name, settings_envelope,
        legacy_config_hash, status, revision, created_at, updated_at, revoked_at
      ) VALUES (?, 1, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)
    `);
    this._insertAlias = this._db.prepare(`
      INSERT INTO legacy_config_aliases (
        legacy_config_hash, profile_id, schema_version, created_at
      ) VALUES (?, ?, 1, ?)
    `);
    this._update = this._db.prepare(`
      UPDATE profiles
      SET display_name = ?, settings_envelope = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'active' AND revision = ?
    `);
    this._rotate = this._db.prepare(`
      UPDATE profiles
      SET install_token_hash = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'active' AND revision = ?
    `);
    this._revoke = this._db.prepare(`
      UPDATE profiles
      SET status = 'revoked', revoked_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ? AND revision = ? AND status = 'active'
    `);
    this._beginErasure = this._db.prepare(`
      UPDATE profiles
      SET status = 'revoked', revoked_at = ?, updated_at = ?, revision = revision + 1,
          deletion_state = 'pending', deletion_started_at = ?,
          erasure_attempt_count = 0, erasure_next_attempt_at = ?
      WHERE id = ? AND revision = ? AND status = 'active' AND deletion_state = 'none'
    `);
    this._eraseDevices = this._db.prepare("DELETE FROM devices WHERE profile_id = ?");
    this._eraseProviders = this._db.prepare("DELETE FROM providers WHERE profile_id = ?");
    this._eraseProviderCollection = this._db.prepare(
      "DELETE FROM provider_collections WHERE profile_id = ?"
    );
    this._eraseOauth = this._db.prepare("DELETE FROM oauth_credentials WHERE profile_id = ?");
    this._eraseHistory = this._db.prepare("DELETE FROM cloud_history WHERE profile_id = ?");
    this._eraseBackups = this._db.prepare(
      "DELETE FROM addon_collection_backups WHERE profile_id = ?"
    );
    this._finishErasure = this._db.prepare(`
      UPDATE profiles
      SET install_token_hash = ?, display_name = '', settings_envelope = NULL,
          deletion_state = 'deleted', durable_erased_at = ?, updated_at = ?,
          revision = revision + 1
      WHERE id = ? AND deletion_state = 'pending' AND status = 'revoked'
    `);
    this._pendingErasures = this._db.prepare(`
      SELECT id, deletion_started_at, erasure_attempt_count, erasure_next_attempt_at
      FROM profiles
      WHERE deletion_state = 'pending' AND erasure_next_attempt_at <= ?
      ORDER BY erasure_next_attempt_at, deletion_started_at, id LIMIT ?
    `);
    this._deferErasure = this._db.prepare(`
      UPDATE profiles
      SET erasure_attempt_count = erasure_attempt_count + 1,
          erasure_next_attempt_at = ?, updated_at = ?
      WHERE id = ? AND deletion_state = 'pending' AND erasure_attempt_count = ?
    `);
    this._snapshot = this._db.prepare("SELECT * FROM profiles ORDER BY rowid");
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
    const settingsText =
      settingsEnvelope === null
        ? null
        : stringifyJson(settingsEnvelope, "settingsEnvelope", 1024 * 1024);

    return withImmediateTransaction(this._db, () => {
      if (this._hasId.get(id)) throw new Error("profile id collision");
      if (this._hasTokenHash.get(issued.tokenHash)) throw new Error("install token collision");
      if (legacyConfigHash !== null) {
        const existing = this._getAlias.get(legacyConfigHash);
        if (existing && existing.profile_id !== id) {
          const error = new Error("legacy config alias belongs to another profile");
          error.code = "legacy_alias_conflict";
          throw error;
        }
      }

      this._insert.run(
        id,
        issued.tokenHash,
        displayName,
        settingsText,
        legacyConfigHash,
        now,
        now
      );
      if (legacyConfigHash !== null) this._insertAlias.run(legacyConfigHash, id, now);
      return { profile: mapProfile(this._getById.get(id)), installToken: issued.token };
    });
  }

  async getById(profileId) {
    return mapProfile(this._getById.get(assertIdentifier(profileId, "profile id")));
  }

  async getByInstallToken(token) {
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("install", token);
    } catch (_error) {
      return null;
    }
    return mapProfile(this._getByTokenHash.get(tokenHash));
  }

  async update(profileId, patch = {}, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const safePatch = assertProfilePatch(patch);
    const expected = assertRevision(expectedRevision, false);

    return this._lifecycleCoordinator.run(id, async () =>
      withImmediateTransaction(this._db, () => {
        const current = this._getById.get(id);
        if (!current || current.status !== "active") return null;
        if (current.revision !== expected) throw revisionConflict();

        const displayName = Object.prototype.hasOwnProperty.call(safePatch, "displayName")
          ? assertDisplayName(safePatch.displayName)
          : current.display_name;
        let settingsEnvelope =
          current.settings_envelope === null
            ? null
            : parseJson(current.settings_envelope, "settings envelope");
        if (Object.prototype.hasOwnProperty.call(safePatch, "settingsEnvelope")) {
          settingsEnvelope = assertOptionalEnvelope(safePatch.settingsEnvelope, "settingsEnvelope");
        }
        const settingsText =
          settingsEnvelope === null
            ? null
            : stringifyJson(settingsEnvelope, "settingsEnvelope", 1024 * 1024);
        const now = readClock(this._clock);
        const result = this._update.run(displayName, settingsText, now, id, expected);
        if (result.changes !== 1) throw revisionConflict();
        this._playbackSessions.invalidateProfileInTransaction(id, expected + 1, now);
        return mapProfile(this._getById.get(id));
      })
    );
  }

  async rotateInstallToken(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);

    return this._lifecycleCoordinator.run(id, async () =>
      withImmediateTransaction(this._db, () => {
        const current = this._getById.get(id);
        if (!current || current.status !== "active") return null;
        if (current.revision !== expected) throw revisionConflict();
        const issued = this._tokens.issue("install", 32);
        if (this._hasTokenHash.get(issued.tokenHash)) throw new Error("install token collision");
        const now = readClock(this._clock);
        const result = this._rotate.run(
          issued.tokenHash,
          now,
          id,
          expected
        );
        if (result.changes !== 1) throw revisionConflict();
        this._playbackSessions.invalidateProfileInTransaction(id, expected + 1, now);
        return { profile: mapProfile(this._getById.get(id)), installToken: issued.token };
      })
    );
  }

  async revoke(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);

    return this._lifecycleCoordinator.run(id, async () =>
      withImmediateTransaction(this._db, () => {
        const current = this._getById.get(id);
        if (!current) return false;
        if (current.revision !== expected) throw revisionConflict();
        if (current.status === "revoked") {
          this._playbackSessions.invalidateProfileInTransaction(
            id,
            current.revision
          );
          this._subtitleManifests.requestProfileDeletionNow(id, "profile_revoked");
          return true;
        }
        const now = readClock(this._clock);
        const result = this._revoke.run(now, now, id, expected);
        if (result.changes !== 1) throw revisionConflict();
        this._playbackSessions.invalidateProfileInTransaction(id, expected + 1, now);
        this._lifecycleInvalidations.enqueueProfile(id, expected + 1);
        this._subtitleManifests.requestProfileDeletionNow(id, "profile_revoked", now);
        return true;
      })
    );
  }

  async beginErasure(profileId, expectedRevision) {
    const id = assertIdentifier(profileId, "profile id");
    const expected = assertRevision(expectedRevision, false);
    return this._lifecycleCoordinator.run(id, async () =>
      withImmediateTransaction(this._db, () => {
        const current = this._getById.get(id);
        if (!current) return null;
        if (current.deletion_state === "pending" || current.deletion_state === "deleted") {
          if (current.deletion_state === "pending") {
            this._subtitleManifests.requestProfileDeletionNow(id, "profile_erasure");
          }
          return mapProfile(current);
        }
        if (current.status !== "active") return null;
        if (current.revision !== expected) throw revisionConflict();
        const now = readClock(this._clock);
        const result = this._beginErasure.run(now, now, now, now, id, expected);
        if (result.changes !== 1) throw revisionConflict();
        this._playbackSessions.invalidateProfileInTransaction(id, expected + 1, now);
        this._lifecycleInvalidations.enqueueProfile(id, expected + 1);
        this._subtitleManifests.requestProfileDeletionNow(id, "profile_erasure", now);
        return mapProfile(this._getById.get(id));
      })
    );
  }

  async erase(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(id, async () =>
      withImmediateTransaction(this._db, () => {
        const current = this._getById.get(id);
        if (!current) return false;
        if (current.deletion_state === "deleted") return true;
        if (current.deletion_state !== "pending" || current.status !== "revoked") return false;
        if (this._subtitleManifests.hasProfileNow(id)) {
          throw codedError(
            "profile_erasure_pending",
            "protected subtitle objects are still pending deletion"
          );
        }
        this._playbackSessions.eraseProfileInTransaction(id);
        this._eraseDevices.run(id);
        this._eraseProviders.run(id);
        this._eraseProviderCollection.run(id);
        this._eraseOauth.run(id);
        this._eraseHistory.run(id);
        this._eraseBackups.run(id);
        const replacement = this._tokens.issue("install", 32);
        if (this._hasTokenHash.get(replacement.tokenHash)) throw new Error("install token collision");
        const now = readClock(this._clock);
        const result = this._finishErasure.run(replacement.tokenHash, now, now, id);
        if (result.changes !== 1) throw revisionConflict();
        return true;
      })
    );
  }

  async getErasureStatus(profileId) {
    const row = this._getById.get(assertIdentifier(profileId, "profile id"));
    if (!row || row.deletion_state === "none") return null;
    return {
      status: row.deletion_state,
      startedAt: row.deletion_started_at,
      durableErasedAt: row.durable_erased_at,
      attemptCount: row.erasure_attempt_count,
      nextAttemptAt: row.erasure_next_attempt_at,
    };
  }

  async listPendingErasures(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("pending erasure limit is invalid");
    }
    return this._pendingErasures.all(readClock(this._clock), limit).map((row) => ({
      profileId: row.id,
      startedAt: row.deletion_started_at,
      attemptCount: row.erasure_attempt_count,
      nextAttemptAt: row.erasure_next_attempt_at,
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
    return withImmediateTransaction(this._db, () =>
      this._deferErasure.run(
        nextAttemptAt,
        readClock(this._clock),
        id,
        expectedAttemptCount
      ).changes === 1
    );
  }

  storageSnapshot() {
    return this._snapshot.all().map((row) => cloneJson(mapProfile(row, true)));
  }
}

module.exports = {
  SqliteProfileRepository,
};
