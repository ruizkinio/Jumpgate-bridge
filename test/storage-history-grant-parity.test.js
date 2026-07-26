"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const Database = require("better-sqlite3");
const { Pool } = require("pg");

const {
  EnvelopeCrypto,
  TokenService,
  createMemoryDurableRepositories,
} = require("../lib/storage");
const {
  digestHistoryEventRequest,
  normalizeHistoryEventBody,
} = require("../lib/history-protocol");
const {
  PostgresMigrationRunner,
  createPostgresRepositories,
} = require("../lib/storage/postgres");
const { createSqliteRepositories } = require("../lib/storage/sqlite");

const POSTGRES_URL = process.env.TEST_POSTGRES_URL || process.env.DATABASE_URL || "";
const AGGREGATED_POSTGRES_LIVE_RUN =
  process.env.JUMPGATE_POSTGRES_LIVE_AGGREGATE === "1";

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function uuid(number, version = 7) {
  return `00000000-0000-${version}000-8000-${number.toString(16).padStart(12, "0")}`;
}

function sequenceRandom(seed) {
  let next = seed;
  return (length) => {
    const output = Buffer.alloc(length, next);
    next = next === 255 ? 1 : next + 1;
    return output;
  };
}

function primitives(seed) {
  const keyId = `history-parity-${seed}`;
  return {
    tokenService: new TokenService({
      pepper: Buffer.alloc(32, 0x40 + seed),
      randomBytes: sequenceRandom(0x10 + seed),
    }),
    envelopeCrypto: new EnvelopeCrypto({
      primaryKeyId: keyId,
      keys: { [keyId]: Buffer.alloc(32, 0x60 + seed) },
      randomBytes: sequenceRandom(0x20 + seed),
    }),
  };
}

function identifiers(backend) {
  const counters = new Map();
  return (kind) => {
    const label = kind || "record";
    const next = (counters.get(label) || 0) + 1;
    counters.set(label, next);
    return `${label}_${backend}_hg_${String(next).padStart(8, "0")}`;
  };
}

function quoteIdentifier(value) {
  assert.match(value, /^[a-z0-9_]+$/);
  return `"${value}"`;
}

function memoryAdapter(repositories) {
  return {
    backend: "memory",
    durable: false,
    async dispatchStatuses(profileId, sessionId) {
      const grants = repositories.historyGrants.storageSnapshot();
      const grant = grants.grants.find(
        (item) => item.profileId === profileId && item.sessionId === sessionId
      );
      const internal = grant
        ? grants.dispatchIntents.filter((item) => item.grantId === grant.grantId)
        : [];
      const direct = repositories.playbackSessions.storageSnapshot().dispatches.filter(
        (item) => item.profileId === profileId && item.sessionId === sessionId
      );
      return [...internal, ...direct].map((item) => item.status).sort();
    },
    async inspect(profileId, grantId, sessionId, contentKey) {
      const snapshot = repositories.historyGrants.storageSnapshot();
      const grant = snapshot.grants.find((item) => item.grantId === grantId) || null;
      const history = contentKey ? await repositories.history.get(profileId, contentKey) : null;
      return {
        dispatches: snapshot.dispatchIntents.filter((item) => item.grantId === grantId).length,
        grant,
        history,
        playback: null,
        receipts: snapshot.receipts.filter((item) => item.grantId === grantId).length,
      };
    },
    async rawAuthority(grantId) {
      const snapshot = repositories.historyGrants.storageSnapshot();
      const grant = snapshot.grants.find((item) => item.grantId === grantId);
      return {
        text: JSON.stringify(snapshot),
        tokenEnvelope: grant.tokenEnvelope,
        tokenHash: grant.tokenHash,
      };
    },
    async revocations() {
      return [];
    },
    async sessionState(profileId, sessionId) {
      const session = repositories.playbackSessions.storageSnapshot().sessions.find(
        (item) => item.profileId === profileId && item.sessionId === sessionId
      );
      return session ? session.state : null;
    },
  };
}

