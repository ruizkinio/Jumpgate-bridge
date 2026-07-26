"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");

const {
  ObjectStoreError,
  assertObjectStore,
} = require("../lib/storage/object-store");
const {
  MAX_PERMANENT_ERASURE_ROUNDS,
  SubtitleObjectStore,
} = require("../lib/storage/s3/subtitle-object-store");

const KEY_SECRET = Buffer.alloc(32, 0x5a);
const KEYRING = Object.freeze([{ id: "primary", secret: KEY_SECRET }]);
function resolveOpenSslBinary() {
  const candidates = [
    process.env.TEST_OPENSSL_BIN,
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe"
      : null,
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe"
      : null,
    "openssl",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = childProcess.spawnSync(candidate, ["version"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  throw new Error("OpenSSL is required for the production S3 transport test");
}

function createEphemeralTlsMaterial() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jumpgate-s3-transport-")
  );
  const certificatePath = path.join(directory, "ca.pem");
  const privateKeyPath = path.join(directory, "tls-key.pem");
  try {
    childProcess.execFileSync(
      resolveOpenSslBinary(),
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        privateKeyPath,
        "-out",
        certificatePath,
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ],
      {
        env: { ...process.env, MSYS_NO_PATHCONV: "1" },
        stdio: "ignore",
        timeout: 15000,
        windowsHide: true,
      }
    );
    return {
      certificate: fs.readFileSync(certificatePath),
      certificatePath,
      directory,
      privateKey: fs.readFileSync(privateKeyPath),
    };
  } catch (error) {
    fs.rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

class MockS3Client {
  constructor(handler = async () => ({})) {
    this.calls = [];
    this.handler = handler;
  }

  send(command, options = {}) {
    const call = { command, options };
    this.calls.push(call);
    return this.handler(command, options, call);
  }
}

function baseConfig(overrides = {}) {
  return {
    allowInjectedClient: true,
    bucket: "jumpgate-private-subtitles",
    client: new MockS3Client(),
    endpoint: "https://t3.storage.dev",
    keyHmacCurrentKeyId: "primary",
    keyHmacKeyring: KEYRING,
    maxObjectBytes: 1024,
    region: "auto",
    requestTimeoutMs: 250,
    ...overrides,
  };
}

function createStore(handler, overrides = {}) {
  const client = overrides.client || new MockS3Client(handler);
  const store = new SubtitleObjectStore(baseConfig({ ...overrides, client }));
  return { client, store };
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Base64(value) {
  return crypto.createHash("sha256").update(value).digest("base64");
}

function storedResponse(value, overrides = {}) {
  const bytes = Buffer.from(value);
  const checksum = sha256Hex(bytes);
  return {
    ChecksumSHA256: sha256Base64(bytes),
    ContentLength: bytes.length,
    ContentType: "application/octet-stream",
    Metadata: {
      "jumpgate-content-length": String(bytes.length),
      "jumpgate-schema": "1",
      "jumpgate-sha256": checksum,
    },
    ServerSideEncryption: "AES256",
    ...overrides,
  };
}

function errorWithCode(code, operation) {
  return (error) => {
    assert.ok(error instanceof ObjectStoreError);
    assert.equal(error.code, code);
    assert.equal(error.operation, operation);
    return true;
  };
}

function noSuchKey(message = "not found") {
  const error = new Error(message);
  error.name = "NoSuchKey";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function noSuchVersion(message = "version not found") {
  const error = new Error(message);
  error.name = "NoSuchVersion";
  error.$metadata = { httpStatusCode: 404 };
  return error;
}

function canonicalHeadNotFound(message = "version not found") {
  const error = new Error(message);
  error.name = "NotFound";
  error.$metadata = { httpStatusCode: 404 };
  error.$response = { headers: { "x-amz-error-code": "NoSuchVersion" } };
  return error;
}

function emptyVersionPage() {
  return { DeleteMarkers: [], IsTruncated: false, Versions: [] };
}

function runSilentNode(script, environment) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, ["-e", script], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.resume();
    child.stderr.resume();
    child.once("error", () => reject(new Error("object store transport child failed to start")));
    child.once("close", (code) => resolve(code));
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address());
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("configuration has explicit endpoint, client, and SSE trust boundaries", async () => {
  for (const endpoint of [
    "http://t3.storage.dev",
    "https://t3.storage.dev/path",
    "https://t3.storage.dev?bucket=other",
    "https://t3.storage.dev#fragment",
    "https://t3.storage.dev\n",
    "not-a-url",
  ]) {
    assert.throws(
      () => new SubtitleObjectStore(baseConfig({ endpoint })),
      /object store endpoint is invalid/
    );
  }

  const credentialEndpoint = "https://access-key:super-secret@t3.storage.dev";
  assert.throws(
    () => new SubtitleObjectStore(baseConfig({ endpoint: credentialEndpoint })),
    (error) => {
      assert.match(error.message, /object store endpoint is invalid/);
      assert.doesNotMatch(error.message, /access-key|super-secret/);
      return true;
    }
  );

  assert.throws(
    () => new SubtitleObjectStore(baseConfig({ endpoint: "https://s3.example.com" })),
    /object store endpoint is not trusted/
  );
  for (const endpoint of [
    "https://localhost",
    "https://localhost.",
    "https://127.1",
    "https://0x7f000001",
    "https://10.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://[::127.0.0.1]",
    "https://[::ffff:127.0.0.1]",
    "https://[64:ff9b::7f00:1]",
    "https://[2002:7f00:1::]",
    "https://[fe80::1]",
    "https://service.internal",
  ]) {
    assert.throws(
      () =>
        new SubtitleObjectStore(
          baseConfig({ endpoint, endpointAllowlist: [new URL(endpoint).origin] })
        ),
      /object store endpoint is not public/
    );
  }
  assert.doesNotThrow(
    () =>
      new SubtitleObjectStore(
        baseConfig({
          endpoint: "https://127.0.0.1:9443",
          endpointAllowlist: ["https://127.0.0.1:9443"],
          allowPrivateEndpoint: true,
        })
      )
  );
  assert.doesNotThrow(
    () =>
      new SubtitleObjectStore(
        baseConfig({ endpoint: "https://s3.example.com", allowUnlistedEndpoint: true })
      )
  );
  assert.doesNotThrow(
    () =>
      new SubtitleObjectStore(
        baseConfig({
          endpoint: "https://8.8.8.8",
          endpointAllowlist: ["https://8.8.8.8"],
        })
      )
  );

  const injectedWithoutOptIn = baseConfig();
  delete injectedWithoutOptIn.allowInjectedClient;
  assert.throws(
    () => new SubtitleObjectStore(injectedWithoutOptIn),
    /object store injected S3 client is not enabled/
  );

  for (const bucket of ["ABCD", "ab", "a..b", "127.0.0.1", "-private-bucket"]) {
    assert.throws(
      () => new SubtitleObjectStore(baseConfig({ bucket })),
      /object store bucket is invalid/
    );
  }
  for (const region of ["", "Auto", "auto/other", " auto"]) {
    assert.throws(
      () => new SubtitleObjectStore(baseConfig({ region })),
      /object store region is invalid/
    );
  }
  assert.throws(
    () =>
      new SubtitleObjectStore({
        ...baseConfig(),
        credentials: { accessKeyId: "leak", secretAccessKey: "leak" },
      }),
    /object store config contains unsupported fields/
  );
  assert.throws(
    () =>
      new SubtitleObjectStore(
        baseConfig({
          keyHmacKeyring: [{ id: "primary", secret: Buffer.alloc(16) }],
        })
      ),
    /object key HMAC secret is invalid/
  );
  assert.throws(
    () =>
      new SubtitleObjectStore(
        baseConfig({
          keyHmacCurrentKeyId: "missing",
          keyHmacKeyring: [{ id: "previous", secret: Buffer.alloc(32, 1) }],
        })
      ),
    /object key current HMAC key is missing/
  );
  assert.throws(
    () =>
      new SubtitleObjectStore(
        baseConfig({
          keyHmacKeyring: [
            { id: "primary", secret: Buffer.alloc(32, 1) },
            { id: "primary", secret: Buffer.alloc(32, 2) },
          ],
        })
      ),
    /object key HMAC keyring is invalid/
  );
  assert.throws(
    () =>
      new SubtitleObjectStore(
        baseConfig({
          keyHmacKeyring: [
            { id: "primary", secret: Buffer.alloc(32, 1), credential: "reject" },
          ],
        })
      ),
    /object key HMAC keyring entry contains unsupported fields/
  );
  assert.throws(
    () => new SubtitleObjectStore(baseConfig({ serverSideEncryption: null })),
    /object store SSE configuration is inconsistent/
  );
  assert.throws(
    () =>
      new SubtitleObjectStore(
        baseConfig({ serverSideEncryption: "AES256", sseResponsePolicy: "disabled" })
      ),
    /object store SSE configuration is inconsistent/
  );

  const { client, store } = createStore(async () => ({}));
  const key = store.createKey(["profile", "artifact"]);
  await assert.rejects(
    store.put(key, Buffer.from("x"), { bucket: "other-private-bucket" }),
    /object store put options contains unsupported fields/
  );
  assert.equal(client.calls.length, 0);
  assert.equal(JSON.stringify(store), "{}");
  assert.equal(store.presign, undefined);
  assert.equal(store.publicUrl, undefined);
  assert.equal(store.getUrl, undefined);
});

test("keys use authenticated opaque HMAC components and reject adversarial input", async () => {
  const { client, store } = createStore(async () => storedResponse(Buffer.from("x")));
  assert.equal(assertObjectStore(store), store);

  const key = store.createKey(["profile-secret", "source/identifier", Buffer.from([0, 1, 2])]);
  assert.equal(
    key,
    store.createKey(["profile-secret", "source/identifier", Buffer.from([0, 1, 2])])
  );
  assert.match(
    key,
    /^subtitles\/v1\/primary\/[A-Za-z0-9_-]{43}(?:\/[A-Za-z0-9_-]{43}){3}$/
  );
  assert.doesNotMatch(key, /profile-secret|source|identifier/);
  assert.notEqual(key, store.createKey(["profile-secret", "different", Buffer.from([0, 1, 2])]));

  const otherStore = createStore(async () => ({}), {
    keyHmacCurrentKeyId: "other",
    keyHmacKeyring: [{ id: "other", secret: Buffer.alloc(32, 0x41) }],
  }).store;
  const otherKey = otherStore.createKey(["profile-secret", "source/identifier"]);
  const tampered = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
  const base64urlAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalTagCharacter = key.at(-1);
  const nonCanonicalTag =
    key.slice(0, -1) +
    base64urlAlphabet[base64urlAlphabet.indexOf(finalTagCharacter) | 1];
  const randomOpaque =
    "subtitles/v1/primary/" + "a".repeat(43) + "/" + "b".repeat(43);

  for (const candidate of [
    "../escape",
    "subtitles/v1/../escape",
    "subtitles/v1/%2e%2e/escape",
    "subtitles/v1/control\u0000key",
    "subtitles\\v1\\escape",
    key.replace("/primary/", "/unknown/"),
    tampered,
    nonCanonicalTag,
    randomOpaque,
    otherKey,
  ]) {
    await assert.rejects(store.head(candidate), /object key is invalid/);
  }
  assert.throws(() => store.createKey([]), /object key components are invalid/);
  assert.throws(
    () => store.createKey(new Array(9).fill("component")),
    /object key components are invalid/
  );
  assert.throws(
    () => store.createKey([Buffer.alloc(1025)]),
    /object key component is invalid/
  );
  assert.equal(client.calls.length, 0);

  const previousStore = createStore(async () => storedResponse(Buffer.from("x")), {
    keyHmacCurrentKeyId: "previous",
    keyHmacKeyring: [{ id: "previous", secret: Buffer.alloc(32, 0x33) }],
  }).store;
  const previousKey = previousStore.createKey(["profile", "artifact"]);
  const rotated = createStore(async () => storedResponse(Buffer.from("x")), {
    keyHmacCurrentKeyId: "primary",
    keyHmacKeyring: [
      { id: "primary", secret: KEY_SECRET },
      { id: "previous", secret: Buffer.alloc(32, 0x33) },
    ],
  }).store;
  const currentKey = rotated.createKey(["profile", "artifact"]);
  assert.match(currentKey, /^subtitles\/v1\/primary\//);
  assert.deepEqual(await rotated.head(previousKey), {
    checksumSha256: sha256Hex("x"),
    contentLength: 1,
    contentType: "application/octet-stream",
    key: previousKey,
  });
  await assert.rejects(
    rotated.head(currentKey.replace("/primary/", "/previous/")),
    /object key is invalid/
  );
  await assert.rejects(store.head(previousKey), /object key is invalid/);
});

test("put is conditional, ACL-free, exact, and SSE-confirmed", async () => {
  const body = Buffer.from("WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n");
  const checksum = sha256Hex(body);
  const { client, store } = createStore((command) => ({
    ChecksumSHA256: command.input.ChecksumSHA256,
    ServerSideEncryption: command.input.ServerSideEncryption,
    VersionId: "provider-version-1",
  }));
  const key = store.createKey(["profile-1", "artifact-1", "text"]);
  const result = await store.put(key, body, {
    checksumSha256: checksum,
    contentLength: body.length,
    contentType: "text/vtt; charset=utf-8",
  });

  assert.equal(client.calls.length, 1);
  const call = client.calls[0];
  assert.ok(call.command instanceof PutObjectCommand);
  assert.ok(call.options.abortSignal instanceof AbortSignal);
  assert.equal(call.command.input.ACL, undefined);
  assert.equal(call.command.input.Bucket, "jumpgate-private-subtitles");
  assert.equal(call.command.input.CacheControl, "private, no-store");
  assert.equal(call.command.input.ChecksumSHA256, sha256Base64(body));
  assert.equal(call.command.input.ContentLength, body.length);
  assert.equal(call.command.input.ContentType, "text/vtt; charset=utf-8");
  assert.equal(call.command.input.IfNoneMatch, "*");
  assert.equal(call.command.input.Key, key);
  assert.equal(call.command.input.ServerSideEncryption, "AES256");
  const putAttemptNonce = call.command.input.Metadata["jumpgate-put-attempt"];
  assert.match(putAttemptNonce, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(call.command.input.Metadata, {
    "jumpgate-content-length": String(body.length),
    "jumpgate-put-attempt": putAttemptNonce,
    "jumpgate-schema": "1",
    "jumpgate-sha256": checksum,
  });
  assert.deepEqual(call.command.input.Body, body);
  assert.deepEqual(result, {
    checksumSha256: checksum,
    contentLength: body.length,
    contentType: "text/vtt; charset=utf-8",
    key,
    versionId: "provider-version-1",
  });
  assert.equal(Object.isFrozen(result), true);

  const secondKey = store.createKey(["profile-1", "artifact-1", "second-attempt"]);
  await store.put(secondKey, body, { contentType: "text/vtt; charset=utf-8" });
  assert.notEqual(
    client.calls[1].command.input.Metadata["jumpgate-put-attempt"],
    putAttemptNonce
  );

  const withoutSse = createStore(async () => ({}), {
    serverSideEncryption: null,
    sseResponsePolicy: "disabled",
  });
  const binaryKey = withoutSse.store.createKey(["profile-1", "artifact-2", "sub"]);
  await withoutSse.store.put(binaryKey, Buffer.from([0, 1, 2]));
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      withoutSse.client.calls[0].command.input,
      "ServerSideEncryption"
    ),
    false
  );
  assert.equal(withoutSse.client.calls[0].command.input.ACL, undefined);

  const compatible = createStore(
    (command) => ({ ChecksumSHA256: command.input.ChecksumSHA256 }),
    { sseResponsePolicy: "allow-missing" }
  );
  const compatibleKey = compatible.store.createKey(["profile-1", "artifact-3"]);
  await compatible.store.put(compatibleKey, Buffer.from("compatible"));
  assert.equal(compatible.client.calls.length, 1);

  const nullVersion = createStore((command) => ({
    ChecksumSHA256: command.input.ChecksumSHA256,
    ServerSideEncryption: command.input.ServerSideEncryption,
    VersionId: "null",
  }));
  const nullVersionKey = nullVersion.store.createKey(["profile-1", "null-version-put"]);
  assert.deepEqual(await nullVersion.store.put(nullVersionKey, Buffer.from("null")), {
    checksumSha256: sha256Hex("null"),
    contentLength: 4,
    contentType: "application/octet-stream",
    key: nullVersionKey,
  });
});

test("put rejects oversized bodies and caller or service checksum mismatches", async () => {
  const body = Buffer.from("hello");
  const { client, store } = createStore(async () => ({}), { maxObjectBytes: 5 });
  const key = store.createKey(["profile", "artifact"]);

  await assert.rejects(
    store.put(key, Buffer.from("123456")),
    errorWithCode("object_store_too_large", "put")
  );
  await assert.rejects(
    store.put(key, body, { contentLength: 4 }),
    errorWithCode("object_store_integrity", "put")
  );
  await assert.rejects(
    store.put(key, body, { checksumSha256: "0".repeat(64) }),
    errorWithCode("object_store_integrity", "put")
  );
  await assert.rejects(store.put(key, "hello"), /object store body must be bytes/);
  assert.equal(client.calls.length, 0);

  const mismatch = createStore(async () => ({ ChecksumSHA256: sha256Base64("other") }));
  const mismatchKey = mismatch.store.createKey(["profile", "artifact"]);
  await assert.rejects(
    mismatch.store.put(mismatchKey, body),
    errorWithCode("object_store_integrity", "put")
  );
});

test("conditional put reconciles content without exposing a reused object's version", async () => {
  const body = Buffer.from("immutable body");
  const contentType = "text/plain; charset=utf-8";
  const existing = createStore(async (command) => {
    if (command instanceof PutObjectCommand) {
      const error = new Error("existing key details must not leak");
      error.name = "PreconditionFailed";
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    return storedResponse(body, {
      ContentType: contentType,
      VersionId: "reconciled-version",
    });
  });
  const key = existing.store.createKey(["profile", "immutable", "text"]);
  const existingResult = await existing.store.put(key, body, { contentType });
  assert.deepEqual(existingResult, {
    checksumSha256: sha256Hex(body),
    contentLength: body.length,
    contentType,
    key,
  });
  assert.equal(existing.client.calls.length, 2);
  assert.ok(existing.client.calls[0].command instanceof PutObjectCommand);
  assert.ok(existing.client.calls[1].command instanceof HeadObjectCommand);
  assert.equal(existing.client.calls[0].command.input.IfNoneMatch, "*");
  await assert.rejects(
    existing.store.deleteVersion(key, existingResult.versionId),
    errorWithCode("object_store_integrity", "delete")
  );
  assert.equal(
    existing.client.calls.some((call) => call.command instanceof DeleteObjectCommand),
    false
  );

  let attemptedNonce;
  const differentNonce = createStore(async (command) => {
    if (command instanceof PutObjectCommand) {
      attemptedNonce = command.input.Metadata["jumpgate-put-attempt"];
      const error = new Error("pre-existing object must not confer deletion authority");
      error.name = "PreconditionFailed";
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    const replacementNonce = attemptedNonce === "A".repeat(43) ? "B".repeat(43) : "A".repeat(43);
    return storedResponse(body, {
      ContentType: contentType,
      Metadata: {
        "jumpgate-content-length": String(body.length),
        "jumpgate-put-attempt": replacementNonce,
        "jumpgate-schema": "1",
        "jumpgate-sha256": sha256Hex(body),
      },
      VersionId: "pre-existing-version",
    });
  });
  const differentNonceKey = differentNonce.store.createKey([
    "profile",
    "different-attempt",
    "text",
  ]);
  const differentNonceResult = await differentNonce.store.put(differentNonceKey, body, {
    contentType,
  });
  assert.equal(differentNonceResult.versionId, undefined);
  await assert.rejects(
    differentNonce.store.deleteVersion(differentNonceKey, differentNonceResult.versionId),
    errorWithCode("object_store_integrity", "delete")
  );
  assert.equal(
    differentNonce.client.calls.some((call) => call.command instanceof DeleteObjectCommand),
    false
  );

  let exactAttemptMetadata;
  const ambiguousSuccess = createStore(async (command) => {
    if (command instanceof PutObjectCommand) {
      exactAttemptMetadata = { ...command.input.Metadata };
      throw new Error("lost successful PUT response");
    }
    return storedResponse(body, {
      ContentType: contentType,
      Metadata: exactAttemptMetadata,
      VersionId: "exact-attempt-version",
    });
  });
  const ambiguousSuccessKey = ambiguousSuccess.store.createKey([
    "profile",
    "ambiguous-success",
    "text",
  ]);
  assert.deepEqual(
    await ambiguousSuccess.store.put(ambiguousSuccessKey, body, { contentType }),
    {
      checksumSha256: sha256Hex(body),
      contentLength: body.length,
      contentType,
      key: ambiguousSuccessKey,
      versionId: "exact-attempt-version",
    }
  );

  const concurrent = createStore(async (command) => {
    if (command instanceof PutObjectCommand) {
      const error = new Error("concurrent write details must not leak");
      error.name = "ConditionalRequestConflict";
      error.$metadata = { httpStatusCode: 409 };
      throw error;
    }
    return storedResponse(body, { ContentType: contentType });
  });
  const concurrentKey = concurrent.store.createKey(["profile", "concurrent", "text"]);
  assert.equal(
    (await concurrent.store.put(concurrentKey, body, { contentType })).key,
    concurrentKey
  );
  assert.equal(concurrent.client.calls.length, 2);

  const conflict = createStore(async (command) => {
    if (command instanceof PutObjectCommand) {
      const error = new Error("collision details must not leak");
      error.name = "PreconditionFailed";
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    return storedResponse(Buffer.alloc(body.length + 1, 0x78), { ContentType: contentType });
  });
  const conflictKey = conflict.store.createKey(["profile", "collision", "text"]);
  await assert.rejects(
    conflict.store.put(conflictKey, body, { contentType }),
    errorWithCode("object_store_integrity", "put")
  );

  let timeoutAbortObserved = false;
  const ambiguous = createStore(
    (command, options) => {
      if (command instanceof HeadObjectCommand) {
        return storedResponse(body, { ContentType: contentType });
      }
      return new Promise((resolve, reject) => {
        options.abortSignal.addEventListener(
          "abort",
          () => {
            timeoutAbortObserved = true;
            reject(new Error("ambiguous network result must not leak"));
          },
          { once: true }
        );
      });
    },
    { requestTimeoutMs: 10 }
  );
  const ambiguousKey = ambiguous.store.createKey(["profile", "ambiguous", "text"]);
  assert.deepEqual(
    await ambiguous.store.put(ambiguousKey, body, { contentType }),
    {
      checksumSha256: sha256Hex(body),
      contentLength: body.length,
      contentType,
      key: ambiguousKey,
    }
  );
  assert.equal(timeoutAbortObserved, true);
});

test("SSE response confirmation fails closed with explicit compatibility modes", async () => {
  const body = Buffer.from("encrypted");
  const missingSse = createStore(async (command) => {
    if (command instanceof PutObjectCommand) {
      return { ChecksumSHA256: command.input.ChecksumSHA256 };
    }
    return storedResponse(body, { ServerSideEncryption: undefined });
  });
  const key = missingSse.store.createKey(["profile", "sse", "missing"]);
  await assert.rejects(
    missingSse.store.put(key, body),
    errorWithCode("object_store_integrity", "put")
  );
  assert.equal(missingSse.client.calls.length, 1);
  await assert.rejects(
    missingSse.store.head(key),
    errorWithCode("object_store_integrity", "head")
  );

  let getDestroyed = false;
  const missingGet = createStore(async () =>
    storedResponse(body, {
      Body: {
        destroy() {
          getDestroyed = true;
        },
        async *[Symbol.asyncIterator]() {
          yield body;
        },
      },
      ServerSideEncryption: undefined,
    })
  );
  const getKey = missingGet.store.createKey(["profile", "sse", "get"]);
  await assert.rejects(
    missingGet.store.get(getKey),
    errorWithCode("object_store_integrity", "get")
  );
  assert.equal(getDestroyed, true);

  const compatible = createStore(
    async () => storedResponse(body, { Body: body, ServerSideEncryption: undefined }),
    { sseResponsePolicy: "allow-missing" }
  );
  const compatibleKey = compatible.store.createKey(["profile", "sse", "compatible"]);
  assert.deepEqual((await compatible.store.get(compatibleKey)).body, body);

  const wrongSse = createStore(async (command) => {
    if (command instanceof PutObjectCommand) {
      return {
        ChecksumSHA256: command.input.ChecksumSHA256,
        ServerSideEncryption: "aws:kms",
      };
    }
    return storedResponse(body, { ServerSideEncryption: "aws:kms" });
  });
  const wrongKey = wrongSse.store.createKey(["profile", "sse", "wrong"]);
  await assert.rejects(
    wrongSse.store.put(wrongKey, body),
    errorWithCode("object_store_integrity", "put")
  );
  await assert.rejects(
    wrongSse.store.head(wrongKey),
    errorWithCode("object_store_integrity", "head")
  );
});

test("head returns verified metadata and rejects size or checksum inconsistencies", async () => {
  const body = Buffer.from("hello");
  const hostileResponse = {};
  Object.defineProperty(hostileResponse, "ContentLength", {
    get() {
      throw new Error("AWS_SECRET_ACCESS_KEY=head-response-secret");
    },
  });
  const responses = [
    storedResponse(body, { ContentType: "text/plain; charset=utf-8" }),
    storedResponse(body, {
      Metadata: {
        "jumpgate-content-length": "4",
        "jumpgate-schema": "1",
        "jumpgate-sha256": sha256Hex(body),
      },
    }),
    storedResponse(body, { ChecksumSHA256: sha256Base64("other") }),
    storedResponse(body),
    storedResponse(body),
    hostileResponse,
  ];
  const { client, store } = createStore(async () => responses.shift());
  const key = store.createKey(["profile", "artifact", "idx"]);
  const record = await store.head(key, {
    checksumSha256: sha256Hex(body),
    contentLength: body.length,
    maxBytes: body.length,
  });
  assert.deepEqual(record, {
    checksumSha256: sha256Hex(body),
    contentLength: body.length,
    contentType: "text/plain; charset=utf-8",
    key,
  });
  assert.ok(client.calls[0].command instanceof HeadObjectCommand);
  assert.deepEqual(client.calls[0].command.input, {
    Bucket: "jumpgate-private-subtitles",
    ChecksumMode: "ENABLED",
    Key: key,
  });

  await assert.rejects(
    store.head(key),
    errorWithCode("object_store_integrity", "head")
  );
  await assert.rejects(
    store.head(key),
    errorWithCode("object_store_integrity", "head")
  );
  await assert.rejects(
    store.head(key, { checksumSha256: "0".repeat(64) }),
    errorWithCode("object_store_integrity", "head")
  );
  await assert.rejects(
    store.head(key, { maxBytes: body.length - 1 }),
    errorWithCode("object_store_too_large", "head")
  );
  await assert.rejects(store.head(key), (error) => {
    assert.ok(errorWithCode("object_store_integrity", "head")(error));
    assert.doesNotMatch(error.stack, /AWS_SECRET_ACCESS_KEY|head-response-secret/);
    return true;
  });
});

test("exact HEAD and GET bind and return provider version IDs", async () => {
  const body = Buffer.from("version-bound subtitle");
  const versionId = "provider-version-exact";
  const { client, store } = createStore(async (command) => {
    if (command instanceof HeadObjectCommand) {
      return storedResponse(body, { VersionId: versionId });
    }
    if (command instanceof GetObjectCommand) {
      return storedResponse(body, { Body: body, VersionId: versionId });
    }
    throw new Error("unexpected S3 command");
  });
  const key = store.createKey(["profile", "version-bound", "subtitle"]);

  const head = await store.head(key, { versionId });
  assert.deepEqual(head, {
    checksumSha256: sha256Hex(body),
    contentLength: body.length,
    contentType: "application/octet-stream",
    key,
    versionId,
  });
  assert.equal(Object.isFrozen(head), true);

  const get = await store.get(key, { versionId });
  assert.deepEqual(get, {
    body,
    checksumSha256: sha256Hex(body),
    contentLength: body.length,
    contentType: "application/octet-stream",
    key,
    versionId,
  });
  assert.equal(Object.isFrozen(get), true);
  assert.ok(client.calls[0].command instanceof HeadObjectCommand);
  assert.ok(client.calls[1].command instanceof GetObjectCommand);
  assert.equal(client.calls[0].command.input.VersionId, versionId);
  assert.equal(client.calls[1].command.input.VersionId, versionId);
  assert.deepEqual(get.body, body);
});

test("exact HEAD and GET map explicit NoSuchVersion to stable not-found", async () => {
  const versionId = "missing-provider-version";
  for (const operation of ["head", "get"]) {
    const { client, store } = createStore(async (command) => {
      assert.ok(
        operation === "head"
          ? command instanceof HeadObjectCommand
          : command instanceof GetObjectCommand
      );
      throw noSuchVersion("private version path must not leak");
    });
    const key = store.createKey(["profile", "missing-version", operation]);

    await assert.rejects(
      store[operation](key, { versionId }),
      errorWithCode("object_store_not_found", operation)
    );
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].command.input.Key, key);
    assert.equal(client.calls[0].command.input.VersionId, versionId);
    assert.ok(client.calls[0].options.abortSignal instanceof AbortSignal);
  }

  const ordinary = createStore(async () => {
    throw noSuchVersion();
  });
  const ordinaryKey = ordinary.store.createKey(["profile", "ordinary-no-such-version"]);
  await assert.rejects(
    ordinary.store.head(ordinaryKey),
    errorWithCode("object_store_unavailable", "head")
  );
});

test("exact HEAD maps the canonical SDK NotFound 404 to stable not-found", async () => {
  const versionId = "deleted-provider-version";
  const { client, store } = createStore(async (command) => {
    assert.ok(command instanceof HeadObjectCommand);
    assert.equal(command.input.VersionId, versionId);
    throw canonicalHeadNotFound("canonical HEAD response has no body");
  });
  const key = store.createKey(["profile", "canonical-head-not-found"]);

  await assert.rejects(
    store.head(key, { versionId }),
    errorWithCode("object_store_not_found", "head")
  );
  assert.equal(client.calls.length, 1);
});

test("canonical HEAD NotFound fallback rejects broader and malformed 404s", async () => {
  const versionId = "exact-provider-version";
  const notFoundWith = (name, status) => {
    const error = new Error("private service details must not leak");
    error.name = name;
    if (status !== undefined) {
      error.$metadata = { httpStatusCode: status };
    }
    return error;
  };
  const cases = [
    {
      commandType: HeadObjectCommand,
      error: () => canonicalHeadNotFound(),
      invoke: (store, key) => store.head(key),
      label: "unversioned-head",
      operation: "head",
    },
    {
      commandType: GetObjectCommand,
      error: () => canonicalHeadNotFound(),
      invoke: (store, key) => store.get(key, { versionId }),
      label: "exact-get",
      operation: "get",
    },
    {
      commandType: ListObjectVersionsCommand,
      error: () => canonicalHeadNotFound(),
      invoke: (store, key) => store.delete(key),
      label: "delete-list",
      operation: "delete",
    },
    {
      commandType: HeadObjectCommand,
      error: () => notFoundWith("Error", 404),
      invoke: (store, key) => store.head(key, { versionId }),
      label: "status-only-unknown-name",
      operation: "head",
    },
    {
      commandType: HeadObjectCommand,
      error: () => notFoundWith("AccessDenied", 404),
      invoke: (store, key) => store.head(key, { versionId }),
      label: "authorization-error",
      operation: "head",
    },
    {
      commandType: HeadObjectCommand,
      error: () => {
        const error = notFoundWith("NotFound", 404);
        error.code = "AccessDenied";
        return error;
      },
      invoke: (store, key) => store.head(key, { versionId }),
      label: "conflicting-authorization-code",
      operation: "head",
    },
    {
      commandType: HeadObjectCommand,
      error: () => notFoundWith("NotFound", undefined),
      invoke: (store, key) => store.head(key, { versionId }),
      label: "missing-status",
      operation: "head",
    },
    {
      commandType: HeadObjectCommand,
      error: () => notFoundWith("NotFound", "404"),
      invoke: (store, key) => store.head(key, { versionId }),
      label: "string-status",
      operation: "head",
    },
    {
      commandType: HeadObjectCommand,
      error: () => ({
        $metadata: { httpStatusCode: 404 },
        name: "NotFound",
      }),
      invoke: (store, key) => store.head(key, { versionId }),
      label: "non-error-shape",
      operation: "head",
    },
  ];

  for (const testCase of cases) {
    const { client, store } = createStore(async (command) => {
      assert.ok(command instanceof testCase.commandType);
      throw testCase.error();
    });
    const key = store.createKey(["profile", "canonical-404-boundary", testCase.label]);

    await assert.rejects(
      testCase.invoke(store, key),
      errorWithCode("object_store_unavailable", testCase.operation)
    );
    assert.equal(client.calls.length, 1);
  }
});

test("ordinary HEAD and GET omit the provider literal null VersionId", async () => {
  const body = Buffer.from("unversioned subtitle");
  for (const operation of ["head", "get"]) {
    const { client, store } = createStore(async () =>
      storedResponse(body, {
        ...(operation === "get" ? { Body: body } : {}),
        VersionId: "null",
      })
    );
    const key = store.createKey(["profile", "null-response-version", operation]);
    const result = await store[operation](key);

    assert.equal(result.versionId, undefined);
    assert.equal(Object.hasOwn(result, "versionId"), false);
    assert.equal(client.calls[0].command.input.VersionId, undefined);
  }
});

test("exact read version IDs are validated before S3 requests", async () => {
  const invalidVersionIds = [
    null,
    1,
    "",
    "null",
    " leading",
    "trailing ",
    "line\nbreak",
    "x".repeat(2049),
  ];

  for (const operation of ["head", "get"]) {
    const { client, store } = createStore(async () => {
      throw new Error("must not send an S3 request");
    });
    const key = store.createKey(["profile", "invalid-version", operation]);
    for (const versionId of invalidVersionIds) {
      await assert.rejects(
        store[operation](key, { versionId }),
        errorWithCode("object_store_integrity", operation)
      );
    }
    assert.equal(client.calls.length, 0);
  }
});

test("reads reject missing, malformed, or mismatched response version IDs", async () => {
  const body = Buffer.from("response version validation");
  const cases = [
    { expected: "requested-version", responseVersionId: undefined },
    { expected: "requested-version", responseVersionId: "null" },
    { expected: undefined, responseVersionId: " malformed-version" },
    { expected: "requested-version", responseVersionId: "replacement-version" },
  ];

  for (const operation of ["head", "get"]) {
    for (const testCase of cases) {
      let destroyed = false;
      let iterated = false;
      const responseBody = {
        destroy() {
          destroyed = true;
        },
        async *[Symbol.asyncIterator]() {
          iterated = true;
          yield body;
        },
      };
      const { client, store } = createStore(async () =>
        storedResponse(body, {
          Body: responseBody,
          VersionId: testCase.responseVersionId,
        })
      );
      const key = store.createKey([
        "profile",
        "invalid-response-version",
        operation,
        testCase.responseVersionId ?? "missing",
      ]);
      const options =
        testCase.expected === undefined ? undefined : { versionId: testCase.expected };

      await assert.rejects(
        store[operation](key, options),
        errorWithCode("object_store_integrity", operation)
      );
      assert.equal(client.calls[0].command.input.VersionId, testCase.expected);
      if (operation === "get") {
        assert.equal(destroyed, true);
        assert.equal(iterated, false);
      }
    }
  }
});

test("bounded get supports UTF-8 text and binary VobSub parts", async () => {
  const text = Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHello\n");
  const vobsub = Buffer.from([0, 0, 1, 0xba, 0xff, 0, 0x20]);
  const responses = [
    storedResponse(text, {
      Body: Readable.from([text.subarray(0, 7), text.subarray(7)]),
      ContentType: "application/x-subrip",
    }),
    storedResponse(vobsub, {
      Body: vobsub,
      ContentType: "application/x-vobsub",
    }),
  ];
  const { client, store } = createStore(async () => responses.shift());
  const textKey = store.createKey(["profile", "artifact", "text"]);
  const subKey = store.createKey(["profile", "artifact", "vobsub"]);

  const textResult = await store.get(textKey, {
    checksumSha256: sha256Hex(text),
    contentLength: text.length,
    maxBytes: text.length,
  });
  assert.deepEqual(textResult.body, text);
  assert.equal(textResult.contentType, "application/x-subrip");
  assert.equal(textResult.checksumSha256, sha256Hex(text));

  const subResult = await store.get(subKey, { maxBytes: vobsub.length });
  assert.deepEqual(subResult.body, vobsub);
  assert.equal(subResult.contentType, "application/x-vobsub");
  assert.equal(subResult.contentLength, vobsub.length);
  assert.ok(client.calls[0].command instanceof GetObjectCommand);
  assert.equal(client.calls[0].command.input.ChecksumMode, "ENABLED");
  assert.ok(client.calls[0].options.abortSignal instanceof AbortSignal);
  assert.equal(Object.isFrozen(subResult), true);
});

test("get rejects declared size, body checksum, and stream overflow mismatches", async () => {
  const expected = Buffer.from("1234");
  let preflightDestroyed = false;
  let destroyed = false;
  let invalidChunkDestroyed = false;
  let iteratorClosed = false;
  let webCanceled = false;
  const preflightBody = {
    destroy() {
      preflightDestroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from("12345");
    },
  };
  const overflowingBody = {
    destroy() {
      destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      try {
        yield Buffer.from("123");
        yield Buffer.from("45");
      } finally {
        iteratorClosed = true;
      }
    },
  };
  const invalidChunkBody = {
    destroy() {
      invalidChunkDestroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      yield "not bytes";
    },
  };
  const webBody = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("123"));
      controller.enqueue(Buffer.from("45"));
    },
    cancel() {
      webCanceled = true;
    },
  });
  const responses = [
    storedResponse(Buffer.from("12345"), { Body: preflightBody }),
    storedResponse(expected, { Body: Buffer.from("12345") }),
    storedResponse(expected, { Body: Buffer.from("4321") }),
    storedResponse(expected, { Body: overflowingBody }),
    storedResponse(expected, { Body: invalidChunkBody }),
    storedResponse(expected, { Body: webBody }),
  ];
  const { store } = createStore(async () => responses.shift(), { maxObjectBytes: 4 });
  const key = store.createKey(["profile", "artifact", "sub"]);

  await assert.rejects(
    store.get(key),
    errorWithCode("object_store_too_large", "get")
  );
  assert.equal(preflightDestroyed, true);
  await assert.rejects(
    store.get(key),
    errorWithCode("object_store_integrity", "get")
  );
  await assert.rejects(
    store.get(key),
    errorWithCode("object_store_integrity", "get")
  );
  await assert.rejects(
    store.get(key),
    errorWithCode("object_store_integrity", "get")
  );
  await assert.rejects(
    store.get(key),
    errorWithCode("object_store_integrity", "get")
  );
  await assert.rejects(
    store.get(key),
    errorWithCode("object_store_integrity", "get")
  );
  assert.equal(destroyed, true);
  assert.equal(iteratorClosed, true);
  assert.equal(invalidChunkDestroyed, true);
  assert.equal(webCanceled, true);
});

