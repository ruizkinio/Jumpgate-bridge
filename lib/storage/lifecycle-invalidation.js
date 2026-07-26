"use strict";

const crypto = require("node:crypto");
const {
  assertIdentifier,
  assertPositiveInteger,
  cloneJson,
  parseTimestamp,
  readClock,
} = require("./repository-utils");

const INVALIDATION_ID_PATTERN = /^[a-f0-9]{64}$/;

function assertInvalidationId(value) {
  if (typeof value !== "string" || !INVALIDATION_ID_PATTERN.test(value)) {
    throw new TypeError("lifecycle invalidation id is invalid");
  }
  return value;
}

function assertInvalidationKind(value) {
  if (value !== "profile" && value !== "device") {
    throw new TypeError("lifecycle invalidation kind is invalid");
  }
  return value;
}

function lifecycleInvalidationId(kind, profileId, profileRevision, deviceId, deviceGeneration) {
  const scopedKind = assertInvalidationKind(kind);
  const scopedProfileId = assertIdentifier(profileId, "profile id");
  const scopedProfileRevision = assertPositiveInteger(
    profileRevision,
    "profile revision",
    Number.MAX_SAFE_INTEGER
  );
  const scopedDeviceId = scopedKind === "device"
    ? assertIdentifier(deviceId, "device id")
    : "";
  const scopedDeviceGeneration = scopedKind === "device"
    ? assertPositiveInteger(
        deviceGeneration,
        "device generation",
        Number.MAX_SAFE_INTEGER
      )
    : 0;
  return crypto
    .createHash("sha256")
    .update(
      [
        "jumpgate-lifecycle-invalidation-v1",
        scopedKind,
        scopedProfileId,
        String(scopedProfileRevision),
        scopedDeviceId,
        String(scopedDeviceGeneration),
      ].join("\0"),
      "utf8"
    )
    .digest("hex");
}

function createInvalidationRecord(input, now) {
  const kind = assertInvalidationKind(input.kind);
  const profileId = assertIdentifier(input.profileId, "profile id");
  const profileRevision = assertPositiveInteger(
    input.profileRevision,
    "profile revision",
    Number.MAX_SAFE_INTEGER
  );
  const deviceId = kind === "device"
    ? assertIdentifier(input.deviceId, "device id")
    : null;
  const deviceGeneration = kind === "device"
    ? assertPositiveInteger(
        input.deviceGeneration,
        "device generation",
        Number.MAX_SAFE_INTEGER
      )
    : null;
  const timestamp = parseTimestamp(now, "lifecycle invalidation timestamp");
  return {
    id: lifecycleInvalidationId(
      kind,
      profileId,
      profileRevision,
      deviceId,
      deviceGeneration
    ),
    kind,
    profileId,
    profileRevision,
    deviceId,
    deviceGeneration,
    attemptCount: 0,
    nextAttemptAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

class ProfileLifecycleCoordinator {
  constructor() {
    this._tails = new Map();
  }

  async run(profileId, operation) {
    const id = assertIdentifier(profileId, "profile id");
    if (typeof operation !== "function") {
      throw new TypeError("profile lifecycle operation is required");
    }
    const previous = this._tails.get(id) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this._tails.set(id, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this._tails.get(id) === tail) this._tails.delete(id);
    }
  }
}

class MemoryLifecycleInvalidationRepository {
  constructor(options = {}) {
    this._clock = options.clock || Date.now;
    this._records = new Map();
  }

  enqueueProfile(profileId, profileRevision) {
    return this._enqueue({ kind: "profile", profileId, profileRevision });
  }

  enqueueDevice(profileId, profileRevision, deviceId, deviceGeneration) {
    return this._enqueue({
      kind: "device",
      profileId,
      profileRevision,
      deviceId,
      deviceGeneration,
    });
  }

  async getPending(kind, profileId, deviceId = null) {
    const scopedKind = assertInvalidationKind(kind);
    const scopedProfileId = assertIdentifier(profileId, "profile id");
    const scopedDeviceId = scopedKind === "device"
      ? assertIdentifier(deviceId, "device id")
      : null;
    const matches = Array.from(this._records.values())
      .filter((record) =>
        record.kind === scopedKind &&
        record.profileId === scopedProfileId &&
        record.deviceId === scopedDeviceId
      )
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    return matches.length > 0 ? cloneJson(matches[0]) : null;
  }

  async listPending(limit = 32) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("pending invalidation limit is invalid");
    }
    const now = readClock(this._clock);
    return Array.from(this._records.values())
      .filter((record) => record.nextAttemptAt <= now)
      .sort((left, right) =>
        left.nextAttemptAt - right.nextAttemptAt ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id)
      )
      .slice(0, limit)
      .map((record) => cloneJson(record));
  }

  async complete(invalidationId) {
    return this._records.delete(assertInvalidationId(invalidationId));
  }

  async defer(invalidationId, expectedAttemptCount, nextAttemptAt) {
    const id = assertInvalidationId(invalidationId);
    if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 0) {
      throw new TypeError("lifecycle invalidation attempt count is invalid");
    }
    const retryAt = parseTimestamp(nextAttemptAt, "lifecycle invalidation retry timestamp");
    const record = this._records.get(id);
    if (!record || record.attemptCount !== expectedAttemptCount) return false;
    record.attemptCount += 1;
    record.nextAttemptAt = retryAt;
    record.updatedAt = readClock(this._clock);
    return true;
  }

  storageSnapshot() {
    return Array.from(this._records.values(), (record) => cloneJson(record));
  }

  _enqueue(input) {
    const record = createInvalidationRecord(input, readClock(this._clock));
    const existing = this._records.get(record.id);
    if (existing) return cloneJson(existing);
    this._records.set(record.id, record);
    return cloneJson(record);
  }
}

module.exports = {
  INVALIDATION_ID_PATTERN,
  MemoryLifecycleInvalidationRepository,
  ProfileLifecycleCoordinator,
  assertInvalidationId,
  assertInvalidationKind,
  createInvalidationRecord,
  lifecycleInvalidationId,
};
