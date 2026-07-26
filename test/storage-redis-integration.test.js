"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { createClient } = require("redis");
const { PairingCoordinator } = require("../lib/pairing-coordinator");
const {
  deriveProfileIdentityHash,
  hashConfigBlob,
} = require("../lib/profile-provisioner");
const { projectPublicPlaybackClaim } = require("../lib/playback-claim-projection");
const { fingerprintExactUrl, hashOpaqueValue } = require("../lib/source-context");
const { EnvelopeCrypto } = require("../lib/storage/envelope-crypto");
const {
  RedisKeyspace,
  RedisManagementSessionRepository,
  RedisOAuthStateRepository,
  RedisPairingRepository,
  RedisPlaybackContextRepository,
  RedisScriptRunner,
  SCRIPT_DEFINITIONS,
} = require("../lib/storage/redis");
const { TokenService } = require("../lib/storage/token-service");
const {
  PROFILE_KEY_INDEX,
} = require("../lib/storage/redis/playback-context-repository");
process.env.JUMPGATE_REDIS_SUBTITLE_AGGREGATE = "1";
const {
  runRedisSubtitleLiveContracts,
} = require("./storage-redis-subtitle-delivery.test");
delete process.env.JUMPGATE_REDIS_SUBTITLE_AGGREGATE;

const REDIS_URL = process.env.REDIS_URL;
const redisTest = REDIS_URL ? test : test.skip;
let prefixSequence = 0;
const PARENT_V3_CONTEXT_FIELDS = Object.freeze([
  "createdAtMs",
  "envelope",
  "equivalenceHash",
  "expiresAtMs",
  "fingerprintHashes",
  "fingerprintIndexKeys",
  "generation",
  "globalMember",
  "ref",
  "revision",
  "tombstoneMembers",
  "v",
]);
const PLAYBACK_CLAIM_CLEANUP_OWNER = Symbol.for(
  "jumpgate.playbackClaimCleanupOwner"
);
const V5_CLAIMED_FIELDS = Object.freeze([
  "authorityVersion",
  "claimedAtMs",
  "contextRef",
  "deviceRef",
  "expiresAtMs",
  "globalMember",
  "intentUrlHash",
  "launchedAtMs",
  "privateStateEnvelope",
  "released",
  "requestDigest",
  "sessionId",
  "sessionKey",
  "status",
  "v",
]);
const V5_NEGATIVE_FIELDS = Object.freeze([
  "authorityVersion",
  "deviceRef",
  "expiresAtMs",
  "globalMember",
  "intentUrlHash",
  "launchedAtMs",
  "released",
  "requestDigest",
  "sessionId",
  "status",
  "v",
]);

function nextPrefix() {
  prefixSequence += 1;
  return "jg:v" + Date.now() + process.pid + prefixSequence;
}

function tokenService() {
  return new TokenService({ pepper: Buffer.alloc(32, 0x5a) });
}

function envelopeCrypto() {
  return new EnvelopeCrypto({
    keys: { integration: Buffer.alloc(32, 0x6b) },
    primaryKeyId: "integration",
  });
}

function activationRetryToken(byte = 0x71) {
  return Buffer.alloc(32, byte).toString("base64url");
}

function sequentialIds() {
  let sequence = 0;
  return (kind) => kind + "_redis_" + String(++sequence).padStart(8, "0");
}

function playbackContext(url, mediaId) {
  return {
    contentKey: hashOpaqueValue("movie:" + mediaId),
    canonicalIdentity: {
      provider: "imdb",
      id: mediaId,
      mediaType: "movie",
      season: null,
      episode: null,
      provenance: "metadata-request",
      confidence: "canonical",
    },
    traktEligible: true,
    request: { type: "movie", metaId: mediaId, videoId: mediaId },
    source: { type: "url", provider: "integration" },
    fingerprints: [fingerprintExactUrl(url)],
  };
}

function claimRequest(url, launchedAt) {
  return {
    attemptId: crypto.randomUUID(),
    fingerprints: [fingerprintExactUrl(url)],
    intentUrlHash: hashOpaqueValue(url),
    launchedAt,
  };
}

function playbackClaimAuthority(profileId, deviceId, request, overrides = {}) {
  const requestDigest = crypto.createHash("sha256")
    .update(JSON.stringify(request), "utf8")
    .digest("hex");
  const sessionId = "session_" + crypto.createHash("sha256")
    .update(profileId + "\0" + deviceId + "\0" + requestDigest, "utf8")
    .digest("hex")
    .slice(0, 32);
  return { sessionId, requestDigest, ...overrides };
}

function claimPlayback(repository, profileId, deviceId, request, options = {}) {
  return repository.claim(
    profileId,
    deviceId,
    request,
    playbackClaimAuthority(profileId, deviceId, request, options)
  );
}

async function playbackStorageSnapshot(client, repository, profileId) {
  const keys = repository._profileKeys(profileId);
  const contextValues = Object.values(await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts]));
  const fingerprintKeys = Array.from(
    new Set(
      contextValues.flatMap((value) => {
        try {
          return JSON.parse(value).fingerprintIndexKeys || [];
        } catch (_error) {
          return [];
        }
      })
    )
  ).sort();
  const fingerprintIndexes = {};
  for (const key of fingerprintKeys) fingerprintIndexes[key] = await client.get(key);
  return {
    root: await client.hGetAll(keys[PROFILE_KEY_INDEX.root]),
    contexts: await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts]),
    contextExpiries: await client.zRangeWithScores(
      keys[PROFILE_KEY_INDEX.contextExpiries],
      0,
      -1
    ),
    contextOrder: await client.lRange(keys[PROFILE_KEY_INDEX.contextOrder], 0, -1),
    equivalences: await client.hGetAll(keys[PROFILE_KEY_INDEX.equivalences]),
    claims: await client.hGetAll(keys[PROFILE_KEY_INDEX.claims]),
    claimExpiries: await client.zRangeWithScores(keys[PROFILE_KEY_INDEX.claimExpiries], 0, -1),
    claimOrder: await client.lRange(keys[PROFILE_KEY_INDEX.claimOrder], 0, -1),
    tombstones: await client.zRangeWithScores(keys[PROFILE_KEY_INDEX.tombstones], 0, -1),
    tombstoneGlobals: await client.hGetAll(keys[PROFILE_KEY_INDEX.tombstoneGlobals]),
    tombstoneOrder: await client.lRange(keys[PROFILE_KEY_INDEX.tombstoneOrder], 0, -1),
    globalContexts: await client.zRangeWithScores(keys[PROFILE_KEY_INDEX.globalContexts], 0, -1),
    globalClaims: await client.zRangeWithScores(keys[PROFILE_KEY_INDEX.globalClaims], 0, -1),
    globalTombstones: await client.zRangeWithScores(
      keys[PROFILE_KEY_INDEX.globalTombstones],
      0,
      -1
    ),
    schedule: await client.zRangeWithScores(keys[PROFILE_KEY_INDEX.schedule], 0, -1),
    fingerprintIndexes,
  };
}

async function rawRedisText(client, prefix) {
  const keys = [];
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, { MATCH: prefix + ":*", COUNT: 100 });
    cursor = String(reply.cursor);
    keys.push(...reply.keys);
  } while (cursor !== "0");
  keys.sort();

  const values = [];
  for (const key of keys) {
    const type = await client.type(key);
    let value;
    if (type === "string") value = await client.get(key);
    else if (type === "hash") value = await client.hGetAll(key);
    else if (type === "list") value = await client.lRange(key, 0, -1);
    else if (type === "zset") value = await client.zRangeWithScores(key, 0, -1);
    else if (type === "set") value = await client.sMembers(key);
    else value = type;
    values.push({ key, type, value });
  }
  return JSON.stringify(values);
}

async function cleanPrefix(client, prefix) {
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, { MATCH: prefix + ":*", COUNT: 100 });
    cursor = String(reply.cursor);
    if (reply.keys.length > 0) await client.del(reply.keys);
  } while (cursor !== "0");
}

async function withRedis(t, callback) {
  const prefix = nextPrefix();
  const client = createClient({ url: REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  t.after(async () => {
    try {
      await cleanPrefix(client, prefix);
    } finally {
      if (client.isOpen) await client.quit();
    }
  });
  return callback({ client, keyspace: new RedisKeyspace(prefix), prefix });
}

redisTest("REDIS_URL loads every Lua script and exercises an actual NOSCRIPT fallback", async (t) => {
  await withRedis(t, async ({ client, keyspace, prefix }) => {
    for (const definition of Object.values(SCRIPT_DEFINITIONS)) {
      assert.equal(await client.scriptLoad(definition.source), definition.sha);
    }

    const source = "return { ARGV[1] }\n-- " + crypto.randomUUID();
    const definition = {
      name: "noscriptProbe",
      filename: "integration-noscript.lua",
      source,
      sha: crypto.createHash("sha1").update(source).digest("hex"),
    };
    const calls = [];
    const runner = new RedisScriptRunner(
      {
        evalSha: async (...args) => {
          calls.push("evalSha");
          return client.evalSha(...args);
        },
        eval: async (...args) => {
          calls.push("eval");
          return client.eval(...args);
        },
      },
      { noscriptProbe: definition }
    );

    assert.deepEqual(await runner.run("noscriptProbe", [], ["loaded"]), ["loaded"]);
    assert.deepEqual(calls, ["evalSha", "eval"]);
    await runRedisSubtitleLiveContracts({ client, keyspace, prefix });
  });
});

redisTest("REDIS_URL playback reads exact c801f38 v3 fixtures and expands to strict v4", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const envelopes = envelopeCrypto();
    const generation = "g1:mixed_live_fixture";
    const idFactory = (label) => {
      let sequence = 0;
      return (kind) => kind + "_" + label + "_" + String(++sequence).padStart(4, "0");
    };
    const sourceContextOptions = {
      ttlMs: 60 * 1000,
      tombstoneTtlMs: 10 * 1000,
    };
    const v3 = new RedisPlaybackContextRepository({
      writeVersion: "3",
      client,
      keyspace,
      envelopeCrypto: envelopes,
      generationFactory: () => generation,
      sourceContextOptions: {
        ...sourceContextOptions,
        idFactory: idFactory("parent_v3"),
      },
    });
    const runner = new RedisScriptRunner(client);
    const profile = "profile_parent_v3_live_0001";
    const device = "device_parent_v3_live_0001";
    const url = "https://cdn.example/parent-v3-live.mkv";
    const input = playbackContext(url, "tt6000001");
    const recorded = await v3.record(profile, input, { providerRevision: "41" });
    const firstClaim = await claimPlayback(v3,
      profile,
      device,
      claimRequest(url, await runner.timeMs())
    );
    assert.equal(firstClaim.status, "claimed");

    const keys = v3._profileKeys(profile);
    const [metadataRaw] = Object.values(
      await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts])
    );
    const metadata = JSON.parse(metadataRaw);
    assert.deepEqual(Object.keys(metadata).sort(), PARENT_V3_CONTEXT_FIELDS);
    assert.equal(metadata.v, "3");
    assert.equal(Object.hasOwn(metadata, "providerRevision"), false);
    assert.deepEqual(
      envelopes.decryptJson(
        JSON.parse(metadata.envelope),
        "playback-context:v1:" + metadata.ref
      ),
      recorded
    );

    const deviceRef = keyspace.member("playback-device", profile, device);
    const parentClaim = JSON.parse(
      await client.hGet(keys[PROFILE_KEY_INDEX.claims], deviceRef)
    );
    assert.deepEqual(Object.keys(parentClaim).sort(), V5_CLAIMED_FIELDS);
    assert.equal(parentClaim.v, "4");
    assert.equal(parentClaim.authorityVersion, "5");
    assert.match(parentClaim.requestDigest, /^[a-f0-9]{64}$/);
    assert.equal(typeof parentClaim.privateStateEnvelope, "string");
    const parentActive = await v3.getActiveClaim(profile, device, firstClaim.sessionId);
    assert.equal(Object.hasOwn(parentActive, "deliveryBinding"), false);

    const v4 = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopes,
      generationFactory: () => generation,
      sourceContextOptions: {
        ...sourceContextOptions,
        idFactory: idFactory("expanded_v4"),
      },
    });
    const legacyReadByV4 = await v4.getActiveClaim(profile, device, firstClaim.sessionId);
    assert.equal(Object.hasOwn(legacyReadByV4, "deliveryBinding"), false);

    const upgraded = await v4.record(profile, input, { providerRevision: "41" });
    assert.equal(upgraded.contextId, recorded.contextId);
    const [v4MetadataRaw] = Object.values(
      await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts])
    );
    const v4Metadata = JSON.parse(v4MetadataRaw);
    assert.deepEqual(
      Object.keys(v4Metadata).sort(),
      [...PARENT_V3_CONTEXT_FIELDS, "providerRevision"].sort()
    );
    assert.equal(v4Metadata.v, "4");
    assert.equal(v4Metadata.providerRevision, "41");
    assert.equal(v4Metadata.revision, "2");
    const privateContext = envelopes.decryptJson(
      JSON.parse(v4Metadata.envelope),
      "playback-context:v1:" + v4Metadata.ref
    );
    assert.deepEqual(Object.keys(privateContext).sort(), [
      "context",
      "generation",
      "providerRevision",
      "revision",
      "v",
    ]);

    const oldClaimOnUpgradedContext = await v4.getActiveClaim(
      profile,
      device,
      firstClaim.sessionId
    );
    assert.equal(oldClaimOnUpgradedContext.deliveryBinding.contextRevision, "2");
    assert.equal(oldClaimOnUpgradedContext.deliveryBinding.providerRevision, "41");
    const secondClaim = await claimPlayback(v4,
      profile,
      device,
      claimRequest(url, (await runner.timeMs()) + 1)
    );
    const v4Active = await v4.getActiveClaim(profile, device, secondClaim.sessionId);
    assert.equal(v4Active.deliveryBinding.providerRevision, "41");
    assert.equal(v4Active.deliveryBinding.contextRevision, "2");
    const v4Claim = JSON.parse(
      await client.hGet(keys[PROFILE_KEY_INDEX.claims], deviceRef)
    );
    assert.deepEqual(Object.keys(v4Claim).sort(), V5_CLAIMED_FIELDS);
    assert.equal(v4Claim.v, "4");
    assert.equal(v4Claim.authorityVersion, "5");
    assert.equal(Object.hasOwn(v4Claim, "cleanupOwner"), false);
    assert.equal(typeof secondClaim[PLAYBACK_CLAIM_CLEANUP_OWNER], "string");
    assert.equal(Object.hasOwn(secondClaim, "cleanupOwner"), false);
  });
});

redisTest("REDIS_URL device invalidation persists an idempotent playback generation fence", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
      },
    });
    const profile = "profile_device_fence_live_0001";
    const device = "device_fence_live_0001";
    const url = "https://cdn.example/device-fence-live.mkv";
    const profileGeneration = await repository.getProfileGeneration(profile);
    await repository.record(profile, playbackContext(url, "tt6000099"), {
      generation: profileGeneration,
      providerRevision: "1",
    });
    const claim = await claimPlayback(repository,
      profile,
      device,
      claimRequest(url, await new RedisScriptRunner(client).timeMs()),
      { generation: profileGeneration, deviceGeneration: 1 }
    );
    assert.equal(claim.status, "claimed");

    assert.equal(await repository.invalidateDevice(profile, device, 2), true);
    assert.equal(await client.get(repository._deviceGenerationKey(profile, device)), "2");
    assert.equal(await repository.getActiveClaim(profile, device, claim.sessionId), null);
    assert.equal(await repository.invalidateDevice(profile, device, 2), false);
    assert.equal(await client.get(repository._deviceGenerationKey(profile, device)), "2");
    await assert.rejects(
      claimPlayback(repository,
        profile,
        device,
        claimRequest(url, (await new RedisScriptRunner(client).timeMs()) + 1),
        { generation: profileGeneration, deviceGeneration: 1 }
      ),
      (error) => error.code === "device_generation_changed"
    );
    assert.equal(await client.get(repository._deviceGenerationKey(profile, device)), "2");
  });
});

