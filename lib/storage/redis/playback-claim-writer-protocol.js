"use strict";

const { RedisKeyspace } = require("./keyspace");

const CLAIM_WRITER_ROLLOUT_ENV = "JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE";
const PROTOCOL_KEY_KIND = "playback-claim-writer-protocol";
const PROTOCOL_KEY_SCOPE = "global";
const SUPPORTED_ACTIONS = Object.freeze([
  "status",
  "initialize-v5",
  "advance-v6",
  "apply-env",
]);
const USAGE =
  "usage: node scripts/playback-claim-writer-protocol.js " + SUPPORTED_ACTIONS.join("|");

const TYPE_PREAMBLE = [
  'local keyTypeReply = redis.call("TYPE", KEYS[1])',
  "local keyType = keyTypeReply",
  'if type(keyTypeReply) == "table" then',
  '  keyType = keyTypeReply["ok"]',
  "end",
].join("\n");

const STATUS_LUA = [
  "-- jg-script:playback-claim-writer-protocol-status-v1",
  TYPE_PREAMBLE,
  'if keyType == "none" then',
  '  return { "missing", "", "" }',
  "end",
  'if keyType ~= "string" then',
  '  return { "wrong_type", "", "" }',
  "end",
  'local current = redis.call("GET", KEYS[1])',
  'if current == "5" or current == "6" then',
  '  return { "ready", current, "" }',
  "end",
  'return { "malformed", "", "" }',
].join("\n");

const INITIALIZE_V5_LUA = [
  "-- jg-script:playback-claim-writer-protocol-initialize-v5-v1",
  TYPE_PREAMBLE,
  'if keyType == "none" then',
  '  redis.call("SET", KEYS[1], "5")',
  '  return { "initialized", "5", "" }',
  "end",
  'if keyType ~= "string" then',
  '  return { "rejected", "", "wrong_type" }',
  "end",
  'local current = redis.call("GET", KEYS[1])',
  'if current == "5" then',
  '  return { "unchanged", "5", "" }',
  "end",
  'if current == "6" then',
  '  return { "rejected", "6", "downgrade" }',
  "end",
  'return { "rejected", "", "malformed" }',
].join("\n");

const ADVANCE_V6_LUA = [
  "-- jg-script:playback-claim-writer-protocol-advance-v6-v1",
  TYPE_PREAMBLE,
  'if keyType == "none" then',
  '  return { "rejected", "", "missing" }',
  "end",
  'if keyType ~= "string" then',
  '  return { "rejected", "", "wrong_type" }',
  "end",
  'local current = redis.call("GET", KEYS[1])',
  'if current == "5" then',
  '  redis.call("SET", KEYS[1], "6")',
  '  return { "advanced", "6", "" }',
  "end",
  'if current == "6" then',
  '  return { "unchanged", "6", "" }',
  "end",
  'return { "rejected", "", "malformed" }',
].join("\n");

const LUA = Object.freeze({
  advanceV6: ADVANCE_V6_LUA,
  initializeV5: INITIALIZE_V5_LUA,
  status: STATUS_LUA,
});

class PlaybackClaimWriterProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlaybackClaimWriterProtocolError";
    this.code = code;
  }
}

function protocolError(code, message) {
  return new PlaybackClaimWriterProtocolError(code, message);
}

function invalidReply() {
  return protocolError(
    "playback_claim_writer_protocol_invalid_reply",
    "Redis returned an invalid playback claim writer protocol reply"
  );
}

function deriveProtocolKey(keyspace = new RedisKeyspace()) {
  if (!keyspace || typeof keyspace.key !== "function") {
    throw new TypeError("RedisKeyspace is required");
  }
  return keyspace.key(PROTOCOL_KEY_KIND, PROTOCOL_KEY_SCOPE);
}

