"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const {
  BUCKET,
  ENDPOINT,
  OBJECT_KEY_ID,
  HARNESS_LOG_SCHEMA,
  audit,
  createFiles,
  generate,
  parseArguments,
  readSecrets,
  redact,
  serializeEnvironment,
  verifyHarnessLog,
} = require("./container-smoke-env");
const {
  deriveObjectId,
  deriveResourceId,
  deriveSequenceId,
} = require("./s3-protocol-harness");
const { loadStorageConfig } = require("../../lib/storage/config");

const PRIVACY_VERSION_ID = "jumpgate-ci-privacy-1";

function outputPaths(directory) {
  return {
    "harness-env": path.join(directory, "harness.env"),
    "postgres-env": path.join(directory, "postgres.env"),
    "runtime-env": path.join(directory, "runtime.env"),
    "secret-values": path.join(directory, "secrets.txt"),
  };
}

function parseEnvironment(filename) {
  return Object.fromEntries(
    fs
      .readFileSync(filename, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1);
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function harnessLine(record) {
  return JSON.stringify({ schema: HARNESS_LOG_SCHEMA, ...record });
}

function operationLine(probeId, ordinal, operation, options = {}) {
  return harnessLine({
    event: "operation",
    probeId,
    sequenceId: deriveSequenceId(probeId, ordinal),
    authenticated: true,
    operation,
    outcome: "accepted",
    scopeId: options.scopeId ?? null,
    objectId: options.objectId ?? null,
    versionSelector: options.versionSelector ?? "none",
    requestedVersionId: options.requestedVersionId ?? null,
    versionId: options.versionId ?? null,
    objectCount: options.objectCount ?? null,
    ...(operation === "GetBucketPolicyStatus"
      ? { isPublic: options.isPublic === true }
      : {}),
  });
}

function rejectionLine(probeId, ordinal, reason, options = {}) {
  const operation =
    options.operation || (reason === "state/replay" ? "PutObject" : "HeadObject");
  return harnessLine({
    event: "request",
    probeId,
    sequenceId: deriveSequenceId(probeId, ordinal),
    authenticated: true,
    operation,
    outcome: "rejected",
    reason,
    scopeId: options.scopeId ?? null,
    objectId: options.objectId ?? null,
    versionSelector: options.versionSelector ?? "none",
    requestedVersionId: options.requestedVersionId ?? null,
    versionId: options.versionId ?? null,
  });
}

function privacyProof(probeId, ordinal, initial) {
  const object = {
    objectId: deriveObjectId(probeId, "privacy"),
    versionId: PRIVACY_VERSION_ID,
  };
  return [
    operationLine(probeId, ordinal, "HeadBucket"),
    operationLine(probeId, ordinal, "GetBucketPolicyStatus", { isPublic: false }),
    ...(initial
      ? [operationLine(probeId, ordinal, "PutObject", object)]
      : [
          rejectionLine(probeId, ordinal, "state/replay", {
            ...object,
            versionId: null,
          }),
          operationLine(probeId, ordinal, "HeadObject", object),
          operationLine(probeId, ordinal, "HeadObject", object),
        ]),
    operationLine(probeId, ordinal, "HeadObject", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
    }),
    operationLine(probeId, ordinal, "GetObject", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
    }),
    operationLine(probeId, ordinal, "GetObjectAcl", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
    }),
  ];
}

