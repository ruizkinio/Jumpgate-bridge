"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  assertProtocolBoundary,
  assertMachineVersion,
  assertDeployable,
  attestRepeatedly,
  CANDIDATE_PROTOCOL_STATUS_COMMAND,
  convergeFleet,
  desiredStateForPhase,
  loadDesiredState,
  loadDesiredStateFromBytes,
  MACHINE_VERSION_COMMAND,
  parseCandidateProtocolStatusOutput,
  planWriterProtocolRollout,
  PROTOCOL_STATUS_MARKER,
  readCandidateWriterProtocolStatus,
  readMachineVersion,
  startMachine,
  validateConvergenceSample,
  validateFleetSample,
  validateFleetSnapshot,
} = require("./fly-managed-rollout");

const ROOT = path.join(__dirname, "..", "..");
const CONFIG = path.join(ROOT, "fly.toml");
const IMAGE =
  "registry.fly.io/jumpgate-bridge:git-" + "a".repeat(40) + "@sha256:" + "b".repeat(64);
const DIGEST = "sha256:" + "b".repeat(64);
const BUILD_SHA = "a".repeat(40);
const PACKAGE_VERSION = require(path.join(ROOT, "package.json")).version;
const MACHINE_A = "0123456789abcd";
const MACHINE_B = "1123456789abcd";
const MACHINE_C = "2123456789abcd";
const RELEASE_A = "rel_1234567890abcdef";
const RELEASE_B = "rel_abcdef1234567890";

function protocolStatus(state, version) {
  return {
    action: "status",
    changed: false,
    state,
    version,
  };
}

function machineVersion(overrides = {}) {
  const [major, minor, patch] = PACKAGE_VERSION.split(".").map(Number);
  return {
    version: PACKAGE_VERSION,
    major,
    minor,
    patch,
    buildSha: BUILD_SHA,
    capabilities: { managementTraktOAuth: "m1-m2-v1" },
    ...overrides,
  };
}

function machine(id, desired, overrides = {}) {
  const value = {
    id,
    state: "started",
    cordoned: false,
    config: {
      image: IMAGE,
      env: { ...desired.env, FLY_PROCESS_GROUP: desired.processGroup },
      guest: {
        cpu_kind: desired.guest.cpuKind,
        cpus: desired.guest.cpus,
        memory_mb: desired.guest.memoryMb,
      },
      init: {},
      metadata: {
        fly_builder_id: "builder-0123456789",
        fly_flyctl_version: "0.4.69-jumpgate-digest4",
        fly_platform_version: "v2",
        fly_process_group: desired.processGroup,
        fly_release_id: RELEASE_A,
        fly_release_version: "42",
      },
      restart: { policy: "on-failure", max_retries: 10 },
      services: [{
        protocol: "tcp",
        internal_port: 7515,
        min_machines_running: 2,
        autostart: true,
        autostop: true,
        force_instance_key: null,
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
  assert.equal(desired.autoStop, "stop");
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

test("canonical Fly-derived environment and runtime stop mapping remain exact", () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const sample = [machine(MACHINE_A, desired), machine(MACHINE_B, desired)];
  for (const candidate of sample) {
    candidate.config.env.PRIMARY_REGION = desired.primaryRegion;
    candidate.config.env.FLY_PROCESS_GROUP = desired.processGroup;
    candidate.config.services[0].autostop = true;
  }
  assert.deepEqual(validateFleetSample(sample, desired, IMAGE), [MACHINE_A, MACHINE_B]);

  const wrongDerived = machine(MACHINE_B, desired);
  wrongDerived.config.env.FLY_PROCESS_GROUP = "worker";
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), wrongDerived], desired, IMAGE),
    /derived process group/
  );

  const missingDerived = machine(MACHINE_B, desired);
  delete missingDerived.config.env.FLY_PROCESS_GROUP;
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), missingDerived], desired, IMAGE),
    /derived process group/
  );

  for (const invalid of [false, "stop", "suspend", "true", "STOP"]) {
    const wrongAutostop = machine(MACHINE_B, desired);
    wrongAutostop.config.services[0].autostop = invalid;
    assert.throws(
      () => validateFleetSample([machine(MACHINE_A, desired), wrongAutostop], desired, IMAGE),
      /auto-stop policy/
    );
  }
});

