"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  assertProtocolBoundary,
  assertDeployable,
  attestRepeatedly,
  CANDIDATE_PROTOCOL_STATUS_COMMAND,
  desiredStateForPhase,
  loadDesiredState,
  parseCandidateProtocolStatusOutput,
  planWriterProtocolRollout,
  PROTOCOL_STATUS_MARKER,
  readCandidateWriterProtocolStatus,
  validateFleetSample,
} = require("./fly-managed-rollout");

const ROOT = path.join(__dirname, "..", "..");
const CONFIG = path.join(ROOT, "fly.toml");
const IMAGE =
  "registry.fly.io/jumpgate-bridge:git-" + "a".repeat(40) + "@sha256:" + "b".repeat(64);
const DIGEST = "sha256:" + "b".repeat(64);

function protocolStatus(state, version) {
  return {
    action: "status",
    changed: false,
    state,
    version,
  };
}

function machine(id, desired, overrides = {}) {
  const value = {
    id,
    state: "started",
    cordoned: false,
    config: {
      image: IMAGE,
      env: { ...desired.env },
      guest: {
        cpu_kind: desired.guest.cpuKind,
        cpus: desired.guest.cpus,
        memory_mb: desired.guest.memoryMb,
      },
      metadata: { fly_process_group: "app" },
      services: [{
        protocol: "tcp",
        internal_port: 7515,
        min_machines_running: 2,
        autostart: true,
        autostop: "stop",
        ports: [
          { port: 80, handlers: ["http"], force_https: true },
          { port: 443, handlers: ["tls", "http"] },
        ],
        checks: [{
          type: "http",
          method: "GET",
          path: "/health/ready",
          port: 7515,
          grace_period: "15s",
          interval: "30s",
          timeout: "5s",
        }],
      }],
    },
    image_ref: { digest: DIGEST },
    checks: [{ name: "servicecheck-00-http-7515", status: "passing" }],
  };
  return { ...value, ...overrides };
}

test("checked-in desired state is exact and deployable after live storage attestation", () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  assert.equal(desired.env.JUMPGATE_PROVIDER_MUTATION_MODE, "fenced");
  assert.equal(desired.env.JUMPGATE_POSTGRES_MIGRATION_CEILING,
    "0011_history_http_receipts");
  assert.equal(desired.env.JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION, "4");
  assert.equal(desired.env.JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE, "v6");
  assert.equal(
    desired.releaseCommand,
    "node scripts/production-release-protocols.js apply-env"
  );
  assert.equal(desired.minMachinesRunning, 2);
  assert.equal(desired.permanentErasureMode, "tigris-version-purge-v1");
  assert.equal(assertDeployable(desired), desired);

  const blocked = {
    ...desired,
    env: {
      ...desired.env,
      JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE:
        "blocked-tigris-provider-confirmation-required",
    },
    permanentErasureMode: "blocked-tigris-provider-confirmation-required",
  };
  assert.throws(
    () => assertDeployable(blocked),
    (error) => error.code === "subtitle_permanent_erasure_unverifiable"
  );
});

