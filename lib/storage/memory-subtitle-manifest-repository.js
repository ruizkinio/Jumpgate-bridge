"use strict";

const {
  addDuration,
  assertBoundedString,
  assertIdentifier,
  assertPlainObject,
  assertPositiveInteger,
  assertRevision,
  cloneJson,
  codedError,
  readClock,
} = require("./repository-utils");

const MAX_PARTS = 2;
const MAX_LEASE_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + " is invalid");
  return value;
}

function decimal(value, name) {
  const text = assertBoundedString(value, name, 128, { pattern: /^\d+$/ });
  if (text.length > 1 && text.startsWith("0")) throw new TypeError(name + " is invalid");
  return text;
}

function normalizeParts(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PARTS) {
    throw new TypeError("subtitle manifest parts are invalid");
  }
  const objectKeys = new Set();
  return value.map((raw, index) => {
    const part = assertPlainObject(raw, "subtitle manifest part");
    const partNumber = assertPositiveInteger(part.partNumber, "subtitle part number", MAX_PARTS);
    if (partNumber !== index + 1) throw new TypeError("subtitle manifest parts are not ordered");
    const objectKey = assertBoundedString(part.objectKey, "subtitle object key", 1024);
    if (objectKeys.has(objectKey)) throw new TypeError("subtitle object key is duplicated");
    objectKeys.add(objectKey);
    return Object.freeze({
      partNumber,
      objectKey,
      sizeBytes: assertPositiveInteger(part.sizeBytes, "subtitle object size", 64 * 1024 * 1024),
      checksum: assertBoundedString(part.checksum, "subtitle object checksum", 64, {
        pattern: /^[a-f0-9]{64}$/,
      }),
      mediaType: assertBoundedString(part.mediaType, "subtitle object media type", 128),
    });
  });
}

function normalizeManifest(input) {
  const value = assertPlainObject(input, "subtitle manifest");
  const expiresAt = timestamp(value.expiresAt, "subtitle manifest expiry");
  const uploadSettlementDeadline = timestamp(
    value.uploadSettlementDeadline,
    "subtitle upload settlement deadline"
  );
  return {
    profileId: assertIdentifier(value.profileId, "profile id"),
    profileRevision: assertRevision(value.profileRevision, false),
    deviceId: assertIdentifier(value.deviceId, "device id"),
    deviceGeneration: assertPositiveInteger(
      value.deviceGeneration,
      "device generation",
      Number.MAX_SAFE_INTEGER
    ),
    artifactId: assertIdentifier(value.artifactId, "artifact id"),
    sessionId: assertIdentifier(value.sessionId, "session id"),
    playbackGeneration: assertBoundedString(
      value.playbackGeneration,
      "playback generation",
      256
    ),
    contextRevision: decimal(value.contextRevision, "context revision"),
    providerRevision: decimal(value.providerRevision, "provider revision"),
    expiresAt,
    uploadSettlementDeadline,
    parts: normalizeParts(value.parts),
  };
}

class MemorySubtitleManifestRepository {
  constructor(options = {}) {
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._getProfileBinding = options.getProfileBinding;
    this._isDeviceBindingActive = options.isDeviceBindingActive;
    this._lifecycleCoordinator = options.lifecycleCoordinator;
    if (
      typeof this._getProfileBinding !== "function" ||
      typeof this._isDeviceBindingActive !== "function" ||
      !this._lifecycleCoordinator ||
      typeof this._lifecycleCoordinator.run !== "function"
    ) {
      throw new TypeError("subtitle manifest lifecycle dependencies are required");
    }
    this._jobs = new Map();
    this._objectKeys = new Map();
  }

  async reserve(input) {
    const candidate = normalizeManifest(input);
    return this._lifecycleCoordinator.run(candidate.profileId, async () => {
      const profile = await this._getProfileBinding(candidate.profileId);
      if (
        !profile ||
        profile.status !== "active" ||
        profile.revision !== candidate.profileRevision
      ) {
        throw codedError("profile_inactive", "profile changed before subtitle manifest reserve");
      }
      if (!this._isDeviceBindingActive(
        candidate.profileId,
        candidate.deviceId,
        candidate.deviceGeneration
      )) {
        throw codedError(
          "device_generation_changed",
          "device changed before subtitle manifest reserve"
        );
      }
      const existing = this._jobs.get(candidate.artifactId);
      if (existing) {
        const comparable = { ...existing };
        delete comparable.state;
        delete comparable.createdAt;
        delete comparable.updatedAt;
        delete comparable.deletionReason;
        delete comparable.nextAttemptAt;
        delete comparable.attemptCount;
        delete comparable.firstAbsentAt;
        delete comparable.leaseTokenHash;
        delete comparable.leaseExpiresAt;
        delete comparable.leaseOwner;
        if (JSON.stringify(comparable) !== JSON.stringify(candidate)) {
          throw codedError("subtitle_manifest_conflict", "subtitle manifest already differs");
        }
        return this._public(existing);
      }
      for (const part of candidate.parts) {
        if (this._objectKeys.has(part.objectKey)) {
          throw codedError("subtitle_manifest_conflict", "subtitle object key is already reserved");
        }
      }
      const now = readClock(this._clock);
      const record = {
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
      };
      this._jobs.set(record.artifactId, record);
      for (const part of record.parts) this._objectKeys.set(part.objectKey, record.artifactId);
      return this._public(record);
    });
  }