test("fleet attestation requires two exact healthy serving Machines", () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const sample = [machine(MACHINE_A, desired), machine(MACHINE_B, desired)];
  assert.deepEqual(validateFleetSample(sample, desired, IMAGE), [MACHINE_A, MACHINE_B]);
  assert.deepEqual(validateFleetSnapshot(sample, desired, IMAGE), {
    machineIds: [MACHINE_A, MACHINE_B],
    releaseId: RELEASE_A,
  });
  assert.throws(
    () => validateFleetSample(sample.slice(0, 1), desired, IMAGE),
    /exactly two serving app Machines/
  );
  assert.throws(
    () => validateFleetSample([...sample, machine(MACHINE_C, desired)], desired, IMAGE),
    /exactly two serving app Machines/
  );
  assert.throws(
    () => validateFleetSample([
      ...sample,
      machine(MACHINE_C, desired, { state: "stopped" }),
    ], desired, IMAGE),
    /non-serving extra Machine/
  );
  const foreignService = machine(MACHINE_C, desired);
  foreignService.config.metadata.fly_process_group = "worker";
  assert.throws(
    () => validateFleetSample([...sample, foreignService], desired, IMAGE),
    /process group/
  );
  const unknownProcess = machine(MACHINE_C, desired);
  delete unknownProcess.config.metadata.fly_process_group;
  unknownProcess.config.services = [];
  assert.throws(
    () => validateFleetSample([...sample, unknownProcess], desired, IMAGE),
    /metadata shape/
  );
  const serviceLessApp = machine(MACHINE_C, desired);
  serviceLessApp.config.services = [];
  assert.throws(
    () => validateFleetSample([...sample, serviceLessApp], desired, IMAGE),
    /without the managed service/
  );
  assert.deepEqual(
    validateFleetSample([
      ...sample,
      { id: MACHINE_C, state: "destroyed" },
    ], desired, IMAGE),
    [MACHINE_A, MACHINE_B]
  );
  assert.throws(
    () => validateFleetSample([
      machine(MACHINE_A, desired),
      machine(MACHINE_B, desired, { image_ref: { digest: "sha256:" + "c".repeat(64) } }),
    ], desired, IMAGE),
    /immutable image digest/
  );
  assert.throws(
    () => validateFleetSample([
      machine(MACHINE_A, desired),
      machine(MACHINE_B, desired, { checks: [{ name: "servicecheck-00-http-7515", status: "critical" }] }),
    ], desired, IMAGE),
    /service check/
  );
  const extraEnv = machine(MACHINE_B, desired);
  extraEnv.config.env.LEGACY_ENV = "must-not-survive-managed-deploy";
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), extraEnv], desired, IMAGE),
    /outside checked-in Fly configuration/
  );
  const wrongGuest = machine(MACHINE_B, desired);
  wrongGuest.config.guest.memory_mb = 512;
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), wrongGuest], desired, IMAGE),
    /Machine memory/
  );
  const legacyLifecycle = machine(MACHINE_B, desired);
  legacyLifecycle.config.services[0].autostop = false;
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), legacyLifecycle], desired, IMAGE),
    /auto-stop policy/
  );
  const wrongHandlers = machine(MACHINE_B, desired);
  wrongHandlers.config.services[0].ports[1].handlers = ["http"];
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), wrongHandlers], desired, IMAGE),
    /public ports/
  );
  const weakCheck = machine(MACHINE_B, desired);
  weakCheck.config.services[0].checks[0].interval = "60s";
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), weakCheck], desired, IMAGE),
    /check interval/
  );
  const implicitCheckPort = [machine(MACHINE_A, desired), machine(MACHINE_B, desired)];
  for (const candidate of implicitCheckPort) {
    delete candidate.config.services[0].checks[0].port;
  }
  assert.deepEqual(
    validateFleetSample(implicitCheckPort, desired, IMAGE),
    [MACHINE_A, MACHINE_B]
  );
  const nullCheckPort = machine(MACHINE_B, desired);
  nullCheckPort.config.services[0].checks[0].port = null;
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), nullCheckPort], desired, IMAGE),
    /check port/
  );
  const wrongCheckPort = machine(MACHINE_B, desired);
  wrongCheckPort.config.services[0].checks[0].port = 7516;
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), wrongCheckPort], desired, IMAGE),
    /check port/
  );
  const missingRelease = machine(MACHINE_B, desired);
  delete missingRelease.config.metadata.fly_release_id;
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), missingRelease], desired, IMAGE),
    /metadata shape/
  );
  const mixedRelease = machine(MACHINE_B, desired);
  mixedRelease.config.metadata.fly_release_id = RELEASE_B;
  assert.throws(
    () => validateFleetSample([machine(MACHINE_A, desired), mixedRelease], desired, IMAGE),
    /do not share one release id/
  );

  const configurationMutations = [
    ["command override", (value) => { value.config.cmd = ["/bin/sh", "-c", "evil"]; }],
    ["entrypoint override", (value) => { value.config.entrypoint = ["/tmp/evil"]; }],
    ["injected file", (value) => { value.config.files = [{ guest_path: "/tmp/evil" }]; }],
    ["injected mount", (value) => { value.config.mounts = [{ path: "/data" }]; }],
    ["restart policy drift", (value) => { value.config.restart.policy = "always"; }],
    ["restart retry drift", (value) => { value.config.restart.max_retries = 99; }],
    ["guest executable field", (value) => { value.config.guest.kernel_args = ["init=/evil"]; }],
    ["service executable field", (value) => { value.config.services[0].exec = ["/evil"]; }],
    ["force instance key", (value) => { value.config.services[0].force_instance_key = "shared"; }],
    ["service port field", (value) => { value.config.services[0].ports[0].proxy_proto = "v2"; }],
    ["service check field", (value) => { value.config.services[0].checks[0].headers = {}; }],
  ];
  for (const [name, mutate] of configurationMutations) {
    const candidate = machine(MACHINE_B, desired);
    mutate(candidate);
    assert.throws(
      () => validateFleetSample([machine(MACHINE_A, desired), candidate], desired, IMAGE),
      /shape|restart|force instance/,
      name
    );
  }
});

