"use strict";

const { validateEnvelope } = require("../envelope-crypto");
const {
  assertBoundedString,
  assertDisplayName,
  assertIdentifier,
  assertPlainObject,
  codedError,
  parseTimestamp,
} = require("../repository-utils");
const { PostgresDatabase } = require("./database");
const { assertJsonValue } = require("../json-domain");

const MAX_JSON_SNAPSHOT_BYTES = 64 * 1024;
// PostgreSQL jsonb normalizes numbers and adds separators when rendered as text.
// A 64x bound covers the worst finite JavaScript exponent expansion (< 55x).
const MAX_POSTGRES_JSONB_STORAGE_BYTES = 4 * 1024 * 1024;
const MAX_BACKUP_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

// AES-GCM keeps the plaintext length, then base64url expands it to ceil(4n/3).
// 170 bytes covers all fixed fields, a 64-byte key id, and jsonb::text spacing.
const MAX_ENVELOPE_STORAGE_OVERHEAD_BYTES = 170;

function envelopeStorageLimit(maximumPlaintextBytes) {
  return Math.ceil((maximumPlaintextBytes * 4) / 3) + MAX_ENVELOPE_STORAGE_OVERHEAD_BYTES;
}

const MAX_JSON_SNAPSHOT_ENVELOPE_BYTES = envelopeStorageLimit(MAX_JSON_SNAPSHOT_BYTES);
const MAX_BACKUP_ENVELOPE_BYTES = envelopeStorageLimit(MAX_BACKUP_PLAINTEXT_BYTES);

function requireDatabase(options = {}) {
  const candidate = options.database || options.db;
  if (candidate) {
    if (typeof candidate.query !== "function" || typeof candidate.transaction !== "function") {
      throw new TypeError("database must implement query() and transaction()");
    }
    return candidate;
  }
  if (options.pool) return new PostgresDatabase({ pool: options.pool });
  throw new TypeError("database is required");
}

function resultRows(result) {
  return result && Array.isArray(result.rows) ? result.rows : [];
}

function firstRow(result) {
  return resultRows(result)[0] || null;
}

function affectedRows(result) {
  if (result && Number.isSafeInteger(result.rowCount) && result.rowCount >= 0) {
    return result.rowCount;
  }
  return resultRows(result).length;
}

function toSafeInteger(value, name, minimum = 0) {
  let integer;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(name + " is outside the JavaScript safe integer range");
    integer = value;
  } else if (typeof value === "bigint") {
    if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) {
      throw new RangeError(name + " is outside the JavaScript safe integer range");
    }
    integer = Number(value);
  } else if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed > MAX_SAFE_BIGINT || parsed < -MAX_SAFE_BIGINT) {
      throw new RangeError(name + " is outside the JavaScript safe integer range");
    }
    integer = Number(parsed);
  } else {
    throw new TypeError(name + " is not an integer");
  }
  if (integer < minimum) throw new RangeError(name + " is below its minimum");
  return integer;
}

function toTimestamp(value, name) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return parseTimestamp(timestamp, name);
  }
  if (typeof value === "string") return parseTimestamp(Date.parse(value), name);
  return parseTimestamp(value, name);
}

function dateParameter(timestamp, name) {
  return new Date(parseTimestamp(timestamp, name));
}

function jsonValue(value, name, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (_err) {
      throw new TypeError(name + " is invalid JSON");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(name + " must be a JSON object");
  }
  return assertJsonValue(parsed, name);
}

function assertOptionalHash(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertOptionalEnvelope(value, name) {
  if (value === null) return null;
  const canonical = assertJsonValue(value, name);
  try {
    validateEnvelope(canonical);
  } catch (_err) {
    throw new TypeError(name + " is invalid");
  }
  return canonical;
}

function assertProfilePatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("profile patch is invalid");
  }
  for (const key of Object.keys(value)) {
    if (key !== "displayName" && key !== "settingsEnvelope") {
      throw new TypeError("profile patch contains an unknown field: " + key);
    }
  }
  return value;
}

function assertDescriptorSize(descriptor) {
  try {
    return assertJsonValue(descriptor, "provider descriptor", 64 * 1024);
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError("provider descriptor exceeds 64 KiB");
    throw error;
  }
}

function assertOptionalObject(value, name) {
  if (value === null) return null;
  const object = assertPlainObject(value, name);
  return assertJsonValue(object, name, MAX_JSON_SNAPSHOT_BYTES);
}

