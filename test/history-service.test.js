"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  HISTORY_INPUT_MAX_BYTES,
  HistoryService,
  normalizeHistoryInput,
  projectCanonicalIdentity,
} = require("../lib/history-service");
const {
  EnvelopeCrypto,
  MemoryHistoryRepository,
  TokenService,
} = require("../lib/storage");
const { createSqliteRepositories } = require("../lib/storage/sqlite");

let Database = null;
try {
  Database = require("better-sqlite3");
} catch (_error) {
  // SQLite coverage is conditional on the pinned native dependency being available.
}

const PROFILE_A = "profile_history_a";
const PROFILE_B = "profile_history_b";
const DEVICE_A = "device_history_a";
const DEVICE_B = "device_history_b";
const CONTENT_KEY = "a".repeat(64);

function binding(profileId = PROFILE_A, deviceId = DEVICE_A) {
  return { profileId, deviceId };
}

function movieIdentity(overrides = {}) {
  return {
    provider: "imdb",
    id: "tt0133093",
    mediaType: "movie",
    provenance: "metadata-request",
    confidence: "canonical",
    ...overrides,
  };
}

function historyInput(overrides = {}) {
  return {
    canonicalIdentity: movieIdentity(),
    displaySnapshot: {
      title: "The Matrix",
      year: 1999,
      poster: "https://image.tmdb.org/t/p/w342/matrix.jpg",
    },
    playbackSnapshot: {
      providerId: "provider_history_0001",
      sourceFingerprint: "v1:url:sha256:" + "b".repeat(64),
      subtitleLanguages: ["en"],
      subtitlesEnabled: true,
    },
    positionMs: 120000,
    durationMs: 8160000,
    watchedMs: 120000,
    completed: false,
    ...overrides,
  };
}

function revisionConflict() {
  const error = new Error("conflict");
  error.code = "revision_conflict";
  return error;
}

test("history validation rejects invalid keys and client-owned identity before repository access", async () => {
  let gets = 0;
  let puts = 0;
  const service = new HistoryService({
    repository: {
      async get() {
        gets += 1;
        return null;
      },
      async getForWrite() {
        gets += 1;
        return null;
      },
      async upsert() {
        puts += 1;
        throw new Error("must not write");
      },
    },
    clock: () => 1000,
  });

  for (const key of ["A".repeat(64), "a".repeat(63), "g".repeat(64), ""]) {
    await assert.rejects(
      () => service.put(binding(), key, historyInput()),
      (error) => error.code === "invalid_content_key" && error.status === 400
    );
  }
  await assert.rejects(
    () => service.get(binding(), "B".repeat(64)),
    (error) => error.code === "invalid_content_key"
  );
  assert.equal(gets, 0);
  assert.equal(puts, 0);

  for (const field of ["profileId", "deviceId", "lastPlayedAt", "title", "revision"]) {
    await assert.rejects(
      () => service.put(binding(), CONTENT_KEY, { ...historyInput(), [field]: "client-owned" }),
      (error) => error.code === "invalid_history_request"
    );
  }
  assert.equal(gets, 0);
  assert.equal(puts, 0);
});

