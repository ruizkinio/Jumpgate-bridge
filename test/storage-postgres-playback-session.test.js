"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const { Pool } = require("pg");

const { EnvelopeCrypto, TokenService } = require("../lib/storage");
const {
  PostgresMigrationRunner,
  createPostgresRepositories,
} = require("../lib/storage/postgres");

const POSTGRES_URL = process.env.TEST_POSTGRES_URL || process.env.DATABASE_URL || "";
const PROFILE_A = "profile_postgres_playback_a";
const DEVICE_A = "device_postgres_playback_a";
const SESSION_A = "session_postgres_playback_a";
const CONTEXT_A = "context_postgres_playback_a";

function sequenceRandom(seed = 1) {
  let next = seed;
  return (length) => {
    const output = Buffer.alloc(length, next);
    next = next === 255 ? 1 : next + 1;
    return output;
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function quoteIdentifier(value) {
  assert.match(value, /^[a-z0-9_]+$/);
  return '"' + value + '"';
}

async function fixture(t) {
  const schema = [
    "jumpgate_playback",
    String(process.pid),
    crypto.randomBytes(5).toString("hex"),
  ].join("_");
  const admin = new Pool({ connectionString: POSTGRES_URL, max: 2 });
  await admin.query("CREATE SCHEMA " + quoteIdentifier(schema));
  const pool = new Pool({
    connectionString: POSTGRES_URL,
    max: 16,
    options: "-c search_path=" + schema + ",public",
  });
  const now = { value: 1000 };
  await new PostgresMigrationRunner({ pool }).run();
  const counters = new Map();
  const repositories = createPostgresRepositories(pool, {
    tokenService: new TokenService({
      pepper: Buffer.alloc(32, 0x61),
      randomBytes: sequenceRandom(),
    }),
    envelopeCrypto: new EnvelopeCrypto({
      primaryKeyId: "postgres-playback-key",
      keys: { "postgres-playback-key": Buffer.alloc(32, 0x51) },
      randomBytes: sequenceRandom(0x30),
    }),
    clock: () => now.value,
    idFactory: (kind) => {
      const next = (counters.get(kind) || 0) + 1;
      counters.set(kind, next);
      if (kind === "profile" && next === 1) return PROFILE_A;
      if (kind === "device" && next === 1) return DEVICE_A;
      return kind + "_postgres_playback_" + String(next).padStart(4, "0");
    },
    providerMutationMode: "fenced",
  });
  t.after(async () => {
    await pool.end();
    await admin.query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
    await admin.end();
  });
  const created = await repositories.profiles.create({ displayName: "Playback" });
  const registered = await repositories.devices.register(PROFILE_A, { displayName: "Kodi" });
  const binding = {
    profileId: PROFILE_A,
    profileRevision: created.profile.revision,
    deviceId: DEVICE_A,
    deviceGeneration: registered.device.generation,
    sessionId: SESSION_A,
    contextId: CONTEXT_A,
    playbackGeneration: "g1:postgres-playback-a",
    contextRevision: "1",
  };
  return { binding, now, pool, repositories };
}

function dispatch(id) {
  return {
    id,
    event: "start",
    progress: 20,
    payload: { movie: { ids: { imdb: "tt0133093" } }, progress: 20 },
  };
}

async function openAndQueue(repositories, binding, dispatchId) {
  await repositories.playbackSessions.openSession({ ...binding, state: "playing" });
  return repositories.playbackSessions.transitionAndEnqueue({
    ...binding,
    expectedRevision: 1,
    state: "playing",
    dispatch: dispatch(dispatchId),
  });
}

test(
  "PostgreSQL authoritative pause and source invalidation defeat stale dispatch",
  { skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL", timeout: 120000 },
  async (t) => {
    const { binding, repositories } = await fixture(t);
    await openAndQueue(repositories, binding, "dispatch_postgres_pause");
    const claim = await repositories.playbackSessions.claimDispatch({
      workerId: "worker_postgres_pause",
      leaseMs: 1000,
    });
    const pausing = repositories.playbackSessions.transition({
      ...binding,
      expectedRevision: 1,
      state: "paused",
    });
    let upstreamCalls = 0;
    await assert.rejects(
      () => repositories.playbackSessions.withDispatchAdmission(
        { profileId: PROFILE_A, dispatchId: claim.dispatch.id, leaseToken: claim.leaseToken },
        async () => {
          upstreamCalls += 1;
        }
      ),
      (error) => error.code === "scrobble_dispatch_revoked"
    );
    assert.equal((await pausing).state, "paused");
    assert.equal(upstreamCalls, 0);
    assert.equal(await repositories.playbackSessions.invalidateSourceClaim({
      profileId: binding.profileId,
      contextId: binding.contextId,
      playbackGeneration: binding.playbackGeneration,
      contextRevision: binding.contextRevision,
    }), 1);
    await assert.rejects(
      () => repositories.playbackSessions.openSession({
        ...binding,
        sessionId: "session_postgres_reopened",
        state: "playing",
      }),
      (error) => error.code === "playback_source_revoked"
    );
  }
);

test(
  "PostgreSQL row lock orders upstream admission before profile generation revocation",
  { skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL", timeout: 120000 },
  async (t) => {
    const { binding, repositories } = await fixture(t);
    await openAndQueue(repositories, binding, "dispatch_postgres_race");
    const claim = await repositories.playbackSessions.claimDispatch({
      workerId: "worker_postgres_race",
      leaseMs: 1000,
    });
    const entered = deferred();
    const release = deferred();
    const admitted = repositories.playbackSessions.withDispatchAdmission(
      { profileId: PROFILE_A, dispatchId: claim.dispatch.id, leaseToken: claim.leaseToken },
      async () => {
        entered.resolve();
        await release.promise;
        return "sent-before-revocation";
      }
    );
    await entered.promise;
    let revisionSettled = false;
    const revising = repositories.profiles.update(
      PROFILE_A,
      { displayName: "Revision two" },
      1
    ).then((value) => {
      revisionSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(revisionSettled, false);
    release.resolve();
    assert.equal(await admitted, "sent-before-revocation");
    assert.equal((await revising).revision, 2);
    assert.equal((await repositories.playbackSessions.getSession(
      PROFILE_A,
      SESSION_A
    )).state, "released");
  }
);

test(
  "PostgreSQL lease replacement and concurrent workers dispatch exactly one admission",
  { skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL", timeout: 120000 },
  async (t) => {
    const { binding, now, repositories } = await fixture(t);
    await openAndQueue(repositories, binding, "dispatch_postgres_stress");
    const first = await repositories.playbackSessions.claimDispatch({
      workerId: "worker_postgres_first",
      leaseMs: 10,
    });
    now.value += 11;
    const claims = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      repositories.playbackSessions.claimDispatch({
        workerId: "worker_postgres_" + String(index).padStart(3, "0"),
        leaseMs: 1000,
      })
    ));
    const replacements = claims.filter(Boolean);
    assert.equal(replacements.length, 1);
    const replacement = replacements[0];
    assert.notEqual(replacement.leaseToken, first.leaseToken);
    await assert.rejects(
      () => repositories.playbackSessions.withDispatchAdmission(
        { profileId: PROFILE_A, dispatchId: first.dispatch.id, leaseToken: first.leaseToken },
        async () => assert.fail("replaced lease dispatched")
      ),
      (error) => error.code === "scrobble_dispatch_lease_lost"
    );

    let upstreamCalls = 0;
    const attempts = await Promise.allSettled(Array.from({ length: 32 }, () =>
      repositories.playbackSessions.withDispatchAdmission(
        {
          profileId: PROFILE_A,
          dispatchId: replacement.dispatch.id,
          leaseToken: replacement.leaseToken,
        },
        async () => {
          upstreamCalls += 1;
          await Promise.resolve();
          return "sent";
        }
      )
    ));
    assert.equal(upstreamCalls, 1);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 31);
  }
);

test(
  "PostgreSQL dispatch id retries require the exact session binding",
  { skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL", timeout: 120000 },
  async (t) => {
    const { binding, repositories } = await fixture(t);
    const queued = await openAndQueue(
      repositories,
      binding,
      "dispatch_postgres_retry"
    );
    const retried = await repositories.playbackSessions.transitionAndEnqueue({
      ...binding,
      expectedRevision: 1,
      state: "playing",
      dispatch: dispatch("dispatch_postgres_retry"),
    });
    assert.equal(retried.dispatch.id, queued.dispatch.id);
    assert.equal(retried.dispatch.sessionId, binding.sessionId);

    const second = { ...binding, sessionId: "session_postgres_retry_b" };
    await repositories.playbackSessions.openSession({ ...second, state: "playing" });
    await assert.rejects(
      () => repositories.playbackSessions.transitionAndEnqueue({
        ...second,
        expectedRevision: 1,
        state: "playing",
        dispatch: dispatch("dispatch_postgres_retry"),
      }),
      (error) => error.code === "scrobble_dispatch_conflict"
    );
  }
);