function erasureProof(probeId, ordinal) {
  const rawScope = "fixture-erasure-scope-" + ordinal;
  const rawObject = rawScope + "/fixture-erasure-object-" + ordinal;
  const object = {
    scopeId: deriveResourceId(probeId, "erasure-scope", rawScope),
    objectId: deriveResourceId(probeId, "erasure-object", rawObject),
    versionId: "jumpgate-ci-erasure-" + ordinal,
  };
  const empty = { scopeId: object.scopeId, objectCount: 0 };
  return [
    operationLine(probeId, ordinal, "ListObjectVersions", empty),
    operationLine(probeId, ordinal, "ListObjectVersions", empty),
    operationLine(probeId, ordinal, "PutObject", object),
    operationLine(probeId, ordinal, "ListObjectVersions", {
      ...object,
      objectCount: 1,
    }),
    operationLine(probeId, ordinal, "DeleteObject", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
    }),
    operationLine(probeId, ordinal, "ListObjectVersions", empty),
    rejectionLine(probeId, ordinal, "state/missing", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
      versionId: null,
    }),
    operationLine(probeId, ordinal, "ListObjectVersions", empty),
    rejectionLine(probeId, ordinal, "state/missing", {
      ...object,
      versionSelector: "exact",
      requestedVersionId: object.versionId,
      versionId: null,
    }),
  ];
}

function privateProof(probeId) {
  return [
    harnessLine({ event: "ready", probeId, mode: "private" }),
    ...privacyProof(probeId, 1, true),
    ...erasureProof(probeId, 1),
    ...privacyProof(probeId, 2, false),
    ...erasureProof(probeId, 2),
    ...privacyProof(probeId, 3, false),
    ...erasureProof(probeId, 3),
    ...privacyProof(probeId, 4, false),
  ];
}

test("generated files contain the complete fenced production rollout and stable S3 authority", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-container-env-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let counter = 0;
  const randomBytes = (length) => Buffer.alloc(length, ++counter);
  const paths = outputPaths(directory);
  const result = generate(paths, { randomBytes });
  const runtime = parseEnvironment(paths["runtime-env"]);
  const harness = parseEnvironment(paths["harness-env"]);
  const postgres = parseEnvironment(paths["postgres-env"]);
  const storage = loadStorageConfig(runtime);

  assert.deepEqual(
    {
      NODE_ENV: runtime.NODE_ENV,
      JUMPGATE_DURABLE_DRIVER: runtime.JUMPGATE_DURABLE_DRIVER,
      JUMPGATE_TTL_DRIVER: runtime.JUMPGATE_TTL_DRIVER,
      JUMPGATE_PROVIDER_MUTATION_MODE: runtime.JUMPGATE_PROVIDER_MUTATION_MODE,
      JUMPGATE_POSTGRES_MIGRATION_CEILING:
        runtime.JUMPGATE_POSTGRES_MIGRATION_CEILING,
      JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION:
        runtime.JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION,
      JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE:
        runtime.JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE,
    },
    {
      NODE_ENV: "production",
      JUMPGATE_DURABLE_DRIVER: "postgres",
      JUMPGATE_TTL_DRIVER: "redis",
      JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
      JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
      JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
      JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE: "v6",
    }
  );
  assert.equal(runtime.JUMPGATE_SUBTITLE_S3_BUCKET, BUCKET);
  assert.equal(runtime.JUMPGATE_SUBTITLE_S3_ENDPOINT, ENDPOINT);
  assert.equal(runtime.JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE, "0");
  assert.equal(runtime.JUMPGATE_SUBTITLE_S3_PRIVACY_MODE, "tigris-policy-status");
  assert.equal(
    runtime.JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE,
    "tigris-version-purge-v1"
  );
  assert.equal(runtime.JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID, OBJECT_KEY_ID);
  assert.equal(runtime.NODE_EXTRA_CA_CERTS, "/run/jumpgate-ca/ca.crt");
  assert.equal(harness.S3_HARNESS_ACCESS_KEY_ID, runtime.JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID);
  assert.equal(
    harness.S3_HARNESS_SECRET_ACCESS_KEY,
    runtime.JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY
  );
  assert.equal(harness.S3_HARNESS_EXPECTED_OBJECT_KEY, result.expectedObjectKey);
  assert.equal(
    harness.S3_HARNESS_EXPECTED_ERASURE_PREFIX,
    result.expectedErasurePrefix
  );
  assert.equal(harness.S3_HARNESS_PROBE_ID, result.probeId);
  assert.match(result.probeId, /^[a-f0-9]{32}$/);
  assert.match(
    result.expectedObjectKey,
    /^subtitles\/v1\/ci-stable\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}$/
  );
  assert.match(
    result.expectedErasurePrefix,
    /^subtitles\/v1\/ci-stable\/[A-Za-z0-9_-]{43}\/$/
  );
  assert.equal(harness.S3_HARNESS_PUBLIC_ATTESTATION, "0");
  assert.equal(
    runtime.DATABASE_URL,
    `postgresql://jumpgate:${postgres.POSTGRES_PASSWORD}@jumpgate-postgres:5432/jumpgate_container_ci`
  );
  assert.equal(runtime.REDIS_URL, "redis://jumpgate-redis:6379/0");
  assert.equal(storage.providerMutationMode, "fenced");
  assert.equal(storage.postgresMigrationCeiling, "0011_history_http_receipts");
  assert.equal(storage.redisPlaybackWriteVersion, "4");
  assert.equal(storage.subtitleS3.bucket, BUCKET);
  assert.equal(storage.subtitleObjectKeys.currentKeyId, OBJECT_KEY_ID);
  assert.equal(storage.ephemeralSecurityMaterial, false);
  assert.equal(readSecrets(paths["secret-values"]).length, 9);
  for (const filename of Object.values(paths)) {
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    }
  }
});

