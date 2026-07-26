"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  RUBY_PSYCH_REQUIRED_MESSAGE,
  assertRubyPsych,
} = require("./tooling-prerequisites");

test("Ruby Psych prerequisite reports one stable actionable error", () => {
  for (const result of [
    { error: Object.assign(new Error("missing"), { code: "ENOENT" }), status: null },
    { error: null, status: 1, stderr: "cannot load such file -- psych\n" },
    { error: null, status: 0, stdout: "unexpected\n" },
  ]) {
    assert.throws(
      () => assertRubyPsych({ spawnSync: () => result }),
      (error) => error.message === RUBY_PSYCH_REQUIRED_MESSAGE
    );
  }
});

test("Ruby Psych prerequisite accepts the exact readiness marker", () => {
  const calls = [];
  assert.equal(
    assertRubyPsych({
      spawnSync(command, args, options) {
        calls.push({ command, args, options });
        return { error: null, status: 0, stdout: "jumpgate-ruby-psych-ready\n", stderr: "" };
      },
    }),
    true
  );
  assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [{
    command: "ruby",
    args: ["-e", "require 'psych'; puts 'jumpgate-ruby-psych-ready'"],
  }]);
});

test("Ruby Psych prerequisite accepts native Windows line endings", () => {
  assert.equal(
    assertRubyPsych({
      spawnSync: () => ({
        error: null,
        status: 0,
        stdout: "jumpgate-ruby-psych-ready\r\n",
        stderr: "",
      }),
    }),
    true
  );
});
