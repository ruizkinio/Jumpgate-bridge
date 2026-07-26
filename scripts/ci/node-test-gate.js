"use strict";

const { spawnSync } = require("node:child_process");

function fail(message) {
  console.error("CI test gate: " + message);
  process.exit(1);
}

let expectedTests = null;
let minimumTests = null;
let requireNoSkips = false;
const separator = process.argv.indexOf("--");

if (separator === -1 || separator === process.argv.length - 1) {
  fail("pass one or more test files after --");
}

for (const argument of process.argv.slice(2, separator)) {
  if (argument === "--no-skips") {
    requireNoSkips = true;
  } else if (argument.startsWith("--expected-tests=")) {
    expectedTests = Number(argument.slice("--expected-tests=".length));
  } else if (argument.startsWith("--minimum-tests=")) {
    minimumTests = Number(argument.slice("--minimum-tests=".length));
  } else {
    fail("unknown argument " + argument);
  }
}

if (expectedTests !== null && (!Number.isSafeInteger(expectedTests) || expectedTests < 1)) {
  fail("--expected-tests must be a positive integer");
}
if (minimumTests !== null && (!Number.isSafeInteger(minimumTests) || minimumTests < 1)) {
  fail("--minimum-tests must be a positive integer");
}

const result = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", ...process.argv.slice(separator + 1)],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
);

process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");

if (result.error) fail("could not start node --test: " + result.error.message);
if (result.status !== 0) process.exit(result.status || 1);

function readSummary(name) {
  const pattern = new RegExp("^# " + name + " (\\d+)$", "gm");
  const matches = [...(result.stdout || "").matchAll(pattern)];
  if (matches.length !== 1) fail("missing or ambiguous TAP summary for " + name);
  return Number(matches[0][1]);
}

const tests = readSummary("tests");
const passed = readSummary("pass");
const failed = readSummary("fail");
const skipped = readSummary("skipped");

if (failed !== 0) fail("TAP summary reported failed tests");
if (passed + skipped !== tests) fail("TAP summary counts are inconsistent");
if (expectedTests !== null && tests !== expectedTests) {
  fail(`expected ${expectedTests} tests, but ${tests} were discovered`);
}
if (minimumTests !== null && tests < minimumTests) {
  fail(`expected at least ${minimumTests} tests, but ${tests} were discovered`);
}
if (requireNoSkips && skipped !== 0) fail(`${skipped} test(s) were skipped`);

console.log(`CI test gate passed: ${tests} tests, ${passed} passed, ${skipped} skipped.`);