redisTest("REDIS_URL caller attempt replay is atomic and keeps the v5 claim shape", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: { idFactory: sequentialIds(), ttlMs: 60 * 1000 },
    });
    const runner = new RedisScriptRunner(client);
    const profile = "profile_claim_authority_live_0001";
    const device = "device_claim_authority_live_0001";
    const url = "https://cdn.example/claim-authority-live.mkv";
    await repository.record(profile, playbackContext(url, "tt6100001"));
    const request = claimRequest(url, await runner.timeMs());
    const authority = playbackClaimAuthority(profile, device, request, {
      sessionId: "session_claim_authority_live_0001",
    });

    const [first, retried] = await Promise.all([
      repository.claim(profile, device, request, authority),
      repository.claim(profile, device, request, authority),
    ]);
    assert.deepEqual(retried, first);
    assert.equal(first.sessionId, authority.sessionId);

    const keys = repository._profileKeys(profile);
    const deviceRef = keyspace.member("playback-device", profile, device);
    const storedBeforeConflict = JSON.parse(
      await client.hGet(keys[PROFILE_KEY_INDEX.claims], deviceRef)
    );
    assert.equal(storedBeforeConflict.authorityVersion, "5");
    assert.equal(storedBeforeConflict.requestDigest, authority.requestDigest);
    assert.equal(storedBeforeConflict.sessionId, authority.sessionId);

    const changedFingerprint = {
      ...request,
      fingerprints: [fingerprintExactUrl(url + "?changed=1")],
    };
    await assert.rejects(
      repository.claim(profile, device, changedFingerprint, authority),
      (error) => error.code === "claim_request_conflict"
    );
    await assert.rejects(
      repository.claim(
        profile,
        device,
        changedFingerprint,
        playbackClaimAuthority(profile, device, changedFingerprint, {
          sessionId: authority.sessionId,
        })
      ),
      (error) => error.code === "claim_request_conflict"
    );
    await assert.rejects(
      repository.claim(profile, device, request, {
        ...authority,
        sessionId: "session_claim_authority_live_0002",
      }),
      (error) => error.code === "claim_request_conflict"
    );
    assert.deepEqual(
      JSON.parse(await client.hGet(keys[PROFILE_KEY_INDEX.claims], deviceRef)),
      storedBeforeConflict
    );

    const distinctRequest = { ...request, attemptId: crypto.randomUUID() };
    const distinctAuthority = playbackClaimAuthority(
      profile,
      device,
      distinctRequest
    );
    const distinct = await repository.claim(
      profile,
      device,
      distinctRequest,
      distinctAuthority
    );
    assert.equal(distinct.status, "claimed");
    assert.notEqual(distinct.sessionId, first.sessionId);
    assert.deepEqual(
      await repository.claim(profile, device, distinctRequest, distinctAuthority),
      distinct
    );
    assert.equal(
      await client.get(repository._activeClaimAttemptKey(profile, device)),
      repository._claimAttemptKey(profile, device, distinctRequest.attemptId)
    );
    const storedDistinct = JSON.parse(
      await client.hGet(keys[PROFILE_KEY_INDEX.claims], deviceRef)
    );
    assert.deepEqual(Object.keys(storedDistinct).sort(), V5_CLAIMED_FIELDS);
    assert.equal(storedDistinct.authorityVersion, "5");
    assert.equal(storedDistinct.sessionId, distinctAuthority.sessionId);

    const missingDevice = "device_claim_authority_live_0002";
    const missingRequest = claimRequest(
      "https://cdn.example/claim-authority-missing.mkv",
      await runner.timeMs()
    );
    const missingAuthority = playbackClaimAuthority(profile, missingDevice, missingRequest);
    const missing = await Promise.all([
      repository.claim(profile, missingDevice, missingRequest, missingAuthority),
      repository.claim(profile, missingDevice, missingRequest, missingAuthority),
    ]);
    assert.deepEqual(missing, [
      { status: "not_found", sessionId: missingAuthority.sessionId },
      { status: "not_found", sessionId: missingAuthority.sessionId },
    ]);
    for (const result of missing) {
      assert.equal(result[PLAYBACK_CLAIM_CLEANUP_OWNER], undefined);
      assert.deepEqual(Object.getOwnPropertySymbols(result), []);
    }
    const missingRef = keyspace.member("playback-device", profile, missingDevice);
    const storedMissing = JSON.parse(
      await client.hGet(keys[PROFILE_KEY_INDEX.claims], missingRef)
    );
    assert.deepEqual(Object.keys(storedMissing).sort(), V5_NEGATIVE_FIELDS);
    assert.equal(storedMissing.status, "not_found");
    assert.equal(storedMissing.requestDigest, missingAuthority.requestDigest);
    assert.equal(storedMissing.sessionId, missingAuthority.sessionId);
    await assert.rejects(
      repository.claim(
        profile,
        missingDevice,
        {
          ...missingRequest,
          fingerprints: [fingerprintExactUrl("https://cdn.example/changed-missing.mkv")],
        },
        {
          ...missingAuthority,
          requestDigest: "e".repeat(64),
        }
      ),
      (error) => error.code === "claim_request_conflict"
    );
  });
});

redisTest("REDIS_URL equal-time supersession makes retry-A terminal after B wins", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: { idFactory: sequentialIds(), ttlMs: 60 * 1000 },
    });
    const runner = new RedisScriptRunner(client);
    const profile = "profile_claim_terminality_live_0001";
    const device = "device_claim_terminality_live_0001";
    const url = "https://cdn.example/claim-terminality-live.mkv";
    await repository.record(profile, playbackContext(url, "tt6100002"));
    const launchedAt = await runner.timeMs();
    const requestA = claimRequest(url, launchedAt);
    const authorityA = playbackClaimAuthority(profile, device, requestA, {
      sessionId: "session_claim_terminality_live_a",
    });
    const claimA = await repository.claim(profile, device, requestA, authorityA);
    assert.equal(claimA.status, "claimed");
    assert.equal(
      await repository.commitClaimDisclosure(
        profile,
        device,
        claimA.sessionId,
        claimA[PLAYBACK_CLAIM_CLEANUP_OWNER]
      ),
      true
    );

    const requestB = { ...requestA, attemptId: crypto.randomUUID() };
    const authorityB = playbackClaimAuthority(profile, device, requestB, {
      sessionId: "session_claim_terminality_live_b",
    });
    const claimB = await repository.claim(profile, device, requestB, authorityB);
    assert.equal(claimB.status, "claimed");
    assert.equal(claimB.sessionId, authorityB.sessionId);
    assert.equal(
      await repository.commitClaimDisclosure(
        profile,
        device,
        claimB.sessionId,
        claimB[PLAYBACK_CLAIM_CLEANUP_OWNER]
      ),
      true
    );

    const profileKeys = repository._profileKeys(profile);
    const deviceRef = keyspace.member("playback-device", profile, device);
    const storedB = await client.hGet(profileKeys[PROFILE_KEY_INDEX.claims], deviceRef);
    const activeAttemptB = repository._claimAttemptKey(profile, device, requestB.attemptId);
    assert.equal(await client.get(repository._activeClaimAttemptKey(profile, device)), activeAttemptB);
    assert.equal(await client.exists(repository._keys.key("playback-session", claimB.sessionId)), 1);

    const retriedA = await repository.claim(profile, device, requestA, authorityA);
    assert.deepEqual(retriedA, { status: "not_found", sessionId: authorityA.sessionId });
    assert.equal(retriedA[PLAYBACK_CLAIM_CLEANUP_OWNER], undefined);
    assert.equal(await client.hGet(profileKeys[PROFILE_KEY_INDEX.claims], deviceRef), storedB);
    assert.equal(await client.get(repository._activeClaimAttemptKey(profile, device)), activeAttemptB);
    assert.equal(await repository.getActiveClaim(profile, device, claimA.sessionId), null);
    assert.notEqual(await repository.getActiveClaim(profile, device, claimB.sessionId), null);
  });
});

redisTest("REDIS_URL finalization index collisions expose no claim, session, or active pointer", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const baseRunner = new RedisScriptRunner(client);
    let poisonKey = null;
    const hookedRunner = {
      timeMs: (options) => baseRunner.timeMs(options),
      async run(name, keys, args, options) {
        const reply = await baseRunner.run(name, keys, args, options);
        if (name === "playbackAttemptBegin" && reply[0] === "begun" && poisonKey) {
          await client.del(poisonKey);
          await client.set(poisonKey, "wrong-type");
        }
        return reply;
      },
    };
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      scriptRunner: hookedRunner,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: { idFactory: sequentialIds(), ttlMs: 60 * 1000 },
    });
    const profile = "profile_claim_finalize_collision_live_0001";
    const device = "device_claim_finalize_collision_live_0001";
    const url = "https://cdn.example/claim-finalize-collision-live.mkv";
    await repository.record(profile, playbackContext(url, "tt6100003"));
    const request = claimRequest(url, await baseRunner.timeMs());
    const authority = playbackClaimAuthority(profile, device, request, {
      sessionId: "session_claim_finalize_collision_live_0001",
    });
    poisonKey = repository._claimAttemptProfileIndexKey(profile);

    await assert.rejects(
      repository.claim(profile, device, request, authority),
      /Redis playback profile key collision/
    );
    const profileKeys = repository._profileKeys(profile);
    const deviceRef = keyspace.member("playback-device", profile, device);
    assert.equal(await client.hGet(profileKeys[PROFILE_KEY_INDEX.claims], deviceRef), null);
    assert.equal(await client.exists(repository._keys.key("playback-session", authority.sessionId)), 0);
    assert.equal(await client.exists(repository._activeClaimAttemptKey(profile, device)), 0);
  });
});

redisTest("REDIS_URL transition writer fences v5 and retries through an in-flight v6 cutover", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const baseRunner = new RedisScriptRunner(client);
    let cutover = false;
    let cutoverApplied = false;
    const calls = [];
    const hookedRunner = {
      timeMs: (options) => baseRunner.timeMs(options),
      async run(name, keys, args, options) {
        calls.push(name);
        if (cutover && !cutoverApplied && name === "playbackClaimV5Fenced") {
          cutoverApplied = true;
          await client.set(protocolKey, "6");
        }
        return baseRunner.run(name, keys, args, options);
      },
    };
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      claimWriterRolloutMode: "transition",
      client,
      keyspace,
      scriptRunner: hookedRunner,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: { idFactory: sequentialIds(), ttlMs: 60 * 1000 },
    });
    const protocolKey = repository._claimWriterProtocolKey;
    await client.set(protocolKey, "5");
    const profile = "profile_claim_protocol_cutover_live_0001";
    const urlA = "https://cdn.example/claim-protocol-v5-live.mkv";
    const urlB = "https://cdn.example/claim-protocol-v6-live.mkv";
    await repository.record(profile, playbackContext(urlA, "tt6100004"));
    await repository.record(profile, playbackContext(urlB, "tt6100005"));

    const requestA = claimRequest(urlA, await baseRunner.timeMs());
    const claimA = await claimPlayback(
      repository,
      profile,
      "device_claim_protocol_cutover_live_a",
      requestA
    );
    assert.equal(claimA.status, "claimed");
    assert.equal(await client.get(protocolKey), "5");

    cutover = true;
    const requestB = claimRequest(urlB, await baseRunner.timeMs());
    const claimB = await claimPlayback(
      repository,
      profile,
      "device_claim_protocol_cutover_live_b",
      requestB
    );
    assert.equal(claimB.status, "claimed");
    assert.equal(await client.get(protocolKey), "6");
    assert.equal(cutoverApplied, true);
    assert.equal(calls.filter((name) => name === "playbackClaimV5Fenced").length, 2);
    assert.equal(calls.filter((name) => name === "playbackClaimV6").length, 1);
  });
});

redisTest("REDIS_URL exact retry leases survive both abandon-disclose orderings", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      claimDisclosureLeaseMs: 5_000,
      sourceContextOptions: { idFactory: sequentialIds(), ttlMs: 60 * 1000 },
    });
    const runner = new RedisScriptRunner(client);

    async function exercise(label, discloseFirst) {
      const profile = "profile_attempt_order_" + label;
      const device = "device_attempt_order_" + label;
      const url = "https://cdn.example/attempt-order-" + label + ".mkv";
      await repository.record(profile, playbackContext(url, "tt62" + label.padStart(5, "0")));
      const request = claimRequest(url, await runner.timeMs());
      const authority = playbackClaimAuthority(profile, device, request);
      const [first, duplicate] = await Promise.all([
        repository.claim(profile, device, request, authority),
        repository.claim(profile, device, request, authority),
      ]);
      assert.equal(first.status, "claimed");
      assert.equal(duplicate.status, "claimed");
      assert.equal(duplicate.sessionId, first.sessionId);
      const firstLease = first[PLAYBACK_CLAIM_CLEANUP_OWNER];
      const duplicateLease = duplicate[PLAYBACK_CLAIM_CLEANUP_OWNER];
      assert.equal(typeof firstLease, "string");
      assert.equal(typeof duplicateLease, "string");
      assert.notEqual(duplicateLease, firstLease);

      if (discloseFirst) {
        assert.equal(
          await repository.commitClaimDisclosure(profile, device, first.sessionId, firstLease),
          true
        );
        assert.equal(
          await repository.releaseOwned(profile, device, duplicate.sessionId, duplicateLease),
          false
        );
      } else {
        assert.equal(
          await repository.releaseOwned(profile, device, first.sessionId, firstLease),
          false
        );
        assert.equal(
          await repository.commitClaimDisclosure(
            profile,
            device,
            duplicate.sessionId,
            duplicateLease
          ),
          true
        );
      }

      assert.notEqual(await repository.getActiveClaim(profile, device, first.sessionId), null);
      const keys = repository._profileKeys(profile);
      const deviceRef = keyspace.member("playback-device", profile, device);
      const stored = JSON.parse(await client.hGet(keys[PROFILE_KEY_INDEX.claims], deviceRef));
      assert.deepEqual(Object.keys(stored).sort(), V5_CLAIMED_FIELDS);
      assert.equal(Object.hasOwn(stored, "cleanupOwner"), false);
    }

    await exercise("00001", false);
    await exercise("00002", true);
  });
});

