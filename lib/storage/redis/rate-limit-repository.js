"use strict";

const { assertBoundedString, assertPositiveInteger, codedError } = require("../repository-utils");
const { initializeRedisOptions } = require("./base");
const { asArray, asInteger, asString } = require("./reply");

class RedisRateLimitRepository {
  constructor(options = {}) {
    const shared = initializeRedisOptions(options);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._keys = shared.keyspace;
    this._scripts = shared.scripts;
    this._tokens = options.tokenService;
    this._maxEntries = options.maxEntries ?? 100000;
    assertPositiveInteger(this._maxEntries, "max rate limit entries", 1000000);
    this._globalKey = this._keys.key("rate-limit-global", "active");
  }

  async consume(scope, key, limit, windowMs, cost = 1) {
    const scopedScope = assertBoundedString(scope, "rate limit scope", 128);
    const scopedKey = assertBoundedString(key, "rate limit key", 512);
    const boundedLimit = assertPositiveInteger(limit, "rate limit", 1000000);
    const boundedWindow = assertPositiveInteger(windowMs, "rate limit window", 24 * 60 * 60 * 1000);
    const boundedCost = assertPositiveInteger(cost, "rate limit cost", boundedLimit);
    const keyHash = this._tokens.hashOpaque(
      "rate-limit-key",
      JSON.stringify([scopedScope, scopedKey]),
      1024
    );
    const reply = asArray(
      await this._scripts.run(
        "rateLimitConsume",
        [this._keys.key("rate-limit-record", keyHash), this._globalKey],
        [boundedLimit, boundedWindow, boundedCost, this._maxEntries]
      ),
      "rateLimitConsume"
    );
    const status = asString(reply[0], "rate limit status");
    if (status === "capacity") throw codedError("rate_limit_capacity", "rate limit capacity reached");
    if (status === "policy_mismatch") {
      throw codedError("rate_limit_policy_mismatch", "rate limit policy changed inside an active window");
    }
    if (status !== "consumed") throw new Error("unexpected rate limit status: " + status);
    return {
      allowed: asString(reply[1], "rate limit allowed flag") === "1",
      remaining: asInteger(reply[2], "rate limit remaining count"),
      resetAt: asInteger(reply[3], "rate limit reset time"),
    };
  }

  async reset(scope, key) {
    const scopedScope = assertBoundedString(scope, "rate limit scope", 128);
    const scopedKey = assertBoundedString(key, "rate limit key", 512);
    const keyHash = this._tokens.hashOpaque(
      "rate-limit-key",
      JSON.stringify([scopedScope, scopedKey]),
      1024
    );
    const reply = asArray(
      await this._scripts.run(
        "rateLimitReset",
        [this._keys.key("rate-limit-record", keyHash), this._globalKey]
      ),
      "rateLimitReset"
    );
    return asString(reply[0], "rate limit reset status") === "reset";
  }
}

module.exports = {
  RedisRateLimitRepository,
};
