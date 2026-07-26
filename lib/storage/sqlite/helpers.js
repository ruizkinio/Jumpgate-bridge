"use strict";

const { validateEnvelope } = require("../envelope-crypto");
const {
  assertBoundedString,
  assertIdentifier,
  assertPlainObject,
  codedError,
} = require("../repository-utils");
const { assertDatabaseHandle } = require("./connection");
const { assertJsonValue, stringifyJsonValue } = require("../json-domain");

const MAX_JSON_SNAPSHOT_BYTES = 64 * 1024;
const MAX_BACKUP_PLAINTEXT_BYTES = 4 * 1024 * 1024;

// AES-GCM keeps the plaintext length, then base64url expands it to ceil(4n/3).
// 170 bytes covers all fixed fields, a 64-byte key id, and jsonb::text spacing;
// SQLite's compact JSON representation is smaller but uses the same hard bounds.
const MAX_ENVELOPE_STORAGE_OVERHEAD_BYTES = 170;

function envelopeStorageLimit(maximumPlaintextBytes) {
  return Math.ceil((maximumPlaintextBytes * 4) / 3) + MAX_ENVELOPE_STORAGE_OVERHEAD_BYTES;
}

const MAX_JSON_SNAPSHOT_ENVELOPE_BYTES = envelopeStorageLimit(MAX_JSON_SNAPSHOT_BYTES);
const MAX_BACKUP_ENVELOPE_BYTES = envelopeStorageLimit(MAX_BACKUP_PLAINTEXT_BYTES);

function normalizeRepositoryOptions(databaseOrOptions, extraOptions = {}) {
  if (databaseOrOptions && typeof databaseOrOptions.prepare === "function") {
    return { ...extraOptions, database: databaseOrOptions };
  }
  if (databaseOrOptions === undefined) return { ...extraOptions };
  if (!databaseOrOptions || typeof databaseOrOptions !== "object" || Array.isArray(databaseOrOptions)) {
    throw new TypeError("repository options are invalid");
  }
  return { ...databaseOrOptions, ...extraOptions };
}

function requireDatabase(options) {
  return assertDatabaseHandle(options.database || options.db);
}

function prepareProfileStatus(database) {
  return database.prepare(
    "SELECT status, revision, history_generation, deletion_state FROM profiles WHERE id = ?"
  );
}

function requireActiveProfile(statement, profileId) {
  const row = statement.get(profileId);
  if (!row || row.status !== "active") {
    throw codedError("profile_inactive", "profile is missing or inactive");
  }
  return row;
}

function isActiveProfile(statement, profileId) {
  const row = statement.get(profileId);
  return Boolean(row && row.status === "active");
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
  } catch (_error) {
    throw new TypeError(name + " is invalid");
  }
  return canonical;
}

function stringifyJson(value, name, maximumBytes) {
  return stringifyJsonValue(value, name, maximumBytes);
}

function parseJson(value, name) {
  try {
    return assertJsonValue(JSON.parse(value), name);
  } catch (_error) {
    const error = new Error("stored " + name + " is invalid JSON");
    error.code = "storage_corrupt";
    throw error;
  }
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
    return assertJsonValue(descriptor, "provider descriptor", MAX_JSON_SNAPSHOT_BYTES);
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError("provider descriptor exceeds 64 KiB");
    throw error;
  }
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

function assertOptionalObject(value, name) {
  if (value === null) return null;
  const object = assertPlainObject(value, name);
  return assertJsonValue(object, name, MAX_JSON_SNAPSHOT_BYTES);
}

function assertRequiredObject(value, name) {
  const object = assertPlainObject(value, name);
  return assertJsonValue(object, name, MAX_JSON_SNAPSHOT_BYTES);
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
      if (typeof item !== "boolean") {
        throw new TypeError("playbackSnapshot." + key + " is invalid");
      }
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

module.exports = {
  MAX_BACKUP_ENVELOPE_BYTES,
  MAX_BACKUP_PLAINTEXT_BYTES,
  MAX_ENVELOPE_STORAGE_OVERHEAD_BYTES,
  MAX_JSON_SNAPSHOT_BYTES,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
  assertContentKey,
  assertDescriptorSize,
  assertJsonValue,
  assertOptionalEnvelope,
  assertOptionalHash,
  assertOptionalObject,
  assertProfilePatch,
  assertProvider,
  assertRequiredObject,
  assertSafePlaybackSnapshot,
  envelopeStorageLimit,
  normalizeRepositoryOptions,
  parseJson,
  prepareProfileStatus,
  requireDatabase,
  requireActiveProfile,
  isActiveProfile,
  stringifyJson,
};
