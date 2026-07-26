"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  EnvelopeCrypto,
  MemoryPlaybackSessionRepository,
  ProfileLifecycleCoordinator,
  TokenService,
  assertRepository,
  createMemoryDurableRepositories,
} = require("../lib/storage");
const { createSqliteRepositories } = require("../lib/storage/sqlite");

let Database = null;
try {
  const Candidate = require("better-sqlite3");
  const probe = new Candidate(":memory:");
  probe.close();
  Database = Candidate;
} catch (_error) {
  // The contract remains covered by Node 24 CI when the native ABI is unavailable locally.
}

const PROFILE_A = "profile_playback_a";
const PROFILE_B = "profile_playback_b";
const DEVICE_A = "device_playback_a";
const DEVICE_B = "device_playback_b";
const SESSION_A = "session_playback_a";
const CONTEXT_A = "context_playback_a";
const GENERATION_A = "g1:playback-a";
const CONTEXT_REVISION_A = "1";

function sequenceRandom(seed = 1) {
  let next = seed;
  return (length) => {
    const output = Buffer.alloc(length, next);
    next = next === 255 ? 1 : next + 1;
    return output;
  };
}

function tokenService(seed = 1) {
  return new TokenService({
    pepper: Buffer.alloc(32, 0x6a),
    randomBytes: sequenceRandom(seed),
  });
}

