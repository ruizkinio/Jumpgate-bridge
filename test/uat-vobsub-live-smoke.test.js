"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  expectedBuildSha,
  failureCode,
  managementFromActivation,
} = require("../scripts/uat-vobsub-live-smoke");

function activationResponse(cookie) {
  return { headers: new Headers({ "set-cookie": cookie }) };
}

test("live smoke requires one exact deployed build SHA", () => {
  const sha = "a".repeat(40);
  assert.equal(expectedBuildSha(["--expected-sha=" + sha]), sha);
  for (const argv of [[], ["--expected-sha=bad"], ["--expected-sha=" + sha, "extra"]]) {
    assert.throws(() => expectedBuildSha(argv), (error) => error.code === "invalid_arguments");
  }
});

test("partial activation arms cleanup before semantic success checks", () => {
  const cookieValue = "c".repeat(43);
  const csrf = "s".repeat(43);
  const management = managementFromActivation(
    activationResponse("jg_management_session=" + cookieValue + "; Path=/api/profile; HttpOnly"),
    { paired: false, managementCsrf: csrf }
  );
  assert.deepEqual(management, {
    cookie: "jg_management_session=" + cookieValue,
    csrf,
  });
  assert.equal(
    managementFromActivation(activationResponse("unrelated=value"), { managementCsrf: csrf }),
    null
  );
  assert.equal(
    managementFromActivation(
      activationResponse("jg_management_session=" + cookieValue),
      { managementCsrf: "invalid csrf" }
    ),
    null
  );
});

test("live smoke failure codes never reflect secret-bearing diagnostics", () => {
  assert.equal(failureCode(Object.assign(new Error("private"), { code: "http_500" })), "http_500");
  assert.equal(
    failureCode(Object.assign(new Error("private"), { code: "secret=do-not-print" })),
    "assertion_failed"
  );
  assert.equal(failureCode(new Error("Bearer private-token")), "assertion_failed");
});
