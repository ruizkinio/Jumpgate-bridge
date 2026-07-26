"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { fingerprintExactUrl, fingerprintStream } = require("../lib/source-context");

const FIXTURE_SHA256 = "33f7213ff6188cf216222e9ab1315af2aa95949e812aee5053c4e8fea58b91c9";
const FIXTURE_PATH = path.join(__dirname, "fixtures", "source-fingerprint-v1.json");
const KODI_FIXTURE_PATH =
  process.env.JUMPGATE_KODI_FINGERPRINT_FIXTURE ||
  path.resolve(__dirname, "..", "..", "xbmc", "xbmc", "utils", "test", "fixtures", "source-fingerprint-v1.json");
const fixtureBytes = fs.readFileSync(FIXTURE_PATH);
const fixtures = JSON.parse(fixtureBytes.toString("utf8"));

test("source-fingerprint-v1 fixture bytes are pinned", () => {
  assert.equal(crypto.createHash("sha256").update(fixtureBytes).digest("hex"), FIXTURE_SHA256);
  assert.equal(fixtureBytes.includes(0x0d), false);
  assert.equal(fixtureBytes.at(-1), 0x0a);
  assert.equal(fixtures.formatVersion, 1);
  assert.equal(fixtures.algorithm, "source-fingerprint-v1");
});

test(
  "source-fingerprint-v1 Kodi sibling fixture is byte-identical",
  { skip: !fs.existsSync(KODI_FIXTURE_PATH) },
  () => {
    assert.deepEqual(fs.readFileSync(KODI_FIXTURE_PATH), fixtureBytes);
  }
);

for (const fixture of fixtures.validCases) {
  test(`source-fingerprint-v1 parity: ${fixture.id}`, () => {
    assert.deepEqual(
      fingerprintStream(fixture.stream, fixture.extraFingerprints),
      fixture.expected
    );

    if (fixture.exactUrl !== undefined) {
      assert.equal(fingerprintExactUrl(fixture.exactUrl), fixture.exactExpected);
    }

    for (const fingerprint of fixture.expected) {
      assert.match(fingerprint, /^v1:[a-z0-9-]+(?::[a-f0-9]{40})?(?::[a-z0-9-]+)*$/);
      assert.equal(/[A-F]/.test(fingerprint), false);
    }
  });
}

for (const fixture of fixtures.invalidStreams) {
  test(`source-fingerprint-v1 rejects invalid stream: ${fixture.id}`, () => {
    assert.throws(() => fingerprintStream(fixture.stream, fixture.extraFingerprints));
  });
}

test("exact URL fixtures distinguish query order and percent encoding", () => {
  const exactCases = fixtures.validCases.filter((fixture) => fixture.exactExpected !== undefined);
  const fingerprints = exactCases
    .map((fixture) => fixture.exactExpected);
  const signedByteVariants = exactCases
    .filter((fixture) => fixture.id.startsWith("direct-signed-url-"))
    .filter((fixture) => fixture.exactExpected !== undefined)
    .map((fixture) => fixture.exactExpected);

  assert.ok(fingerprints.length >= 7);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  assert.equal(signedByteVariants.length, 3);
  assert.equal(new Set(signedByteVariants).size, signedByteVariants.length);
});

test("NZB file selectors produce distinct canonical fingerprints", () => {
  const fingerprints = fixtures.validCases
    .filter((fixture) => fixture.id.startsWith("nzb-create-route"))
    .map((fixture) => fixture.expected[0]);

  assert.equal(fingerprints.length, 4);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});
