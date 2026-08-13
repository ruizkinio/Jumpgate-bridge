"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const {
  RedisKeyspace,
  RedisScriptRunner,
  SCRIPT_DEFINITIONS,
  SCRIPT_FILES,
  createRedisTtlRepositories,
} = require("../lib/storage/redis");

test("Redis module loads without importing the redis package", () => {
  const repositoryRoot = path.join(__dirname, "..");
  const program = [
    'const Module = require("node:module");',
    "const original = Module._load;",
    "Module._load = function(request) {",
    '  if (request === "redis" || request.startsWith("@redis/")) throw new Error("redis import attempted");',
    "  return original.apply(this, arguments);",
    "};",
    'require("./lib/storage/redis");',
  ].join("\n");
  const child = spawnSync(process.execPath, ["-e", program], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

test("Redis keyspace hashes every dynamic component under jg:v1", () => {
  const keys = new RedisKeyspace();
  const secret = "profile-and-network-secret";
  const first = keys.key("rate-limit-record", secret);
  const second = keys.key("rate-limit-record", secret);
  const other = keys.key("rate-limit-record", secret + "-other");

  assert.match(first, /^jg:v1:rate-limit-record:[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.equal(first.includes(secret), false);
  assert.match(keys.member("playback-context", secret), /^[a-f0-9]{64}$/);
});

test("script definitions have Redis SHA1 digests and preserve atomic contract markers", () => {
  assert.equal(Object.keys(SCRIPT_DEFINITIONS).length, Object.keys(SCRIPT_FILES).length);
  assert.ok(Object.keys(SCRIPT_DEFINITIONS).length >= 24);
  for (const definition of Object.values(SCRIPT_DEFINITIONS)) {
    assert.equal(crypto.createHash("sha1").update(definition.source).digest("hex"), definition.sha);
    assert.doesNotMatch(definition.source, /redis\.call\(["']SCAN["']/i, definition.filename);
  }

  for (const name of ["pairingActivate", "pairingComplete", "pairingRedeem", "pairingCancel"]) {
    assert.match(SCRIPT_DEFINITIONS[name].source, /redis\.call\("TIME"\)/);
    assert.match(SCRIPT_DEFINITIONS[name].source, /redis\.call\("HSET"/);
  }
  assert.match(SCRIPT_DEFINITIONS.pairingActivate.source, /existingEnvelope/);
  assert.match(
    SCRIPT_DEFINITIONS.pairingActivate.source,
    /retryExpiresAt = math\.min\(expiresAt, now \+ tonumber\(ARGV\[6\]\)\)/
  );
  for (const name of [
    "pairingActivate",
    "pairingRecover",
    "pairingCompletePeek",
    "pairingComplete",
  ]) {
    const source = SCRIPT_DEFINITIONS[name].source;
    assert.match(source, /not expiresAt or expiresAt <= now/, name);
    assert.ok(
      source.indexOf("expiresAt <= now") < source.indexOf("retryExpiresAt <= now"),
      name + " must enforce the original expiry before the retry expiry"
    );
  }
  assert.match(SCRIPT_DEFINITIONS.pairingCompletePeek.source, /activationEnvelope/);
  assert.match(SCRIPT_DEFINITIONS.pairingComplete.source, /finalizationHash/);
  assert.match(SCRIPT_DEFINITIONS.pairingComplete.source, /envelope ~= ARGV\[4\]/);
  assert.match(SCRIPT_DEFINITIONS.pairingComplete.source, /"activationEnvelope", ARGV\[5\]/);
  assert.match(SCRIPT_DEFINITIONS.pairingComplete.source, /ARGV\[5\], digest/);
  assert.match(SCRIPT_DEFINITIONS.pairingRedeemPeek.source, /"ready"/);
  assert.match(SCRIPT_DEFINITIONS.pairingRedeemPeek.source, /"replay"/);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.pairingRedeemPeek.source, /"state", "consumed"/);
  assert.match(SCRIPT_DEFINITIONS.pairingRedeem.source, /envelope ~= ARGV\[3\]/);
  assert.match(SCRIPT_DEFINITIONS.pairingRedeem.source, /digest ~= ARGV\[4\]/);
  assert.match(SCRIPT_DEFINITIONS.pairingRedeem.source, /state == "consumed"/);
  assert.match(SCRIPT_DEFINITIONS.pairingRedeemPeek.source, /finalizationHash/);
  assert.match(SCRIPT_DEFINITIONS.pairingRedeem.source, /finalizationHash/);
  assert.doesNotMatch(
    SCRIPT_DEFINITIONS.pairingRedeem.source,
    /"state", "consumed"\)\s*redis\.call\("HDEL"/
  );
  assert.match(SCRIPT_DEFINITIONS.pairingIssue.source, /"state", "expired"/);
  assert.match(SCRIPT_DEFINITIONS.pairingIssue.source, /"LIMIT", 0, tonumber\(ARGV\[9\]\)/);
  assert.match(SCRIPT_DEFINITIONS.pairingIssue.source, /ARGV\[10\] ~= ""/);
  assert.match(SCRIPT_DEFINITIONS.pairingIssue.source, /"validationScenario", ARGV\[10\]/);
  assert.match(SCRIPT_DEFINITIONS.pairingValidation.source, /validationRateLimitClaimed/);
  assert.match(SCRIPT_DEFINITIONS.pairingValidation.source, /redis\.call\("TIME"\)/);
  assert.match(SCRIPT_DEFINITIONS.oauthConsumePeek.source, /"ready"/);
  assert.match(SCRIPT_DEFINITIONS.oauthConsumePeek.source, /payloadEnvelope/);
  assert.match(SCRIPT_DEFINITIONS.oauthConsume.source, /bindingHash/);
  assert.match(SCRIPT_DEFINITIONS.oauthConsume.source, /payloadEnvelope.*ARGV\[2\]/);
  assert.match(SCRIPT_DEFINITIONS.oauthConsume.source, /return \{ "changed" \}/);
  assert.match(SCRIPT_DEFINITIONS.oauthConsume.source, /redis\.call\("DEL", KEYS\[1\]\)/);
  assert.match(SCRIPT_DEFINITIONS.managementIssue.source, /global_capacity/);
  assert.match(SCRIPT_DEFINITIONS.managementIssue.source, /profile_capacity/);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.managementIssue.source, /ZPOP|EVICT/i);
  for (const [name, replayMarker] of [
    ["managementPairingIssue", 'local replayType = redis.call("TYPE", KEYS[5])'],
    ["managementPairingRecover", 'redis.call("HGET", KEYS[1], "status")'],
    ["managementPairingRevoke", 'redis.call("HGET", KEYS[1], "status")'],
  ]) {
    const source = SCRIPT_DEFINITIONS[name].source;
    assert.ok(
      source.indexOf('redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)') >= 0
    );
    assert.ok(
      source.indexOf('redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", now)') <
        source.indexOf(replayMarker)
    );
  }
  assert.ok(
    SCRIPT_DEFINITIONS.managementRevoke.source.indexOf(
      'redis.call("ZREM", KEYS[2], KEYS[1])'
    ) < SCRIPT_DEFINITIONS.managementRevoke.source.indexOf('return { "not_found" }')
  );
  assert.match(SCRIPT_DEFINITIONS.managementRevokeProfile.source, /ZCARD/);
  assert.match(SCRIPT_DEFINITIONS.managementRevokeProfile.source, /profileId ~= ARGV\[1\]/);
  assert.ok(
    SCRIPT_DEFINITIONS.managementRevokeProfile.source.indexOf('return { "state_collision" }') <
      SCRIPT_DEFINITIONS.managementRevokeProfile.source.indexOf('redis.call("DEL", sessionKey)')
  );
  assert.ok(
    SCRIPT_DEFINITIONS.managementRevokeProfile.source.indexOf("profileId ~= ARGV[1]") <
      SCRIPT_DEFINITIONS.managementRevokeProfile.source.indexOf('redis.call("SET", KEYS[3]')
  );
  assert.match(SCRIPT_DEFINITIONS.managementRevokeProfile.source, /revoked:/);
  assert.match(SCRIPT_DEFINITIONS.oauthIssue.source, /managementGeneration/);
  assert.match(SCRIPT_DEFINITIONS.oauthConsume.source, /profile_changed/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /deviceGenerationIndex/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /playback-claim-v5/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /authorityVersion\s*=\s*ARGV\[21\]/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /requestDigest\s*=\s*ARGV\[26\]/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaim.source,
    /previous\.requestDigest\s*~=\s*ARGV\[26\]/
  );
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaim.source,
    /previous\.sessionId\s*~=\s*ARGV\[6\]/
  );
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /"claim_request_conflict"/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaimV5Fenced.source,
    /local function jumpgate_playback_claim_v5\(KEYS, ARGV\)/
  );
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaimV5Fenced.source,
    /playbackClaimV5Keys\[index\] = KEYS\[index\]/
  );
  assert.doesNotMatch(
    SCRIPT_DEFINITIONS.playbackClaimV5Fenced.source,
    /table\.remove\(KEYS\)/
  );
  assert.match(SCRIPT_DEFINITIONS.playbackClaimV6.source, /playback-claim-v6/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaimV6.source, /activeAttemptKey/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaimV6.source,
    /activeAttemptOwned = not activeAttempt or activeAttempt == attemptKey/
  );
  assert.match(SCRIPT_DEFINITIONS.playbackClaimV6.source, /attemptFingerprintKey/);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackClaimV6.source, /attemptKey \.\. ":fingerprints"/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaimV6.source,
    /launchedAtMs < tonumber\(previous\.launchedAtMs\)/
  );
  assert.doesNotMatch(
    SCRIPT_DEFINITIONS.playbackClaimV6.source,
    /launchedAtMs <= tonumber\(previous\.launchedAtMs\)/
  );
  assert.match(SCRIPT_DEFINITIONS.playbackClaimV6.source, /ARGV\[27\]/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaim.source,
    /return \{ "claimed", status, ARGV\[6\] \}/
  );
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackClaim.source, /previous\.cleanupOwner\s*=/);
  assert.match(SCRIPT_DEFINITIONS.playbackAttemptBegin.source, /lease:/);
  assert.match(SCRIPT_DEFINITIONS.playbackAttemptBegin.source, /claim_request_conflict/);
  assert.match(SCRIPT_DEFINITIONS.playbackAttemptDisclose.source, /record\.state = "disclosed"/);
  assert.match(SCRIPT_DEFINITIONS.playbackAttemptAbandon.source, /playback_attempt_release_claim/);
  assert.match(SCRIPT_DEFINITIONS.playbackAttemptReconcile.source, /playback_attempt_lease_summary/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackAttemptBegin.source,
    /local function playback_preserve_max_expiry/
  );
  assert.match(SCRIPT_DEFINITIONS.playbackAttemptBegin.source, /redis\.call\("PEXPIRETIME", key\)/);
  assert.match(SCRIPT_DEFINITIONS.playbackAttemptBegin.source, /currentExpiresAtMs == -1/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackAttemptBegin.source,
    /playback_preserve_max_expiry\(KEYS\[4\], authorityExpiresAtMs\)/
  );
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaim.source,
    /playback_preserve_max_expiry\([\s\S]+profileAttempts[\s\S]+authorityExpiresAtMs/
  );
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaim.source,
    /local expectedCount = hasV5Authority and 11 or 8/
  );
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaim.source,
    /if status ~= "claimed" then[\s\S]+record\.state = "disclosed"[\s\S]+playback_attempt_clear_leases/
  );
  const attemptBeginBody = SCRIPT_DEFINITIONS.playbackAttemptBegin.source.split(
    "-- jg-script:playback-attempt-begin-v3"
  )[1];
  assert.ok(attemptBeginBody);
  assert.doesNotMatch(attemptBeginBody, /cleanupOwner/);
  assert.doesNotMatch(attemptBeginBody, /PEXPIREAT", KEYS\[4\]/);
  assert.doesNotMatch(attemptBeginBody, /KEYS\[1\] \.\. ":fingerprints"/);
  assert.match(attemptBeginBody, /pruneIndex\(KEYS\[12\]\)/);
  assert.match(SCRIPT_DEFINITIONS.playbackAttemptReconcile.source, /expectedFingerprintPrefix/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackAttemptReconcile.source,
    /ZCOUNT", KEYS\[3\], "-inf", now\) > 0/
  );
  assert.match(
    SCRIPT_DEFINITIONS.playbackRelease.source,
    /claim\.cleanupOwner\s*~=\s*ARGV\[9\]/
  );
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /PEXPIREAT/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /playback_delete_device_generations/);
  assert.doesNotMatch(
    SCRIPT_DEFINITIONS.playbackRecord.source,
    /generationKeys\s*=\s*redis\.call\("ZRANGE"[\s\S]{0,200}redis\.call\("DEL", key\)/
  );
  assert.match(SCRIPT_DEFINITIONS.leaseRenew.source, /leaseTokenHash/);
  assert.match(SCRIPT_DEFINITIONS.leaseRelease.source, /leaseTokenHash/);
  assert.match(SCRIPT_DEFINITIONS.rateLimitConsume.source, /policy_mismatch/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /stale|launchedAtMs|too_old/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /playback_decode_context_metadata/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /redis\.call\("GET", KEYS\[19 \+ index\]\)/);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackClaim.source, /SMEMBERS/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /claim\.contextRef = match\.ref/);
  assert.match(SCRIPT_DEFINITIONS.playbackClaim.source, /redis\.call\("HSET", keys\.claims/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackClaim.source,
    /playback_device_generation_matches\(KEYS\[17\], ARGV\[22\], true\)/
  );
  assert.ok(
    SCRIPT_DEFINITIONS.playbackClaim.source.indexOf("playback_device_generation_matches") <
      SCRIPT_DEFINITIONS.playbackClaim.source.indexOf('redis.call("HSET", keys.claims')
  );
  assert.match(SCRIPT_DEFINITIONS.playbackGetActiveClaim.source, /playback_purge_profile/);
  assert.match(SCRIPT_DEFINITIONS.playbackGetActiveClaim.source, /claim\.deviceRef ~= ARGV\[2\]/);
  assert.match(SCRIPT_DEFINITIONS.playbackGetActiveClaim.source, /claim\.sessionId ~= ARGV\[3\]/);
  assert.match(SCRIPT_DEFINITIONS.playbackGetActiveClaim.source, /claim\.released ~= "0"/);
  assert.match(SCRIPT_DEFINITIONS.playbackGetActiveClaim.source, /playback_current_generation/);
  assert.match(SCRIPT_DEFINITIONS.playbackGetActiveClaim.source, /redis\.call\("GET", KEYS\[17\]\) ~= keys\.root/);
  assert.match(SCRIPT_DEFINITIONS.playbackGetActiveClaim.source, /tonumber\(context\.expiresAtMs\) <= now/);
  assert.match(SCRIPT_DEFINITIONS.playbackGetActiveClaim.source, /return \{ "not_found" \}/);
  assert.doesNotMatch(
    SCRIPT_DEFINITIONS.playbackGetActiveClaim.source,
    /canonicalIdentity|inlineSubtitles|authorization|accessToken/i
  );
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /playback_decode_context_metadata/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /playback_decimal_increment/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /"generation_changed"/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /"overlap"/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /"capacity"/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /currentRaw ~= ARGV\[5\]/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /fingerprintIndexKeys/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /redis\.call\("GET", indexKey\)/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /redis\.call\("SET", indexKey, candidate\.ref\)/);
  assert.match(SCRIPT_DEFINITIONS.playbackRecord.source, /redis\.call\("HSET", keys\.contexts/);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackRecord.source, /ZPOP|EVICT/i);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackClaim.source, /ZPOP|EVICT/i);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackRecord.source, /canonicalIdentity|inlineSubtitles|accessToken/);
  const playbackRecordBody = SCRIPT_DEFINITIONS.playbackRecord.source.slice(
    SCRIPT_DEFINITIONS.playbackRecord.source.lastIndexOf("-- jg-script:playback-record")
  );
  const firstMutation = playbackRecordBody.indexOf(
    "playback_ensure_profile(keys, ARGV[1], true)"
  );
  assert.ok(playbackRecordBody.indexOf("playback_decode_context_metadata(candidateRaw)") < firstMutation);
  assert.ok(playbackRecordBody.indexOf('return { "overlap" }') < firstMutation);
  assert.ok(playbackRecordBody.indexOf('return { "capacity" }') < firstMutation);
  assert.match(
    SCRIPT_DEFINITIONS.playbackGetOrInitializeGeneration.source,
    /redis\.call\("SET", KEYS\[1\], ARGV\[1\], "NX"\)/
  );
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackRecord.source, /or "g1:0"/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackInvalidate.source,
    /currentGeneration ~= ARGV\[2\][\s\S]+redis\.call\("SET", keys\.generation, ARGV\[3\]\)/
  );
  assert.match(SCRIPT_DEFINITIONS.playbackInvalidate.source, /playback_remove_context/);
  assert.match(SCRIPT_DEFINITIONS.playbackInvalidate.source, /playback_remove_claim/);
  assert.match(SCRIPT_DEFINITIONS.playbackInvalidateDevice.source, /currentGeneration ~= ARGV\[8\]/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackInvalidateDevice.source,
    /playback_advance_device_generation\(KEYS\[17\], ARGV\[9\]\)/
  );
  assert.ok(
    SCRIPT_DEFINITIONS.playbackInvalidateDevice.source.indexOf("playback_advance_device_generation") <
      SCRIPT_DEFINITIONS.playbackInvalidateDevice.source.indexOf('redis.call("HGET", keys.claims')
  );
  assert.match(SCRIPT_DEFINITIONS.playbackInvalidateDevice.source, /HGET", keys\.claims, ARGV\[2\]/);
  assert.match(SCRIPT_DEFINITIONS.playbackInvalidateDevice.source, /playback_remove_claim/);
  const playbackInvalidateDeviceBody = SCRIPT_DEFINITIONS.playbackInvalidateDevice.source.slice(
    SCRIPT_DEFINITIONS.playbackInvalidateDevice.source.lastIndexOf(
      "-- jg-script:playback-invalidate-device-v4"
    )
  );
  assert.doesNotMatch(playbackInvalidateDeviceBody, /playback_remove_context/);
  assert.match(SCRIPT_DEFINITIONS.subtitleInvalidate.source, /mode ~= "device"/);
  assert.match(SCRIPT_DEFINITIONS.subtitleInvalidate.source, /"deviceRef"\) == deviceRef/);
  assert.match(SCRIPT_DEFINITIONS.subtitleInvalidate.source, /subtitle_mark_deleting/);
  assert.match(SCRIPT_DEFINITIONS.playbackPrune.source, /"LIMIT", 0, batchSize/);
  assert.match(SCRIPT_DEFINITIONS.playbackPrune.source, /playback_prune_globals\([^\n]+batchSize\)/);
  const playbackPruneBody = SCRIPT_DEFINITIONS.playbackPrune.source.slice(
    SCRIPT_DEFINITIONS.playbackPrune.source.lastIndexOf("-- jg-script:playback-prune-v3")
  );
  assert.doesNotMatch(playbackPruneBody, /ZREMRANGEBYSCORE/);
  assert.match(SCRIPT_DEFINITIONS.playbackPrune.source, /redis\.call\("ZCOUNT", KEYS\[4\]/);
  for (const key of ["contextExpiries", "claimExpiries", "tombstones"]) {
    assert.match(
      SCRIPT_DEFINITIONS.playbackPrune.source,
      new RegExp(
        '"ZRANGEBYSCORE", keys\\.' + key + '[\\s\\S]{0,100}"LIMIT", 0, remaining'
      )
    );
  }
  for (const name of [
    "playbackRecord",
    "playbackClaim",
    "playbackGetActiveClaim",
    "playbackRelease",
    "playbackPrune",
    "playbackInvalidate",
  ]) {
    assert.doesNotMatch(SCRIPT_DEFINITIONS[name].source, /LREM|RPUSH/);
  }
  for (const name of [
    "playbackRecord",
    "playbackClaim",
    "playbackGetActiveClaim",
    "playbackRelease",
  ]) {
    assert.match(SCRIPT_DEFINITIONS[name].source, /"prune_pending"/);
    assert.match(SCRIPT_DEFINITIONS[name].source, /playback_refresh_profile_ttl\([^\n]+true\)/);
  }
  assert.match(SCRIPT_DEFINITIONS.playbackPrune.source, /entryBatchSize/);
  assert.match(SCRIPT_DEFINITIONS.playbackPrune.source, /purgeHasMore/);
  assert.match(SCRIPT_DEFINITIONS.playbackPrune.source, /playback_has_due_globals/);
  assert.match(
    SCRIPT_DEFINITIONS.playbackPrune.source,
    /if purgeError then\s+if purgeHasMore then\s+playback_refresh_profile_ttl\([^\n]+true\)/
  );
  assert.match(SCRIPT_DEFINITIONS.playbackRelease.source, /redis\.call\("HSET", keys\.claims/);
  assert.match(SCRIPT_DEFINITIONS.playbackRelease.source, /claim\.released = "1"/);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackRelease.source, /redis\.call\("DEL", KEYS\[17\]\)/);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackClaim.source, /DEL", previous\.sessionKey/);
  assert.doesNotMatch(SCRIPT_DEFINITIONS.playbackClaim.source, /DEL", claim\.sessionKey/);
});

