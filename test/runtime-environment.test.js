"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { isProductionLikeEnvironment } = require("../lib/runtime-environment");

test("only production and controlled UAT are production-like runtimes", () => {
  assert.equal(isProductionLikeEnvironment("production"), true);
  assert.equal(isProductionLikeEnvironment("uat"), true);
  for (const environment of ["development", "test", "", undefined, null]) {
    assert.equal(isProductionLikeEnvironment(environment), false);
  }
});