test("fleet attestation requires two exact healthy serving Machines", () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const sample = [machine("machine-a", desired), machine("machine-b", desired)];
  assert.deepEqual(validateFleetSample(sample, desired, IMAGE), ["machine-a", "machine-b"]);
  assert.throws(
    () => validateFleetSample(sample.slice(0, 1), desired, IMAGE),
    /exactly two serving app Machines/
  );
  assert.throws(
    () => validateFleetSample([...sample, machine("machine-c", desired)], desired, IMAGE),
    /exactly two serving app Machines/
  );
  assert.throws(
    () => validateFleetSample([
      ...sample,
      machine("machine-c", desired, { state: "stopped" }),
    ], desired, IMAGE),
    /non-serving extra Machine/
  );
  const foreignService = machine("machine-c", desired);
  foreignService.config.metadata.fly_process_group = "worker";
  assert.throws(
    () => validateFleetSample([...sample, foreignService], desired, IMAGE),
    /outside the managed app process group/
  );
  const unknownProcess = machine("machine-c", desired);
  delete unknownProcess.config.metadata.fly_process_group;
  unknownProcess.config.services = [];
  assert.throws(
    () => validateFleetSample([...sample, unknownProcess], desired, IMAGE),
    /unexpected Machine process group/
  );
  const serviceLessApp = machine("machine-c", desired);
  serviceLessApp.config.services = [];
  assert.throws(
    () => validateFleetSample([...sample, serviceLessApp], desired, IMAGE),
    /without the managed service/
  );
  assert.deepEqual(
    validateFleetSample([
      ...sample,
      { id: "release-command", state: "destroyed" },
    ], desired, IMAGE),
    ["machine-a", "machine-b"]
  );
  assert.throws(
    () => validateFleetSample([
      machine("machine-a", desired),
      machine("machine-b", desired, { image_ref: { digest: "sha256:" + "c".repeat(64) } }),
    ], desired, IMAGE),
    /immutable image digest/
  );
  assert.throws(
    () => validateFleetSample([
      machine("machine-a", desired),
      machine("machine-b", desired, { checks: [{ name: "servicecheck-00-http-7515", status: "critical" }] }),
    ], desired, IMAGE),
    /service check/
  );
  const extraEnv = machine("machine-b", desired);
  extraEnv.config.env.LEGACY_ENV = "must-not-survive-managed-deploy";
  assert.throws(
    () => validateFleetSample([machine("machine-a", desired), extraEnv], desired, IMAGE),
    /outside checked-in Fly configuration/
  );
  const wrongGuest = machine("machine-b", desired);
  wrongGuest.config.guest.memory_mb = 512;
  assert.throws(
    () => validateFleetSample([machine("machine-a", desired), wrongGuest], desired, IMAGE),
    /Machine memory/
  );
  const legacyLifecycle = machine("machine-b", desired);
  legacyLifecycle.config.services[0].autostop = true;
  assert.throws(
    () => validateFleetSample([machine("machine-a", desired), legacyLifecycle], desired, IMAGE),
    /auto-stop policy/
  );
  const wrongHandlers = machine("machine-b", desired);
  wrongHandlers.config.services[0].ports[1].handlers = ["http"];
  assert.throws(
    () => validateFleetSample([machine("machine-a", desired), wrongHandlers], desired, IMAGE),
    /public ports/
  );
  const weakCheck = machine("machine-b", desired);
  weakCheck.config.services[0].checks[0].interval = "60s";
  assert.throws(
    () => validateFleetSample([machine("machine-a", desired), weakCheck], desired, IMAGE),
    /check interval/
  );
});

test("phase-specific attestation cannot confuse transition and final v6 fleets", () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const transition = desiredStateForPhase(desired, "transition");
  const final = desiredStateForPhase(desired, "v6");
  const transitionSample = [machine("machine-a", transition), machine("machine-b", transition)];
  const finalSample = [machine("machine-a", final), machine("machine-b", final)];

  assert.deepEqual(
    validateFleetSample(transitionSample, transition, IMAGE),
    ["machine-a", "machine-b"]
  );
  assert.deepEqual(validateFleetSample(finalSample, final, IMAGE), ["machine-a", "machine-b"]);
  assert.throws(
    () => validateFleetSample(transitionSample, final, IMAGE),
    /does not match checked-in desired state/
  );
  assert.throws(
    () => validateFleetSample(finalSample, transition, IMAGE),
    /does not match checked-in desired state/
  );
  assert.throws(
    () => desiredStateForPhase(desired, "legacy"),
    (error) => error.code === "fly_arguments_invalid"
  );
});

test("managed attestation samples service and external readiness across intervals", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  let samples = 0;
  let probes = 0;
  let protocolProbes = 0;
  let sleeps = 0;
  const result = await attestRepeatedly({
    desired,
    phase: "v6",
    image: IMAGE,
    intervals: 3,
    delayMs: 1,
    sample: async () => {
      samples += 1;
      return [machine("machine-a", desired), machine("machine-b", desired)];
    },
    externalProbe: async () => {
      probes += 1;
    },
    protocolProbe: async (machineId) => {
      protocolProbes += 1;
      assert.equal(machineId, "machine-a");
      return protocolStatus("ready", "6");
    },
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.deepEqual(result.machineIds, ["machine-a", "machine-b"]);
  assert.equal(result.intervals, 3);
  assert.equal(result.phase, "v6");
  assert.equal(result.protocolVersion, "6");
  assert.equal(samples, 3);
  assert.equal(probes, 3);
  assert.equal(protocolProbes, 3);
  assert.equal(sleeps, 2);
});

test("attestation requires the exact Redis protocol at each rollout boundary", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  assert.deepEqual(
    assertProtocolBoundary(protocolStatus("ready", "5"), "transition"),
    protocolStatus("ready", "5")
  );
  assert.deepEqual(
    assertProtocolBoundary(protocolStatus("ready", "6"), "v6"),
    protocolStatus("ready", "6")
  );
  assert.throws(
    () => assertProtocolBoundary(protocolStatus("ready", "6"), "transition"),
    (error) => error.code === "fly_protocol_boundary_invalid"
  );
  assert.throws(
    () => assertProtocolBoundary(protocolStatus("ready", "5"), "v6"),
    (error) => error.code === "fly_protocol_boundary_invalid"
  );

  await assert.rejects(
    attestRepeatedly({
      desired,
      phase: "transition",
      image: IMAGE,
      intervals: 3,
      delayMs: 0,
      sample: async () => {
        const transition = desiredStateForPhase(desired, "transition");
        return [machine("machine-a", transition), machine("machine-b", transition)];
      },
      externalProbe: async () => {},
      protocolProbe: async () => protocolStatus("ready", "6"),
      sleep: async () => {},
    }),
    (error) => error.code === "fly_protocol_boundary_invalid"
  );
});