function sqliteAdapter(database, directory, repositories) {
  return {
    backend: "sqlite",
    durable: true,
    async dispatchStatuses(profileId, sessionId) {
      return database.prepare(`
        SELECT status FROM scrobble_dispatches
         WHERE profile_id = ? AND session_id = ? ORDER BY id
      `).all(profileId, sessionId).map((row) => row.status);
    },
    async inspect(profileId, grantId, sessionId, contentKey) {
      const grant = database.prepare("SELECT * FROM history_grants WHERE grant_id = ?").get(grantId);
      return {
        dispatches: database.prepare(
          "SELECT count(*) AS count FROM scrobble_dispatches WHERE profile_id = ? AND session_id = ?"
        ).get(profileId, sessionId).count,
        grant,
        history: contentKey
          ? database.prepare(
              "SELECT * FROM cloud_history WHERE profile_id = ? AND content_key = ?"
            ).get(profileId, contentKey) || null
          : null,
        playback: database.prepare(
          "SELECT * FROM playback_sessions WHERE profile_id = ? AND session_id = ?"
        ).get(profileId, sessionId) || null,
        receipts: database.prepare(
          "SELECT count(*) AS count FROM history_event_receipts WHERE grant_id = ?"
        ).get(grantId).count,
      };
    },
    async rawAuthority(grantId) {
      const grant = database.prepare("SELECT * FROM history_grants WHERE grant_id = ?").get(grantId);
      const rows = {
        grant,
        receipts: database.prepare(
          "SELECT * FROM history_event_receipts WHERE grant_id = ? ORDER BY idempotency_key"
        ).all(grantId),
        dispatches: database.prepare(
          "SELECT * FROM scrobble_dispatches WHERE profile_id = ? AND session_id = ? ORDER BY id"
        ).all(grant.profile_id, grant.session_id),
        revocations: database.prepare(
          "SELECT * FROM history_grant_revocations WHERE profile_id = ? ORDER BY kind, scope_hash"
        ).all(grant.profile_id),
      };
      return {
        text: JSON.stringify(rows),
        tokenEnvelope: JSON.parse(grant.token_envelope),
        tokenHash: grant.token_hash,
      };
    },
    async assertNoFileLeak(secret) {
      database.pragma("wal_checkpoint(TRUNCATE)");
      for (const entry of fs.readdirSync(directory)) {
        const bytes = fs.readFileSync(path.join(directory, entry));
        assert.equal(bytes.includes(Buffer.from(secret, "utf8")), false, `${entry} leaked grant`);
      }
    },
    async installReceiptFailure() {
      database.exec(`
        CREATE TRIGGER fail_history_receipt
        BEFORE INSERT ON history_event_receipts
        BEGIN
          SELECT RAISE(ABORT, 'forced history receipt failure');
        END
      `);
      return async () => database.exec("DROP TRIGGER fail_history_receipt");
    },
    async assertTerminalReceiptConstraint(grantId, receiptId) {
      assert.throws(
        () => database.prepare(
          "DELETE FROM history_event_receipts WHERE grant_id = ? AND idempotency_key = ?"
        ).run(grantId, receiptId),
        /FOREIGN KEY constraint failed/
      );
    },
    async revocations(profileId) {
      return database.prepare(
        "SELECT kind, scope_hash FROM history_grant_revocations WHERE profile_id = ?"
      ).all(profileId);
    },
    async sessionState(profileId, sessionId) {
      const row = database.prepare(`
        SELECT state FROM playback_sessions WHERE profile_id = ? AND session_id = ?
      `).get(profileId, sessionId);
      return row ? row.state : null;
    },
  };
}