redisTest("REDIS_URL reconciliation releases only expired undisclosed delivery leases", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      claimDisclosureLeaseMs: 25,
      pruneBatchSize: 4,
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 2_000,
        maxClaimAttempts: 1,
        maxClaimAttemptsPerProfile: 1,
      },
    });
    const runner = new RedisScriptRunner(client);
    const backlogNow = await runner.timeMs();
    const backlogKeys = Array.from(
      { length: repository._pruneBatchSize + 1 },
      (_value, index) => keyspace.key(
        "playback-claim-attempt-fingerprint-v1",
        "expired-backlog-" + index
      )
    );
    assert.equal(backlogKeys.length > repository._pruneBatchSize, true);
    await client.zAdd(
      repository._globalClaimAttemptFingerprintsKey,
      backlogKeys.map((value) => ({ score: backlogNow - 1, value }))
    );
    assert.deepEqual(
      await runner.run(
        "playbackAttemptReconcile",
        [
          repository._globalClaimAttemptsKey,
          repository._claimAttemptReconcileKey,
          repository._globalClaimAttemptFingerprintsKey,
        ],
        [
          String(repository._pruneBatchSize),
          keyspace.prefix + ":playback-claim-attempt-v2:",
          keyspace.prefix + ":playback-claim-attempt-fingerprint-v1:",
        ]
      ),
      ["reconciled", "0", "0", "1"]
    );
    const residualBacklog = await client.zRangeByScore(
      repository._globalClaimAttemptFingerprintsKey,
      "-inf",
      backlogNow
    );
    assert.equal(residualBacklog.length, 1);

    const profile = "profile_attempt_reconcile_live_0001";
    const device = "device_attempt_reconcile_live_0001";
    const url = "https://cdn.example/attempt-reconcile-live.mkv";
    await repository.record(profile, playbackContext(url, "tt6200101"));
    const request = claimRequest(url, await runner.timeMs());
    const authority = playbackClaimAuthority(profile, device, request);
    const claim = await repository.claim(profile, device, request, authority);
    assert.equal(claim.status, "claimed");
    assert.equal(typeof claim[PLAYBACK_CLAIM_CLEANUP_OWNER], "string");
    assert.equal(
      await client.zScore(
        repository._globalClaimAttemptFingerprintsKey,
        residualBacklog[0]
      ),
      null
    );

    await new Promise((resolve) => setTimeout(resolve, 75));
    const reconciled = await repository.reconcileClaimAttempts();
    assert.ok(reconciled.examined >= 1);
    assert.equal(reconciled.released, 1);
    assert.equal(reconciled.hasMore, false);
    assert.equal(await repository.getActiveClaim(profile, device, claim.sessionId), null);

    const keys = repository._profileKeys(profile);
    const deviceRef = keyspace.member("playback-device", profile, device);
    const stored = JSON.parse(await client.hGet(keys[PROFILE_KEY_INDEX.claims], deviceRef));
    assert.equal(stored.released, "1");
    assert.deepEqual(
      await repository.claim(profile, device, request, authority),
      { status: "not_found", sessionId: authority.sessionId }
    );
    await assert.rejects(
      repository.claim(profile, device, request, {
        ...authority,
        requestDigest: "f".repeat(64),
      }),
      (error) => error.code === "claim_request_conflict"
    );
  });
});

redisTest("REDIS_URL negative claim authority replays, expires, prunes, and recovers", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const ttlMs = 500;
    const tombstoneTtlMs = 1_200;
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      pruneBatchSize: 16,
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs,
        tombstoneTtlMs,
        maxLaunchAgeMs: 5_000,
      },
    });
    const runner = new RedisScriptRunner(client);
    const trackedAttempts = [];

    function track(profile, device, request, authority) {
      trackedAttempts.push({
        attemptKey: repository._claimAttemptKey(
          profile,
          device,
          request.attemptId
        ),
        fingerprintKey: repository._claimAttemptFingerprintKey(
          profile,
          device,
          request.attemptId
        ),
        pointerKey: repository._claimAttemptPointerKey(profile, device, authority.sessionId),
      });
    }

    const ambiguousProfile = "profile_negative_ambiguous_live_0001";
    const ambiguousDevice = "device_negative_ambiguous_live_0001";
    const ambiguousUrlA = "https://cdn.example/negative-ambiguous-a.mkv";
    const ambiguousUrlB = "https://cdn.example/negative-ambiguous-b.mkv";
    await repository.record(
      ambiguousProfile,
      playbackContext(ambiguousUrlA, "tt6300001")
    );
    await repository.record(
      ambiguousProfile,
      playbackContext(ambiguousUrlB, "tt6300002")
    );
    const ambiguousRequest = {
      attemptId: crypto.randomUUID(),
      fingerprints: [fingerprintExactUrl(ambiguousUrlA), fingerprintExactUrl(ambiguousUrlB)],
      intentUrlHash: hashOpaqueValue("negative-ambiguous-intent"),
      launchedAt: await runner.timeMs(),
    };
    const ambiguousAuthority = playbackClaimAuthority(
      ambiguousProfile,
      ambiguousDevice,
      ambiguousRequest
    );
    const ambiguous = await repository.claim(
      ambiguousProfile,
      ambiguousDevice,
      ambiguousRequest,
      ambiguousAuthority
    );
    assert.deepEqual(ambiguous, {
      status: "ambiguous",
      sessionId: ambiguousAuthority.sessionId,
    });
    assert.equal(ambiguous[PLAYBACK_CLAIM_CLEANUP_OWNER], undefined);
    assert.deepEqual(
      await repository.claim(
        ambiguousProfile,
        ambiguousDevice,
        ambiguousRequest,
        ambiguousAuthority
      ),
      ambiguous
    );
    const ambiguousKeys = repository._profileKeys(ambiguousProfile);
    const ambiguousRef = keyspace.member(
      "playback-device",
      ambiguousProfile,
      ambiguousDevice
    );
    assert.deepEqual(
      Object.keys(JSON.parse(
        await client.hGet(ambiguousKeys[PROFILE_KEY_INDEX.claims], ambiguousRef)
      )).sort(),
      V5_NEGATIVE_FIELDS
    );
    track(ambiguousProfile, ambiguousDevice, ambiguousRequest, ambiguousAuthority);

    const expiredProfile = "profile_negative_expired_live_0001";
    const expiredDevice = "device_negative_expired_live_0001";
    const expiredUrl = "https://cdn.example/negative-expired.mkv";
    await repository.record(expiredProfile, playbackContext(expiredUrl, "tt6300003"));
    await new Promise((resolve) => setTimeout(resolve, ttlMs + 75));
    const expiredRequest = claimRequest(expiredUrl, await runner.timeMs());
    const expiredAuthority = playbackClaimAuthority(
      expiredProfile,
      expiredDevice,
      expiredRequest
    );
    const expired = await repository.claim(
      expiredProfile,
      expiredDevice,
      expiredRequest,
      expiredAuthority
    );
    assert.deepEqual(expired, {
      status: "expired",
      sessionId: expiredAuthority.sessionId,
    });
    assert.equal(expired[PLAYBACK_CLAIM_CLEANUP_OWNER], undefined);
    assert.deepEqual(
      await repository.claim(expiredProfile, expiredDevice, expiredRequest, expiredAuthority),
      expired
    );
    const expiredKeys = repository._profileKeys(expiredProfile);
    const expiredRef = keyspace.member("playback-device", expiredProfile, expiredDevice);
    assert.deepEqual(
      Object.keys(JSON.parse(
        await client.hGet(expiredKeys[PROFILE_KEY_INDEX.claims], expiredRef)
      )).sort(),
      V5_NEGATIVE_FIELDS
    );
    track(expiredProfile, expiredDevice, expiredRequest, expiredAuthority);

    const profileAttemptIndex = repository._claimAttemptProfileIndexKey(expiredProfile);
    const longIndexExpiry = Number(
      await client.sendCommand(["PEXPIRETIME", profileAttemptIndex])
    );
    assert.ok(longIndexExpiry > (await runner.timeMs()) + ttlMs);
    const missingDevice = "device_negative_missing_live_0001";
    const missingUrl = "https://cdn.example/negative-never-seen.mkv";
    const missingRequest = claimRequest(missingUrl, await runner.timeMs());
    const missingAuthority = playbackClaimAuthority(
      expiredProfile,
      missingDevice,
      missingRequest
    );
    const missing = await repository.claim(
      expiredProfile,
      missingDevice,
      missingRequest,
      missingAuthority
    );
    assert.deepEqual(missing, {
      status: "not_found",
      sessionId: missingAuthority.sessionId,
    });
    assert.equal(missing[PLAYBACK_CLAIM_CLEANUP_OWNER], undefined);
    assert.equal(
      Number(await client.sendCommand(["PEXPIRETIME", profileAttemptIndex])),
      longIndexExpiry
    );
    track(expiredProfile, missingDevice, missingRequest, missingAuthority);

    const staleProfile = "profile_negative_stale_live_0001";
    const staleDevice = "device_negative_stale_live_0001";
    const activeUrl = "https://cdn.example/negative-stale-active.mkv";
    await repository.record(staleProfile, playbackContext(activeUrl, "tt6300004"));
    const activeLaunchedAt = await runner.timeMs();
    const activeRequest = claimRequest(activeUrl, activeLaunchedAt);
    const activeAuthority = playbackClaimAuthority(staleProfile, staleDevice, activeRequest);
    const active = await repository.claim(
      staleProfile,
      staleDevice,
      activeRequest,
      activeAuthority
    );
    assert.equal(active.status, "claimed");
    assert.equal(
      await repository.commitClaimDisclosure(
        staleProfile,
        staleDevice,
        active.sessionId,
        active[PLAYBACK_CLAIM_CLEANUP_OWNER]
      ),
      true
    );
    const staleRequest = {
      attemptId: crypto.randomUUID(),
      fingerprints: [fingerprintExactUrl("https://cdn.example/negative-stale-missing.mkv")],
      intentUrlHash: hashOpaqueValue("negative-stale-intent"),
      launchedAt: activeLaunchedAt - 1,
    };
    const staleAuthority = playbackClaimAuthority(staleProfile, staleDevice, staleRequest);
    assert.deepEqual(
      await repository.claim(staleProfile, staleDevice, staleRequest, staleAuthority),
      { status: "not_found", sessionId: staleAuthority.sessionId }
    );
    assert.notEqual(
      await repository.getActiveClaim(staleProfile, staleDevice, active.sessionId),
      null
    );
    await assert.rejects(
      repository.claim(
        staleProfile,
        staleDevice,
        {
          ...staleRequest,
          fingerprints: [fingerprintExactUrl("https://cdn.example/negative-stale-changed.mkv")],
        },
        { ...staleAuthority, requestDigest: "d".repeat(64) }
      ),
      (error) => error.code === "claim_request_conflict"
    );
    await assert.rejects(
      repository.claim(staleProfile, staleDevice, staleRequest, {
        ...staleAuthority,
        sessionId: "session_negative_stale_changed_0001",
      }),
      (error) => error.code === "claim_request_conflict"
    );
    track(staleProfile, staleDevice, staleRequest, staleAuthority);

    const recoveryProfile = "profile_negative_recovery_live_0001";
    const recoveryDevice = "device_negative_recovery_live_0001";
    const recoveryUrl = "https://cdn.example/negative-recovery-missing.mkv";
    const recoveryRequest = claimRequest(recoveryUrl, await runner.timeMs());
    const recoveryAuthority = playbackClaimAuthority(
      recoveryProfile,
      recoveryDevice,
      recoveryRequest
    );
    assert.equal(
      (await repository.claim(
        recoveryProfile,
        recoveryDevice,
        recoveryRequest,
        recoveryAuthority
      )).status,
      "not_found"
    );
    const nextGeneration = await repository.invalidateProfile(recoveryProfile);
    const recoveredRequest = {
      ...recoveryRequest,
      fingerprints: [fingerprintExactUrl(recoveryUrl + "?generation=2")],
    };
    const recoveredAuthority = playbackClaimAuthority(
      recoveryProfile,
      recoveryDevice,
      recoveredRequest,
      { generation: nextGeneration }
    );
    assert.equal(
      (await repository.claim(
        recoveryProfile,
        recoveryDevice,
        recoveredRequest,
        recoveredAuthority
      )).status,
      "not_found"
    );
    track(recoveryProfile, recoveryDevice, recoveredRequest, recoveredAuthority);

    const latestAttemptIndexExpiry = Math.max(
      longIndexExpiry,
      ...await Promise.all(
        [ambiguousProfile, staleProfile, recoveryProfile].map(async (profile) =>
          Number(await client.sendCommand([
            "PEXPIRETIME",
            repository._claimAttemptProfileIndexKey(profile),
          ]))
        )
      )
    );
    const waitForExpiryMs = Math.max(
      0,
      latestAttemptIndexExpiry - (await runner.timeMs()) + 75
    );
    await new Promise((resolve) => setTimeout(resolve, waitForExpiryMs));
    await repository.prune();
    for (const tracked of trackedAttempts) {
      assert.equal(await client.exists(tracked.attemptKey), 0);
      assert.equal(await client.exists(tracked.fingerprintKey), 0);
      assert.equal(await client.exists(tracked.pointerKey), 0);
      assert.equal(await client.zScore(repository._globalClaimAttemptsKey, tracked.attemptKey), null);
      assert.equal(
        await client.zScore(repository._globalClaimAttemptFingerprintsKey, tracked.fingerprintKey),
        null
      );
    }
  });
});

redisTest("REDIS_URL profile invalidation forgets device indexes without deleting member-supplied keys", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        deviceGenerationTtlMs: 1000,
      },
    });
    const runner = new RedisScriptRunner(client);
    const profileA = "profile_generation_cleanup_live_a";
    const profileB = "profile_generation_cleanup_live_b";
    const deviceA = "device_generation_cleanup_live_a";
    const deviceB = "device_generation_cleanup_live_b";
    const urlA = "https://cdn.example/generation-cleanup-a.mkv";
    const urlB = "https://cdn.example/generation-cleanup-b.mkv";
    const unrelatedKey = keyspace.key("rate-limit-record", "must-survive-generation-index-poison");
    const generationA = await repository.getProfileGeneration(profileA);
    const generationB = await repository.getProfileGeneration(profileB);
    await repository.record(profileA, playbackContext(urlA, "tt6000101"), {
      generation: generationA,
      providerRevision: "1",
    });
    await repository.record(profileB, playbackContext(urlB, "tt6000102"), {
      generation: generationB,
      providerRevision: "1",
    });
    const claimA = await claimPlayback(repository,
      profileA,
      deviceA,
      claimRequest(urlA, await runner.timeMs()),
      { generation: generationA, deviceGeneration: 1 }
    );
    const claimB = await claimPlayback(repository,
      profileB,
      deviceB,
      claimRequest(urlB, await runner.timeMs()),
      { generation: generationB, deviceGeneration: 1 }
    );
    assert.equal(claimA.status, "claimed");
    assert.equal(claimB.status, "claimed");
    assert.equal(
      await client.zCard(repository._deviceGenerationIndexKey(profileA)),
      1
    );
    await client.set(unrelatedKey, "preserve-me");
    await client.zAdd(repository._deviceGenerationIndexKey(profileA), {
      score: Date.now() + 60 * 1000,
      value: unrelatedKey,
    });

    await repository.invalidateProfile(profileA);
    assert.equal(await client.get(repository._deviceGenerationKey(profileA, deviceA)), "1");
    assert.equal(await client.get(unrelatedKey), "preserve-me");
    assert.equal(await client.exists(repository._deviceGenerationIndexKey(profileA)), 0);
    assert.equal(await repository.getActiveClaim(profileA, deviceA, claimA.sessionId), null);
    assert.equal(
      await client.get(repository._deviceGenerationKey(profileB, deviceB)),
      "1"
    );
    assert.notEqual(
      await repository.getActiveClaim(profileB, deviceB, claimB.sessionId),
      null
    );
  });
});

redisTest("REDIS_URL device generation fences expire with their profile index", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        deviceGenerationTtlMs: 50,
      },
    });
    const runner = new RedisScriptRunner(client);
    const profile = "profile_generation_expiry_live_0001";
    const device = "device_generation_expiry_live_0001";
    const url = "https://cdn.example/generation-expiry.mkv";
    const generation = await repository.getProfileGeneration(profile);
    await repository.record(profile, playbackContext(url, "tt6000103"), {
      generation,
      providerRevision: "1",
    });
    const claim = await claimPlayback(repository,
      profile,
      device,
      claimRequest(url, await runner.timeMs()),
      { generation, deviceGeneration: 1 }
    );
    assert.equal(claim.status, "claimed");
    assert.equal(await client.get(repository._deviceGenerationKey(profile, device)), "1");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await client.get(repository._deviceGenerationKey(profile, device)), null);
    assert.equal(await client.exists(repository._deviceGenerationIndexKey(profile)), 0);
  });
});

