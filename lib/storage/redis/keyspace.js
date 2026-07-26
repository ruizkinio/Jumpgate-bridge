"use strict";

const crypto = require("node:crypto");

const DEFAULT_KEY_PREFIX = "jg:v1";
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

function digestParts(kind, parts) {
  const hash = crypto.createHash("sha256");
  hash.update("jumpgate-redis-key:v1\0", "utf8");
  hash.update(kind, "utf8");
  for (const part of parts) {
    const value = String(part);
    hash.update("\0" + Buffer.byteLength(value, "utf8") + ":", "utf8");
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

class RedisKeyspace {
  constructor(prefix = DEFAULT_KEY_PREFIX) {
    if (typeof prefix !== "string" || !/^jg:v[1-9][0-9]*$/.test(prefix)) {
      throw new TypeError("Redis key prefix is invalid");
    }
    this.prefix = prefix;
  }

  key(kind, ...parts) {
    if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) {
      throw new TypeError("Redis key kind is invalid");
    }
    return this.prefix + ":" + kind + ":" + digestParts(kind, parts);
  }

  member(kind, ...parts) {
    if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) {
      throw new TypeError("Redis member kind is invalid");
    }
    return digestParts("member-" + kind, parts);
  }
}

module.exports = {
  DEFAULT_KEY_PREFIX,
  RedisKeyspace,
};