function assertRequiredObject(value, name) {
  const object = assertPlainObject(value, name);
  return assertJsonValue(object, name, MAX_JSON_SNAPSHOT_BYTES);
}

function assertEnvelopeStorageSize(value, name, maximumBytes) {
  assertJsonValue(value, name, maximumBytes);
  return value;
}

function assertProvider(value) {
  return assertBoundedString(value, "OAuth provider", 64, {
    pattern: /^[a-z][a-z0-9_-]{0,63}$/,
  });
}

function assertContentKey(value) {
  return assertBoundedString(value, "contentKey", 64, {
    pattern: /^[a-f0-9]{64}$/,
  });
}

function assertSafePlaybackSnapshot(value) {
  const snapshot = assertRequiredObject(value, "playbackSnapshot");
  const stringFields = new Set([
    "providerNamespace",
    "sourceFingerprint",
    "subtitleTrackId",
    "audioTrackId",
    "videoTrackId",
    "edition",
    "quality",
    "resolution",
    "codec",
    "container",
  ]);
  const arrayFields = new Set(["subtitleLanguages", "audioLanguages"]);
  const booleanFields = new Set(["subtitlesEnabled", "hearingImpaired", "forced"]);
  for (const [key, item] of Object.entries(snapshot)) {
    if (key === "providerId") {
      assertIdentifier(item, "playbackSnapshot.providerId");
    } else if (stringFields.has(key)) {
      const maximum = key === "sourceFingerprint" ? 512 : 256;
      assertBoundedString(item, "playbackSnapshot." + key, maximum);
      if (/(?:[a-z][a-z0-9+.-]*:\/\/|magnet:|^\/\/)/i.test(item)) {
        throw new TypeError("playbackSnapshot must not contain source URLs");
      }
    } else if (arrayFields.has(key)) {
      if (!Array.isArray(item) || item.length > 32) {
        throw new TypeError("playbackSnapshot." + key + " is invalid");
      }
      for (const language of item) {
        assertBoundedString(language, "playbackSnapshot language", 32, {
          pattern: /^[A-Za-z0-9_-]+$/,
        });
      }
    } else if (booleanFields.has(key)) {
      if (typeof item !== "boolean") throw new TypeError("playbackSnapshot." + key + " is invalid");
    } else if (key === "playbackSpeed") {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0.25 || item > 4) {
        throw new TypeError("playbackSnapshot.playbackSpeed is invalid");
      }
    } else if (/(?:url|token|secret|authorization|cookie|credential|headers?)/i.test(key)) {
      throw new TypeError("playbackSnapshot contains a sensitive field");
    } else {
      throw new TypeError("playbackSnapshot contains an unsupported field: " + key);
    }
  }
  return snapshot;
}

async function lockActiveProfile(transaction, profileId) {
  const result = await transaction.query(
    "SELECT id, status FROM profiles WHERE id = $1 FOR UPDATE",
    [profileId]
  );
  const row = firstRow(result);
  if (!row || row.status !== "active") {
    throw codedError("profile_inactive", "profile is missing or inactive");
  }
  return row;
}

async function lockActiveProfileHistoryGeneration(transaction, profileId) {
  const result = await transaction.query(
    "SELECT id, status, history_generation FROM profiles WHERE id = $1 FOR UPDATE",
    [profileId]
  );
  const row = firstRow(result);
  if (!row || row.status !== "active") {
    throw codedError("profile_inactive", "profile is missing or inactive");
  }
  return row;
}

function uniqueConstraint(error, ...names) {
  return Boolean(error && error.code === "23505" && names.includes(error.constraint));
}

