"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  TraktScrobbleService,
} = require("../lib/trakt-scrobble-service");
const {
  MemoryPlaybackSessionRepository,
} = require("../lib/storage/memory-playback-session-repository");
const { TokenService } = require("../lib/storage/token-service");

const PROFILE_ID = "profile_trakt_service_0001";
const DEVICE_ID = "device_trakt_service_0001";
const SESSION_ID = "session_trakt_service_0001";
const CONTEXT_ID = "context_trakt_service_0001";
const PLAYBACK_GENERATION = "g1:trakt-service-1";

function canonicalIdentity(overrides = {}) {
  return {
    provider: "imdb",
    id: "tt0133093",
    mediaType: "movie",
    confidence: "canonical",
    provenance: "metadata-request",
    ...overrides,
  };
}

function activeClaim(overrides = {}) {
  const {
    context: contextOverrides = {},
    deliveryBinding: deliveryBindingOverrides = {},
    ...claimOverrides
  } = overrides;
  const context = {
    profileId: PROFILE_ID,
    contextId: CONTEXT_ID,
    canonicalIdentity: canonicalIdentity(),
    traktEligible: true,
    ...contextOverrides,
  };
  return {
    status: "claimed",
    sessionId: SESSION_ID,
    context,
    deliveryBinding: {
      profileId: PROFILE_ID,
      deviceId: DEVICE_ID,
      sessionId: SESSION_ID,
      generation: PLAYBACK_GENERATION,
      contextId: context.contextId,
      contextRevision: "1",
      providerRevision: "1",
      ...deliveryBindingOverrides,
    },
    claimedAt: new Date(1_000).toISOString(),
    expiresAt: new Date(60_000).toISOString(),
    ...claimOverrides,
    context,
  };
}

function binding(overrides = {}) {
  return {
    profileId: PROFILE_ID,
    profileRevision: 1,
    deviceId: DEVICE_ID,
    deviceGeneration: 1,
    playbackGeneration: PLAYBACK_GENERATION,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    sessionId: SESSION_ID,
    contextId: CONTEXT_ID,
    event: "start",
    progress: 12.5,
    paused: false,
    backgrounded: false,
    ...overrides,
  };
}

function fixture(options = {}) {
  const calls = [];
  const credentials = [];
  const claimReads = [];
  const claims = Array.isArray(options.claims)
    ? options.claims.slice()
    : [options.claim === undefined ? activeClaim() : options.claim];
  const playbackContexts = {
    async getActiveClaim(profileId, deviceId, sessionId) {
      claimReads.push({ profileId, deviceId, sessionId });
      if (claims.length > 1) return claims.shift();
      return claims[0] || null;
    },
  };
  const service = new TraktScrobbleService({
    playbackContexts,
    async getCredential(profileId) {
      credentials.push(profileId);
      if (options.getCredential) return options.getCredential(profileId);
      return {
        access_token: "internal-access-token",
        refresh_token: "internal-refresh-token",
        token_expiry: 9999999999,
      };
    },
    async dispatch(request) {
      calls.push(request);
      if (options.dispatch) return options.dispatch(request);
      return { status: 201 };
    },
    async admit(deviceBinding, operation) {
      assert.deepEqual(deviceBinding, binding());
      return operation();
    },
  });
  return { calls, claimReads, credentials, service };
}

test("canonical movie scrobbles are constructed server-side without credential disclosure", async () => {
  const { calls, claimReads, credentials, service } = fixture();

  const result = await service.scrobble(binding(), input());

  assert.deepEqual(result, { ok: true, status: "scrobbled", event: "start" });
  assert.deepEqual(claimReads, [
    { profileId: PROFILE_ID, deviceId: DEVICE_ID, sessionId: SESSION_ID },
    { profileId: PROFILE_ID, deviceId: DEVICE_ID, sessionId: SESSION_ID },
    { profileId: PROFILE_ID, deviceId: DEVICE_ID, sessionId: SESSION_ID },
  ]);
  assert.deepEqual(credentials, [PROFILE_ID]);
  assert.deepEqual(calls, [
    {
      action: "start",
      accessToken: "internal-access-token",
      payload: { movie: { ids: { imdb: "tt0133093" } }, progress: 12.5 },
    },
  ]);
  assert.equal(JSON.stringify(result).includes("internal-access-token"), false);
  assert.equal(JSON.stringify(result).includes("internal-refresh-token"), false);
});

