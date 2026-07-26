"use strict";

const { spawnSync } = require("node:child_process");

const RUBY_PSYCH_READY_MARKER = "jumpgate-ruby-psych-ready";
const RUBY_PSYCH_REQUIRED_MESSAGE =
  "Ruby with Psych is required for workflow policy tests; install Ruby 3.x with the Psych standard/default gem.";

function assertRubyPsych(options = {}) {
  const runner = options.spawnSync || spawnSync;
  const rubyCommand = options.rubyCommand || "ruby";
  const result = runner(
    rubyCommand,
    ["-e", "require 'psych'; puts '" + RUBY_PSYCH_READY_MARKER + "'"],
    { encoding: "utf8", windowsHide: true }
  );
  if (
    !result ||
    result.error ||
    result.status !== 0 ||
    ![
      RUBY_PSYCH_READY_MARKER + "\n",
      RUBY_PSYCH_READY_MARKER + "\r\n",
    ].includes(result.stdout)
  ) {
    throw new Error(RUBY_PSYCH_REQUIRED_MESSAGE);
  }
  return true;
}

function main() {
  assertRubyPsych();
  console.log("Ruby Psych test prerequisite is available.");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  RUBY_PSYCH_REQUIRED_MESSAGE,
  assertRubyPsych,
  main,
};