test("bounded get caps chunks and destroys bodies on iterator failure", async () => {
  const expected = Buffer.from("abc");
  let capDestroyed = false;
  let capIteratorClosed = false;
  const chunkFlood = {
    destroy() {
      capDestroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      try {
        yield Buffer.from("a");
        yield Buffer.from("b");
        yield Buffer.from("c");
      } finally {
        capIteratorClosed = true;
      }
    },
  };
  const capped = createStore(
    async () => storedResponse(expected, { Body: chunkFlood }),
    { maxResponseChunks: 2 }
  );
  const cappedKey = capped.store.createKey(["profile", "chunks", "cap"]);
  await assert.rejects(
    capped.store.get(cappedKey),
    errorWithCode("object_store_too_large", "get")
  );
  assert.equal(capDestroyed, true);
  assert.equal(capIteratorClosed, true);

  let failedDestroyed = false;
  let iteration = 0;
  const failedBody = {
    destroy() {
      failedDestroyed = true;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      iteration += 1;
      if (iteration === 1) return { done: false, value: Buffer.from("a") };
      throw new Error("AWS_SECRET_ACCESS_KEY=stream-failure-secret");
    },
    async return() {
      return { done: true };
    },
  };
  const failed = createStore(async () =>
    storedResponse(expected, { Body: failedBody })
  );
  const failedKey = failed.store.createKey(["profile", "chunks", "failure"]);
  await assert.rejects(failed.store.get(failedKey), (error) => {
    assert.ok(errorWithCode("object_store_unavailable", "get")(error));
    assert.doesNotMatch(error.stack, /stream-failure-secret|AWS_SECRET_ACCESS_KEY/);
    return true;
  });
  assert.equal(failedDestroyed, true);
});