function mapProfileRow(row) {
  return {
    schemaVersion: toSafeInteger(row.schema_version, "profile schemaVersion", 1),
    id: row.id,
    displayName: row.display_name,
    settingsEnvelope: jsonValue(row.settings_envelope, "profile settingsEnvelope", true),
    legacyConfigHash: row.legacy_config_hash === undefined ? null : row.legacy_config_hash,
    status: row.status,
    revision: toSafeInteger(row.revision, "profile revision", 1),
    createdAt: toTimestamp(row.created_at, "profile createdAt"),
    updatedAt: toTimestamp(row.updated_at, "profile updatedAt"),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined
      ? null
      : toTimestamp(row.revoked_at, "profile revokedAt"),
    historyGeneration: toSafeInteger(row.history_generation, "profile historyGeneration", 1),
    deletionState: row.deletion_state,
    deletionStartedAt: row.deletion_started_at === null || row.deletion_started_at === undefined
      ? null
      : toTimestamp(row.deletion_started_at, "profile deletionStartedAt"),
    durableErasedAt: row.durable_erased_at === null || row.durable_erased_at === undefined
      ? null
      : toTimestamp(row.durable_erased_at, "profile durableErasedAt"),
    erasureAttemptCount: toSafeInteger(
      row.erasure_attempt_count === undefined ? 0 : row.erasure_attempt_count,
      "profile erasureAttemptCount"
    ),
    erasureNextAttemptAt:
      row.erasure_next_attempt_at === null || row.erasure_next_attempt_at === undefined
        ? null
        : toTimestamp(row.erasure_next_attempt_at, "profile erasureNextAttemptAt"),
  };
}

function mapDeviceRow(row) {
  return {
    schemaVersion: toSafeInteger(row.schema_version, "device schemaVersion", 1),
    id: row.id,
    profileId: row.profile_id,
    pairingId: row.pairing_id === undefined ? null : row.pairing_id,
    generation: toSafeInteger(row.generation, "device generation", 1),
    displayName: row.display_name,
    createdAt: toTimestamp(row.created_at, "device createdAt"),
    lastSeenAt: toTimestamp(row.last_seen_at, "device lastSeenAt"),
    expiresAt: toTimestamp(row.expires_at, "device expiresAt"),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined
      ? null
      : toTimestamp(row.revoked_at, "device revokedAt"),
  };
}

function mapHistoryRow(row) {
  return {
    schemaVersion: toSafeInteger(row.schema_version, "history schemaVersion", 1),
    profileId: row.profile_id,
    contentKey: row.content_key,
    canonicalIdentity: jsonValue(row.canonical_identity, "history canonicalIdentity", true),
    displaySnapshot: jsonValue(row.display_snapshot, "history displaySnapshot"),
    playbackSnapshot: jsonValue(row.playback_snapshot, "history playbackSnapshot"),
    positionMs: toSafeInteger(row.position_ms, "history positionMs"),
    durationMs: toSafeInteger(row.duration_ms, "history durationMs"),
    watchedMs: toSafeInteger(row.watched_ms, "history watchedMs"),
    completed: row.completed,
    revision: toSafeInteger(row.revision, "history revision", 1),
    changeSequence: toSafeInteger(row.change_seq, "history changeSequence", 1),
    lastPlayedAt: toTimestamp(row.last_played_at, "history lastPlayedAt"),
    updatedAt: toTimestamp(row.updated_at, "history updatedAt"),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined
      ? null
      : toTimestamp(row.deleted_at, "history deletedAt"),
  };
}

function mapBackupMetadata(row) {
  return {
    schemaVersion: toSafeInteger(row.schema_version, "backup schemaVersion", 1),
    id: row.id,
    profileId: row.profile_id,
    reason: row.reason,
    createdAt: toTimestamp(row.created_at, "backup createdAt"),
    restoredAt: row.restored_at === null || row.restored_at === undefined
      ? null
      : toTimestamp(row.restored_at, "backup restoredAt"),
  };
}

module.exports = {
  MAX_BACKUP_ENVELOPE_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
  MAX_ENVELOPE_STORAGE_OVERHEAD_BYTES,
  MAX_JSON_SNAPSHOT_BYTES,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
  MAX_POSTGRES_JSONB_STORAGE_BYTES,
  affectedRows,
  assertContentKey,
  assertDescriptorSize,
  assertDisplayName,
  assertEnvelopeStorageSize,
  assertJsonValue,
  assertOptionalEnvelope,
  assertOptionalHash,
  assertOptionalObject,
  assertProfilePatch,
  assertProvider,
  assertRequiredObject,
  assertSafePlaybackSnapshot,
  dateParameter,
  envelopeStorageLimit,
  firstRow,
  jsonValue,
  lockActiveProfile,
  lockActiveProfileHistoryGeneration,
  mapBackupMetadata,
  mapDeviceRow,
  mapHistoryRow,
  mapProfileRow,
  requireDatabase,
  resultRows,
  toSafeInteger,
  toTimestamp,
  uniqueConstraint,
};