test("desired state parsing is bound to one captured fly.toml byte sequence", () => {
  const original = fs.readFileSync(CONFIG);
  const desired = loadDesiredStateFromBytes(original, "jumpgate-bridge");
  assert.equal(desired.releaseCommand, "node scripts/production-release-protocols.js apply-env");

  const replacement = Buffer.from(
    original.toString("utf8").replace(
      "node scripts/production-release-protocols.js apply-env",
      "node /tmp/unreviewed-release.js"
    )
  );
  assert.throws(
    () => loadDesiredStateFromBytes(replacement, "jumpgate-bridge"),
    /release command/
  );
  assert.equal(
    loadDesiredStateFromBytes(original, "jumpgate-bridge").releaseCommand,
    desired.releaseCommand
  );

  const source = original.toString("utf8").replace(/\r\n/g, "\n");
  const unreviewedMutations = [
    source.replace("[build]\n", "[build]\n  dockerfile = 'Dockerfile.evil'\n"),
    source.replace("primary_region = 'iad'\n", "primary_region = 'iad'\nkill_signal = 'SIGKILL'\n"),
    source.replace("[env]\n", "[env]\n  NODE_OPTIONS = '--require=/tmp/evil.js'\n"),
    source.replace("[deploy]\n", "[processes]\n  app = 'node /tmp/evil.js'\n\n[deploy]\n"),
    source + "\n[[mounts]]\n  source = 'data'\n  destination = '/data'\n",
  ];
  for (const mutation of unreviewedMutations) {
    assert.throws(
      () => loadDesiredStateFromBytes(Buffer.from(mutation), "jumpgate-bridge"),
      /shape/
    );
  }
});