test("external cancellation and operation timeouts abort the S3 client", async () => {
  const preAborted = createStore(async () => {
    throw new Error("must not run");
  });
  const preAbortedKey = preAborted.store.createKey(["profile", "artifact"]);
  const alreadyCanceled = new AbortController();
  alreadyCanceled.abort("credential-shaped cancellation reason");
  await assert.rejects(
    preAborted.store.head(preAbortedKey, { signal: alreadyCanceled.signal }),
    errorWithCode("object_store_aborted", "head")
  );
  assert.equal(preAborted.client.calls.length, 0);

  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let observedExternalAbort = false;
  const cancellable = createStore((_command, options) => {
    markStarted();
    return new Promise((resolve, reject) => {
      options.abortSignal.addEventListener(
        "abort",
        () => {
          observedExternalAbort = true;
          const error = new Error("AWS_SECRET_ACCESS_KEY=must-not-leak");
          error.name = "AbortError";
          reject(error);
        },
        { once: true }
      );
    });
  });
  const cancellableKey = cancellable.store.createKey(["profile", "cancel"]);
  const controller = new AbortController();
  const request = cancellable.store.head(cancellableKey, { signal: controller.signal });
  await started;
  controller.abort("tsec_do-not-leak");
  await assert.rejects(request, (error) => {
    assert.ok(errorWithCode("object_store_aborted", "head")(error));
    assert.equal(error.message, "object storage operation canceled");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, /AWS_SECRET_ACCESS_KEY|tsec_do-not-leak/);
    return true;
  });
  assert.equal(observedExternalAbort, true);

  let observedTimeoutAbort = false;
  const timed = createStore(
    (_command, options) =>
      new Promise((resolve, reject) => {
        options.abortSignal.addEventListener(
          "abort",
          () => {
            observedTimeoutAbort = true;
            reject(new Error("https://access:secret@private.invalid"));
          },
          { once: true }
        );
      }),
    { requestTimeoutMs: 15 }
  );
  const timedKey = timed.store.createKey(["profile", "timeout"]);
  await assert.rejects(
    timed.store.head(timedKey),
    errorWithCode("object_store_timeout", "head")
  );
  assert.equal(observedTimeoutAbort, true);
});

