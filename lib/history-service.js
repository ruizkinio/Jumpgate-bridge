"use strict";

const { isSafePublicArtworkUrl } = require("./public-artwork");
const { assertJsonValue } = require("./storage/json-domain");
const { MAX_DATE_MS, assertIdentifier } = require("./storage/repository-utils");

const CONTENT_KEY_PATTERN = /^[a-f0-9]{64}$/;
const HISTORY_INPUT_KEYS = new Set([
  "canonicalIdentity",
  "completed",
  "displaySnapshot",
  "durationMs",
  "playbackSnapshot",
  "positionMs",
  "watchedMs",
]);
const CANONICAL_IDENTITY_KEYS = new Set([
  "provider",
  "id",
  "mediaType",
  "season",
  "episode",
  "confidence",
  "provenance",
]);
const DISPLAY_SNAPSHOT_KEYS = new Set([
  "title",
  "year",
  "season",
  "episode",
  "poster",
  "background",
  "logo",
]);
const PLAYBACK_SNAPSHOT_KEYS = new Set([
  "providerId",
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
  "subtitleLanguages",
  "audioLanguages",
  "subtitlesEnabled",
  "hearingImpaired",
  "forced",
  "playbackSpeed",
]);
const CANONICAL_PROVIDERS = new Set(["imdb", "tmdb", "tvdb", "trakt"]);
const HISTORY_INPUT_MAX_BYTES = 12 * 1024;
const MAX_DISPLAY_STRING_LENGTH = 256;
const MAX_DISPLAY_URL_LENGTH = 2048;
const MAX_PLAYBACK_STRING_LENGTH = 256;
const MAX_PLAYBACK_FINGERPRINT_LENGTH = 512;
const MAX_TRACK_LANGUAGES = 32;
const MAX_EPISODE_NUMBER = 2147483647;
const MAX_RETRY_DELAY_MS = 5000;

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validationError(message, code = "invalid_history_request") {
  const error = new TypeError(message);
  error.code = code;
  error.status = 400;
  return error;
}

function historyConflict() {
  const error = new Error("history changed too many times");
  error.code = "history_conflict";
  error.status = 409;
  return error;
}

function historyIdentityConflict() {
  const error = new Error("contentKey is already bound to a different canonical identity");
  error.code = "history_identity_conflict";
  error.status = 409;
  return error;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(name + " must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError(name + " must be a plain object");
  }
  return value;
}

function assertOnlyKeys(value, keys, name) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw validationError(name + " contains an unknown field");
  }
}

function assertRequiredKeys(value, keys, name) {
  for (const key of keys) {
    if (!hasOwn(value, key)) throw validationError(name + " is missing " + key);
  }
}

function assertBoundedString(value, name, maximumLength, options = {}) {
  const allowEmpty = options.allowEmpty === true;
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength ||
    Buffer.byteLength(value, "utf8") > maximumLength * 4 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw validationError(name + " is invalid");
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw validationError(name + " is invalid");
  }
  return value;
}

function assertNonNegativeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw validationError(name + " is invalid");
  }
  return value;
}

function assertContentKey(value) {
  if (typeof value !== "string" || !CONTENT_KEY_PATTERN.test(value)) {
    throw validationError("contentKey is invalid", "invalid_content_key");
  }
  return value;
}