function postgresAdapter(pool) {
  return {
    backend: "postgres",
    durable: true,
    async dispatchStatuses(profileId, sessionId) {
      return (await pool.query(
        `SELECT status FROM scrobble_dispatches
          WHERE profile_id = $1 AND session_id = $2 ORDER BY id`,
        [profileId, sessionId]
      )).rows.map((row) => row.status);
    },
    async inspect(profileId, grantId, sessionId, contentKey) {
      const [grant, dispatches, receipts, playback, history] = await Promise.all([
        pool.query("SELECT * FROM history_grants WHERE grant_id = $1", [grantId]),
        pool.query(
          "SELECT count(*)::integer AS count FROM scrobble_dispatches WHERE profile_id = $1 AND session_id = $2",
          [profileId, sessionId]
        ),
        pool.query(
          "SELECT count(*)::integer AS count FROM history_event_receipts WHERE grant_id = $1",
          [grantId]
        ),
        pool.query(
          "SELECT * FROM playback_sessions WHERE profile_id = $1 AND session_id = $2",
          [profileId, sessionId]
        ),
        contentKey
          ? pool.query(
              "SELECT * FROM cloud_history WHERE profile_id = $1 AND content_key = $2",
              [profileId, contentKey]
            )
          : Promise.resolve({ rows: [] }),
      ]);
      return {
        dispatches: dispatches.rows[0].count,
        grant: grant.rows[0] || null,
        history: history.rows[0] || null,
        playback: playback.rows[0] || null,
        receipts: receipts.rows[0].count,
      };
    },
    async rawAuthority(grantId) {
      const grantResult = await pool.query("SELECT * FROM history_grants WHERE grant_id = $1", [grantId]);
      const grant = grantResult.rows[0];
      const [receipts, dispatches, revocations] = await Promise.all([
        pool.query("SELECT * FROM history_event_receipts WHERE grant_id = $1", [grantId]),
        pool.query(
          "SELECT * FROM scrobble_dispatches WHERE profile_id = $1 AND session_id = $2",
          [grant.profile_id, grant.session_id]
        ),
        pool.query("SELECT * FROM history_grant_revocations WHERE profile_id = $1", [
          grant.profile_id,
        ]),
      ]);
      return {
        text: JSON.stringify({
          grant,
          receipts: receipts.rows,
          dispatches: dispatches.rows,
          revocations: revocations.rows,
        }),
        tokenEnvelope: grant.token_envelope,
        tokenHash: String(grant.token_hash).trim(),
      };
    },
    async installReceiptFailure() {
      await pool.query(`
        CREATE FUNCTION fail_history_receipt() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced history receipt failure' USING ERRCODE = 'P0001';
        END
        $$
      `);
      await pool.query(`
        CREATE TRIGGER fail_history_receipt
        BEFORE INSERT ON history_event_receipts
        FOR EACH ROW EXECUTE FUNCTION fail_history_receipt()
      `);
      return async () => {
        await pool.query("DROP TRIGGER fail_history_receipt ON history_event_receipts");
        await pool.query("DROP FUNCTION fail_history_receipt()");
      };
    },
    async assertTerminalReceiptConstraint(grantId, receiptId) {
      await assert.rejects(
        () => pool.query(
          "DELETE FROM history_event_receipts WHERE grant_id = $1 AND idempotency_key = $2::uuid",
          [grantId, receiptId]
        ),
        (error) => error.code === "23503"
      );
    },
    async revocations(profileId) {
      return (await pool.query(
        "SELECT kind, scope_hash::text AS scope_hash FROM history_grant_revocations WHERE profile_id = $1",
        [profileId]
      )).rows;
    },
    async sessionState(profileId, sessionId) {
      const result = await pool.query(
        "SELECT state FROM playback_sessions WHERE profile_id = $1 AND session_id = $2",
        [profileId, sessionId]
      );
      return result.rows[0] ? result.rows[0].state : null;
    },
  };
}

async function setupMemory() {
  const ids = identifiers("memory");
  const now = { value: 10_000 };
  const repositories = createMemoryDurableRepositories(primitives(1), {
    clock: () => now.value,
    profileIdFactory: () => ids("profile"),
    deviceIdFactory: () => ids("device"),
    historyGrantIdFactory: () => ids("grant"),
    historySessionIdFactory: () => ids("session"),
  });
  return { adapter: memoryAdapter(repositories), ids, now, repositories };
}

async function setupSqlite(t) {
  const ids = identifiers("sqlite");
  const now = { value: 10_000 };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-history-parity-"));
  const database = new Database(path.join(directory, "history.sqlite3"));
  const repositories = createSqliteRepositories(database, {
    ...primitives(2),
    clock: () => now.value,
    idFactory: ids,
    historyGrantIdFactory: () => ids("grant"),
    historySessionIdFactory: () => ids("session"),
    deviceTtlMs: 60_000,
    deviceTouchIntervalMs: 1_000,
  });
  t.after(() => {
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    adapter: sqliteAdapter(database, directory, repositories),
    ids,
    now,
    repositories,
  };
}

async function setupPostgres(t) {
  const schema = `jumpgate_history_${process.pid}_${crypto.randomBytes(5).toString("hex")}`;
  const admin = new Pool({ connectionString: POSTGRES_URL, max: 2 });
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  const pool = new Pool({
    connectionString: POSTGRES_URL,
    max: 32,
    options: `-c search_path=${schema},public`,
  });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  });
  await new PostgresMigrationRunner({ pool }).run();
  const ids = identifiers("postgres");
  const now = { value: 10_000 };
  const repositories = createPostgresRepositories(pool, {
    ...primitives(3),
    clock: () => now.value,
    idFactory: ids,
    historyGrantIdFactory: () => ids("grant"),
    historySessionIdFactory: () => ids("session"),
    deviceTtlMs: 60_000,
    deviceTouchIntervalMs: 1_000,
  });
  return { adapter: postgresAdapter(pool), ids, now, repositories };
}

