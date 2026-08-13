"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { OpaqueObjectKeyFactory } = require("../../lib/storage/object-store");
const { SUBTITLE_ERASURE_CANARY_NAMESPACE } = require("../../lib/storage/factory");
const { deriveObjectId, deriveSequenceId } = require("./s3-protocol-harness");

const BUCKET = "jumpgate-ci-subtitles";
const ENDPOINT = "https://fly.storage.tigris.dev";
const OBJECT_KEY_ID = "ci-stable";
const HARNESS_LOG_SCHEMA = "jumpgate-s3-harness-v2";
const HARNESS_OPERATIONS = Object.freeze([
  "HeadBucket",
  "GetBucketAcl",
  "GetBucketPolicyStatus",
  "PutObject",
  "HeadObject",
  "GetObject",
  "GetObjectAcl",
  "ListObjectVersions",
  "DeleteObject",
]);
const PUBLIC_ATTESTATION_SEQUENCE = Object.freeze([
  { operation: "HeadBucket", versionSelector: "none" },
  { operation: "GetBucketPolicyStatus", isPublic: true, versionSelector: "none" },
]);
const PRIVATE_PRIVACY_PREFIX = Object.freeze([
  { operation: "HeadBucket", versionSelector: "none" },
  { operation: "GetBucketPolicyStatus", isPublic: false, versionSelector: "none" },
]);
const PRIVATE_INITIAL_PRIVACY_TAIL = Object.freeze([
  { operation: "PutObject", versionSelector: "none" },
  { operation: "HeadObject", versionSelector: "exact" },
  { operation: "GetObject", versionSelector: "exact" },
  { operation: "GetObjectAcl", versionSelector: "exact" },
]);
const PRIVATE_REPLAY_PRIVACY_TAIL = Object.freeze([
  { operation: "PutObject", reason: "state/replay", versionSelector: "none" },
  { operation: "HeadObject", versionSelector: "none" },
  { operation: "HeadObject", versionSelector: "none" },
  { operation: "HeadObject", versionSelector: "exact" },
  { operation: "GetObject", versionSelector: "exact" },
  { operation: "GetObjectAcl", versionSelector: "exact" },
]);
const PRIVATE_ERASURE_SEQUENCE = Object.freeze([
  { operation: "ListObjectVersions", versionSelector: "none" },
  { operation: "ListObjectVersions", versionSelector: "none" },
  { operation: "PutObject", versionSelector: "none" },
  { operation: "ListObjectVersions", versionSelector: "none" },
  { operation: "DeleteObject", versionSelector: "exact" },
  { operation: "ListObjectVersions", versionSelector: "none" },
  { operation: "HeadObject", reason: "state/missing", versionSelector: "exact" },
  { operation: "ListObjectVersions", versionSelector: "none" },
  { operation: "HeadObject", reason: "state/missing", versionSelector: "exact" },
]);
const PRIVATE_ERASURE_PROOF_COUNT = 3;
const PRIVATE_ACCEPTED_PUT_COUNT = 4;
const PRIVATE_VERSION_OPERATION_COUNT = 18;
const PRIVATE_MIN_PRIVACY_REPLAY_COUNT = 3;
const REQUIRED_GENERATE_ARGUMENTS = Object.freeze([
  "harness-env",
  "postgres-env",
  "runtime-env",
  "secret-values",
]);

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 1) throw new Error("missing command");
  const command = argv[0];
  const values = Object.create(null);
  for (const argument of argv.slice(1)) {
    const match = /^--([a-z][a-z0-9-]*)=(.+)$/.exec(argument);
    if (!match || Object.hasOwn(values, match[1])) throw new Error("invalid argument");
    values[match[1]] = match[2];
  }
  return { command, values };
}

function requireExactArguments(values, required, pathArguments = required) {
  const actual = Object.keys(values).sort();
  const expected = [...required].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error("invalid arguments");
  }
  for (const name of pathArguments) {
    if (!path.isAbsolute(values[name])) throw new Error(name + " must be absolute");
  }
}

