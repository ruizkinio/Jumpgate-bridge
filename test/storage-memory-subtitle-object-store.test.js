"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");

const {
  OpaqueObjectKeyFactory,
  assertObjectStore,
} = require("../lib/storage/object-store");
const {
  MemorySubtitleObjectStore,
} = require("../lib/storage/memory-subtitle-object-store");
const storage = require("../lib/storage");

function keyFactory(seed = 0x41) {
  return new OpaqueObjectKeyFactory({
    currentKeyId: "memory-test",
    keyring: [{ id: "memory-test", secret: Buffer.alloc(32, seed) }],
    prefix: "subtitles/v1",
  });
}

function store(options = {}) {
  return new MemorySubtitleObjectStore({
    objectKeyFactory: keyFactory(),
    ...options,
  });
}

function digest(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

test("memory subtitle object store satisfies the object-store lifecycle", async () => {
  assert.equal(storage.MemorySubtitleObjectStore, MemorySubtitleObjectStore);
  assert.equal(storage.OpaqueObjectKeyFactory, OpaqueObjectKeyFactory);
  const objectStore = assertObjectStore(store());
  const key = objectStore.createKey(["artifact", "attempt", "1"]);
  const body = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nJumpgate\n");
  const expected = {
    checksumSha256: digest(body),
    contentLength: body.length,
    contentType: "text/vtt; charset=utf-8",
  };
  const readExpectation = {
    checksumSha256: expected.checksumSha256,
    contentLength: expected.contentLength,
  };

  assert.deepEqual(await objectStore.put(key, body, expected), { key, ...expected });
  assert.deepEqual(await objectStore.head(key, readExpectation), { key, ...expected });
  const fetched = await objectStore.get(key, readExpectation);
  assert.deepEqual(fetched, { body, key, ...expected });
  assert.notEqual(fetched.body, body);
  assert.deepEqual(await objectStore.delete(key), { deleted: true, key });
  assert.deepEqual(await objectStore.delete(key), { deleted: true, key });
  await assert.rejects(
    objectStore.get(key),
    (error) => error && error.code === "object_store_not_found" && error.operation === "get"
  );
});

test("memory subtitle PUT replays exact objects and rejects every overwrite", async () => {
  const objectStore = store();
  const key = objectStore.createKey(["artifact", "attempt", "1"]);
  const body = Buffer.from("1\n00:00:00,000 --> 00:00:01,000\nOne\n");
  const options = {
    checksumSha256: digest(body),
    contentLength: body.length,
    contentType: "application/x-subrip",
  };
  const first = await objectStore.put(key, body, options);
  assert.deepEqual(await objectStore.put(key, Buffer.from(body), options), first);

  for (const [candidate, changed] of [
    [Buffer.from("different bytes"), { contentType: options.contentType }],
    [body, { contentType: "text/plain" }],
  ]) {
    const attempt = {
      checksumSha256: digest(candidate),
      contentLength: candidate.length,
      ...changed,
    };
    await assert.rejects(
      objectStore.put(key, candidate, attempt),
      (error) => error && error.code === "object_store_integrity" && error.operation === "put"
    );
  }
  assert.deepEqual(
    await objectStore.get(key, {
      checksumSha256: options.checksumSha256,
      contentLength: options.contentLength,
    }),
    { body, key, ...options }
  );
});

test("memory subtitle objects cannot be mutated through input or output buffers", async () => {
  const objectStore = store();
  const key = objectStore.createKey(["artifact", "attempt", "1"]);
  const original = Buffer.from("immutable subtitle");
  const expectedChecksum = digest(original);
  await objectStore.put(key, original, { contentType: "text/plain" });
  original.fill(0x78);

  const first = await objectStore.get(key, { checksumSha256: expectedChecksum });
  assert.equal(first.body.toString(), "immutable subtitle");
  first.body.fill(0x79);
  const second = await objectStore.get(key, { checksumSha256: expectedChecksum });
  assert.equal(second.body.toString(), "immutable subtitle");
});

test("memory subtitle object limits and expected metadata fail closed", async () => {
  const objectStore = store({ maxObjectBytes: 8 });
  const key = objectStore.createKey(["artifact", "attempt", "1"]);
  await assert.rejects(
    objectStore.put(key, Buffer.alloc(9, 1)),
    (error) => error && error.code === "object_store_too_large" && error.operation === "put"
  );
  await assert.rejects(objectStore.put(key, Buffer.alloc(0)), /must not be empty/);
  await assert.rejects(objectStore.put(key, "not bytes"), /must be bytes/);

  const body = Buffer.from("12345678");
  await assert.rejects(
    objectStore.put(key, body, { checksumSha256: "0".repeat(64) }),
    (error) => error && error.code === "object_store_integrity"
  );
  await objectStore.put(key, body, { contentType: "text/plain" });
  await assert.rejects(
    objectStore.head(key, { maxBytes: 7 }),
    (error) => error && error.code === "object_store_too_large" && error.operation === "head"
  );
  await assert.rejects(
    objectStore.get(key, { contentLength: 7 }),
    (error) => error && error.code === "object_store_integrity" && error.operation === "get"
  );
});

test("memory subtitle operations honor aborts and reject unsupported options", async () => {
  const objectStore = store();
  const key = objectStore.createKey(["artifact", "attempt", "1"]);
  const controller = new AbortController();
  controller.abort();
  for (const [operation, invoke] of [
    ["put", () => objectStore.put(key, Buffer.from("x"), { signal: controller.signal })],
    ["head", () => objectStore.head(key, { signal: controller.signal })],
    ["get", () => objectStore.get(key, { signal: controller.signal })],
    ["delete", () => objectStore.delete(key, { signal: controller.signal })],
  ]) {
    await assert.rejects(
      invoke(),
      (error) => error && error.code === "object_store_aborted" && error.operation === operation
    );
  }
  await assert.rejects(objectStore.put(key, Buffer.from("x"), { bucket: "public" }), /unsupported/);
  await assert.rejects(objectStore.get(key, { contentType: "text/plain" }), /unsupported/);
});

test("memory subtitle keys remain authenticated and factory isolated", async () => {
  const first = store();
  const second = new MemorySubtitleObjectStore({ objectKeyFactory: keyFactory(0x42) });
  const key = first.createKey(["artifact", "attempt", "1"]);
  const segments = key.split("/");
  segments[segments.length - 2] = "A".repeat(43);
  const tampered = segments.join("/");

  await assert.rejects(first.put(tampered, Buffer.from("x")), /object key is invalid/);
  await assert.rejects(second.put(key, Buffer.from("x")), /object key is invalid/);
  assert.throws(() => new MemorySubtitleObjectStore(), /objectKeyFactory/);
  assert.throws(
    () => new MemorySubtitleObjectStore({ objectKeyFactory: keyFactory(), maxObjectBytes: 0 }),
    /byte limit/
  );
  assert.throws(
    () => new MemorySubtitleObjectStore({ objectKeyFactory: keyFactory(), public: true }),
    /unsupported/
  );
});