async function binding(harness, label) {
  const created = await harness.repositories.profiles.create({ displayName: label });
  const registered = await harness.repositories.devices.register(created.profile.id, {
    displayName: `${label} Kodi`,
  });
  return {
    profileId: created.profile.id,
    profileRevision: created.profile.revision,
    deviceId: registered.device.id,
    deviceGeneration: registered.device.generation,
    historyGeneration: created.profile.historyGeneration,
    playbackGeneration: `g1:${label.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "_")}`,
  };
}

function sourceAuthority(reservation, bindingValue, kind, number) {
  const negative = kind === "negative";
  return {
    ...bindingValue,
    providerRevision: negative ? null : String(number + 10),
    contextId: negative ? null : `context_history_${String(number).padStart(6, "0")}`,
    contextRevision: negative ? null : String(number + 20),
    sessionId: reservation.sessionId,
    contentKey: negative ? null : sha256(`history-content-${number}`),
    canonicalIdentity: kind === "canonical"
      ? {
          provider: "imdb",
          id: "tt0133093",
          mediaType: "movie",
          provenance: "metadata-request",
          confidence: "canonical",
        }
      : null,
    displaySnapshot: negative ? {} : { title: `History ${kind} ${number}`, year: 1999 },
    claimStatus: negative ? "not_found" : "claimed",
    traktEligible: kind === "canonical",
    supersededSessionId: null,
  };
}

async function reserveAndFinalize(harness, kind, number, authorityOverrides = {}) {
  const bindingValue = await binding(harness, `${kind}_${number}`);
  return reserveAndFinalizeForBinding(
    harness,
    bindingValue,
    kind,
    number,
    authorityOverrides
  );
}

async function reserveAndFinalizeForBinding(
  harness,
  bindingValue,
  kind,
  number,
  authorityOverrides = {}
) {
  const requestDigest = sha256(`claim-request-${number}`);
  const reservation = await harness.repositories.historyGrants.reserve({
    attemptId: uuid(number),
    requestDigest,
    ...bindingValue,
  });
  const authority = {
    ...sourceAuthority(reservation, bindingValue, kind, number),
    ...authorityOverrides,
  };
  const grant = await harness.repositories.historyGrants.finalize({
    grantId: reservation.grantId,
    requestDigest,
    authority,
  });
  return { authority, binding: bindingValue, grant, requestDigest, reservation };
}

function eventBody(overrides = {}) {
  return {
    event: "start",
    sessionRevision: 1,
    positionMs: 20_000,
    durationMs: 100_000,
    watchedMs: 18_000,
    playbackPreferences: {
      subtitleTrackId: "subtitle_track_eng",
      audioTrackId: "audio_track_original",
      subtitlesEnabled: true,
      subtitleLanguages: ["eng"],
    },
    ...overrides,
  };
}

function eventInput(grant, idempotencyKey, body = eventBody()) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    profileId: grant.profileId,
    deviceId: grant.deviceId,
    grantToken: grant.grantToken,
    idempotencyKey,
    requestDigest: digestHistoryEventRequest(rawBody),
    event: normalizeHistoryEventBody(body),
  };
}

async function assertStale(operation) {
  await assert.rejects(operation, (error) => error.code === "history_grant_stale");
}

