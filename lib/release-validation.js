"use strict";

const UAT_PUBLIC_BASE_URL = "https://jumpgate-uat.fly.dev";
const UAT_SCENARIOS = Object.freeze([
  "normal",
  "delayed-issue",
  "delayed-poll",
  "short-expiry",
  "rate-limit",
  "terminal-failure",
  "apply-delay",
  "apply-failure",
]);
const UAT_SCENARIO_SET = new Set(UAT_SCENARIOS);

function enabledFlag(value, name) {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new TypeError(name + " must be 0 or 1");
}

function optionalDelay(env, name, fallback) {
  if (env.NODE_ENV !== "test" || env[name] === undefined) return fallback;
  if (!/^\d{1,5}$/.test(env[name])) throw new TypeError(name + " is invalid");
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 10 || value > 30_000) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function loadReleaseValidationConfig(env = process.env) {
  const enabled = enabledFlag(env.JUMPGATE_UAT_MODE, "JUMPGATE_UAT_MODE");
  const vobsubFixtureEnabled = enabledFlag(
    env.JUMPGATE_UAT_VOBSUB_FIXTURE,
    "JUMPGATE_UAT_VOBSUB_FIXTURE"
  );
  if (env.NODE_ENV === "production" && vobsubFixtureEnabled) {
    throw new TypeError("production refuses JUMPGATE_UAT_VOBSUB_FIXTURE");
  }
  if (vobsubFixtureEnabled && !enabled) {
    throw new TypeError("JUMPGATE_UAT_VOBSUB_FIXTURE requires JUMPGATE_UAT_MODE");
  }
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      scenarios: UAT_SCENARIOS,
      vobsubFixtureEnabled: false,
    });
  }
  if (env.NODE_ENV === "production") {
    throw new TypeError("production refuses JUMPGATE_UAT_MODE");
  }
  if (env.NODE_ENV !== "uat" && env.NODE_ENV !== "test") {
    throw new TypeError("JUMPGATE_UAT_MODE requires NODE_ENV=uat");
  }
  if (env.PUBLIC_BASE_URL !== UAT_PUBLIC_BASE_URL) {
    throw new TypeError("JUMPGATE_UAT_MODE requires the exact UAT public origin");
  }
  if (
    env.NODE_ENV !== "test" &&
    (env.JUMPGATE_DURABLE_DRIVER !== "postgres" || env.JUMPGATE_TTL_DRIVER !== "redis")
  ) {
    throw new TypeError("JUMPGATE_UAT_MODE requires PostgreSQL and Redis storage");
  }
  for (const name of ["TRAKT_CLIENT_ID", "TRAKT_CLIENT_SECRET", "TMDB_API_KEY"]) {
    if (typeof env[name] === "string" && env[name].trim()) {
      throw new TypeError("JUMPGATE_UAT_MODE refuses external account credentials");
    }
  }
  return Object.freeze({
    enabled: true,
    scenarios: UAT_SCENARIOS,
    vobsubFixtureEnabled,
    delayedIssueMs: optionalDelay(env, "JUMPGATE_TEST_UAT_ISSUE_DELAY_MS", 4_000),
    delayedPollMs: optionalDelay(env, "JUMPGATE_TEST_UAT_POLL_DELAY_MS", 4_000),
    shortExpiryMs: optionalDelay(env, "JUMPGATE_TEST_UAT_EXPIRY_MS", 6_000),
    retryAfterSec: 4,
  });
}

function assertValidationScenario(value, config) {
  if (value === undefined || value === null || value === "") return null;
  if (!config || config.enabled !== true) {
    throw new TypeError("release-validation scenarios are unavailable");
  }
  if (typeof value !== "string" || !UAT_SCENARIO_SET.has(value)) {
    throw new TypeError("release-validation scenario is invalid");
  }
  return value;
}

function waitForRequest(req, res, delayMs) {
  if (!req || typeof req.once !== "function") throw new TypeError("request is required");
  if (!res || typeof res.once !== "function") throw new TypeError("response is required");
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 30_000) {
    throw new TypeError("release-validation delay is invalid");
  }
  return new Promise((resolve) => {
    if (req.aborted || res.destroyed) return resolve(false);
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener("aborted", aborted);
      res.removeListener("close", closed);
      resolve(completed);
    };
    const aborted = () => finish(false);
    const closed = () => {
      if (!res.writableEnded) finish(false);
    };
    const timer = setTimeout(() => finish(true), delayMs);
    req.once("aborted", aborted);
    res.once("close", closed);
  });
}

module.exports = {
  UAT_PUBLIC_BASE_URL,
  UAT_SCENARIOS,
  assertValidationScenario,
  loadReleaseValidationConfig,
  waitForRequest,
};