test("service and stream failures become stable redacted errors", async () => {
  const secretText =
    "AccessDenied endpoint=https://access:super-secret@t3.storage.dev bucket=private key=opaque";
  const unavailable = createStore(async () => {
    const error = new Error(secretText);
    error.name = "AccessDenied";
    error.credentials = { accessKeyId: "access", secretAccessKey: "super-secret" };
    throw error;
  });
  const key = unavailable.store.createKey(["profile", "artifact"]);
  await assert.rejects(unavailable.store.head(key), (error) => {
    assert.ok(errorWithCode("object_store_unavailable", "head")(error));
    assert.equal(error.message, "object storage operation failed");
    assert.equal(error.cause, undefined);
    assert.equal(error.retryable, true);
    assert.doesNotMatch(error.stack, /access:super-secret|private|opaque/);
    assert.doesNotMatch(JSON.stringify(error), /access|super-secret|private|opaque/);
    return true;
  });

  const mutated = createStore(async () => {
    const error = new ObjectStoreError("object_store_not_found", "head");
    error.code = "object_store_unavailable";
    error.message = "AWS_SECRET_ACCESS_KEY=mutated-object-store-error";
    error.credentials = { secretAccessKey: "mutated-object-store-error" };
    throw error;
  });
  const mutatedKey = mutated.store.createKey(["profile", "mutated-error"]);
  await assert.rejects(mutated.store.head(mutatedKey), (error) => {
    assert.ok(errorWithCode("object_store_unavailable", "head")(error));
    assert.equal(error.message, "object storage operation failed");
    assert.equal(error.credentials, undefined);
    assert.doesNotMatch(error.stack, /mutated-object-store-error|AWS_SECRET_ACCESS_KEY/);
    return true;
  });

  const hostileProxy = createStore(async () => {
    throw new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("AWS_SECRET_ACCESS_KEY=proxy-trap-must-not-leak");
        },
      }
    );
  });
  const hostileProxyKey = hostileProxy.store.createKey(["profile", "proxy-error"]);
  await assert.rejects(hostileProxy.store.head(hostileProxyKey), (error) => {
    assert.ok(errorWithCode("object_store_unavailable", "head")(error));
    assert.doesNotMatch(error.stack, /proxy-trap-must-not-leak|AWS_SECRET_ACCESS_KEY/);
    return true;
  });

  const sdkChecksum = createStore(async () => {
    throw new Error(
      'Checksum mismatch: expected "credential-secret" but received "other" in response header.'
    );
  });
  const sdkChecksumKey = sdkChecksum.store.createKey(["profile", "sdk-checksum"]);
  await assert.rejects(sdkChecksum.store.get(sdkChecksumKey), (error) => {
    assert.ok(errorWithCode("object_store_integrity", "get")(error));
    assert.doesNotMatch(error.stack, /credential-secret|Checksum mismatch/);
    return true;
  });

  const bytes = Buffer.from("body");
  const brokenStream = Readable.from(
    (async function* stream() {
      yield Buffer.from("bo");
      throw new Error("AWS_ACCESS_KEY_ID=must-not-leak");
    })()
  );
  const streaming = createStore(async () =>
    storedResponse(bytes, { Body: brokenStream })
  );
  const streamKey = streaming.store.createKey(["profile", "stream"]);
  await assert.rejects(streaming.store.get(streamKey), (error) => {
    assert.ok(errorWithCode("object_store_unavailable", "get")(error));
    assert.doesNotMatch(error.stack, /AWS_ACCESS_KEY_ID|must-not-leak/);
    return true;
  });
});