test("Redis repositories reject cluster clients at construction", () => {
  const { createCluster } = require("redis");
  const cluster = createCluster({ rootNodes: [{ url: "redis://127.0.0.1:6379" }] });

  assert.throws(() => new RedisScriptRunner(cluster), /Cluster clients are not supported/);
  assert.throws(
    () => createRedisTtlRepositories({ client: cluster }),
    /standalone primary client is required/
  );
});

test("script runner falls back from EVALSHA only on NOSCRIPT", async () => {
  const calls = [];
  const client = {
    async evalSha(sha, options) {
      calls.push({ command: "evalSha", sha, options });
      const error = new Error("NOSCRIPT No matching script. Please use EVAL.");
      error.code = "NOSCRIPT";
      throw error;
    },
    async eval(source, options) {
      calls.push({ command: "eval", source, options });
      return ["1234"];
    },
  };
  const runner = new RedisScriptRunner(client);

  assert.equal(await runner.timeMs(), 1234);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].sha, SCRIPT_DEFINITIONS.time.sha);
  assert.deepEqual(calls[0].options, { keys: [], arguments: [] });
  assert.equal(calls[1].source, SCRIPT_DEFINITIONS.time.source);
});

test("script runner applies one abort signal to EVALSHA and NOSCRIPT fallback", async () => {
  const calls = [];
  const controller = new AbortController();
  const commandClient = {
    async evalSha(sha, options) {
      calls.push({ command: "evalSha", sha, options });
      const error = new Error("NOSCRIPT No matching script. Please use EVAL.");
      error.code = "NOSCRIPT";
      throw error;
    },
    async eval(source, options) {
      calls.push({ command: "eval", source, options });
      return ["4321"];
    },
  };
  const client = {
    async eval() {
      assert.fail("the unscoped Redis client must not execute abortable commands");
    },
    withAbortSignal(signal) {
      calls.push({ command: "withAbortSignal", signal });
      return commandClient;
    },
  };
  const runner = new RedisScriptRunner(client);

  assert.deepEqual(
    await runner.run("time", [], [], { signal: controller.signal }),
    ["4321"]
  );
  assert.equal(calls[0].command, "withAbortSignal");
  assert.equal(calls[0].signal, controller.signal);
  assert.deepEqual(calls.slice(1).map((call) => call.command), ["evalSha", "eval"]);
});

test("script runner does not hide non-NOSCRIPT failures", async () => {
  const client = {
    async evalSha() {
      throw new Error("READONLY replica");
    },
    async eval() {
      assert.fail("EVAL fallback must not run for non-NOSCRIPT failures");
    },
  };
  await assert.rejects(() => new RedisScriptRunner(client).run("time"), /READONLY/);
});

test("script runner rejects unsafe numeric arguments before Redis", async () => {
  let calls = 0;
  const client = {
    async eval() {
      calls += 1;
      return ["0"];
    },
  };
  const runner = new RedisScriptRunner(client);

  await assert.rejects(
    runner.run("time", [], [Number.MAX_SAFE_INTEGER + 1]),
    /non-safe integer/
  );
  await assert.rejects(runner.run("time", [], [1.5]), /non-safe integer/);
  assert.equal(calls, 0);
});
