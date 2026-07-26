"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const {
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetObjectAclCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const { OpaqueObjectKeyFactory } = require("../../lib/storage/object-store");
const {
  SUBTITLE_ERASURE_CANARY_NAMESPACE,
  createHardenedSubtitleObjectStore,
  createSubtitleStorageHealth,
  loadStorageConfig,
} = require("../../lib/storage");

const {
  ALGORITHM,
  CANARY,
  CANARY_CHECKSUM,
  CANARY_SHA256,
  CHECKSUM_READ_HEADERS,
  EMPTY_SHA256,
  ERASURE_CANARY,
  ERASURE_CANARY_CHECKSUM,
  ERASURE_CANARY_SHA256,
  ERASURE_PUT_HEADERS,
  PUT_ATTEMPT_HEADER,
  PUT_HEADERS,
  createProtocolHandler,
  deriveObjectId,
  deriveResourceId,
  deriveSequenceId,
  deriveSigningKey,
  parseAuthorization,
  parseTarget,
  readConfig,
} = require("./s3-protocol-harness");
const { HARNESS_LOG_SCHEMA, verifyHarnessLog } = require("./container-smoke-env");

const NOW = Date.UTC(2026, 6, 14, 12, 34, 56);
const AMZ_DATE = "20260714T123456Z";
const ACCESS_KEY = "CI" + "0123456789ABCDEF".repeat(2);
const SECRET_KEY = "ci-secret-access-key-" + "x".repeat(32);
const PROBE_ID = "0123456789abcdef0123456789abcdef";
const BUCKET = "jumpgate-ci-subtitles";
const HOST = BUCKET + ".fly.storage.tigris.dev";

function opaqueComponent(fill) {
  return Buffer.alloc(32, fill).toString("base64url");
}

const OBJECT_KEY =
  "subtitles/v1/ci-stable/" + opaqueComponent(0x01) + "/" + opaqueComponent(0x02);
const OBJECT_PATH = "/" + OBJECT_KEY;
const ERASURE_PREFIX = "subtitles/v1/ci-stable/" + opaqueComponent(0x03) + "/";
const ERASURE_SCOPE = opaqueComponent(0x04);
const ERASURE_SCOPED_PREFIX = ERASURE_PREFIX + ERASURE_SCOPE + "/";
const ERASURE_KEY =
  ERASURE_SCOPED_PREFIX + opaqueComponent(0x05) + "/" + opaqueComponent(0x06);
const ERASURE_PATH = "/" + ERASURE_KEY;
const OTHER_ERASURE_KEY =
  ERASURE_SCOPED_PREFIX + opaqueComponent(0x07) + "/" + opaqueComponent(0x08);
const OTHER_ERASURE_PATH = "/" + OTHER_ERASURE_KEY;
const CROSS_SCOPE_PREFIX = ERASURE_PREFIX + opaqueComponent(0x09) + "/";
const CROSS_SCOPE_KEY =
  CROSS_SCOPE_PREFIX + opaqueComponent(0x0a) + "/" + opaqueComponent(0x0b);
const OBSOLETE_ERASURE_KEY =
  ERASURE_PREFIX + opaqueComponent(0x0c) + "/" + opaqueComponent(0x0d);
const NONCANONICAL_COMPONENT = "A".repeat(42) + "B";
const PUT_ATTEMPT = Buffer.alloc(32, 0x11).toString("base64url");
const ERASURE_PUT_ATTEMPT = Buffer.alloc(32, 0x22).toString("base64url");
const OBJECT_TARGETS = Object.freeze({
  GET: OBJECT_PATH + "?x-id=GetObject",
  HEAD: OBJECT_PATH,
  PUT: OBJECT_PATH + "?x-id=PutObject",
  ACL: OBJECT_PATH + "?acl",
});

function config(overrides = {}) {
  return Object.freeze({
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: "auto",
    bucket: BUCKET,
    expectedObjectKey: OBJECT_KEY,
    expectedErasurePrefix: ERASURE_PREFIX,
    probeId: PROBE_ID,
    publicAttestation: false,
    publicDelayMs: 0,
    ...overrides,
  });
}

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/[\t ]+/g, " ");
}

