"use strict";

const fs = require("node:fs");
const path = require("node:path");

const APPLICATION = "jumpgate-bridge";
const WORKFLOW_ID = 320575057;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RELEASE_PATTERN = /^rel_[a-z0-9]{10,64}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const MACHINE_ID_PATTERN = /^[a-f0-9]{14}$/;
const ARGUMENT_NAMES = new Set([
  "status-file",
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

function validateMachine(machine, expected, machineIds, releaseIds) {
  requireCondition(isRecord(machine), "Fly Machine is invalid");
  requireCondition(
    typeof machine.id === "string" && MACHINE_ID_PATTERN.test(machine.id),
    "Fly Machine id is invalid"
  );
  requireCondition(!machineIds.has(machine.id), "Fly Machine id is duplicated");
  machineIds.add(machine.id);

  requireCondition(machine.state === "started", "Fly Machine is not started");
  requireCondition(machine.host_status === "ok", "Fly Machine host is not healthy");
  requireCondition(machine.cordoned === false, "Fly Machine is cordoned");

  const imageRef = machine.image_ref;
  requireCondition(isRecord(imageRef), "Fly Machine image reference is invalid");
  requireCondition(imageRef.registry === "registry.fly.io", "Fly Machine registry is invalid");
  requireCondition(imageRef.repository === APPLICATION, "Fly Machine repository is invalid");
  requireCondition(imageRef.tag === expected.tag, "Fly Machine commit tag differs");
  requireCondition(imageRef.digest === expected.imageDigest, "Fly Machine image digest differs");
  requireCondition(isRecord(imageRef.labels), "Fly Machine image labels are invalid");
  requireCondition(
    imageRef.labels["org.opencontainers.image.revision"] === expected.bridgeCommit,
    "Fly Machine image revision differs"
  );

  requireCondition(isRecord(machine.config), "Fly Machine config is invalid");
  requireCondition(machine.config.image === expected.image, "Fly Machine immutable image differs");
  const metadata = machine.config.metadata;
  requireCondition(isRecord(metadata), "Fly Machine metadata is invalid");
  requireCondition(metadata.fly_process_group === "app", "Fly Machine process group is invalid");
  requireCondition(
    typeof metadata.fly_release_id === "string" &&
      RELEASE_PATTERN.test(metadata.fly_release_id),
    "Fly Machine release id is invalid"
  );
  releaseIds.add(metadata.fly_release_id);

  requireCondition(
    Array.isArray(machine.checks) && machine.checks.length > 0 && machine.checks.length <= 32,
    "Fly Machine checks are invalid"
  );
  const checkNames = new Set();
  for (const check of machine.checks) {
    requireCondition(
      isRecord(check) && typeof check.name === "string" && check.name.length > 0,
      "Fly Machine check is invalid"
    );
    requireCondition(!checkNames.has(check.name), "Fly Machine check is duplicated");
    checkNames.add(check.name);
    requireCondition(check.status === "passing", "Fly Machine check is not passing");
  }
}

function validateFlyStatus(status, inputs) {
  validateInputs(inputs);
  requireCondition(isRecord(status), "Fly status document is invalid");
  requireCondition(status.Name === APPLICATION, "Fly status application differs");
  requireCondition(status.Deployed === true, "Fly application is not deployed");
  requireCondition(status.Status === "deployed", "Fly application status is not deployed");
  requireCondition(
    Array.isArray(status.Machines) && status.Machines.length > 0 && status.Machines.length <= 64,
    "Fly active Machine set is invalid"
  );

  const expected = {
    ...inputs,
    tag: `git-${inputs.bridgeCommit}`,
    image: `registry.fly.io/${APPLICATION}:git-${inputs.bridgeCommit}@${inputs.imageDigest}`,
  };
  const machineIds = new Set();
  const releaseIds = new Set();
  for (const machine of status.Machines) {
    validateMachine(machine, expected, machineIds, releaseIds);
  }
  requireCondition(releaseIds.size === 1, "Fly active Machines do not share one release id");
  return [...releaseIds][0];
}

function buildDeploymentAttestation(status, inputs, now = new Date()) {
  const releaseId = validateFlyStatus(status, inputs);
  requireCondition(now instanceof Date && Number.isFinite(now.getTime()), "verification time is invalid");
  return Object.freeze({
    schemaVersion: 1,
    bridgeCommit: inputs.bridgeCommit,
    imageDigest: inputs.imageDigest,
    workflowRunId: inputs.workflowRunId,
    workflowId: WORKFLOW_ID,
    application: APPLICATION,
    releaseId,
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

function readStatus(filename) {
  let bytes;
  try {
    bytes = fs.readFileSync(filename);
  } catch (_error) {
    fail("Fly status file could not be read");
  }
  requireCondition(bytes.length > 0 && bytes.length <= MAX_STATUS_BYTES, "Fly status file size is invalid");
  requireCondition(!bytes.includes(0), "Fly status file contains NUL bytes");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (_error) {
    fail("Fly status file is invalid JSON");
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
  const inputs = {
    bridgeCommit: values["bridge-commit"],
    imageDigest: values["image-digest"],
    workflowRunId: values["workflow-run-id"],
  };
  const status = readStatus(values["status-file"]);
  const attestation = buildDeploymentAttestation(status, inputs);
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
  WORKFLOW_ID,
};
