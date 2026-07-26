"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  readKodiVersion,
  spliceCppLines,
  stripCppComments,
  verifyKodiVersion,
} = require("./verify-kodi-version-parity");

const declaration = (version = "3.0.0") =>
  `  static constexpr const char* JUMPGATE_VERSION = "${version}";\n`;

test("Kodi version parity accepts exactly one active matching declaration", () => {
  assert.equal(verifyKodiVersion(`#pragma once\n${declaration()}`, "3.0.0"), "3.0.0");
});

test("commented declarations cannot satisfy version parity", () => {
  assert.throws(() => readKodiVersion(`//${declaration()}`), /found 0/);
  assert.throws(() => readKodiVersion(`/*\n${declaration()}*/\n`), /found 0/);
  assert.throws(() => readKodiVersion(`// continued \\\n${declaration()}`), /found 0/);
  assert.throws(() => readKodiVersion(`// spaced \\ \t\v\f\n${declaration()}`), /found 0/);
  assert.throws(() => readKodiVersion(`// spaced CRLF \\ \t\v\f\r\n${declaration()}`), /found 0/);
  assert.equal(readKodiVersion(`// ${declaration("9.9.9")}${declaration()}`), "3.0.0");
});

test("missing, duplicate, malformed, and mismatched declarations fail closed", () => {
  assert.throws(() => readKodiVersion("#pragma once\n"), /found 0/);
  assert.throws(() => readKodiVersion(declaration() + declaration()), /found 2/);
  assert.throws(
    () => readKodiVersion('static constexpr const char* JUMPGATE_VERSION = "3.0.0"; int bypass;\n'),
    /found 0/
  );
  assert.throws(() => verifyKodiVersion(declaration("3.0.1"), "3.0.0"), /expected 3\.0\.0, found 3\.0\.1/);
});

test("comment stripping preserves literals and rejects unterminated block comments", () => {
  const source = 'const char* url = "https://example.test/*literal*/"; // remove me\n' + declaration();
  const stripped = stripCppComments(source);
  assert.match(stripped, /https:\/\/example\.test\/\*literal\*\//);
  assert.equal(readKodiVersion(stripped), "3.0.0");
  assert.throws(() => stripCppComments("/* never closed"), /unterminated comment/);
});

test("line splicing and unsupported C++ contexts fail closed", () => {
  assert.equal(
    spliceCppLines("first\\\nsecond\\ \t\v\f\r\nthird"),
    "firstsecondthird"
  );
  assert.throws(
    () => readKodiVersion(`#if 0\n${declaration()}#endif\n`),
    /unsupported conditional preprocessing/
  );
  assert.throws(
    () => readKodiVersion(`%:if 0\n${declaration()}%:endif\n`),
    /unsupported conditional preprocessing/
  );
  assert.throws(
    () => readKodiVersion(`const char* decoy = R"tag(${declaration()})tag";\n`),
    /unsupported raw string/
  );
});