test("history schema is exact, bounded, safe-integer-only, and media-consistent", () => {
  const invalid = [
    { ...historyInput(), positionMs: Number.MAX_SAFE_INTEGER + 1 },
    { ...historyInput(), watchedMs: -1 },
    { ...historyInput(), completed: 1 },
    { ...historyInput(), positionMs: 1, durationMs: 0, watchedMs: 0 },
    { ...historyInput(), positionMs: 0, durationMs: 0, watchedMs: 1 },
    { ...historyInput(), positionMs: 101, durationMs: 100, watchedMs: 100 },
    { ...historyInput(), positionMs: 100, durationMs: 100, watchedMs: 101 },
    { ...historyInput(), canonicalIdentity: movieIdentity({ provider: "other" }) },
    { ...historyInput(), canonicalIdentity: movieIdentity({ confidence: "probable" }) },
    { ...historyInput(), canonicalIdentity: movieIdentity({ id: "tt0133093:1" }) },
    {
      ...historyInput(),
      canonicalIdentity: movieIdentity({ season: 1, episode: 2 }),
    },
    {
      ...historyInput(),
      canonicalIdentity: movieIdentity({ mediaType: "episode", season: 1 }),
    },
    {
      ...historyInput(),
      canonicalIdentity: {
        ...movieIdentity(),
        provider: "tmdb",
        id: "603",
      },
    },
    {
      ...historyInput(),
      canonicalIdentity: { ...movieIdentity(), extra: true },
    },
    { ...historyInput(), displaySnapshot: { unknown: "field" } },
    { ...historyInput(), displaySnapshot: { poster: "http://images.example/poster.jpg" } },
    { ...historyInput(), playbackSnapshot: { sourceUrl: "https://secret.example/video" } },
    { ...historyInput(), playbackSnapshot: { quality: "x".repeat(257) } },
  ];
  for (const value of invalid) {
    assert.throws(
      () => normalizeHistoryInput(value),
      (error) => error.code === "invalid_history_request" && error.status === 400
    );
  }

  const episode = normalizeHistoryInput({
    ...historyInput(),
    canonicalIdentity: {
      ...movieIdentity(),
      mediaType: "episode",
      season: 0,
      episode: 0,
    },
    displaySnapshot: { title: "Special", season: 0, episode: 0 },
  });
  assert.equal(episode.canonicalIdentity.season, 0);
  assert.equal(episode.canonicalIdentity.episode, 0);

  const oversized = {
    ...historyInput(),
    displaySnapshot: { title: "x".repeat(HISTORY_INPUT_MAX_BYTES) },
  };
  assert.throws(
    () => normalizeHistoryInput(oversized),
    (error) => error.code === "invalid_history_request"
  );
});

test("memory history is profile-shared across devices with server-monotonic timestamps and bounded DTOs", async () => {
  let now = 5000;
  const repository = new MemoryHistoryRepository({ clock: () => now });
  const service = new HistoryService({ repository, clock: () => now });

  const first = await service.put(binding(), CONTENT_KEY, historyInput());
  assert.equal(first.lastPlayedAt, 5000);
  assert.deepEqual(Object.keys(first).sort(), [
    "canonicalIdentity",
    "completed",
    "contentKey",
    "displaySnapshot",
    "durationMs",
    "lastPlayedAt",
    "playbackSnapshot",
    "positionMs",
    "watchedMs",
  ]);
  for (const internal of ["profileId", "deviceId", "revision", "changeSequence", "updatedAt"]) {
    assert.equal(Object.hasOwn(first, internal), false);
  }

  now = 4000;
  const second = await service.put(
    binding(PROFILE_A, DEVICE_B),
    CONTENT_KEY,
    historyInput({ positionMs: 90000, watchedMs: 130000 })
  );
  assert.equal(second.lastPlayedAt, 5001);
  assert.equal(second.positionMs, 90000);
  assert.equal(second.watchedMs, 130000);
  assert.deepEqual(await service.get(binding(PROFILE_A, DEVICE_A), CONTENT_KEY), second);
  assert.deepEqual(await service.get(binding(PROFILE_A, DEVICE_B), CONTENT_KEY), second);
  assert.equal(await service.get(binding(PROFILE_B, DEVICE_B), CONTENT_KEY), null);

  const raw = await repository.get(PROFILE_A, CONTENT_KEY);
  assert.equal(raw.profileId, PROFILE_A);
  assert.equal(raw.revision, 2);
  assert.equal(Object.hasOwn(second, "profileId"), false);
});

