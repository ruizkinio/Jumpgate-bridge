"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  buildDeploymentAttestation,
  validateFlyStatus,
} = require("./deployment-attestation");

const SCRIPT = path.join(__dirname, "deployment-attestation.js");
const WORKFLOW = path.join(__dirname, "../../.github/workflows/fly-deploy.yml");
const COMMIT = "a".repeat(40);
const DIGEST = "sha256:" + "b".repeat(64);
const INPUTS = Object.freeze({
  bridgeCommit: COMMIT,
  imageDigest: DIGEST,
  workflowRunId: "30384726861",
});
const RELEASE_A = "rel_1234567890abcdef";
const RELEASE_B = "rel_abcdef1234567890";

function machine(id, releaseId = RELEASE_A) {
  return {
    id,
    name: "quiet-snow-1234",
    state: "started",
    region: "ams",
    image_ref: {
      registry: "registry.fly.io",
      repository: "jumpgate-bridge",
      tag: `git-${COMMIT}`,
      digest: DIGEST,
      labels: { "org.opencontainers.image.revision": COMMIT },
    },
    config: {
      image: `registry.fly.io/jumpgate-bridge:git-${COMMIT}@${DIGEST}`,
      metadata: {
        fly_process_group: "app",
        fly_release_id: releaseId,
      },
    },
    checks: [{ name: "servicecheck-00-http-7515", status: "passing" }],
    host_status: "ok",
    cordoned: false,
  };
}

function validStatus() {
  return {
    AppURL: "https://jumpgate-bridge.fly.dev/",
    Deployed: true,
    Machines: [machine("0123456789abcd"), machine("1123456789abcd")],
    Name: "jumpgate-bridge",
    Status: "deployed",
  };
}

test("builds the exact release attestation from one healthy immutable Fly release", () => {
  const verifiedAt = new Date("2026-07-29T12:34:56.789Z");
  const result = buildDeploymentAttestation(validStatus(), INPUTS, verifiedAt);
  assert.deepEqual(result, {
    schemaVersion: 1,
    bridgeCommit: COMMIT,
    imageDigest: DIGEST,
    workflowRunId: "30384726861",
    workflowId: 320575057,
    application: "jumpgate-bridge",
    releaseId: RELEASE_A,
    verifiedAt: "2026-07-29T12:34:56.789Z",
    status: "deployed-and-smoke-tested",
  });
  assert.deepEqual(Object.keys(result), [
    "schemaVersion",
    "bridgeCommit",
    "imageDigest",
    "workflowRunId",
    "workflowId",
    "application",
    "releaseId",
    "verifiedAt",
    "status",
  ]);
});

test("rejects malformed or non-passing Fly status documents", async (t) => {
  const cases = [
    ["non-object", () => null],
    ["wrong app", (value) => { value.Name = "other-app"; }],
    ["not deployed", (value) => { value.Deployed = false; }],
    ["wrong app state", (value) => { value.Status = "pending"; }],
    ["no active Machines", (value) => { value.Machines = []; }],
    ["stopped Machine", (value) => { value.Machines[0].state = "stopped"; }],
    ["unhealthy host", (value) => { value.Machines[0].host_status = "unreachable"; }],
    ["cordoned Machine", (value) => { value.Machines[0].cordoned = true; }],
    ["missing checks", (value) => { value.Machines[0].checks = []; }],
    ["failing check", (value) => { value.Machines[0].checks[0].status = "critical"; }],
    ["missing metadata", (value) => { delete value.Machines[0].config.metadata; }],
    ["malformed release", (value) => { value.Machines[0].config.metadata.fly_release_id = "44"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const status = validStatus();
      const replacement = mutate(status);
      assert.throws(
        () => validateFlyStatus(replacement === undefined ? status : replacement, INPUTS),
        (error) => error.code === "deployment_attestation_invalid"
      );
    });
  }
});

test("rejects cross-digest active Machine state", () => {
  const status = validStatus();
  status.Machines[1].image_ref.digest = "sha256:" + "c".repeat(64);
  assert.throws(
    () => validateFlyStatus(status, INPUTS),
    /Fly Machine image digest differs/
  );

  const configDrift = validStatus();
  configDrift.Machines[1].config.image =
    `registry.fly.io/jumpgate-bridge:git-${COMMIT}@sha256:${"c".repeat(64)}`;
  assert.throws(
    () => validateFlyStatus(configDrift, INPUTS),
    /Fly Machine immutable image differs/
  );
});

