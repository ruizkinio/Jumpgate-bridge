"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const BRIDGE_VERSION = require(path.join(ROOT, "package.json")).version;
const DECLARATION = /^\s*static constexpr const char\* JUMPGATE_VERSION = "([^"]+)";\s*$/gm;
const CONDITIONAL_DIRECTIVE = /^\s*(?:#|%:)\s*(?:if|ifdef|ifndef|elif|else|endif)\b/m;
const RAW_STRING_PREFIX = /(?:^|[^A-Za-z0-9_])(?:u8|u|U|L)?R"/;

function spliceCppLines(source) {
  return String(source).replace(/\\[ \t\v\f]*\r?\n/g, "");
}

function stripCppComments(source) {
  let output = "";
  let state = "code";

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] || "";

    if (state === "line-comment") {
      if (current === "\n") {
        output += current;
        state = "code";
      } else {
        output += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        output += "  ";
        index += 1;
        state = "code";
      } else {
        output += current === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "string" || state === "character") {
      output += current;
      if (current === "\\") {
        if (index + 1 < source.length) {
          output += source[index + 1];
          index += 1;
        }
      } else if (
        (state === "string" && current === '"') ||
        (state === "character" && current === "'")
      ) {
        state = "code";
      }
      continue;
    }

    if (current === "/" && next === "/") {
      output += "  ";
      index += 1;
      state = "line-comment";
    } else if (current === "/" && next === "*") {
      output += "  ";
      index += 1;
      state = "block-comment";
    } else {
      output += current;
      if (current === '"') state = "string";
      if (current === "'") state = "character";
    }
  }

  if (state === "block-comment") throw new Error("Kodi version header has an unterminated comment");
  return output;
}

function readKodiVersion(source) {
  const spliced = spliceCppLines(source);
  if (RAW_STRING_PREFIX.test(spliced)) {
    throw new Error("Kodi version header contains an unsupported raw string");
  }
  const uncommented = stripCppComments(spliced);
  if (CONDITIONAL_DIRECTIVE.test(uncommented)) {
    throw new Error("Kodi version header contains unsupported conditional preprocessing");
  }
  const matches = [...uncommented.matchAll(DECLARATION)];
  if (matches.length !== 1) {
    throw new Error(`Kodi version header must contain exactly one active declaration; found ${matches.length}`);
  }
  return matches[0][1];
}

function verifyKodiVersion(source, expectedVersion = BRIDGE_VERSION) {
  const actualVersion = readKodiVersion(source);
  if (actualVersion !== expectedVersion) {
    throw new Error(`Kodi runtime version mismatch: expected ${expectedVersion}, found ${actualVersion}`);
  }
  return actualVersion;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !argv[0]) {
    throw new Error("usage: node scripts/ci/verify-kodi-version-parity.js <XBMCApp.h>");
  }
  const headerPath = path.resolve(process.cwd(), argv[0]);
  verifyKodiVersion(fs.readFileSync(headerPath, "utf8"));
  process.stdout.write(`Bridge/Kodi version parity passed: ${BRIDGE_VERSION}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, readKodiVersion, spliceCppLines, stripCppComments, verifyKodiVersion };