function secret(randomBytes = crypto.randomBytes) {
  const value = randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("random source is invalid");
  return value;
}

function assertEnvironmentValue(name, value) {
  if (
    typeof name !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/.test(name) ||
    typeof value !== "string" ||
    value.length === 0 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error("invalid environment value");
  }
}

function serializeEnvironment(values) {
  return (
    Object.entries(values)
      .map(([name, value]) => {
        assertEnvironmentValue(name, value);
        return name + "=" + value;
      })
      .join("\n") + "\n"
  );
}

function createFiles(options, dependencies = {}) {
  const randomBytes = dependencies.randomBytes || crypto.randomBytes;
  const configSecret = secret(randomBytes);
  const tokenPepper = secret(randomBytes);
  const envelopeSecret = secret(randomBytes);
  const objectKeySecret = secret(randomBytes);
  const s3AccessKeyId = "CI" + randomBytes(16).toString("hex").toUpperCase();
  const s3SecretAccessKey = secret(randomBytes);
  const traktClientId = randomBytes(32).toString("hex");
  const traktClientSecret = secret(randomBytes);
  const postgresPassword = secret(randomBytes);
  const probeId = randomBytes(16).toString("hex");
  if (!/^[a-f0-9]{32}$/.test(probeId)) throw new Error("random source is invalid");
  const envelopeKeyring = JSON.stringify([{ id: "ci-primary", key: envelopeSecret }]);
  const objectKeyring = JSON.stringify([{ id: OBJECT_KEY_ID, key: objectKeySecret }]);
  const objectKeyFactory = new OpaqueObjectKeyFactory({
    currentKeyId: OBJECT_KEY_ID,
    keyring: [{ id: OBJECT_KEY_ID, secret: Buffer.from(objectKeySecret, "base64url") }],
    prefix: "subtitles/v1",
  });
  const expectedObjectKey = objectKeyFactory.create(["privacy-readiness-canary-v1"]);
  const erasurePrefixes = objectKeyFactory.namespacePrefixes([
    SUBTITLE_ERASURE_CANARY_NAMESPACE,
  ]);
  if (erasurePrefixes.length !== 1) throw new Error("erasure namespace is invalid");
  const expectedErasurePrefix = erasurePrefixes[0];

  const runtime = {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    PORT: "7515",
    PUBLIC_BASE_URL: "https://jumpgate-ci.invalid",
    JUMPGATE_TRUST_PROXY: "1",
    JUMPGATE_DURABLE_DRIVER: "postgres",
    JUMPGATE_TTL_DRIVER: "redis",
    DATABASE_URL:
      "postgresql://jumpgate:" +
      postgresPassword +
      "@jumpgate-postgres:5432/jumpgate_container_ci",
    REDIS_URL: "redis://jumpgate-redis:6379/0",
    JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
    JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
    JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
    JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE: "v6",
    JUMPGATE_SUBTITLE_S3_BUCKET: BUCKET,
    JUMPGATE_SUBTITLE_S3_REGION: "auto",
    JUMPGATE_SUBTITLE_S3_ENDPOINT: ENDPOINT,
    JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE: "0",
    JUMPGATE_SUBTITLE_S3_PRIVACY_MODE: "tigris-policy-status",
    JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
    JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID: s3AccessKeyId,
    JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY: s3SecretAccessKey,
    JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID: OBJECT_KEY_ID,
    JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING: objectKeyring,
    CONFIG_SECRET: configSecret,
    JUMPGATE_TOKEN_PEPPER: tokenPepper,
    JUMPGATE_ENVELOPE_PRIMARY_KEY_ID: "ci-primary",
    JUMPGATE_ENVELOPE_KEYRING: envelopeKeyring,
    TRAKT_CLIENT_ID: traktClientId,
    TRAKT_CLIENT_SECRET: traktClientSecret,
    NODE_EXTRA_CA_CERTS: "/run/jumpgate-ca/ca.crt",
  };
  const harness = {
    S3_HARNESS_ACCESS_KEY_ID: s3AccessKeyId,
    S3_HARNESS_SECRET_ACCESS_KEY: s3SecretAccessKey,
    S3_HARNESS_REGION: "auto",
    S3_HARNESS_BUCKET: BUCKET,
    S3_HARNESS_EXPECTED_OBJECT_KEY: expectedObjectKey,
    S3_HARNESS_EXPECTED_ERASURE_PREFIX: expectedErasurePrefix,
    S3_HARNESS_PROBE_ID: probeId,
    S3_HARNESS_PUBLIC_ATTESTATION: "0",
    S3_HARNESS_PUBLIC_DELAY_MS: "0",
    S3_HARNESS_TLS_CERT_FILE: "/run/jumpgate-tls/server.crt",
    S3_HARNESS_TLS_KEY_FILE: "/run/jumpgate-tls/server.key",
    S3_HARNESS_PORT: "443",
  };
  const postgres = {
    POSTGRES_DB: "jumpgate_container_ci",
    POSTGRES_USER: "jumpgate",
    POSTGRES_PASSWORD: postgresPassword,
  };
  const secrets = [
    configSecret,
    tokenPepper,
    envelopeSecret,
    objectKeySecret,
    s3AccessKeyId,
    s3SecretAccessKey,
    traktClientId,
    traktClientSecret,
    postgresPassword,
  ];
  return {
    runtime,
    harness,
    postgres,
    secrets,
    expectedErasurePrefix,
    expectedObjectKey,
    probeId,
  };
}