test("phase-specific attestation cannot confuse transition and final v6 fleets", () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const transition = desiredStateForPhase(desired, "transition");
  const final = desiredStateForPhase(desired, "v6");
  const transitionSample = [machine(MACHINE_A, transition), machine(MACHINE_B, transition)];
  const finalSample = [machine(MACHINE_A, final), machine(MACHINE_B, final)];

  assert.deepEqual(
    validateFleetSample(transitionSample, transition, IMAGE),
    [MACHINE_A, MACHINE_B]
  );
  assert.deepEqual(validateFleetSample(finalSample, final, IMAGE), [MACHINE_A, MACHINE_B]);
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

test("managed attestation probes both Machines and external readiness across intervals", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  let samples = 0;
  let probes = 0;
  const protocolProbes = [];
  const versionProbes = [];
  let sleeps = 0;
  const result = await attestRepeatedly({
    desired,
    phase: "v6",
    image: IMAGE,
    intervals: 3,
    delayMs: 1,
    sample: async () => {
      samples += 1;
      return [machine(MACHINE_A, desired), machine(MACHINE_B, desired)];
    },
    externalProbe: async () => {
      probes += 1;
    },
    protocolProbe: async (machineId) => {
      protocolProbes.push(machineId);
      return protocolStatus("ready", "6");
    },
    versionProbe: async (machineId) => {
      versionProbes.push(machineId);
      return machineVersion();
    },
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.deepEqual(result.machineIds, [MACHINE_A, MACHINE_B]);
  assert.equal(result.intervals, 3);
  assert.equal(result.phase, "v6");
  assert.equal(result.protocolVersion, "6");
  assert.equal(result.releaseId, RELEASE_A);
  assert.equal(samples, 3);
  assert.equal(probes, 3);
  assert.deepEqual(protocolProbes, [
    MACHINE_A, MACHINE_B,
    MACHINE_A, MACHINE_B,
    MACHINE_A, MACHINE_B,
  ]);
  assert.deepEqual(versionProbes, [
    MACHINE_A, MACHINE_B,
    MACHINE_A, MACHINE_B,
    MACHINE_A, MACHINE_B,
  ]);
  assert.equal(sleeps, 2);
});

test("managed attestation rejects a release replacement across stable Machine ids", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  let sampleIndex = 0;
  await assert.rejects(
    attestRepeatedly({
      desired,
      phase: "v6",
      image: IMAGE,
      intervals: 3,
      delayMs: 0,
      sample: async () => {
        sampleIndex += 1;
        const second = machine(MACHINE_B, desired);
        if (sampleIndex > 1) {
          second.config.metadata.fly_release_id = RELEASE_B;
          const first = machine(MACHINE_A, desired);
          first.config.metadata.fly_release_id = RELEASE_B;
          return [first, second];
        }
        return [machine(MACHINE_A, desired), second];
      },
      externalProbe: async () => {},
      protocolProbe: async () => protocolStatus("ready", "6"),
      versionProbe: async () => machineVersion(),
      sleep: async () => {},
    }),
    /release changed during attestation/
  );
});

test("attestation rejects a missing or wrong management capability on either Machine", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const secret = "capability-secret-must-not-escape";
  for (const capability of [undefined, secret]) {
    const probed = [];
    await assert.rejects(
      attestRepeatedly({
        desired,
        phase: "v6",
        image: IMAGE,
        intervals: 3,
        delayMs: 0,
        sample: async () => [machine(MACHINE_A, desired), machine(MACHINE_B, desired)],
        externalProbe: async () => {},
        protocolProbe: async () => protocolStatus("ready", "6"),
        versionProbe: async (machineId) => {
          probed.push(machineId);
          const version = machineVersion();
          if (machineId === MACHINE_B) {
            if (capability === undefined) {
              delete version.capabilities.managementTraktOAuth;
            } else {
              version.capabilities.managementTraktOAuth = capability;
            }
          }
          return version;
        },
        sleep: async () => {},
      }),
      (error) => {
        assert.equal(error.code, "fly_runtime_version_invalid");
        assert.equal(error.message.includes(secret), false);
        return true;
      }
    );
    assert.deepEqual(probed, [MACHINE_A, MACHINE_B]);
  }
});

