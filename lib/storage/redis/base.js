"use strict";

const { assertPlainObject } = require("../repository-utils");
const { RedisKeyspace } = require("./keyspace");
const { RedisScriptRunner, assertStandalonePrimaryClient } = require("./script-runner");

function initializeRedisOptions(options) {
  const supplied = assertPlainObject(options, "Redis repository options");
  if (!supplied.client) throw new TypeError("Redis client is required");
  assertStandalonePrimaryClient(supplied.client);
  return {
    client: supplied.client,
    keyspace: supplied.keyspace || new RedisKeyspace(supplied.keyPrefix),
    scripts: supplied.scriptRunner || new RedisScriptRunner(supplied.client),
  };
}

function jsonStringify(value, name) {
  let encoded;
  let containsUnsafeNumber = false;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (typeof item === "number" && !Number.isSafeInteger(item)) {
        containsUnsafeNumber = true;
        throw new TypeError("unsafe JSON number");
      }
      return item;
    });
  } catch (_error) {
    if (containsUnsafeNumber) throw new TypeError(name + " contains a non-safe integer");
    throw new TypeError(name + " is not JSON serializable");
  }
  if (encoded === undefined) throw new TypeError(name + " is not JSON serializable");
  return encoded;
}

function jsonParse(value, name) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    throw new TypeError(name + " contains invalid JSON");
  }
}

module.exports = {
  initializeRedisOptions,
  jsonParse,
  jsonStringify,
};