test("caller-supplied title and identity fields are rejected before credential access", async () => {
  for (const arbitrary of [
    { title: "Caller controlled" },
    { ids: { imdb: "tt9999999" } },
    { canonicalIdentity: canonicalIdentity({ id: "tt9999999" }) },
    { movie: { ids: { imdb: "tt9999999" } } },
  ]) {
    const { calls, credentials, service } = fixture();
    await assert.rejects(
      service.scrobble(binding(), input(arbitrary)),
      (error) => error && error.code === "invalid_scrobble_request"
    );
    assert.deepEqual(credentials, []);
    assert.deepEqual(calls, []);
  }
});

test("local-only claims make zero Trakt calls", async () => {
  const { calls, credentials, service } = fixture({
    claim: activeClaim({
      context: { canonicalIdentity: null, traktEligible: false },
    }),
  });

  await assert.rejects(
    service.scrobble(binding(), input()),
    (error) => error && error.code === "trakt_ineligible"
  );
  assert.deepEqual(credentials, []);
  assert.deepEqual(calls, []);
});

test("periodic start and resume events are suppressed while paused or backgrounded", async () => {
  for (const state of [
    { event: "start", paused: true, backgrounded: false },
    { event: "start", paused: false, backgrounded: true },
    { event: "resume", paused: true, backgrounded: false },
    { event: "resume", paused: false, backgrounded: true },
  ]) {
    const { calls, credentials, service } = fixture();
    assert.deepEqual(await service.scrobble(binding(), input(state)), {
      ok: true,
      status: "suppressed",
      event: state.event,
    });
    assert.deepEqual(credentials, []);
    assert.deepEqual(calls, []);
  }
});

test("every supported event is mapped to a fixed Trakt action and canonical episode payload", async () => {
  const episode = activeClaim({
    context: {
      canonicalIdentity: canonicalIdentity({
        provider: "tmdb",
        id: "603",
        mediaType: "episode",
        season: 2,
        episode: 7,
      }),
    },
  });
  const cases = [
    { event: "start", progress: 1, paused: false, backgrounded: false, action: "start" },
    { event: "pause", progress: 25, paused: true, backgrounded: false, action: "pause" },
    { event: "resume", progress: 25, paused: false, backgrounded: false, action: "start" },
    { event: "stop", progress: 80, paused: false, backgrounded: false, action: "stop" },
    { event: "completion", progress: 80, paused: false, backgrounded: false, action: "stop" },
  ];

  for (const item of cases) {
    const { calls, service } = fixture({ claim: episode });
    const { action, ...request } = item;
    const result = await service.scrobble(binding(), input(request));
    assert.equal(result.event, item.event);
    assert.equal(calls[0].action, action);
    assert.deepEqual(calls[0].payload, {
      episode: { season: 2, number: 7, ids: { tmdb: 603 } },
      progress: item.event === "completion" ? 100 : item.progress,
    });
  }
});

test("released, replaced, cross-device, and generation-stale claims are rejected", async () => {
  const cases = [
    null,
    activeClaim({ sessionId: "session_replaced_0001" }),
    activeClaim({ deliveryBinding: { deviceId: "device_other_0001" } }),
    activeClaim({ deliveryBinding: { generation: "g1:replacement" } }),
    activeClaim({ deliveryBinding: { contextId: "context_replacement_0001" } }),
  ];

  for (const claim of cases) {
    const { calls, credentials, service } = fixture({ claim });
    await assert.rejects(
      service.scrobble(binding(), input()),
      (error) => error && error.code === "scrobble_claim_stale"
    );
    assert.deepEqual(credentials, []);
    assert.deepEqual(calls, []);
  }
});

test("claim replacement during credential refresh is fenced before Trakt dispatch", async () => {
  const { calls, service } = fixture({
    claims: [activeClaim(), null],
  });

  await assert.rejects(
    service.scrobble(binding(), input()),
    (error) => error && error.code === "scrobble_claim_stale"
  );
  assert.deepEqual(calls, []);
});

