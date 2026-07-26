"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createClient } = require("redis");

const {
  invalidateProviderSnapshot,
  readProviderCollectionSnapshot,
  replaceProviderCollection,
} = require("../lib/source-context");
const { EnvelopeCrypto } = require("../lib/storage/envelope-crypto");
const {
  RedisKeyspace,
  RedisPlaybackContextRepository,
} = require("../lib/storage/redis");
const { createSqliteRepositories } = require("../lib/storage/sqlite");
const { TokenService } = require("../lib/storage/token-service");

let Database = null;
try {
  Database = require("better-sqlite3");
} catch (_error) {
  // The live mixed-store contract is skipped only when the optional native driver is unavailable.
}

const REDIS_URL = process.env.REDIS_URL;
const skipReason = !REDIS_URL
  ? "REDIS_URL is not configured"
  : !Database
    ? "better-sqlite3 is not installed"
    : false;

function sequenceRandom(seed = 1) {
  let value = seed;
  return (length) => {
    const output = Buffer.alloc(length, value);
    value = value === 255 ? 1 : value + 1;
    return output;
  };
}

function descriptor(name) {
  return {
    transportUrl: "https://" + name + ".example/manifest.json",
    manifest: {
      id: "org.example." + name,
      version: "1.0.0",
      name,
      types: ["movie"],
      resources: ["stream"],
    },
  };
}

async function cleanRedisPrefix(client, prefix) {
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, { MATCH: prefix + ":*", COUNT: 100 });
    cursor = String(reply.cursor);
    if (reply.keys.length > 0) await client.del(reply.keys);
  } while (cursor !== "0");
}