  async commit(input) {
    const value = assertPlainObject(input, "subtitle manifest commit");
    const profileId = assertIdentifier(value.profileId, "profile id");
    const artifactId = assertIdentifier(value.artifactId, "artifact id");
    return this._lifecycleCoordinator.run(profileId, async () => {
      const record = this._jobs.get(artifactId);
      if (!record || record.profileId !== profileId) return null;
      if (record.state === "active") return this._public(record);
      if (record.state !== "uploading") return null;
      const profile = await this._getProfileBinding(record.profileId);
      if (
        !profile ||
        profile.status !== "active" ||
        profile.revision !== record.profileRevision ||
        !this._isDeviceBindingActive(
          record.profileId,
          record.deviceId,
          record.deviceGeneration
        )
      ) {
        this._requestDeletion(record, "lifecycle_changed");
        return null;
      }
      record.state = "active";
      record.updatedAt = readClock(this._clock);
      return this._public(record);
    });
  }

  requestProfileDeletionNow(profileId, reason = "profile_revoked") {
    const id = assertIdentifier(profileId, "profile id");
    let changed = 0;
    for (const record of this._jobs.values()) {
      if (record.profileId !== id) continue;
      if (this._requestDeletion(record, reason)) changed += 1;
    }
    return changed;
  }

  async requestProfileDeletion(profileId, reason = "profile_revoked") {
    const id = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(id, async () =>
      this.requestProfileDeletionNow(id, reason)
    );
  }

  async requestArtifactDeletion(profileId, artifactId, reason = "delivery_cleanup") {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(artifactId, "artifact id");
    return this._lifecycleCoordinator.run(scopedProfileId, async () => {
      const record = this._jobs.get(id);
      if (!record || record.profileId !== scopedProfileId) return false;
      return this._requestDeletion(record, reason);
    });
  }

  requestDeviceDeletionNow(profileId, deviceId, reason = "device_revoked") {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    let changed = 0;
    for (const record of this._jobs.values()) {
      if (record.profileId !== scopedProfileId || record.deviceId !== id) continue;
      if (this._requestDeletion(record, reason)) changed += 1;
    }
    return changed;
  }

  async requestDeviceDeletion(profileId, deviceId, reason = "device_revoked") {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    return this._lifecycleCoordinator.run(scopedProfileId, async () =>
      this.requestDeviceDeletionNow(scopedProfileId, deviceId, reason)
    );
  }

  async claimDeletion(options = {}) {
    const supplied = assertPlainObject(options, "subtitle manifest deletion claim");
    const workerId = assertBoundedString(supplied.workerId, "subtitle deletion worker id", 256);
    const leaseMs = assertPositiveInteger(supplied.leaseMs, "subtitle deletion lease", MAX_LEASE_MS);
    const now = readClock(this._clock);
    this._requestExpired(now);
    const eligible = Array.from(this._jobs.values())
      .filter((record) =>
        (record.state === "deletion_requested" || record.state === "first_absent") &&
        record.nextAttemptAt <= now &&
        record.uploadSettlementDeadline <= now &&
        (record.leaseExpiresAt === null || record.leaseExpiresAt <= now)
      )
      .sort((left, right) =>
        left.nextAttemptAt - right.nextAttemptAt ||
        left.createdAt - right.createdAt ||
        left.artifactId.localeCompare(right.artifactId)
      )[0];
    if (!eligible) return null;
    return this._lifecycleCoordinator.run(eligible.profileId, async () => {
      const record = this._jobs.get(eligible.artifactId);
      const current = readClock(this._clock);
      if (
        !record ||
        record.nextAttemptAt > current ||
        record.uploadSettlementDeadline > current ||
        (record.leaseExpiresAt !== null && record.leaseExpiresAt > current)
      ) {
        return null;
      }
      const token = this._tokens.issue("subtitle-manifest-deletion", 32);
      record.leaseTokenHash = token.tokenHash;
      record.leaseOwner = workerId;
      record.leaseExpiresAt = addDuration(current, leaseMs, "subtitle deletion lease");
      record.updatedAt = current;
      return Object.freeze({
        artifactId: record.artifactId,
        profileId: record.profileId,
        deviceId: record.deviceId,
        phase: record.state === "first_absent" ? "second" : "first",
        deletionToken: token.token,
        parts: Object.freeze(record.parts.map((part) => Object.freeze({ ...part }))),
      });
    });
  }