test("history mutations carry the authenticated device generation to the final repository write", async () => {
  let current = null;
  const calls = [];
  const repository = {
    async get() {
      return current;
    },
    async getForWrite() {
      return current;
    },
    async upsert(profileId, entry, expectedRevision, options) {
      calls.push({ operation: "upsert", profileId, expectedRevision, options });
      current = {
        ...entry,
        profileId,
        revision: expectedRevision + 1,
        changeSequence: 1,
        updatedAt: entry.lastPlayedAt,
        deletedAt: null,
      };
      return current;
    },
    async remove(profileId, contentKey, expectedRevision, options) {
      calls.push({ operation: "remove", profileId, contentKey, expectedRevision, options });
      return true;
    },
  };
  const service = new HistoryService({ repository, clock: () => 1000 });
  const authenticated = {
    profileId: PROFILE_A,
    deviceId: DEVICE_A,
    deviceGeneration: 7,
    historyGeneration: 3,
  };

  await service.put(authenticated, CONTENT_KEY, historyInput());
  await service.remove(authenticated, CONTENT_KEY);

  assert.deepEqual(calls.map((call) => call.options), [
    { generation: 3, deviceId: DEVICE_A, deviceGeneration: 7 },
    { generation: 3, deviceId: DEVICE_A, deviceGeneration: 7 },
  ]);
});

test("memory history service resurrects a tombstone without exposing it through GET", async () => {
  let now = 1000;
  const repository = new MemoryHistoryRepository({ clock: () => now });
  const service = new HistoryService({ repository, clock: () => now });
  await service.put(binding(), CONTENT_KEY, historyInput());
  assert.equal(await repository.remove(PROFILE_A, CONTENT_KEY, 1), true);
  assert.equal(await service.get(binding(), CONTENT_KEY), null);

  const tombstone = await repository.getForWrite(PROFILE_A, CONTENT_KEY);
  assert.equal(tombstone.revision, 2);
  assert.ok(tombstone.deletedAt !== null);
  now = 900;
  const resurrected = await service.put(
    binding(PROFILE_A, DEVICE_B),
    CONTENT_KEY,
    historyInput({ positionMs: 5000, watchedMs: 5000 })
  );
  const stored = await repository.getForWrite(PROFILE_A, CONTENT_KEY);
  assert.equal(stored.revision, 3);
  assert.equal(stored.deletedAt, null);
  assert.equal(resurrected.lastPlayedAt, 1001);
  assert.deepEqual(await service.get(binding(), CONTENT_KEY), resurrected);
});

test("history DTO projection strips private legacy fields and normalizes legacy IMDb identity", async () => {
  const repository = new MemoryHistoryRepository({ clock: () => 1000 });
  await repository.upsert(
    PROFILE_A,
    {
      contentKey: CONTENT_KEY,
      canonicalIdentity: { imdb: "tt0133093" },
      displaySnapshot: { title: "The Matrix", privateBlob: "do-not-return" },
      playbackSnapshot: {},
      positionMs: 10,
      durationMs: 100,
      watchedMs: 10,
      completed: false,
      lastPlayedAt: 1000,
    },
    0
  );
  const dto = await new HistoryService({ repository }).get(binding(), CONTENT_KEY);
  assert.deepEqual(dto.canonicalIdentity, movieIdentity());
  assert.deepEqual(dto.displaySnapshot, { title: "The Matrix" });
  assert.equal(JSON.stringify(dto).includes("privateBlob"), false);
});