test("HEAD and GET require explicit NoSuchKey before returning not-found", async () => {
  for (const operation of ["head", "get"]) {
    const explicit = createStore(async () => {
      const error = new Error("secret object path");
      error.name = "NoSuchKey";
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    });
    const explicitKey = explicit.store.createKey(["profile", operation, "explicit"]);
    await assert.rejects(
      explicit.store[operation](explicitKey),
      errorWithCode("object_store_not_found", operation)
    );

    for (const name of ["Error", "NotFound", "NoSuchBucket", "PermanentRedirect"]) {
      const generic = createStore(async () => {
        const error = new Error("credential and routing details must not leak");
        error.name = name;
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      });
      const genericKey = generic.store.createKey(["profile", operation, name]);
      await assert.rejects(
        generic.store[operation](genericKey),
        errorWithCode("object_store_unavailable", operation)
      );
    }
  }
});

test("deleteVersion removes only the exact target among unrelated version history", async () => {
  const versionId = "version-to-delete";
  const deleted = [];
  let key;
  let present = true;
  const { client, store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      return {
        DeleteMarkers: [
          { Key: key, VersionId: "unrelated-delete-marker" },
        ],
        IsTruncated: false,
        Versions: [
          { ETag: '"historical"', Key: key, VersionId: "historical-version" },
          ...(present ? [{ ETag: '"exact"', Key: key, VersionId: versionId }] : []),
          ...(!present
            ? [{ ETag: '"replacement"', Key: key, VersionId: "racing-replacement" }]
            : []),
        ],
      };
    }
    if (command instanceof DeleteObjectCommand) {
      assert.equal(command.input.Key, key);
      assert.equal(command.input.VersionId, versionId);
      deleted.push(command.input.VersionId);
      present = false;
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      assert.equal(command.input.Key, key);
      assert.equal(command.input.VersionId, versionId);
      throw noSuchVersion();
    }
    throw new Error("unexpected S3 command");
  });
  key = store.createKey(["profile", "exact-version-delete"]);

  const result = await store.deleteVersion(key, versionId);
  assert.deepEqual(result, { deleted: true, key, observed: true, versionId });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(deleted, [versionId]);
  const heads = client.calls.filter((call) => call.command instanceof HeadObjectCommand);
  assert.equal(heads.length, 2);
  assert.ok(heads.every((call) => call.command.input.VersionId === versionId));
});

