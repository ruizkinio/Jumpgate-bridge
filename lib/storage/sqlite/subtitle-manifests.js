"use strict";

const {
  addDuration,
  assertIdentifier,
  codedError,
  readClock,
} = require("../repository-utils");
const {
  normalizeAbsence,
  normalizeConfirmation,
  normalizeDeletionClaim,
  normalizeManifest,
  normalizeReason,
  normalizeRetry,
  publicManifest,
  sameManifest,
} = require("../subtitle-manifest");
const { withImmediateTransaction } = require("./connection");

function mapPart(row) {
  return {
    partNumber: row.part_number,
    objectKey: row.object_key,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    mediaType: row.media_type,
  };
}

function mapManifest(row, parts) {
  return {
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    deviceId: row.device_id,
    deviceGeneration: row.device_generation,
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    playbackGeneration: row.playback_generation,
    contextRevision: row.context_revision,
    providerRevision: row.provider_revision,
    expiresAt: row.expires_at,
    uploadSettlementDeadline: row.upload_settlement_deadline,
    parts,
    state: row.state,
    deletionReason: row.deletion_reason,
    nextAttemptAt: row.next_attempt_at,
    attemptCount: row.attempt_count,
    firstAbsentAt: row.first_absent_at,
    leaseTokenHash: row.lease_token_hash,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function manifestConflict() {
  return codedError("subtitle_manifest_conflict", "subtitle manifest already differs");
}

class SqliteSubtitleManifestRepository {
  constructor(options = {}) {
    if (!options.database) throw new TypeError("database is required");
    if (!options.tokenService) throw new TypeError("tokenService is required");
    if (!options.lifecycleCoordinator || typeof options.lifecycleCoordinator.run !== "function") {
      throw new TypeError("lifecycleCoordinator is required");
    }
    this._db = options.database;
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._lifecycleCoordinator = options.lifecycleCoordinator;
    this._profile = this._db.prepare(
      "SELECT revision, status, deletion_state FROM profiles WHERE id = ?"
    );
    this._device = this._db.prepare(
      `SELECT generation, revoked_at, expires_at FROM devices
        WHERE id = ? AND profile_id = ?`
    );
    this._manifest = this._db.prepare(
      "SELECT * FROM subtitle_object_manifests WHERE artifact_id = ?"
    );
    this._parts = this._db.prepare(
      `SELECT * FROM subtitle_object_manifest_parts
        WHERE artifact_id = ? ORDER BY part_number`
    );
    this._insertManifest = this._db.prepare(`
      INSERT INTO subtitle_object_manifests (
        artifact_id, profile_id, profile_revision, device_id, device_generation,
        session_id, playback_generation, context_revision, provider_revision,
        expires_at, upload_settlement_deadline, state, deletion_reason,
        next_attempt_at, attempt_count, first_absent_at,
        lease_token_hash, lease_owner, lease_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'uploading', NULL, ?, 0, NULL,
                NULL, NULL, NULL, ?, ?)
    `);
    this._insertPart = this._db.prepare(`
      INSERT INTO subtitle_object_manifest_parts (
        artifact_id, part_number, object_key, size_bytes, checksum, media_type
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this._activate = this._db.prepare(`
      UPDATE subtitle_object_manifests
         SET state = 'active', updated_at = ?
       WHERE artifact_id = ? AND profile_id = ? AND state = 'uploading'
    `);
    this._requestProfileDeletion = this._db.prepare(`
      UPDATE subtitle_object_manifests
         SET state = 'deletion_requested', deletion_reason = ?,
             next_attempt_at = max(?, upload_settlement_deadline),
             first_absent_at = NULL, lease_token_hash = NULL, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
       WHERE profile_id = ? AND state IN ('uploading', 'active')
    `);
    this._requestDeviceDeletion = this._db.prepare(`
      UPDATE subtitle_object_manifests
         SET state = 'deletion_requested', deletion_reason = ?,
             next_attempt_at = max(?, upload_settlement_deadline),
             first_absent_at = NULL, lease_token_hash = NULL, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
       WHERE profile_id = ? AND device_id = ? AND state IN ('uploading', 'active')
    `);
    this._requestArtifactDeletion = this._db.prepare(`
      UPDATE subtitle_object_manifests
         SET state = 'deletion_requested', deletion_reason = ?,
             next_attempt_at = max(?, upload_settlement_deadline),
             first_absent_at = NULL, lease_token_hash = NULL, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
       WHERE artifact_id = ? AND profile_id = ? AND state IN ('uploading', 'active')
    `);
    this._requestExpired = this._db.prepare(`
      UPDATE subtitle_object_manifests
         SET state = 'deletion_requested',
             deletion_reason = CASE WHEN state = 'active' THEN 'expired' ELSE 'upload_unsettled' END,
             next_attempt_at = max(?, upload_settlement_deadline),
             first_absent_at = NULL, lease_token_hash = NULL, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?
       WHERE (state = 'active' AND expires_at <= ?)
          OR (state = 'uploading' AND upload_settlement_deadline <= ?)
    `);
    this._eligible = this._db.prepare(`
      SELECT * FROM subtitle_object_manifests
       WHERE state IN ('deletion_requested', 'first_absent')
         AND next_attempt_at <= ? AND upload_settlement_deadline <= ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY next_attempt_at, created_at, artifact_id
       LIMIT 1
    `);
    this._claim = this._db.prepare(`
      UPDATE subtitle_object_manifests
         SET lease_token_hash = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ?
       WHERE artifact_id = ?
    `);
    this._firstAbsent = this._db.prepare(`
      UPDATE subtitle_object_manifests
         SET state = 'first_absent', first_absent_at = ?, next_attempt_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?
       WHERE artifact_id = ? AND state = 'deletion_requested'
         AND lease_token_hash = ? AND lease_expires_at > ?
    `);
    this._retry = this._db.prepare(`
      UPDATE subtitle_object_manifests
         SET attempt_count = attempt_count + 1, next_attempt_at = ?,
             lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL,
             updated_at = ?
       WHERE artifact_id = ? AND state IN ('deletion_requested', 'first_absent')
         AND lease_token_hash = ? AND lease_expires_at > ?
    `);
    this._confirm = this._db.prepare(`
      DELETE FROM subtitle_object_manifests
       WHERE artifact_id = ? AND state = 'first_absent'
         AND lease_token_hash = ? AND lease_expires_at > ?
    `);
    this._hasProfile = this._db.prepare(
      "SELECT 1 FROM subtitle_object_manifests WHERE profile_id = ? LIMIT 1"
    );
    this._hasDevice = this._db.prepare(
      `SELECT 1 FROM subtitle_object_manifests
        WHERE profile_id = ? AND device_id = ? LIMIT 1`
    );
    this._listProfile = this._db.prepare(
      `SELECT * FROM subtitle_object_manifests
        WHERE profile_id = ? ORDER BY created_at, artifact_id`
    );
  }

  async reserve(input) {
    const candidate = normalizeManifest(input);
    if (candidate.profileRevision < 1) throw new TypeError("profile revision is invalid");
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      try {
        return withImmediateTransaction(this._db, () => {
          const now = readClock(this._clock);
          this._assertBinding(candidate, now);
          const existing = this._load(candidate.artifactId);
          if (existing) {
            if (!sameManifest(existing, candidate)) throw manifestConflict();
            return publicManifest(existing);
          }
          this._insertManifest.run(
            candidate.artifactId,
            candidate.profileId,
            candidate.profileRevision,
            candidate.deviceId,
            candidate.deviceGeneration,
            candidate.sessionId,
            candidate.playbackGeneration,
            candidate.contextRevision,
            candidate.providerRevision,
            candidate.expiresAt,
            candidate.uploadSettlementDeadline,
            candidate.uploadSettlementDeadline,
            now,
            now
          );
          for (const part of candidate.parts) {
            this._insertPart.run(
              candidate.artifactId,
              part.partNumber,
              part.objectKey,
              part.sizeBytes,
              part.checksum,
              part.mediaType
            );
          }
          return publicManifest({
            ...candidate,
            state: "uploading",
            deletionReason: null,
            nextAttemptAt: candidate.uploadSettlementDeadline,
            attemptCount: 0,
            firstAbsentAt: null,
            leaseTokenHash: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            createdAt: now,
            updatedAt: now,
          });
        });
      } catch (error) {
        if (error && String(error.code || "").startsWith("SQLITE_CONSTRAINT")) {
          throw manifestConflict();
        }
        throw error;
      }
    });
  }

  async commit(input) {
    const value = input && typeof input === "object" ? input : {};
    const profileId = assertIdentifier(value.profileId, "profile id");
    const artifactId = assertIdentifier(value.artifactId, "artifact id");
    return this._lifecycleCoordinator.run(profileId, async () =>
      withImmediateTransaction(this._db, () => {
        const record = this._load(artifactId);
        if (!record || record.profileId !== profileId) return null;
        if (record.state === "active") return publicManifest(record);
        if (record.state !== "uploading") return null;
        const now = readClock(this._clock);
        try {
          this._assertBinding(record, now);
        } catch (error) {
          if (!error || !["profile_inactive", "device_generation_changed"].includes(error.code)) {
            throw error;
          }
          this._requestArtifactDeletion.run(
            "lifecycle_changed",
            now,
            now,
            artifactId,
            profileId
          );
          return null;
        }
        if (this._activate.run(now, artifactId, profileId).changes !== 1) return null;
        return publicManifest(this._load(artifactId));
      })
    );
  }

  requestProfileDeletionNow(profileId, reason = "profile_revoked", nowValue) {
    const id = assertIdentifier(profileId, "profile id");
    const now = nowValue === undefined ? readClock(this._clock) : nowValue;
    return this._requestProfileDeletion.run(
      normalizeReason(reason, "profile_revoked"),
      now,
      now,
      id
    ).changes;
  }

  async requestProfileDeletion(profileId, reason = "profile_revoked") {
    const id = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(id, async () =>
      withImmediateTransaction(this._db, () => this.requestProfileDeletionNow(id, reason))
    );
  }

  async requestArtifactDeletion(profileId, artifactId, reason = "delivery_cleanup") {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(artifactId, "artifact id");
    return this._lifecycleCoordinator.run(scopedProfileId, async () =>
      withImmediateTransaction(this._db, () => {
        const now = readClock(this._clock);
        return this._requestArtifactDeletion.run(
          normalizeReason(reason, "delivery_cleanup"),
          now,
          now,
          id,
          scopedProfileId
        ).changes;
      })
    );
  }

  requestDeviceDeletionNow(profileId, deviceId, reason = "device_revoked", nowValue) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    const now = nowValue === undefined ? readClock(this._clock) : nowValue;
    return this._requestDeviceDeletion.run(
      normalizeReason(reason, "device_revoked"),
      now,
      now,
      scopedProfileId,
      id
    ).changes;
  }

  async requestDeviceDeletion(profileId, deviceId, reason = "device_revoked") {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(scopedProfileId, async () =>
      withImmediateTransaction(this._db, () =>
        this.requestDeviceDeletionNow(scopedProfileId, deviceId, reason)
      )
    );
  }

  async claimDeletion(options = {}) {
    const claim = normalizeDeletionClaim(options);
    const lease = this._tokens.issue("subtitle-manifest-deletion", 32);
    return withImmediateTransaction(this._db, () => {
      const now = readClock(this._clock);
      this._requestExpired.run(now, now, now, now);
      const selected = this._eligible.get(now, now, now);
      if (!selected) return null;
      const leaseExpiresAt = addDuration(now, claim.leaseMs, "subtitle deletion lease");
      if (this._claim.run(
        lease.tokenHash,
        claim.workerId,
        leaseExpiresAt,
        now,
        selected.artifact_id
      ).changes !== 1) return null;
      const record = this._load(selected.artifact_id);
      return Object.freeze({
        artifactId: record.artifactId,
        profileId: record.profileId,
        deviceId: record.deviceId,
        phase: record.state === "first_absent" ? "second" : "first",
        deletionToken: lease.token,
        parts: Object.freeze(record.parts.map((part) => Object.freeze({ ...part }))),
      });
    });
  }

  async recordDeletionAbsence(input) {
    const value = normalizeAbsence(input);
    if (!value.verifiedAbsent) return null;
    const tokenHash = this._tokenHash(value.deletionToken);
    if (!tokenHash) return null;
    return withImmediateTransaction(this._db, () => {
      const now = readClock(this._clock);
      const retryAt = addDuration(now, value.secondPassDelayMs, "subtitle deletion second pass");
      const changed = this._firstAbsent.run(
        now,
        retryAt,
        now,
        value.artifactId,
        tokenHash,
        now
      ).changes;
      return changed === 1
        ? Object.freeze({ status: "awaiting_second_pass", retryAt })
        : null;
    });
  }

  async retryDeletion(input) {
    const value = normalizeRetry(input);
    const tokenHash = this._tokenHash(value.deletionToken);
    if (!tokenHash) return null;
    return withImmediateTransaction(this._db, () => {
      const now = readClock(this._clock);
      const retryAt = addDuration(now, value.retryDelayMs, "subtitle deletion retry");
      const changed = this._retry.run(
        retryAt,
        now,
        value.artifactId,
        tokenHash,
        now
      ).changes;
      return changed === 1 ? Object.freeze({ status: "retrying", retryAt }) : null;
    });
  }

  async confirmDeletion(input) {
    const value = normalizeConfirmation(input);
    if (!value.verifiedAbsent) return null;
    const tokenHash = this._tokenHash(value.deletionToken);
    if (!tokenHash) return null;
    return withImmediateTransaction(this._db, () =>
      this._confirm.run(value.artifactId, tokenHash, readClock(this._clock)).changes === 1
        ? Object.freeze({ status: "confirmed" })
        : null
    );
  }

  async hasProfile(profileId) {
    return Boolean(this._hasProfile.get(assertIdentifier(profileId, "profile id")));
  }

  hasProfileNow(profileId) {
    return Boolean(this._hasProfile.get(assertIdentifier(profileId, "profile id")));
  }

  async hasDevice(profileId, deviceId) {
    return Boolean(this._hasDevice.get(
      assertIdentifier(profileId, "profile id"),
      assertIdentifier(deviceId, "device id")
    ));
  }

  async listProfile(profileId) {
    const rows = this._listProfile.all(assertIdentifier(profileId, "profile id"));
    return rows.map((row) => publicManifest(mapManifest(row, this._parts.all(row.artifact_id).map(mapPart))));
  }

  _assertBinding(binding, now) {
    const profile = this._profile.get(binding.profileId);
    if (!profile || profile.status !== "active" || profile.deletion_state !== "none" ||
        profile.revision !== binding.profileRevision) {
      throw codedError("profile_inactive", "profile changed before subtitle manifest write");
    }
    const device = this._device.get(binding.deviceId, binding.profileId);
    if (!device || device.revoked_at !== null || device.generation !== binding.deviceGeneration ||
        device.expires_at <= now) {
      throw codedError("device_generation_changed", "device changed before subtitle manifest write");
    }
  }

  _load(artifactId) {
    const row = this._manifest.get(artifactId);
    return row ? mapManifest(row, this._parts.all(artifactId).map(mapPart)) : null;
  }

  _tokenHash(token) {
    try {
      return this._tokens.hashToken("subtitle-manifest-deletion", token);
    } catch (_error) {
      return null;
    }
  }
}

module.exports = {
  SQLiteSubtitleManifestRepository: SqliteSubtitleManifestRepository,
  SqliteSubtitleManifestRepository,
};
