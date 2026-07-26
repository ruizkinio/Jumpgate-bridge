"use strict";

const {
  assertBoundedString,
  assertIdentifier,
  assertPositiveInteger,
  codedError,
} = require("../repository-utils");
const { initializeRedisOptions } = require("./base");
const { asArray, asInteger, asString } = require("./reply");

class RedisLeaseRepository {
  constructor(options = {}) {
    const shared = initializeRedisOptions(options);
    if (!options.tokenService) throw new TypeError("tokenService is required");
    this._keys = shared.keyspace;
    this._scripts = shared.scripts;
    this._tokens = options.tokenService;
    this._maxLeases = options.maxLeases ?? 10000;
    assertPositiveInteger(this._maxLeases, "maxLeases", 1000000);
    this._globalKey = this._keys.key("lease-global", "active");
  }

  async acquire(scope, key, owner, ttlMs) {
    const scopedScope = assertBoundedString(scope, "lease scope", 128);
    const scopedKey = assertBoundedString(key, "lease key", 512);
    const scopedOwner = assertIdentifier(owner, "lease owner");
    const duration = assertPositiveInteger(ttlMs, "lease ttl", 5 * 60 * 1000);
    const keyHash = this._keyHash(scopedScope, scopedKey);
    const recordKey = this._recordKey(keyHash);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lease = this._tokens.issue("lease", 24);
      const reply = asArray(
        await this._scripts.run(
          "leaseAcquire",
          [recordKey, this._tokenKey(lease.tokenHash), this._globalKey],
          [scopedOwner, lease.tokenHash, duration, this._maxLeases]
        ),
        "leaseAcquire"
      );
      const status = asString(reply[0], "lease acquire status");
      if (status === "acquired") {
        return {
          acquired: true,
          leaseToken: lease.token,
          expiresAt: asInteger(reply[1], "lease expiry"),
        };
      }
      if (status === "busy") return { acquired: false, expiresAt: asInteger(reply[1], "lease expiry") };
      if (status === "capacity") throw codedError("lease_capacity", "lease capacity reached");
      if (status !== "token_collision") throw new Error("unexpected lease acquire status: " + status);
    }
    throw codedError("lease_token_collision", "could not allocate a unique lease token");
  }

  async renew(scope, key, leaseToken, ttlMs) {
    const scopedScope = assertBoundedString(scope, "lease scope", 128);
    const scopedKey = assertBoundedString(key, "lease key", 512);
    const duration = assertPositiveInteger(ttlMs, "lease ttl", 5 * 60 * 1000);
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("lease", leaseToken);
    } catch (_error) {
      return { renewed: false };
    }
    const reply = asArray(
      await this._scripts.run(
        "leaseRenew",
        [this._recordKey(this._keyHash(scopedScope, scopedKey)), this._tokenKey(tokenHash), this._globalKey],
        [tokenHash, duration]
      ),
      "leaseRenew"
    );
    const status = asString(reply[0], "lease renew status");
    if (status === "not_owner") return { renewed: false };
    if (status !== "renewed") throw new Error("unexpected lease renew status: " + status);
    return { renewed: true, expiresAt: asInteger(reply[1], "lease expiry") };
  }

  async release(scope, key, leaseToken) {
    const scopedScope = assertBoundedString(scope, "lease scope", 128);
    const scopedKey = assertBoundedString(key, "lease key", 512);
    let tokenHash;
    try {
      tokenHash = this._tokens.hashToken("lease", leaseToken);
    } catch (_error) {
      return false;
    }
    const reply = asArray(
      await this._scripts.run(
        "leaseRelease",
        [this._recordKey(this._keyHash(scopedScope, scopedKey)), this._tokenKey(tokenHash), this._globalKey],
        [tokenHash]
      ),
      "leaseRelease"
    );
    return asString(reply[0], "lease release status") === "released";
  }

  _keyHash(scope, key) {
    return this._tokens.hashOpaque("lease-key", JSON.stringify([scope, key]), 1024);
  }

  _recordKey(keyHash) {
    return this._keys.key("lease-record", keyHash);
  }

  _tokenKey(tokenHash) {
    return this._keys.key("lease-token", tokenHash);
  }
}

module.exports = {
  RedisLeaseRepository,
};