test("convergence starts only the exact stopped Machine and polls to passing", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const transition = desiredStateForPhase(desired, "transition");
  const stopped = machine(MACHINE_B, transition, { state: "stopped" });
  const warming = machine(MACHINE_B, transition, {
    checks: [{ name: "servicecheck-00-http-7515", status: "warning" }],
  });
  const samples = [
    [machine(MACHINE_A, transition), stopped],
    [machine(MACHINE_A, transition), warming],
    [machine(MACHINE_A, transition), machine(MACHINE_B, transition)],
  ];
  const invocations = [];
  let sleeps = 0;
  const result = await convergeFleet({
    desired,
    phase: "transition",
    image: IMAGE,
    polls: 3,
    delayMs: 1,
    sample: async () => samples.shift(),
    startMachine: (machineId) => startMachine(
      "flyctl-test",
      desired.app,
      machineId,
      {
        execFile: async (file, args, options) => {
          invocations.push({ file, args, options });
          return { stdout: "started", stderr: "" };
        },
      }
    ),
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.deepEqual(result.machineIds, [MACHINE_A, MACHINE_B]);
  assert.deepEqual(result.startedIds, [MACHINE_B]);
  assert.equal(result.phase, "transition");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].file, "flyctl-test");
  assert.deepEqual(invocations[0].args, [
    "machine",
    "start",
    MACHINE_B,
    "--app",
    desired.app,
  ]);
  assert.equal(invocations[0].options.maxBuffer > 0, true);
  assert.equal(invocations[0].options.timeout > 0, true);
  assert.equal(invocations[0].options.timeout <= 60_000, true);
  assert.equal(sleeps, 1);
});

test("already healthy convergence is mutation-free", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const healthy = [machine(MACHINE_A, desired), machine(MACHINE_B, desired)];
  for (const candidate of healthy) {
    candidate.config.env.PRIMARY_REGION = desired.primaryRegion;
    candidate.config.env.FLY_PROCESS_GROUP = desired.processGroup;
  }
  let samples = 0;
  let starts = 0;
  let sleeps = 0;
  const result = await convergeFleet({
    desired,
    phase: "v6",
    image: IMAGE,
    polls: 2,
    delayMs: 0,
    sample: async () => {
      samples += 1;
      return healthy;
    },
    startMachine: async () => {
      starts += 1;
    },
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.deepEqual(result.startedIds, []);
  assert.equal(samples, 1);
  assert.equal(starts, 0);
  assert.equal(sleeps, 0);
  assert.deepEqual(
    validateConvergenceSample(healthy, desired, IMAGE).map((candidate) => candidate.id),
    [MACHINE_A, MACHINE_B]
  );
});

test("convergence rejects ambiguous or drifted candidates before mutation", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const cases = [
    ["extra", (fleet) => fleet.push(machine(MACHINE_C, desired))],
    ["wrong image", (fleet) => { fleet[1].config.image = IMAGE.replace(/b+$/, "c".repeat(64)); }],
    ["wrong digest", (fleet) => { fleet[1].image_ref.digest = "sha256:" + "c".repeat(64); }],
    ["wrong guest config", (fleet) => { fleet[1].config.guest.memory_mb = 512; }],
    ["wrong service config", (fleet) => { fleet[1].config.services[0].checks[0].timeout = "6s"; }],
    ["wrong process", (fleet) => { fleet[1].config.metadata.fly_process_group = "worker"; }],
    ["ambiguous process", (fleet) => { fleet[1].config.metadata.process_group = "worker"; }],
    ["cordoned", (fleet) => { fleet[1].cordoned = true; }],
    ["pending", (fleet) => { fleet[1].state = "pending"; }],
    ["suspended", (fleet) => { fleet[1].state = "suspended"; }],
    ["missing health result", (fleet) => { fleet[1].checks = []; }],
    ["invalid health status", (fleet) => { fleet[1].checks[0].status = "pending"; }],
    ["malformed id", (fleet) => { fleet[1].id = "machine-b"; }],
    ["duplicate id", (fleet) => { fleet[1].id = MACHINE_A; }],
    ["wrong phase", (fleet) => {
      fleet[1].config.env.JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE = "transition";
    }],
  ];

  for (const [name, mutate] of cases) {
    const fleet = [
      machine(MACHINE_A, desired),
      machine(MACHINE_B, desired, { state: "stopped" }),
    ];
    mutate(fleet);
    let starts = 0;
    await assert.rejects(
      convergeFleet({
        desired,
        phase: "v6",
        image: IMAGE,
        polls: 2,
        delayMs: 0,
        sample: async () => fleet,
        startMachine: async () => {
          starts += 1;
        },
        sleep: async () => {},
      }),
      Error,
      name
    );
    assert.equal(starts, 0, name);
  }
});

