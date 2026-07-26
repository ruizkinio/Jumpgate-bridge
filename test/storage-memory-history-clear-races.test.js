"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const {
  EnvelopeCrypto,
  TokenService,
  createMemoryDurableRepositories,
} = require("../lib/storage");
const {
  digestHistoryEventRequest,
  normalizeHistoryEventBody,
} = require("../lib/history-protocol");

let harnessSeed = 0;

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function uuid(number) {
  return `00000000-0000-7000-8000-${number.toString(16).padStart(12, "0")}`;
}

function sequenceRandom(seed) {
  let next = seed;
  return (length) => {
    const output = Buffer.alloc(length, next);
    next = next === 255 ? 1 : next + 1;
    return output;
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function assertPending(promise) {
  const pending = Symbol("pending");
  const outcome = await Promise.race([
    promise.then(() => "fulfilled", () => "rejected"),
    new Promise((resolve) => setImmediate(() => resolve(pending))),
  ]);
  assert.equal(outcome, pending);
}

async function withinDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + " did not complete")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createHarness(label) {
  const seed = ++harnessSeed;
  const now = { value: 10_000 };
  let grantId = 0;
  let sessionId = 0;
  const keyId = `history-race-${seed}`;
  const repositories = createMemoryDurableRepositories({
    tokenService: new TokenService({
      pepper: Buffer.alloc(32, 0x30 + seed),
      randomBytes: sequenceRandom(0x50 + seed),
    }),
    envelopeCrypto: new EnvelopeCrypto({
      primaryKeyId: keyId,
      keys: { [keyId]: Buffer.alloc(32, 0x70 + seed) },
      randomBytes: sequenceRandom(0x90 + seed),
    }),
  }, {
    clock: () => now.value,
    profileIdFactory: () => `profile_history_race_${label}`,
    deviceIdFactory: () => `device_history_race_${label}`,
    historyGrantIdFactory: () => `grant_history_race_${label}_${++grantId}`,
    historySessionIdFactory: () => `session_history_race_${label}_${++sessionId}`,
  });
  const created = await repositories.profiles.create({ displayName: `Race ${label}` });
  const registered = await repositories.devices.register(created.profile.id, {
    displayName: `Kodi ${label}`,
  });
  return {
    binding: {
      profileId: created.profile.id,
      profileRevision: created.profile.revision,
      deviceId: registered.device.id,
      deviceGeneration: registered.device.generation,
      historyGeneration: created.profile.historyGeneration,
      playbackGeneration: `g1:${label}`,
    },
    now,
    repositories,
  };
}

function historyEntry(contentKey, lastPlayedAt, positionMs = 1_000) {
  return {
    contentKey,
    canonicalIdentity: null,
    displaySnapshot: { title: "Memory history race" },
    playbackSnapshot: {},
    positionMs,
    durationMs: 100_000,
    watchedMs: positionMs,
    completed: false,
    lastPlayedAt,
  };
}

function pauseNextDeviceCheck(repositories) {
  const entered = deferred();
  const release = deferred();
  const original = repositories.devices.isActiveBindingNow;
  let pause = true;
  repositories.devices.isActiveBindingNow = function pausedDeviceCheck(...args) {
    if (!pause) return original.apply(this, args);
    pause = false;
    entered.resolve();
    return release.promise.then(() => original.apply(this, args));
  };
  return {
    entered: entered.promise,
    release: release.resolve,
    restore() {
      repositories.devices.isActiveBindingNow = original;
    },
  };
}

function pauseNextGenerationCommit(history) {
  const entered = deferred();
  const release = deferred();
  const original = history.advanceGenerationNow;
  let pause = true;
  history.advanceGenerationNow = async function pausedGenerationCommit(...args) {
    if (!pause) return original.apply(this, args);
    pause = false;
    entered.resolve();
    await release.promise;
    return original.apply(this, args);
  };
  return {
    entered: entered.promise,
    release: release.resolve,
    restore() {
      history.advanceGenerationNow = original;
    },
  };
}

async function canonicalGrant(harness, number) {
  const { binding, repositories } = harness;
  const requestDigest = sha256(`history-race-claim-${number}`);
  const reservation = await repositories.historyGrants.reserve({
    attemptId: uuid(number),
    requestDigest,
    ...binding,
  });
  const authority = {
    ...binding,
    providerRevision: String(number + 10),
    contextId: `context_history_race_${number}`,
    contextRevision: String(number + 20),
    sessionId: reservation.sessionId,
    contentKey: sha256(`history-race-content-${number}`),
    canonicalIdentity: {
      provider: "imdb",
      id: "tt0133093",
      mediaType: "movie",
      provenance: "metadata-request",
      confidence: "canonical",
    },
    displaySnapshot: { title: `History race ${number}`, year: 1999 },
    claimStatus: "claimed",
    traktEligible: true,
    supersededSessionId: null,
  };
  const grant = await repositories.historyGrants.finalize({
    grantId: reservation.grantId,
    requestDigest,
    authority,
  });
  return { authority, grant };
}

function eventInput(grant, number) {
  const body = {
    event: "start",
    sessionRevision: 1,
    positionMs: 20_000,
    durationMs: 100_000,
    watchedMs: 18_000,
    playbackPreferences: {
      subtitleTrackId: "subtitle_track_eng",
      subtitlesEnabled: true,
      subtitleLanguages: ["eng"],
    },
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    profileId: grant.profileId,
    deviceId: grant.deviceId,
    grantToken: grant.grantToken,
    idempotencyKey: uuid(number),
    requestDigest: digestHistoryEventRequest(rawBody),
    event: normalizeHistoryEventBody(body),
  };
}

test("clear wins over in-flight direct history mutations without resurrection", async (t) => {
  await t.test("upsert linearizes before clear", async () => {
    const harness = await createHarness("clear_wins_upsert");
    const { binding, repositories } = harness;
    const contentKey = sha256("clear-wins-upsert");
    const gate = pauseNextDeviceCheck(repositories);
    try {
      const writePromise = repositories.history.upsert(
        binding.profileId,
        historyEntry(contentKey, 10_000),
        0,
        {
          generation: binding.historyGeneration,
          deviceId: binding.deviceId,
          deviceGeneration: binding.deviceGeneration,
        }
      );
      await gate.entered;
      const clearPromise = repositories.historyGrants.clearHistory(binding.profileId);
      await assertPending(clearPromise);
      gate.release();

      const written = await writePromise;
      const cleared = await clearPromise;
      assert.equal(cleared.historyGeneration, binding.historyGeneration + 1);
      assert.equal(await repositories.history.get(binding.profileId, contentKey), null);

      const afterClear = await repositories.history.upsert(
        binding.profileId,
        historyEntry(contentKey, 10_001),
        0,
        {
          generation: cleared.historyGeneration,
          deviceId: binding.deviceId,
          deviceGeneration: binding.deviceGeneration,
        }
      );
      assert.ok(afterClear.changeSequence > written.changeSequence);
    } finally {
      gate.restore();
    }
  });

  await t.test("remove linearizes before clear", async () => {
    const harness = await createHarness("clear_wins_remove");
    const { binding, repositories } = harness;
    const contentKey = sha256("clear-wins-remove");
    const seeded = await repositories.history.upsert(
      binding.profileId,
      historyEntry(contentKey, 10_000),
      0
    );
    const gate = pauseNextDeviceCheck(repositories);
    try {
      const removePromise = repositories.history.remove(
        binding.profileId,
        contentKey,
        seeded.revision,
        {
          generation: binding.historyGeneration,
          deviceId: binding.deviceId,
          deviceGeneration: binding.deviceGeneration,
        }
      );
      await gate.entered;
      const clearPromise = repositories.historyGrants.clearHistory(binding.profileId);
      await assertPending(clearPromise);
      gate.release();

      assert.equal(await removePromise, true);
      const cleared = await clearPromise;
      assert.equal(await repositories.history.getForWrite(binding.profileId, contentKey), null);
      const afterClear = await repositories.history.upsert(
        binding.profileId,
        historyEntry(contentKey, 10_001),
        0,
        { generation: cleared.historyGeneration }
      );
      assert.ok(afterClear.changeSequence > seeded.changeSequence + 1);
    } finally {
      gate.restore();
    }
  });
});

test("direct mutations queued behind clear observe only the committed generation", async (t) => {
  await t.test("upsert writes after clear", async () => {
    const harness = await createHarness("write_wins_upsert");
    const { binding, repositories } = harness;
    const contentKey = sha256("write-wins-upsert");
    const gate = pauseNextGenerationCommit(repositories.history);
    try {
      const clearPromise = repositories.historyGrants.clearHistory(binding.profileId);
      await gate.entered;
      const writePromise = repositories.history.upsert(
        binding.profileId,
        historyEntry(contentKey, 10_001),
        0,
        {
          deviceId: binding.deviceId,
          deviceGeneration: binding.deviceGeneration,
        }
      );
      await assertPending(writePromise);
      gate.release();

      const cleared = await clearPromise;
      const written = await writePromise;
      assert.equal(cleared.historyGeneration, binding.historyGeneration + 1);
      assert.deepEqual(
        await repositories.history.get(binding.profileId, contentKey),
        written
      );
    } finally {
      gate.restore();
    }
  });

  await t.test("remove wins after a queued new-generation upsert", async () => {
    const harness = await createHarness("write_wins_remove");
    const { binding, repositories } = harness;
    const contentKey = sha256("write-wins-remove");
    const seeded = await repositories.history.upsert(
      binding.profileId,
      historyEntry(contentKey, 10_000),
      0
    );
    const gate = pauseNextGenerationCommit(repositories.history);
    try {
      const clearPromise = repositories.historyGrants.clearHistory(binding.profileId);
      await gate.entered;
      const writePromise = repositories.history.upsert(
        binding.profileId,
        historyEntry(contentKey, 10_001),
        0,
        {
          deviceId: binding.deviceId,
          deviceGeneration: binding.deviceGeneration,
        }
      );
      const removePromise = repositories.history.remove(
        binding.profileId,
        contentKey,
        1,
        {
          deviceId: binding.deviceId,
          deviceGeneration: binding.deviceGeneration,
        }
      );
      await assertPending(writePromise);
      await assertPending(removePromise);
      gate.release();

      await clearPromise;
      const written = await writePromise;
      assert.equal(await removePromise, true);
      const tombstone = await repositories.history.getForWrite(binding.profileId, contentKey);
      assert.equal(await repositories.history.get(binding.profileId, contentKey), null);
      assert.equal(tombstone.revision, 2);
      assert.ok(tombstone.changeSequence > written.changeSequence);
      assert.ok(written.changeSequence > seeded.changeSequence);
    } finally {
      gate.restore();
    }
  });
});

test("grant writes and atomic clear use lock-held history primitives without deadlock", async () => {
  const harness = await createHarness("no_nested_deadlock");
  const { binding, repositories } = harness;
  assert.equal(
    repositories.history._lifecycleCoordinator,
    repositories.historyGrants._lifecycleCoordinator
  );
  assert.equal(
    repositories.history._lifecycleCoordinator,
    repositories.playbackSessions._lifecycleCoordinator
  );

  const canonical = await canonicalGrant(harness, 100);
  const input = eventInput(canonical.grant, 200);
  const applied = await withinDeadline(
    repositories.historyGrants.applyEvent(input),
    "grant history write"
  );
  assert.ok(applied.history);
  const cleared = await withinDeadline(
    repositories.historyGrants.clearHistory(binding.profileId),
    "atomic history clear"
  );
  assert.equal(cleared.historyGeneration, binding.historyGeneration + 1);
});

test("late clear failure rolls back all state and successful retry clears revoked leases", async () => {
  const harness = await createHarness("rollback_and_lease");
  const { binding, now, repositories } = harness;
  const canonical = await canonicalGrant(harness, 300);
  const input = eventInput(canonical.grant, 400);
  const applied = await repositories.historyGrants.applyEvent(input);
  const storedBefore = await repositories.history.get(
    binding.profileId,
    canonical.authority.contentKey
  );
  assert.ok(applied.history);
  assert.ok(storedBefore);

  const sessionId = "session_history_race_direct";
  const dispatchId = "dispatch_history_race_direct";
  const { historyGeneration: _historyGeneration, ...playbackBinding } = binding;
  const directBinding = {
    ...playbackBinding,
    sessionId,
    contextId: "context_history_race_direct",
    playbackGeneration: "g1:rollback_and_lease_direct",
    contextRevision: "1",
  };
  await repositories.playbackSessions.openSession({ ...directBinding, state: "playing" });
  await repositories.playbackSessions.transitionAndEnqueue({
    ...directBinding,
    expectedRevision: 1,
    state: "playing",
    dispatch: {
      id: dispatchId,
      event: "start",
      progress: 20,
      payload: { movie: { ids: { imdb: "tt0133093" } }, progress: 20 },
    },
  });
  const lease = await repositories.playbackSessions.claimDispatch({
    workerId: "worker_history_race",
    leaseMs: 1_000,
  });
  assert.equal(lease.dispatch.id, dispatchId);

  const stateBefore = {
    grants: repositories.historyGrants.storageSnapshot(),
    history: repositories.history.storageSnapshot(),
    playback: repositories.playbackSessions.storageSnapshot(),
    profile: await repositories.profiles.getById(binding.profileId),
  };
  const rawDispatchKey = binding.profileId + "\0" + dispatchId;
  const rawLeaseHash = repositories.playbackSessions._dispatches.get(rawDispatchKey).leaseTokenHash;
  assert.match(rawLeaseHash, /^[a-f0-9]{64}$/);

  const originalInvalidate = repositories.playbackSessions.invalidateHistoryNow;
  repositories.playbackSessions.invalidateHistoryNow = function failAfterInvalidation(...args) {
    originalInvalidate.apply(this, args);
    throw new Error("injected late history clear failure");
  };
  try {
    await assert.rejects(
      () => repositories.historyGrants.clearHistory(binding.profileId),
      /injected late history clear failure/
    );
  } finally {
    repositories.playbackSessions.invalidateHistoryNow = originalInvalidate;
  }

  assert.deepEqual(await repositories.profiles.getById(binding.profileId), stateBefore.profile);
  assert.deepEqual(repositories.history.storageSnapshot(), stateBefore.history);
  assert.deepEqual(repositories.historyGrants.storageSnapshot(), stateBefore.grants);
  assert.deepEqual(repositories.playbackSessions.storageSnapshot(), stateBefore.playback);
  assert.equal(
    repositories.playbackSessions._dispatches.get(rawDispatchKey).leaseTokenHash,
    rawLeaseHash
  );
  assert.deepEqual(await repositories.historyGrants.applyEvent(input), applied);

  const admissionFailure = new Error("upstream probe stopped");
  await assert.rejects(
    () => repositories.playbackSessions.withDispatchAdmission(
      {
        profileId: binding.profileId,
        dispatchId,
        leaseToken: lease.leaseToken,
      },
      async () => {
        throw admissionFailure;
      }
    ),
    (error) => error === admissionFailure
  );

  const cleared = await repositories.historyGrants.clearHistory(binding.profileId);
  assert.equal(cleared.historyGeneration, binding.historyGeneration + 1);
  assert.ok(cleared.revokedGrants >= 1);
  assert.ok(cleared.releasedSessions >= 1);
  assert.equal(
    await repositories.history.get(binding.profileId, canonical.authority.contentKey),
    null
  );
  assert.equal(
    (await repositories.historyGrants.getGrantBySession(
      binding.profileId,
      canonical.grant.sessionId
    )).status,
    "revoked"
  );

  const finalDispatch = repositories.playbackSessions.storageSnapshot().dispatches
    .find((record) => record.id === dispatchId);
  const finalRawDispatch = repositories.playbackSessions._dispatches.get(rawDispatchKey);
  assert.equal(finalDispatch.status, "revoked");
  assert.equal(finalDispatch.leaseOwner, null);
  assert.equal(finalDispatch.leaseExpiresAt, null);
  assert.equal(finalRawDispatch.leaseTokenHash, null);
  assert.equal(finalRawDispatch.leaseOwner, null);
  assert.equal(finalRawDispatch.leaseExpiresAt, null);
  assert.equal(await repositories.playbackSessions.retryDispatch({
    profileId: binding.profileId,
    dispatchId,
    leaseToken: lease.leaseToken,
    nextAttemptAt: now.value + 100,
  }), false);

  now.value += 1;
  const afterClear = await repositories.history.upsert(
    binding.profileId,
    historyEntry(sha256("history-after-atomic-clear"), now.value),
    0,
    {
      generation: cleared.historyGeneration,
      deviceId: binding.deviceId,
      deviceGeneration: binding.deviceGeneration,
    }
  );
  assert.ok(afterClear.changeSequence > storedBefore.changeSequence);
});
