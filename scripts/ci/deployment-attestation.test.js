"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  buildDeploymentAttestation,
  validateFlyStatus,
  validateReceipt,
} = require("./deployment-attestation");
const { desiredStateForPhase, loadDesiredState } = require("./fly-managed-rollout");

const ROOT = path.join(__dirname, "..", "..");
const SCRIPT = path.join(__dirname, "deployment-attestation.js");
const CONFIG = path.join(ROOT, "fly.toml");
const WORKFLOW = path.join(ROOT, ".github/workflows/fly-deploy.yml");
const COMMIT = "a".repeat(40);
const DIGEST = "sha256:" + "b".repeat(64);
const IMAGE = `registry.fly.io/jumpgate-bridge:git-${COMMIT}@${DIGEST}`;
const CONFIG_SHA256 = createHash("sha256").update(fs.readFileSync(CONFIG)).digest("hex");
const INPUTS = Object.freeze({
  bridgeCommit: COMMIT,
  imageDigest: DIGEST,
  workflowRunId: "30384726861",
});
const RELEASE_A = "rel_1234567890abcdef";
const RELEASE_B = "rel_abcdef1234567890";
const MACHINE_A = "0123456789abcd";
const MACHINE_B = "1123456789abcd";
const MACHINE_C = "2123456789abcd";

function desired() {
  return loadDesiredState(CONFIG, "jumpgate-bridge");
}

function machine(id, releaseId = RELEASE_A) {
  const state = desiredStateForPhase(desired(), "v6");
  return {
    id,
    state: "started",
    cordoned: false,
    image_ref: { digest: DIGEST },
    config: {
      image: IMAGE,
      env: { ...state.env, FLY_PROCESS_GROUP: state.processGroup },
      guest: {
        cpu_kind: state.guest.cpuKind,
        cpus: state.guest.cpus,
        memory_mb: state.guest.memoryMb,
      },
      metadata: {
        fly_process_group: state.processGroup,
        fly_release_id: releaseId,
      },
      services: [{
        protocol: "tcp",
        internal_port: state.internalPort,
        min_machines_running: state.minMachinesRunning,
        autostart: true,
        autostop: true,
        ports: [
          { port: 80, handlers: ["http"], force_https: true },
          { port: 443, handlers: ["http", "tls"] },
        ],
        checks: [{
          type: "http",
          method: "GET",
          path: "/health/ready",
          port: state.internalPort,
          grace_period: "15s",
          interval: "30s",
          timeout: "5s",
        }],
      }],
    },
    checks: [{ name: "servicecheck-00-http-7515", status: "passing" }],
  };
}

function machineList() {
  return [machine(MACHINE_A), machine(MACHINE_B)];
}

function receipt() {
  return {
    schemaVersion: 1,
    application: "jumpgate-bridge",
    phase: "v6",
    image: IMAGE,
    machineIds: [MACHINE_A, MACHINE_B],
    releaseId: RELEASE_A,
    intervals: 3,
    protocolVersion: "6",
  };
}

test("builds an exact signed subject from the repeatedly attested and post-smoke fleet", () => {
  const verifiedAt = new Date("2026-07-29T12:34:56.789Z");
  const result = buildDeploymentAttestation(
    machineList(),
    receipt(),
    desired(),
    INPUTS,
    CONFIG_SHA256,
    verifiedAt
  );
  assert.deepEqual(result, {
    schemaVersion: 2,
    bridgeCommit: COMMIT,
    imageDigest: DIGEST,
    workflowRunId: "30384726861",
    workflowId: 320575057,
    application: "jumpgate-bridge",
    releaseId: RELEASE_A,
    machineIds: [MACHINE_A, MACHINE_B],
    managedIntervals: 3,
    writerProtocol: "v6",
    flyConfigSha256: CONFIG_SHA256,
    verifiedAt: "2026-07-29T12:34:56.789Z",
    status: "deployed-and-smoke-tested",
  });
});

test("rejects malformed or drifted managed fleet receipts", async (t) => {
  const cases = [
    ["non-object", () => null],
    ["extra field", (value) => { value.untrusted = true; }],
    ["wrong phase", (value) => { value.phase = "transition"; }],
    ["wrong image", (value) => { value.image = value.image.replace(DIGEST, "sha256:" + "c".repeat(64)); }],
    ["one Machine", (value) => { value.machineIds.pop(); }],
    ["unordered Machines", (value) => { value.machineIds.reverse(); }],
    ["wrong release", (value) => { value.releaseId = "invalid"; }],
    ["too few intervals", (value) => { value.intervals = 2; }],
    ["wrong protocol", (value) => { value.protocolVersion = "5"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const value = receipt();
      const replacement = mutate(value);
      assert.throws(
        () => validateReceipt(replacement === undefined ? value : replacement, INPUTS),
        (error) => error.code === "deployment_attestation_invalid"
      );
    });
  }
});

