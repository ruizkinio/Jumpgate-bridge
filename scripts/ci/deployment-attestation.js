"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  desiredStateForPhase,
  loadDesiredState,
  validateFleetSnapshot,
} = require("./fly-managed-rollout");

const APPLICATION = "jumpgate-bridge";
const WORKFLOW_ID = 320575057;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RELEASE_PATTERN = /^rel_[a-z0-9]{10,64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MACHINE_ID_PATTERN = /^[a-f0-9]{14}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ARGUMENT_NAMES = new Set([
  "status-file",
  "receipt-file",
  "config",
  "output",
  "bridge-commit",
  "image-digest",
  "workflow-run-id",
]);

function fail(message) {
  const error = new Error(message);
  error.code = "deployment_attestation_invalid";
  throw error;
}

function requireCondition(condition, message) {
  if (!condition) fail(message);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateInputs({ bridgeCommit, imageDigest, workflowRunId }) {
  requireCondition(
    typeof bridgeCommit === "string" && COMMIT_PATTERN.test(bridgeCommit),
    "Bridge commit is invalid"
  );
  requireCondition(
    typeof imageDigest === "string" && DIGEST_PATTERN.test(imageDigest),
    "image digest is invalid"
  );
  requireCondition(
    typeof workflowRunId === "string" && RUN_ID_PATTERN.test(workflowRunId),
    "workflow run id is invalid"
  );
}

function expectedImage(inputs) {
  return `registry.fly.io/${APPLICATION}:git-${inputs.bridgeCommit}@${inputs.imageDigest}`;
}

function validateReceipt(receipt, inputs) {
  requireCondition(isRecord(receipt), "managed fleet receipt is invalid");
  requireCondition(
    JSON.stringify(Object.keys(receipt)) === JSON.stringify([
      "schemaVersion",
      "application",
      "phase",
      "image",
      "machineIds",
      "releaseId",
      "intervals",
      "protocolVersion",
    ]),
    "managed fleet receipt shape is invalid"
  );
  requireCondition(receipt.schemaVersion === 1, "managed fleet receipt schema differs");
  requireCondition(receipt.application === APPLICATION, "managed fleet application differs");
  requireCondition(receipt.phase === "v6", "managed fleet phase differs");
  requireCondition(receipt.image === expectedImage(inputs), "managed fleet image differs");
  requireCondition(
    Array.isArray(receipt.machineIds) && receipt.machineIds.length === 2,
    "managed fleet Machine ids are invalid"
  );
  const machineIds = receipt.machineIds.map((machineId) => {
    requireCondition(
      typeof machineId === "string" && MACHINE_ID_PATTERN.test(machineId),
      "managed fleet Machine id is invalid"
    );
    return machineId;
  });
  requireCondition(new Set(machineIds).size === 2, "managed fleet Machine ids are duplicated");
  requireCondition(
    JSON.stringify(machineIds) === JSON.stringify([...machineIds].sort()),
    "managed fleet Machine ids are not canonical"
  );
  requireCondition(
    typeof receipt.releaseId === "string" && RELEASE_PATTERN.test(receipt.releaseId),
    "managed fleet release id is invalid"
  );
  requireCondition(
    Number.isSafeInteger(receipt.intervals) && receipt.intervals >= 3 && receipt.intervals <= 12,
    "managed fleet interval count is invalid"
  );
  requireCondition(receipt.protocolVersion === "6", "managed fleet writer protocol differs");
  return Object.freeze({
    machineIds: Object.freeze(machineIds),
    releaseId: receipt.releaseId,
    intervals: receipt.intervals,
  });
}

function validateFlyStatus(machineList, receipt, desired, inputs) {
  validateInputs(inputs);
  const sealed = validateReceipt(receipt, inputs);
  let current;
  try {
    current = validateFleetSnapshot(
      machineList,
      desiredStateForPhase(desired, "v6"),
      expectedImage(inputs)
    );
  } catch (error) {
    fail(typeof error?.message === "string" ? error.message : "Fly fleet is invalid");
  }
  requireCondition(
    JSON.stringify(current.machineIds) === JSON.stringify(sealed.machineIds),
    "Fly Machine identities differ from the repeatedly attested fleet"
  );
  requireCondition(
    current.releaseId === sealed.releaseId,
    "Fly release differs from the repeatedly attested fleet"
  );
  return Object.freeze({
    machineIds: current.machineIds,
    releaseId: current.releaseId,
    intervals: sealed.intervals,
  });
}

function buildDeploymentAttestation(
  machineList,
  receipt,
  desired,
  inputs,
  flyConfigSha256,
  now = new Date()
) {
  requireCondition(
    typeof flyConfigSha256 === "string" && SHA256_PATTERN.test(flyConfigSha256),
    "Fly configuration digest is invalid"
  );
  const verified = validateFlyStatus(machineList, receipt, desired, inputs);
  requireCondition(now instanceof Date && Number.isFinite(now.getTime()), "verification time is invalid");
  return Object.freeze({
    schemaVersion: 2,
    bridgeCommit: inputs.bridgeCommit,
    imageDigest: inputs.imageDigest,
    workflowRunId: inputs.workflowRunId,
    workflowId: WORKFLOW_ID,
    application: APPLICATION,
    releaseId: verified.releaseId,
    machineIds: verified.machineIds,
    managedIntervals: verified.intervals,
    writerProtocol: "v6",
    flyConfigSha256,
    verifiedAt: now.toISOString(),
    status: "deployed-and-smoke-tested",
  });
}

function parseArguments(args) {
  const values = new Map();
  for (const argument of args) {
    requireCondition(typeof argument === "string" && argument.startsWith("--"), "argument is invalid");
    const separator = argument.indexOf("=");
    requireCondition(separator > 2, "argument is invalid");
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    requireCondition(ARGUMENT_NAMES.has(name) && value.length > 0, "argument is invalid");
    requireCondition(!values.has(name), "argument is duplicated");
    values.set(name, value);
  }
  requireCondition(values.size === ARGUMENT_NAMES.size, "required argument is missing");
  return Object.freeze(Object.fromEntries(values));
}

function readStableRegularFile(filename, expectedBasename) {
  requireCondition(path.basename(filename) === expectedBasename, expectedBasename + " path is invalid");
  let descriptor = null;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const materialized = fs.lstatSync(filename, { bigint: true });
    requireCondition(
      opened.isFile() &&
        materialized.isFile() &&
        !materialized.isSymbolicLink() &&
        opened.dev === materialized.dev &&
        opened.ino === materialized.ino,
      expectedBasename + " is not a stable regular file"
    );
    const bytes = fs.readFileSync(descriptor);
    requireCondition(
      bytes.length > 0 && bytes.length <= MAX_DOCUMENT_BYTES && !bytes.includes(0),
      expectedBasename + " size is invalid"
    );
    return bytes;
  } catch (error) {
    if (error?.code === "deployment_attestation_invalid") throw error;
    fail(expectedBasename + " could not be read");
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function parseJsonDocument(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (_error) {
    fail(label + " is invalid JSON");
  }
}

function writeAttestation(filename, attestation) {
  requireCondition(
    path.basename(filename) === "deployment-attestation.json",
    "attestation output filename is invalid"
  );
  let descriptor;
  try {
    descriptor = fs.openSync(filename, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(attestation, null, 2) + "\n", "utf8");
  } catch (_error) {
    fail("attestation output could not be created exclusively");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function main(args = process.argv.slice(2)) {
  const values = parseArguments(args);
  requireCondition(
    path.resolve(values.config) === path.resolve("fly.toml"),
    "Fly configuration path is invalid"
  );
  const inputs = {
    bridgeCommit: values["bridge-commit"],
    imageDigest: values["image-digest"],
    workflowRunId: values["workflow-run-id"],
  };
  const machineBytes = readStableRegularFile(values["status-file"], "fly-machine-list.json");
  const receiptBytes = readStableRegularFile(
    values["receipt-file"],
    "managed-fleet-attestation.json"
  );
  const configBytes = readStableRegularFile(values.config, "fly.toml");
  const machineList = parseJsonDocument(machineBytes, "Fly Machine list");
  const receipt = parseJsonDocument(receiptBytes, "managed fleet receipt");
  const desired = loadDesiredState(values.config, APPLICATION);
  const configDigest = createHash("sha256").update(configBytes).digest("hex");
  const attestation = buildDeploymentAttestation(
    machineList,
    receipt,
    desired,
    inputs,
    configDigest
  );
  writeAttestation(values.output, attestation);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Deployment attestation failed: " + (error?.message || "internal error"));
    process.exitCode = 1;
  }
}

module.exports = {
  APPLICATION,
  buildDeploymentAttestation,
  main,
  validateFlyStatus,
  validateReceipt,
  WORKFLOW_ID,
};
