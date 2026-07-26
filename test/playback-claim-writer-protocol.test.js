"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { RedisKeyspace } = require("../lib/storage/redis/keyspace");
const {
  ADVANCE_V6_LUA,
  advanceV6,
  applyEnv,
  CLAIM_WRITER_ROLLOUT_ENV,
  deriveProtocolKey,
  getStatus,
  INITIALIZE_V5_LUA,
  initializeV5,
  runCli,
  STATUS_LUA,
} = require("../scripts/playback-claim-writer-protocol");

const EXPECTED_KEY = new RedisKeyspace().key(
  "playback-claim-writer-protocol",
  "global"
);

class FakeRedis {
  constructor(options = {}) {
    this.type = options.type || "none";
    this.value = options.value ?? null;
    this.calls = [];
    this.hasReplyOverride = Object.prototype.hasOwnProperty.call(options, "reply");
    this.reply = options.reply;
  }

  async eval(source, options) {
    this.calls.push({ source, options });
    if (this.hasReplyOverride) return this.reply;

    if (source === STATUS_LUA) {
      if (this.type === "none") return ["missing", "", ""];
      if (this.type !== "string") return ["wrong_type", "", ""];
      if (this.value === "5" || this.value === "6") return ["ready", this.value, ""];
      return ["malformed", "", ""];
    }

    if (source === INITIALIZE_V5_LUA) {
      if (this.type === "none") {
        this.type = "string";
        this.value = "5";
        return ["initialized", "5", ""];
      }
      if (this.type !== "string") return ["rejected", "", "wrong_type"];
      if (this.value === "5") return ["unchanged", "5", ""];
      if (this.value === "6") return ["rejected", "6", "downgrade"];
      return ["rejected", "", "malformed"];
    }

    if (source === ADVANCE_V6_LUA) {
      if (this.type === "none") return ["rejected", "", "missing"];
      if (this.type !== "string") return ["rejected", "", "wrong_type"];
      if (this.value === "5") {
        this.value = "6";
        return ["advanced", "6", ""];
      }
      if (this.value === "6") return ["unchanged", "6", ""];
      return ["rejected", "", "malformed"];
    }

    throw new Error("unexpected Lua source");
  }
}

function assertOneAtomicCall(redis, expectedSource) {
  assert.equal(redis.calls.length, 1);
  assert.equal(redis.calls[0].source, expectedSource);
  assert.deepEqual(redis.calls[0].options, {
    keys: [EXPECTED_KEY],
    arguments: [],
  });
}

async function rejectsWithCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test("protocol key uses RedisKeyspace with a hashed global component", () => {
  assert.equal(deriveProtocolKey(), EXPECTED_KEY);
  assert.match(EXPECTED_KEY, /^jg:v1:playback-claim-writer-protocol:[a-f0-9]{64}$/);
  assert.equal(EXPECTED_KEY.includes(":global"), false);
});

test("Lua mutations contain only their intended protocol write", () => {
  const writes = (source) => [
    ...source.matchAll(/redis\.call\("SET", KEYS\[1\], "([^"]+)"\)/g),
  ].map((match) => match[1]);

  assert.deepEqual(writes(STATUS_LUA), []);
  assert.deepEqual(writes(INITIALIZE_V5_LUA), ["5"]);
  assert.deepEqual(writes(ADVANCE_V6_LUA), ["6"]);
});

test("status reports missing, v5, v6, malformed, and wrong-type states without mutation", async () => {
  const cases = [
    [{ type: "none" }, { state: "missing", version: null }],
    [{ type: "string", value: "5" }, { state: "ready", version: "5" }],
    [{ type: "string", value: "6" }, { state: "ready", version: "6" }],
    [{ type: "string", value: "future" }, { state: "malformed", version: null }],
    [{ type: "hash" }, { state: "wrong_type", version: null }],
  ];

  for (const [input, expected] of cases) {
    const redis = new FakeRedis(input);
    const result = await getStatus(redis);
    assert.deepEqual(result, {
      action: "status",
      changed: false,
      ...expected,
    });
    assert.deepEqual({ type: redis.type, value: redis.value }, {
      type: input.type,
      value: input.value ?? null,
    });
    assertOneAtomicCall(redis, STATUS_LUA);
  }
});

