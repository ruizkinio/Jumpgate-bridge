"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  HISTORY_EVENT_METHOD,
  HISTORY_EVENT_PATH,
  HISTORY_EVENTS,
  HISTORY_GRANT_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  PLAYBACK_CLAIM_METHOD,
  PLAYBACK_CLAIM_PATH,
  PLAYBACK_PREFERENCE_FIELDS,
  normalizeHistoryEventBody,
} = require("../lib/history-protocol");

const FIXTURE_PATH = path.join(__dirname, "fixtures", "history-wire-v1.json");
const FIXTURE_SHA256 = "9c6f5eff5a0782bfc0be70ed8c23cf865c89ede5653d8f97c027573e3b003851";

function loadFixture() {
  const bytes = fs.readFileSync(FIXTURE_PATH);
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), FIXTURE_SHA256);
  return JSON.parse(bytes.toString("utf8"));
}

test("shared history wire fixture is byte-pinned to the Kodi contract", () => {
  const fixture = loadFixture();
  assert.equal(fixture.formatVersion, 1);
  assert.equal(fixture.algorithm, "history-wire-v1");
  assert.equal(fixture.claim.method, PLAYBACK_CLAIM_METHOD);
  assert.equal(fixture.claim.path, PLAYBACK_CLAIM_PATH);
  assert.equal(fixture.history.method, HISTORY_EVENT_METHOD);
  assert.equal(fixture.history.path, HISTORY_EVENT_PATH);
  assert.deepEqual(fixture.history.events, Array.from(HISTORY_EVENTS));
  assert.deepEqual(fixture.history.headers, [
    "authorization",
    HISTORY_GRANT_HEADER,
    IDEMPOTENCY_KEY_HEADER,
  ]);
  assert.deepEqual(fixture.history.requestOptionalFields, ["playbackPreferences"]);
  assert.deepEqual(
    Array.from(PLAYBACK_PREFERENCE_FIELDS).sort(),
    [
      "audioLanguages",
      "audioTrackId",
      "forced",
      "hearingImpaired",
      "playbackSpeed",
      "subtitleLanguages",
      "subtitleTrackId",
      "subtitlesEnabled",
      "videoTrackId",
    ]
  );
  assert.deepEqual(fixture.release.requestRequiredFields, ["sessionId", "terminalReceiptId"]);
  assert.equal(fixture.release.terminalReceiptSource, "history-event-idempotency-key");
});

test("every fixture lifecycle event is accepted by the strict Bridge normalizer", () => {
  const fixture = loadFixture();
  for (const event of fixture.history.events) {
    const normalized = normalizeHistoryEventBody({
      event,
      sessionRevision: 1,
      positionMs: 25_000,
      durationMs: 100_000,
      watchedMs: 20_000,
    });
    assert.equal(normalized.event, event);
  }
});