test("an existing content key keeps its canonical identity binding immutable", async () => {
  const repository = new MemoryHistoryRepository({ clock: () => 2000 });
  const service = new HistoryService({ repository, clock: () => 2000 });
  await service.put(binding(), CONTENT_KEY, historyInput());

  await assert.rejects(
    () =>
      service.put(
        binding(),
        CONTENT_KEY,
        historyInput({ canonicalIdentity: movieIdentity({ id: "tt0234215" }) })
      ),
    (error) => error.code === "history_identity_conflict" && error.status === 409
  );
  const afterConflict = await repository.get(PROFILE_A, CONTENT_KEY);
  assert.equal(afterConflict.canonicalIdentity.id, "tt0133093");
  assert.equal(afterConflict.revision, 1);

  await assert.rejects(
    () =>
      service.put(
        binding(),
        CONTENT_KEY,
        historyInput({
          canonicalIdentity: movieIdentity({ provenance: "verified-external-id" }),
        })
      ),
    (error) => error.code === "history_identity_conflict" && error.status === 409
  );
  assert.equal((await repository.get(PROFILE_A, CONTENT_KEY)).revision, 1);

  const nullUpdate = await service.put(
    binding(),
    CONTENT_KEY,
    historyInput({ canonicalIdentity: null, positionMs: 130000, watchedMs: 130000 })
  );
  assert.equal(nullUpdate.canonicalIdentity.id, "tt0133093");
  assert.equal((await repository.get(PROFILE_A, CONTENT_KEY)).canonicalIdentity.id, "tt0133093");
});

test("an empty direct event preserves completed history until meaningful rewatch progress", async () => {
  let now = 6000;
  const repository = new MemoryHistoryRepository({ clock: () => now });
  const service = new HistoryService({ repository, clock: () => now });
  await service.put(
    binding(),
    CONTENT_KEY,
    historyInput({ positionMs: 8160000, watchedMs: 8160000, completed: true })
  );

  now = 6001;
  const emptyEvent = await service.put(
    binding(),
    CONTENT_KEY,
    historyInput({ positionMs: 0, durationMs: 0, watchedMs: 0, completed: false })
  );
  assert.equal(emptyEvent.completed, true);
  assert.equal(emptyEvent.positionMs, 8160000);
  assert.equal(emptyEvent.durationMs, 8160000);
  assert.equal(emptyEvent.watchedMs, 8160000);

  now = 6002;
  const rewatch = await service.put(
    binding(),
    CONTENT_KEY,
    historyInput({ positionMs: 1000, watchedMs: 1000, completed: false })
  );
  assert.equal(rewatch.completed, false);
  assert.equal(rewatch.positionMs, 1000);
  assert.equal(rewatch.watchedMs, 1000);
  assert.equal((await repository.get(PROFILE_A, CONTENT_KEY)).revision, 3);
});

test("a later rewatch deterministically clears a concurrent completed event after CAS retry", async () => {
  const durable = new MemoryHistoryRepository({ clock: () => 7000 });
  let initialReads = 0;
  let releaseReads;
  let releaseCompletedWrite;
  const bothRead = new Promise((resolve) => {
    releaseReads = resolve;
  });
  const completedWrite = new Promise((resolve) => {
    releaseCompletedWrite = resolve;
  });
  const repository = {
    async get(profileId, contentKey) {
      return durable.get(profileId, contentKey);
    },
    async getForWrite(profileId, contentKey) {
      if (initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseReads();
        await bothRead;
        return null;
      }
      return durable.getForWrite(profileId, contentKey);
    },
    async upsert(profileId, entry, expectedRevision) {
      if (entry.completed) {
        const stored = await durable.upsert(profileId, entry, expectedRevision);
        releaseCompletedWrite();
        return stored;
      }
      await completedWrite;
      return durable.upsert(profileId, entry, expectedRevision);
    },
  };
  const sleeps = [];
  const service = new HistoryService({
    repository,
    clock: () => 7000,
    backoff: () => 2,
    jitter: () => 1,
    sleep: async (delay) => sleeps.push(delay),
  });

  const [lower, higher] = await Promise.all([
    service.put(
      binding(PROFILE_A, DEVICE_A),
      CONTENT_KEY,
      historyInput({ positionMs: 100, watchedMs: 100, completed: true })
    ),
    service.put(
      binding(PROFILE_A, DEVICE_B),
      CONTENT_KEY,
      historyInput({ positionMs: 200, watchedMs: 200 })
    ),
  ]);
  const stored = await durable.get(PROFILE_A, CONTENT_KEY);
  assert.equal(stored.revision, 2);
  assert.equal(stored.positionMs, 200);
  assert.equal(stored.watchedMs, 200);
  assert.equal(stored.completed, false);
  assert.equal(stored.lastPlayedAt, 7001);
  assert.equal(lower.contentKey, CONTENT_KEY);
  assert.equal(higher.contentKey, CONTENT_KEY);
  assert.deepEqual(sleeps, [3]);
});

