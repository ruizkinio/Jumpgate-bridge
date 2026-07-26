"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createClient } = require("redis");

const { RedisKeyspace } = require("../lib/storage/redis/keyspace");
const {
  CLAIM_WRITER_ROLLOUT_ENV,
  advanceV6,
  deriveProtocolKey,
  getStatus,
  initializeV5,
  runCli,
} = require("../lib/storage/redis/playback-claim-writer-protocol");

const REDIS_URL = process.env.REDIS_URL;
const redisTest = REDIS_URL ? test : test.skip;

function uniqueKeyspace() {
  return new RedisKeyspace("jg:v" + Date.now() + process.pid);
}

async function connectedClient() {
  const client = createClient({ url: REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  return client;
}

redisTest("REDIS_URL atomically enforces and applies the playback claim writer protocol", async (t) => {
  const keyspace = uniqueKeyspace();
  const key = deriveProtocolKey(keyspace);
  const client = await connectedClient();
  t.after(async () => {
    if (!client.isOpen) await client.connect();
    await client.del(key);
    await client.quit();
  });

  assert.deepEqual(await getStatus(client, { keyspace }), {
    action: "status",
    changed: false,
    state: "missing",
    version: null,
  });
  assert.equal((await initializeV5(client, { keyspace })).version, "5");
  assert.equal((await initializeV5(client, { keyspace })).changed, false);
  assert.equal((await advanceV6(client, { keyspace })).version, "6");
  assert.equal((await advanceV6(client, { keyspace })).changed, false);
  await assert.rejects(
    () => initializeV5(client, { keyspace }),
    (error) => error.code === "playback_claim_writer_protocol_downgrade"
  );

  await client.del(key);
  await client.set(key, "malformed");
  assert.equal((await getStatus(client, { keyspace })).state, "malformed");
  await assert.rejects(
    () => advanceV6(client, { keyspace }),
    (error) => error.code === "playback_claim_writer_protocol_malformed"
  );

  await client.del(key);
  await client.hSet(key, "field", "value");
  assert.equal((await getStatus(client, { keyspace })).state, "wrong_type");
  await assert.rejects(
    () => initializeV5(client, { keyspace }),
    (error) => error.code === "playback_claim_writer_protocol_wrong_type"
  );

  await client.del(key);
  let output = "";
  const stdout = { write: (value) => { output += value; } };
  const baseEnvironment = { REDIS_URL };
  await runCli({
    argv: ["apply-env"],
    env: { ...baseEnvironment, [CLAIM_WRITER_ROLLOUT_ENV]: "transition" },
    keyspace,
    stdout,
  });
  await runCli({
    argv: ["apply-env"],
    env: { ...baseEnvironment, [CLAIM_WRITER_ROLLOUT_ENV]: "v6" },
    keyspace,
    stdout,
  });
  assert.equal((await getStatus(client, { keyspace })).version, "6");
  assert.equal(output.includes(REDIS_URL), false);
  assert.equal(output.trim().split("\n").length, 2);
});