test("rejects mixed Fly release ids across active Machines", () => {
  const status = validStatus();
  status.Machines[1].config.metadata.fly_release_id = RELEASE_B;
  assert.throws(
    () => validateFlyStatus(status, INPUTS),
    /do not share one release id/
  );
});

test("rejects cross-commit tags, labels, and immutable config", async (t) => {
  const otherCommit = "c".repeat(40);
  const cases = [
    ["tag", (value) => { value.Machines[1].image_ref.tag = `git-${otherCommit}`; }],
    ["revision label", (value) => {
      value.Machines[1].image_ref.labels["org.opencontainers.image.revision"] = otherCommit;
    }],
    ["config image", (value) => {
      value.Machines[1].config.image =
        `registry.fly.io/jumpgate-bridge:git-${otherCommit}@${DIGEST}`;
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const status = validStatus();
      mutate(status);
      assert.throws(
        () => validateFlyStatus(status, INPUTS),
        (error) => error.code === "deployment_attestation_invalid"
      );
    });
  }
});

test("CLI writes one canonical file and refuses to replace it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-deployment-attestation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statusFile = path.join(directory, "status.json");
  const outputFile = path.join(directory, "deployment-attestation.json");
  fs.writeFileSync(statusFile, JSON.stringify(validStatus()));
  const args = [
    `--status-file=${statusFile}`,
    `--output=${outputFile}`,
    `--bridge-commit=${COMMIT}`,
    `--image-digest=${DIGEST}`,
    `--workflow-run-id=${INPUTS.workflowRunId}`,
  ];

  const first = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "");
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    ["deployment-attestation.json", "status.json"]
  );
  const written = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(written.releaseId, RELEASE_A);
  assert.match(written.verifiedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const second = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /could not be created exclusively/);
});

test("workflow derives after the final smoke and uploads only the canonical file", () => {
  const workflow = fs.readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");
  const smokeIndex = workflow.indexOf(
    "      - name: Validate exact public production provenance without logging bodies\n"
  );
  const deriveIndex = workflow.indexOf(
    "      - name: Derive attestation from the final exact Fly state\n"
  );
  const attestIndex = workflow.indexOf(
    "      - name: Sign deployment attestation through GitHub OIDC\n"
  );
  const uploadIndex = workflow.indexOf(
    "      - name: Preserve exact deployment attestation\n"
  );
  assert.equal(
    smokeIndex >= 0 && deriveIndex > smokeIndex && attestIndex > deriveIndex && uploadIndex > attestIndex,
    true
  );

  const deriveBlock = workflow.slice(deriveIndex, uploadIndex);
  assert.match(
    deriveBlock,
    /"\$FLYCTL_BIN" status --app jumpgate-bridge --json > "\$status_file"/
  );
  assert.match(deriveBlock, /--bridge-commit="\$GITHUB_SHA"/);
  assert.match(deriveBlock, /--image-digest="\$IMAGE_DIGEST"/);
  assert.match(deriveBlock, /--workflow-run-id="\$GITHUB_RUN_ID"/);

  const attestBlock = workflow.slice(attestIndex, uploadIndex);
  assert.match(
    attestBlock,
    /uses: actions\/attest-build-provenance@96278af6caaf10aea03fd8d33a09a777ca52d62f/
  );
  assert.match(
    attestBlock,
    /subject-path: \$\{\{ runner\.temp \}\}\/jumpgate-deployment-attestation-\$\{\{ github\.run_id \}\}\/deployment-attestation\.json/
  );
  assert.match(workflow, /    permissions:\n      attestations: write\n      contents: read\n      id-token: write\n/);

  const uploadBlock = workflow.slice(uploadIndex);
  assert.match(
    uploadBlock,
    /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/
  );
  assert.match(
    uploadBlock,
    /name: jumpgate-deployment-attestation-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ github\.sha \}\}/
  );
  assert.match(
    uploadBlock,
    /path: \$\{\{ runner\.temp \}\}\/jumpgate-deployment-attestation-\$\{\{ github\.run_id \}\}\/deployment-attestation\.json/
  );
  assert.match(uploadBlock, /if-no-files-found: error/);
  assert.match(uploadBlock, /retention-days: 35/);
  assert.doesNotMatch(uploadBlock, /path: \|/);
});