async function runParityContract(t, harness) {
  await t.test("reservation is durable, concurrent-idempotent, and capability-safe", async () => {
    const bindingValue = await binding(harness, "reservation_1");
    const requestDigest = sha256("reservation-exact-bytes");
    const input = { attemptId: uuid(1), requestDigest, ...bindingValue };
    const reservations = await Promise.all(
      Array.from({ length: 24 }, () => harness.repositories.historyGrants.reserve(input))
    );
    for (const reservation of reservations) assert.deepEqual(reservation, reservations[0]);
    assert.equal(reservations[0].status, "reserved");
    assert.match(reservations[0].grantToken, /^hg1_/);
    assert.equal(
      (await harness.repositories.historyGrants.getGrantBySession(
        bindingValue.profileId,
        reservations[0].sessionId
      )).status,
      "reserved"
    );
    await assert.rejects(
      () => harness.repositories.historyGrants.reserve({
        ...input,
        requestDigest: sha256("reservation-changed-bytes"),
      }),
      (error) => error.code === "history_claim_conflict"
    );

    const authority = sourceAuthority(reservations[0], bindingValue, "canonical", 1);
    const finalized = await harness.repositories.historyGrants.finalize({
      grantId: reservations[0].grantId,
      requestDigest,
      authority,
    });
    assert.deepEqual(
      await harness.repositories.historyGrants.finalize({
        grantId: reservations[0].grantId,
        requestDigest,
        authority,
      }),
      finalized
    );
    await assert.rejects(
      () => harness.repositories.historyGrants.finalize({
        grantId: finalized.grantId,
        requestDigest,
        authority: { ...authority, displaySnapshot: { title: "Changed" } },
      }),
      (error) => error.code === "history_claim_conflict"
    );

    const raw = await harness.adapter.rawAuthority(finalized.grantId);
    assert.match(raw.tokenHash, /^[a-f0-9]{64}$/);
    assert.equal(raw.text.includes(finalized.grantToken), false);
    assert.equal(JSON.stringify(raw.tokenEnvelope).includes(finalized.grantToken), false);
    if (harness.adapter.assertNoFileLeak) {
      await harness.adapter.assertNoFileLeak(finalized.grantToken);
    }
  });

  await t.test("canonical, local, and negative grants isolate history and Trakt intent", async () => {
    const canonical = await reserveAndFinalize(harness, "canonical", 10);
    const local = await reserveAndFinalize(harness, "local", 11);
    const negative = await reserveAndFinalize(harness, "negative", 12);
    const localCanonicalIdentity = {
      provider: "imdb",
      id: "tt0234215",
      mediaType: "movie",
      provenance: "metadata-request",
      confidence: "canonical",
    };
    const localCanonical = await reserveAndFinalize(harness, "local", 13, {
      canonicalIdentity: localCanonicalIdentity,
      traktEligible: false,
    });
    const canonicalResult = await harness.repositories.historyGrants.applyEvent(
      eventInput(canonical.grant, uuid(110))
    );
    const localResult = await harness.repositories.historyGrants.applyEvent(
      eventInput(local.grant, uuid(111))
    );
    const negativeResult = await harness.repositories.historyGrants.applyEvent(
      eventInput(negative.grant, uuid(112))
    );
    const localCanonicalResult = await harness.repositories.historyGrants.applyEvent(
      eventInput(localCanonical.grant, uuid(113))
    );
    assert.equal(canonicalResult.grantKind, "canonical");
    assert.ok(canonicalResult.history);
    assert.ok(canonicalResult.dispatchIntent);
    assert.equal(localResult.grantKind, "local");
    assert.ok(localResult.history);
    assert.equal(localResult.history.canonicalIdentity, null);
    assert.equal(localResult.dispatchIntent, null);
    assert.equal(negativeResult.grantKind, "negative");
    assert.equal(negativeResult.status, "local_only");
    assert.equal(negativeResult.history, null);
    assert.equal(negativeResult.dispatchIntent, null);
    assert.equal(localCanonical.grant.kind, "local");
    assert.deepEqual(localCanonicalResult.history.canonicalIdentity, localCanonicalIdentity);
    assert.equal(localCanonicalResult.dispatchIntent, null);

    const canonicalState = await harness.adapter.inspect(
      canonical.binding.profileId,
      canonical.grant.grantId,
      canonical.grant.sessionId,
      canonical.authority.contentKey
    );
    const localState = await harness.adapter.inspect(
      local.binding.profileId,
      local.grant.grantId,
      local.grant.sessionId,
      local.authority.contentKey
    );
    const negativeState = await harness.adapter.inspect(
      negative.binding.profileId,
      negative.grant.grantId,
      negative.grant.sessionId,
      null
    );
    assert.equal(canonicalState.dispatches, 1);
    assert.equal(localState.dispatches, 0);
    assert.equal(negativeState.dispatches, 0);
    assert.ok(canonicalState.history);
    assert.ok(localState.history);
    assert.equal(negativeState.history, null);
  });

  await t.test("concurrent exact retries converge and changed UUID reuse cannot mutate", async () => {
    const record = await reserveAndFinalize(harness, "canonical", 20);
    const idempotencyKey = uuid(220);
    const input = eventInput(record.grant, idempotencyKey);
    const results = await Promise.all(
      Array.from({ length: 32 }, () => harness.repositories.historyGrants.applyEvent(input))
    );
    for (const result of results) assert.deepEqual(result, results[0]);
    const before = await harness.adapter.inspect(
      record.binding.profileId,
      record.grant.grantId,
      record.grant.sessionId,
      record.authority.contentKey
    );
    assert.equal(before.receipts, 1);
    assert.equal(before.dispatches, 1);
    assert.equal(Number(before.history.revision), 1);

    await assert.rejects(
      () => harness.repositories.historyGrants.applyEvent(eventInput(
        record.grant,
        idempotencyKey,
        eventBody({ positionMs: 21_000, watchedMs: 19_000 })
      )),
      (error) => error.code === "history_event_idempotency_conflict"
    );
    const after = await harness.adapter.inspect(
      record.binding.profileId,
      record.grant.grantId,
      record.grant.sessionId,
      record.authority.contentKey
    );
    assert.equal(after.receipts, 1);
    assert.equal(after.dispatches, 1);
    assert.equal(Number(after.history.revision), 1);
  });

  await t.test("currency is checked before an old receipt can replay", async () => {
    const record = await reserveAndFinalize(harness, "canonical", 30);
    const input = eventInput(record.grant, uuid(330));
    await harness.repositories.historyGrants.applyEvent(input);
    await harness.repositories.historyGrants.revokeHistory(
      record.binding.profileId,
      record.binding.historyGeneration
    );
    await assertStale(() => harness.repositories.historyGrants.applyEvent(input));
    const state = await harness.adapter.inspect(
      record.binding.profileId,
      record.grant.grantId,
      record.grant.sessionId,
      record.authority.contentKey
    );
    assert.equal(state.receipts, 1);
  });

  await t.test("terminal replay is receipt-bound", async () => {
    const record = await reserveAndFinalize(harness, "canonical", 40);
    const terminalReceiptId = uuid(440);
    const terminal = eventInput(
      record.grant,
      terminalReceiptId,
      eventBody({ event: "stop", sessionRevision: 1 })
    );
    const stopped = await harness.repositories.historyGrants.applyEvent(terminal);
    assert.equal(stopped.sessionState, "released");
    assert.deepEqual(await harness.repositories.historyGrants.applyEvent(terminal), stopped);
    await assert.rejects(
      () => harness.repositories.historyGrants.applyEvent(eventInput(
        record.grant,
        terminalReceiptId,
        eventBody({ event: "completion", sessionRevision: 1, positionMs: 100_000 })
      )),
      (error) => error.code === "history_event_idempotency_conflict"
    );
    if (harness.adapter.durable) {
      await harness.adapter.assertTerminalReceiptConstraint(
        record.grant.grantId,
        terminalReceiptId
      );
    }
    await assert.rejects(
      () => harness.repositories.historyGrants.release({
        ...record.binding,
        sessionId: record.grant.sessionId,
        terminalReceiptId: uuid(441),
      }),
      (error) => error.code === "history_terminal_receipt_required"
    );
    assert.equal(
      await harness.repositories.historyGrants.release({
        ...record.binding,
        sessionId: record.grant.sessionId,
        terminalReceiptId,
      }),
      true
    );
  });

  await t.test("presented profile and device are checked before terminal receipt replay", async () => {
    const record = await reserveAndFinalize(harness, "canonical", 45);
    const terminal = eventInput(
      record.grant,
      uuid(445),
      eventBody({ event: "stop", sessionRevision: 1 })
    );
    const stopped = await harness.repositories.historyGrants.applyEvent(terminal);
    for (const mismatch of [
      { profileId: record.binding.profileId + "_other" },
      { deviceId: record.binding.deviceId + "_other" },
    ]) {
      await assert.rejects(
        () => harness.repositories.historyGrants.applyEvent({ ...terminal, ...mismatch }),
        (error) => error.code === "history_grant_invalid" && error.status === 401
      );
    }
    assert.deepEqual(
      await harness.repositories.historyGrants.applyEvent(terminal),
      stopped
    );
  });

  await t.test("all authority generations and scopes revoke without replay", async () => {
    const cases = [
      ["profile", (record) => harness.repositories.historyGrants.revokeProfile(
        record.binding.profileId,
        record.binding.profileRevision
      )],
      ["device", (record) => harness.repositories.historyGrants.revokeDevice(
        record.binding.profileId,
        record.binding.deviceId,
        record.binding.deviceGeneration
      )],
      ["history", (record) => harness.repositories.historyGrants.revokeHistory(
        record.binding.profileId,
        record.binding.historyGeneration
      )],
      ["playback", (record) => harness.repositories.historyGrants.revokePlayback(
        record.binding.profileId,
        record.binding.playbackGeneration
      )],
      ["session", (record) => harness.repositories.historyGrants.revokeSession(
        record.binding.profileId,
        record.grant.sessionId
      )],
      ["source", (record) => harness.repositories.historyGrants.revokeSource({
        profileId: record.binding.profileId,
        contextId: record.authority.contextId,
        playbackGeneration: record.binding.playbackGeneration,
        providerRevision: record.authority.providerRevision,
        contextRevision: record.authority.contextRevision,
      })],
      ["supersession", (record) => harness.repositories.historyGrants.supersede(
        record.binding.profileId,
        record.binding.deviceId,
        record.grant.sessionId,
        `replacement_history_${record.grant.sessionId.slice(-8)}`
      )],
    ];

    let number = 50;
    for (const [kind, revoke] of cases) {
      number += 1;
      const record = await reserveAndFinalize(harness, "canonical", number);
      const input = eventInput(record.grant, uuid(500 + number));
      await revoke(record);
      await assertStale(() => harness.repositories.historyGrants.applyEvent(input));
      const revocations = await harness.adapter.revocations(record.binding.profileId);
      if (harness.adapter.durable) {
        assert.equal(revocations.some((row) => row.kind === kind), true);
        for (const row of revocations) assert.match(String(row.scope_hash).trim(), /^[a-f0-9]{64}$/);
      }
    }
  });

  await t.test("durable event failure rolls back history, session, outbox, and receipt", async (subtest) => {
    if (!harness.adapter.durable) {
      subtest.skip("durable transaction injection only");
      return;
    }
    const record = await reserveAndFinalize(harness, "canonical", 70);
    const input = eventInput(record.grant, uuid(770));
    const removeFailure = await harness.adapter.installReceiptFailure();
    try {
      await assert.rejects(() => harness.repositories.historyGrants.applyEvent(input));
    } finally {
      await removeFailure();
    }
    const rolledBack = await harness.adapter.inspect(
      record.binding.profileId,
      record.grant.grantId,
      record.grant.sessionId,
      record.authority.contentKey
    );
    assert.equal(rolledBack.receipts, 0);
    assert.equal(rolledBack.dispatches, 0);
    assert.equal(rolledBack.history, null);
    assert.equal(Number(rolledBack.grant.session_revision), 1);
    assert.equal(rolledBack.grant.session_state, "playing");
    assert.equal(Number(rolledBack.playback.revision), 1);
    assert.equal(rolledBack.playback.state, "playing");

    const applied = await harness.repositories.historyGrants.applyEvent(input);
    assert.equal(applied.status, "applied");
  });
}

