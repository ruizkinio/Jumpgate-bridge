"use strict";

const { SCRIPT_DEFINITIONS } = require("./scripts");

function isClusterClient(client) {
  return Boolean(
    client &&
      (client.isCluster === true ||
        typeof client.getSlotMaster === "function" ||
        typeof client.nodeClient === "function" ||
        typeof client.nodes === "function")
  );
}

function assertStandalonePrimaryClient(client) {
  if (!client || typeof client !== "object") throw new TypeError("Redis client is required");
  if (isClusterClient(client)) {
    throw new TypeError(
      "Redis Cluster clients are not supported; a standalone primary client is required"
    );
  }
  return client;
}

function isNoScriptError(error) {
  return Boolean(
    error &&
      (error.code === "NOSCRIPT" ||
        error.name === "NoScriptError" ||
        /(?:^|\s)NOSCRIPT(?:\s|$)/i.test(String(error.message || error)))
  );
}

function normalizeList(values, name) {
  if (!Array.isArray(values)) throw new TypeError(name + " must be an array");
  return values.map((value) => {
    if (value === null || value === undefined) throw new TypeError(name + " contains an invalid value");
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new TypeError(name + " contains a non-safe integer");
    }
    return typeof value === "string" ? value : String(value);
  });
}

function abortSignalFromOptions(options) {
  if (options === undefined) return null;
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Redis script options are invalid");
  }
  const signal = options.signal;
  if (signal === undefined) return null;
  if (
    !signal ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("Redis script signal is invalid");
  }
  return signal;
}

class RedisScriptRunner {
  constructor(client, scripts = SCRIPT_DEFINITIONS) {
    assertStandalonePrimaryClient(client);
    if (typeof client.eval !== "function" && typeof client.sendCommand !== "function") {
      throw new TypeError("Redis client must provide eval() or sendCommand()");
    }
    this.client = client;
    this.scripts = scripts;
  }

  async run(name, keys = [], args = [], options = {}) {
    const definition = this.scripts[name];
    if (!definition) throw new TypeError("unknown Redis script: " + name);
    const normalizedKeys = normalizeList(keys, "script keys");
    const normalizedArgs = normalizeList(args, "script arguments");
    const signal = abortSignalFromOptions(options);
    let client = this.client;
    if (signal) {
      if (typeof client.withAbortSignal !== "function") {
        throw new TypeError("Redis client must provide withAbortSignal() for abortable commands");
      }
      client = client.withAbortSignal(signal);
    }

    if (typeof client.evalSha === "function") {
      try {
        return await client.evalSha(definition.sha, {
          keys: normalizedKeys,
          arguments: normalizedArgs,
        });
      } catch (error) {
        if (!isNoScriptError(error)) throw error;
      }
    } else if (typeof client.sendCommand === "function") {
      try {
        return await client.sendCommand([
          "EVALSHA",
          definition.sha,
          String(normalizedKeys.length),
          ...normalizedKeys,
          ...normalizedArgs,
        ]);
      } catch (error) {
        if (!isNoScriptError(error)) throw error;
      }
    }

    if (typeof client.eval === "function") {
      return client.eval(definition.source, {
        keys: normalizedKeys,
        arguments: normalizedArgs,
      });
    }
    return client.sendCommand([
      "EVAL",
      definition.source,
      String(normalizedKeys.length),
      ...normalizedKeys,
      ...normalizedArgs,
    ]);
  }

  async timeMs(options = {}) {
    const reply = await this.run("time", [], [], options);
    const value = Number(Array.isArray(reply) ? reply[0] : reply);
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Redis TIME returned an invalid value");
    return value;
  }
}

module.exports = {
  RedisScriptRunner,
  assertStandalonePrimaryClient,
  isClusterClient,
  isNoScriptError,
};