test("an empty event cannot clear a concurrent completed event after CAS retry", async () => {
  const durable = new MemoryHistoryRepository({ clock: () => 7500 });
  let initialReads = 0;
  let releaseReads;
  let releaseCompletedWrite;
  const bothRead = new Promise((resolve) => {
    releaseReads = resolve;
  });
  const completedWrite = new Promise((resolve) => {
    releaseCompletedWrite = resolve;
  });
  const repository = {
    async get(profileId, contentKey) {
      return durable.get(profileId, contentKey);
    },
    async getForWrite(profileId, contentKey) {
      if (initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseReads();
        await bothRead;
        return null;
      }
      return durable.getForWrite(profileId, contentKey);
    },
    async upsert(profileId, entry, expectedRevision) {
      if (entry.completed) {
        const stored = await durable.upsert(profileId, entry, expectedRevision);
        releaseCompletedWrite();
        return stored;
      }
      await completedWrite;
      return durable.upsert(profileId, entry, expectedRevision);
    },
  };
  const sleeps = [];
  const service = new HistoryService({
    repository,
    clock: () => 7500,
    backoff: () => 2,
    jitter: () => 1,
    sleep: async (delay) => sleeps.push(delay),
  });

  await Promise.all([
    service.put(
      binding(PROFILE_A, DEVICE_A),
      CONTENT_KEY,
      historyInput({ positionMs: 8160000, watchedMs: 8160000, completed: true })
    ),
    service.put(
      binding(PROFILE_A, DEVICE_B),
      CONTENT_KEY,
      historyInput({ positionMs: 0, durationMs: 0, watchedMs: 0, completed: false })
    ),
  ]);
  const stored = await durable.get(PROFILE_A, CONTENT_KEY);
  assert.equal(stored.revision, 2);
  assert.equal(stored.completed, true);
  assert.equal(stored.positionMs, 8160000);
  assert.equal(stored.durationMs, 8160000);
  assert.equal(stored.watchedMs, 8160000);
  assert.deepEqual(sleeps, [3]);
});

test("racing different canonical identities cannot rebind a content key after CAS retry", async () => {
  const durable = new MemoryHistoryRepository({ clock: () => 8000 });
  let initialReads = 0;
  let releaseReads;
  const bothRead = new Promise((resolve) => {
    releaseReads = resolve;
  });
  const repository = {
    async get(profileId, contentKey) {
      return durable.get(profileId, contentKey);
    },
    async getForWrite(profileId, contentKey) {
      if (initialReads < 2) {
        initialReads += 1;
        if (initialReads === 2) releaseReads();
        await bothRead;
        return null;
      }
      return durable.getForWrite(profileId, contentKey);
    },
    async upsert(...args) {
      return durable.upsert(...args);
    },
  };
  const service = new HistoryService({
    repository,
    clock: () => 8000,
    backoff: () => 0,
    jitter: () => 0,
    sleep: async () => {},
  });

  const contenders = await Promise.allSettled([
    service.put(binding(PROFILE_A, DEVICE_A), CONTENT_KEY, historyInput()),
    service.put(
      binding(PROFILE_A, DEVICE_B),
      CONTENT_KEY,
      historyInput({ canonicalIdentity: movieIdentity({ id: "tt0234215" }) })
    ),
  ]);
  assert.equal(contenders.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = contenders.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "history_identity_conflict");
  assert.equal(rejected.reason.status, 409);
  const stored = await durable.get(PROFILE_A, CONTENT_KEY);
  assert.equal(stored.revision, 1);
  assert.ok(["tt0133093", "tt0234215"].includes(stored.canonicalIdentity.id));
});