function writeExclusive(filename, contents) {
  fs.writeFileSync(filename, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function generate(values, dependencies = {}) {
  requireExactArguments(values, REQUIRED_GENERATE_ARGUMENTS);
  const generated = createFiles(values, dependencies);
  writeExclusive(values["runtime-env"], serializeEnvironment(generated.runtime));
  writeExclusive(values["harness-env"], serializeEnvironment(generated.harness));
  writeExclusive(values["postgres-env"], serializeEnvironment(generated.postgres));
  writeExclusive(values["secret-values"], generated.secrets.join("\n") + "\n");
  return generated;
}

function readSecrets(filename) {
  const values = fs
    .readFileSync(filename, "utf8")
    .split("\n")
    .filter(Boolean);
  if (
    values.length < 1 ||
    new Set(values).size !== values.length ||
    values.some((value) => value.length < 16 || /[\r\n\0]/.test(value))
  ) {
    throw new Error("secret values file is invalid");
  }
  return values.sort((left, right) => right.length - left.length);
}

function redact(values) {
  requireExactArguments(values, ["input", "output", "secret-values"]);
  const secrets = readSecrets(values["secret-values"]);
  let contents = fs.readFileSync(values.input, "utf8");
  for (const value of secrets) contents = contents.split(value).join("[REDACTED]");
  for (const value of secrets) {
    if (contents.includes(value)) throw new Error("secret remained after redaction");
  }
  writeExclusive(values.output, contents);
}

function audit(values) {
  requireExactArguments(values, ["input", "secret-values"]);
  const contents = fs.readFileSync(values.input, "utf8");
  if (readSecrets(values["secret-values"]).some((value) => contents.includes(value))) {
    throw new Error("generated secret found in log");
  }
}

function exactRecordKeys(record, expected) {
  const actual = Object.keys(record);
  return (
    actual.length === expected.length &&
    actual.every((name, index) => name === expected[index])
  );
}

function validResourceId(value) {
  return /^[a-f0-9]{64}$/.test(value || "");
}

function validHarnessVersionId(value) {
  return /^jumpgate-ci-(?:privacy|erasure)-[1-9][0-9]*$/.test(value || "");
}

function validVersionEvidence(record) {
  if (record.versionSelector === "none") return record.requestedVersionId === null;
  return record.versionSelector === "exact" && validHarnessVersionId(record.requestedVersionId);
}

function readHarnessRecords(filename, probeId) {
  if (!/^[a-f0-9]{32}$/.test(probeId || "")) throw new Error("invalid probe id");
  const contents = fs.readFileSync(filename, "utf8");
  if (!contents.endsWith("\n") || /[\r\0]/.test(contents)) {
    throw new Error("harness log framing is invalid");
  }
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.some((line) => line.length === 0)) {
    throw new Error("harness log framing is invalid");
  }
  return lines.map((line) => {
    let record;
    try {
      record = JSON.parse(line);
    } catch (_error) {
      throw new Error("harness log record is invalid");
    }
    if (
      !record ||
      Array.isArray(record) ||
      JSON.stringify(record) !== line ||
      record.schema !== HARNESS_LOG_SCHEMA ||
      record.probeId !== probeId
    ) {
      throw new Error("harness log record is invalid");
    }
    if (record.event === "ready") {
      if (
        !exactRecordKeys(record, ["schema", "event", "probeId", "mode"]) ||
        !new Set(["private", "public"]).has(record.mode)
      ) {
        throw new Error("harness ready record is invalid");
      }
      return record;
    }
    if (record.event === "operation") {
      const keys = [
        "schema",
        "event",
        "probeId",
        "sequenceId",
        "authenticated",
        "operation",
        "outcome",
        "scopeId",
        "objectId",
        "versionSelector",
        "requestedVersionId",
        "versionId",
        "objectCount",
      ];
      if (record.operation === "GetBucketPolicyStatus") keys.push("isPublic");
      const bucketOperation = new Set([
        "HeadBucket",
        "GetBucketAcl",
        "GetBucketPolicyStatus",
      ]).has(record.operation);
      const objectOperation = new Set([
        "PutObject",
        "HeadObject",
        "GetObject",
        "GetObjectAcl",
        "DeleteObject",
      ]).has(record.operation);
      const validScopeId = validResourceId(record.scopeId);
      const validObjectId = validResourceId(record.objectId);
      const validVersionId = validHarnessVersionId(record.versionId);
      const unversionedOperation = new Set([
        "HeadBucket",
        "GetBucketAcl",
        "GetBucketPolicyStatus",
        "PutObject",
        "ListObjectVersions",
      ]).has(record.operation);
      if (
        !exactRecordKeys(record, keys) ||
        !/^[a-f0-9]{32}$/.test(record.sequenceId || "") ||
        record.authenticated !== true ||
        !HARNESS_OPERATIONS.includes(record.operation) ||
        record.outcome !== "accepted" ||
        !validVersionEvidence(record) ||
        (record.versionSelector === "exact" &&
          record.requestedVersionId !== record.versionId) ||
        (unversionedOperation && record.versionSelector !== "none") ||
        (record.operation === "GetBucketPolicyStatus" &&
          typeof record.isPublic !== "boolean") ||
        (bucketOperation &&
          (record.scopeId !== null ||
            record.objectId !== null ||
            record.versionId !== null ||
            record.objectCount !== null)) ||
        (objectOperation &&
          (!validObjectId ||
            !validVersionId ||
            record.objectCount !== null ||
            (record.scopeId !== null && !validScopeId))) ||
        (new Set(["GetObject", "GetObjectAcl"]).has(record.operation) &&
          record.scopeId !== null) ||
        (record.operation === "DeleteObject" &&
          (!validScopeId || record.versionSelector !== "exact")) ||
        (record.operation === "ListObjectVersions" &&
          (!validScopeId ||
            record.versionSelector !== "none" ||
            !Number.isSafeInteger(record.objectCount) ||
            record.objectCount < 0 ||
            record.objectCount > 4096 ||
            (record.objectCount === 1
              ? !validObjectId || !validVersionId
              : record.objectId !== null || record.versionId !== null)))
      ) {
        throw new Error("harness operation record is invalid");
      }
      return record;
    }
    if (record.event === "request") {
      if (
        !exactRecordKeys(record, [
          "schema",
          "event",
          "probeId",
          "sequenceId",
          "authenticated",
          "operation",
          "outcome",
          "reason",
          "scopeId",
          "objectId",
          "versionSelector",
          "requestedVersionId",
          "versionId",
        ]) ||
        !/^[a-f0-9]{32}$/.test(record.sequenceId || "") ||
        typeof record.authenticated !== "boolean" ||
        (record.operation !== null && !HARNESS_OPERATIONS.includes(record.operation)) ||
        record.outcome !== "rejected" ||
        typeof record.reason !== "string" ||
        !/^[a-z0-9/-]+$/.test(record.reason) ||
        (record.scopeId !== null && !validResourceId(record.scopeId)) ||
        (record.objectId !== null && !validResourceId(record.objectId)) ||
        !validVersionEvidence(record) ||
        (record.versionId !== null && !validHarnessVersionId(record.versionId)) ||
        (new Set(["state/replay", "state/missing"]).has(record.reason) &&
          (record.authenticated !== true ||
            record.operation !==
              (record.reason === "state/replay" ? "PutObject" : "HeadObject") ||
            record.objectId === null ||
            record.versionId !== null ||
            (record.reason === "state/replay" &&
              (record.scopeId !== null ||
                record.versionSelector !== "none" ||
                record.requestedVersionId !== null)) ||
            (record.reason === "state/missing" &&
              (record.scopeId === null ||
                record.versionSelector !== "exact" ||
                !validHarnessVersionId(record.requestedVersionId)))))
      ) {
        throw new Error("harness rejection record is invalid");
      }
      return record;
    }
    throw new Error("harness log event is invalid");
  });
}

function matchesProofStep(record, step, sequenceId, context = {}) {
  if (!record) return false;
  if (record.sequenceId !== sequenceId) return false;
  const stepContext = Object.fromEntries(
    Object.entries(step).filter(([name]) => name !== "operation" && name !== "reason")
  );
  const expectedContext = { ...stepContext, ...context };
  if (!step.reason) {
    if (
      record.event === "operation" &&
      record.authenticated === true &&
      record.outcome === "accepted" &&
      record.operation === step.operation
    ) {
      return Object.entries(expectedContext).every(
        ([name, value]) => record[name] === value
      );
    }
    return false;
  }
  if (
    record.event === "request" &&
    record.authenticated === true &&
    record.outcome === "rejected" &&
    record.reason === step.reason &&
    (!step.operation || record.operation === step.operation)
  ) {
    return Object.entries(expectedContext).every(
      ([name, value]) => record[name] === value
    );
  }
  return false;
}

function consumeProofSequence(records, offset, sequence, sequenceId, context = {}) {
  for (let index = 0; index < sequence.length; index += 1) {
    if (
      !matchesProofStep(
        records[offset + index],
        sequence[index],
        sequenceId,
        context
      )
    ) {
      return -1;
    }
  }
  return offset + sequence.length;
}

function splitSequenceBlocks(records, probeId) {
  const blocks = [];
  const seen = new Set();
  for (const record of records.slice(1)) {
    const current = blocks[blocks.length - 1];
    if (!current || current[0].sequenceId !== record.sequenceId) {
      if (seen.has(record.sequenceId)) return null;
      seen.add(record.sequenceId);
      blocks.push([record]);
    } else {
      current.push(record);
    }
  }
  if (
    blocks.some(
      (block, index) => block[0].sequenceId !== deriveSequenceId(probeId, index + 1)
    )
  ) {
    return null;
  }
  return blocks;
}

function privacyContext(record, probeId) {
  if (
    !record ||
    record.scopeId !== null ||
    record.objectId !== deriveObjectId(probeId, "privacy") ||
    record.versionId !== "jumpgate-ci-privacy-1"
  ) {
    return null;
  }
  return {
    scopeId: null,
    objectId: record.objectId,
    versionId: record.versionId,
  };
}

function verifyErasureSequence(
  block,
  offset,
  sequenceId,
  sequenceOrdinal,
  usedVersions,
  usedScopes,
  usedObjects
) {
  const firstList = block[offset];
  const scopeId = firstList?.scopeId;
  if (!validResourceId(scopeId) || usedScopes.has(scopeId)) return -1;
  const emptyList = {
    scopeId,
    objectCount: 0,
    objectId: null,
    requestedVersionId: null,
    versionId: null,
  };
  if (
    !matchesProofStep(block[offset], PRIVATE_ERASURE_SEQUENCE[0], sequenceId, emptyList) ||
    !matchesProofStep(block[offset + 1], PRIVATE_ERASURE_SEQUENCE[1], sequenceId, emptyList)
  ) {
    return -1;
  }
  const put = block[offset + 2];
  if (
    !matchesProofStep(put, PRIVATE_ERASURE_SEQUENCE[2], sequenceId) ||
    put.scopeId !== scopeId ||
    !validResourceId(put.objectId) ||
    put.versionId !== "jumpgate-ci-erasure-" + sequenceOrdinal ||
    put.requestedVersionId !== null ||
    usedVersions.has(put.versionId) ||
    usedObjects.has(put.objectId)
  ) {
    return -1;
  }
  usedScopes.add(scopeId);
  usedObjects.add(put.objectId);
  usedVersions.add(put.versionId);
  const object = {
    scopeId,
    objectId: put.objectId,
    versionId: put.versionId,
  };
  const populatedList = { ...object, objectCount: 1 };
  if (
    !matchesProofStep(
      block[offset + 3],
      PRIVATE_ERASURE_SEQUENCE[3],
      sequenceId,
      { ...populatedList, requestedVersionId: null }
    ) ||
    !matchesProofStep(block[offset + 4], PRIVATE_ERASURE_SEQUENCE[4], sequenceId, {
      ...object,
      requestedVersionId: put.versionId,
      objectCount: null,
    }) ||
    !matchesProofStep(
      block[offset + 5],
      PRIVATE_ERASURE_SEQUENCE[5],
      sequenceId,
      emptyList
    ) ||
    !matchesProofStep(block[offset + 6], PRIVATE_ERASURE_SEQUENCE[6], sequenceId, {
      ...object,
      requestedVersionId: put.versionId,
      versionId: null,
    }) ||
    !matchesProofStep(
      block[offset + 7],
      PRIVATE_ERASURE_SEQUENCE[7],
      sequenceId,
      emptyList
    ) ||
    !matchesProofStep(block[offset + 8], PRIVATE_ERASURE_SEQUENCE[8], sequenceId, {
      ...object,
      requestedVersionId: put.versionId,
      versionId: null,
    })
  ) {
    return -1;
  }
  return offset + PRIVATE_ERASURE_SEQUENCE.length;
}

function verifyHarnessLog(values, mode) {
  requireExactArguments(values, ["input", "probe-id"], ["input"]);
  const records = readHarnessRecords(values.input, values["probe-id"]);
  const ready = records.filter((record) => record.event === "ready");
  if (ready.length !== 1 || records[0] !== ready[0] || ready[0].mode !== mode) {
    throw new Error("harness ready proof is invalid");
  }
  const acceptedPuts = records.filter(
    (record) =>
      record.event === "operation" &&
      record.outcome === "accepted" &&
      record.operation === "PutObject"
  );
  if (mode === "public") {
    const sequenceId = deriveSequenceId(values["probe-id"], 1);
    const end = consumeProofSequence(
      records,
      1,
      PUBLIC_ATTESTATION_SEQUENCE,
      sequenceId,
      {
        scopeId: null,
        objectId: null,
        requestedVersionId: null,
        versionId: null,
        objectCount: null,
      }
    );
    if (
      acceptedPuts.length !== 0 ||
      end < 0 ||
      end !== records.length
    ) {
      throw new Error("public attestation proof is invalid");
    }
    return;
  }
  const versionOperations = records.filter(
    (record) =>
      record.event === "operation" &&
      record.authenticated === true &&
      record.outcome === "accepted" &&
      (record.operation === "ListObjectVersions" || record.operation === "DeleteObject")
  );
  const blocks = splitSequenceBlocks(records, values["probe-id"]);
  let durablePrivacy = null;
  const usedErasureVersions = new Set();
  const usedErasureScopes = new Set();
  const usedErasureObjects = new Set();
  if (!blocks || blocks.length < PRIVATE_MIN_PRIVACY_REPLAY_COUNT + 1) {
    throw new Error("private lifecycle proof is invalid");
  }
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    const sequenceId = block[0].sequenceId;
    let cursor = consumeProofSequence(
      block,
      0,
      PRIVATE_PRIVACY_PREFIX,
      sequenceId,
      {
        scopeId: null,
        objectId: null,
        requestedVersionId: null,
        versionId: null,
        objectCount: null,
      }
    );
    if (cursor < 0) throw new Error("private lifecycle proof is invalid");

    if (blockIndex === 0) {
      durablePrivacy = privacyContext(block[cursor], values["probe-id"]);
      if (
        !durablePrivacy ||
        !matchesProofStep(
          block[cursor],
          PRIVATE_INITIAL_PRIVACY_TAIL[0],
          sequenceId,
          { ...durablePrivacy, objectCount: null }
        )
      ) {
        throw new Error("private lifecycle proof is invalid");
      }
      cursor += 1;
      cursor = consumeProofSequence(
        block,
        cursor,
        PRIVATE_INITIAL_PRIVACY_TAIL.slice(1),
        sequenceId,
        { ...durablePrivacy, objectCount: null }
      );
    } else {
      if (
        !matchesProofStep(
          block[cursor],
          PRIVATE_REPLAY_PRIVACY_TAIL[0],
          sequenceId,
          {
            scopeId: null,
            objectId: durablePrivacy.objectId,
            requestedVersionId: null,
            versionId: null,
          }
        )
      ) {
        throw new Error("private lifecycle proof is invalid");
      }
      cursor += 1;
      cursor = consumeProofSequence(
        block,
        cursor,
        PRIVATE_REPLAY_PRIVACY_TAIL.slice(1),
        sequenceId,
        { ...durablePrivacy, objectCount: null }
      );
    }
    if (cursor < 0) throw new Error("private lifecycle proof is invalid");

    if (blockIndex < PRIVATE_ERASURE_PROOF_COUNT) {
      cursor = verifyErasureSequence(
        block,
        cursor,
        sequenceId,
        blockIndex + 1,
        usedErasureVersions,
        usedErasureScopes,
        usedErasureObjects
      );
    }
    if (cursor < 0 || cursor !== block.length) {
      throw new Error("private lifecycle proof is invalid");
    }
  }
  const privacyReplayCount = blocks.length - 1;
  const erasureProofCount = usedErasureVersions.size;
  if (
    !durablePrivacy ||
    acceptedPuts.length !== PRIVATE_ACCEPTED_PUT_COUNT ||
    versionOperations.length !== PRIVATE_VERSION_OPERATION_COUNT ||
    privacyReplayCount < PRIVATE_MIN_PRIVACY_REPLAY_COUNT ||
    erasureProofCount !== PRIVATE_ERASURE_PROOF_COUNT ||
    usedErasureScopes.size !== PRIVATE_ERASURE_PROOF_COUNT ||
    usedErasureObjects.size !== PRIVATE_ERASURE_PROOF_COUNT
  ) {
    throw new Error("private lifecycle proof is invalid");
  }
}

function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv);
  if (command === "generate") {
    generate(values);
    console.log("Container smoke environment generated.");
    return;
  }
  if (command === "redact") {
    redact(values);
    console.log("Container smoke log redacted.");
    return;
  }
  if (command === "audit") {
    audit(values);
    console.log("Container smoke log contains no generated secrets.");
    return;
  }
  if (command === "verify-public-attestation") {
    verifyHarnessLog(values, "public");
    console.log("Public S3 attestation log verified.");
    return;
  }
  if (command === "verify-private-lifecycle") {
    verifyHarnessLog(values, "private");
    console.log("Private S3 lifecycle log verified.");
    return;
  }
  throw new Error("unknown command");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Container smoke environment failed: " + error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  BUCKET,
  ENDPOINT,
  OBJECT_KEY_ID,
  HARNESS_LOG_SCHEMA,
  audit,
  createFiles,
  generate,
  main,
  parseArguments,
  readSecrets,
  readHarnessRecords,
  redact,
  serializeEnvironment,
  verifyHarnessLog,
};