function envelopeCrypto() {
  return new EnvelopeCrypto({
    primaryKeyId: "playback-key",
    keys: { "playback-key": Buffer.alloc(32, 0x4d) },
    randomBytes: sequenceRandom(0x30),
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function binding(overrides = {}) {
  return {
    profileId: PROFILE_A,
    profileRevision: 1,
    deviceId: DEVICE_A,
    deviceGeneration: 1,
    sessionId: SESSION_A,
    contextId: CONTEXT_A,
    playbackGeneration: GENERATION_A,
    contextRevision: CONTEXT_REVISION_A,
    ...overrides,
  };
}

function transition(state, expectedRevision, overrides = {}) {
  return {
    ...binding(overrides),
    expectedRevision,
    state,
  };
}

function dispatch(id, event = "start", overrides = {}) {
  return {
    id,
    event,
    progress: overrides.progress ?? 12.5,
    payload: overrides.payload || {
      movie: { ids: { imdb: "tt0133093" } },
      progress: overrides.progress ?? 12.5,
    },
  };
}

function directFixture() {
  const now = { value: 1000 };
  const profiles = new Map([
    [PROFILE_A, { status: "active", revision: 1, historyGeneration: 1 }],
    [PROFILE_B, { status: "active", revision: 1, historyGeneration: 1 }],
  ]);
  const devices = new Map([
    [PROFILE_A + "\0" + DEVICE_A, { generation: 1, active: true }],
    [PROFILE_B + "\0" + DEVICE_B, { generation: 1, active: true }],
  ]);
  const repository = new MemoryPlaybackSessionRepository({
    tokenService: tokenService(),
    clock: () => now.value,
    lifecycleCoordinator: new ProfileLifecycleCoordinator(),
    getProfileBinding: async (profileId) => profiles.get(profileId) || null,
    isDeviceBindingActive: async (profileId, deviceId, generation) => {
      const device = devices.get(profileId + "\0" + deviceId);
      return Boolean(device && device.active && device.generation === generation);
    },
  });
  return { devices, now, profiles, repository };
}

async function openAndQueue(repository, options = {}) {
  const scopedBinding = binding(options.binding);
  const opened = await repository.openSession({ ...scopedBinding, state: "playing" });
  const queued = await repository.transitionAndEnqueue({
    ...scopedBinding,
    expectedRevision: opened.revision,
    state: options.state || "playing",
    dispatch: dispatch(options.dispatchId || "dispatch_playback_a", options.event, options.dispatch),
  });
  return { binding: scopedBinding, opened, queued };
}

test("playbackSessions is a required durable repository contract", () => {
  const { repository } = directFixture();
  assert.equal(assertRepository("playbackSessions", repository), repository);
});

test("pause admitted before dispatch suppresses client-claimed playing state", async () => {
  const { repository } = directFixture();
  await openAndQueue(repository);
  const claim = await repository.claimDispatch({ workerId: "worker_playback_a", leaseMs: 100 });
  assert.ok(claim);

  const paused = repository.transition(transition("paused", 1));
  let upstreamCalls = 0;
  await assert.rejects(
    () => repository.withDispatchAdmission(
      { profileId: PROFILE_A, dispatchId: claim.dispatch.id, leaseToken: claim.leaseToken },
      async () => {
        upstreamCalls += 1;
      }
    ),
    (error) => error.code === "scrobble_dispatch_revoked"
  );
  assert.equal((await paused).state, "paused");
  assert.equal(upstreamCalls, 0);
});

test("an admitted dispatch serializes a concurrent pause behind the upstream effect", async () => {
  const { repository } = directFixture();
  await openAndQueue(repository);
  const claim = await repository.claimDispatch({ workerId: "worker_playback_a", leaseMs: 100 });
  const entered = deferred();
  const release = deferred();
  const admitted = repository.withDispatchAdmission(
    { profileId: PROFILE_A, dispatchId: claim.dispatch.id, leaseToken: claim.leaseToken },
    async () => {
      entered.resolve();
      await release.promise;
      return "upstream-ok";
    }
  );
  await entered.promise;
  let pauseSettled = false;
  const pausing = repository.transition(transition("paused", 1)).then((value) => {
    pauseSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(pauseSettled, false);
  release.resolve();
  assert.equal(await admitted, "upstream-ok");
  assert.equal((await pausing).state, "paused");
});

test("expired and replaced leases cannot dispatch or release the retry owner", async () => {
  const { now, repository } = directFixture();
  await openAndQueue(repository);
  const first = await repository.claimDispatch({ workerId: "worker_playback_a", leaseMs: 10 });
  now.value += 11;
  const second = await repository.claimDispatch({ workerId: "worker_playback_b", leaseMs: 100 });
  assert.ok(second);
  assert.notEqual(second.leaseToken, first.leaseToken);

  let upstreamCalls = 0;
  await assert.rejects(
    () => repository.withDispatchAdmission(
      { profileId: PROFILE_A, dispatchId: first.dispatch.id, leaseToken: first.leaseToken },
      async () => {
        upstreamCalls += 1;
      }
    ),
    (error) => error.code === "scrobble_dispatch_lease_lost"
  );
  assert.equal(await repository.retryDispatch({
    profileId: PROFILE_A,
    dispatchId: first.dispatch.id,
    leaseToken: first.leaseToken,
    nextAttemptAt: now.value + 10,
  }), false);
  assert.equal(await repository.withDispatchAdmission(
    { profileId: PROFILE_A, dispatchId: second.dispatch.id, leaseToken: second.leaseToken },
    async () => {
      upstreamCalls += 1;
      return "sent";
    }
  ), "sent");
  assert.equal(upstreamCalls, 1);
});

test("source and session generations are exact and released sessions are terminal", async () => {
  const { repository } = directFixture();
  await repository.openSession({ ...binding(), state: "playing" });
  await assert.rejects(
    () => repository.transition(transition("paused", 1, { playbackGeneration: "g1:stale" })),
    (error) => error.code === "playback_session_stale"
  );
  const released = await repository.invalidateSourceClaim({
    profileId: PROFILE_A,
    contextId: CONTEXT_A,
    playbackGeneration: GENERATION_A,
    contextRevision: CONTEXT_REVISION_A,
  });
  assert.equal(released, 1);
  await assert.rejects(
    () => repository.openSession({
      ...binding({ sessionId: "session_playback_new" }),
      state: "playing",
    }),
    (error) => error.code === "playback_source_revoked"
  );
  await assert.rejects(
    () => repository.transition(transition("playing", 2)),
    (error) => error.code === "playback_session_released"
  );
});

test("profile revocation atomically revokes dispatches without cross-profile mutation", async () => {
  const primitives = { tokenService: tokenService(), envelopeCrypto: envelopeCrypto() };
  const repositories = createMemoryDurableRepositories(primitives, {
    profileIdFactory: (() => {
      const values = [PROFILE_A, PROFILE_B];
      return () => values.shift();
    })(),
    deviceIdFactory: (() => {
      const values = [DEVICE_A, DEVICE_B];
      return () => values.shift();
    })(),
  });
  const firstProfile = await repositories.profiles.create({ displayName: "A" });
  const secondProfile = await repositories.profiles.create({ displayName: "B" });
  const firstDevice = await repositories.devices.register(PROFILE_A, { displayName: "A" });
  const secondDevice = await repositories.devices.register(PROFILE_B, { displayName: "B" });
  const firstBinding = binding({
    profileRevision: firstProfile.profile.revision,
    deviceGeneration: firstDevice.device.generation,
  });
  const secondBinding = binding({
    profileId: PROFILE_B,
    profileRevision: secondProfile.profile.revision,
    deviceId: DEVICE_B,
    deviceGeneration: secondDevice.device.generation,
    sessionId: "session_playback_b",
    contextId: "context_playback_b",
    playbackGeneration: "g1:playback-b",
  });
  for (const [scopedBinding, dispatchId] of [
    [firstBinding, "dispatch_playback_a"],
    [secondBinding, "dispatch_playback_b"],
  ]) {
    await repositories.playbackSessions.openSession({ ...scopedBinding, state: "playing" });
    await repositories.playbackSessions.transitionAndEnqueue({
      ...scopedBinding,
      expectedRevision: 1,
      state: "playing",
      dispatch: dispatch(dispatchId),
    });
  }
  await repositories.profiles.revoke(PROFILE_A, 1);
  const firstDispatch = (await repositories.playbackSessions.listDispatches(
    PROFILE_A,
    firstBinding.sessionId
  ))[0];
  const secondDispatch = (await repositories.playbackSessions.listDispatches(
    PROFILE_B,
    secondBinding.sessionId
  ))[0];
  assert.equal(firstDispatch.status, "revoked");
  assert.equal(secondDispatch.status, "queued");
});

test("only one of many concurrent workers can perform a leased dispatch", async () => {
  const { repository } = directFixture();
  await openAndQueue(repository);
  const claim = await repository.claimDispatch({ workerId: "worker_playback_a", leaseMs: 1000 });
  const workers = 64;
  let upstreamCalls = 0;
  const results = await Promise.allSettled(Array.from({ length: workers }, () =>
    repository.withDispatchAdmission(
      { profileId: PROFILE_A, dispatchId: claim.dispatch.id, leaseToken: claim.leaseToken },
      async () => {
        upstreamCalls += 1;
        await Promise.resolve();
        return "sent";
      }
    )
  ));
  assert.equal(upstreamCalls, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, workers - 1);
});

test("dispatch id retries require the exact playback session binding", async () => {
  const { repository } = directFixture();
  const first = await openAndQueue(repository, { dispatchId: "dispatch_shared_retry" });
  const retried = await repository.transitionAndEnqueue({
    ...first.binding,
    expectedRevision: first.opened.revision,
    state: "playing",
    dispatch: dispatch("dispatch_shared_retry"),
  });
  assert.equal(retried.dispatch.id, first.queued.dispatch.id);
  assert.equal(retried.dispatch.sessionId, first.binding.sessionId);

  const second = binding({ sessionId: "session_playback_retry_b" });
  await repository.openSession({ ...second, state: "playing" });
  await assert.rejects(
    () => repository.transitionAndEnqueue({
      ...second,
      expectedRevision: 1,
      state: "playing",
      dispatch: dispatch("dispatch_shared_retry"),
    }),
    (error) => error.code === "scrobble_dispatch_conflict"
  );
});

function sqliteTest(name, callback) {
  test(name, { skip: Database ? false : "better-sqlite3 ABI is unavailable" }, callback);
}

function sqliteFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-playback-sqlite-"));
  const database = new Database(path.join(directory, "storage.sqlite3"));
  const now = { value: 1000 };
  const identifiers = {
    profile: [PROFILE_A, PROFILE_B],
    device: [DEVICE_A, DEVICE_B],
  };
  const repositories = createSqliteRepositories(database, {
    tokenService: tokenService(),
    envelopeCrypto: envelopeCrypto(),
    clock: () => now.value,
    idFactory: (kind) => identifiers[kind].shift(),
    deviceTtlMs: 1000,
    deviceTouchIntervalMs: 100,
  });
  t.after(() => {
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { now, repositories };
}

async function sqliteBinding(repositories, profileId = PROFILE_A, deviceId = DEVICE_A) {
  const created = await repositories.profiles.create({ displayName: profileId });
  const registered = await repositories.devices.register(profileId, {
    displayName: deviceId,
  });
  return binding({
    profileId,
    profileRevision: created.profile.revision,
    deviceId,
    deviceGeneration: registered.device.generation,
    ...(profileId === PROFILE_B ? {
      sessionId: "session_playback_b",
      contextId: "context_playback_b",
      playbackGeneration: "g1:playback-b",
    } : {}),
  });
}

sqliteTest("SQLite keeps transition, lease, and admission state durable", async (t) => {
  const { now, repositories } = sqliteFixture(t);
  const scopedBinding = await sqliteBinding(repositories);
  assert.equal(
    assertRepository("playbackSessions", repositories.playbackSessions),
    repositories.playbackSessions
  );
  await repositories.playbackSessions.openSession({ ...scopedBinding, state: "playing" });
  await repositories.playbackSessions.transitionAndEnqueue({
    ...scopedBinding,
    expectedRevision: 1,
    state: "playing",
    dispatch: dispatch("dispatch_sqlite_a"),
  });
  const first = await repositories.playbackSessions.claimDispatch({
    workerId: "worker_sqlite_a",
    leaseMs: 10,
  });
  now.value += 11;
  const second = await repositories.playbackSessions.claimDispatch({
    workerId: "worker_sqlite_b",
    leaseMs: 100,
  });
  await assert.rejects(
    () => repositories.playbackSessions.withDispatchAdmission(
      { profileId: PROFILE_A, dispatchId: first.dispatch.id, leaseToken: first.leaseToken },
      async () => assert.fail("expired lease dispatched")
    ),
    (error) => error.code === "scrobble_dispatch_lease_lost"
  );
  assert.equal(await repositories.playbackSessions.withDispatchAdmission(
    { profileId: PROFILE_A, dispatchId: second.dispatch.id, leaseToken: second.leaseToken },
    async () => "sqlite-sent"
  ), "sqlite-sent");
});

sqliteTest("SQLite profile generation changes serialize behind admitted dispatch", async (t) => {
  const { repositories } = sqliteFixture(t);
  const scopedBinding = await sqliteBinding(repositories);
  await repositories.playbackSessions.openSession({ ...scopedBinding, state: "playing" });
  await repositories.playbackSessions.transitionAndEnqueue({
    ...scopedBinding,
    expectedRevision: 1,
    state: "playing",
    dispatch: dispatch("dispatch_sqlite_race"),
  });
  const claim = await repositories.playbackSessions.claimDispatch({
    workerId: "worker_sqlite_a",
    leaseMs: 100,
  });
  const entered = deferred();
  const release = deferred();
  const admitted = repositories.playbackSessions.withDispatchAdmission(
    { profileId: PROFILE_A, dispatchId: claim.dispatch.id, leaseToken: claim.leaseToken },
    async () => {
      entered.resolve();
      await release.promise;
      return "sent-before-revision";
    }
  );
  await entered.promise;
  let updateSettled = false;
  const updating = repositories.profiles.update(
    PROFILE_A,
    { displayName: "revision-two" },
    1
  ).then((value) => {
    updateSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(updateSettled, false);
  release.resolve();
  assert.equal(await admitted, "sent-before-revision");
  assert.equal((await updating).revision, 2);
  assert.equal((await repositories.playbackSessions.getSession(
    PROFILE_A,
    SESSION_A
  )).state, "released");
});

sqliteTest("SQLite source invalidation is durable and profile isolated", async (t) => {
  const { repositories } = sqliteFixture(t);
  const first = await sqliteBinding(repositories, PROFILE_A, DEVICE_A);
  const second = await sqliteBinding(repositories, PROFILE_B, DEVICE_B);
  await repositories.playbackSessions.openSession({ ...first, state: "playing" });
  await repositories.playbackSessions.openSession({ ...second, state: "playing" });
  assert.equal(await repositories.playbackSessions.invalidateSourceClaim({
    profileId: first.profileId,
    contextId: first.contextId,
    playbackGeneration: first.playbackGeneration,
    contextRevision: first.contextRevision,
  }), 1);
  assert.equal((await repositories.playbackSessions.getSession(
    first.profileId,
    first.sessionId
  )).state, "released");
  assert.equal((await repositories.playbackSessions.getSession(
    second.profileId,
    second.sessionId
  )).state, "playing");
});

sqliteTest("SQLite dispatch id retries require the exact session binding", async (t) => {
  const { repositories } = sqliteFixture(t);
  const first = await sqliteBinding(repositories);
  await repositories.playbackSessions.openSession({ ...first, state: "playing" });
  const queued = await repositories.playbackSessions.transitionAndEnqueue({
    ...first,
    expectedRevision: 1,
    state: "playing",
    dispatch: dispatch("dispatch_sqlite_retry"),
  });
  const retried = await repositories.playbackSessions.transitionAndEnqueue({
    ...first,
    expectedRevision: 1,
    state: "playing",
    dispatch: dispatch("dispatch_sqlite_retry"),
  });
  assert.equal(retried.dispatch.id, queued.dispatch.id);
  assert.equal(retried.dispatch.sessionId, first.sessionId);

  const second = { ...first, sessionId: "session_sqlite_retry_b" };
  await repositories.playbackSessions.openSession({ ...second, state: "playing" });
  await assert.rejects(
    () => repositories.playbackSessions.transitionAndEnqueue({
      ...second,
      expectedRevision: 1,
      state: "playing",
      dispatch: dispatch("dispatch_sqlite_retry"),
    }),
    (error) => error.code === "scrobble_dispatch_conflict"
  );
});