test("production deployment pins fenced v4 protocols, durable manifests, and two serving machines", () => {
  const root = path.join(__dirname, "..", "..");
  const fly = fs.readFileSync(path.join(root, "fly.toml"), "utf8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(
    fly,
    /JUMPGATE_PROVIDER_MUTATION_MODE\s*=\s*'fenced'/
  );
  assert.match(
    fly,
    /JUMPGATE_POSTGRES_MIGRATION_CEILING\s*=\s*'0011_history_http_receipts'/
  );
  assert.match(
    fly,
    /JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION\s*=\s*'4'/
  );
  assert.match(
    fly,
    /JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE\s*=\s*'v6'/
  );
  assert.match(
    fly,
    /release_command\s*=\s*'node scripts\/production-release-protocols\.js apply-env'/
  );
  assert.match(
    fly,
    /JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE\s*=\s*'tigris-version-purge-v1'/
  );
  assert.match(
    fly,
    /JUMPGATE_PRIVACY_POLICY_URL\s*=\s*'https:\/\/github\.com\/ruizkinio\/Jumpgate-bridge\/blob\/main\/PRIVACY\.md'/
  );
  assert.match(
    fly,
    /JUMPGATE_SECURITY_POLICY_URL\s*=\s*'https:\/\/github\.com\/ruizkinio\/Jumpgate-bridge\/blob\/main\/SECURITY\.md'/
  );
  assert.match(
    fly,
    /JUMPGATE_SUPPORT_POLICY_URL\s*=\s*'https:\/\/github\.com\/ruizkinio\/Jumpgate-bridge\/blob\/main\/SUPPORT\.md'/
  );
  assert.match(fly, /JUMPGATE_SUBTITLE_S3_BUCKET\s*=\s*'jumpgate-bridge-subtitles-live'/);
  assert.match(fly, /min_machines_running\s*=\s*2/);
  assert.match(
    readme,
    /JUMPGATE_POSTGRES_MIGRATION_CEILING=0011_history_http_receipts/
  );
});

test("generation is exclusive and never embeds line-oriented environment injection", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-container-exclusive-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = outputPaths(directory);
  generate(paths);
  assert.throws(() => generate(paths), /EEXIST/);
  assert.throws(
    () => serializeEnvironment({ SAFE: "value\nINJECTED=true" }),
    /invalid environment value/
  );
  assert.throws(() => serializeEnvironment({ unsafe: "value" }), /invalid environment value/);
});