redisTest("REDIS_URL stale active check cannot recreate a revoked management session", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    let enterActiveCheck;
    let releaseActiveCheck;
    const entered = new Promise((resolve) => {
      enterActiveCheck = resolve;
    });
    const release = new Promise((resolve) => {
      releaseActiveCheck = resolve;
    });
    const repository = new RedisManagementSessionRepository({
      client,
      keyspace,
      tokenService: tokenService(),
      isProfileActive: async () => {
        enterActiveCheck();
        await release;
        return true;
      },
    });
    const profile = "profile_management_race_live_0001";
    const issuing = repository.issue(profile);
    await entered;
    await repository.revokeProfile(profile);
    releaseActiveCheck();
    await assert.rejects(
      issuing,
      (error) => error.code === "profile_inactive"
    );
    assert.equal(await client.zCard(repository._globalKey), 0);
    assert.equal(await client.zCard(repository._profileKey(profile)), 0);
    const generationKey = repository._profileGenerationKey(profile);
    assert.equal(await client.get(generationKey), "revoked:1");
    assert.equal(await repository.revokeProfile(profile), 0);
    assert.equal(await client.get(generationKey), "revoked:1");

    const foreignSessionKey = keyspace.key("management-session", "foreign-owner");
    await client.hSet(foreignSessionKey, { profileId: "profile_foreign_owner" });
    await client.zAdd(repository._profileKey(profile), {
      score: Date.now() + 60 * 1000,
      value: foreignSessionKey,
    });
    await assert.rejects(() => repository.revokeProfile(profile), /unexpected management profile revoke/);
    assert.equal(await client.get(generationKey), "revoked:1");
    assert.equal(await client.hGet(foreignSessionKey, "profileId"), "profile_foreign_owner");
  });
});

redisTest("REDIS_URL playback rejects an in-flight stale epoch with zero key side effects", async (t) => {
  await withRedis(t, async ({ client, keyspace, prefix }) => {
    const envelopes = envelopeCrypto();
    const profile = "profile_flush_race_live_0001";
    const unrelatedKey = prefix + "-unrelated";
    t.after(async () => {
      if (client.isOpen) await client.del(unrelatedKey);
    });
    await client.set(unrelatedKey, "preserve-me");

    let idSequence = 0;
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopes,
      sourceContextOptions: {
        idFactory: (kind) => kind + "_flush_" + String(++idSequence).padStart(4, "0"),
        ttlMs: 60 * 1000,
      },
    });
    const staleGeneration = await repository.getProfileGeneration(profile);
    await repository.record(
      profile,
      playbackContext("https://cdn.example/pre-flush.mkv", "tt6000002"),
      { generation: staleGeneration, providerRevision: "1" }
    );
    assert.notEqual(await rawRedisText(client, prefix), "[]");

    const delegate = new RedisScriptRunner(client);
    let wiped = false;
    const racingScripts = {
      timeMs: () => delegate.timeMs(),
      async run(name, keys, args) {
        if (!wiped && name === "playbackRecord" && args[2] === "insert") {
          wiped = true;
          await cleanPrefix(client, prefix);
          assert.equal(await rawRedisText(client, prefix), "[]");
          assert.equal(await client.get(unrelatedKey), "preserve-me");
        }
        return delegate.run(name, keys, args);
      },
    };
    const racingRepository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      scriptRunner: racingScripts,
      envelopeCrypto: envelopes,
      sourceContextOptions: {
        idFactory: () => "context_flush_race",
        ttlMs: 60 * 1000,
      },
    });
    await assert.rejects(
      racingRepository.record(
        profile,
        playbackContext("https://cdn.example/in-flight-stale.mkv", "tt6000003"),
        { generation: staleGeneration, providerRevision: "1" }
      ),
      (error) => error.code === "profile_generation_changed"
    );
    assert.equal(wiped, true);
    assert.equal(await rawRedisText(client, prefix), "[]");
    assert.equal(await client.get(unrelatedKey), "preserve-me");

    const freshGeneration = await repository.getProfileGeneration(profile);
    assert.notEqual(freshGeneration, staleGeneration);
    const initializedOnly = await rawRedisText(client, prefix);
    const initializedRecords = JSON.parse(initializedOnly);
    assert.equal(initializedRecords.length, 1);
    assert.equal(initializedRecords[0].key, repository._generationKey(profile));
    await assert.rejects(
      repository.record(
        profile,
        playbackContext("https://cdn.example/retried-stale.mkv", "tt6000004"),
        { generation: staleGeneration, providerRevision: "1" }
      ),
      (error) => error.code === "profile_generation_changed"
    );
    assert.equal(await rawRedisText(client, prefix), initializedOnly);
    assert.equal(await client.get(unrelatedKey), "preserve-me");
  });
});

redisTest("REDIS_URL playback prune processes only its configured profile batch", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const runner = new RedisScriptRunner(client);
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      pruneBatchSize: 2,
      pruneEntryBatchSize: 1,
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        tombstoneTtlMs: 10 * 1000,
      },
    });
    const profiles = ["profile_prune_0001", "profile_prune_0002", "profile_prune_0003"];
    for (let index = 0; index < profiles.length; index += 1) {
      const suffix = String(index + 1).padStart(7, "0");
      await repository.record(
        profiles[index],
        playbackContext("https://cdn.example/prune-" + suffix + ".mkv", "tt" + suffix)
      );
    }

    const dueAt = await runner.timeMs();
    const scheduleKey = repository._scheduleKey;
    const globalContextsKey = keyspace.key("playback-global", "contexts");
    for (const profileId of profiles) {
      const keys = repository._profileKeys(profileId);
      const contexts = await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts]);
      for (const [ref, serialized] of Object.entries(contexts)) {
        const context = JSON.parse(serialized);
        context.createdAtMs = String(dueAt - 2);
        context.expiresAtMs = String(dueAt - 1);
        await client.hSet(keys[PROFILE_KEY_INDEX.contexts], ref, JSON.stringify(context));
        await client.zAdd(keys[PROFILE_KEY_INDEX.contextExpiries], {
          score: dueAt - 1,
          value: ref,
        });
        await client.zAdd(globalContextsKey, {
          score: dueAt - 1,
          value: context.globalMember,
        });
      }
      await client.zAdd(scheduleKey, {
        score: dueAt - 1,
        value: keys[PROFILE_KEY_INDEX.root],
      });
    }

    const first = await repository.prune();
    assert.deepEqual(first, { contexts: 0, claims: 0, tombstones: 2, hasMore: true });
    assert.equal(await client.zCount(scheduleKey, "-inf", dueAt), 1);

    const second = await repository.prune();
    assert.deepEqual(second, { contexts: 0, claims: 0, tombstones: 3, hasMore: false });
    assert.equal(await client.zCount(scheduleKey, "-inf", await runner.timeMs()), 0);
  });
});

redisTest("REDIS_URL playback prune bounds and requeues one profile backlog", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const runner = new RedisScriptRunner(client);
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      pruneBatchSize: 1,
      pruneEntryBatchSize: 3,
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        tombstoneTtlMs: 10 * 60 * 1000,
      },
    });
    const profileId = "profile_prune_backlog_0001";
    for (let index = 0; index < 9; index += 1) {
      await repository.record(
        profileId,
        playbackContext(
          "https://cdn.example/prune-backlog-" + index + ".mkv",
          "tt3" + String(index).padStart(6, "0")
        )
      );
    }

    const dueAt = await runner.timeMs();
    const keys = repository._profileKeys(profileId);
    const contexts = await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts]);
    for (const [ref, serialized] of Object.entries(contexts)) {
      const context = JSON.parse(serialized);
      context.createdAtMs = String(dueAt - 2);
      context.expiresAtMs = String(dueAt - 1);
      await client.hSet(keys[PROFILE_KEY_INDEX.contexts], ref, JSON.stringify(context));
      await client.zAdd(keys[PROFILE_KEY_INDEX.contextExpiries], {
        score: dueAt - 1,
        value: ref,
      });
      await client.zAdd(keys[PROFILE_KEY_INDEX.globalContexts], {
        score: dueAt - 1,
        value: context.globalMember,
      });
    }
    await client.zAdd(repository._scheduleKey, {
      score: dueAt - 1,
      value: keys[PROFILE_KEY_INDEX.root],
    });

    for (const [remaining, tombstones, hasMore] of [
      [6, 3, true],
      [3, 6, true],
      [0, 9, false],
    ]) {
      const result = await repository.prune();
      assert.equal(result.hasMore, hasMore);
      assert.equal(await client.hLen(keys[PROFILE_KEY_INDEX.contexts]), remaining);
      assert.equal(await client.zCard(keys[PROFILE_KEY_INDEX.contextExpiries]), remaining);
      assert.equal(await client.zCard(keys[PROFILE_KEY_INDEX.tombstones]), tombstones);
      assert.equal(
        await client.zCount(repository._scheduleKey, "-inf", await runner.timeMs()),
        hasMore ? 1 : 0
      );
    }
    assert.deepEqual({
      contextOrder: await client.lRange(keys[PROFILE_KEY_INDEX.contextOrder], 0, -1),
      claimOrder: await client.lRange(keys[PROFILE_KEY_INDEX.claimOrder], 0, -1),
      tombstoneOrder: await client.lRange(keys[PROFILE_KEY_INDEX.tombstoneOrder], 0, -1),
    }, {
      contextOrder: [],
      claimOrder: [],
      tombstoneOrder: [],
    });
  });
});

redisTest("REDIS_URL playback prune requeues a partially processed profile error", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const runner = new RedisScriptRunner(client);
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      pruneBatchSize: 1,
      pruneEntryBatchSize: 3,
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        tombstoneTtlMs: 10 * 60 * 1000,
      },
    });
    const profileId = "profile_prune_partial_0001";
    for (let index = 0; index < 3; index += 1) {
      await repository.record(
        profileId,
        playbackContext(
          "https://cdn.example/prune-partial-" + index + ".mkv",
          "tt4" + String(index).padStart(6, "0")
        )
      );
    }

    const dueAt = await runner.timeMs();
    const keys = repository._profileKeys(profileId);
    const contexts = Object.entries(
      await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts])
    ).sort(([left], [right]) => left.localeCompare(right));
    for (let index = 0; index < contexts.length; index += 1) {
      const [ref, serialized] = contexts[index];
      const context = JSON.parse(serialized);
      context.createdAtMs = String(dueAt - (index === 1 ? 1 : 2));
      context.expiresAtMs = String(dueAt - 1);
      await client.hSet(keys[PROFILE_KEY_INDEX.contexts], ref, JSON.stringify(context));
      await client.zAdd(keys[PROFILE_KEY_INDEX.contextExpiries], {
        score: dueAt - 1,
        value: ref,
      });
      await client.zAdd(keys[PROFILE_KEY_INDEX.globalContexts], {
        score: dueAt - 1,
        value: context.globalMember,
      });
    }
    await client.zAdd(repository._scheduleKey, {
      score: dueAt - 1,
      value: keys[PROFILE_KEY_INDEX.root],
    });

    const result = await repository.prune();
    assert.equal(result.hasMore, true);
    assert.equal(await client.hLen(keys[PROFILE_KEY_INDEX.contexts]), 2);
    assert.equal(await client.zCard(keys[PROFILE_KEY_INDEX.contextExpiries]), 2);
    assert.equal(await client.zCount(repository._scheduleKey, "-inf", await runner.timeMs()), 1);
  });
});

redisTest("REDIS_URL equivalent playback refresh preserves first fields and bounded unions", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
      },
    });
    const url = "https://cdn.example/provider-union.mkv";
    const firstInput = playbackContext(url, "tt2000001");
    firstInput.source.provider = "source-a";
    firstInput.source.providers = ["source-a", "source-shared"];
    firstInput.request.streamProvider = "request-a";
    firstInput.request.streamProviders = ["request-a", "request-shared"];
    firstInput.inlineSubtitles = Array.from({ length: 63 }, (_, index) => ({
      id: "subtitle-" + String(index).padStart(2, "0"),
      lang: "en",
      url: "https://subs.example/" + index + ".vtt",
    }));
    const first = await repository.record("profile_provider_union_0001", firstInput);

    const secondInput = playbackContext(url, "tt2000001");
    secondInput.canonicalIdentity = {
      provider: "tmdb",
      id: "603",
      mediaType: "movie",
      season: null,
      episode: null,
      provenance: "verified-external-id",
      confidence: "canonical",
    };
    secondInput.traktEligible = false;
    secondInput.source.provider = "source-b";
    secondInput.source.providers = ["source-b", "source-shared"];
    secondInput.request.streamProvider = "request-b";
    secondInput.request.streamProviders = ["request-b", "request-shared"];
    secondInput.inlineSubtitles = [
      {
        url: firstInput.inlineSubtitles[0].url,
        lang: firstInput.inlineSubtitles[0].lang,
        id: firstInput.inlineSubtitles[0].id,
      },
      { id: "subtitle-63", lang: "es", url: "https://subs.example/63.vtt" },
    ];
    const refreshed = await repository.record("profile_provider_union_0001", secondInput);

    assert.equal(refreshed.contextId, first.contextId);
    assert.deepEqual(refreshed.canonicalIdentity, first.canonicalIdentity);
    assert.equal(refreshed.traktEligible, true);
    assert.equal(refreshed.inlineSubtitles.length, 64);
    assert.deepEqual(
      refreshed.inlineSubtitles.map((subtitle) => subtitle.id),
      [...firstInput.inlineSubtitles.map((subtitle) => subtitle.id), "subtitle-63"]
    );
    assert.equal(refreshed.source.provider, "source-b");
    assert.deepEqual(refreshed.source.providers, ["source-a", "source-shared", "source-b"]);
    assert.equal(refreshed.request.streamProvider, "request-b");
    assert.deepEqual(refreshed.request.streamProviders, [
      "request-a",
      "request-shared",
      "request-b",
    ]);

    const beforeSubtitleOverflow = await playbackStorageSnapshot(
      client,
      repository,
      "profile_provider_union_0001"
    );
    const subtitleOverflow = playbackContext(url, "tt2000001");
    subtitleOverflow.inlineSubtitles = [
      { id: "subtitle-64", lang: "fr", url: "https://subs.example/64.vtt" },
    ];
    await assert.rejects(
      repository.record("profile_provider_union_0001", subtitleOverflow),
      /inlineSubtitles exceeds the maximum array length/
    );
    assert.deepEqual(
      await playbackStorageSnapshot(client, repository, "profile_provider_union_0001"),
      beforeSubtitleOverflow
    );

    const overflowInput = playbackContext(url, "tt2000001");
    overflowInput.source.provider = "source-overflow-00";
    overflowInput.source.providers = Array.from(
      { length: 62 },
      (_, index) => "source-overflow-" + String(index).padStart(2, "0")
    );
    await assert.rejects(
      repository.record("profile_provider_union_0001", overflowInput),
      /providers exceeds the maximum array length/
    );
    assert.deepEqual(
      await playbackStorageSnapshot(client, repository, "profile_provider_union_0001"),
      beforeSubtitleOverflow
    );
  });
});

redisTest("REDIS_URL playback equivalence treats fingerprints as an unordered set", async (t) => {
  await withRedis(t, async ({ client, keyspace, prefix }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: { idFactory: sequentialIds(), ttlMs: 60 * 1000 },
    });
    const profileId = "profile_set_equivalence_0001";
    const firstUrl = "https://cdn.example/set-a.mkv?token=first-secret";
    const secondUrl = "https://cdn.example/set-b.mkv?token=second-secret";
    const firstFingerprint = fingerprintExactUrl(firstUrl);
    const secondFingerprint = fingerprintExactUrl(secondUrl);
    const firstInput = playbackContext(firstUrl, "tt2000005");
    firstInput.fingerprints = [firstFingerprint, secondFingerprint];
    firstInput.source.provider = "source-a";
    const first = await repository.record(profileId, firstInput);

    const reorderedInput = playbackContext(secondUrl, "tt2000005");
    reorderedInput.fingerprints = [secondFingerprint, firstFingerprint];
    reorderedInput.source.provider = "source-b";
    const reordered = await repository.record(profileId, reorderedInput);

    assert.equal(reordered.contextId, first.contextId);
    assert.deepEqual(reordered.fingerprints, [secondFingerprint, firstFingerprint]);
    const keys = repository._profileKeys(profileId);
    assert.equal(await client.hLen(keys[PROFILE_KEY_INDEX.contexts]), 1);
    assert.equal(await client.hLen(keys[PROFILE_KEY_INDEX.equivalences]), 1);

    const discovered = [];
    let cursor = "0";
    do {
      const reply = await client.scan(cursor, { MATCH: prefix + ":*", COUNT: 100 });
      cursor = String(reply.cursor);
      discovered.push(...reply.keys);
    } while (cursor !== "0");
    assert.equal(discovered.some((key) => key.includes("first-secret")), false);
    assert.equal(discovered.some((key) => key.includes("second-secret")), false);
  });
});

