"use strict";

const crypto = require("node:crypto");
const { types } = require("node:util");

const {
  applyDirectEventSemantics,
  bindCanonicalIdentity,
  mergeAfterConflict,
  nextLastPlayedAt,
} = require("../history-service");
const {
  attachPreparedHttpResponse,
  decodePreparedHttpResponse,
} = require("../prepared-http-response");
const {
  dispatchEventForHistoryEvent,
  historyGrantError,
  publicDispatchIntent,
  publicGrant,
} = require("./history-grant");
const { assertPlaybackGeneration } = require("./playback-session");
const {
  assertIdentifier,
  assertMutationFence,
  cloneJson,
  stableScope,
} = require("./repository-utils");

const NUMERIC_TRAKT_ID = /^[1-9][0-9]{0,15}$/;

function tokenPurpose(grantId) {
  return "history-grant-token:" + stableScope("history-grant", grantId).slice(0, 64);
}

function dispatchId(grantId, idempotencyKey) {
  return "hdi_" + crypto
    .createHash("sha256")
    .update("jumpgate-history-dispatch:v1\0", "utf8")
    .update(grantId, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "ascii")
    .digest("base64url");
}

function grantResponse(record, grantToken) {
  const response = { ...publicGrant(record), grantToken };
  if (record.claimResponse) {
    attachPreparedHttpResponse(response, decodePreparedHttpResponse(record.claimResponse));
  }
  return Object.freeze(response);
}

function recoverGrantToken(record, tokenService, envelopeCrypto) {
  let authority;
  let recoveredHash;
  try {
    authority = envelopeCrypto.decryptJson(record.tokenEnvelope, tokenPurpose(record.grantId));
    if (
      !authority ||
      typeof authority !== "object" ||
      Array.isArray(authority) ||
      Object.keys(authority).length !== 1 ||
      typeof authority.token !== "string"
    ) {
      throw new Error("history grant token authority is malformed");
    }
    recoveredHash = tokenService.hashToken("history-grant", authority.token);
  } catch (_error) {
    throw historyGrantError(
      "history_grant_authority_unavailable",
      "history grant retry authority is unavailable",
      503
    );
  }
  if (recoveredHash !== record.tokenHash) {
    throw historyGrantError(
      "history_grant_authority_unavailable",
      "history grant retry authority is invalid",
      503
    );
  }
  return authority.token;
}

function hashPresentedGrantToken(tokenService, token) {
  try {
    return tokenService.hashToken("history-grant", token);
  } catch (_error) {
    throw historyGrantError("history_grant_invalid", "history grant is invalid", 401);
  }
}

function normalizeSourceRevocation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) {
    throw new TypeError("history source revocation is invalid");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("history source revocation is invalid");
  }
  const fields = new Set([
    "profileId",
    "contextId",
    "playbackGeneration",
    "providerRevision",
    "contextRevision",
  ]);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new TypeError("history source revocation is invalid");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new TypeError("history source revocation is invalid");
    }
  }
  return Object.freeze({
    profileId: assertIdentifier(value.profileId, "profile id"),
    contextId: assertIdentifier(value.contextId, "source context id"),
    playbackGeneration: assertPlaybackGeneration(value.playbackGeneration),
    providerRevision: assertMutationFence(value.providerRevision, "provider revision"),
    contextRevision: assertMutationFence(value.contextRevision, "source context revision"),
  });
}

function revocationScope(kind, value) {
  switch (kind) {
    case "profile":
      return stableScope("history-profile-revocation", value.profileId, value.profileRevision);
    case "device":
      return stableScope(
        "history-device-revocation",
        value.profileId,
        value.deviceId,
        value.deviceGeneration
      );
    case "history":
      return stableScope("history-generation-revocation", value.profileId, value.historyGeneration);
    case "playback":
      return stableScope(
        "history-playback-revocation",
        value.profileId,
        value.playbackGeneration
      );
    case "session":
    case "supersession":
      return stableScope("history-session-revocation", value.profileId, value.sessionId);
    case "source":
      return stableScope(
        "history-source-revocation",
        value.profileId,
        value.contextId,
        value.playbackGeneration,
        value.providerRevision,
        value.contextRevision
      );
    default:
      throw new TypeError("history revocation kind is invalid");
  }
}

function revocationScopes(record, authority = record.authority) {
  const scopes = [
    ["profile", revocationScope("profile", record)],
    ["device", revocationScope("device", record)],
    ["history", revocationScope("history", record)],
    ["playback", revocationScope("playback", record)],
    ["session", revocationScope("session", record)],
    ["supersession", revocationScope("supersession", record)],
  ];
  if (authority && authority.contextId !== null) {
    scopes.push(["source", revocationScope("source", authority)]);
  }
  return scopes;
}