function signRequest(options = {}) {
  const method = options.method || "GET";
  const target = options.target || "/";
  const body = Buffer.from(options.body || []);
  const amzDate = options.amzDate || AMZ_DATE;
  const scopeDate = options.scopeDate || amzDate.slice(0, 8);
  const region = options.region || "auto";
  const service = options.service || "s3";
  const accessKeyId = options.accessKeyId || ACCESS_KEY;
  const secretAccessKey = options.secretAccessKey || SECRET_KEY;
  const headers = {
    host: HOST,
    "x-amz-content-sha256": crypto.createHash("sha256").update(body).digest("hex"),
    "x-amz-date": amzDate,
    ...(options.headers || {}),
  };
  const signedHeaderNames = options.signedHeaderNames || Object.keys(headers).sort();
  const signedHeadersText = options.signedHeadersText || signedHeaderNames.join(";");
  const parsedTarget = parseTarget(options.signedTarget || target);
  const canonicalHeaders = signedHeaderNames
    .map((name) => name + ":" + canonicalHeaderValue(headers[name]) + "\n")
    .join("");
  const canonicalRequest = [
    method,
    parsedTarget.pathname,
    parsedTarget.canonicalQuery,
    canonicalHeaders,
    signedHeadersText,
    headers["x-amz-content-sha256"],
  ].join("\n");
  const scope = `${scopeDate}/${region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  let signature = crypto
    .createHmac("sha256", deriveSigningKey(secretAccessKey, scopeDate, region, service))
    .update(stringToSign)
    .digest("hex");
  if (options.signature) signature = options.signature;
  headers.authorization =
    `${ALGORITHM} Credential=${accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeadersText}, Signature=${signature}`;
  return { method, target, headers, body };
}

async function listen(options = {}) {
  const handler = createProtocolHandler(config(options.config), {
    now: options.now || (() => NOW),
    log: options.log || (() => {}),
  });
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { handler, server, port: server.address().port };
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

async function send(port, signed) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: signed.method,
        path: signed.target,
        headers: signed.headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          })
        );
      }
    );
    request.once("error", reject);
    request.end(signed.body);
  });
}

function putRequest(overrides = {}) {
  const headers = {
    ...PUT_HEADERS,
    [PUT_ATTEMPT_HEADER]: PUT_ATTEMPT,
    "content-length": "1",
    ...(overrides.headers || {}),
  };
  for (const name of overrides.omitHeaders || []) delete headers[name];
  const {
    headers: _headers,
    omitHeaders: _omitHeaders,
    ...requestOverrides
  } = overrides;
  const signedHeaderNames = Object.keys(headers)
    .concat(["host", "x-amz-content-sha256", "x-amz-date"])
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
  return signRequest({
    ...requestOverrides,
    method: "PUT",
    target: OBJECT_TARGETS.PUT,
    body: Object.hasOwn(overrides, "body") ? overrides.body : CANARY,
    headers,
    signedHeaderNames: overrides.signedHeaderNames || signedHeaderNames,
  });
}

function erasurePutRequest(overrides = {}) {
  const headers = {
    ...ERASURE_PUT_HEADERS,
    [PUT_ATTEMPT_HEADER]: ERASURE_PUT_ATTEMPT,
    "content-length": "1",
    ...(overrides.headers || {}),
  };
  for (const name of overrides.omitHeaders || []) delete headers[name];
  const {
    headers: _headers,
    omitHeaders: _omitHeaders,
    target = ERASURE_PATH + "?x-id=PutObject",
    ...requestOverrides
  } = overrides;
  const signedHeaderNames = Object.keys(headers)
    .concat(["host", "x-amz-content-sha256", "x-amz-date"])
    .filter((name, index, names) => names.indexOf(name) === index)
    .sort();
  return signRequest({
    ...requestOverrides,
    method: "PUT",
    target,
    body: Object.hasOwn(overrides, "body") ? overrides.body : ERASURE_CANARY,
    headers,
    signedHeaderNames: overrides.signedHeaderNames || signedHeaderNames,
  });
}

function listVersionsRequest(prefix = ERASURE_SCOPED_PREFIX) {
  return signRequest({
    method: "GET",
    target: "/?max-keys=1000&prefix=" + encodeURIComponent(prefix) + "&versions",
  });
}

function readRequest(method, target) {
  const parsedTarget = parseTarget(target);
  const canaryPath =
    parsedTarget.pathname === OBJECT_PATH ||
    parsedTarget.pathname.startsWith("/" + ERASURE_PREFIX);
  const checksumRead =
    (method === "HEAD" && canaryPath) ||
    (method === "GET" &&
      parsedTarget.pathname === OBJECT_PATH &&
      parsedTarget.canonicalQuery.includes("x-id=GetObject"));
  return signRequest({
    method,
    target,
    headers: checksumRead ? CHECKSUM_READ_HEADERS : {},
  });
}

test("private lifecycle implements only the production canary protocol and replays with 412", async (t) => {
  const fixture = await listen();
  t.after(() => close(fixture.server));

  assert.equal((await send(fixture.port, readRequest("HEAD", "/"))).status, 200);
  const bucketAcl = await send(fixture.port, readRequest("GET", "/?acl"));
  assert.equal(bucketAcl.status, 200);
  assert.match(bucketAcl.body.toString(), /CanonicalUser/);
  assert.match(bucketAcl.body.toString(), /FULL_CONTROL/);
  const policy = await send(fixture.port, readRequest("GET", "/?policyStatus"));
  assert.equal(policy.status, 200);
  assert.match(policy.body.toString(), /<IsPublic>false<\/IsPublic>/);

  const put = await send(fixture.port, putRequest());
  assert.equal(put.status, 200);
  assert.equal(put.headers["x-amz-checksum-sha256"], CANARY_CHECKSUM);
  assert.equal(put.headers["x-amz-server-side-encryption"], "AES256");
  assert.deepEqual(fixture.handler.state, { stored: true, mutations: 1 });

  const head = await send(fixture.port, readRequest("HEAD", OBJECT_TARGETS.HEAD));
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], "1");
  assert.equal(head.headers["content-type"], "application/octet-stream");
  assert.equal(head.headers["cache-control"], "private, no-store");
  assert.equal(head.headers["x-amz-meta-jumpgate-content-length"], "1");
  assert.equal(head.headers[PUT_ATTEMPT_HEADER], PUT_ATTEMPT);
  assert.equal(head.headers["x-amz-meta-jumpgate-schema"], "1");
  assert.equal(head.headers["x-amz-meta-jumpgate-sha256"], CANARY_SHA256);
  assert.equal(head.headers["x-amz-checksum-sha256"], CANARY_CHECKSUM);
  assert.equal(head.headers["x-amz-server-side-encryption"], "AES256");

  const get = await send(fixture.port, readRequest("GET", OBJECT_TARGETS.GET));
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, CANARY);
  assert.equal(get.headers[PUT_ATTEMPT_HEADER], PUT_ATTEMPT);
  const objectAcl = await send(fixture.port, readRequest("GET", OBJECT_TARGETS.ACL));
  assert.equal(objectAcl.status, 200);
  assert.match(objectAcl.body.toString(), /FULL_CONTROL/);

  const replay = await send(fixture.port, putRequest());
  assert.equal(replay.status, 412);
  assert.match(replay.body.toString(), /<Code>PreconditionFailed<\/Code>/);
  assert.deepEqual(fixture.handler.state, { stored: true, mutations: 1 });
});

test("authenticated erasure HEAD binds the live version and returns 404 after exact deletion", async (t) => {
  const records = [];
  const fixture = await listen({ log: (line) => records.push(JSON.parse(line)) });
  t.after(() => close(fixture.server));

  const scopedList = await send(fixture.port, listVersionsRequest());
  assert.equal(scopedList.status, 200);
  assert.match(scopedList.body.toString(), new RegExp("<Prefix>" + ERASURE_SCOPED_PREFIX));

  const put = await send(fixture.port, erasurePutRequest());
  assert.equal(put.status, 200);
  const versionId = put.headers["x-amz-version-id"];
  assert.match(versionId, /^jumpgate-ci-erasure-[1-9][0-9]*$/);

  const head = await send(
    fixture.port,
    readRequest("HEAD", ERASURE_PATH + "?versionId=" + versionId)
  );
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], "1");
  assert.equal(head.headers["x-amz-checksum-sha256"], ERASURE_CANARY_CHECKSUM);
  assert.equal(head.headers[PUT_ATTEMPT_HEADER], ERASURE_PUT_ATTEMPT);
  assert.equal(head.headers["x-amz-meta-jumpgate-sha256"], ERASURE_CANARY_SHA256);
  assert.equal(head.headers["x-amz-version-id"], versionId);

  const deleted = await send(
    fixture.port,
    signRequest({
      method: "DELETE",
      target: ERASURE_PATH + "?versionId=" + versionId + "&x-id=DeleteObject",
    })
  );
  assert.equal(deleted.status, 204);

  const missingVersion = await send(fixture.port, readRequest("HEAD", ERASURE_PATH));
  assert.equal(missingVersion.status, 404);
  const wrongVersion = await send(
    fixture.port,
    readRequest("HEAD", ERASURE_PATH + "?versionId=jumpgate-ci-erasure-999")
  );
  assert.equal(wrongVersion.status, 404);
  const unrelated = await send(
    fixture.port,
    readRequest("HEAD", OTHER_ERASURE_PATH + "?versionId=" + versionId)
  );
  assert.equal(unrelated.status, 404);

  const missing = await send(
    fixture.port,
    readRequest("HEAD", ERASURE_PATH + "?versionId=" + versionId)
  );
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["content-length"], "0");
  assert.equal(missing.body.length, 0);
  assert.deepEqual(fixture.handler.state, { stored: false, mutations: 2 });
  assert.deepEqual(
    records.map((record) =>
      record.event === "operation" ? record.operation : record.reason
    ),
    [
      "ListObjectVersions",
      "PutObject",
      "HeadObject",
      "DeleteObject",
      "state/missing-version",
      "state/missing-version",
      "state/unrelated-missing",
      "state/missing",
    ]
  );
  const deletion = records.find((record) => record.operation === "DeleteObject");
  const absenceProofs = records.filter((record) => record.reason === "state/missing");
  assert.equal(absenceProofs.length, 1);
  assert.equal(absenceProofs[0].authenticated, true);
  assert.equal(absenceProofs[0].operation, "HeadObject");
  assert.equal(absenceProofs[0].scopeId, deletion.scopeId);
  assert.equal(absenceProofs[0].objectId, deletion.objectId);
  assert.equal(absenceProofs[0].versionSelector, "exact");
  assert.equal(absenceProofs[0].requestedVersionId, deletion.versionId);
  assert.equal(absenceProofs[0].versionId, null);
  assert.equal(
    deletion.scopeId,
    deriveResourceId(PROBE_ID, "erasure-scope", ERASURE_SCOPED_PREFIX)
  );
  assert.equal(
    deletion.objectId,
    deriveResourceId(PROBE_ID, "erasure-object", ERASURE_KEY)
  );
  assert.equal(deletion.versionSelector, "exact");
  assert.equal(deletion.requestedVersionId, deletion.versionId);
  const serializedRecords = JSON.stringify(records);
  assert.equal(serializedRecords.includes(ERASURE_KEY), false);
  assert.equal(serializedRecords.includes(ERASURE_PUT_ATTEMPT), false);
  assert.equal(serializedRecords.includes(SECRET_KEY), false);
  assert.equal(new Set(records.map((record) => record.sequenceId)).size, 1);
});

test("erasure routing binds only the current scoped prefix and full object key", async (t) => {
  const records = [];
  const fixture = await listen({ log: (line) => records.push(JSON.parse(line)) });
  t.after(() => close(fixture.server));

  const unrelatedPrefix =
    "subtitles/v1/ci-stable/" + opaqueComponent(0x0e) + "/" + opaqueComponent(0x0f) + "/";
  const invalidLists = [
    ["shared prefix", ERASURE_PREFIX],
    ["full key", ERASURE_KEY],
    ["short scope", ERASURE_PREFIX + ERASURE_SCOPE.slice(0, -1) + "/"],
    ["extra scope", ERASURE_SCOPED_PREFIX + opaqueComponent(0x10) + "/"],
    ["noncanonical scope", ERASURE_PREFIX + NONCANONICAL_COMPONENT + "/"],
    ["unrelated prefix", unrelatedPrefix],
  ];
  for (const [name, prefix] of invalidLists) {
    await t.test("rejects " + name + " list", async () => {
      const response = await send(fixture.port, listVersionsRequest(prefix));
      assert.equal(response.status, 400);
      assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
    });
  }

  assert.equal((await send(fixture.port, listVersionsRequest())).status, 200);
  assert.equal((await send(fixture.port, listVersionsRequest(CROSS_SCOPE_PREFIX))).status, 400);
  assert.equal((await send(fixture.port, listVersionsRequest(ERASURE_KEY))).status, 400);

  const invalidKeys = [
    ["obsolete two-segment", OBSOLETE_ERASURE_KEY],
    [
      "short nonce",
      ERASURE_SCOPED_PREFIX +
        opaqueComponent(0x11).slice(0, -1) +
        "/" +
        opaqueComponent(0x12),
    ],
    ["extra segment", ERASURE_KEY + "/" + opaqueComponent(0x13)],
    [
      "noncanonical nonce",
      ERASURE_SCOPED_PREFIX + NONCANONICAL_COMPONENT + "/" + opaqueComponent(0x14),
    ],
    ["cross-scope", CROSS_SCOPE_KEY],
    [
      "unrelated namespace",
      "subtitles/v1/ci-stable/" +
        opaqueComponent(0x15) +
        "/" +
        opaqueComponent(0x16) +
        "/" +
        opaqueComponent(0x17) +
        "/" +
        opaqueComponent(0x18),
    ],
  ];
  for (const [name, key] of invalidKeys) {
    await t.test("rejects " + name + " object key", async () => {
      const response = await send(
        fixture.port,
        erasurePutRequest({ target: "/" + key + "?x-id=PutObject" })
      );
      assert.equal(response.status >= 400, true);
      assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
    });
  }

  const put = await send(fixture.port, erasurePutRequest());
  assert.equal(put.status, 200);
  const versionId = put.headers["x-amz-version-id"];
  assert.match(versionId, /^jumpgate-ci-erasure-[1-9][0-9]*$/);
  assert.equal((await send(fixture.port, listVersionsRequest(ERASURE_KEY))).status, 200);
  assert.equal((await send(fixture.port, listVersionsRequest(OTHER_ERASURE_KEY))).status, 400);

  const unrelatedPut = await send(
    fixture.port,
    erasurePutRequest({ target: OTHER_ERASURE_PATH + "?x-id=PutObject" })
  );
  assert.equal(unrelatedPut.status, 404);
  assert.equal(
    (
      await send(
        fixture.port,
        readRequest("HEAD", OTHER_ERASURE_PATH + "?versionId=" + versionId)
      )
    ).status,
    404
  );
  assert.equal(
    (
      await send(
        fixture.port,
        signRequest({
          method: "DELETE",
          target:
            OTHER_ERASURE_PATH + "?versionId=" + versionId + "&x-id=DeleteObject",
        })
      )
    ).status,
    404
  );
  assert.deepEqual(fixture.handler.state, { stored: false, mutations: 1 });

  const populated = await send(fixture.port, listVersionsRequest());
  assert.equal(populated.status, 200);
  assert.equal((populated.body.toString().match(/<Version>/g) || []).length, 1);
  assert.match(populated.body.toString(), new RegExp("<Key>" + ERASURE_KEY));

  const acceptedPut = records.find(
    (record) => record.event === "operation" && record.operation === "PutObject"
  );
  assert.ok(acceptedPut);
  assert.equal(
    acceptedPut.scopeId,
    deriveResourceId(PROBE_ID, "erasure-scope", ERASURE_SCOPED_PREFIX)
  );
  assert.equal(
    acceptedPut.objectId,
    deriveResourceId(PROBE_ID, "erasure-object", ERASURE_KEY)
  );
  assert.equal(acceptedPut.versionId, versionId);
  const populatedLists = records.filter(
    (record) => record.operation === "ListObjectVersions" && record.objectCount === 1
  );
  assert.equal(populatedLists.length, 2);
  for (const record of populatedLists) {
    assert.equal(record.scopeId, acceptedPut.scopeId);
    assert.equal(record.objectId, acceptedPut.objectId);
    assert.equal(record.versionId, acceptedPut.versionId);
  }
  assert.equal(new Set(records.map((record) => record.sequenceId)).size, 1);

  const serializedRecords = JSON.stringify(records);
  for (const secret of [
    ERASURE_PREFIX,
    ERASURE_SCOPED_PREFIX,
    ERASURE_KEY,
    OTHER_ERASURE_KEY,
    CROSS_SCOPE_PREFIX,
    CROSS_SCOPE_KEY,
    ERASURE_PUT_ATTEMPT,
    SECRET_KEY,
  ]) {
    assert.equal(serializedRecords.includes(secret), false);
  }
});

test("pinned AWS SDK v3 uses the exact virtual-hosted harness protocol", async (t) => {
  const fixture = await listen({ now: Date.now });
  const agent = new http.Agent();
  agent.createConnection = (_options, callback) =>
    net.createConnection({ host: "127.0.0.1", port: fixture.port }, callback);
  const client = new S3Client({
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    endpoint: "http://fly.storage.tigris.dev",
    forcePathStyle: false,
    maxAttempts: 1,
    region: "auto",
    requestChecksumCalculation: "WHEN_SUPPORTED",
    responseChecksumValidation: "WHEN_SUPPORTED",
    requestHandler: new NodeHttpHandler({ httpAgent: agent }),
  });
  t.after(async () => {
    client.destroy();
    await close(fixture.server);
  });

  await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  await client.send(new GetBucketAclCommand({ Bucket: BUCKET }));
  const policy = await client.send(new GetBucketPolicyStatusCommand({ Bucket: BUCKET }));
  assert.equal(policy.PolicyStatus.IsPublic, false);
  const putInput = {
    Body: CANARY,
    Bucket: BUCKET,
    CacheControl: "private, no-store",
    ChecksumSHA256: CANARY_CHECKSUM,
    ContentLength: 1,
    ContentType: "application/octet-stream",
    IfNoneMatch: "*",
    Key: OBJECT_KEY,
    Metadata: {
      "jumpgate-content-length": "1",
      "jumpgate-put-attempt": PUT_ATTEMPT,
      "jumpgate-schema": "1",
      "jumpgate-sha256": CANARY_SHA256,
    },
    ServerSideEncryption: "AES256",
  };
  const privacyPut = await client.send(new PutObjectCommand(putInput));
  assert.equal(privacyPut.VersionId, "jumpgate-ci-privacy-1");
  const head = await client.send(
    new HeadObjectCommand({
      Bucket: BUCKET,
      ChecksumMode: "ENABLED",
      Key: OBJECT_KEY,
      VersionId: privacyPut.VersionId,
    })
  );
  assert.equal(head.ChecksumSHA256, CANARY_CHECKSUM);
  assert.equal(head.Metadata["jumpgate-put-attempt"], PUT_ATTEMPT);
  assert.equal(head.VersionId, privacyPut.VersionId);
  const get = await client.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      ChecksumMode: "ENABLED",
      Key: OBJECT_KEY,
      VersionId: privacyPut.VersionId,
    })
  );
  assert.deepEqual(Buffer.from(await get.Body.transformToByteArray()), CANARY);
  assert.equal(get.Metadata["jumpgate-put-attempt"], PUT_ATTEMPT);
  assert.equal(get.VersionId, privacyPut.VersionId);
  const acl = await client.send(
    new GetObjectAclCommand({
      Bucket: BUCKET,
      Key: OBJECT_KEY,
      VersionId: privacyPut.VersionId,
    })
  );
  assert.equal(acl.Grants[0].Permission, "FULL_CONTROL");
  await assert.rejects(
    client.send(new PutObjectCommand(putInput)),
    (error) => error && error.$metadata?.httpStatusCode === 412
  );
  assert.deepEqual(fixture.handler.state, { stored: true, mutations: 1 });

  const listInput = { Bucket: BUCKET, MaxKeys: 1000, Prefix: ERASURE_SCOPED_PREFIX };
  assert.equal((await client.send(new ListObjectVersionsCommand(listInput))).IsTruncated, false);
  assert.deepEqual(
    (await client.send(new ListObjectVersionsCommand(listInput))).Versions || [],
    []
  );
  await client.send(
    new PutObjectCommand({
      Body: ERASURE_CANARY,
      Bucket: BUCKET,
      CacheControl: "private, no-store",
      ChecksumSHA256: ERASURE_CANARY_CHECKSUM,
      ContentLength: 1,
      ContentType: "application/octet-stream",
      IfNoneMatch: "*",
      Key: ERASURE_KEY,
      Metadata: {
        "jumpgate-content-length": "1",
        "jumpgate-put-attempt": ERASURE_PUT_ATTEMPT,
        "jumpgate-schema": "1",
        "jumpgate-sha256": ERASURE_CANARY_SHA256,
      },
      ServerSideEncryption: "AES256",
    })
  );
  const populated = await client.send(new ListObjectVersionsCommand(listInput));
  assert.equal(populated.Versions.length, 1);
  assert.equal(populated.Versions[0].Key, ERASURE_KEY);
  assert.match(populated.Versions[0].VersionId, /^jumpgate-ci-erasure-[1-9][0-9]*$/);
  const erasureHead = await client.send(
    new HeadObjectCommand({
      Bucket: BUCKET,
      ChecksumMode: "ENABLED",
      Key: ERASURE_KEY,
      VersionId: populated.Versions[0].VersionId,
    })
  );
  assert.equal(erasureHead.ChecksumSHA256, ERASURE_CANARY_CHECKSUM);
  assert.equal(
    erasureHead.Metadata["jumpgate-put-attempt"],
    ERASURE_PUT_ATTEMPT
  );
  assert.equal(erasureHead.VersionId, populated.Versions[0].VersionId);
  await client.send(
    new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: ERASURE_KEY,
      VersionId: populated.Versions[0].VersionId,
    })
  );
  assert.deepEqual(
    (await client.send(new ListObjectVersionsCommand(listInput))).Versions || [],
    []
  );
  assert.deepEqual(
    (await client.send(new ListObjectVersionsCommand(listInput))).Versions || [],
    []
  );
  await assert.rejects(
    client.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        ChecksumMode: "ENABLED",
        Key: ERASURE_KEY,
        VersionId: populated.Versions[0].VersionId,
      })
    ),
    (error) => error && error.$metadata?.httpStatusCode === 404
  );
  assert.deepEqual(fixture.handler.state, { stored: true, mutations: 3 });
});

test("production readiness proves exact-version erasure through the signed harness", async (t) => {
  const objectKeySecret = Buffer.alloc(32, 0x52);
  const objectKeyring = JSON.stringify([
    { id: "ci-stable", key: objectKeySecret.toString("base64url") },
  ]);
  const keyFactory = new OpaqueObjectKeyFactory({
    currentKeyId: "ci-stable",
    keyring: [{ id: "ci-stable", secret: objectKeySecret }],
    prefix: "subtitles/v1",
  });
  const expectedObjectKey = keyFactory.create(["privacy-readiness-canary-v1"]);
  const [expectedErasurePrefix] = keyFactory.namespacePrefixes([
    SUBTITLE_ERASURE_CANARY_NAMESPACE,
  ]);
  const records = [];
  const fixture = await listen({
    config: { expectedErasurePrefix, expectedObjectKey },
    log: (line) => records.push(JSON.parse(line)),
    now: Date.now,
  });
  const agent = new http.Agent();
  agent.createConnection = (_options, callback) =>
    net.createConnection({ host: "127.0.0.1", port: fixture.port }, callback);
  const client = new S3Client({
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    endpoint: "http://fly.storage.tigris.dev",
    forcePathStyle: false,
    maxAttempts: 1,
    region: "auto",
    requestChecksumCalculation: "WHEN_SUPPORTED",
    responseChecksumValidation: "WHEN_SUPPORTED",
    requestHandler: new NodeHttpHandler({ httpAgent: agent }),
  });
  t.after(async () => {
    client.destroy();
    await close(fixture.server);
  });

  const storageConfig = loadStorageConfig({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://bridge:secret@db.example:5432/jumpgate",
    REDIS_URL: "redis://redis.example:6379/0",
    JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
    JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
    JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
    JUMPGATE_SUBTITLE_S3_BUCKET: BUCKET,
    JUMPGATE_SUBTITLE_S3_REGION: "auto",
    JUMPGATE_SUBTITLE_S3_ENDPOINT: "https://fly.storage.tigris.dev",
    JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE: "0",
    JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: "tigris-policy-status",
    JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
    JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID: ACCESS_KEY,
    JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY: SECRET_KEY,
    JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID: "ci-stable",
    JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: objectKeyring,
    JUMPGATE_TOKEN_PEPPER: Buffer.alloc(32, 0x31).toString("base64url"),
    JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "runtime-key",
    JUMPGATE_ENVELOPE_KEYRING: JSON.stringify([
      { id: "runtime-key", key: Buffer.alloc(32, 0x41).toString("base64url") },
    ]),
  });
  const store = createHardenedSubtitleObjectStore(storageConfig, { client });
  const lifecycle = {
    readinessMs: 5000,
    timers: { clearTimeout, now: Date.now, setTimeout },
  };
  const createHealth = (fill) =>
    createSubtitleStorageHealth(client, store, storageConfig, lifecycle, {
      attestationFreshnessMs: 60_000,
      randomBytes: (size) => Buffer.alloc(size, fill),
    });
  const firstHealth = createHealth(0x71);

  await firstHealth.run({ timeoutMs: 5000 });

  assert.deepEqual(fixture.handler.state, { stored: true, mutations: 3 });
  assert.deepEqual(
    records
      .filter((record) => record.event === "operation")
      .map((record) => record.operation),
    [
      "HeadBucket",
      "GetBucketAcl",
      "GetBucketPolicyStatus",
      "PutObject",
      "HeadObject",
      "GetObject",
      "GetObjectAcl",
      "ListObjectVersions",
      "ListObjectVersions",
      "PutObject",
      "ListObjectVersions",
      "DeleteObject",
      "ListObjectVersions",
      "ListObjectVersions",
    ]
  );
  assert.deepEqual(
    records
      .filter((record) => record.event === "request")
      .map((record) => record.reason),
    ["state/missing", "state/missing"]
  );

  await createHealth(0x72).run({ timeoutMs: 5000 });
  const servingHealth = createHealth(0x73);
  await servingHealth.run({ timeoutMs: 5000 });
  await servingHealth.run({ timeoutMs: 5000 });
  assert.deepEqual(fixture.handler.state, { stored: true, mutations: 7 });

  const proofDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jumpgate-s3-health-proof-")
  );
  t.after(() => fs.rmSync(proofDirectory, { recursive: true, force: true }));
  const proofPath = path.join(proofDirectory, "private.log");
  const ready = {
    schema: HARNESS_LOG_SCHEMA,
    event: "ready",
    probeId: PROBE_ID,
    mode: "private",
  };
  fs.writeFileSync(
    proofPath,
    [ready, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
  verifyHarnessLog({ input: proofPath, "probe-id": PROBE_ID }, "private");
});

test("SigV4 rejects access, scope, canonicalization, signed headers, payload, and clock attacks", async (t) => {
  const attacks = [
    ["access", signRequest({ method: "HEAD", accessKeyId: "CIFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF" })],
    ["scope date", signRequest({ method: "HEAD", scopeDate: "20260713" })],
    ["region", signRequest({ method: "HEAD", region: "us-east-1" })],
    ["service", signRequest({ method: "HEAD", service: "execute-api" })],
    ["signature", signRequest({ method: "HEAD", signature: "0".repeat(64) })],
    ["canonical query", signRequest({ method: "GET", target: "/?acl", signedTarget: "/" })],
    [
      "missing mandatory signed header",
      signRequest({ method: "HEAD", signedHeaderNames: ["x-amz-content-sha256", "x-amz-date"] }),
    ],
    [
      "unsorted signed headers",
      signRequest({
        method: "HEAD",
        signedHeaderNames: ["host", "x-amz-content-sha256", "x-amz-date"],
        signedHeadersText: "x-amz-date;host;x-amz-content-sha256",
      }),
    ],
    [
      "payload hash",
      signRequest({
        method: "HEAD",
        headers: { "x-amz-content-sha256": "f".repeat(64) },
      }),
    ],
    ["clock skew", signRequest({ method: "HEAD", amzDate: "20260714T122955Z" })],
  ];

  for (const [name, request] of attacks) {
    await t.test(name, async () => {
      const fixture = await listen();
      try {
        const response = await send(fixture.port, request);
        assert.equal(response.status, 403);
        assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
      } finally {
        await close(fixture.server);
      }
    });
  }
});

test("unknown hosts, buckets, keys, methods, queries, ACL writes, and DELETE never mutate", async (t) => {
  const requests = [
    ["canonical endpoint without bucket", signRequest({ method: "HEAD", headers: { host: "fly.storage.tigris.dev" } })],
    ["unknown bucket", signRequest({ method: "HEAD", headers: { host: "other.fly.storage.tigris.dev" } })],
    ["unknown key", signRequest({ method: "GET", target: "/unknown" })],
    ["bucket POST", signRequest({ method: "POST" })],
    ["unknown query", signRequest({ method: "GET", target: "/?uploads" })],
    [
      "wrong version prefix",
      signRequest({
        method: "GET",
        target: "/?max-keys=1000&prefix=other%2F&versions",
      }),
    ],
    ["object DELETE", signRequest({ method: "DELETE", target: OBJECT_PATH })],
    [
      "unbound erasure delete",
      signRequest({
        method: "DELETE",
        target: "/" + ERASURE_KEY + "?versionId=jumpgate-ci-erasure-1&x-id=DeleteObject",
      }),
    ],
    ["object query", signRequest({ method: "GET", target: OBJECT_PATH + "?versionId=1" })],
    ["missing GET operation selector", signRequest({ method: "GET", target: OBJECT_PATH })],
    ["erasure GET", readRequest("GET", ERASURE_PATH + "?x-id=GetObject")],
    [
      "erasure HEAD privacy version",
      readRequest("HEAD", ERASURE_PATH + "?versionId=jumpgate-ci-privacy-1"),
    ],
    ["ACL write", putRequest({ headers: { "x-amz-acl": "public-read" } })],
  ];
  for (const [name, request] of requests) {
    await t.test(name, async () => {
      const fixture = await listen();
      try {
        const response = await send(fixture.port, request);
        assert.equal(response.status >= 400, true);
        assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
      } finally {
        await close(fixture.server);
      }
    });
  }
});

test("conditional put requires exact byte, checksum, SSE, metadata, cache, and signed semantics", async (t) => {
  const mutations = [
    ["body", { body: Buffer.from([0xa4]) }],
    ["content type", { headers: { "content-type": "text/plain" } }],
    ["cache", { headers: { "cache-control": "public" } }],
    ["condition", { headers: { "if-none-match": '"etag"' } }],
    ["checksum", { headers: { "x-amz-checksum-sha256": Buffer.alloc(32).toString("base64") } }],
    ["metadata length", { headers: { "x-amz-meta-jumpgate-content-length": "2" } }],
    ["missing put attempt", { omitHeaders: [PUT_ATTEMPT_HEADER] }],
    ["malformed put attempt", { headers: { [PUT_ATTEMPT_HEADER]: "short" } }],
    ["noncanonical put attempt", { headers: { [PUT_ATTEMPT_HEADER]: "a".repeat(43) } }],
    ["metadata schema", { headers: { "x-amz-meta-jumpgate-schema": "2" } }],
    ["metadata digest", { headers: { "x-amz-meta-jumpgate-sha256": "0".repeat(64) } }],
    ["SSE", { headers: { "x-amz-server-side-encryption": "aws:kms" } }],
    ["storage class", { headers: { "x-amz-storage-class": "DEEP_ARCHIVE" } }],
    ["tagging", { headers: { "x-amz-tagging": "retention=forever" } }],
    ["extra metadata", { headers: { "x-amz-meta-jumpgate-extra": "1" } }],
    [
      "extra put attempt variant",
      { headers: { "x-amz-meta-jumpgate-put-attempt-id": PUT_ATTEMPT } },
    ],
    ["content semantics", { headers: { "content-encoding": "gzip" } }],
    ["unknown x-amz", { headers: { "x-amz-website-redirect-location": "/escape" } }],
  ];
  for (const [name, overrides] of mutations) {
    await t.test(name, async () => {
      const fixture = await listen();
      try {
        const response = await send(fixture.port, putRequest(overrides));
        assert.equal(response.status, 400);
        assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
      } finally {
        await close(fixture.server);
      }
    });
  }

  await t.test("unsigned semantic header", async () => {
    const fixture = await listen();
    try {
      const request = putRequest();
      const names = request.headers.authorization
        .match(/SignedHeaders=([^,]+)/)[1]
        .split(";")
        .filter((name) => name !== "content-type");
      const unsigned = putRequest({ signedHeaderNames: names });
      const response = await send(fixture.port, unsigned);
      assert.equal(response.status, 403);
      assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
    } finally {
      await close(fixture.server);
    }
  });

  await t.test("unsigned put attempt metadata", async () => {
    const fixture = await listen();
    try {
      const request = putRequest();
      const names = request.headers.authorization
        .match(/SignedHeaders=([^,]+)/)[1]
        .split(";")
        .filter((name) => name !== PUT_ATTEMPT_HEADER);
      const response = await send(fixture.port, putRequest({ signedHeaderNames: names }));
      assert.equal(response.status, 403);
      assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
    } finally {
      await close(fixture.server);
    }
  });

  await t.test("unsigned permitted x-amz header", async () => {
    const fixture = await listen();
    try {
      const request = putRequest({ headers: { "x-amz-user-agent": "aws-sdk-js/3.1085.0" } });
      const names = request.headers.authorization
        .match(/SignedHeaders=([^,]+)/)[1]
        .split(";")
        .filter((name) => name !== "x-amz-user-agent");
      const unsigned = putRequest({
        headers: { "x-amz-user-agent": "aws-sdk-js/3.1085.0" },
        signedHeaderNames: names,
      });
      const response = await send(fixture.port, unsigned);
      assert.equal(response.status, 403);
      assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
    } finally {
      await close(fixture.server);
    }
  });
});

test("operation header allowlists reject misplaced content, metadata, and x-amz semantics", async (t) => {
  const attacks = [
    ["bucket content", signRequest({ method: "HEAD", headers: { "content-type": "text/plain" } })],
    [
      "bucket checksum mode",
      signRequest({ method: "GET", target: "/?acl", headers: CHECKSUM_READ_HEADERS }),
    ],
    [
      "object ACL metadata",
      signRequest({
        method: "GET",
        target: OBJECT_TARGETS.ACL,
        headers: { "x-amz-meta-jumpgate-schema": "1" },
      }),
    ],
    [
      "object read storage class",
      signRequest({
        method: "GET",
        target: OBJECT_TARGETS.GET,
        headers: { ...CHECKSUM_READ_HEADERS, "x-amz-storage-class": "DEEP_ARCHIVE" },
      }),
    ],
  ];
  for (const [name, request] of attacks) {
    await t.test(name, async () => {
      const fixture = await listen();
      try {
        const response = await send(fixture.port, request);
        assert.equal(response.status, 400);
        assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
      } finally {
        await close(fixture.server);
      }
    });
  }
});

test("object reads require signed checksum mode and missing state stays immutable", async (t) => {
  const fixture = await listen();
  t.after(() => close(fixture.server));
  assert.equal((await send(fixture.port, listVersionsRequest())).status, 200);
  for (const [method, target] of [
    ["HEAD", OBJECT_TARGETS.HEAD],
    ["GET", OBJECT_TARGETS.GET],
    ["HEAD", ERASURE_PATH],
  ]) {
    const missingMode = signRequest({ method, target });
    assert.equal((await send(fixture.port, missingMode)).status, 400);
    const unsignedMode = signRequest({
      method,
      target,
      headers: CHECKSUM_READ_HEADERS,
      signedHeaderNames: ["host", "x-amz-content-sha256", "x-amz-date"],
    });
    assert.equal((await send(fixture.port, unsignedMode)).status, 403);
    assert.equal((await send(fixture.port, readRequest(method, target))).status, 404);
  }
  assert.equal((await send(fixture.port, readRequest("GET", OBJECT_TARGETS.ACL))).status, 404);
  assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
});

test("public policy attestation is explicit and cannot create the canary", async (t) => {
  const records = [];
  const fixture = await listen({
    config: { publicAttestation: true },
    log: (line) => records.push(JSON.parse(line)),
  });
  t.after(() => close(fixture.server));
  const response = await send(fixture.port, readRequest("GET", "/?policyStatus"));
  assert.equal(response.status, 200);
  assert.match(response.body.toString(), /<IsPublic>true<\/IsPublic>/);
  assert.deepEqual(fixture.handler.state, { stored: false, mutations: 0 });
  assert.deepEqual(records, [
    {
      schema: "jumpgate-s3-harness-v2",
      event: "operation",
      probeId: PROBE_ID,
      sequenceId: deriveSequenceId(PROBE_ID, 1),
      authenticated: true,
      operation: "GetBucketPolicyStatus",
      outcome: "accepted",
      scopeId: null,
      objectId: null,
      versionSelector: "none",
      requestedVersionId: null,
      versionId: null,
      objectCount: null,
      isPublic: true,
    },
  ]);
});

test("parsers and environment config fail closed on malformed authority", () => {
  assert.equal(parseTarget("/?policyStatus").canonicalQuery, "policyStatus=");
  assert.equal(parseTarget("/?acl=").canonicalQuery, "acl=");
  for (const target of ["", "//", "/%2e%2e/key", "/?", "/?acl&&x=1", "/?bad=%ZZ"] ) {
    assert.throws(() => parseTarget(target));
  }
  assert.throws(() => parseAuthorization("AWS4-HMAC-SHA256 broken"));

  const base = {
    S3_HARNESS_ACCESS_KEY_ID: ACCESS_KEY,
    S3_HARNESS_SECRET_ACCESS_KEY: SECRET_KEY,
    S3_HARNESS_REGION: "auto",
    S3_HARNESS_BUCKET: BUCKET,
    S3_HARNESS_EXPECTED_OBJECT_KEY: OBJECT_KEY,
    S3_HARNESS_EXPECTED_ERASURE_PREFIX: ERASURE_PREFIX,
    S3_HARNESS_PROBE_ID: PROBE_ID,
    S3_HARNESS_PUBLIC_ATTESTATION: "0",
    S3_HARNESS_PUBLIC_DELAY_MS: "0",
    S3_HARNESS_TLS_CERT_FILE: "/run/server.crt",
    S3_HARNESS_TLS_KEY_FILE: "/run/server.key",
    S3_HARNESS_PORT: "443",
  };
  assert.equal(readConfig(base).region, "auto");
  for (const [field, value] of [
    ["S3_HARNESS_REGION", "us-east-1"],
    ["S3_HARNESS_BUCKET", "Bad_Bucket"],
    ["S3_HARNESS_PUBLIC_ATTESTATION", "true"],
    ["S3_HARNESS_PUBLIC_DELAY_MS", "5001"],
    ["S3_HARNESS_EXPECTED_OBJECT_KEY", "subtitles/v1/escape"],
    [
      "S3_HARNESS_EXPECTED_OBJECT_KEY",
      "subtitles/v1/ci-stable/" + NONCANONICAL_COMPONENT + "/" + opaqueComponent(0x19),
    ],
    ["S3_HARNESS_EXPECTED_ERASURE_PREFIX", "subtitles/v1/escape/"],
    [
      "S3_HARNESS_EXPECTED_ERASURE_PREFIX",
      "subtitles/v1/ci-stable/" + NONCANONICAL_COMPONENT + "/",
    ],
    ["S3_HARNESS_PROBE_ID", "not-a-probe"],
    ["S3_HARNESS_PORT", "0"],
  ]) {
    assert.throws(() => readConfig({ ...base, [field]: value }));
  }
  assert.equal(EMPTY_SHA256, crypto.createHash("sha256").update("").digest("hex"));
});