test("CAS retry exhaustion uses injected backoff and maps explicitly to a 409 conflict", async () => {
  let attempts = 0;
  const sleeps = [];
  const service = new HistoryService({
    repository: {
      async get() {
        return null;
      },
      async getForWrite() {
        return null;
      },
      async upsert() {
        attempts += 1;
        throw revisionConflict();
      },
    },
    clock: () => 1000,
    maxAttempts: 3,
    backoff: (attempt) => 3 * (attempt + 1),
    jitter: (_maximum, attempt) => attempt + 1,
    sleep: async (delay) => sleeps.push(delay),
  });

  await assert.rejects(
    () => service.put(binding(), CONTENT_KEY, historyInput()),
    (error) => error.code === "history_conflict" && error.status === 409
  );
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [4, 8]);
});

test(
  "SQLite history service persists profile-shared DTOs through the durable adapter",
  { skip: Database ? false : "better-sqlite3 is not installed" },
  async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-history-service-"));
    const filename = path.join(directory, "history.sqlite3");
    const database = new Database(filename);
    t.after(() => {
      if (database.open) database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    let now = 9000;
    let sequence = 0;
    const repositories = createSqliteRepositories(database, {
      clock: () => now,
      envelopeCrypto: new EnvelopeCrypto({
        primaryKeyId: "history-key",
        keys: { "history-key": Buffer.alloc(32, 0x41) },
      }),
      tokenService: new TokenService({ pepper: Buffer.alloc(32, 0x42) }),
      idFactory: (kind) => kind + "_history_" + String(++sequence).padStart(8, "0"),
    });
    const profile = (await repositories.profiles.create({ displayName: "History" })).profile;
    const service = new HistoryService({ repository: repositories.history, clock: () => now });
    const scopedBinding = binding(profile.id, "device_history_sqlite");

    const written = await service.put(scopedBinding, CONTENT_KEY, historyInput());
    now = 9001;
    const read = await new HistoryService({ repository: repositories.history }).get(
      binding(profile.id, "device_history_other"),
      CONTENT_KEY
    );
    assert.deepEqual(read, written);
    assert.equal((await repositories.history.get(profile.id, CONTENT_KEY)).revision, 1);

    assert.equal(await repositories.history.remove(profile.id, CONTENT_KEY, 1), true);
    assert.equal(await service.get(scopedBinding, CONTENT_KEY), null);
    const tombstone = await repositories.history.getForWrite(profile.id, CONTENT_KEY);
    assert.equal(tombstone.revision, 2);
    assert.ok(tombstone.deletedAt !== null);
    now = 9002;
    const resurrected = await service.put(
      scopedBinding,
      CONTENT_KEY,
      historyInput({ positionMs: 250000, watchedMs: 250000 })
    );
    assert.equal((await repositories.history.get(profile.id, CONTENT_KEY)).revision, 3);
    assert.deepEqual(await service.get(scopedBinding, CONTENT_KEY), resurrected);
  }
);

test("canonical projection accepts legacy and source-backed provider identities", () => {
  assert.deepEqual(projectCanonicalIdentity({ imdb: "tt0133093" }), {
    provider: "imdb",
    id: "tt0133093",
    mediaType: "movie",
  });
  assert.deepEqual(projectCanonicalIdentity(movieIdentity()), {
    provider: "imdb",
    id: "tt0133093",
    mediaType: "movie",
  });
  assert.deepEqual(
    projectCanonicalIdentity({
      ...movieIdentity(),
      provider: "tmdb",
      id: "603",
      mediaType: "episode",
      season: 0,
      episode: 1,
    }),
    { provider: "tmdb", id: "603", mediaType: "episode", season: 0, episode: 1 }
  );
});