redisTest("REDIS_URL playback preserves nested and required empty arrays across Lua writes", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: { idFactory: sequentialIds(), ttlMs: 60 * 1000 },
    });
    const runner = new RedisScriptRunner(client);
    const profileId = "profile_empty_arrays_0001";
    const deviceId = "device_empty_arrays_0001";
    const url = "https://cdn.example/empty-arrays.mkv";
    const input = playbackContext(url, "tt2000004");
    input.display = { tags: [], nested: { values: [] }, literal: "[]" };
    input.request.filters = [];
    input.source.options = [];
    input.inlineSubtitles = [];

    const recorded = await repository.record(profileId, input);
    assert.deepEqual(recorded.display.tags, []);
    assert.deepEqual(recorded.display.nested.values, []);
    assert.equal(Object.hasOwn(recorded.request, "filters"), false);
    assert.equal(Object.hasOwn(recorded.source, "options"), false);
    assert.deepEqual(recorded.inlineSubtitles, []);
    assert.equal(recorded.display.literal, "[]");

    const keys = repository._profileKeys(profileId);
    let storedContextBytes;
    const assertStoredMetadata = async () => {
      assert.deepEqual({
        contextOrder: await client.lRange(keys[PROFILE_KEY_INDEX.contextOrder], 0, -1),
        claimOrder: await client.lRange(keys[PROFILE_KEY_INDEX.claimOrder], 0, -1),
        tombstoneOrder: await client.lRange(keys[PROFILE_KEY_INDEX.tombstoneOrder], 0, -1),
      }, {
        contextOrder: [],
        claimOrder: [],
        tombstoneOrder: [],
      });
      const contexts = await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts]);
      const serialized = Object.values(contexts)[0];
      const stored = JSON.parse(serialized);
      assert.equal(stored.v, "4");
      assert.equal(stored.providerRevision, "0");
      assert.equal(typeof stored.envelope, "string");
      assert.equal(typeof stored.revision, "string");
      assert.equal(Object.hasOwn(stored, "display"), false);
      assert.equal(Object.hasOwn(stored, "request"), false);
      assert.equal(Object.hasOwn(stored, "source"), false);
      assert.equal(Object.hasOwn(stored, "inlineSubtitles"), false);
      if (storedContextBytes === undefined) storedContextBytes = serialized;
      else assert.equal(serialized, storedContextBytes);
    };
    await assertStoredMetadata();

    const claim = await claimPlayback(repository,
      profileId,
      deviceId,
      claimRequest(url, await runner.timeMs())
    );
    assert.equal(claim.status, "claimed");
    assert.deepEqual(claim.context.inlineSubtitles, []);
    assert.deepEqual(claim.context.display.nested.values, []);
    const claims = Object.values(await client.hGetAll(keys[PROFILE_KEY_INDEX.claims]));
    assert.equal(claims.length, 1);
    const storedClaim = JSON.parse(claims[0]);
    assert.equal(storedClaim.contextRef.length, 64);
    assert.equal(Object.hasOwn(storedClaim, "context"), false);
    assert.equal(Object.hasOwn(storedClaim, "response"), false);
    await assertStoredMetadata();

    assert.equal(await repository.release(profileId, deviceId, claim.sessionId), true);
    await assertStoredMetadata();
  });
});

redisTest("REDIS_URL equivalent playback union enforces aggregate budget atomically", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
      },
    });
    const profileId = "profile_bounded_union_0001";
    const url = "https://cdn.example/bounded-union.mkv";
    const context = (prefix) => {
      const value = playbackContext(url, "tt2000002");
      value.inlineSubtitles = Array.from({ length: 16 }, (_item, index) => ({
        id: prefix + "-" + index,
        url: prefix.repeat(8_192),
      }));
      return value;
    };

    await repository.record(profileId, context("a"));
    const before = await playbackStorageSnapshot(client, repository, profileId);

    await assert.rejects(
      repository.record(profileId, context("b")),
      /maximum total byte size/
    );
    assert.deepEqual(await playbackStorageSnapshot(client, repository, profileId), before);
  });
});

redisTest("REDIS_URL encrypted playback preserves exact safe integers through pressure and generation clear", async (t) => {
  await withRedis(t, async ({ client, keyspace, prefix }) => {
    let generationSequence = 0;
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      generationFactory: () => "g1:live_" + String(++generationSequence),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        maxContexts: 2,
        maxContextsPerProfile: 2,
        maxClaims: 1,
        maxClaimsPerProfile: 1,
      },
    });
    const runner = new RedisScriptRunner(client);
    const profileId = "profile_encrypted_pressure_0001";
    const deviceId = "device_encrypted_pressure_0001";
    const mediaUrl = "https://cdn.example/max-safe.mkv?token=media-live-secret";
    const subtitleUrl = "https://subs.example/max-safe.vtt?sig=subtitle-live-secret";
    const artworkUrl = "https://images.example/max-safe.jpg?token=art-live-secret";
    const firstInput = playbackContext(mediaUrl, "tt4000001");
    firstInput.display = {
      exactInteger: Number.MAX_SAFE_INTEGER,
      signedArtwork: artworkUrl,
      authorization: "Bearer display-live-secret",
      unknown: {
        headers: { Authorization: "Bearer nested-live-secret" },
        token: "unknown-live-token",
      },
    };
    firstInput.inlineSubtitles = [{
      id: "inline-live-secret",
      url: subtitleUrl,
      headers: { Authorization: "Bearer subtitle-header-live-secret" },
      token: "subtitle-live-token",
    }];

    const generation = await repository.getProfileGeneration(profileId);
    assert.equal(generation, "g1:live_1");
    const recorded = await repository.record(profileId, firstInput, { generation });
    assert.equal(recorded.display.exactInteger, Number.MAX_SAFE_INTEGER);

    const keys = repository._profileKeys(profileId);
    const metadataRaw = Object.values(
      await client.hGetAll(keys[PROFILE_KEY_INDEX.contexts])
    )[0];
    const metadata = JSON.parse(metadataRaw);
    assert.equal(metadata.v, "4");
    assert.equal(metadata.providerRevision, "0");
    assert.equal(metadata.revision, "1");
    assert.equal(typeof metadata.createdAtMs, "string");
    assert.equal(typeof metadata.expiresAtMs, "string");
    assert.equal(Object.hasOwn(metadata, "display"), false);
    assert.equal(Object.hasOwn(metadata, "inlineSubtitles"), false);

    const rawBeforeClaim = await rawRedisText(client, prefix);
    for (const secret of [
      mediaUrl,
      subtitleUrl,
      artworkUrl,
      "media-live-secret",
      "subtitle-live-secret",
      "art-live-secret",
      "display-live-secret",
      "nested-live-secret",
      "unknown-live-token",
      "subtitle-header-live-secret",
      "subtitle-live-token",
      String(Number.MAX_SAFE_INTEGER),
    ]) {
      assert.equal(rawBeforeClaim.includes(secret), false, secret);
    }

    const request = claimRequest(mediaUrl, await runner.timeMs());
    const firstClaim = await claimPlayback(repository, profileId, deviceId, request);
    assert.equal(firstClaim.status, "claimed");
    assert.equal(firstClaim.context.display.exactInteger, Number.MAX_SAFE_INTEGER);
    assert.equal(firstClaim.context.display.signedArtwork, artworkUrl);
    assert.equal(firstClaim.context.display.unknown.token, "unknown-live-token");
    assert.equal(
      firstClaim.context.display.unknown.headers.Authorization,
      "Bearer nested-live-secret"
    );
    assert.equal(firstClaim.context.inlineSubtitles[0].url, subtitleUrl);
    assert.equal(
      firstClaim.context.inlineSubtitles[0].headers.Authorization,
      "Bearer subtitle-header-live-secret"
    );
    assert.equal(firstClaim.context.inlineSubtitles[0].token, "subtitle-live-token");

    const secondUrl = "https://cdn.example/pressure-two.mkv";
    await repository.record(profileId, playbackContext(secondUrl, "tt4000002"), { generation });
    await assert.rejects(
      repository.record(
        profileId,
        playbackContext("https://cdn.example/pressure-three.mkv", "tt4000003"),
        { generation }
      ),
      (error) => error.code === "context_capacity"
    );
    await assert.rejects(
      repository.record(profileId, playbackContext(mediaUrl, "tt4999999"), { generation }),
      (error) => error.code === "context_overlap"
    );

    assert.deepEqual(
      await claimPlayback(repository, profileId, deviceId, request),
      firstClaim,
      "an identical retry must bypass ordinary claim pressure"
    );
    await assert.rejects(
      claimPlayback(repository,
        profileId,
        "device_encrypted_pressure_0002",
        claimRequest(secondUrl, await runner.timeMs())
      ),
      (error) => error.code === "claim_capacity"
    );
    assert.deepEqual(await claimPlayback(repository, profileId, deviceId, request), firstClaim);

    const rawAfterPressure = await rawRedisText(client, prefix);
    assert.equal(rawAfterPressure.includes("subtitle-header-live-secret"), false);
    assert.equal(rawAfterPressure.includes(String(Number.MAX_SAFE_INTEGER)), false);

    const nextGeneration = await repository.invalidateProfile(profileId);
    assert.match(nextGeneration, /^g1:live_[0-9]+$/);
    assert.notEqual(nextGeneration, generation);
    assert.equal(await repository.getProfileGeneration(profileId), nextGeneration);
    await assert.rejects(
      repository.record(
        profileId,
        playbackContext("https://cdn.example/stale-after-clear.mkv", "tt4000004"),
        { generation }
      ),
      (error) => error.code === "profile_generation_changed"
    );
    assert.equal(
      (await claimPlayback(repository,
        profileId,
        "device_encrypted_pressure_0003",
        claimRequest(mediaUrl, await runner.timeMs())
      )).status,
      "not_found"
    );
    const fresh = await repository.record(
      profileId,
      playbackContext("https://cdn.example/fresh-after-clear.mkv", "tt4000005"),
      { generation: nextGeneration }
    );
    assert.equal(fresh.profileId, profileId);
    assert.equal((await rawRedisText(client, prefix)).includes("live-secret"), false);
  });
});

redisTest("REDIS_URL concurrent equivalent and overlapping retention is atomic", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        maxContexts: 8,
        maxContextsPerProfile: 8,
      },
    });

    const equivalentProfile = "profile_concurrent_equivalent_0001";
    const equivalentUrl = "https://cdn.example/concurrent-equivalent.mkv";
    const equivalentInputs = ["provider-a", "provider-b"].map((provider) => {
      const value = playbackContext(equivalentUrl, "tt4100001");
      value.source.provider = provider;
      value.inlineSubtitles = [{
        id: provider,
        url: "https://subs.example/" + provider + ".vtt",
      }];
      return value;
    });
    const equivalentResults = await Promise.all(
      equivalentInputs.map((value) => repository.record(equivalentProfile, value))
    );
    assert.equal(equivalentResults[0].contextId, equivalentResults[1].contextId);
    const equivalentKeys = repository._profileKeys(equivalentProfile);
    assert.equal(await client.hLen(equivalentKeys[PROFILE_KEY_INDEX.contexts]), 1);
    const equivalentMetadata = JSON.parse(
      Object.values(await client.hGetAll(equivalentKeys[PROFILE_KEY_INDEX.contexts]))[0]
    );
    assert.equal(equivalentMetadata.revision, "2");

    const overlapProfile = "profile_concurrent_overlap_0001";
    const urls = {
      a: "https://cdn.example/overlap-a.mkv",
      b: "https://cdn.example/overlap-b.mkv",
      c: "https://cdn.example/overlap-c.mkv",
    };
    const fingerprints = Object.fromEntries(
      Object.entries(urls).map(([name, url]) => [name, fingerprintExactUrl(url)])
    );
    const overlapInput = (mediaId, selected) => {
      const value = playbackContext(urls[selected[0]], mediaId);
      value.fingerprints = selected.map((name) => fingerprints[name]);
      return value;
    };
    const settled = await Promise.allSettled([
      repository.record(overlapProfile, overlapInput("tt4200001", ["a", "b"])),
      repository.record(overlapProfile, overlapInput("tt4200002", ["b", "c"])),
    ]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = settled.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "context_overlap");

    const winnerIndex = settled[0].status === "fulfilled" ? 0 : 1;
    const freeName = winnerIndex === 0 ? "c" : "a";
    const winnerNames = winnerIndex === 0 ? ["a", "b"] : ["b", "c"];
    const freeRecord = await repository.record(
      overlapProfile,
      overlapInput("tt4200003", [freeName])
    );
    assert.equal(freeRecord.fingerprints[0], fingerprints[freeName]);

    const winner = settled[winnerIndex].value;
    const claim = await claimPlayback(repository,
      overlapProfile,
      "device_concurrent_overlap_0001",
      {
        attemptId: crypto.randomUUID(),
        fingerprints: winnerNames.map((name) => fingerprints[name]),
        intentUrlHash: hashOpaqueValue("concurrent-overlap-intent"),
        launchedAt: Date.now(),
      }
    );
    assert.equal(claim.status, "claimed");
    assert.equal(claim.context.contextId, winner.contextId);
    const overlapKeys = repository._profileKeys(overlapProfile);
    assert.equal(await client.hLen(overlapKeys[PROFILE_KEY_INDEX.contexts]), 2);
  });
});
redisTest("REDIS_URL playback reservations survive release and stale-owner cleanup", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const sessionId = "session_reused_redis_0001";
    let contextSequence = 0;
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      pruneBatchSize: 4,
      sourceContextOptions: {
        idFactory: (kind) => {
          if (kind === "session") return sessionId;
          contextSequence += 1;
          return "context_redis_" + String(contextSequence).padStart(8, "0");
        },
        ttlMs: 60 * 1000,
        tombstoneTtlMs: 10 * 1000,
      },
    });
    const runner = new RedisScriptRunner(client);
    const profileA = "profile_session_0001";
    const profileB = "profile_session_0002";
    const deviceA = "device_session_0001";
    const deviceB = "device_session_0002";
    const urlA = "https://cdn.example/session-a.mkv";
    const urlB = "https://cdn.example/session-b.mkv";
    await repository.record(profileA, playbackContext(urlA, "tt1000001"));
    await repository.record(profileB, playbackContext(urlB, "tt1000002"));

    const requestA = claimRequest(urlA, await runner.timeMs());
    const claimA = await claimPlayback(repository,
      profileA,
      deviceA,
      requestA,
      { sessionId }
    );
    assert.equal(claimA.sessionId, sessionId);
    const reservationKey = keyspace.key("playback-session", sessionId);
    const keysA = repository._profileKeys(profileA);
    const keysB = repository._profileKeys(profileB);
    const stateKeyA = keysA[PROFILE_KEY_INDEX.root];
    const stateKeyB = keysB[PROFILE_KEY_INDEX.root];
    assert.equal(await repository.release(profileA, deviceA, sessionId), true);
    assert.equal(await client.get(reservationKey), stateKeyA);

    const requestB = claimRequest(urlB, await runner.timeMs());
    await assert.rejects(
      () => claimPlayback(repository, profileB, deviceB, requestB, { sessionId }),
      /already in use/
    );

    const dueAt = await runner.timeMs();
    const claimsA = await client.hGetAll(keysA[PROFILE_KEY_INDEX.claims]);
    for (const [deviceRef, serialized] of Object.entries(claimsA)) {
      const claim = JSON.parse(serialized);
      claim.expiresAtMs = String(dueAt - 1);
      await client.hSet(keysA[PROFILE_KEY_INDEX.claims], deviceRef, JSON.stringify(claim));
      await client.zAdd(keysA[PROFILE_KEY_INDEX.claimExpiries], {
        score: dueAt - 1,
        value: deviceRef,
      });
      await client.zAdd(keysA[PROFILE_KEY_INDEX.globalClaims], {
        score: dueAt - 1,
        value: claim.globalMember,
      });
    }
    await client.zAdd(repository._scheduleKey, {
      score: dueAt - 1,
      value: stateKeyA,
    });
    await client.del(reservationKey);
    const claimB = await claimPlayback(repository, profileB, deviceB, requestB, { sessionId });
    assert.equal(claimB.sessionId, sessionId);
    assert.equal(await client.get(reservationKey), stateKeyB);
    assert.equal(await repository.release(profileA, deviceA, sessionId), false);
    assert.equal(await client.get(reservationKey), stateKeyB);

    assert.equal(await repository.release(profileB, deviceB, sessionId), true);
    assert.equal(await client.get(reservationKey), stateKeyB);
  });
});