function normalizeCanonicalIdentity(value) {
  if (value === null) return null;
  const identity = assertPlainObject(value, "canonicalIdentity");
  assertOnlyKeys(identity, CANONICAL_IDENTITY_KEYS, "canonicalIdentity");
  assertRequiredKeys(
    identity,
    ["provider", "id", "mediaType", "confidence", "provenance"],
    "canonicalIdentity"
  );

  const provider = assertBoundedString(identity.provider, "canonicalIdentity.provider", 16, {
    pattern: /^[a-z]+$/,
  });
  if (!CANONICAL_PROVIDERS.has(provider)) {
    throw validationError("canonicalIdentity.provider is not supported");
  }
  const id = assertBoundedString(identity.id, "canonicalIdentity.id", 256);
  if (provider === "imdb" && !/^tt\d{7,}$/.test(id)) {
    throw validationError("canonicalIdentity.id is not an exact IMDb id");
  }
  if (identity.confidence !== "canonical") {
    throw validationError("canonicalIdentity.confidence is invalid");
  }
  if (
    identity.provenance !== "metadata-request" &&
    identity.provenance !== "verified-external-id"
  ) {
    throw validationError("canonicalIdentity.provenance is invalid");
  }
  if (provider !== "imdb" && identity.provenance !== "verified-external-id") {
    throw validationError("non-IMDb canonical identities require verified provenance");
  }

  const normalized = {
    provider,
    id,
    mediaType: identity.mediaType,
    provenance: identity.provenance,
    confidence: "canonical",
  };
  if (identity.mediaType === "movie") {
    if (
      (hasOwn(identity, "season") && identity.season !== null) ||
      (hasOwn(identity, "episode") && identity.episode !== null)
    ) {
      throw validationError("movie canonicalIdentity cannot contain episode coordinates");
    }
    return normalized;
  }
  if (identity.mediaType !== "episode") {
    throw validationError("canonicalIdentity.mediaType is invalid");
  }
  assertRequiredKeys(identity, ["season", "episode"], "canonicalIdentity");
  normalized.season = assertNonNegativeInteger(
    identity.season,
    "canonicalIdentity.season",
    MAX_EPISODE_NUMBER
  );
  normalized.episode = assertNonNegativeInteger(
    identity.episode,
    "canonicalIdentity.episode",
    MAX_EPISODE_NUMBER
  );
  return normalized;
}