function parseArguments(argv) {
  if (
    !Array.isArray(argv) ||
    argv.length !== 1 ||
    typeof argv[0] !== "string" ||
    !SUPPORTED_ACTIONS.includes(argv[0])
  ) {
    throw protocolError("playback_claim_writer_protocol_invalid_arguments", USAGE);
  }
  return argv[0];
}

function resolveApplyEnvAction(env = process.env) {
  const mode = env && env[CLAIM_WRITER_ROLLOUT_ENV];
  if (mode === "transition") return "initialize-v5";
  if (mode === "v6") return "advance-v6";
  throw protocolError(
    "playback_claim_writer_protocol_invalid_rollout_mode",
    CLAIM_WRITER_ROLLOUT_ENV + " must be transition or v6"
  );
}

function resolveAction(action, env) {
  if (!SUPPORTED_ACTIONS.includes(action)) {
    throw protocolError("playback_claim_writer_protocol_invalid_arguments", USAGE);
  }
  return action === "apply-env" ? resolveApplyEnvAction(env) : action;
}

function readReplyTuple(reply) {
  if (
    !Array.isArray(reply) ||
    reply.length !== 3 ||
    reply.some((part) => typeof part !== "string")
  ) {
    throw invalidReply();
  }
  return reply;
}

function normalizeStatusReply(reply) {
  const [state, version, reason] = readReplyTuple(reply);
  if (reason !== "") throw invalidReply();
  if (state === "ready" && (version === "5" || version === "6")) {
    return Object.freeze({ action: "status", changed: false, state, version });
  }
  if (["missing", "malformed", "wrong_type"].includes(state) && version === "") {
    return Object.freeze({ action: "status", changed: false, state, version: null });
  }
  throw invalidReply();
}

function rejectionError(action, version, reason) {
  if (reason === "wrong_type" && version === "") {
    return protocolError(
      "playback_claim_writer_protocol_wrong_type",
      "playback claim writer protocol key has the wrong Redis type"
    );
  }
  if (reason === "malformed" && version === "") {
    return protocolError(
      "playback_claim_writer_protocol_malformed",
      "stored playback claim writer protocol is malformed"
    );
  }
  if (action === "initialize-v5" && reason === "downgrade" && version === "6") {
    return protocolError(
      "playback_claim_writer_protocol_downgrade",
      "initialize-v5 cannot downgrade playback claim writer protocol 6"
    );
  }
  if (action === "advance-v6" && reason === "missing" && version === "") {
    return protocolError(
      "playback_claim_writer_protocol_missing",
      "advance-v6 requires an existing playback claim writer protocol 5"
    );
  }
  return invalidReply();
}

function normalizeMutationReply(action, reply) {
  const [state, version, reason] = readReplyTuple(reply);
  if (state === "rejected") throw rejectionError(action, version, reason);
  if (reason !== "") throw invalidReply();

  if (action === "initialize-v5") {
    if (state === "initialized" && version === "5") {
      return Object.freeze({ action, changed: true, state, version });
    }
    if (state === "unchanged" && version === "5") {
      return Object.freeze({ action, changed: false, state, version });
    }
  }

  if (action === "advance-v6") {
    if (state === "advanced" && version === "6") {
      return Object.freeze({ action, changed: true, state, version });
    }
    if (state === "unchanged" && version === "6") {
      return Object.freeze({ action, changed: false, state, version });
    }
  }
  throw invalidReply();
}

async function evaluate(client, source, keyspace) {
  if (!client || typeof client.eval !== "function") {
    throw new TypeError("Redis client must provide eval()");
  }
  return client.eval(source, {
    keys: [deriveProtocolKey(keyspace)],
    arguments: [],
  });
}

async function getStatus(client, options = {}) {
  return normalizeStatusReply(await evaluate(client, STATUS_LUA, options.keyspace));
}

async function initializeV5(client, options = {}) {
  return normalizeMutationReply(
    "initialize-v5",
    await evaluate(client, INITIALIZE_V5_LUA, options.keyspace)
  );
}