redisTest("REDIS_URL provider snapshot leases serialize and recover across repository instances", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    let generationA = 0;
    let generationB = 0;
    const common = {
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        providerMutationLeaseMs: 50,
      },
    };
    const first = new RedisPlaybackContextRepository({
      writeVersion: "4",
      ...common,
      generationFactory: () => "g1:redis_a_" + String(++generationA),
    });
    const second = new RedisPlaybackContextRepository({
      writeVersion: "4",
      ...common,
      generationFactory: () => "g1:redis_b_" + String(++generationB),
    });
    const profile = "profile_snapshot_lease_live_0001";

    const token = await first.beginProviderSnapshotMutation(profile);
    const pending = await second.getProviderSnapshotState(profile);
    assert.deepEqual(pending, { generation: token, pending: true });
    const busyUrl = "https://media.example/provider-snapshot-pending-live.mkv";
    await assert.rejects(
      second.beginProviderSnapshotMutation(profile),
      (error) => error.code === "provider_snapshot_busy"
    );
    await assert.rejects(
      second.invalidateProfile(profile),
      (error) => error.code === "provider_snapshot_busy"
    );
    await assert.rejects(
      second.record(profile, playbackContext(busyUrl, "tt7000001")),
      (error) => error.code === "provider_snapshot_busy"
    );
    await assert.rejects(
      claimPlayback(second,
        profile,
        "device_snapshot_pending_live_0001",
        claimRequest(busyUrl, Date.now())
      ),
      (error) => error.code === "provider_snapshot_busy"
    );
    const firstFence = await first.fenceProviderSnapshotMutation(profile, token, "1");
    assert.equal(firstFence.token, token);
    assert.equal(firstFence.fence, "1");
    const stableGeneration = await first.completeProviderSnapshotMutation(profile, token);
    assert.deepEqual(await second.getProviderSnapshotState(profile), {
      generation: stableGeneration,
      pending: false,
    });

    const stale = await first.beginProviderSnapshotMutation(profile);
    await client.hSet(first._providerSnapshotStateKey(profile), "expiresAtMs", "0");
    const recovered = await second.getProviderSnapshotState(profile);
    assert.equal(recovered.pending, false);
    assert.notEqual(recovered.generation, stale);
    const replacement = await second.beginProviderSnapshotMutation(profile);
    assert.notEqual(replacement, stale);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.deepEqual(await first.renewProviderSnapshotMutation(profile, stale), {
        renewed: false,
      });
      assert.equal(await first.releaseProviderSnapshotMutation(profile, stale), false);
      await assert.rejects(
        first.fenceProviderSnapshotMutation(profile, stale, "2"),
        (error) => error.code === "provider_snapshot_changed"
      );
      assert.deepEqual(await second.getProviderSnapshotState(profile), {
        generation: replacement,
        pending: true,
      });
    }
    await assert.rejects(
      first.completeProviderSnapshotMutation(profile, stale),
      (error) => error.code === "provider_snapshot_changed"
    );
    const replacementFence = await second.fenceProviderSnapshotMutation(profile, replacement, "2");
    assert.equal(replacementFence.token, replacement);
    assert.equal(replacementFence.fence, "2");
    assert.deepEqual(await first.renewProviderSnapshotMutation(profile, replacement), {
      renewed: false,
    });
    const replacementGeneration = await second.completeProviderSnapshotMutation(
      profile,
      replacement
    );
    assert.deepEqual(await first.getProviderSnapshotState(profile), {
      generation: replacementGeneration,
      pending: false,
    });
    assert.equal(await first.releaseProviderSnapshotMutation(profile, stale), false);
  });
});

redisTest("REDIS_URL orphaned provider fences recover once and reject the original owner", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    let generationA = 0;
    let generationB = 0;
    const common = {
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        providerMutationLeaseMs: 50,
      },
    };
    const first = new RedisPlaybackContextRepository({
      writeVersion: "4",
      ...common,
      generationFactory: () => "g1:orphan_a_" + String(++generationA),
    });
    const second = new RedisPlaybackContextRepository({
      writeVersion: "4",
      ...common,
      generationFactory: () => "g1:orphan_b_" + String(++generationB),
    });
    const profile = "profile_snapshot_orphan_live_0001";

    const token = await first.beginProviderSnapshotMutation(profile);
    assert.equal((await first.fenceProviderSnapshotMutation(profile, token, "1")).fence, "1");
    await client.hSet(first._providerSnapshotStateKey(profile), "expiresAtMs", "0");

    assert.deepEqual(await second.probeProviderSnapshotRecovery(profile), {
      token,
      fence: "1",
      phase: "fenced",
    });
    const recovery = await second.beginProviderSnapshotRecovery(profile, "2");
    assert.deepEqual(recovery, { token, fence: "2" });
    assert.deepEqual(await first.beginProviderSnapshotRecovery(profile, "1"), recovery);
    assert.deepEqual(await second.getProviderSnapshotState(profile), {
      generation: token,
      pending: true,
    });

    const stable = await second.completeProviderSnapshotRecovery(
      profile,
      recovery.token,
      recovery.fence
    );
    assert.deepEqual(await first.getProviderSnapshotState(profile), {
      generation: stable,
      pending: false,
    });
    await assert.rejects(
      first.completeProviderSnapshotMutation(profile, token),
      (error) => error.code === "provider_snapshot_changed"
    );
    assert.equal(await first.probeProviderSnapshotRecovery(profile), null);

    const next = await first.beginProviderSnapshotMutation(profile);
    assert.equal((await first.fenceProviderSnapshotMutation(profile, next, "3")).fence, "3");
    await first.completeProviderSnapshotMutation(profile, next);
  });
});

redisTest("REDIS_URL active playback lookup is atomic, private, and fail-closed", async (t) => {
  await withRedis(t, async ({ client, keyspace, prefix }) => {
    const envelopes = envelopeCrypto();
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopes,
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        tombstoneTtlMs: 10 * 1000,
      },
    });
    const runner = new RedisScriptRunner(client);

    async function issue(profileId, deviceId, url, mediaId) {
      const input = playbackContext(url, mediaId);
      input.request.videoHash = "0123456789abcdef";
      input.request.videoSize = 987654321;
      input.request.filename = "Private.Redis.Movie.mkv";
      input.inlineSubtitles = [{
        id: "inline-" + mediaId,
        lang: "eng",
        url: "https://subs.example/" + mediaId + ".vtt?token=live-inline-url-secret",
        headers: { Authorization: "Bearer live-inline-header-secret" },
        token: "live-inline-token-secret",
      }];
      const recorded = await repository.record(profileId, input);
      const request = claimRequest(url, await runner.timeMs());
      const claim = await claimPlayback(repository,
        profileId,
        deviceId,
        request
      );
      assert.equal(claim.status, "claimed");
      return { claim, recorded, request };
    }

    const profile = "profile_active_live_0001";
    const device = "device_active_live_0001";
    const url = "https://cdn.example/active-live.mkv?token=live-media-secret";
    const issued = await issue(profile, device, url, "tt5000001");
    const rawBefore = await rawRedisText(client, prefix);
    for (const secret of [
      "live-media-secret",
      "live-inline-url-secret",
      "live-inline-header-secret",
      "live-inline-token-secret",
    ]) {
      assert.equal(rawBefore.includes(secret), false, secret);
    }

    const active = await repository.getActiveClaim(profile, device, issued.claim.sessionId);
    const generation = await repository.getProfileGeneration(profile);
    assert.deepEqual(active, {
      ...issued.claim,
      deliveryBinding: {
        profileId: profile,
        deviceId: device,
        sessionId: issued.claim.sessionId,
        generation,
        contextId: issued.recorded.contextId,
        contextRevision: "1",
        providerRevision: "0",
      },
    });
    assert.equal(Object.isFrozen(active), true);
    assert.equal(Object.isFrozen(active.context), true);
    assert.equal(Object.isFrozen(active.deliveryBinding), true);
    assert.equal(active.context.inlineSubtitles[0].url.includes("live-inline-url-secret"), true);
    assert.equal(
      active.context.inlineSubtitles[0].headers.Authorization,
      "Bearer live-inline-header-secret"
    );
    assert.equal(active.context.inlineSubtitles[0].token, "live-inline-token-secret");
    assert.equal(active.context.request.videoHash, "0123456789abcdef");
    assert.equal(active.context.request.videoSize, 987654321);
    assert.equal(active.context.request.filename, "Private.Redis.Movie.mkv");
    const publicClaim = projectPublicPlaybackClaim(active, profile);
    assert.equal(Object.hasOwn(publicClaim.context.request, "videoHash"), false);
    assert.equal(Object.hasOwn(publicClaim.context.request, "videoSize"), false);
    assert.equal(Object.hasOwn(publicClaim.context.request, "filename"), false);
    assert.equal(await rawRedisText(client, prefix), rawBefore);

    const activeKeys = repository._profileKeys(profile);
    const activeRef = keyspace.member("playback-context", profile, active.context.contextId);
    const originalMetadataRaw = await client.hGet(
      activeKeys[PROFILE_KEY_INDEX.contexts],
      activeRef
    );
    const crossProfileMetadata = JSON.parse(originalMetadataRaw);
    crossProfileMetadata.envelope = JSON.stringify(
      envelopes.encryptJson(
        { ...active.context, profileId: "profile_active_live_cross_profile" },
        "playback-context:v1:" + crossProfileMetadata.ref
      )
    );
    await client.hSet(
      activeKeys[PROFILE_KEY_INDEX.contexts],
      activeRef,
      JSON.stringify(crossProfileMetadata)
    );
    assert.equal(await repository.getActiveClaim(profile, device, issued.claim.sessionId), null);
    await client.hSet(activeKeys[PROFILE_KEY_INDEX.contexts], activeRef, originalMetadataRaw);
    assert.deepEqual(
      await repository.getActiveClaim(profile, device, issued.claim.sessionId),
      active
    );

    const refMismatchedMetadata = JSON.parse(originalMetadataRaw);
    refMismatchedMetadata.ref = "f".repeat(64);
    refMismatchedMetadata.envelope = JSON.stringify(
      envelopes.encryptJson(
        active.context,
        "playback-context:v1:" + refMismatchedMetadata.ref
      )
    );
    await client.hSet(
      activeKeys[PROFILE_KEY_INDEX.contexts],
      activeRef,
      JSON.stringify(refMismatchedMetadata)
    );
    assert.equal(await repository.getActiveClaim(profile, device, issued.claim.sessionId), null);
    await client.hSet(activeKeys[PROFILE_KEY_INDEX.contexts], activeRef, originalMetadataRaw);
    assert.deepEqual(
      await repository.getActiveClaim(profile, device, issued.claim.sessionId),
      active
    );

    const differentDigest = (value) => (value[0] === "0" ? "1" : "0") + value.slice(1);
    const protectedMetadataCorruptions = [
      ["equivalenceHash", (metadata) => {
        metadata.equivalenceHash = differentDigest(metadata.equivalenceHash);
      }],
      ["globalMember", (metadata) => {
        metadata.globalMember = differentDigest(metadata.globalMember);
      }],
      ["fingerprintHashes", (metadata) => {
        metadata.fingerprintHashes[0] = differentDigest(metadata.fingerprintHashes[0]);
      }],
      ["fingerprintIndexKeys", (metadata) => {
        metadata.fingerprintIndexKeys[0] += ":corrupt";
      }],
      ["tombstoneMembers", (metadata) => {
        metadata.tombstoneMembers[0] = differentDigest(metadata.tombstoneMembers[0]);
      }],
    ];
    for (const [field, corrupt] of protectedMetadataCorruptions) {
      const corruptedMetadata = JSON.parse(originalMetadataRaw);
      corrupt(corruptedMetadata);
      await client.hSet(
        activeKeys[PROFILE_KEY_INDEX.contexts],
        activeRef,
        JSON.stringify(corruptedMetadata)
      );
      assert.equal(
        await repository.getActiveClaim(profile, device, issued.claim.sessionId),
        null,
        field
      );
      await client.hSet(activeKeys[PROFILE_KEY_INDEX.contexts], activeRef, originalMetadataRaw);
    }
    assert.deepEqual(
      await repository.getActiveClaim(profile, device, issued.claim.sessionId),
      active
    );

    const activeDeviceRef = keyspace.member("playback-device", profile, device);
    const originalCleanupOwner = issued.claim[PLAYBACK_CLAIM_CLEANUP_OWNER];
    assert.equal(typeof originalCleanupOwner, "string");
    assert.equal(Object.keys(issued.claim).includes("cleanupOwner"), false);
    const adopted = await claimPlayback(repository, profile, device, issued.request);
    assert.equal(adopted.sessionId, issued.claim.sessionId);
    assert.notEqual(adopted[PLAYBACK_CLAIM_CLEANUP_OWNER], originalCleanupOwner);
    assert.equal(
      await repository.releaseOwned(
        profile,
        device,
        issued.claim.sessionId,
        originalCleanupOwner
      ),
      false
    );
    assert.equal(
      await repository.commitClaimDisclosure(
        profile,
        device,
        issued.claim.sessionId,
        adopted[PLAYBACK_CLAIM_CLEANUP_OWNER]
      ),
      true
    );
    const adoptedClaimRaw = await client.hGet(
      activeKeys[PROFILE_KEY_INDEX.claims],
      activeDeviceRef
    );
    assert.deepEqual(Object.keys(JSON.parse(adoptedClaimRaw)).sort(), V5_CLAIMED_FIELDS);
    assert.equal(Object.hasOwn(JSON.parse(adoptedClaimRaw), "cleanupOwner"), false);
    const tamperedClaim = JSON.parse(adoptedClaimRaw);
    assert.equal(Object.hasOwn(tamperedClaim, "supersededSessionId"), false);
    assert.equal(typeof tamperedClaim.privateStateEnvelope, "string");
    const tamperedPrivateState = JSON.parse(tamperedClaim.privateStateEnvelope);
    tamperedPrivateState.tag =
      (tamperedPrivateState.tag[0] === "A" ? "B" : "A") + tamperedPrivateState.tag.slice(1);
    tamperedClaim.privateStateEnvelope = JSON.stringify(tamperedPrivateState);
    await client.hSet(
      activeKeys[PROFILE_KEY_INDEX.claims],
      activeDeviceRef,
      JSON.stringify(tamperedClaim)
    );
    assert.equal(await repository.getActiveClaim(profile, device, issued.claim.sessionId), null);
    await client.hSet(activeKeys[PROFILE_KEY_INDEX.claims], activeDeviceRef, adoptedClaimRaw);
    assert.deepEqual(
      await repository.getActiveClaim(profile, device, issued.claim.sessionId),
      active
    );

    assert.equal(
      await repository.getActiveClaim("profile_active_live_other", device, issued.claim.sessionId),
      null
    );
    assert.equal(
      await repository.getActiveClaim(profile, "device_active_live_other", issued.claim.sessionId),
      null
    );
    assert.equal(
      await repository.getActiveClaim(profile, device, "session_active_live_wrong"),
      null
    );
    assert.equal(await repository.release(profile, device, issued.claim.sessionId), true);
    assert.equal(await repository.getActiveClaim(profile, device, issued.claim.sessionId), null);

    const expiredProfile = "profile_active_live_expired";
    const expiredDevice = "device_active_live_expired";
    const expired = await issue(
      expiredProfile,
      expiredDevice,
      "https://cdn.example/active-expired.mkv",
      "tt5000002"
    );
    const expiredKeys = repository._profileKeys(expiredProfile);
    const expiredDeviceRef = keyspace.member("playback-device", expiredProfile, expiredDevice);
    const expiredRaw = await client.hGet(
      expiredKeys[PROFILE_KEY_INDEX.claims],
      expiredDeviceRef
    );
    const expiredMetadata = JSON.parse(expiredRaw);
    const dueAt = (await runner.timeMs()) - 1;
    expiredMetadata.expiresAtMs = String(dueAt);
    await client.hSet(
      expiredKeys[PROFILE_KEY_INDEX.claims],
      expiredDeviceRef,
      JSON.stringify(expiredMetadata)
    );
    await client.zAdd(expiredKeys[PROFILE_KEY_INDEX.claimExpiries], {
      score: dueAt,
      value: expiredDeviceRef,
    });
    await client.zAdd(expiredKeys[PROFILE_KEY_INDEX.globalClaims], {
      score: dueAt,
      value: expiredMetadata.globalMember,
    });
    assert.equal(
      await repository.getActiveClaim(expiredProfile, expiredDevice, expired.claim.sessionId),
      null
    );

    const staleProfile = "profile_active_live_stale";
    const staleDevice = "device_active_live_stale";
    const stale = await issue(
      staleProfile,
      staleDevice,
      "https://cdn.example/active-stale.mkv",
      "tt5000003"
    );
    const staleKeys = repository._profileKeys(staleProfile);
    await client.set(staleKeys[PROFILE_KEY_INDEX.generation], "g1:stale-generation");
    assert.equal(
      await repository.getActiveClaim(staleProfile, staleDevice, stale.claim.sessionId),
      null
    );

    const missingProfile = "profile_active_live_missing";
    const missingDevice = "device_active_live_missing";
    const missing = await issue(
      missingProfile,
      missingDevice,
      "https://cdn.example/active-missing.mkv",
      "tt5000004"
    );
    const missingKeys = repository._profileKeys(missingProfile);
    const missingDeviceRef = keyspace.member("playback-device", missingProfile, missingDevice);
    const missingClaim = JSON.parse(
      await client.hGet(missingKeys[PROFILE_KEY_INDEX.claims], missingDeviceRef)
    );
    await client.hDel(missingKeys[PROFILE_KEY_INDEX.contexts], missingClaim.contextRef);
    assert.equal(
      await repository.getActiveClaim(missingProfile, missingDevice, missing.claim.sessionId),
      null
    );

    assert.equal((await rawRedisText(client, prefix)).includes("live-inline-header-secret"), false);
  });
});