test("invalid progress and playback-state combinations fail closed", async () => {
  const invalid = [
    { progress: -1 },
    { progress: 100.1 },
    { progress: Number.NaN },
    { paused: undefined },
    { backgrounded: undefined },
    { event: "pause", paused: false, backgrounded: false },
    { event: "bogus" },
  ];

  for (const overrides of invalid) {
    const { calls, credentials, service } = fixture();
    await assert.rejects(
      service.scrobble(binding(), input(overrides)),
      (error) => error && error.code === "invalid_scrobble_request"
    );
    assert.deepEqual(credentials, []);
    assert.deepEqual(calls, []);
  }
});

test("upstream failures expose only a bounded Bridge error", async () => {
  const { service } = fixture({
    dispatch() {
      throw Object.assign(new Error("Bearer internal-access-token upstream body secret"), {
        status: 401,
      });
    },
  });

  await assert.rejects(
    service.scrobble(binding(), input()),
    (error) => {
      assert.equal(error.code, "trakt_scrobble_unavailable");
      assert.equal(error.message.includes("internal-access-token"), false);
      assert.equal(error.message.includes("upstream body"), false);
      return true;
    }
  );
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function durableFixture(options = {}) {
  const now = { value: 10_000 };
  const calls = [];
  const profile = {
    id: PROFILE_ID,
    status: "active",
    revision: 1,
    historyGeneration: 1,
  };
  const device = {
    profileId: PROFILE_ID,
    id: DEVICE_ID,
    generation: 1,
    active: true,
  };
  const playbackSessions = new MemoryPlaybackSessionRepository({
    tokenService: new TokenService({
      pepper: Buffer.alloc(32, 0x35),
      randomBytes: (length) => Buffer.alloc(length, 0x36),
    }),
    clock: () => now.value,
    getProfileBinding: async (profileId) => profileId === profile.id ? profile : null,
    isDeviceBindingActive: async (profileId, deviceId, generation) =>
      device.active &&
      profileId === device.profileId &&
      deviceId === device.id &&
      generation === device.generation,
  });
  let currentClaim = activeClaim();
  const playbackContexts = {
    async getActiveClaim(profileId, deviceId, sessionId) {
      if (
        !currentClaim ||
        profileId !== PROFILE_ID ||
        deviceId !== DEVICE_ID ||
        currentClaim.sessionId !== sessionId
      ) {
        return null;
      }
      return currentClaim;
    },
  };
  let sequence = 0;
  const service = new TraktScrobbleService({
    playbackContexts,
    playbackSessions,
    clock: () => now.value,
    workerId: options.workerId || "worker_trakt_service_0001",
    leaseMs: options.leaseMs || 1_000,
    retryBaseMs: options.retryBaseMs || 10,
    retryMaxMs: options.retryMaxMs || 100,
    autoStart: false,
    dispatchInline: options.dispatchInline !== false,
    idFactory: () => "dispatch_generated_" + String(++sequence).padStart(4, "0"),
    async getCredential() {
      if (options.getCredential) return options.getCredential();
      return { access_token: "durable-internal-access" };
    },
    async dispatch(request) {
      calls.push(request);
      if (options.dispatch) return options.dispatch(request, calls.length);
      return { status: 201 };
    },
    // Kept only so this fixture fails against the pre-durable implementation at the behavioral assertion.
    async admit(_binding, operation) {
      return operation();
    },
  });
  return {
    calls,
    device,
    now,
    playbackSessions,
    profile,
    service,
    get claim() {
      return currentClaim;
    },
    set claim(value) {
      currentClaim = value;
    },
  };
}

function durableInput(overrides = {}) {
  return input({
    dispatchId: "dispatch_trakt_service_0001",
    sessionRevision: 1,
    ...overrides,
  });
}

test("durable pause and background state suppress stale caller start and resume evidence", async () => {
  for (const pauseEvidence of [
    { paused: true, backgrounded: false, expectedState: "paused" },
    { paused: false, backgrounded: true, expectedState: "backgrounded" },
  ]) {
    const harness = durableFixture();
    await harness.service.bindClaim(binding(), harness.claim);
    const paused = await harness.service.scrobble(binding(), durableInput({
      dispatchId: "dispatch_pause_" + pauseEvidence.expectedState,
      event: "pause",
      paused: pauseEvidence.paused,
      backgrounded: pauseEvidence.backgrounded,
    }));
    assert.equal(paused.status, "scrobbled");
    assert.equal(paused.sessionRevision, 2);
    assert.equal((await harness.playbackSessions.getSession(PROFILE_ID, SESSION_ID)).state, pauseEvidence.expectedState);

    for (const event of ["start", "resume"]) {
      const suppressed = await harness.service.scrobble(binding(), durableInput({
        dispatchId: "dispatch_stale_" + pauseEvidence.expectedState + "_" + event,
        event,
        paused: false,
        backgrounded: false,
        sessionRevision: 1,
      }));
      assert.deepEqual(suppressed, {
        ok: true,
        status: "suppressed",
        event,
        sessionRevision: 2,
      });
    }
    assert.equal(harness.calls.length, 1);

    const resumed = await harness.service.scrobble(binding(), durableInput({
      dispatchId: "dispatch_explicit_resume_" + pauseEvidence.expectedState,
      event: "resume",
      paused: false,
      backgrounded: false,
      sessionRevision: 2,
    }));
    assert.equal(resumed.status, "scrobbled");
    assert.equal(resumed.sessionRevision, 3);
    assert.equal((await harness.playbackSessions.getSession(PROFILE_ID, SESSION_ID)).state, "playing");
  }
});

test("pause and background transitions persist before Trakt reauthorization is required", async () => {
  for (const state of [
    { paused: true, backgrounded: false, expected: "paused" },
    { paused: false, backgrounded: true, expected: "backgrounded" },
  ]) {
    const harness = durableFixture({
      getCredential: async () => null,
    });
    await harness.service.bindClaim(binding(), harness.claim);
    await assert.rejects(
      harness.service.scrobble(binding(), durableInput({
        dispatchId: "dispatch_reauth_" + state.expected,
        event: "pause",
        paused: state.paused,
        backgrounded: state.backgrounded,
      })),
      (error) => error && error.code === "trakt_reauthorization_required"
    );
    const session = await harness.playbackSessions.getSession(PROFILE_ID, SESSION_ID);
    assert.equal(session.state, state.expected);
    assert.equal(session.revision, 2);
    assert.equal(harness.calls.length, 0);
    const [queued] = await harness.playbackSessions.listDispatches(PROFILE_ID, SESSION_ID);
    assert.equal(queued.status, "queued");
    assert.equal(queued.event, "pause");
  }
});

test("an admitted upstream start linearly precedes a concurrent durable pause", async () => {
  const entered = deferred();
  const release = deferred();
  const order = [];
  const harness = durableFixture({
    async dispatch(request) {
      order.push("enter:" + request.action);
      if (request.action === "start") {
        entered.resolve();
        await release.promise;
      }
      order.push("exit:" + request.action);
      return { status: 201 };
    },
  });
  await harness.service.bindClaim(binding(), harness.claim);
  const starting = harness.service.scrobble(binding(), durableInput({
    dispatchId: "dispatch_concurrent_start",
  }));
  await entered.promise;
  let pauseSettled = false;
  const pausing = harness.service.scrobble(binding(), durableInput({
    dispatchId: "dispatch_concurrent_pause",
    event: "pause",
    paused: true,
  })).then((value) => {
    pauseSettled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(pauseSettled, false);
  release.resolve();
  assert.equal((await starting).status, "scrobbled");
  assert.equal((await pausing).status, "scrobbled");
  assert.deepEqual(order, ["enter:start", "exit:start", "enter:pause", "exit:pause"]);
});

test("profile device source and session invalidation prevent every later upstream admission", async () => {
  const invalidations = [
    async (harness) => harness.playbackSessions.invalidateProfile(PROFILE_ID, 2),
    async (harness) => harness.playbackSessions.invalidateDevice(PROFILE_ID, DEVICE_ID, 2),
    async (harness) => harness.playbackSessions.invalidateSourceClaim({
      profileId: PROFILE_ID,
      contextId: CONTEXT_ID,
      playbackGeneration: PLAYBACK_GENERATION,
      contextRevision: "1",
    }),
    async (harness) => harness.playbackSessions.invalidateSession({
      profileId: PROFILE_ID,
      profileRevision: 1,
      deviceId: DEVICE_ID,
      deviceGeneration: 1,
      sessionId: SESSION_ID,
      contextId: CONTEXT_ID,
      playbackGeneration: PLAYBACK_GENERATION,
      contextRevision: "1",
      expectedRevision: 1,
    }),
  ];
  for (const invalidate of invalidations) {
    const harness = durableFixture();
    await harness.service.bindClaim(binding(), harness.claim);
    await invalidate(harness);
    await assert.rejects(
      harness.service.scrobble(binding(), durableInput()),
      (error) => error && error.code === "scrobble_claim_stale"
    );
    assert.deepEqual(harness.calls, []);
  }
});

test("claim replacement and explicit release durably terminate the old exact session", async () => {
  const harness = durableFixture();
  await harness.service.bindClaim(binding(), harness.claim);
  const replacementSessionId = "session_trakt_service_0002";
  const replacementContextId = "context_trakt_service_0002";
  harness.claim = activeClaim({
    sessionId: replacementSessionId,
    context: { contextId: replacementContextId },
    deliveryBinding: {
      sessionId: replacementSessionId,
      contextId: replacementContextId,
      supersededSessionId: SESSION_ID,
    },
  });
  await harness.service.bindClaim(binding(), harness.claim);
  assert.equal((await harness.playbackSessions.getSession(PROFILE_ID, SESSION_ID)).state, "released");
  assert.equal((await harness.playbackSessions.getSession(PROFILE_ID, replacementSessionId)).state, "playing");

  const released = await harness.service.releaseSession(binding(), replacementSessionId);
  assert.equal(released, true);
  assert.equal((await harness.playbackSessions.getSession(PROFILE_ID, replacementSessionId)).state, "released");
  assert.deepEqual(harness.calls, []);
});

test("retry ownership survives a service restart and duplicate workers deliver one dispatch", async () => {
  let successfulEffects = 0;
  let failFirst = true;
  const first = durableFixture({
    retryBaseMs: 10,
    async dispatch() {
      if (failFirst) {
        failFirst = false;
        throw Object.assign(new Error("connection refused before request transmission"), {
          preEffect: true,
        });
      }
      successfulEffects += 1;
      return { status: 201 };
    },
  });
  await first.service.bindClaim(binding(), first.claim);
  await assert.rejects(
    first.service.scrobble(binding(), durableInput({ dispatchId: "dispatch_restart_retry" })),
    (error) => error && error.code === "trakt_scrobble_unavailable"
  );
  assert.equal((await first.playbackSessions.listDispatches(PROFILE_ID, SESSION_ID))[0].status, "queued");
  first.now.value += 10;

  const workerOptions = {
    playbackContexts: { getActiveClaim: async () => first.claim },
    playbackSessions: first.playbackSessions,
    clock: () => first.now.value,
    leaseMs: 1_000,
    retryBaseMs: 10,
    retryMaxMs: 100,
    autoStart: false,
    dispatchInline: false,
    getCredential: async () => ({ access_token: "restart-internal-access" }),
    dispatch: async () => {
      successfulEffects += 1;
      return { status: 201 };
    },
    admit: async (_binding, operation) => operation(),
  };
  const workerA = new TraktScrobbleService({ ...workerOptions, workerId: "worker_restart_a" });
  const workerB = new TraktScrobbleService({ ...workerOptions, workerId: "worker_restart_b" });
  await Promise.all([workerA.runWorkerPass(), workerB.runWorkerPass()]);
  assert.equal(successfulEffects, 1);
  const [dispatchRecord] = await first.playbackSessions.listDispatches(PROFILE_ID, SESSION_ID);
  assert.equal(dispatchRecord.status, "delivered");
  assert.doesNotMatch(JSON.stringify(dispatchRecord.payload), /token|authorization|provider|source|url/i);
});

test("playback release preserves a queued terminal stop until Trakt delivery", async () => {
  let failBeforeEffect = true;
  const harness = durableFixture({
    retryBaseMs: 10,
    async dispatch(request) {
      if (failBeforeEffect) {
        failBeforeEffect = false;
        throw Object.assign(new Error("connection refused before stop transmission"), {
          preEffect: true,
        });
      }
      return { status: 201, action: request.action };
    },
  });
  await harness.service.bindClaim(binding(), harness.claim);
  await assert.rejects(
    harness.service.scrobble(binding(), durableInput({
      dispatchId: "dispatch_terminal_stop_0001",
      event: "stop",
      progress: 72,
      sessionRevision: 1,
    })),
    (error) => error && error.code === "trakt_scrobble_unavailable"
  );
  assert.equal((await harness.playbackSessions.getSession(PROFILE_ID, SESSION_ID)).state, "released");
  assert.equal((await harness.playbackSessions.listDispatches(PROFILE_ID, SESSION_ID))[0].status, "queued");

  assert.equal(await harness.service.releaseSession(binding(), SESSION_ID), false);
  assert.equal((await harness.playbackSessions.listDispatches(PROFILE_ID, SESSION_ID))[0].status, "queued");
  harness.now.value += 10;
  const worker = new TraktScrobbleService({
    playbackContexts: { getActiveClaim: async () => null },
    playbackSessions: harness.playbackSessions,
    clock: () => harness.now.value,
    workerId: "worker_terminal_stop_0001",
    leaseMs: 1_000,
    retryBaseMs: 10,
    retryMaxMs: 100,
    autoStart: false,
    dispatchInline: false,
    getCredential: async () => ({ access_token: "terminal-stop-access" }),
    dispatch: async (request) => {
      harness.calls.push(request);
      return { status: 201 };
    },
  });
  assert.equal((await worker.runWorkerPass()).delivered, 1);
  assert.equal(harness.calls.at(-1).action, "stop");
  assert.equal((await harness.playbackSessions.listDispatches(PROFILE_ID, SESSION_ID))[0].status, "delivered");
});

test("ambiguous outcomes and expired in-flight leases are terminalized without duplicate effects", async () => {
  let acceptedEffects = 0;
  const ambiguous = durableFixture({
    async dispatch() {
      acceptedEffects += 1;
      throw new Error("connection closed after the upstream may have accepted the request");
    },
  });
  await ambiguous.service.bindClaim(binding(), ambiguous.claim);
  await assert.rejects(
    ambiguous.service.scrobble(
      binding(),
      durableInput({ dispatchId: "dispatch_ambiguous_effect_0001" })
    ),
    (error) => error && error.code === "trakt_scrobble_unavailable"
  );
  assert.equal(acceptedEffects, 1);
  assert.equal(
    (await ambiguous.playbackSessions.listDispatches(PROFILE_ID, SESSION_ID))[0].status,
    "delivered"
  );
  ambiguous.now.value += 10_000;
  await ambiguous.service.runWorkerPass();
  assert.equal(acceptedEffects, 1);

  const expired = durableFixture({ dispatchInline: false, leaseMs: 100 });
  await expired.service.bindClaim(binding(), expired.claim);
  await expired.playbackSessions.transitionAndEnqueue({
    profileId: PROFILE_ID,
    profileRevision: 1,
    deviceId: DEVICE_ID,
    deviceGeneration: 1,
    sessionId: SESSION_ID,
    contextId: CONTEXT_ID,
    playbackGeneration: PLAYBACK_GENERATION,
    contextRevision: "1",
    expectedRevision: 1,
    state: "playing",
    dispatch: {
      id: "dispatch_crashed_inflight_0001",
      event: "start",
      progress: 33,
      payload: { movie: { ids: { imdb: "tt0133093" } }, progress: 33 },
    },
  });
  const abandonedLease = await expired.playbackSessions.claimDispatch({
    workerId: "worker_that_crashed_0001",
    leaseMs: 100,
  });
  assert.equal(abandonedLease.dispatch.attemptCount, 1);
  expired.now.value += 100;

  let replayCalls = 0;
  const recoveringWorker = new TraktScrobbleService({
    playbackContexts: { getActiveClaim: async () => expired.claim },
    playbackSessions: expired.playbackSessions,
    clock: () => expired.now.value,
    workerId: "worker_after_crash_0001",
    leaseMs: 100,
    retryBaseMs: 10,
    retryMaxMs: 100,
    autoStart: false,
    dispatchInline: false,
    getCredential: async () => ({ access_token: "must-not-be-used" }),
    dispatch: async () => {
      replayCalls += 1;
      throw new Error("an expired in-flight lease was replayed");
    },
    admit: async (_binding, operation) => operation(),
  });
  const recovered = await recoveringWorker.runWorkerPass();
  assert.equal(recovered.ambiguous, 1);
  assert.equal(replayCalls, 0);
  const [terminal] = await expired.playbackSessions.listDispatches(PROFILE_ID, SESSION_ID);
  assert.equal(terminal.status, "delivered");
  assert.equal(terminal.attemptCount, 2);
});