  async recordDeletionAbsence(input) {
    const value = assertPlainObject(input, "subtitle deletion absence");
    const delay = assertPositiveInteger(
      value.secondPassDelayMs,
      "subtitle deletion second pass delay",
      MAX_DELAY_MS
    );
    if (value.verifiedAbsent === false) return null;
    const record = this._authorizedLease(value.artifactId, value.deletionToken);
    if (!record || record.state !== "deletion_requested") return null;
    const now = readClock(this._clock);
    record.state = "first_absent";
    record.firstAbsentAt = now;
    record.nextAttemptAt = addDuration(now, delay, "subtitle deletion second pass");
    this._clearLease(record);
    record.updatedAt = now;
    return Object.freeze({ status: "awaiting_second_pass", retryAt: record.nextAttemptAt });
  }

  async retryDeletion(input) {
    const value = assertPlainObject(input, "subtitle deletion retry");
    const delay = assertPositiveInteger(value.retryDelayMs, "subtitle deletion retry", MAX_DELAY_MS);
    const record = this._authorizedLease(value.artifactId, value.deletionToken);
    if (!record) return null;
    const now = readClock(this._clock);
    record.attemptCount += 1;
    record.nextAttemptAt = addDuration(now, delay, "subtitle deletion retry");
    this._clearLease(record);
    record.updatedAt = now;
    return Object.freeze({ status: "retrying", retryAt: record.nextAttemptAt });
  }

  async confirmDeletion(input) {
    const value = assertPlainObject(input, "subtitle deletion confirmation");
    if (value.verifiedAbsent !== true) return null;
    const record = this._authorizedLease(value.artifactId, value.deletionToken);
    if (!record || record.state !== "first_absent") return null;
    this._jobs.delete(record.artifactId);
    for (const part of record.parts) this._objectKeys.delete(part.objectKey);
    return Object.freeze({ status: "confirmed" });
  }

  hasProfileNow(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return Array.from(this._jobs.values()).some((record) => record.profileId === id);
  }

  async hasProfile(profileId) {
    return this.hasProfileNow(profileId);
  }

  async hasDevice(profileId, deviceId) {
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const id = assertIdentifier(deviceId, "device id");
    return Array.from(this._jobs.values()).some(
      (record) => record.profileId === scopedProfileId && record.deviceId === id
    );
  }

  async listProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return Array.from(this._jobs.values())
      .filter((record) => record.profileId === id)
      .sort((left, right) => left.createdAt - right.createdAt || left.artifactId.localeCompare(right.artifactId))
      .map((record) => this._public(record));
  }

  storageSnapshot() {
    return Array.from(this._jobs.values(), (record) => this._public(record));
  }

  _requestDeletion(record, reason) {
    if (record.state === "deletion_requested" || record.state === "first_absent") return false;
    record.state = "deletion_requested";
    record.deletionReason = assertBoundedString(reason, "subtitle deletion reason", 64);
    const now = readClock(this._clock);
    record.nextAttemptAt = Math.max(now, record.uploadSettlementDeadline);
    this._clearLease(record);
    record.updatedAt = now;
    return true;
  }

  _requestExpired(now) {
    for (const record of this._jobs.values()) {
      if (
        (record.state === "active" && record.expiresAt <= now) ||
        (record.state === "uploading" && record.uploadSettlementDeadline <= now)
      ) {
        this._requestDeletion(record, record.state === "active" ? "expired" : "upload_unsettled");
      }
    }
  }

  _authorizedLease(artifactId, deletionToken) {
    const id = assertIdentifier(artifactId, "artifact id");
    const record = this._jobs.get(id);
    if (!record || !record.leaseTokenHash) return null;
    if (record.leaseExpiresAt === null || record.leaseExpiresAt <= readClock(this._clock)) {
      this._clearLease(record);
      return null;
    }
    try {
      return this._tokens.matchesToken(
        "subtitle-manifest-deletion",
        deletionToken,
        record.leaseTokenHash
      ) ? record : null;
    } catch (_error) {
      return null;
    }
  }

  _clearLease(record) {
    record.leaseTokenHash = null;
    record.leaseOwner = null;
    record.leaseExpiresAt = null;
  }

  _public(record) {
    const copy = cloneJson(record);
    delete copy.leaseTokenHash;
    return Object.freeze(copy);
  }
}

module.exports = {
  MemorySubtitleManifestRepository,
};