test("deleteVersion is idempotent but unattested when the exact target was not observed", async () => {
  for (const mismatchKind of ["absent", "delete-marker"]) {
    let key;
    const { client, store } = createStore(async (command) => {
      if (command instanceof ListObjectVersionsCommand) {
        return {
          DeleteMarkers:
            mismatchKind === "delete-marker"
              ? [{ Key: key, VersionId: "requested-version" }]
              : [],
          IsTruncated: false,
          Versions: [
            { ETag: '"replacement"', Key: key, VersionId: "replacement-version" },
          ],
        };
      }
      if (command instanceof HeadObjectCommand) {
        assert.equal(command.input.Key, key);
        assert.equal(command.input.VersionId, "requested-version");
        throw noSuchVersion();
      }
      throw new Error("delete must not be attempted");
    });
    key = store.createKey(["profile", "mismatched-version-delete", mismatchKind]);

    const result = await store.deleteVersion(key, "requested-version");
    assert.deepEqual(result, {
      deleted: true,
      key,
      observed: false,
      versionId: "requested-version",
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(
      client.calls.filter((call) => call.command instanceof ListObjectVersionsCommand).length,
      2
    );
    assert.equal(
      client.calls.filter((call) => call.command instanceof DeleteObjectCommand).length,
      0
    );
    assert.equal(
      client.calls.filter((call) => call.command instanceof HeadObjectCommand).length,
      2
    );
  }

  const invalid = createStore(async () => {
    throw new Error("must not send an S3 request");
  });
  const invalidKey = invalid.store.createKey(["profile", "null-version-delete"]);
  await assert.rejects(
    invalid.store.deleteVersion(invalidKey, "null"),
    errorWithCode("object_store_integrity", "delete")
  );
  assert.equal(invalid.client.calls.length, 0);
});

test("deleteVersion reconciles a lost delete response without touching a replacement", async () => {
  const targetVersionId = "target-version";
  const replacementVersionId = "racing-replacement";
  const deleted = [];
  let key;
  let targetPresent = true;
  const { store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      return {
        DeleteMarkers: [],
        IsTruncated: false,
        Versions: targetPresent
          ? [{ ETag: '"target"', Key: key, VersionId: targetVersionId }]
          : [{ ETag: '"replacement"', Key: key, VersionId: replacementVersionId }],
      };
    }
    if (command instanceof DeleteObjectCommand) {
      deleted.push(command.input.VersionId);
      targetPresent = false;
      throw new Error("provider applied delete but its response was lost");
    }
    if (command instanceof HeadObjectCommand) {
      assert.equal(command.input.VersionId, targetVersionId);
      throw noSuchVersion();
    }
    throw new Error("unexpected S3 command");
  });
  key = store.createKey(["profile", "racing-version-delete"]);

  assert.deepEqual(await store.deleteVersion(key, targetVersionId), {
    deleted: true,
    key,
    observed: true,
    versionId: targetVersionId,
  });
  assert.deepEqual(deleted, [targetVersionId]);
  assert.equal(deleted.includes(replacementVersionId), false);
});

test("deleteVersion retries only a still-listed requested target", async () => {
  const targetVersionId = "retry-target-version";
  const deleted = [];
  let key;
  let targetPresent = true;
  const { store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      return {
        DeleteMarkers: [{ Key: key, VersionId: "unrelated-marker" }],
        IsTruncated: false,
        Versions: [
          ...(targetPresent
            ? [{ ETag: '"target"', Key: key, VersionId: targetVersionId }]
            : []),
          { ETag: '"replacement"', Key: key, VersionId: "replacement-version" },
        ],
      };
    }
    if (command instanceof DeleteObjectCommand) {
      deleted.push(command.input.VersionId);
      if (deleted.length === 1) throw new Error("delete was not applied");
      targetPresent = false;
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      assert.equal(command.input.VersionId, targetVersionId);
      throw noSuchVersion();
    }
    throw new Error("unexpected S3 command");
  });
  key = store.createKey(["profile", "retry-exact-version-delete"]);

  assert.equal((await store.deleteVersion(key, targetVersionId)).observed, true);
  assert.deepEqual(deleted, [targetVersionId, targetVersionId]);
});

test("deleteVersion requires exact-version HEAD not-found for list-based absence", async () => {
  const targetVersionId = "list-hidden-target";
  const newerVersionId = "unrelated-newer-version";
  let key;
  const { client, store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      return {
        DeleteMarkers: [],
        IsTruncated: false,
        Versions: [{ ETag: '"newer"', Key: key, VersionId: newerVersionId }],
      };
    }
    if (command instanceof HeadObjectCommand) {
      assert.equal(command.input.Key, key);
      assert.equal(command.input.VersionId, targetVersionId);
      return {};
    }
    throw new Error("delete must not be attempted");
  });
  key = store.createKey(["profile", "list-hidden-exact-version"]);

  await assert.rejects(
    store.deleteVersion(key, targetVersionId),
    errorWithCode("object_store_integrity", "delete")
  );
  assert.equal(
    client.calls.filter((call) => call.command instanceof HeadObjectCommand).length,
    1
  );
  assert.equal(
    client.calls.filter((call) => call.command instanceof DeleteObjectCommand).length,
    0
  );
});

test("deleteVersion returns the first normalized failure when a denied target persists", async () => {
  const targetVersionId = "denied-target-version";
  const foreignVersionId = "foreign-version-never-delete";
  const deleted = [];
  let key;
  const { client, store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      return {
        DeleteMarkers: [{ Key: key, VersionId: "foreign-delete-marker" }],
        IsTruncated: false,
        Versions: [
          { ETag: '"target"', Key: key, VersionId: targetVersionId },
          { ETag: '"foreign"', Key: key, VersionId: foreignVersionId },
        ],
      };
    }
    if (command instanceof DeleteObjectCommand) {
      deleted.push(command.input.VersionId);
      const error = new Error("AccessDenied AWS_SECRET_ACCESS_KEY=must-not-leak");
      error.name = "AccessDenied";
      error.$metadata = { httpStatusCode: 403 };
      throw error;
    }
    throw new Error("unexpected S3 command");
  });
  key = store.createKey(["profile", "persistent-denied-version"]);

  await assert.rejects(store.deleteVersion(key, targetVersionId), (error) => {
    assert.ok(errorWithCode("object_store_unavailable", "delete")(error));
    assert.doesNotMatch(error.stack, /AWS_SECRET_ACCESS_KEY|must-not-leak/);
    return true;
  });
  assert.equal(deleted.length, MAX_PERMANENT_ERASURE_ROUNDS);
  assert.ok(deleted.every((versionId) => versionId === targetVersionId));
  assert.equal(deleted.includes(foreignVersionId), false);
  assert.equal(
    client.calls.some((call) => call.command instanceof HeadObjectCommand),
    false
  );
});

test("deleteVersion preserves the first timeout when a lost response leaves the target", async () => {
  const targetVersionId = "timed-out-target-version";
  const foreignVersionId = "foreign-version-after-timeout";
  const deleted = [];
  let key;
  let timedOutRequestAborted = false;
  const { store } = createStore(
    async (command, options) => {
      if (command instanceof ListObjectVersionsCommand) {
        return {
          DeleteMarkers: [],
          IsTruncated: false,
          Versions: [
            { ETag: '"target"', Key: key, VersionId: targetVersionId },
            { ETag: '"foreign"', Key: key, VersionId: foreignVersionId },
          ],
        };
      }
      if (command instanceof DeleteObjectCommand) {
        deleted.push(command.input.VersionId);
        if (deleted.length === 1) {
          return new Promise((_resolve, reject) => {
            options.abortSignal.addEventListener(
              "abort",
              () => {
                timedOutRequestAborted = true;
                reject(new Error("lost response with credential-shaped details"));
              },
              { once: true }
            );
          });
        }
        const error = new Error("later access denial");
        error.name = "AccessDenied";
        error.$metadata = { httpStatusCode: 403 };
        throw error;
      }
      throw new Error("unexpected S3 command");
    },
    { requestTimeoutMs: 10 }
  );
  key = store.createKey(["profile", "persistent-timeout-version"]);

  await assert.rejects(
    store.deleteVersion(key, targetVersionId),
    errorWithCode("object_store_timeout", "delete")
  );
  assert.equal(timedOutRequestAborted, true);
  assert.equal(deleted.length, MAX_PERMANENT_ERASURE_ROUNDS);
  assert.ok(deleted.every((versionId) => versionId === targetVersionId));
  assert.equal(deleted.includes(foreignVersionId), false);
});

test("delete permanently removes a regular null version and proves stable absence", async () => {
  let present = true;
  let key;
  const { client, store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      return present
        ? {
            DeleteMarkers: [],
            IsTruncated: false,
            Versions: [{ ETag: '"etag-null"', Key: key, VersionId: "null" }],
          }
        : emptyVersionPage();
    }
    if (command instanceof DeleteObjectCommand) {
      assert.equal(command.input.Key, key);
      assert.equal(command.input.VersionId, "null");
      present = false;
      return {};
    }
    if (command instanceof HeadObjectCommand) throw noSuchKey();
    throw new Error("unexpected S3 command");
  });
  key = store.createKey(["profile", "regular-hard-delete"]);

  assert.deepEqual(await store.delete(key), { deleted: true, key });
  assert.deepEqual(
    client.calls.map((call) => call.command.constructor.name),
    [
      "ListObjectVersionsCommand",
      "DeleteObjectCommand",
      "ListObjectVersionsCommand",
      "HeadObjectCommand",
      "ListObjectVersionsCommand",
      "HeadObjectCommand",
    ]
  );
});

