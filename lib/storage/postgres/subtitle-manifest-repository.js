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
const {
  affectedRows,
  dateParameter,
  firstRow,
  requireDatabase,
  resultRows,
  toSafeInteger,
  toTimestamp,
} = require("./repository-helpers");

function decimal(value, name) {
  const text = String(value);
  if (!/^(?:0|[1-9][0-9]{0,127})$/.test(text)) throw new TypeError(name + " is invalid");
  return text;
}

function mapPart(row) {
  return {
    partNumber: toSafeInteger(row.part_number, "subtitle part number", 1),
    objectKey: String(row.object_key),
    sizeBytes: toSafeInteger(row.size_bytes, "subtitle object size", 1),
    checksum: String(row.checksum),
    mediaType: String(row.media_type),
  };
}

function mapManifest(row, parts) {
  return {
    profileId: String(row.profile_id),
    profileRevision: toSafeInteger(row.profile_revision, "subtitle profile revision", 1),
    deviceId: String(row.device_id),
    deviceGeneration: toSafeInteger(row.device_generation, "subtitle device generation", 1),
    artifactId: String(row.artifact_id),
    sessionId: String(row.session_id),
    playbackGeneration: String(row.playback_generation),
    contextRevision: decimal(row.context_revision, "subtitle context revision"),
    providerRevision: decimal(row.provider_revision, "subtitle provider revision"),
    expiresAt: toTimestamp(row.expires_at, "subtitle manifest expiry"),
    uploadSettlementDeadline: toTimestamp(
      row.upload_settlement_deadline,
      "subtitle upload settlement deadline"
    ),
    parts,
    state: String(row.state),
    deletionReason: row.deletion_reason === null ? null : String(row.deletion_reason),
    nextAttemptAt: toTimestamp(row.next_attempt_at, "subtitle next attempt"),
    attemptCount: toSafeInteger(row.attempt_count, "subtitle attempt count"),
    firstAbsentAt: row.first_absent_at === null
      ? null
      : toTimestamp(row.first_absent_at, "subtitle first absence"),
    leaseTokenHash: row.lease_token_hash === null ? null : String(row.lease_token_hash),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at === null
      ? null
      : toTimestamp(row.lease_expires_at, "subtitle lease expiry"),
    createdAt: toTimestamp(row.created_at, "subtitle manifest createdAt"),
    updatedAt: toTimestamp(row.updated_at, "subtitle manifest updatedAt"),
  };
}

function manifestConflict() {
  return codedError("subtitle_manifest_conflict", "subtitle manifest already differs");
}

class PostgresSubtitleManifestRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
  }

  async reserve(input) {
    const candidate = normalizeManifest(input);
    if (candidate.profileRevision < 1) throw new TypeError("profile revision is invalid");
    try {
      return await this._db.transaction(async (transaction) => {
        const now = readClock(this._clock);
        await this._assertBinding(transaction, candidate, now);
        const existing = await this._load(transaction, candidate.artifactId, true);
        if (existing) {
          if (!sameManifest(existing, candidate)) throw manifestConflict();
          return publicManifest(existing);
        }
        await transaction.query(
          `INSERT INTO subtitle_object_manifests (
             artifact_id, profile_id, profile_revision, device_id, device_generation,
             session_id, playback_generation, context_revision, provider_revision,
             expires_at, upload_settlement_deadline, state, deletion_reason,
             next_attempt_at, attempt_count, first_absent_at,
             lease_token_hash, lease_owner, lease_expires_at, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             'uploading', NULL, $11, 0, NULL, NULL, NULL, NULL, $12, $12
           )`,
          [
            candidate.artifactId,
            candidate.profileId,
            candidate.profileRevision,
            candidate.deviceId,
            candidate.deviceGeneration,
            candidate.sessionId,
            candidate.playbackGeneration,
            candidate.contextRevision,
            candidate.providerRevision,
            dateParameter(candidate.expiresAt, "subtitle manifest expiry"),
            dateParameter(
              candidate.uploadSettlementDeadline,
              "subtitle upload settlement deadline"
            ),
            dateParameter(now, "subtitle manifest createdAt"),
          ]
        );
        for (const part of candidate.parts) {
          await transaction.query(
            `INSERT INTO subtitle_object_manifest_parts (
               artifact_id, part_number, object_key, size_bytes, checksum, media_type
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              candidate.artifactId,
              part.partNumber,
              part.objectKey,
              part.sizeBytes,
              part.checksum,
              part.mediaType,
            ]
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
      if (error && error.code === "23505") throw manifestConflict();
      throw error;
    }
  }

  async commit(input) {
    const value = input && typeof input === "object" ? input : {};
    const profileId = assertIdentifier(value.profileId, "profile id");
    const artifactId = assertIdentifier(value.artifactId, "artifact id");
    return this._db.transaction(async (transaction) => {
      const observed = await this._load(transaction, artifactId, false, profileId);
      if (!observed) return null;
      if (observed.state === "active") return publicManifest(observed);
      if (observed.state !== "uploading") return null;
      try {
        await this._assertBinding(transaction, observed, readClock(this._clock));
      } catch (error) {
        if (!error || !["profile_inactive", "device_generation_changed"].includes(error.code)) {
          throw error;
        }
        await this.requestArtifactDeletionInTransaction(
          transaction,
          profileId,
          artifactId,
          "lifecycle_changed"
        );
        return null;
      }
      const record = await this._load(transaction, artifactId, true, profileId);
      if (!record) return null;
      if (record.state === "active") return publicManifest(record);
      if (record.state !== "uploading") return null;
      if (!sameManifest(record, observed)) throw manifestConflict();
      const now = readClock(this._clock);
      const result = await transaction.query(
        `UPDATE subtitle_object_manifests
            SET state = 'active', updated_at = $3
          WHERE artifact_id = $1 AND profile_id = $2 AND state = 'uploading'
          RETURNING *`,
        [artifactId, profileId, dateParameter(now, "subtitle manifest updatedAt")]
      );
      const row = firstRow(result);
      return row ? publicManifest(mapManifest(row, record.parts)) : null;
    });
  }

  async requestProfileDeletion(profileId, reason = "profile_revoked") {
    const id = assertIdentifier(profileId, "profile id");
    return this._db.transaction((transaction) =>
      this.requestProfileDeletionInTransaction(transaction, id, reason)
    );
  }

  async requestArtifactDeletion(profileId, artifactId, reason = "delivery_cleanup") {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(artifactId, "artifact id");
    return this._db.transaction((transaction) =>
      this.requestArtifactDeletionInTransaction(
        transaction,
        scopedProfileId,
        id,
        reason
      )
    );
  }

  async requestDeviceDeletion(profileId, deviceId, reason = "device_revoked") {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    return this._db.transaction((transaction) =>
      this.requestDeviceDeletionInTransaction(transaction, scopedProfileId, id, reason)
    );
  }

  async requestProfileDeletionInTransaction(transaction, profileId, reason, nowValue) {
    return this._requestDeletion(
      transaction,
      "profile_id = $1",
      [assertIdentifier(profileId, "profile id")],
      normalizeReason(reason, "profile_revoked"),
      nowValue
    );
  }

  async requestDeviceDeletionInTransaction(transaction, profileId, deviceId, reason, nowValue) {
    return this._requestDeletion(
      transaction,
      "profile_id = $1 AND device_id = $2",
      [
        assertIdentifier(profileId, "profile id"),
        assertIdentifier(deviceId, "device id"),
      ],
      normalizeReason(reason, "device_revoked"),
      nowValue
    );
  }

  async requestArtifactDeletionInTransaction(
    transaction,
    profileId,
    artifactId,
    reason,
    nowValue
  ) {
    return this._requestDeletion(
      transaction,
      "profile_id = $1 AND artifact_id = $2",
      [
        assertIdentifier(profileId, "profile id"),
        assertIdentifier(artifactId, "artifact id"),
      ],
      normalizeReason(reason, "lifecycle_changed"),
      nowValue
    );
  }

  async hasProfileInTransaction(transaction, profileId) {
    return Boolean(firstRow(await transaction.query(
      "SELECT 1 FROM subtitle_object_manifests WHERE profile_id = $1 LIMIT 1",
      [assertIdentifier(profileId, "profile id")]
    )));
  }

  async claimDeletion(options = {}) {
    const claim = normalizeDeletionClaim(options);
    const lease = this._tokens.issue("subtitle-manifest-deletion", 32);
    return this._db.transaction(async (transaction) => {
      const now = readClock(this._clock);
      await this._requestExpired(transaction, now);
      const selected = firstRow(await transaction.query(
        `SELECT * FROM subtitle_object_manifests
          WHERE state IN ('deletion_requested', 'first_absent')
            AND next_attempt_at <= $1
            AND upload_settlement_deadline <= $1
            AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
          ORDER BY next_attempt_at, created_at, artifact_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [dateParameter(now, "subtitle deletion claim timestamp")]
      ));
      if (!selected) return null;
      const leaseExpiresAt = addDuration(now, claim.leaseMs, "subtitle deletion lease");
      const updated = firstRow(await transaction.query(
        `UPDATE subtitle_object_manifests
            SET lease_token_hash = $2, lease_owner = $3, lease_expires_at = $4,
                updated_at = $1
          WHERE artifact_id = $5
          RETURNING *`,
        [
          dateParameter(now, "subtitle manifest updatedAt"),
          lease.tokenHash,
          claim.workerId,
          dateParameter(leaseExpiresAt, "subtitle deletion lease expiry"),
          selected.artifact_id,
        ]
      ));
      const parts = await this._loadParts(transaction, String(selected.artifact_id));
      return Object.freeze({
        artifactId: String(updated.artifact_id),
        profileId: String(updated.profile_id),
        deviceId: String(updated.device_id),
        phase: updated.state === "first_absent" ? "second" : "first",
        deletionToken: lease.token,
        parts: Object.freeze(parts.map((part) => Object.freeze({ ...part }))),
      });
    });
  }

  async recordDeletionAbsence(input) {
    const value = normalizeAbsence(input);
    if (!value.verifiedAbsent) return null;
    const tokenHash = this._tokenHash(value.deletionToken);
    if (!tokenHash) return null;
    return this._db.transaction(async (transaction) => {
      const now = readClock(this._clock);
      const retryAt = addDuration(now, value.secondPassDelayMs, "subtitle deletion second pass");
      const row = firstRow(await transaction.query(
        `UPDATE subtitle_object_manifests
            SET state = 'first_absent', first_absent_at = $2, next_attempt_at = $3,
                lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL,
                updated_at = $2
          WHERE artifact_id = $1 AND state = 'deletion_requested'
            AND lease_token_hash = $4 AND lease_expires_at > $2
          RETURNING next_attempt_at`,
        [
          value.artifactId,
          dateParameter(now, "subtitle deletion absence timestamp"),
          dateParameter(retryAt, "subtitle deletion second pass"),
          tokenHash,
        ]
      ));
      return row
        ? Object.freeze({ status: "awaiting_second_pass", retryAt: toTimestamp(row.next_attempt_at, "subtitle retryAt") })
        : null;
    });
  }

  async retryDeletion(input) {
    const value = normalizeRetry(input);
    const tokenHash = this._tokenHash(value.deletionToken);
    if (!tokenHash) return null;
    return this._db.transaction(async (transaction) => {
      const now = readClock(this._clock);
      const retryAt = addDuration(now, value.retryDelayMs, "subtitle deletion retry");
      const row = firstRow(await transaction.query(
        `UPDATE subtitle_object_manifests
            SET attempt_count = attempt_count + 1, next_attempt_at = $3,
                lease_token_hash = NULL, lease_owner = NULL, lease_expires_at = NULL,
                updated_at = $2
          WHERE artifact_id = $1
            AND state IN ('deletion_requested', 'first_absent')
            AND lease_token_hash = $4 AND lease_expires_at > $2
          RETURNING next_attempt_at`,
        [
          value.artifactId,
          dateParameter(now, "subtitle deletion retry timestamp"),
          dateParameter(retryAt, "subtitle deletion retry"),
          tokenHash,
        ]
      ));
      return row
        ? Object.freeze({ status: "retrying", retryAt: toTimestamp(row.next_attempt_at, "subtitle retryAt") })
        : null;
    });
  }

  async confirmDeletion(input) {
    const value = normalizeConfirmation(input);
    if (!value.verifiedAbsent) return null;
    const tokenHash = this._tokenHash(value.deletionToken);
    if (!tokenHash) return null;
    return this._db.transaction(async (transaction) => {
      const now = readClock(this._clock);
      const result = await transaction.query(
        `DELETE FROM subtitle_object_manifests
          WHERE artifact_id = $1 AND state = 'first_absent'
            AND lease_token_hash = $2 AND lease_expires_at > $3
          RETURNING artifact_id`,
        [
          value.artifactId,
          tokenHash,
          dateParameter(now, "subtitle deletion confirmation timestamp"),
        ]
      );
      return affectedRows(result) === 1 ? Object.freeze({ status: "confirmed" }) : null;
    });
  }

  async hasProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return Boolean(firstRow(await this._db.query(
      "SELECT 1 FROM subtitle_object_manifests WHERE profile_id = $1 LIMIT 1",
      [id]
    )));
  }

  async hasDevice(profileId, deviceId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    return Boolean(firstRow(await this._db.query(
      `SELECT 1 FROM subtitle_object_manifests
        WHERE profile_id = $1 AND device_id = $2 LIMIT 1`,
      [scopedProfileId, id]
    )));
  }

  async listProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const rows = resultRows(await this._db.query(
      `SELECT * FROM subtitle_object_manifests
        WHERE profile_id = $1 ORDER BY created_at, artifact_id`,
      [id]
    ));
    if (rows.length === 0) return [];
    const parts = resultRows(await this._db.query(
      `SELECT parts.* FROM subtitle_object_manifest_parts AS parts
        JOIN subtitle_object_manifests AS manifests
          ON manifests.artifact_id = parts.artifact_id
        WHERE manifests.profile_id = $1
        ORDER BY parts.artifact_id, parts.part_number`,
      [id]
    ));
    const grouped = new Map();
    for (const part of parts) {
      const artifactId = String(part.artifact_id);
      if (!grouped.has(artifactId)) grouped.set(artifactId, []);
      grouped.get(artifactId).push(mapPart(part));
    }
    return rows.map((row) => publicManifest(mapManifest(row, grouped.get(String(row.artifact_id)) || [])));
  }

  async _assertBinding(transaction, binding, now) {
    const profile = firstRow(await transaction.query(
      `SELECT revision, status, deletion_state FROM profiles
        WHERE id = $1 FOR SHARE`,
      [binding.profileId]
    ));
    if (!profile || profile.status !== "active" || profile.deletion_state !== "none" ||
        toSafeInteger(profile.revision, "profile revision", 1) !== binding.profileRevision) {
      throw codedError("profile_inactive", "profile changed before subtitle manifest write");
    }
    const device = firstRow(await transaction.query(
      `SELECT generation, revoked_at, expires_at FROM devices
        WHERE id = $1 AND profile_id = $2 FOR SHARE`,
      [binding.deviceId, binding.profileId]
    ));
    if (!device || device.revoked_at !== null ||
        toSafeInteger(device.generation, "device generation", 1) !== binding.deviceGeneration ||
        toTimestamp(device.expires_at, "device expiry") <= now) {
      throw codedError("device_generation_changed", "device changed before subtitle manifest write");
    }
  }

  async _load(transaction, artifactId, lock = false, profileId = null) {
    const values = [artifactId];
    let scope = "artifact_id = $1";
    if (profileId !== null) {
      values.push(profileId);
      scope += " AND profile_id = $2";
    }
    const row = firstRow(await transaction.query(
      `SELECT * FROM subtitle_object_manifests WHERE ${scope}${lock ? " FOR UPDATE" : ""}`,
      values
    ));
    if (!row) return null;
    return mapManifest(row, await this._loadParts(transaction, artifactId));
  }

  async _loadParts(transaction, artifactId) {
    return resultRows(await transaction.query(
      `SELECT * FROM subtitle_object_manifest_parts
        WHERE artifact_id = $1 ORDER BY part_number`,
      [artifactId]
    )).map(mapPart);
  }

  async _requestDeletion(transaction, scope, values, reason, nowValue) {
    const now = nowValue === undefined ? readClock(this._clock) : nowValue;
    const reasonIndex = values.length + 1;
    const nowIndex = values.length + 2;
    const result = await transaction.query(
      `UPDATE subtitle_object_manifests
          SET state = 'deletion_requested', deletion_reason = $${reasonIndex},
              next_attempt_at = GREATEST($${nowIndex}, upload_settlement_deadline),
              first_absent_at = NULL, lease_token_hash = NULL, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = $${nowIndex}
        WHERE ${scope} AND state IN ('uploading', 'active')`,
      [
        ...values,
        reason,
        dateParameter(now, "subtitle deletion request timestamp"),
      ]
    );
    return affectedRows(result);
  }

  async _requestExpired(transaction, now) {
    await transaction.query(
      `UPDATE subtitle_object_manifests
          SET state = 'deletion_requested',
              deletion_reason = CASE WHEN state = 'active' THEN 'expired' ELSE 'upload_unsettled' END,
              next_attempt_at = GREATEST($1, upload_settlement_deadline),
              first_absent_at = NULL, lease_token_hash = NULL, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = $1
        WHERE (state = 'active' AND expires_at <= $1)
           OR (state = 'uploading' AND upload_settlement_deadline <= $1)`,
      [dateParameter(now, "subtitle expiry timestamp")]
    );
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
  PostgreSQLSubtitleManifestRepository: PostgresSubtitleManifestRepository,
  PostgresSubtitleManifestRepository,
};