test(
  "real Redis and SQLite recover provider snapshots without stale writes or revocation leaks",
  { skip: skipReason },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-provider-recovery-"));
    const database = new Database(path.join(directory, "storage.sqlite3"));
    let profileSequence = 0;
    let providerSequence = 0;
    const repositories = createSqliteRepositories(database, {
      tokenService: new TokenService({
        pepper: Buffer.alloc(32, 0x4a),
        randomBytes: sequenceRandom(1),
      }),
      envelopeCrypto: new EnvelopeCrypto({
        primaryKeyId: "mixed-store",
        keys: { "mixed-store": Buffer.alloc(32, 0x5b) },
        randomBytes: sequenceRandom(0x20),
      }),
      profileIdFactory: () =>
        "profile_mixed_store_" + String(++profileSequence).padStart(4, "0"),
      providerIdFactory: () =>
        "provider_mixed_store_" + String(++providerSequence).padStart(4, "0"),
    });
    const prefix = "jg:v" + Date.now() + process.pid;
    const keyspace = new RedisKeyspace(prefix);
    const client = createClient({ url: REDIS_URL });
    client.on("error", () => {});
    await client.connect();
    t.after(async () => {
      try {
        await cleanRedisPrefix(client, prefix);
      } finally {
        if (client.isOpen) await client.quit();
        if (database.open) database.close();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
    let generationSequence = 0;
    const playbackContexts = new RedisPlaybackContextRepository({
      client,
      keyspace,
      envelopeCrypto: new EnvelopeCrypto({
        primaryKeyId: "mixed-redis",
        keys: { "mixed-redis": Buffer.alloc(32, 0x6c) },
        randomBytes: sequenceRandom(0x40),
      }),
      generationFactory: () =>
        "g1:mixed_store_" + String(++generationSequence).padStart(8, "0"),
      sourceContextOptions: {
        idFactory: (kind) => kind + "_mixed_store_0001",
        providerMutationLeaseMs: 50,
      },
    });

    const preCommit = await repositories.profiles.create({ displayName: "Pre-commit" });
    const preCommitId = preCommit.profile.id;
    const preCommitToken = await playbackContexts.beginProviderSnapshotMutation(preCommitId);
    const preCommitFence = await playbackContexts.fenceProviderSnapshotMutation(
      preCommitId,
      preCommitToken,
      await repositories.providers.allocateMutationFence(preCommitId)
    );
    await client.hSet(
      playbackContexts._providerSnapshotStateKey(preCommitId),
      "expiresAtMs",
      "0"
    );
    const recoveredReads = await Promise.all(
      Array.from({ length: 4 }, () =>
        readProviderCollectionSnapshot(repositories.providers, playbackContexts, preCommitId)
      )
    );
    assert.equal(new Set(recoveredReads.map((item) => item.generation)).size, 1);
    assert.deepEqual(
      recoveredReads.map((item) => item.collection),
      Array.from({ length: 4 }, () => ({ revision: 0, providers: [] }))
    );
    await assert.rejects(
      repositories.providers.replaceAll(preCommitId, [descriptor("stale")], 0, {
        mutationFence: preCommitFence.fence,
      }),
      (error) => error.code === "provider_snapshot_stale_fence"
    );
    await assert.rejects(
      playbackContexts.completeProviderSnapshotMutation(preCommitId, preCommitToken),
      (error) => error.code === "provider_snapshot_changed"
    );

    const clearToken = await playbackContexts.beginProviderSnapshotMutation(preCommitId);
    await playbackContexts.fenceProviderSnapshotMutation(
      preCommitId,
      clearToken,
      await repositories.providers.allocateMutationFence(preCommitId)
    );
    await client.hSet(
      playbackContexts._providerSnapshotStateKey(preCommitId),
      "expiresAtMs",
      "0"
    );
    const clearedGeneration = await invalidateProviderSnapshot(
      playbackContexts,
      repositories.providers,
      preCommitId
    );
    assert.deepEqual(await playbackContexts.getProviderSnapshotState(preCommitId), {
      generation: clearedGeneration,
      pending: false,
    });

    const postCommit = await repositories.profiles.create({ displayName: "Post-commit" });
    const postCommitId = postCommit.profile.id;
    const committedDescriptor = descriptor("committed");
    const postCommitToken = await playbackContexts.beginProviderSnapshotMutation(postCommitId);
    const postCommitFence = await playbackContexts.fenceProviderSnapshotMutation(
      postCommitId,
      postCommitToken,
      await repositories.providers.allocateMutationFence(postCommitId)
    );
    await repositories.providers.replaceAll(postCommitId, [committedDescriptor], 0, {
      mutationFence: postCommitFence.fence,
    });
    await client.hSet(
      playbackContexts._providerSnapshotStateKey(postCommitId),
      "expiresAtMs",
      "0"
    );
    const postCommitReads = await Promise.all(
      Array.from({ length: 4 }, () =>
        readProviderCollectionSnapshot(repositories.providers, playbackContexts, postCommitId)
      )
    );
    for (const snapshot of postCommitReads) {
      assert.equal(snapshot.collection.revision, 1);
      assert.deepEqual(
        snapshot.collection.providers.map((item) => item.descriptor),
        [committedDescriptor]
      );
    }
    await assert.rejects(
      playbackContexts.completeProviderSnapshotMutation(postCommitId, postCommitToken),
      (error) => error.code === "provider_snapshot_changed"
    );

    const reset = await repositories.profiles.create({ displayName: "Redis reset" });
    const resetId = reset.profile.id;
    await repositories.providers.advanceMutationFence(resetId, "100");
    const oldToken = await playbackContexts.beginProviderSnapshotMutation(resetId);
    const oldFence = await playbackContexts.fenceProviderSnapshotMutation(
      resetId,
      oldToken,
      await repositories.providers.allocateMutationFence(resetId)
    );
    assert.equal(oldFence.fence, "101");
    assert.equal(
      await client.sendCommand([
        "DEL",
        playbackContexts._generationKey(resetId),
        playbackContexts._providerSnapshotStateKey(resetId),
        playbackContexts._providerSnapshotFenceKey(resetId),
      ]),
      3
    );
    assert.deepEqual(
      await replaceProviderCollection(
        repositories.providers,
        playbackContexts,
        resetId,
        [descriptor("after-reset")],
        0
      ),
      { revision: 1, count: 1 }
    );
    assert.equal(repositories.providers.storageSnapshot(resetId).mutationFence, "102");
    await assert.rejects(
      repositories.providers.replaceAll(resetId, [descriptor("old-writer")], 0, {
        mutationFence: oldFence.fence,
      }),
      (error) => error.code === "provider_snapshot_stale_fence"
    );

    const revoked = await repositories.profiles.create({ displayName: "Revoked" });
    const revokedId = revoked.profile.id;
    const revokedToken = await playbackContexts.beginProviderSnapshotMutation(revokedId);
    const revokedFence = await playbackContexts.fenceProviderSnapshotMutation(
      revokedId,
      revokedToken,
      await repositories.providers.allocateMutationFence(revokedId)
    );
    await repositories.providers.replaceAll(revokedId, [descriptor("revoked")], 0, {
      mutationFence: revokedFence.fence,
    });
    assert.equal(await repositories.profiles.revoke(revokedId, revoked.profile.revision), true);
    await client.hSet(
      playbackContexts._providerSnapshotStateKey(revokedId),
      "expiresAtMs",
      "0"
    );
    const revokedReads = await Promise.all(
      Array.from({ length: 4 }, () =>
        readProviderCollectionSnapshot(repositories.providers, playbackContexts, revokedId)
      )
    );
    assert.deepEqual(
      revokedReads.map((item) => item.collection),
      Array.from({ length: 4 }, () => ({ revision: 0, providers: [] }))
    );
    assert.deepEqual(await playbackContexts.getProviderSnapshotState(revokedId), {
      generation: revokedReads[0].generation,
      pending: false,
    });
    await assert.rejects(
      playbackContexts.completeProviderSnapshotMutation(revokedId, revokedToken),
      (error) => error.code === "provider_snapshot_changed"
    );
  }
);
