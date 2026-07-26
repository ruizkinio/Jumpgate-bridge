"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  HISTORY_EVENT_DIGEST_DOMAIN,
  HISTORY_EVENT_METHOD,
  HISTORY_EVENT_PATH,
  HISTORY_GRANT_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  PLAYBACK_CLAIM_DIGEST_DOMAIN,
  PLAYBACK_CLAIM_METHOD,
  PLAYBACK_CLAIM_PATH,
  digestHistoryEventRequest,
  digestPlaybackClaimRequest,
  parseHistoryEventRequest,
  parsePlaybackClaimRequest,
} = require("../lib/history-protocol");

const ATTEMPT_ID = "018f47c2-7f3a-7b1c-8d2e-4f5a6b7c8d9e";
const EVENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const GRANT_TOKEN = "hg1_" + "a".repeat(43);

function expectedDigest(domain, method, path, rawBody) {
  return crypto
    .createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(method, "ascii")
    .update("\0", "utf8")
    .update(path, "utf8")
    .update("\0", "utf8")
    .update(rawBody)
    .digest("hex");
}

function eventBody(overrides = {}) {
  return {
    event: "start",
    sessionRevision: 1,
    positionMs: 30_000,
    durationMs: 120_000,
    watchedMs: 25_000,
    playbackPreferences: {
      subtitleTrackId: "subtitle_track_01",
      audioTrackId: "audio_track_01",
      subtitleLanguages: ["eng", "nld"],
      subtitlesEnabled: true,
      playbackSpeed: 1,
    },
    ...overrides,
  };
}

function headers(overrides = {}) {
  return {
    [HISTORY_GRANT_HEADER]: GRANT_TOKEN,
    [IDEMPOTENCY_KEY_HEADER]: EVENT_ID,
    ...overrides,
  };
}

test("playback claim digest binds the domain, method, path, and exact raw JSON bytes", () => {
  const compact = Buffer.from(
    JSON.stringify({
      attemptId: ATTEMPT_ID,
      fingerprints: ["sha256:" + "1".repeat(64)],
      intentUrlHash: "2".repeat(64),
      launchedAt: 1_725_000_000_000,
    })
  );
  const spaced = Buffer.from(compact.toString("utf8").replace(",\"fingerprints", ", \"fingerprints"));

  assert.equal(
    digestPlaybackClaimRequest(compact),
    expectedDigest(
      PLAYBACK_CLAIM_DIGEST_DOMAIN,
      PLAYBACK_CLAIM_METHOD,
      PLAYBACK_CLAIM_PATH,
      compact
    )
  );
  assert.notEqual(digestPlaybackClaimRequest(compact), digestPlaybackClaimRequest(spaced));
  const parsed = parsePlaybackClaimRequest(compact);
  assert.equal(parsed.attemptId, ATTEMPT_ID);
  assert.equal(parsed.requestDigest, digestPlaybackClaimRequest(compact));
  assert.deepEqual(parsed.body.fingerprints, ["sha256:" + "1".repeat(64)]);
});

test("playback claims require a lowercase canonical UUID attemptId and valid raw JSON", () => {
  for (const attemptId of [
    ATTEMPT_ID.toUpperCase(),
    "123e4567-e89b-02d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    "not-a-uuid",
    null,
  ]) {
    assert.throws(
      () => parsePlaybackClaimRequest(Buffer.from(JSON.stringify({ attemptId }))),
      (error) => error.code === "invalid_playback_claim" && error.status === 400
    );
  }
  assert.throws(
    () => parsePlaybackClaimRequest(Buffer.from([0xff, 0xfe, 0xfd])),
    (error) => error.code === "invalid_playback_claim"
  );
  assert.throws(
    () => parsePlaybackClaimRequest(Buffer.from("[]")),
    (error) => error.code === "invalid_playback_claim"
  );
});

test("history events bind an opaque grant, canonical idempotency UUID, and exact body bytes", () => {
  const rawBody = Buffer.from(JSON.stringify(eventBody()));
  const parsed = parseHistoryEventRequest(headers(), rawBody);

  assert.equal(parsed.grantToken, GRANT_TOKEN);
  assert.equal(parsed.idempotencyKey, EVENT_ID);
  assert.equal(
    parsed.requestDigest,
    expectedDigest(
      HISTORY_EVENT_DIGEST_DOMAIN,
      HISTORY_EVENT_METHOD,
      HISTORY_EVENT_PATH,
      rawBody
    )
  );
  assert.equal(parsed.requestDigest, digestHistoryEventRequest(rawBody));
  assert.deepEqual(parsed.event, eventBody());

  const spaced = Buffer.from(rawBody.toString("utf8").replace(",\"sessionRevision", ", \"sessionRevision"));
  assert.notEqual(digestHistoryEventRequest(rawBody), digestHistoryEventRequest(spaced));
});

test("history event bodies reject every caller-controlled identity and source field", () => {
  const forbidden = [
    ["contentKey", "0".repeat(64)],
    ["canonicalIdentity", { provider: "imdb", id: "tt0133093" }],
    ["imdbId", "tt0133093"],
    ["tmdbId", 603],
    ["externalIds", { imdb: "tt0133093" }],
    ["sourceUrl", "https://media.example/private.mkv?token=secret"],
    ["providerUrl", "https://addon.example/stream.json"],
  ];
  for (const [field, value] of forbidden) {
    assert.throws(
      () => parseHistoryEventRequest(headers(), Buffer.from(JSON.stringify(eventBody({ [field]: value })))),
      (error) => error.code === "invalid_history_event",
      field
    );
  }

  assert.throws(
    () =>
      parseHistoryEventRequest(
        headers(),
        Buffer.from(JSON.stringify(eventBody({
          playbackPreferences: {
            subtitleTrackId: "https://source.example/subtitle.vtt?token=secret",
          },
        })))
      ),
    (error) => error.code === "invalid_history_event"
  );
});

test("history event headers and progress use strict canonical forms", () => {
  const rawBody = Buffer.from(JSON.stringify(eventBody()));
  assert.throws(
    () => parseHistoryEventRequest(headers({ [HISTORY_GRANT_HEADER]: "not-a-grant" }), rawBody),
    (error) => error.code === "history_grant_required" && error.status === 401
  );
  assert.throws(
    () => parseHistoryEventRequest({
      ...headers(),
      "X-Jumpgate-History-Grant": GRANT_TOKEN,
    }, rawBody),
    (error) => error.code === "history_grant_required"
  );
  assert.throws(
    () => parseHistoryEventRequest(headers({ [IDEMPOTENCY_KEY_HEADER]: EVENT_ID.toUpperCase() }), rawBody),
    (error) => error.code === "invalid_idempotency_key"
  );
  assert.throws(
    () =>
      parseHistoryEventRequest(
        headers(),
        Buffer.from(JSON.stringify(eventBody({ positionMs: 120_001 })))
      ),
    (error) => error.code === "invalid_history_event"
  );
  assert.throws(
    () =>
      parseHistoryEventRequest(
        headers(),
        Buffer.from(JSON.stringify(eventBody({ playbackPreferences: { providerId: "provider_01" } })))
      ),
    (error) => error.code === "invalid_history_event"
  );
});
