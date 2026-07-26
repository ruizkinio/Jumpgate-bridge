"use strict";

const { isSafePublicArtworkUrl } = require("./public-artwork");

const { validateStoredContext } = require("./source-context");

const MAX_PUBLIC_CONTEXT_JSON_BYTES = 256 * 1024;
const NEGATIVE_CLAIM_STATUSES = new Set(["ambiguous", "expired", "not_found"]);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CONTENT_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_IDENTIFIER_BYTES = MAX_IDENTIFIER_LENGTH * 4;
const MAX_PROVENANCE_VALUES = 64;

function assertPlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(name + " must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(name + " must be a plain object");
  }
  return value;
}

function assertIdentifier(value, name) {
  if (!isKodiIdentifier(value)) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function assertCanonicalTimestamp(value, name) {
  if (typeof value !== "string" || value.length !== 24 || new Date(value).toISOString() !== value) {
    throw new TypeError(name + " must be a canonical ISO timestamp");
  }
  return value;
}

function projectExactKeys(source, keys) {
  const projected = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    projected[key] = source[key];
  }
  return projected;
}

function hasValidSurrogatePairs(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isKodiIdentifier(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    Buffer.byteLength(value, "utf8") <= MAX_IDENTIFIER_BYTES &&
    value.trim() === value &&
    !CONTROL_PATTERN.test(value) &&
    hasValidSurrogatePairs(value)
  );
}

function projectIdentifierArray(value) {
  if (!Array.isArray(value) || value.length > MAX_PROVENANCE_VALUES) return null;
  const projected = [];
  const seen = new Set();
  for (const item of value) {
    if (!isKodiIdentifier(item) || seen.has(item)) return null;
    seen.add(item);
    projected.push(item);
  }
  return projected;
}

function projectProvenance(source, scalarKeys, singularKey, pluralKey) {
  const projected = {};
  for (const key of scalarKeys) {
    if (isKodiIdentifier(source[key])) projected[key] = source[key];
  }

  const singular = isKodiIdentifier(source[singularKey]) ? source[singularKey] : null;
  const plural = projectIdentifierArray(source[pluralKey]);
  if (singular !== null) projected[singularKey] = singular;
  if (plural !== null && (singular === null || plural.includes(singular))) {
    projected[pluralKey] = plural;
  }
  return projected;
}

function projectRequest(request) {
  return projectProvenance(
    request,
    ["resource", "type", "metaId", "videoId", "metaProvider"],
    "streamProvider",
    "streamProviders"
  );
}

function projectSource(source) {
  return projectProvenance(source, ["type"], "provider", "providers");
}

function isSafeDisplayText(value) {
  return (
    typeof value === "string" &&
    value.length <= 8192 &&
    Buffer.byteLength(value, "utf8") <= 8192 * 4 &&
    !CONTROL_PATTERN.test(value)
  );
}

function projectCanonicalIdentity(identity) {
  if (identity === null) return null;
  const projected = projectExactKeys(identity, [
    "provider",
    "id",
    "mediaType",
    "confidence",
    "provenance",
  ]);
  if (identity.mediaType === "episode") {
    projected.season = identity.season;
    projected.episode = identity.episode;
  }
  return projected;
}

function projectDisplay(display, canonicalIdentity) {
  const projected = {};
  if (isSafeDisplayText(display.title)) projected.title = display.title;
  if (Number.isSafeInteger(display.year) && display.year >= 0 && display.year <= 9999) {
    projected.year = display.year;
  }

  const isEpisode = canonicalIdentity && canonicalIdentity.mediaType === "episode";
  for (const key of ["season", "episode"]) {
    if (!Number.isSafeInteger(display[key]) || display[key] < 0) continue;
    if (!canonicalIdentity || (isEpisode && display[key] === canonicalIdentity[key])) {
      projected[key] = display[key];
    }
  }
  for (const key of ["poster", "background", "logo"]) {
    if (isSafePublicArtworkUrl(display[key])) projected[key] = display[key];
  }
  return projected;
}

function projectPublicPlaybackContext(privateContext, authenticatedProfileId) {
  const profileId = assertIdentifier(authenticatedProfileId, "authenticated profile id");
  const context = validateStoredContext(privateContext);
  if (context.profileId !== profileId) {
    throw new TypeError("playback context profile does not match the authenticated profile");
  }

  const canonicalIdentity = projectCanonicalIdentity(context.canonicalIdentity);
  const projected = {
    schemaVersion: context.schemaVersion,
    // Required by the current strict native parser; the value is opaque and bounded.
    contextId: context.contextId,
    profileId,
    contentKey:
      context.contentKey !== null && CONTENT_KEY_PATTERN.test(context.contentKey)
        ? context.contentKey
        : null,
    canonicalIdentity,
    traktEligible: context.traktEligible === true,
    request: projectRequest(context.request),
    display: projectDisplay(context.display, canonicalIdentity),
    source: projectSource(context.source),
    // Required by the current strict native parser and already canonical one-way hashes.
    fingerprints: context.fingerprints.slice(),
    inlineSubtitles: [],
    createdAt: context.createdAt,
    expiresAt: context.expiresAt,
  };

  if (Buffer.byteLength(JSON.stringify(projected), "utf8") > MAX_PUBLIC_CONTEXT_JSON_BYTES) {
    throw new RangeError("public playback context exceeds the maximum byte size");
  }
  return projected;
}

function projectPublicPlaybackClaim(privateClaim, authenticatedProfileId) {
  const claim = assertPlainObject(privateClaim, "private playback claim");
  assertIdentifier(authenticatedProfileId, "authenticated profile id");
  if (NEGATIVE_CLAIM_STATUSES.has(claim.status)) {
    if (typeof claim.sessionId !== "string" || !SESSION_ID_PATTERN.test(claim.sessionId)) {
      throw new TypeError("private playback claim sessionId is invalid");
    }
    return { status: claim.status, sessionId: claim.sessionId };
  }
  if (claim.status !== "claimed") throw new TypeError("private playback claim status is invalid");
  if (typeof claim.sessionId !== "string" || !SESSION_ID_PATTERN.test(claim.sessionId)) {
    throw new TypeError("private playback claim sessionId is invalid");
  }

  const claimedAt = assertCanonicalTimestamp(claim.claimedAt, "private playback claim claimedAt");
  const expiresAt = assertCanonicalTimestamp(claim.expiresAt, "private playback claim expiresAt");
  if (expiresAt <= claimedAt) throw new TypeError("private playback claim expiry is invalid");
  const context = projectPublicPlaybackContext(claim.context, authenticatedProfileId);
  return { status: "claimed", sessionId: claim.sessionId, context, claimedAt, expiresAt };
}

module.exports = {
  MAX_PUBLIC_CONTEXT_JSON_BYTES,
  projectPublicPlaybackClaim,
  projectPublicPlaybackContext,
};