test("initialize-v5 changes only missing to 5 and is idempotent at 5", async () => {
  const missing = new FakeRedis();
  assert.deepEqual(await initializeV5(missing), {
    action: "initialize-v5",
    changed: true,
    state: "initialized",
    version: "5",
  });
  assert.equal(missing.type, "string");
  assert.equal(missing.value, "5");
  assertOneAtomicCall(missing, INITIALIZE_V5_LUA);

  const current = new FakeRedis({ type: "string", value: "5" });
  assert.deepEqual(await initializeV5(current), {
    action: "initialize-v5",
    changed: false,
    state: "unchanged",
    version: "5",
  });
  assert.equal(current.value, "5");
  assertOneAtomicCall(current, INITIALIZE_V5_LUA);
});

test("initialize-v5 rejects downgrade, malformed data, and wrong Redis types", async () => {
  const cases = [
    [
      new FakeRedis({ type: "string", value: "6" }),
      "playback_claim_writer_protocol_downgrade",
      "6",
    ],
    [
      new FakeRedis({ type: "string", value: "05" }),
      "playback_claim_writer_protocol_malformed",
      "05",
    ],
    [new FakeRedis({ type: "set" }), "playback_claim_writer_protocol_wrong_type", null],
  ];

  for (const [redis, code, unchanged] of cases) {
    await rejectsWithCode(() => initializeV5(redis), code);
    assert.equal(redis.value, unchanged);
    assertOneAtomicCall(redis, INITIALIZE_V5_LUA);
  }
});

test("advance-v6 changes only 5 to 6 and is idempotent at 6", async () => {
  const current = new FakeRedis({ type: "string", value: "5" });
  assert.deepEqual(await advanceV6(current), {
    action: "advance-v6",
    changed: true,
    state: "advanced",
    version: "6",
  });
  assert.equal(current.value, "6");
  assertOneAtomicCall(current, ADVANCE_V6_LUA);

  const advanced = new FakeRedis({ type: "string", value: "6" });
  assert.deepEqual(await advanceV6(advanced), {
    action: "advance-v6",
    changed: false,
    state: "unchanged",
    version: "6",
  });
  assert.equal(advanced.value, "6");
  assertOneAtomicCall(advanced, ADVANCE_V6_LUA);
});

test("advance-v6 rejects missing, malformed data, and wrong Redis types", async () => {
  const cases = [
    [new FakeRedis(), "playback_claim_writer_protocol_missing", "none", null],
    [
      new FakeRedis({ type: "string", value: "7" }),
      "playback_claim_writer_protocol_malformed",
      "string",
      "7",
    ],
    [new FakeRedis({ type: "list" }), "playback_claim_writer_protocol_wrong_type", "list", null],
  ];

  for (const [redis, code, type, value] of cases) {
    await rejectsWithCode(() => advanceV6(redis), code);
    assert.equal(redis.type, type);
    assert.equal(redis.value, value);
    assertOneAtomicCall(redis, ADVANCE_V6_LUA);
  }
});

test("invalid Redis replies fail closed", async () => {
  for (const reply of ["OK", ["initialized", "6", ""], ["ready", "5"], ["rejected", 6, "downgrade"]]) {
    const redis = new FakeRedis({ reply });
    await rejectsWithCode(
      () => initializeV5(redis),
      "playback_claim_writer_protocol_invalid_reply"
    );
    assertOneAtomicCall(redis, INITIALIZE_V5_LUA);
  }
});