redisTest("REDIS_URL concurrent claims authenticate exact immediate supersession", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPlaybackContextRepository({
      writeVersion: "4",
      client,
      keyspace,
      envelopeCrypto: envelopeCrypto(),
      sourceContextOptions: {
        idFactory: sequentialIds(),
        ttlMs: 60 * 1000,
        tombstoneTtlMs: 10 * 1000,
      },
    });
    const runner = new RedisScriptRunner(client);
    const profile = "profile_supersession_live_0001";
    const device = "device_supersession_live_0001";
    const url = "https://cdn.example/supersession-live.mkv";
    const recorded = await repository.record(profile, playbackContext(url, "tt5000010"));
    const launchedAt = await runner.timeMs();
    const first = await claimPlayback(repository, profile, device, claimRequest(url, launchedAt));
    const [second, third] = await Promise.all([
      claimPlayback(repository, profile, device, claimRequest(url, launchedAt + 1)),
      claimPlayback(repository, profile, device, claimRequest(url, launchedAt + 2)),
    ]);

    assert.equal(first.status, "claimed");
    assert.equal(third.status, "claimed");
    assert.equal(Object.hasOwn(second, "supersededSessionId"), false);
    assert.equal(Object.hasOwn(third, "supersededSessionId"), false);
    const expectedSuperseded = second.status === "claimed" ? second.sessionId : first.sessionId;
    const active = await repository.getActiveClaim(profile, device, third.sessionId);
    assert.equal(active.deliveryBinding.contextId, recorded.contextId);
    assert.equal(active.deliveryBinding.supersededSessionId, expectedSuperseded);
    assert.equal(Object.hasOwn(active, "supersededSessionId"), false);
    assert.equal(Object.isFrozen(active), true);

    const keys = repository._profileKeys(profile);
    const deviceRef = keyspace.member("playback-device", profile, device);
    const rawClaim = await client.hGet(keys[PROFILE_KEY_INDEX.claims], deviceRef);
    assert.equal(rawClaim.includes(expectedSuperseded), false);
    assert.equal(JSON.parse(rawClaim).supersededSessionId, undefined);
    assert.equal(await repository.getActiveClaim(profile, device, first.sessionId), null);
    if (second.status === "claimed") {
      assert.equal(await repository.getActiveClaim(profile, device, second.sessionId), null);
    }
  });
});

redisTest("REDIS_URL pairing finalizes and safely replays one consumed activation", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const tokens = tokenService();
    const envelopes = envelopeCrypto();
    const repository = new RedisPairingRepository({
      client,
      keyspace,
      tokenService: tokens,
      envelopeCrypto: envelopes,
      idFactory: sequentialIds(),
      ttlMs: 60 * 1000,
      tombstoneTtlMs: 10 * 1000,
    });
    const issued = await repository.issue({ deviceName: "Integration TV" });
    const stableActivation = { installId: "install_pairing_0001" };
    const profileId = "profile_pairing_0001";
    const retryToken = activationRetryToken();
    const activating = await repository.activate(
      issued.userCode,
      {
        ...stableActivation,
        profileId: "profile_caller_ignored",
      },
      { activationRetryToken: retryToken }
    );
    assert.equal(activating.status, "activating");
    assert.match(activating.activation.deviceToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Object.hasOwn(activating.activation, "profileId"), false);

    const retry = await repository.activate(
      issued.userCode,
      {
        ...stableActivation,
        profileId: "profile_other_ignored",
        deviceToken: "caller-token-is-ignored",
      },
      { activationRetryToken: retryToken }
    );
    assert.equal(retry.activation.deviceToken, activating.activation.deviceToken);
    await assert.rejects(
      () =>
        repository.activate(
          issued.userCode,
          { installId: "install_pairing_0002" },
          { activationRetryToken: retryToken }
        ),
      (error) => error.code === "pairing_conflict"
    );

    const completed = await repository.completeActivation(
      activating.pairingId,
      activating.activationDigest,
      {
      profileId,
      }
    );
    assert.equal(completed.activation.profileId, profileId);
    assert.equal(completed.activation.deviceToken, activating.activation.deviceToken);
    assert.equal(
      (
        await repository.completeActivation(activating.pairingId, activating.activationDigest, {
          profileId,
        })
      ).status,
      "activated"
    );
    await assert.rejects(
      () =>
        repository.completeActivation(activating.pairingId, activating.activationDigest, {
          profileId: "profile_pairing_0002",
        }),
      (error) => error.code === "pairing_conflict"
    );
    const completedRetry = await repository.activate(
      issued.userCode,
      {
        ...stableActivation,
        profileId: "profile_other_ignored",
      },
      { activationRetryToken: retryToken }
    );
    assert.equal(completedRetry.status, "activated");
    assert.equal(completedRetry.activation.deviceToken, activating.activation.deviceToken);
    assert.equal(completedRetry.activation.profileId, profileId);

    const recordKey = keyspace.key("pairing-record-v2", issued.pairingId);
    const deviceKey = keyspace.key(
      "pairing-device-v2",
      tokens.hashToken("pair-device", issued.deviceCode)
    );
    const validEnvelope = await client.hGet(recordKey, "activationEnvelope");
    assert.equal(validEnvelope.includes(activating.activation.deviceToken), false);
    const missingKeyEnvelope = { ...JSON.parse(validEnvelope), kid: "missing" };
    await client.hSet(recordKey, "activationEnvelope", JSON.stringify(missingKeyEnvelope));

    await assert.rejects(() => repository.redeem(issued.deviceCode), /key is unavailable/);
    assert.equal(await client.hGet(recordKey, "state"), "activated");
    assert.equal(
      await client.hGet(recordKey, "activationEnvelope"),
      JSON.stringify(missingKeyEnvelope)
    );

    const parsedEnvelope = JSON.parse(validEnvelope);
    const corruptEnvelope = {
      ...parsedEnvelope,
      ct: (parsedEnvelope.ct.startsWith("A") ? "B" : "A") + parsedEnvelope.ct.slice(1),
    };
    await client.hSet(recordKey, "activationEnvelope", JSON.stringify(corruptEnvelope));
    await assert.rejects(() => repository.redeem(issued.deviceCode), /authentication failed/);
    assert.equal(await client.hGet(recordKey, "state"), "activated");

    await client.hSet(recordKey, "activationEnvelope", validEnvelope);
    const results = await Promise.all([
      repository.redeem(issued.deviceCode),
      repository.redeem(issued.deviceCode),
    ]);
    assert.deepEqual(results.map((result) => result.status), ["redeemed", "redeemed"]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0].activation, completedRetry.activation);
    const recordTtlBeforeReplay = await client.pTTL(recordKey);
    const deviceTtlBeforeReplay = await client.pTTL(deviceKey);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(await repository.redeem(issued.deviceCode), results[0]);
    assert.ok((await client.pTTL(recordKey)) < recordTtlBeforeReplay);
    assert.ok((await client.pTTL(deviceKey)) < deviceTtlBeforeReplay);
    assert.equal(await client.hGet(recordKey, "state"), "consumed");
    assert.equal(await client.hGet(recordKey, "activationEnvelope"), validEnvelope);

    await client.pExpire(recordKey, 5);
    await client.pExpire(deviceKey, 5);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await repository.redeem(issued.deviceCode)).status, "not_found");
  });
});

redisTest("REDIS_URL pairing protocol gate rejects active legacy state and blocks old writers", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPairingRepository({
      client,
      keyspace,
      tokenService: tokenService(),
      envelopeCrypto: envelopeCrypto(),
    });
    const legacyGlobal = keyspace.key("pairing-global", "active");
    const now = await new RedisScriptRunner(client).timeMs();
    await client.zAdd(legacyGlobal, { score: now + 60 * 1000, value: "legacy-record" });
    await assert.rejects(
      repository.assertProtocol(),
      (error) => error.code === "pairing_mixed_version"
    );
    await client.del(legacyGlobal);
    await client.zAdd(legacyGlobal, { score: now - 1, value: "expired-legacy-record" });
    assert.equal(await repository.assertProtocol(), true);
    assert.equal(await client.type(legacyGlobal), "string");
    assert.equal(await client.get(legacyGlobal), "pairing-replay-v2");
    await assert.rejects(
      client.zAdd(legacyGlobal, { score: now + 1, value: "old-writer" }),
      /WRONGTYPE/
    );
  });
});

redisTest("REDIS_URL pairing retry and management replay races remain private and non-reminting", async (t) => {
  await withRedis(t, async ({ client, keyspace, prefix }) => {
    const tokens = tokenService();
    const envelopes = envelopeCrypto();
    const pairings = new RedisPairingRepository({
      client,
      keyspace,
      tokenService: tokens,
      envelopeCrypto: envelopes,
      idFactory: sequentialIds(),
      ttlMs: 60 * 1000,
      activationRetryTtlMs: 10 * 60 * 1000,
    });
    const issued = await pairings.issue();
    const retryToken = activationRetryToken(0x77);
    const otherToken = activationRetryToken(0x78);
    const stableActivation = { installId: "install_pairing_race_0001" };
    const sameToken = await Promise.all([
      pairings.activate(issued.userCode, stableActivation, {
        activationRetryToken: retryToken,
      }),
      pairings.activate(issued.userCode, stableActivation, {
        activationRetryToken: retryToken,
      }),
    ]);
    assert.deepEqual(sameToken[1], sameToken[0]);
    assert.equal(sameToken[0].activationRetryExpiresAt, issued.expiresAt);
    assert.deepEqual(
      await pairings.activate(issued.userCode, stableActivation, {
        activationRetryToken: otherToken,
      }),
      { status: "not_found" }
    );
    await assert.rejects(
      pairings.recoverActivation(retryToken, { installId: "changed" }),
      (error) => error.code === "pairing_conflict"
    );

    const profileId = "profile_pairing_replay_live_0001";
    await pairings.completeActivation(
      sameToken[0].pairingId,
      sameToken[0].activationDigest,
      { profileId }
    );
    const management = new RedisManagementSessionRepository({
      client,
      keyspace,
      tokenService: tokens,
      envelopeCrypto: envelopes,
      ttlMs: 1000,
      isProfileActive: async () => true,
    });
    const runner = new RedisScriptRunner(client);
    const now = await runner.timeMs();
    const managementInput = {
      pairingId: sameToken[0].pairingId,
      profileId,
      configHash: "a".repeat(64),
      activationRetryToken: retryToken,
      activationRetryExpiresAt: now + 5000,
      authority: {
        schemaVersion: 1,
        profileId,
        installToken: "private-live-install-authority",
      },
    };
    const [first, second] = await Promise.all([
      management.issueForPairing(managementInput),
      management.issueForPairing(managementInput),
    ]);
    assert.deepEqual([first.status, second.status].sort(), ["issued", "replayed"]);
    assert.equal(second.sessionToken, first.sessionToken);
    assert.equal(second.csrfToken, first.csrfToken);
    assert.equal(second.expiresAt, first.expiresAt);
    assert.equal(
      await client.zCard(keyspace.key("management-global", "sessions")),
      1
    );
    const recovered = await management.recoverPairing(managementInput);
    assert.equal(recovered.sessionToken, first.sessionToken);
    assert.equal(recovered.csrfToken, first.csrfToken);

    let raw = await rawRedisText(client, prefix);
    for (const secret of [
      retryToken,
      otherToken,
      first.sessionToken,
      first.csrfToken,
      "private-live-install-authority",
      sameToken[0].activation.deviceToken,
    ]) {
      assert.equal(raw.includes(secret), false);
    }

    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(await management.recoverPairing(managementInput), { status: "denied" });
    assert.deepEqual(await management.issueForPairing(managementInput), { status: "denied" });
    assert.equal(
      await client.zCard(keyspace.key("management-global", "sessions")),
      0
    );
    raw = await rawRedisText(client, prefix);
    assert.equal(raw.includes("authorityEnvelope"), false);

    const boundaryIssued = await pairings.issue();
    const boundaryRetryToken = activationRetryToken(0x79);
    const boundaryActivation = await pairings.activate(
      boundaryIssued.userCode,
      { installId: "install_pairing_boundary_live_0001" },
      { activationRetryToken: boundaryRetryToken }
    );
    assert.equal(boundaryActivation.activationRetryExpiresAt, boundaryIssued.expiresAt);
    const boundaryRecordKey = keyspace.key(
      "pairing-record-v2",
      boundaryActivation.pairingId
    );
    await client.hSet(boundaryRecordKey, "expiresAt", String(await runner.timeMs()));
    assert.deepEqual(
      await pairings.completeActivation(
        boundaryActivation.pairingId,
        boundaryActivation.activationDigest,
        { profileId: "profile_pairing_boundary_live_0001" }
      ),
      { status: "expired" }
    );
    assert.deepEqual(
      await pairings.recoverActivation(boundaryRetryToken, {
        installId: "install_pairing_boundary_live_0001",
      }),
      { status: "expired" }
    );
  });
});