test("first rollout, v5 retry, and v6 steady state choose only safe phase orderings", () => {
  const first = planWriterProtocolRollout(protocolStatus("missing", null));
  assert.equal(first.observedProtocol, "missing");
  assert.equal(first.transitionRequired, true);
  assert.deepEqual(first.phases, ["transition", "v6"]);
  assert.equal(first.path, "transition-then-v6");

  const retry = planWriterProtocolRollout(protocolStatus("ready", "5"));
  assert.equal(retry.observedProtocol, "5");
  assert.equal(retry.transitionRequired, true);
  assert.deepEqual(retry.phases, ["transition", "v6"]);

  const steady = planWriterProtocolRollout(protocolStatus("ready", "6"));
  assert.equal(steady.observedProtocol, "6");
  assert.equal(steady.transitionRequired, false);
  assert.deepEqual(steady.phases, ["v6"]);
  assert.equal(steady.path, "v6");

  for (const unsafe of ["malformed", "wrong_type"]) {
    assert.throws(
      () => planWriterProtocolRollout(protocolStatus(unsafe, null)),
      (error) => error.code === "fly_protocol_state_invalid"
    );
  }
});

test("candidate protocol probe is ephemeral, service-free, bounded, and secret-safe", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const redisUrl = "redis://bridge-user:probe-secret@redis.internal:6379/0";
  let invocation;
  const status = await readCandidateWriterProtocolStatus(
    "flyctl-test",
    desired.app,
    IMAGE,
    desired.primaryRegion,
    {
      env: {
        FLY_API_TOKEN: "fly-token",
        NO_COLOR: "0",
        REDIS_URL: redisUrl,
      },
      execFile: async (file, args, options) => {
        invocation = { file, args, options };
        assert.equal(fs.existsSync(path.join(options.cwd, "fly.toml")), false);
        return {
          stdout:
            "Success! A Machine has been successfully launched.\n" +
            PROTOCOL_STATUS_MARKER +
            JSON.stringify(protocolStatus("ready", "6")) +
            "\nMachine destroyed.\n",
          stderr: "",
        };
      },
    }
  );

  assert.deepEqual(status, protocolStatus("ready", "6"));
  assert.equal(invocation.file, "flyctl-test");
  assert.deepEqual(invocation.args.slice(0, 5), [
    "machine",
    "run",
    IMAGE,
    "/bin/sleep",
    "300",
  ]);
  assert.equal(invocation.args.includes("--app"), true);
  assert.equal(invocation.args[invocation.args.indexOf("--app") + 1], desired.app);
  assert.equal(invocation.args.includes("--shell"), true);
  assert.equal(invocation.args.includes("--rm"), true);
  assert.equal(invocation.args.includes("--skip-dns-registration"), true);
  assert.equal(invocation.args[invocation.args.indexOf("--env") + 1], "NO_COLOR=1");
  assert.equal(invocation.args.includes("--config"), false);
  assert.equal(invocation.args.includes("--port"), false);
  assert.equal(
    invocation.args[invocation.args.indexOf("--command") + 1],
    CANDIDATE_PROTOCOL_STATUS_COMMAND
  );
  assert.match(CANDIDATE_PROTOCOL_STATUS_COMMAND, /playback-claim-writer-protocol\.js status/);
  assert.match(CANDIDATE_PROTOCOL_STATUS_COMMAND, /JUMPGATE_WRITER_PROTOCOL_STATUS_JSON=/);
  assert.equal(invocation.options.env.FLY_API_TOKEN, "fly-token");
  assert.equal(invocation.options.env.NO_COLOR, "1");
  assert.equal(Object.hasOwn(invocation.options.env, "REDIS_URL"), false);
  assert.equal(invocation.options.maxBuffer > 0, true);
  assert.equal(invocation.options.timeout > 0, true);
  assert.equal(invocation.options.timeout < 300 * 1000, true);
  assert.notEqual(path.resolve(invocation.options.cwd), ROOT);
  assert.equal(fs.existsSync(invocation.options.cwd), false);
  assert.equal(JSON.stringify(invocation).includes(redisUrl), false);
});