test("delete paginates both markers and hard-deletes only exact-key versions and markers", async () => {
  let key;
  const pages = [];
  const { client, store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) return pages.shift();
    if (command instanceof DeleteObjectCommand) return {};
    if (command instanceof HeadObjectCommand) throw noSuchKey();
    throw new Error("unexpected S3 command");
  });
  key = store.createKey(["profile", "paginated-hard-delete"]);
  pages.push(
    {
      DeleteMarkers: [],
      IsTruncated: true,
      NextKeyMarker: key,
      NextVersionIdMarker: "version-2",
      Versions: [
        { ETag: '"etag-2"', Key: key, VersionId: "version-2" },
        { ETag: '"sibling"', Key: key + ".bak", VersionId: "sibling-version" },
      ],
    },
    {
      DeleteMarkers: [{ Key: key, VersionId: "delete-marker-1" }],
      IsTruncated: false,
      Versions: [{ ETag: '"etag-1"', Key: key, VersionId: "version-1" }],
    },
    emptyVersionPage(),
    emptyVersionPage()
  );

  await store.delete(key);
  const lists = client.calls.filter((call) => call.command instanceof ListObjectVersionsCommand);
  assert.equal(lists.length, 4);
  assert.equal(lists[0].command.input.Prefix, key);
  assert.equal(lists[0].command.input.KeyMarker, undefined);
  assert.equal(lists[1].command.input.KeyMarker, key);
  assert.equal(lists[1].command.input.VersionIdMarker, "version-2");
  assert.deepEqual(
    client.calls
      .filter((call) => call.command instanceof DeleteObjectCommand)
      .map((call) => [call.command.input.Key, call.command.input.VersionId]),
    [
      [key, "version-2"],
      [key, "version-1"],
      [key, "delete-marker-1"],
    ]
  );
});

test("namespace purge paginates exact versions and proves stable version absence", async () => {
  const pages = [];
  const deleted = [];
  const { client, store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) return pages.shift();
    if (command instanceof DeleteObjectCommand) {
      deleted.push([command.input.Key, command.input.VersionId]);
      return {};
    }
    throw new Error("unexpected S3 command");
  });
  const namespace = "erasure-attestation-canary-v2";
  const first = store.createKey([namespace, "first"]);
  const second = store.createKey([namespace, "second"]);
  const unrelated = store.createKey(["profile", "unrelated"]);
  pages.push(
    {
      DeleteMarkers: [],
      IsTruncated: true,
      NextKeyMarker: first,
      NextVersionIdMarker: "first-version",
      Versions: [{ ETag: '"first"', Key: first, VersionId: "first-version" }],
    },
    {
      DeleteMarkers: [{ Key: second, VersionId: "second-marker" }],
      IsTruncated: false,
      Versions: [{ ETag: '"second"', Key: second, VersionId: "second-version" }],
    },
    emptyVersionPage(),
    emptyVersionPage()
  );

  assert.deepEqual(await store.purgeNamespace([namespace]), { deleted: true });
  assert.deepEqual(deleted, [
    [first, "first-version"],
    [second, "second-version"],
    [second, "second-marker"],
  ]);
  assert.equal(deleted.some(([key]) => key === unrelated), false);
  const lists = client.calls.filter((call) => call.command instanceof ListObjectVersionsCommand);
  assert.equal(lists.length, 4);
  assert.ok(lists.every((call) => first.startsWith(call.command.input.Prefix)));
  assert.equal(lists[1].command.input.KeyMarker, first);
  assert.equal(lists[1].command.input.VersionIdMarker, "first-version");
});

test("delete converges when a racing write appears between purge scans", async () => {
  let key;
  const scans = ["version-before", "version-raced", null, null];
  const deleted = [];
  const { store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      const versionId = scans.shift();
      return versionId === null
        ? emptyVersionPage()
        : {
            DeleteMarkers: [],
            IsTruncated: false,
            Versions: [{ ETag: '"etag"', Key: key, VersionId: versionId }],
          };
    }
    if (command instanceof DeleteObjectCommand) {
      deleted.push(command.input.VersionId);
      return {};
    }
    if (command instanceof HeadObjectCommand) throw noSuchKey();
    throw new Error("unexpected S3 command");
  });
  key = store.createKey(["profile", "racing-hard-delete"]);

  await store.delete(key);
  assert.deepEqual(deleted, ["version-before", "version-raced"]);
});

test("delete fails closed when versions keep reappearing or enumeration is incomplete", async () => {
  let key;
  let scan = 0;
  const racing = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      scan += 1;
      return {
        DeleteMarkers: [],
        IsTruncated: false,
        Versions: [{ ETag: '"etag"', Key: key, VersionId: "raced-" + scan }],
      };
    }
    if (command instanceof DeleteObjectCommand) return {};
    throw new Error("unexpected S3 command");
  });
  key = racing.store.createKey(["profile", "never-stable"]);
  await assert.rejects(
    racing.store.delete(key),
    errorWithCode("object_store_integrity", "delete")
  );
  assert.equal(scan, MAX_PERMANENT_ERASURE_ROUNDS);

  const missingMarker = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      return { DeleteMarkers: [], IsTruncated: true, Versions: [] };
    }
    throw new Error("unexpected S3 command");
  });
  const missingMarkerKey = missingMarker.store.createKey(["profile", "missing-marker"]);
  await assert.rejects(
    missingMarker.store.delete(missingMarkerKey),
    errorWithCode("object_store_integrity", "delete")
  );

  const hiddenLiveObject = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) return emptyVersionPage();
    if (command instanceof HeadObjectCommand) return storedResponse(Buffer.from("residual"));
    throw new Error("unexpected S3 command");
  });
  const hiddenKey = hiddenLiveObject.store.createKey(["profile", "hidden-residual"]);
  await assert.rejects(
    hiddenLiveObject.store.delete(hiddenKey),
    errorWithCode("object_store_integrity", "delete")
  );
});

test("partial exact-version failure is retryable and never skips the residual", async () => {
  let key;
  const versions = new Set(["version-1", "version-2"]);
  let failVersion2 = true;
  const { client, store } = createStore(async (command) => {
    if (command instanceof ListObjectVersionsCommand) {
      return versions.size === 0
        ? emptyVersionPage()
        : {
            DeleteMarkers: [],
            IsTruncated: false,
            Versions: [...versions].map((versionId) => ({
              ETag: '"' + versionId + '"',
              Key: key,
              VersionId: versionId,
            })),
          };
    }
    if (command instanceof DeleteObjectCommand) {
      if (command.input.VersionId === "version-2" && failVersion2) {
        throw new Error("provider failure with AWS_SECRET_ACCESS_KEY=must-not-leak");
      }
      versions.delete(command.input.VersionId);
      return {};
    }
    if (command instanceof HeadObjectCommand) throw noSuchKey();
    throw new Error("unexpected S3 command");
  });
  key = store.createKey(["profile", "partial-retry"]);

  await assert.rejects(store.delete(key), (error) => {
    assert.ok(errorWithCode("object_store_unavailable", "delete")(error));
    assert.doesNotMatch(error.stack, /AWS_SECRET_ACCESS_KEY|must-not-leak/);
    return true;
  });
  assert.deepEqual([...versions], ["version-2"]);
  failVersion2 = false;
  assert.deepEqual(await store.delete(key), { deleted: true, key });
  assert.equal(versions.size, 0);
  assert.equal(
    client.calls.filter(
      (call) =>
        call.command instanceof DeleteObjectCommand &&
        call.command.input.VersionId === "version-2"
    ).length,
    2
  );
});

test("version-list failures are normalized without bucket, key, or credential leakage", async () => {
  const failed = createStore(async (command) => {
    assert.ok(command instanceof ListObjectVersionsCommand);
    throw new Error(
      "bucket=jumpgate-private-subtitles key=private-key AWS_SECRET_ACCESS_KEY=secret"
    );
  });
  const key = failed.store.createKey(["profile", "redacted-version-list"]);
  await assert.rejects(failed.store.delete(key), (error) => {
    assert.ok(errorWithCode("object_store_unavailable", "delete")(error));
    assert.doesNotMatch(
      error.stack,
      /jumpgate-private-subtitles|private-key|AWS_SECRET_ACCESS_KEY|secret/
    );
    return true;
  });
});