test("apply-env maps transition to initialize-v5 and v6 to advance-v6", async () => {
  const transition = new FakeRedis();
  assert.deepEqual(
    await applyEnv(transition, { [CLAIM_WRITER_ROLLOUT_ENV]: "transition" }),
    {
      action: "apply-env",
      appliedAction: "initialize-v5",
      changed: true,
      state: "initialized",
      version: "5",
    }
  );
  assertOneAtomicCall(transition, INITIALIZE_V5_LUA);

  const v6 = new FakeRedis({ type: "string", value: "5" });
  assert.deepEqual(await applyEnv(v6, { [CLAIM_WRITER_ROLLOUT_ENV]: "v6" }), {
    action: "apply-env",
    appliedAction: "advance-v6",
    changed: true,
    state: "advanced",
    version: "6",
  });
  assertOneAtomicCall(v6, ADVANCE_V6_LUA);

  const invalid = new FakeRedis();
  await rejectsWithCode(
    () => applyEnv(invalid, { [CLAIM_WRITER_ROLLOUT_ENV]: "V6" }),
    "playback_claim_writer_protocol_invalid_rollout_mode"
  );
  assert.equal(invalid.calls.length, 0);
});

test("CLI validates arguments and REDIS_URL before creating a client", async () => {
  let createCalls = 0;
  const createClient = () => {
    createCalls += 1;
    throw new Error("must not create a client");
  };
  const stdout = { write() {} };

  for (const argv of [[], ["unknown"], ["status", "extra"]]) {
    await rejectsWithCode(
      () => runCli({ argv, createClient, env: { REDIS_URL: "redis://unused" }, stdout }),
      "playback_claim_writer_protocol_invalid_arguments"
    );
  }
  await rejectsWithCode(
    () => runCli({ argv: ["status"], createClient, env: {}, stdout }),
    "playback_claim_writer_protocol_redis_url_required"
  );
  await rejectsWithCode(
    () =>
      runCli({
        argv: ["apply-env"],
        createClient,
        env: { REDIS_URL: "redis://unused" },
        stdout,
      }),
    "playback_claim_writer_protocol_invalid_rollout_mode"
  );
  assert.equal(createCalls, 0);
});

test("CLI connects, prints non-secret status, and closes the Redis client", async () => {
  const redis = new FakeRedis();
  const secretUrl = "redis://bridge-user:super-secret@redis.internal:6379/0";
  const writes = [];
  let connectCalls = 0;
  let quitCalls = 0;
  let errorListenerAttached = false;
  let createOptions;
  const client = {
    eval: redis.eval.bind(redis),
    async connect() {
      connectCalls += 1;
    },
    on(event) {
      if (event === "error") errorListenerAttached = true;
    },
    async quit() {
      quitCalls += 1;
    },
  };

  const result = await runCli({
    argv: ["initialize-v5"],
    createClient(options) {
      createOptions = options;
      return client;
    },
    env: { REDIS_URL: secretUrl },
    stdout: { write(value) { writes.push(value); } },
  });

  assert.deepEqual(createOptions, { url: secretUrl });
  assert.equal(connectCalls, 1);
  assert.equal(quitCalls, 1);
  assert.equal(errorListenerAttached, true);
  assert.deepEqual(JSON.parse(writes.join("")), result);
  assert.equal(writes.join("").includes("super-secret"), false);
  assert.equal(writes.join("").includes("redis.internal"), false);
  assert.equal(writes.join("").includes(EXPECTED_KEY), false);
  assertOneAtomicCall(redis, INITIALIZE_V5_LUA);
});

test("CLI still closes after a rejected mutation", async () => {
  const redis = new FakeRedis();
  let quitCalls = 0;
  const client = {
    eval: redis.eval.bind(redis),
    async connect() {},
    on() {},
    async quit() {
      quitCalls += 1;
    },
  };

  await rejectsWithCode(
    () =>
      runCli({
        argv: ["advance-v6"],
        createClient: () => client,
        env: { REDIS_URL: "redis://unused" },
        stdout: { write() { throw new Error("must not print rejected status"); } },
      }),
    "playback_claim_writer_protocol_missing"
  );
  assert.equal(quitCalls, 1);
  assertOneAtomicCall(redis, ADVANCE_V6_LUA);
});