test("candidate command failure and ambiguous or invalid probe output stop rollout", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const secret = "redis://must-not-escape@redis.internal:6379/0";
  let failedCwd;
  await assert.rejects(
    readCandidateWriterProtocolStatus(
      "flyctl-test",
      desired.app,
      IMAGE,
      desired.primaryRegion,
      {
        env: { FLY_API_TOKEN: "fly-token", REDIS_URL: secret },
        execFile: async (_file, _args, options) => {
          failedCwd = options.cwd;
          throw new Error("remote command failed with " + secret);
        },
      }
    ),
    (error) => {
      assert.equal(error.code, "fly_protocol_probe_failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
  assert.equal(fs.existsSync(failedCwd), false);

  const record = PROTOCOL_STATUS_MARKER + JSON.stringify(protocolStatus("ready", "5"));
  for (const [stdout, stderr] of [
    ["no marked record", ""],
    [record + "\n" + record, ""],
    [PROTOCOL_STATUS_MARKER + "not-json", ""],
    [record, PROTOCOL_STATUS_MARKER + JSON.stringify(protocolStatus("ready", "6"))],
  ]) {
    assert.throws(
      () => parseCandidateProtocolStatusOutput(stdout, stderr),
      (error) => error.code === "fly_protocol_status_invalid"
    );
  }
});

test("workflow probes first, conditionally transitions, and always finishes on v6 in order", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "fly-deploy.yml"),
    "utf8");
  const candidatePlan = workflow.indexOf("fly-managed-rollout.js plan");
  const transitionDeploy = workflow.indexOf(
    "--env JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=transition"
  );
  const transitionAttestation = workflow.indexOf("--phase=transition");
  const finalDeploy = workflow.indexOf(
    "--env JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=v6"
  );
  const finalAttestation = workflow.indexOf("--phase=v6");

  assert.match(workflow, /fly-managed-rollout\.js validate/);
  assert.match(workflow, /FLYCTL_VERSION: "0\.4\.69-jumpgate-digest4"/);
  assert.match(
    workflow,
    /FLYCTL_ARCHIVE_URL: https:\/\/github\.com\/ruizkinio\/flyctl\/releases\/download\/jumpgate-flyctl-v0\.4\.69-digest4\/flyctl_0\.4\.69-jumpgate-digest4_Linux_x86_64\.tar\.gz/
  );
  assert.match(
    workflow,
    /FLYCTL_LINUX_X86_64_SHA256: d9f1a798980f50a3091aaad60956b35f3c7a2795677287d5257fac876137da80/
  );
  assert.doesNotMatch(workflow, /github\.com\/superfly\/flyctl\/releases\/download/);
  assert.ok(candidatePlan > -1);
  assert.ok(transitionDeploy > candidatePlan);
  assert.ok(transitionAttestation > transitionDeploy);
  assert.ok(finalDeploy > transitionAttestation);
  assert.ok(finalAttestation > finalDeploy);
  assert.equal(
    (workflow.match(/if: steps\.writer-protocol\.outputs\.transition_required == 'true'/g) || [])
      .length,
    2
  );
  assert.match(
    workflow,
    /fly-managed-rollout\.js plan[\s\S]*--image="\$IMMUTABLE_IMAGE_REF"[\s\S]*>> "\$GITHUB_OUTPUT"/
  );
  assert.equal((workflow.match(/--image "\$IMMUTABLE_IMAGE_REF"/g) || []).length, 2);
  assert.equal((workflow.match(/fly-managed-rollout\.js attest/g) || []).length, 2);
  assert.match(
    workflow,
    /test\/provider-snapshot-recovery-integration\.test\.js\s+test\/playback-claim-writer-protocol-redis\.test\.js/
  );
  assert.doesNotMatch(workflow, /fly-machines-rollout\.js/);
});

test("runtime image exposes the guarded release command without copying scripts", () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /ln -s \.\.\/lib\/storage\/redis\/playback-claim-writer-protocol\.js[\s\S]*\/app\/scripts\/playback-claim-writer-protocol\.js/
  );
  assert.match(
    dockerfile,
    /ln -s \.\.\/lib\/storage\/production-release-protocols\.js[\s\S]*\/app\/scripts\/production-release-protocols\.js/
  );
  assert.doesNotMatch(dockerfile, /COPY[^\n]*scripts/);
});