function assertSafeDisplayUrl(value, name) {
  const input = assertBoundedString(value, name, MAX_DISPLAY_URL_LENGTH);
  if (input.trim() !== input || /[\u0000-\u001f\u007f\s\\]/.test(input)) {
    throw validationError(name + " is invalid");
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch (_error) {
    throw validationError(name + " is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    input.includes("?") ||
    input.includes("#")
  ) {
    throw validationError(name + " is invalid");
  }
  return input;
}

function normalizeDisplaySnapshot(value, canonicalIdentity) {
  const input = assertPlainObject(value, "displaySnapshot");
  assertOnlyKeys(input, DISPLAY_SNAPSHOT_KEYS, "displaySnapshot");
  const snapshot = {};
  if (hasOwn(input, "title") && input.title !== null) {
    snapshot.title = assertBoundedString(
      input.title,
      "displaySnapshot.title",
      MAX_DISPLAY_STRING_LENGTH,
      { allowEmpty: true }
    );
  }
  if (hasOwn(input, "year") && input.year !== null) {
    snapshot.year = assertNonNegativeInteger(input.year, "displaySnapshot.year", 9999);
  }
  for (const field of ["season", "episode"]) {
    if (hasOwn(input, field) && input[field] !== null) {
      snapshot[field] = assertNonNegativeInteger(
        input[field],
        "displaySnapshot." + field,
        MAX_EPISODE_NUMBER
      );
    }
  }
  for (const field of ["poster", "background", "logo"]) {
    if (hasOwn(input, field) && input[field] !== null) {
      snapshot[field] = assertSafeDisplayUrl(input[field], "displaySnapshot." + field);
    }
  }

  if (canonicalIdentity && canonicalIdentity.mediaType === "movie") {
    if (hasOwn(snapshot, "season") || hasOwn(snapshot, "episode")) {
      throw validationError("movie displaySnapshot cannot contain episode coordinates");
    }
  } else if (canonicalIdentity && canonicalIdentity.mediaType === "episode") {
    if (
      (hasOwn(snapshot, "season") && snapshot.season !== canonicalIdentity.season) ||
      (hasOwn(snapshot, "episode") && snapshot.episode !== canonicalIdentity.episode)
    ) {
      throw validationError("displaySnapshot episode coordinates do not match canonicalIdentity");
    }
  }
  return snapshot;
}

function normalizePlaybackSnapshot(value) {
  const input = assertPlainObject(value, "playbackSnapshot");
  assertOnlyKeys(input, PLAYBACK_SNAPSHOT_KEYS, "playbackSnapshot");
  const snapshot = {};
  const stringFields = [
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
  ];
  const arrayFields = ["subtitleLanguages", "audioLanguages"];
  const booleanFields = ["subtitlesEnabled", "hearingImpaired", "forced"];

  if (hasOwn(input, "providerId")) {
    try {
      snapshot.providerId = assertIdentifier(input.providerId, "playbackSnapshot.providerId");
    } catch (_error) {
      throw validationError("playbackSnapshot.providerId is invalid");
    }
  }
  for (const field of stringFields) {
    if (!hasOwn(input, field)) continue;
    const maximum = field === "sourceFingerprint"
      ? MAX_PLAYBACK_FINGERPRINT_LENGTH
      : MAX_PLAYBACK_STRING_LENGTH;
    snapshot[field] = assertBoundedString(input[field], "playbackSnapshot." + field, maximum);
    if (/(?:[a-z][a-z0-9+.-]*:\/\/|magnet:|^\/\/)/i.test(snapshot[field])) {
      throw validationError("playbackSnapshot must not contain source URLs");
    }
  }
  for (const field of arrayFields) {
    if (!hasOwn(input, field)) continue;
    if (!Array.isArray(input[field]) || input[field].length > MAX_TRACK_LANGUAGES) {
      throw validationError("playbackSnapshot." + field + " is invalid");
    }
    snapshot[field] = input[field].map((language) =>
      assertBoundedString(language, "playbackSnapshot language", 32, {
        pattern: /^[A-Za-z0-9_-]+$/,
      })
    );
  }
  for (const field of booleanFields) {
    if (!hasOwn(input, field)) continue;
    if (typeof input[field] !== "boolean") {
      throw validationError("playbackSnapshot." + field + " is invalid");
    }
    snapshot[field] = input[field];
  }
  if (hasOwn(input, "playbackSpeed")) {
    if (
      typeof input.playbackSpeed !== "number" ||
      !Number.isFinite(input.playbackSpeed) ||
      input.playbackSpeed < 0.25 ||
      input.playbackSpeed > 4
    ) {
      throw validationError("playbackSnapshot.playbackSpeed is invalid");
    }
    snapshot.playbackSpeed = input.playbackSpeed;
  }
  return snapshot;
}

function normalizeHistoryInput(value) {
  let input;
  try {
    input = assertJsonValue(value, "history request", HISTORY_INPUT_MAX_BYTES);
  } catch (error) {
    throw validationError(error instanceof RangeError ? "history request is too large" : "history request is invalid");
  }
  assertPlainObject(input, "history request");
  assertOnlyKeys(input, HISTORY_INPUT_KEYS, "history request");
  assertRequiredKeys(input, HISTORY_INPUT_KEYS, "history request");

  const canonicalIdentity = normalizeCanonicalIdentity(input.canonicalIdentity);
  if (typeof input.completed !== "boolean") {
    throw validationError("completed is invalid");
  }
  const positionMs = assertNonNegativeInteger(input.positionMs, "positionMs");
  const durationMs = assertNonNegativeInteger(input.durationMs, "durationMs");
  const watchedMs = assertNonNegativeInteger(input.watchedMs, "watchedMs");
  if (
    (durationMs === 0 && (positionMs !== 0 || watchedMs !== 0)) ||
    (durationMs > 0 && (positionMs > durationMs || watchedMs > durationMs))
  ) {
    throw validationError("playback progress must be bounded by durationMs");
  }
  return {
    canonicalIdentity,
    displaySnapshot: normalizeDisplaySnapshot(input.displaySnapshot, canonicalIdentity),
    playbackSnapshot: normalizePlaybackSnapshot(input.playbackSnapshot),
    positionMs,
    durationMs,
    watchedMs,
    completed: input.completed,
  };
}

function assertDeviceBinding(value) {
  const binding = assertPlainObject(value, "device binding");
  try {
    const result = {
      profileId: assertIdentifier(binding.profileId, "profile id"),
      deviceId: assertIdentifier(binding.deviceId, "device id"),
    };
    if (binding.historyGeneration !== undefined) {
      if (!Number.isSafeInteger(binding.historyGeneration) || binding.historyGeneration < 1) {
        throw new TypeError("history generation is invalid");
      }
      result.historyGeneration = binding.historyGeneration;
    }
    if (binding.deviceGeneration !== undefined) {
      if (!Number.isSafeInteger(binding.deviceGeneration) || binding.deviceGeneration < 1) {
        throw new TypeError("device generation is invalid");
      }
      result.deviceGeneration = binding.deviceGeneration;
    }
    return result;
  } catch (_error) {
    throw validationError("device binding is invalid");
  }
}

function readClock(clock) {
  const value = Number(clock());
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MS) {
    throw new TypeError("history clock is invalid");
  }
  return value;
}

function nextLastPlayedAt(clock, current) {
  const now = readClock(clock);
  if (!current) return now;
  if (
    !Number.isSafeInteger(current.lastPlayedAt) ||
    current.lastPlayedAt < 0 ||
    current.lastPlayedAt > MAX_DATE_MS
  ) {
    throw new TypeError("stored history timestamp is invalid");
  }
  if (current.lastPlayedAt >= MAX_DATE_MS) return MAX_DATE_MS;
  return Math.max(now, current.lastPlayedAt + 1);
}

function canonicalTuple(identity) {
  if (!identity) return "";
  return JSON.stringify([
    identity.provider,
    identity.id,
    identity.mediaType,
    identity.mediaType === "episode" ? identity.season : null,
    identity.mediaType === "episode" ? identity.episode : null,
    identity.provenance,
    identity.confidence,
  ]);
}

function projectCanonicalIdentityDto(value) {
  const projected = projectCanonicalIdentity(value);
  if (!projected) return null;
  const provenance =
    value &&
    (value.provenance === "metadata-request" || value.provenance === "verified-external-id")
      ? value.provenance
      : projected.provider === "imdb"
        ? "metadata-request"
        : "verified-external-id";
  return {
    ...projected,
    provenance,
    confidence: "canonical",
  };
}

function projectDisplaySnapshot(value, canonicalIdentity) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const projected = {};
  for (const field of DISPLAY_SNAPSHOT_KEYS) {
    if (!hasOwn(value, field) || value[field] === null) continue;
    if (
      (field === "poster" || field === "background" || field === "logo") &&
      !isSafePublicArtworkUrl(value[field])
    ) {
      continue;
    }
    try {
      const candidate = normalizeDisplaySnapshot({ [field]: value[field] }, canonicalIdentity);
      if (hasOwn(candidate, field)) projected[field] = candidate[field];
    } catch (_error) {
      // Older durable records may contain fields outside the public DTO contract.
    }
  }
  return projected;
}

function projectPlaybackSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const projected = {};
  for (const field of PLAYBACK_SNAPSHOT_KEYS) {
    if (!hasOwn(value, field)) continue;
    try {
      const candidate = normalizePlaybackSnapshot({ [field]: value[field] });
      if (hasOwn(candidate, field)) projected[field] = candidate[field];
    } catch (_error) {
      // Ignore legacy/private fields rather than reflecting them through the API.
    }
  }
  return projected;
}

function bindCanonicalIdentity(input, current) {
  if (!current) return input;
  const currentIdentity = projectCanonicalIdentityDto(current.canonicalIdentity);
  if (!currentIdentity) return input;
  const inputIdentity = input.canonicalIdentity;
  if (inputIdentity && canonicalTuple(currentIdentity) !== canonicalTuple(inputIdentity)) {
    throw historyIdentityConflict();
  }
  if (inputIdentity) return input;
  return {
    ...input,
    canonicalIdentity: projectCanonicalIdentityDto(current.canonicalIdentity),
  };
}

function mergeAfterConflict(input, current) {
  if (!current) return input;
  const currentIdentity = projectCanonicalIdentityDto(current.canonicalIdentity);
  const inputIdentity = input.canonicalIdentity;
  if (
    currentIdentity &&
    inputIdentity &&
    canonicalTuple(currentIdentity) !== canonicalTuple(inputIdentity)
  ) {
    throw historyIdentityConflict();
  }
  const canonicalIdentity =
    input.canonicalIdentity === null
      ? currentIdentity
      : input.canonicalIdentity;
  const currentProgressIsValid =
    Number.isSafeInteger(current.positionMs) &&
    current.positionMs >= 0 &&
    Number.isSafeInteger(current.durationMs) &&
    current.durationMs >= 0 &&
    Number.isSafeInteger(current.watchedMs) &&
    current.watchedMs >= 0 &&
    ((current.durationMs === 0 && current.positionMs === 0 && current.watchedMs === 0) ||
      (current.durationMs > 0 &&
        current.positionMs <= current.durationMs &&
        current.watchedMs <= current.durationMs));
  // A completion can only be cleared by a later event carrying actual watched
  // progress. Empty startup/stop snapshots preserve the completed history row.
  const startsRewatch =
    current.completed === true &&
    input.completed === false &&
    input.durationMs > 0 &&
    (input.positionMs > 0 || input.watchedMs > 0);
  const preservesCompletion =
    current.completed === true && input.completed === false && !startsRewatch;
  return {
    ...input,
    canonicalIdentity,
    displaySnapshot: {
      ...projectDisplaySnapshot(current.displaySnapshot, canonicalIdentity),
      ...input.displaySnapshot,
    },
    playbackSnapshot: {
      ...projectPlaybackSnapshot(current.playbackSnapshot),
      ...input.playbackSnapshot,
    },
    positionMs:
      currentProgressIsValid && !startsRewatch
        ? Math.max(input.positionMs, current.positionMs)
        : input.positionMs,
    durationMs:
      currentProgressIsValid && !startsRewatch
        ? Math.max(input.durationMs, current.durationMs)
        : input.durationMs,
    watchedMs:
      currentProgressIsValid && !startsRewatch
        ? Math.max(input.watchedMs, current.watchedMs)
        : input.watchedMs,
    completed: preservesCompletion ? true : input.completed,
  };
}