test("convergence start failure is fail-closed and secret-safe", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const secret = "fly-secret-must-not-escape";
  await assert.rejects(
    convergeFleet({
      desired,
      phase: "v6",
      image: IMAGE,
      polls: 2,
      delayMs: 0,
      sample: async () => [
        machine(MACHINE_A, desired),
        machine(MACHINE_B, desired, { state: "stopped" }),
      ],
      startMachine: (machineId) => startMachine(
        "flyctl-test",
        desired.app,
        machineId,
        { execFile: async () => { throw new Error(secret); } }
      ),
      sleep: async () => {},
    }),
    (error) => {
      assert.equal(error.code, "fly_convergence_start_failed");
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});

test("convergence timeout is bounded without repeated mutation", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  let samples = 0;
  let starts = 0;
  let sleeps = 0;
  await assert.rejects(
    convergeFleet({
      desired,
      phase: "v6",
      image: IMAGE,
      polls: 2,
      delayMs: 1,
      sample: async () => {
        samples += 1;
        return [
          machine(MACHINE_A, desired),
          machine(MACHINE_B, desired, { state: "stopped" }),
        ];
      },
      startMachine: async (machineId) => {
        assert.equal(machineId, MACHINE_B);
        starts += 1;
      },
      sleep: async () => {
        sleeps += 1;
      },
    }),
    (error) => error.code === "fly_convergence_timeout"
  );
  assert.equal(samples, 3);
  assert.equal(starts, 1);
  assert.equal(sleeps, 1);
});