async function runAtomicClearContract(t, harness) {
  const target = await reserveAndFinalize(harness, "canonical", 80);
  const other = await reserveAndFinalize(harness, "canonical", 81);
  const directBinding = {
    profileId: target.binding.profileId,
    profileRevision: target.binding.profileRevision,
    deviceId: target.binding.deviceId,
    deviceGeneration: target.binding.deviceGeneration,
    sessionId: "session_history_clear_direct",
    contextId: "context_history_clear_direct",
    playbackGeneration: "g1:history_clear_direct",
    contextRevision: "1",
  };
  const directDispatchId = "dispatch_history_clear_direct";
  await harness.repositories.playbackSessions.openSession({
    ...directBinding,
    state: "playing",
  });
  await harness.repositories.playbackSessions.transitionAndEnqueue({
    ...directBinding,
    expectedRevision: 1,
    state: "playing",
    dispatch: {
      id: directDispatchId,
      event: "start",
      progress: 20,
      payload: { movie: { ids: { imdb: "tt0133093" } }, progress: 20 },
    },
  });
  const lease = await harness.repositories.playbackSessions.claimDispatch({
    workerId: "worker_history_clear",
    leaseMs: 1_000,
  });
  assert.ok(lease);
  assert.equal(lease.dispatch.id, directDispatchId);

  const targetInput = eventInput(target.grant, uuid(880));
  const otherInput = eventInput(other.grant, uuid(881));
  const targetApplied = await harness.repositories.historyGrants.applyEvent(targetInput);
  const otherApplied = await harness.repositories.historyGrants.applyEvent(otherInput);
  assert.ok(targetApplied.history);
  assert.ok(otherApplied.history);
  const targetStoredBeforeClear = await harness.repositories.history.get(
    target.binding.profileId,
    target.authority.contentKey
  );
  assert.ok(targetStoredBeforeClear);
  assert.deepEqual(
    await harness.adapter.dispatchStatuses(target.binding.profileId, target.grant.sessionId),
    ["queued"]
  );

  let upstreamCalls = 0;
  const clearPromise = harness.repositories.historyGrants.clearHistory(target.binding.profileId);
  const admissionOperation = () => harness.repositories.playbackSessions.withDispatchAdmission(
    {
      profileId: target.binding.profileId,
      dispatchId: directDispatchId,
      leaseToken: lease.leaseToken,
    },
    async () => {
      upstreamCalls += 1;
      return "sent";
    }
  );
  const admissionPromise = harness.adapter.backend === "postgres"
    ? null
    : admissionOperation().then(
        (value) => ({ value }),
        (error) => ({ error })
      );
  const cleared = await clearPromise;
  const admission = admissionPromise
    ? await admissionPromise
    : await admissionOperation().then(
        (value) => ({ value }),
        (error) => ({ error })
      );

  assert.equal(cleared.previousGeneration, target.binding.historyGeneration);
  assert.equal(cleared.historyGeneration, target.binding.historyGeneration + 1);
  assert.ok(cleared.revokedGrants >= 1);
  assert.ok(cleared.releasedSessions >= 1);
  assert.equal(upstreamCalls, 0);
  assert.equal(admission.value, undefined);
  assert.equal(admission.error && admission.error.code, "scrobble_dispatch_revoked");
  assert.equal(await harness.repositories.playbackSessions.retryDispatch({
    profileId: target.binding.profileId,
    dispatchId: directDispatchId,
    leaseToken: lease.leaseToken,
    nextAttemptAt: harness.now.value + 100,
  }), false);

  assert.deepEqual(
    await harness.adapter.dispatchStatuses(target.binding.profileId, target.grant.sessionId),
    ["revoked"]
  );
  assert.deepEqual(
    await harness.adapter.dispatchStatuses(target.binding.profileId, directBinding.sessionId),
    ["revoked"]
  );
  assert.equal(
    await harness.adapter.sessionState(target.binding.profileId, directBinding.sessionId),
    "released"
  );
  assert.equal(
    (await harness.repositories.historyGrants.getGrantBySession(
      target.binding.profileId,
      target.grant.sessionId
    )).status,
    "revoked"
  );
  await assertStale(() => harness.repositories.historyGrants.applyEvent(targetInput));
  assert.equal(
    await harness.repositories.history.get(
      target.binding.profileId,
      target.authority.contentKey
    ),
    null
  );

  assert.deepEqual(await harness.repositories.historyGrants.applyEvent(otherInput), otherApplied);
  assert.ok(await harness.repositories.history.get(
    other.binding.profileId,
    other.authority.contentKey
  ));
  assert.deepEqual(
    await harness.adapter.dispatchStatuses(other.binding.profileId, other.grant.sessionId),
    ["queued"]
  );
  assert.equal(
    (await harness.repositories.profiles.getById(other.binding.profileId)).historyGeneration,
    other.binding.historyGeneration
  );

  const refreshedProfile = await harness.repositories.profiles.getById(target.binding.profileId);
  assert.equal(refreshedProfile.historyGeneration, target.binding.historyGeneration + 1);
  const next = await reserveAndFinalizeForBinding(
    harness,
    {
      ...target.binding,
      historyGeneration: refreshedProfile.historyGeneration,
      playbackGeneration: "g1:history_after_clear",
    },
    "canonical",
    82
  );
  const nextApplied = await harness.repositories.historyGrants.applyEvent(
    eventInput(next.grant, uuid(882))
  );
  assert.ok(nextApplied.history);
  const nextStored = await harness.repositories.history.get(
    next.binding.profileId,
    next.authority.contentKey
  );
  assert.ok(nextStored.changeSequence > targetStoredBeforeClear.changeSequence);
}

if (!AGGREGATED_POSTGRES_LIVE_RUN) {
test("memory history-grant repository shared parity", async (t) => {
  await runParityContract(t, await setupMemory(t));
});

test("SQLite history-grant repository shared parity", async (t) => {
  await runParityContract(t, await setupSqlite(t));
});

test("memory atomic history clear fences all old work", async (t) => {
  await runAtomicClearContract(t, await setupMemory(t));
});

test("SQLite atomic history clear fences all old work", async (t) => {
  await runAtomicClearContract(t, await setupSqlite(t));
});
}

test(
  "PostgreSQL history-grant repository shared parity",
  { skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL", timeout: 120_000 },
  async (t) => {
    await runParityContract(t, await setupPostgres(t));
  }
);

test(
  "PostgreSQL atomic history clear fences all old work",
  { skip: POSTGRES_URL ? false : "set TEST_POSTGRES_URL or DATABASE_URL", timeout: 120_000 },
  async (t) => {
    await runAtomicClearContract(t, await setupPostgres(t));
  }
);