async function advanceV6(client, options = {}) {
  return normalizeMutationReply(
    "advance-v6",
    await evaluate(client, ADVANCE_V6_LUA, options.keyspace)
  );
}

async function runAction(client, action, options = {}) {
  const effectiveAction = resolveAction(action, options.env || process.env);
  let result;
  if (effectiveAction === "status") result = await getStatus(client, options);
  else if (effectiveAction === "initialize-v5") result = await initializeV5(client, options);
  else result = await advanceV6(client, options);

  if (action !== "apply-env") return result;
  return Object.freeze({
    ...result,
    action: "apply-env",
    appliedAction: effectiveAction,
  });
}

async function closeRedisClient(client, connected) {
  if (!client) return;
  if (connected) {
    if (typeof client.quit === "function") {
      await client.quit();
      return;
    }
    if (typeof client.close === "function") {
      await client.close();
      return;
    }
    throw new TypeError("Redis client must provide quit() or close()");
  }

  if (!client.isOpen) return;
  if (typeof client.destroy === "function") {
    client.destroy();
    return;
  }
  if (typeof client.disconnect === "function") {
    client.disconnect();
    return;
  }
  if (typeof client.close === "function") await client.close();
}

async function runCli(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const action = parseArguments(argv);

  // Resolve deployment intent before opening a socket.
  if (action === "apply-env") resolveApplyEnvAction(env);
  const redisUrl = env && env.REDIS_URL;
  if (typeof redisUrl !== "string" || redisUrl.length === 0) {
    throw protocolError("playback_claim_writer_protocol_redis_url_required", "REDIS_URL is required");
  }

  const createClient = options.createClient || require("redis").createClient;
  if (typeof createClient !== "function") throw new TypeError("createClient must be a function");
  const client = createClient({ url: redisUrl });
  if (!client || typeof client.connect !== "function") {
    throw new TypeError("Redis client must provide connect()");
  }
  if (typeof client.on === "function") client.on("error", () => {});

  let connected = false;
  let operationError = null;
  let result;
  try {
    await client.connect();
    connected = true;
    result = await runAction(client, action, {
      env,
      keyspace: options.keyspace,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await closeRedisClient(client, connected);
    } catch (_closeError) {
      if (!operationError) {
        throw protocolError(
          "playback_claim_writer_protocol_close_failed",
          "Redis connection did not close cleanly"
        );
      }
    }
  }
  stdout.write(JSON.stringify(result) + "\n");
  return result;
}

function reportCliError(error, stderr = process.stderr, processObject = process) {
  const code =
    error &&
    typeof error.code === "string" &&
    /^playback_claim_writer_protocol_[a-z0-9_]+$/.test(error.code)
      ? " [" + error.code + "]"
      : "";
  stderr.write("playback claim writer protocol command failed" + code + "\n");
  processObject.exitCode = 1;
}

module.exports = {
  ADVANCE_V6_LUA,
  advancePlaybackClaimWriterProtocolV6: advanceV6,
  advanceV6,
  applyEnv: (client, env = process.env, options = {}) =>
    runAction(client, "apply-env", { ...options, env }),
  CLAIM_WRITER_ROLLOUT_ENV,
  closeRedisClient,
  deriveProtocolKey,
  getPlaybackClaimWriterProtocolStatus: getStatus,
  getStatus,
  INITIALIZE_V5_LUA,
  initializePlaybackClaimWriterProtocolV5: initializeV5,
  initializeV5,
  LUA,
  parseArguments,
  PlaybackClaimWriterProtocolError,
  PROTOCOL_KEY_KIND,
  PROTOCOL_KEY_SCOPE,
  reportCliError,
  resolveApplyEnvAction,
  runAction,
  runCli,
  runPlaybackClaimWriterProtocolAction: runAction,
  runPlaybackClaimWriterProtocolCli: runCli,
  STATUS_LUA,
  SUPPORTED_ACTIONS,
  USAGE,
};

if (require.main === module) {
  runCli().catch(reportCliError);
}