function applyDirectEventSemantics(input, current) {
  if (
    !current ||
    current.completed !== true ||
    input.completed !== false ||
    (input.durationMs > 0 && (input.positionMs > 0 || input.watchedMs > 0))
  ) {
    return input;
  }
  const preserved = mergeAfterConflict(input, current);
  return {
    ...input,
    positionMs: preserved.positionMs,
    durationMs: preserved.durationMs,
    watchedMs: preserved.watchedMs,
    completed: true,
  };
}

function toHistoryDto(record) {
  if (!record) return null;
  const canonicalIdentity = projectCanonicalIdentityDto(record.canonicalIdentity);
  return {
    contentKey: assertContentKey(record.contentKey),
    canonicalIdentity,
    displaySnapshot: projectDisplaySnapshot(record.displaySnapshot, canonicalIdentity),
    playbackSnapshot: projectPlaybackSnapshot(record.playbackSnapshot),
    positionMs: record.positionMs,
    durationMs: record.durationMs,
    watchedMs: record.watchedMs,
    completed: record.completed,
    lastPlayedAt: record.lastPlayedAt,
  };
}

function isRetryableConflict(error) {
  return Boolean(error && (error.code === "revision_conflict" || error.code === "stale_history"));
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultBackoff(attempt) {
  return Math.min(10 * 2 ** attempt, 250);
}

function defaultJitter(maximum) {
  return maximum > 0 ? Math.floor(Math.random() * (maximum + 1)) : 0;
}

function readDelay(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RETRY_DELAY_MS) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

class HistoryService {
  constructor(options = {}) {
    if (
      !options.repository ||
      typeof options.repository.get !== "function" ||
      typeof options.repository.getForWrite !== "function" ||
      typeof options.repository.upsert !== "function"
    ) {
      throw new TypeError("history repository is required");
    }
    this._repository = options.repository;
    this._clock = options.clock || Date.now;
    this._sleep = options.sleep || defaultSleep;
    this._backoff = options.backoff || defaultBackoff;
    this._jitter = options.jitter || defaultJitter;
    this._maxAttempts = options.maxAttempts ?? 5;
    if (
      typeof this._clock !== "function" ||
      typeof this._sleep !== "function" ||
      typeof this._backoff !== "function" ||
      typeof this._jitter !== "function" ||
      !Number.isSafeInteger(this._maxAttempts) ||
      this._maxAttempts < 1 ||
      this._maxAttempts > 16
    ) {
      throw new TypeError("history service options are invalid");
    }
  }

  async get(deviceBinding, contentKey) {
    const binding = assertDeviceBinding(deviceBinding);
    const key = assertContentKey(contentKey);
    return toHistoryDto(await this._repository.get(binding.profileId, key));
  }

  async put(deviceBinding, contentKey, body) {
    const binding = assertDeviceBinding(deviceBinding);
    const key = assertContentKey(contentKey);
    const input = normalizeHistoryInput(body);

    for (let attempt = 0; attempt < this._maxAttempts; attempt += 1) {
      const writeState = await this._repository.getForWrite(binding.profileId, key);
      const current = writeState && writeState.deletedAt === null ? writeState : null;
      const boundInput = bindCanonicalIdentity(input, current);
      const directInput = applyDirectEventSemantics(boundInput, current);
      const effectiveInput = attempt === 0 ? directInput : mergeAfterConflict(directInput, current);
      const entry = {
        contentKey: key,
        ...effectiveInput,
        lastPlayedAt: nextLastPlayedAt(this._clock, writeState),
      };
      try {
        const mutationOptions = {};
        if (binding.historyGeneration !== undefined) {
          mutationOptions.generation = binding.historyGeneration;
        }
        if (binding.deviceGeneration !== undefined) {
          mutationOptions.deviceId = binding.deviceId;
          mutationOptions.deviceGeneration = binding.deviceGeneration;
        }
        const stored = await this._repository.upsert(
          binding.profileId,
          entry,
          writeState ? writeState.revision : 0,
          mutationOptions
        );
        return toHistoryDto(stored);
      } catch (error) {
        if (!isRetryableConflict(error)) throw error;
        if (attempt + 1 >= this._maxAttempts) throw historyConflict();
        const backoff = readDelay(this._backoff(attempt), "history retry backoff");
        const jitter = readDelay(this._jitter(backoff, attempt), "history retry jitter");
        await this._sleep(Math.min(backoff + jitter, MAX_RETRY_DELAY_MS));
      }
    }
    throw historyConflict();
  }

  async remove(deviceBinding, contentKey) {
    if (typeof this._repository.remove !== "function") {
      throw new TypeError("history repository remove is unavailable");
    }
    const binding = assertDeviceBinding(deviceBinding);
    const key = assertContentKey(contentKey);
    for (let attempt = 0; attempt < this._maxAttempts; attempt += 1) {
      const current = await this._repository.getForWrite(binding.profileId, key);
      if (!current || current.deletedAt !== null) return false;
      try {
        const mutationOptions = {};
        if (binding.historyGeneration !== undefined) {
          mutationOptions.generation = binding.historyGeneration;
        }
        if (binding.deviceGeneration !== undefined) {
          mutationOptions.deviceId = binding.deviceId;
          mutationOptions.deviceGeneration = binding.deviceGeneration;
        }
        return await this._repository.remove(
          binding.profileId,
          key,
          current.revision,
          mutationOptions
        );
      } catch (error) {
        if (!isRetryableConflict(error)) throw error;
        if (attempt + 1 >= this._maxAttempts) throw historyConflict();
        const backoff = readDelay(this._backoff(attempt), "history retry backoff");
        const jitter = readDelay(this._jitter(backoff, attempt), "history retry jitter");
        await this._sleep(Math.min(backoff + jitter, MAX_RETRY_DELAY_MS));
      }
    }
    throw historyConflict();
  }
}

function projectCanonicalIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.imdb === "string" && /^tt\d{7,}$/.test(value.imdb)) {
    const hasSeason = Number.isSafeInteger(value.season) && value.season >= 0;
    const hasEpisode = Number.isSafeInteger(value.episode) && value.episode >= 0;
    if (hasSeason !== hasEpisode) return null;
    return hasSeason
      ? {
          provider: "imdb",
          id: value.imdb,
          mediaType: "episode",
          season: value.season,
          episode: value.episode,
        }
      : { provider: "imdb", id: value.imdb, mediaType: "movie" };
  }

  if (
    !CANONICAL_PROVIDERS.has(value.provider) ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 256 ||
    value.id.trim() !== value.id ||
    /[\u0000-\u001f\u007f]/.test(value.id) ||
    (value.provider === "imdb" && !/^tt\d{7,}$/.test(value.id))
  ) {
    return null;
  }
  if (value.mediaType === "movie") {
    return { provider: value.provider, id: value.id, mediaType: "movie" };
  }
  if (
    value.mediaType !== "episode" ||
    !Number.isSafeInteger(value.season) ||
    value.season < 0 ||
    !Number.isSafeInteger(value.episode) ||
    value.episode < 0
  ) {
    return null;
  }
  return {
    provider: value.provider,
    id: value.id,
    mediaType: "episode",
    season: value.season,
    episode: value.episode,
  };
}

module.exports = {
  HISTORY_INPUT_MAX_BYTES,
  HistoryService,
  applyDirectEventSemantics,
  assertContentKey,
  bindCanonicalIdentity,
  mergeAfterConflict,
  nextLastPlayedAt,
  normalizeCanonicalIdentity,
  normalizeDisplaySnapshot,
  normalizeHistoryInput,
  normalizePlaybackSnapshot,
  projectCanonicalIdentity,
  projectCanonicalIdentityDto,
  projectDisplaySnapshot,
  projectPlaybackSnapshot,
  toHistoryDto,
};