test("identity or configuration drift while polling is not retried", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  for (const drift of ["identity", "digest"]) {
    let samples = 0;
    let starts = 0;
    let sleeps = 0;
    await assert.rejects(
      convergeFleet({
        desired,
        phase: "v6",
        image: IMAGE,
        polls: 3,
        delayMs: 1,
        sample: async () => {
          samples += 1;
          if (samples === 1) {
            return [
              machine(MACHINE_A, desired),
              machine(MACHINE_B, desired, { state: "stopped" }),
            ];
          }
          if (drift === "identity") {
            return [machine(MACHINE_A, desired), machine(MACHINE_C, desired)];
          }
          const changed = machine(MACHINE_B, desired);
          changed.image_ref.digest = "sha256:" + "c".repeat(64);
          return [machine(MACHINE_A, desired), changed];
        },
        startMachine: async () => {
          starts += 1;
        },
        sleep: async () => {
          sleeps += 1;
        },
      }),
      Error,
      drift
    );
    assert.equal(samples, 2, drift);
    assert.equal(starts, 1, drift);
    assert.equal(sleeps, 0, drift);
  }
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
        return [machine(MACHINE_A, transition), machine(MACHINE_B, transition)];
      },
      externalProbe: async () => {},
      protocolProbe: async () => protocolStatus("ready", "6"),
      versionProbe: async () => machineVersion(),
      sleep: async () => {},
    }),
    (error) => error.code === "fly_protocol_boundary_invalid"
  );

  const preSmoke = await attestRepeatedly({
    desired,
    phase: "v6",
    image: IMAGE,
    intervals: 3,
    delayMs: 0,
    sample: async () => [machine(MACHINE_A, desired), machine(MACHINE_B, desired)],
    externalProbe: async () => {},
    protocolProbe: async () => protocolStatus("ready", "6"),
    versionProbe: async () => machineVersion(),
    sleep: async () => {},
  });
  assert.equal(preSmoke.protocolVersion, "6");
  await assert.rejects(
    attestRepeatedly({
      desired,
      phase: "v6",
      image: IMAGE,
      intervals: 3,
      delayMs: 0,
      sample: async () => [machine(MACHINE_A, desired), machine(MACHINE_B, desired)],
      externalProbe: async () => {},
      protocolProbe: async () => protocolStatus("ready", "5"),
      versionProbe: async () => machineVersion(),
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
  assert.equal(
    CANDIDATE_PROTOCOL_STATUS_COMMAND,
    "/bin/sh -lc '" +
      'status="$(node scripts/playback-claim-writer-protocol.js status)" || exit $?; ' +
      'printf "%s\\n" "$status" | ' +
      'sed "s/^/JUMPGATE_WRITER_PROTOCOL_STATUS_JSON=/"' +
      "'"
  );
  assert.match(CANDIDATE_PROTOCOL_STATUS_COMMAND, /^\/bin\/sh -lc '/);
  assert.match(CANDIDATE_PROTOCOL_STATUS_COMMAND, /'$/);
  assert.match(CANDIDATE_PROTOCOL_STATUS_COMMAND, /playback-claim-writer-protocol\.js status/);
  assert.match(CANDIDATE_PROTOCOL_STATUS_COMMAND, /JUMPGATE_WRITER_PROTOCOL_STATUS_JSON=/);
  assert.doesNotMatch(CANDIDATE_PROTOCOL_STATUS_COMMAND, /[\r\n]/);
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

test("Machine runtime version probe is targeted, bounded, exact, and secret-safe", async () => {
  const desired = loadDesiredState(CONFIG, "jumpgate-bridge");
  const redisUrl = "sensitive-runtime-value";
  let invocation;
  const version = await readMachineVersion("flyctl-test", desired.app, MACHINE_B, {
    env: { FLY_API_TOKEN: "fly-token", REDIS_URL: redisUrl },
    execFile: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: JSON.stringify(machineVersion()), stderr: "" };
    },
  });

  assert.deepEqual(assertMachineVersion(version, PACKAGE_VERSION, BUILD_SHA), machineVersion());
  assert.equal(invocation.file, "flyctl-test");
  assert.deepEqual(invocation.args, [
    "ssh",
    "console",
    "--app",
    desired.app,
    "--machine",
    MACHINE_B,
    "--command",
    MACHINE_VERSION_COMMAND,
    "--quiet",
  ]);
  assert.match(MACHINE_VERSION_COMMAND, /127\.0\.0\.1:7515\/version/);
  assert.equal(invocation.options.env.FLY_API_TOKEN, "fly-token");
  assert.equal(Object.hasOwn(invocation.options.env, "REDIS_URL"), false);
  assert.equal(invocation.options.maxBuffer, 16 * 1024);
  assert.equal(invocation.options.timeout > 0, true);
  assert.equal(JSON.stringify(invocation).includes(redisUrl), false);

  await assert.rejects(
    readMachineVersion("flyctl-test", desired.app, MACHINE_B, {
      env: { FLY_API_TOKEN: "fly-token", REDIS_URL: redisUrl },
      execFile: async () => {
        throw new Error("remote command failed with " + redisUrl);
      },
    }),
    (error) => {
      assert.equal(error.code, "fly_runtime_version_probe_failed");
      assert.equal(error.message.includes(redisUrl), false);
      return true;
    }
  );
});

test("workflow probes first, conditionally transitions, and always finishes on v6 in order", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "fly-deploy.yml"),
    "utf8").replace(/\r\n/g, "\n");
  const candidatePlan = workflow.indexOf("fly-managed-rollout.js plan");
  const transitionDeploy = workflow.indexOf(
    "--env JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=transition"
  );
  const transitionConvergence = workflow.indexOf(
    "fly-managed-rollout.js converge",
    transitionDeploy
  );
  const transitionAttestation = workflow.indexOf(
    "fly-managed-rollout.js attest",
    transitionConvergence
  );
  const finalDeploy = workflow.indexOf(
    "--env JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=v6"
  );
  const finalConvergence = workflow.indexOf(
    "fly-managed-rollout.js converge",
    finalDeploy
  );
  const finalAttestation = workflow.indexOf(
    "fly-managed-rollout.js attest",
    finalConvergence
  );
  const publicSmoke = workflow.indexOf(
    "      - name: Validate exact public production provenance without logging bodies\n",
    finalAttestation
  );
  const postSmokeAttestation = workflow.indexOf(
    "fly-managed-rollout.js attest",
    publicSmoke
  );

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
  assert.match(
    workflow,
    /FLYCTL_SOURCE_COMMIT: cc9795507584be17cad4d15af0752195af4c403d/
  );
  assert.match(
    workflow,
    /FLYCTL_LINUX_X86_64_BINARY_SHA256: 70afd975429f8fad178ed2aeab936883d7162a2526311db9746f14e5bf69c783/
  );
  assert.match(workflow, /FLYCTL_BUILD_DATE: "2026-07-19T02:19:27\+02:00"/);
  assert.match(
    workflow,
    /test "\$version_output" = \\\n\s+"flyctl-verified v\$\{FLYCTL_VERSION\} linux\/amd64 Commit: \$\{FLYCTL_SOURCE_COMMIT\} BuildDate: \$\{FLYCTL_BUILD_DATE\}"/
  );
  assert.doesNotMatch(workflow, /grep -F "flyctl v\$\{FLYCTL_VERSION\}/);
  assert.match(workflow, /test "\$\(tar --list --gzip --file "\$archive"\)" = "flyctl"/);
  assert.match(workflow, /\\"Environment\\":\\"production\\"/);
  assert.doesNotMatch(workflow, /github\.com\/superfly\/flyctl\/releases\/download/);
  assert.ok(candidatePlan > -1);
  assert.ok(transitionDeploy > candidatePlan);
  assert.ok(transitionConvergence > transitionDeploy);
  assert.ok(transitionAttestation > transitionConvergence);
  assert.ok(finalDeploy > transitionAttestation);
  assert.ok(finalConvergence > finalDeploy);
  assert.ok(finalAttestation > finalConvergence);
  assert.ok(publicSmoke > finalAttestation);
  assert.ok(postSmokeAttestation > publicSmoke);
  assert.equal(
    (workflow.match(/if: steps\.writer-protocol\.outputs\.transition_required == 'true'/g) || [])
      .length,
    3
  );
  assert.match(
    workflow,
    /fly-managed-rollout\.js plan[\s\S]*--image="\$IMMUTABLE_IMAGE_REF"[\s\S]*>> "\$GITHUB_OUTPUT"/
  );
  assert.equal((workflow.match(/--image "\$IMMUTABLE_IMAGE_REF"/g) || []).length, 2);
  assert.equal((workflow.match(/fly-managed-rollout\.js converge/g) || []).length, 2);
  assert.equal((workflow.match(/fly-managed-rollout\.js attest/g) || []).length, 3);
  assert.equal((workflow.match(/--image="\$IMMUTABLE_IMAGE_REF"/g) || []).length, 6);
  assert.equal((workflow.match(/--phase=transition/g) || []).length, 2);
  assert.equal((workflow.match(/--phase=v6/g) || []).length, 3);
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