test("production S3Client uses TLS, SigV4, retries, checksums, and strict headers", async () => {
  const expectedBody = Buffer.from("transport subtitle");
  const expectedChecksumHex = sha256Hex(expectedBody);
  const expectedChecksumBase64 = sha256Base64(expectedBody);
  const tlsMaterial = createEphemeralTlsMaterial();
  const requests = [];
  let headAttempt = 0;
  let getAttempt = 0;
  const server = https.createServer(
    { cert: tlsMaterial.certificate, key: tlsMaterial.privateKey },
    (request, response) => {
      void (async () => {
        const chunks = [];
        let total = 0;
        for await (const chunk of request) {
          total += chunk.length;
          if (total > 1024 * 1024) {
            request.destroy();
            return;
          }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks, total);
        requests.push({
          body,
          encrypted: request.socket.encrypted === true,
          headers: { ...request.headers },
          method: request.method,
          url: request.url,
        });
        const setObjectHeaders = (payload) => {
          response.setHeader("Content-Length", String(payload.length));
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.setHeader("x-amz-checksum-sha256", expectedChecksumBase64);
          response.setHeader(
            "x-amz-meta-jumpgate-content-length",
            String(expectedBody.length)
          );
          response.setHeader("x-amz-meta-jumpgate-schema", "1");
          response.setHeader("x-amz-meta-jumpgate-sha256", expectedChecksumHex);
          response.setHeader("x-amz-server-side-encryption", "AES256");
        };
        if (request.method === "PUT") {
          response.statusCode = 200;
          response.setHeader("x-amz-checksum-sha256", expectedChecksumBase64);
          response.setHeader("x-amz-server-side-encryption", "AES256");
          response.end();
          return;
        }
        if (request.method === "HEAD") {
          headAttempt += 1;
          if (headAttempt === 1) {
            response.statusCode = 503;
            response.setHeader("x-amz-error-code", "SlowDown");
            response.end();
            return;
          }
          response.statusCode = 200;
          setObjectHeaders(expectedBody);
          response.end();
          return;
        }
        if (request.method === "GET") {
          getAttempt += 1;
          if (getAttempt === 3) {
            const errorBody = Buffer.from(
              "<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>"
            );
            response.statusCode = 404;
            response.setHeader("Content-Length", String(errorBody.length));
            response.setHeader("Content-Type", "application/xml");
            response.end(errorBody);
            return;
          }
          const payload =
            getAttempt === 1
              ? expectedBody
              : Buffer.alloc(expectedBody.length, 0x78);
          response.statusCode = 200;
          setObjectHeaders(payload);
          response.end(payload);
          return;
        }
        if (request.method === "DELETE") {
          response.statusCode = 404;
          response.end();
          return;
        }
        response.statusCode = 500;
        response.end();
      })().catch(() => response.destroy());
    }
  );
  server.on("tlsClientError", () => {});
  const temporaryDirectory = tlsMaterial.directory;
  const certificatePath = tlsMaterial.certificatePath;
  const address = await listen(server);
  const endpoint = "https://127.0.0.1:" + address.port;
  const modulePath = path.resolve(
    __dirname,
    "../lib/storage/s3/subtitle-object-store.js"
  );
  const childEnvironment = {
    AWS_ACCESS_KEY_ID: "TRANSPORTACCESSKEY",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SECRET_ACCESS_KEY: "transport-secret-never-log",
    NODE_TLS_REJECT_UNAUTHORIZED: "1",
    TEST_OBJECT_STORE_ENDPOINT: endpoint,
    TEST_OBJECT_STORE_MODULE: modulePath,
  };
  const childConfig = [
    "const { SubtitleObjectStore } = require(process.env.TEST_OBJECT_STORE_MODULE);",
    "const store = new SubtitleObjectStore({",
    "  allowPrivateEndpoint: true,",
    "  bucket: 'jumpgate-private-subtitles',",
    "  endpoint: process.env.TEST_OBJECT_STORE_ENDPOINT,",
    "  endpointAllowlist: [process.env.TEST_OBJECT_STORE_ENDPOINT],",
    "  forcePathStyle: true,",
    "  keyHmacCurrentKeyId: 'transport',",
    "  keyHmacKeyring: [{ id: 'transport', secret: Buffer.alloc(32, 0x21) }],",
    "  maxObjectBytes: 1024,",
    "  region: 'test-1',",
    "  requestTimeoutMs: 3000,",
    "});",
  ];
  const untrustedTlsScript = childConfig
    .concat([
      "(async () => {",
      "  try {",
      "    const key = store.createKey(['transport', 'untrusted']);",
      "    await require('node:assert/strict').rejects(",
      "      store.head(key),",
      "      (error) => error && error.code === 'object_store_unavailable'",
      "    );",
      "    process.exit(0);",
      "  } catch (_error) { process.exit(10); }",
      "})();",
    ])
    .join("\n");
  const transportScript = [
    "const assert = require('node:assert/strict');",
    ...childConfig,
    "const body = Buffer.from('transport subtitle');",
    "(async () => {",
    "  let stage = 20;",
    "  try {",
    "    const key = store.createKey(['transport', 'artifact']);",
    "    const missingKey = store.createKey(['transport', 'missing']);",
    "    await store.put(key, body, {",
    "      checksumSha256: require('node:crypto').createHash('sha256').update(body).digest('hex'),",
    "      contentLength: body.length,",
    "      contentType: 'text/plain; charset=utf-8',",
    "    });",
    "    stage = 21;",
    "    await store.head(key);",
    "    stage = 22;",
    "    assert.deepEqual((await store.get(key)).body, body);",
    "    stage = 23;",
    "    await assert.rejects(",
    "      store.get(key),",
    "      (error) => error && error.code === 'object_store_integrity' && error.operation === 'get'",
    "    );",
    "    stage = 24;",
    "    await assert.rejects(",
    "      store.get(missingKey),",
    "      (error) => error && error.code === 'object_store_not_found' && error.operation === 'get'",
    "    );",
    "    stage = 25;",
    "    await assert.rejects(",
    "      store.delete(key),",
    "      (error) => error && error.code === 'object_store_unavailable' && error.operation === 'delete'",
    "    );",
    "    process.exit(0);",
    "  } catch (_error) { process.exit(stage); }",
    "})();",
  ].join("\n");
  try {
    assert.equal(
      await runSilentNode(untrustedTlsScript, {
        ...childEnvironment,
        NODE_EXTRA_CA_CERTS: "",
      }),
      0,
      "untrusted local TLS was not rejected"
    );
    assert.equal(
      await runSilentNode(transportScript, {
        ...childEnvironment,
        NODE_EXTRA_CA_CERTS: certificatePath,
      }),
      0,
      "real AWS SDK transport stage failed"
    );
  } finally {
    await close(server);
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }

  const putRequest = requests.find((request) => request.method === "PUT");
  assert.ok(putRequest);
  assert.equal(putRequest.encrypted, true);
  assert.deepEqual(putRequest.body, expectedBody);
  assert.equal(putRequest.headers["cache-control"], "private, no-store");
  assert.equal(putRequest.headers["content-length"], String(expectedBody.length));
  assert.equal(putRequest.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(putRequest.headers["if-none-match"], "*");
  assert.equal(putRequest.headers["x-amz-acl"], undefined);
  assert.equal(putRequest.headers["x-amz-checksum-sha256"], expectedChecksumBase64);
  assert.equal(
    putRequest.headers["x-amz-meta-jumpgate-content-length"],
    String(expectedBody.length)
  );
  assert.equal(putRequest.headers["x-amz-meta-jumpgate-schema"], "1");
  assert.equal(
    putRequest.headers["x-amz-meta-jumpgate-sha256"],
    expectedChecksumHex
  );
  assert.equal(putRequest.headers["x-amz-server-side-encryption"], "AES256");
  assert.match(putRequest.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.match(putRequest.headers.authorization, /Credential=TRANSPORTACCESSKEY\//);
  assert.equal(typeof putRequest.headers["x-amz-date"], "string");
  assert.equal(typeof putRequest.headers["x-amz-content-sha256"], "string");
  assert.equal(
    requests.filter((request) => request.method === "HEAD").length,
    2
  );
  assert.equal(
    requests
      .filter((request) => request.method === "HEAD")[1]
      .headers["amz-sdk-request"]
      .includes("attempt=2"),
    true
  );
  assert.equal(requests.every((request) => request.encrypted), true);
  assert.equal(
    requests.some(
      (request) =>
        request.url.includes("transport-secret-never-log") ||
        request.body.includes("transport-secret-never-log")
    ),
    false
  );
});

const LIVE_S3_ENABLED = [
  "TEST_SUBTITLE_S3_ENDPOINT",
  "TEST_SUBTITLE_S3_BUCKET",
  "TEST_SUBTITLE_S3_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
].every((name) => typeof process.env[name] === "string" && process.env[name]);

test(
  "env-gated real private S3 lifecycle",
  { skip: LIVE_S3_ENABLED ? false : "set TEST_SUBTITLE_S3_* and AWS credentials" },
  async (t) => {
    const endpoint = process.env.TEST_SUBTITLE_S3_ENDPOINT;
    const sseResponsePolicy =
      process.env.TEST_SUBTITLE_S3_SSE_RESPONSE_POLICY || "required";
    const serverSideEncryption =
      sseResponsePolicy === "disabled" ? null : "AES256";
    const store = new SubtitleObjectStore({
      allowPrivateEndpoint: process.env.TEST_SUBTITLE_S3_ALLOW_PRIVATE === "1",
      bucket: process.env.TEST_SUBTITLE_S3_BUCKET,
      endpoint,
      endpointAllowlist: [new URL(endpoint).origin],
      forcePathStyle: process.env.TEST_SUBTITLE_S3_FORCE_PATH_STYLE === "1",
      keyHmacCurrentKeyId: "integration",
      keyHmacKeyring: [{ id: "integration", secret: crypto.randomBytes(32) }],
      maxObjectBytes: 1024 * 1024,
      region: process.env.TEST_SUBTITLE_S3_REGION,
      requestTimeoutMs: 15000,
      serverSideEncryption,
      sseResponsePolicy,
    });
    const body = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nintegration\n");
    const key = store.createKey([
      "integration",
      crypto.randomUUID(),
      crypto.randomBytes(16),
    ]);
    let deleted = false;
    t.after(async () => {
      if (!deleted) await store.delete(key);
    });
    const put = await store.put(key, body, {
      checksumSha256: sha256Hex(body),
      contentLength: body.length,
      contentType: "text/vtt; charset=utf-8",
    });
    assert.equal(put.key, key);
    assert.equal((await store.head(key)).checksumSha256, sha256Hex(body));
    assert.deepEqual((await store.get(key)).body, body);
    await store.delete(key);
    deleted = true;
    await assert.rejects(
      store.get(key),
      errorWithCode("object_store_not_found", "get")
    );
  }
);