redisTest("REDIS_URL management pairing issue and revoke prune expired global members by Redis TIME", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const tokens = tokenService();
    const management = new RedisManagementSessionRepository({
      client,
      keyspace,
      tokenService: tokens,
      envelopeCrypto: envelopeCrypto(),
      ttlMs: 1000,
      pairingReplayTtlMs: 10_000,
      maxSessions: 1,
      maxSessionsPerProfile: 1,
      isProfileActive: async () => true,
    });
    const runner = new RedisScriptRunner(client);
    const now = await runner.timeMs();
    const staleSessionKey = keyspace.key("management-session", "expired-capacity-member");
    await client.zAdd(management._globalKey, { score: now - 1, value: staleSessionKey });

    const input = {
      pairingId: "pairing_management_expiry_live_0001",
      profileId: "profile_management_expiry_live_0001",
      configHash: "b".repeat(64),
      activationRetryToken: activationRetryToken(0x7a),
      activationRetryExpiresAt: now + 10_000,
      authority: {
        schemaVersion: 1,
        profileId: "profile_management_expiry_live_0001",
        installToken: "private-management-expiry-authority",
      },
    };
    const issued = await management.issueForPairing(input);
    assert.equal(issued.status, "issued");
    assert.equal(await client.zScore(management._globalKey, staleSessionKey), null);

    const sessionHash = tokens.hashToken("management-session", issued.sessionToken);
    const sessionKey = management._sessionKey(sessionHash);
    assert.notEqual(await client.zScore(management._globalKey, sessionKey), null);
    await client.del(sessionKey);
    await client.zAdd(management._globalKey, { score: (await runner.timeMs()) - 1, value: sessionKey });

    assert.deepEqual(await management.revokePairing(input), { status: "revoked" });
    assert.equal(await client.zScore(management._globalKey, sessionKey), null);
    assert.deepEqual(await management.recoverPairing(input), { status: "denied" });
  });
});

redisTest("REDIS_URL legacy completion can finalize once and blocks redemption until then", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const repository = new RedisPairingRepository({
      client,
      keyspace,
      tokenService: tokenService(),
      envelopeCrypto: envelopeCrypto(),
      idFactory: sequentialIds(),
      ttlMs: 60 * 1000,
      tombstoneTtlMs: 10 * 1000,
    });
    const issued = await repository.issue();
    const activating = await repository.activate(
      issued.userCode,
      { installId: "install_legacy_pairing_0001" },
      { activationRetryToken: activationRetryToken(0x72) }
    );
    const legacyCompletion = await repository.completeActivation(
      activating.pairingId,
      activating.activationDigest
    );
    assert.equal(legacyCompletion.status, "activated");
    assert.equal(Object.hasOwn(legacyCompletion.activation, "profileId"), false);
    const earlyRedemption = await repository.redeem(issued.deviceCode);
    assert.equal(earlyRedemption.status, "pending");
    assert.equal(earlyRedemption.activationState, "activated");

    const profileId = "profile_legacy_pairing_0001";
    const finalized = await repository.completeActivation(
      activating.pairingId,
      activating.activationDigest,
      { profileId }
    );
    assert.equal(finalized.activation.profileId, profileId);
    assert.equal(finalized.activation.deviceToken, activating.activation.deviceToken);
    assert.equal(
      (
        await repository.completeActivation(
          activating.pairingId,
          activating.activationDigest,
          { profileId }
        )
      ).activation.profileId,
      profileId
    );
    await assert.rejects(
      repository.completeActivation(activating.pairingId, activating.activationDigest, {
        profileId: "profile_legacy_pairing_0002",
      }),
      (error) => error.code === "pairing_conflict"
    );
    const redeemed = await repository.redeem(issued.deviceCode);
    assert.equal(redeemed.status, "redeemed");
    assert.equal(redeemed.activation.profileId, profileId);
  });
});

redisTest("REDIS_URL concurrent same-profile finalization is idempotent", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const runner = new RedisScriptRunner(client);
    let gateCompletions = false;
    let expireAtCommitBoundary = false;
    let waiting = 0;
    let releaseCompletions;
    let completionBarrier;
    const resetCompletionBarrier = () => {
      waiting = 0;
      completionBarrier = new Promise((resolve) => {
        releaseCompletions = resolve;
      });
    };
    resetCompletionBarrier();
    const scriptRunner = {
      timeMs: () => runner.timeMs(),
      async run(name, keys, args) {
        if (gateCompletions && name === "pairingComplete") {
          waiting += 1;
          if (waiting === 2) {
            if (expireAtCommitBoundary) {
              await client.hSet(keys[0], "expiresAt", String(await runner.timeMs()));
            }
            releaseCompletions();
          }
          await completionBarrier;
        }
        return runner.run(name, keys, args);
      },
    };
    const repository = new RedisPairingRepository({
      client,
      keyspace,
      scriptRunner,
      tokenService: tokenService(),
      envelopeCrypto: envelopeCrypto(),
      idFactory: sequentialIds(),
      ttlMs: 60 * 1000,
      tombstoneTtlMs: 10 * 1000,
    });
    const issued = await repository.issue();
    const activating = await repository.activate(
      issued.userCode,
      { installId: "install_concurrent_pairing_0001" },
      { activationRetryToken: activationRetryToken(0x73) }
    );
    await repository.completeActivation(activating.pairingId, activating.activationDigest);

    gateCompletions = true;
    const profileId = "profile_concurrent_pairing_0001";
    const results = await Promise.all([
      repository.completeActivation(activating.pairingId, activating.activationDigest, {
        profileId,
      }),
      repository.completeActivation(activating.pairingId, activating.activationDigest, {
        profileId,
      }),
    ]);
    gateCompletions = false;
    assert.equal(waiting, 2);
    assert.deepEqual(results[0].activation, results[1].activation);
    assert.equal(results[0].activation.profileId, profileId);

    const expiringIssued = await repository.issue();
    const expiringActivation = await repository.activate(
      expiringIssued.userCode,
      { installId: "install_concurrent_expiry_0001" },
      { activationRetryToken: activationRetryToken(0x75) }
    );
    resetCompletionBarrier();
    expireAtCommitBoundary = true;
    gateCompletions = true;
    const expired = await Promise.all([
      repository.completeActivation(
        expiringActivation.pairingId,
        expiringActivation.activationDigest,
        { profileId: "profile_concurrent_expiry_0001" }
      ),
      repository.completeActivation(
        expiringActivation.pairingId,
        expiringActivation.activationDigest,
        { profileId: "profile_concurrent_expiry_0001" }
      ),
    ]);
    gateCompletions = false;
    assert.equal(waiting, 2);
    assert.deepEqual(expired, [{ status: "expired" }, { status: "expired" }]);
    assert.equal(
      await client.hGet(
        keyspace.key("pairing-record-v2", expiringActivation.pairingId),
        "finalizationHash"
      ),
      null
    );
  });
});

redisTest("REDIS_URL PairingCoordinator receives finalized Redis activation end to end", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const tokens = tokenService();
    const envelopes = envelopeCrypto();
    const pairings = new RedisPairingRepository({
      client,
      keyspace,
      tokenService: tokens,
      envelopeCrypto: envelopes,
      idFactory: sequentialIds(),
      ttlMs: 60 * 1000,
      tombstoneTtlMs: 10 * 1000,
    });
    const configBlob = "R".repeat(64);
    const config = {
      profileId: "configured_profile_redis_0001",
      name: "Redis integration room",
      settings: { subtitles_enabled: true },
    };
    const profileId = "profile_coordinator_redis_0001";
    let registered;
    const devices = {
      async register(registeredProfileId, input) {
        registered = {
          id: input.deviceId,
          profileId: registeredProfileId,
          token: input.deviceToken,
          generation: 1,
        };
        return {
          device: {
            id: registered.id,
            profileId: registered.profileId,
            generation: registered.generation,
          },
          deviceToken: registered.token,
        };
      },
      async authenticate(deviceToken) {
        if (!registered || deviceToken !== registered.token) return null;
        return {
          id: registered.id,
          profileId: registered.profileId,
          generation: registered.generation,
        };
      },
      async list(registeredProfileId) {
        return registered && registered.profileId === registeredProfileId ? [registered] : [];
      },
      async revoke() {
        return false;
      },
      async revokeWithInvalidation() {
        return { revoked: false, invalidation: null };
      },
      async getGeneration(registeredProfileId, deviceId) {
        return registered && registered.profileId === registeredProfileId && registered.id === deviceId
          ? registered.generation
          : null;
      },
      async isActiveBinding(registeredProfileId, deviceId, generation) {
        return Boolean(
          registered &&
          registered.profileId === registeredProfileId &&
          registered.id === deviceId &&
          registered.generation === generation
        );
      },
      async commitDisclosure(_profileId, _deviceId, _profileRevision, _generation, emitSync) {
        return emitSync();
      },
      async withClaimAdmission(
        registeredProfileId,
        deviceId,
        _profileRevision,
        generation,
        operation
      ) {
        if (!(await this.isActiveBinding(registeredProfileId, deviceId, generation))) {
          throw new Error("device generation changed");
        }
        return operation();
      },
    };
    const coordinator = new PairingCoordinator({
      pairings,
      devices,
      managementSessions: new RedisManagementSessionRepository({
        client,
        keyspace,
        tokenService: tokens,
        envelopeCrypto: envelopes,
        isProfileActive: async () => true,
      }),
      profiles: {
        async getById(id) {
          return id === profileId ? { id, status: "active", revision: 1 } : null;
        },
      },
      profileProvisioner: {
        async provision() {
          return {
            profile: { id: profileId, displayName: config.name, revision: 1 },
            installToken: "install_token_coordinator_redis_0001",
            identityHash: deriveProfileIdentityHash(config, configBlob),
            configHash: hashConfigBlob(configBlob),
          };
        },
      },
      decryptConfig: () => JSON.parse(JSON.stringify(config)),
      allowInsecureLoopback: true,
    });

    const issued = await coordinator.issue({ deviceName: "Redis coordinator TV" });
    const activated = await coordinator.activate({
      userCode: issued.userCode,
      configBlob,
      bridgeBaseUrl: "http://127.0.0.1:7515/_c/" + configBlob,
      activationRetryToken: activationRetryToken(0x74),
    });
    assert.equal(activated.status, "activated");
    assert.equal(activated.profileId, profileId);
    let disclosure = null;
    const redeemed = await coordinator.redeem(issued.deviceCode, (value) => {
      disclosure = value;
    });
    assert.equal(redeemed.status, "redeemed");
    assert.equal(disclosure.profileId, profileId);
    assert.equal(disclosure.deviceToken, registered.token);
  });
});

redisTest("REDIS_URL OAuth corruption is retryable and concurrent consume succeeds once", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const tokens = tokenService();
    const profile = "profile_oauth_redis_0001";
    const management = new RedisManagementSessionRepository({
      client,
      keyspace,
      tokenService: tokenService(),
    });
    const managementSession = await management.issue(profile);
    const managementBinding = await management.authenticate(
      managementSession.sessionToken,
      managementSession.csrfToken
    );
    assert.equal(managementBinding.managementGeneration, 0);
    const repository = new RedisOAuthStateRepository({
      client,
      keyspace,
      tokenService: tokens,
      envelopeCrypto: envelopeCrypto(),
      ttlMs: 60 * 1000,
    });
    const issued = await repository.issue(
      profile,
      { nonce: "oauth-integration" },
      { managementGeneration: managementBinding.managementGeneration }
    );
    const stateHash = tokens.hashToken("oauth-state", issued.stateToken);
    const stateKey = keyspace.key("oauth-state", stateHash);
    assert.equal(stateKey.includes(issued.stateToken), false);
    assert.equal(stateKey.includes(issued.browserBindingToken), false);
    const validEnvelope = await client.hGet(stateKey, "payloadEnvelope");
    const missingKeyEnvelope = { ...JSON.parse(validEnvelope), kid: "missing" };
    await client.hSet(stateKey, "payloadEnvelope", JSON.stringify(missingKeyEnvelope));
    await assert.rejects(
      repository.consume(issued.stateToken, issued.browserBindingToken),
      /key is unavailable/
    );
    assert.equal(await client.exists(stateKey), 1);

    const parsedEnvelope = JSON.parse(validEnvelope);
    const corruptEnvelope = {
      ...parsedEnvelope,
      ct: (parsedEnvelope.ct.startsWith("A") ? "B" : "A") + parsedEnvelope.ct.slice(1),
    };
    await client.hSet(stateKey, "payloadEnvelope", JSON.stringify(corruptEnvelope));
    await assert.rejects(
      repository.consume(issued.stateToken, issued.browserBindingToken),
      /authentication failed/
    );
    assert.equal(await client.exists(stateKey), 1);

    await client.hSet(stateKey, "payloadEnvelope", validEnvelope);
    const results = await Promise.all([
      repository.consume(issued.stateToken, issued.browserBindingToken),
      repository.consume(issued.stateToken, issued.browserBindingToken),
    ]);
    assert.equal(results.filter((result) => result !== null).length, 1);
    assert.equal(results.filter((result) => result === null).length, 1);
    assert.deepEqual(results.find((result) => result !== null).payload, {
      nonce: "oauth-integration",
    });
    assert.equal(await client.exists(stateKey), 0);

    const stale = await repository.issue(
      profile,
      { nonce: "must-not-survive-revocation" },
      { managementGeneration: managementBinding.managementGeneration }
    );
    await management.revokeProfile(profile);
    assert.equal(await repository.consume(stale.stateToken, stale.browserBindingToken), null);
    await assert.rejects(
      () => repository.issue(
        profile,
        { nonce: "must-not-be-issued" },
        { managementGeneration: managementBinding.managementGeneration }
      ),
      (error) => error.code === "profile_inactive"
    );
  });
});

redisTest("REDIS_URL issuance cleanup refreshes expired pairing replay tombstones", async (t) => {
  await withRedis(t, async ({ client, keyspace }) => {
    const tokens = tokenService();
    const tombstoneTtlMs = 10 * 1000;
    const repository = new RedisPairingRepository({
      client,
      keyspace,
      tokenService: tokens,
      envelopeCrypto: envelopeCrypto(),
      idFactory: sequentialIds(),
      ttlMs: 60 * 1000,
      tombstoneTtlMs,
    });
    const expired = await repository.issue();
    const recordKey = keyspace.key("pairing-record-v2", expired.pairingId);
    const deviceKey = keyspace.key(
      "pairing-device-v2",
      tokens.hashToken("pair-device", expired.deviceCode)
    );
    const now = await new RedisScriptRunner(client).timeMs();
    await client.hSet(recordKey, "expiresAt", String(now - 1));
    await client.zAdd(keyspace.key("pairing-global-v2", "active"), {
      score: now - 1,
      value: recordKey,
    });
    await client.pExpire(recordKey, 500);
    await client.pExpire(deviceKey, 500);

    await repository.issue();
    assert.equal(await client.hGet(recordKey, "state"), "expired");
    assert.ok((await client.pTTL(recordKey)) > tombstoneTtlMs - 2000);
    assert.ok((await client.pTTL(deviceKey)) > tombstoneTtlMs - 2000);
    assert.equal((await repository.redeem(expired.deviceCode)).status, "expired");
  });
});