test("redaction removes every generated secret and writes exclusively", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-container-redact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = outputPaths(directory);
  generate(paths);
  const secrets = readSecrets(paths["secret-values"]);
  const input = path.join(directory, "raw.log");
  const output = path.join(directory, "redacted.log");
  fs.writeFileSync(input, "before " + secrets.join(" middle ") + " after\n");
  assert.throws(
    () => audit({ input, "secret-values": paths["secret-values"] }),
    /generated secret found in log/
  );
  redact({ input, output, "secret-values": paths["secret-values"] });
  const redacted = fs.readFileSync(output, "utf8");
  assert.equal(redacted, "before " + new Array(secrets.length).fill("[REDACTED]").join(" middle ") + " after\n");
  assert.equal(secrets.some((value) => redacted.includes(value)), false);
  assert.throws(
    () => redact({ input, output, "secret-values": paths["secret-values"] }),
    /EEXIST/
  );
  audit({ input: output, "secret-values": paths["secret-values"] });
});

test("structured harness proofs are canonical, authenticated, probe-bound, and PUT-safe", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-container-proof-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const probeId = "0123456789abcdef0123456789abcdef";
  const line = (record) => JSON.stringify({ schema: HARNESS_LOG_SCHEMA, ...record });
  const publicRecords = [
    line({ event: "ready", probeId, mode: "public" }),
    operationLine(probeId, 1, "HeadBucket"),
    operationLine(probeId, 1, "GetBucketAcl"),
    operationLine(probeId, 1, "GetBucketPolicyStatus", { isPublic: true }),
  ];
  const publicLog = path.join(directory, "public.log");
  fs.writeFileSync(publicLog, publicRecords.join("\n") + "\n");
  assert.doesNotThrow(() =>
    verifyHarnessLog({ input: publicLog, "probe-id": probeId }, "public")
  );
  const cli = spawnSync(process.execPath, [
    path.join(__dirname, "container-smoke-env.js"),
    "verify-public-attestation",
    "--input=" + publicLog,
    "--probe-id=" + probeId,
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /^Public S3 attestation log verified\.\s*$/);

  const assertPublicProofRejected = (name, records) => {
    const filename = path.join(directory, name + ".log");
    fs.writeFileSync(filename, records.join("\n") + "\n");
    assert.throws(
      () => verifyHarnessLog({ input: filename, "probe-id": probeId }, "public"),
      /public attestation proof is invalid/
    );
  };

  await t.test("rejects a same-probe duplicate public-policy record", () => {
    assertPublicProofRejected(
      "same-probe-duplicate-policy",
      publicRecords.concat(publicRecords[3])
    );
  });
  await t.test("rejects reordered public attestation operations", () => {
    assertPublicProofRejected("reordered", [
      publicRecords[0],
      publicRecords[1],
      publicRecords[3],
      publicRecords[2],
    ]);
  });
  await t.test("rejects a missing public attestation operation", () => {
    assertPublicProofRejected("missing", [
      publicRecords[0],
      publicRecords[1],
      publicRecords[3],
    ]);
  });
  await t.test("rejects an extra accepted public operation", () => {
    assertPublicProofRejected(
      "extra-operation",
      publicRecords.concat(
        operationLine(probeId, 1, "HeadObject", {
          objectId: deriveObjectId(probeId, "privacy"),
          versionId: PRIVACY_VERSION_ID,
        })
      )
    );
  });

  const putLog = path.join(directory, "public-put.log");
  fs.writeFileSync(
    putLog,
    publicRecords
      .concat(
        operationLine(probeId, 1, "PutObject", {
          objectId: deriveObjectId(probeId, "privacy"),
          versionId: PRIVACY_VERSION_ID,
        })
      )
      .join("\n") + "\n"
  );
  assert.throws(
    () => verifyHarnessLog({ input: putLog, "probe-id": probeId }, "public"),
    /public attestation proof is invalid/
  );

  const spoofLog = path.join(directory, "spoof.log");
  fs.writeFileSync(
    spoofLog,
    publicRecords[0] +
      "\n" +
      publicRecords[3].replace('"authenticated":true', '"authenticated":false') +
      "\n"
  );
  assert.throws(
    () => verifyHarnessLog({ input: spoofLog, "probe-id": probeId }, "public"),
    /harness operation record is invalid/
  );

  const nonCanonicalLog = path.join(directory, "non-canonical.log");
  fs.writeFileSync(nonCanonicalLog, publicRecords[0] + "\n \n");
  assert.throws(
    () => verifyHarnessLog({ input: nonCanonicalLog, "probe-id": probeId }, "public"),
    /harness log record is invalid/
  );
  const blankLog = path.join(directory, "blank.log");
  fs.writeFileSync(blankLog, publicRecords.join("\n\n") + "\n");
  assert.throws(
    () => verifyHarnessLog({ input: blankLog, "probe-id": probeId }, "public"),
    /harness log framing is invalid/
  );
  const duplicateLog = path.join(directory, "duplicate.log");
  fs.writeFileSync(
    duplicateLog,
    publicRecords
      .slice(0, -1)
      .concat(publicRecords[3].replace('"isPublic":true', '"isPublic":false,"isPublic":true'))
      .join("\n") + "\n"
  );
  assert.throws(
    () => verifyHarnessLog({ input: duplicateLog, "probe-id": probeId }, "public"),
    /harness log record is invalid/
  );
  assert.throws(
    () =>
      verifyHarnessLog(
        { input: publicLog, "probe-id": "ffffffffffffffffffffffffffffffff" },
        "public"
      ),
    /harness log record is invalid/
  );

  const privateRecords = privateProof(probeId);
  const privateLog = path.join(directory, "private.log");
  fs.writeFileSync(privateLog, privateRecords.join("\n") + "\n");
  assert.doesNotThrow(() =>
    verifyHarnessLog({ input: privateLog, "probe-id": probeId }, "private")
  );

  const parsedPrivateRecords = privateRecords.map((record) => JSON.parse(record));
  assert.equal(
    parsedPrivateRecords.filter(
      (record) => record.event === "operation" && record.operation === "PutObject"
    ).length,
    4
  );
  assert.equal(
    parsedPrivateRecords.filter(
      (record) =>
        record.event === "operation" &&
        (record.operation === "ListObjectVersions" || record.operation === "DeleteObject")
    ).length,
    18
  );
  assert.equal(
    parsedPrivateRecords.filter(
      (record) => record.event === "request" && record.reason === "state/replay"
    ).length,
    3
  );

  const assertPrivateProofRejected = (name, records) => {
    const filename = path.join(directory, name + ".log");
    fs.writeFileSync(filename, records.join("\n") + "\n");
    assert.throws(
      () => verifyHarnessLog({ input: filename, "probe-id": probeId }, "private"),
      /private lifecycle proof is invalid/
    );
  };
  const erasureStarts = parsedPrivateRecords
    .map((record, index) =>
      record.event === "operation" &&
      record.operation === "ListObjectVersions" &&
      parsedPrivateRecords[index + 1]?.operation === "ListObjectVersions" &&
      parsedPrivateRecords[index + 2]?.operation === "PutObject"
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  assert.equal(erasureStarts.length, 3);

  await t.test("rejects a malformed post-delete absence record with valid aggregate counts", () => {
    const malformed = [...privateRecords];
    const missingIndex = parsedPrivateRecords.findIndex(
      (record) => record.event === "request" && record.reason === "state/missing"
    );
    const missing = parsedPrivateRecords[missingIndex];
    malformed[missingIndex] = rejectionLine(probeId, 1, "state/replay", {
      objectId: missing.objectId,
    });
    assertPrivateProofRejected("malformed-private-sequence", malformed);
  });

  await t.test("rejects a post-delete witness for the wrong object", () => {
    const missingIndex = parsedPrivateRecords.findIndex(
      (record) => record.event === "request" && record.reason === "state/missing"
    );
    const missing = parsedPrivateRecords[missingIndex];
    const wrongObjectId = deriveObjectId(deriveSequenceId(probeId, 1), "unbound");
    const substituted = [...privateRecords];
    substituted[missingIndex] = rejectionLine(probeId, 1, "state/missing", {
      scopeId: missing.scopeId,
      objectId: wrongObjectId,
      versionSelector: "exact",
      requestedVersionId: missing.requestedVersionId,
      versionId: null,
    });
    assertPrivateProofRejected("wrong-erasure-object", substituted);
  });

  await t.test("rejects a post-delete witness for the wrong version", () => {
    const missingIndex = parsedPrivateRecords.findIndex(
      (record) => record.event === "request" && record.reason === "state/missing"
    );
    const missing = parsedPrivateRecords[missingIndex];
    const substituted = [...privateRecords];
    substituted[missingIndex] = rejectionLine(probeId, 1, "state/missing", {
      scopeId: missing.scopeId,
      objectId: missing.objectId,
      versionSelector: "exact",
      requestedVersionId: "jumpgate-ci-erasure-999",
      versionId: null,
    });
    assertPrivateProofRejected("wrong-erasure-version", substituted);
  });

  await t.test("rejects a missing-version response in place of the exact absence witness", () => {
    const substituted = [...privateRecords];
    const missingIndex = parsedPrivateRecords.findIndex(
      (record) => record.event === "request" && record.reason === "state/missing"
    );
    const missing = parsedPrivateRecords[missingIndex];
    substituted[missingIndex] = rejectionLine(probeId, 1, "state/missing-version", {
      scopeId: missing.scopeId,
      objectId: missing.objectId,
      versionSelector: "exact",
      requestedVersionId: missing.requestedVersionId,
    });
    assertPrivateProofRejected("missing-erasure-version", substituted);
  });

  await t.test("rejects reordered operations inside any erasure sequence", () => {
    const reordered = [...privateRecords];
    const start = erasureStarts[1];
    [reordered[start + 3], reordered[start + 4]] = [
      reordered[start + 4],
      reordered[start + 3],
    ];
    assertPrivateProofRejected("reordered-private-sequence", reordered);
  });

  await t.test("rejects version records moved across otherwise complete sequences", () => {
    const crossed = [...privateRecords];
    const [moved] = crossed.splice(erasureStarts[0] + 1, 1);
    crossed.splice(erasureStarts[2], 0, moved);
    assertPrivateProofRejected("crossed-private-sequences", crossed);
  });

  await t.test("rejects reused erasure scope and object identities across health blocks", () => {
    const reused = privateRecords.map((line) => JSON.parse(line));
    const firstPut = reused[erasureStarts[0] + 2];
    const secondSequence = deriveSequenceId(probeId, 2);
    for (const record of reused) {
      if (record.sequenceId !== secondSequence || record.scopeId === null) continue;
      record.scopeId = firstPut.scopeId;
      if (record.objectId !== null) record.objectId = firstPut.objectId;
    }
    assertPrivateProofRejected(
      "reused-erasure-resource-identities",
      reused.map((record) => JSON.stringify(record))
    );
  });

  await t.test("rejects unversioned privacy reads substituted for exact reads", () => {
    const unversioned = privateRecords.map((line) => JSON.parse(line));
    const firstSequence = deriveSequenceId(probeId, 1);
    for (const record of unversioned) {
      if (
        record.sequenceId === firstSequence &&
        record.scopeId === null &&
        new Set(["HeadObject", "GetObject", "GetObjectAcl"]).has(record.operation)
      ) {
        record.versionSelector = "none";
        record.requestedVersionId = null;
      }
    }
    assertPrivateProofRejected(
      "unversioned-privacy-exact-reads",
      unversioned.map((record) => JSON.stringify(record))
    );
  });

  await t.test("rejects scope and object identities swapped across sequences", () => {
    const swapped = privateRecords.map((line) => JSON.parse(line));
    const secondPutIndex = erasureStarts[1] + 2;
    const thirdPutIndex = erasureStarts[2] + 2;
    [swapped[secondPutIndex].scopeId, swapped[thirdPutIndex].scopeId] = [
      swapped[thirdPutIndex].scopeId,
      swapped[secondPutIndex].scopeId,
    ];
    [swapped[secondPutIndex].objectId, swapped[thirdPutIndex].objectId] = [
      swapped[thirdPutIndex].objectId,
      swapped[secondPutIndex].objectId,
    ];
    assertPrivateProofRejected(
      "cross-sequence-resource-swap",
      swapped.map((record) => JSON.stringify(record))
    );
  });

  await t.test("rejects same-position records swapped across sequence identities", () => {
    const crossed = [...privateRecords];
    const secondSequence = deriveSequenceId(probeId, 2);
    const thirdSequence = deriveSequenceId(probeId, 3);
    const secondHead = parsedPrivateRecords.findIndex(
      (record) => record.sequenceId === secondSequence && record.operation === "HeadBucket"
    );
    const thirdHead = parsedPrivateRecords.findIndex(
      (record) => record.sequenceId === thirdSequence && record.operation === "HeadBucket"
    );
    [crossed[secondHead], crossed[thirdHead]] = [crossed[thirdHead], crossed[secondHead]];
    assertPrivateProofRejected("same-position-cross-sequence", crossed);
  });

  await t.test("rejects replay of an otherwise complete lifecycle block", () => {
    const fourthSequence = deriveSequenceId(probeId, 4);
    const replayedBlock = privateRecords.filter(
      (record) => JSON.parse(record).sequenceId === fourthSequence
    );
    assert.equal(replayedBlock.length, privacyProof(probeId, 4, false).length);
    assertPrivateProofRejected("whole-block-replay", privateRecords.concat(replayedBlock));
  });

  await t.test("rejects a truncated additional privacy replay", () => {
    assertPrivateProofRejected("truncated-private-replay", privateRecords.slice(0, -1));
  });

  await t.test("requires at least three complete privacy replay proofs", () => {
    const replayLength = privacyProof(probeId, 4, false).length;
    assertPrivateProofRejected(
      "missing-third-private-replay",
      privateRecords.slice(0, -replayLength)
    );
  });

  await t.test("accepts additional complete privacy replay proofs", () => {
    const extended = privateRecords.concat(privacyProof(probeId, 5, false));
    const filename = path.join(directory, "additional-private-replay.log");
    fs.writeFileSync(filename, extended.join("\n") + "\n");
    assert.doesNotThrow(() =>
      verifyHarnessLog({ input: filename, "probe-id": probeId }, "private")
    );
  });
});

test("argument parsing and CLI reject ambiguity without reflecting secret file contents", (t) => {
  assert.deepEqual(parseArguments(["generate", "--runtime-env=C:\\safe"]), {
    command: "generate",
    values: Object.assign(Object.create(null), { "runtime-env": "C:\\safe" }),
  });
  assert.throws(() => parseArguments([]), /missing command/);
  assert.throws(
    () => parseArguments(["generate", "--runtime-env=a", "--runtime-env=b"]),
    /invalid argument/
  );
  assert.throws(() => parseArguments(["generate", "--bad"]), /invalid argument/);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-container-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secretValue = "never-reflect-this-secret-value";
  const secretFile = path.join(directory, "secrets.txt");
  fs.writeFileSync(secretFile, secretValue + "\n");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "container-smoke-env.js"),
    "redact",
    "--input=" + path.join(directory, "missing.log"),
    "--output=" + path.join(directory, "output.log"),
    "--secret-values=" + secretFile,
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.includes(secretValue), false);
  assert.equal(result.stderr.includes(secretValue), false);
});

test("deterministic construction rejects a broken random source", () => {
  assert.throws(
    () => createFiles({}, { randomBytes: (length) => Buffer.alloc(Math.max(0, length - 1)) }),
    /random source is invalid/
  );
});