function historyEntry(record, event, current, clock, writeState = current) {
  if (!record.authority || !record.authority.contentKey) return null;
  const input = {
    canonicalIdentity: cloneJson(record.authority.canonicalIdentity),
    displaySnapshot: cloneJson(record.authority.displaySnapshot),
    playbackSnapshot: cloneJson(event.playbackPreferences),
    positionMs: event.positionMs,
    durationMs: event.durationMs,
    watchedMs: event.watchedMs,
    completed: event.event === "completion",
  };
  const bound = bindCanonicalIdentity(input, current);
  const direct = applyDirectEventSemantics(bound, current);
  const effective = mergeAfterConflict(direct, current);
  return {
    contentKey: record.authority.contentKey,
    ...effective,
    lastPlayedAt: nextLastPlayedAt(clock, writeState),
  };
}

function canonicalDispatchPayload(identity, progress, event) {
  if (!identity || identity.confidence !== "canonical") {
    throw historyGrantError("history_dispatch_invalid", "canonical Trakt identity is invalid", 500);
  }
  let ids;
  if (identity.provider === "imdb" && /^tt[0-9]{7,}$/.test(identity.id)) {
    ids = { imdb: identity.id };
  } else if (
    (identity.provider === "tmdb" || identity.provider === "tvdb" || identity.provider === "trakt") &&
    NUMERIC_TRAKT_ID.test(identity.id)
  ) {
    const numericId = Number(identity.id);
    if (!Number.isSafeInteger(numericId)) {
      throw historyGrantError("history_dispatch_invalid", "canonical Trakt identity is invalid", 500);
    }
    ids = { [identity.provider]: numericId };
  } else {
    throw historyGrantError("history_dispatch_invalid", "canonical Trakt identity is invalid", 500);
  }
  const payloadProgress = event === "completion" ? 100 : progress;
  if (identity.mediaType === "movie") return { movie: { ids }, progress: payloadProgress };
  if (
    identity.mediaType === "episode" &&
    Number.isSafeInteger(identity.season) &&
    identity.season >= 0 &&
    Number.isSafeInteger(identity.episode) &&
    identity.episode >= 0
  ) {
    return {
      episode: { season: identity.season, number: identity.episode, ids },
      progress: payloadProgress,
    };
  }
  throw historyGrantError("history_dispatch_invalid", "canonical Trakt identity is invalid", 500);
}

function createDispatchIntent(record, candidate, sessionRevision, now) {
  const progress = candidate.event.event === "completion"
    ? 100
    : candidate.event.durationMs === 0
      ? 0
      : Number(((candidate.event.positionMs / candidate.event.durationMs) * 100).toFixed(3));
  const intent = {
    id: dispatchId(record.grantId, candidate.idempotencyKey),
    grantId: record.grantId,
    profileId: record.profileId,
    profileRevision: record.profileRevision,
    deviceId: record.deviceId,
    deviceGeneration: record.deviceGeneration,
    historyGeneration: record.historyGeneration,
    sessionId: record.sessionId,
    sessionRevision,
    contextId: record.authority.contextId,
    contextRevision: record.authority.contextRevision,
    playbackGeneration: record.playbackGeneration,
    providerRevision: record.authority.providerRevision,
    event: dispatchEventForHistoryEvent(candidate.event.event),
    progress,
    canonicalIdentity: cloneJson(record.authority.canonicalIdentity),
    status: "queued",
    createdAt: now,
    revokedAt: null,
  };
  return {
    intent,
    payload: canonicalDispatchPayload(
      record.authority.canonicalIdentity,
      progress,
      candidate.event.event
    ),
    publicIntent: publicDispatchIntent(intent),
  };
}

function eventResponse(record, candidate, history, dispatchIntent, status = null) {
  return Object.freeze({
    ok: true,
    status: status || (record.kind === "negative" ? "local_only" : "applied"),
    grantKind: record.kind,
    event: candidate.event.event,
    sessionId: record.sessionId,
    sessionState: record.sessionState,
    sessionRevision: record.sessionRevision,
    history,
    dispatchIntent,
  });
}

function nextSessionRevision(current) {
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
    throw historyGrantError(
      "history_session_revision_exhausted",
      "history session revision is exhausted"
    );
  }
  return current + 1;
}

module.exports = {
  canonicalDispatchPayload,
  createDispatchIntent,
  dispatchId,
  eventResponse,
  grantResponse,
  hashPresentedGrantToken,
  historyEntry,
  nextSessionRevision,
  normalizeSourceRevocation,
  recoverGrantToken,
  revocationScope,
  revocationScopes,
  tokenPurpose,
};