test("rejects every incomplete, unmanaged, unhealthy, or configuration-drifted fleet", async (t) => {
  const cases = [
    ["one Machine", (value) => value.pop()],
    ["unexpected Machine", (value) => value.push(machine(MACHINE_C))],
    ["stopped Machine", (value) => { value[0].state = "stopped"; }],
    ["cordoned Machine", (value) => { value[0].cordoned = true; }],
    ["wrong environment", (value) => { value[0].config.env.NODE_ENV = "development"; }],
    ["extra environment", (value) => { value[0].config.env.LEGACY = "1"; }],
    ["wrong guest", (value) => { value[0].config.guest.memory_mb = 512; }],
    ["wrong minimum fleet", (value) => { value[0].config.services[0].min_machines_running = 1; }],
    ["wrong service port", (value) => { value[0].config.services[0].ports[1].port = 8443; }],
    ["wrong check identity", (value) => { value[0].checks[0].name = "unrelated"; }],
    ["failing check", (value) => { value[0].checks[0].status = "critical"; }],
    ["wrong digest", (value) => { value[0].image_ref.digest = "sha256:" + "c".repeat(64); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const value = machineList();
      mutate(value);
      assert.throws(
        () => validateFlyStatus(value, receipt(), desired(), INPUTS),
        (error) => error.code === "deployment_attestation_invalid"
      );
    });
  }
});

test("rejects a post-smoke Machine or release replacement", () => {
  const replacedMachine = machineList();
  replacedMachine[1].id = MACHINE_C;
  assert.throws(
    () => validateFlyStatus(replacedMachine, receipt(), desired(), INPUTS),
    /identities differ from the repeatedly attested fleet/
  );

  const replacedRelease = [machine(MACHINE_A, RELEASE_B), machine(MACHINE_B, RELEASE_B)];
  assert.throws(
    () => validateFlyStatus(replacedRelease, receipt(), desired(), INPUTS),
    /release differs from the repeatedly attested fleet/
  );
});

test("CLI writes one canonical subject and refuses to replace it", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jumpgate-deployment-attestation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const statusFile = path.join(directory, "fly-machine-list.json");
  const receiptFile = path.join(directory, "managed-fleet-attestation.json");
  const outputFile = path.join(directory, "deployment-attestation.json");
  fs.writeFileSync(statusFile, JSON.stringify(machineList()));
  fs.writeFileSync(receiptFile, JSON.stringify(receipt()));
  const args = [
    `--status-file=${statusFile}`,
    `--receipt-file=${receiptFile}`,
    "--config=fly.toml",
    `--output=${outputFile}`,
    `--bridge-commit=${COMMIT}`,
    `--image-digest=${DIGEST}`,
    `--workflow-run-id=${INPUTS.workflowRunId}`,
  ];

  const first = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "");
  assert.deepEqual(
    fs.readdirSync(directory).sort(),
    ["deployment-attestation.json", "fly-machine-list.json", "managed-fleet-attestation.json"]
  );
  const written = JSON.parse(fs.readFileSync(outputFile, "utf8"));
  assert.equal(written.releaseId, RELEASE_A);
  assert.deepEqual(written.machineIds, [MACHINE_A, MACHINE_B]);
  assert.equal(written.flyConfigSha256, CONFIG_SHA256);

  const second = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /could not be created exclusively/);
});

test("workflow uses the complete Machine list and isolates OIDC signing", () => {
  const workflow = fs.readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");
  const repeatedIndex = workflow.indexOf("      - name: Attest the exact final v6 fleet across repeated intervals\n");
  const smokeIndex = workflow.indexOf(
    "      - name: Validate exact public production provenance without logging bodies\n"
  );
  const deriveIndex = workflow.indexOf("      - name: Derive attestation from the final exact Fly state\n");
  const signerIndex = workflow.indexOf("  deployment-provenance:\n");
  assert.equal(
    repeatedIndex >= 0 && smokeIndex > repeatedIndex && deriveIndex > smokeIndex && signerIndex > deriveIndex,
    true
  );
  const deriveBlock = workflow.slice(deriveIndex, signerIndex);
  assert.match(deriveBlock, /"\$FLYCTL_BIN" machine list --app jumpgate-bridge --json/);
  assert.doesNotMatch(deriveBlock, /"\$FLYCTL_BIN" status /);
  assert.match(deriveBlock, /--receipt-file="\$attestation_dir\/managed-fleet-attestation\.json"/);
  assert.match(deriveBlock, /--config=fly\.toml/);

  const deployBlock = workflow.slice(workflow.indexOf("  deploy:\n"), signerIndex);
  assert.doesNotMatch(deployBlock, /id-token: write/);
  assert.doesNotMatch(deployBlock, /attestations: write/);
  const signerBlock = workflow.slice(signerIndex);
  assert.match(signerBlock, /    permissions:\n      attestations: write\n      contents: read\n      id-token: write\n/);
  assert.equal((signerBlock.match(/^      - name:/gm) || []).length, 2);
  assert.match(signerBlock, /uses: actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(signerBlock, /uses: actions\/attest-build-provenance@96278af6caaf10aea03fd8d33a09a777ca52d62f/);
});
