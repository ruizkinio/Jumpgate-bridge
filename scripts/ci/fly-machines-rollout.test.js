"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  EMERGENCY_CODE,
  LEASE_TTL_SECONDS,
  MachinesClient,
  REQUEST_TIMEOUT_MS,
  RolloutFailure,
  SERVER_WAIT_SECONDS,
  healthChecksPass,
  parseImageReference,
  requireReleaseContext,
  runRollout,
} = require("./fly-machines-rollout");

const APP = "jumpgate-bridge";
const BUILD_SHA = "0123456789abcdef".repeat(2) + "01234567";
const DIGEST = "sha256:" + "abcdef0123456789".repeat(4);
const IMAGE = `registry.fly.io/${APP}:git-${BUILD_SHA}@${DIGEST}`;
const OLD_DIGEST = "sha256:" + "1".repeat(64);
const OLD_IMAGE = `registry.fly.io/${APP}:old@${OLD_DIGEST}`;
const TOKEN = "ci-test-token-value";
const DEADLINE_MS = 3 * 60 * 60_000;
const SECRETS_VERSION = 42;

function rolloutMetadata(buildSha = BUILD_SHA) {
  return {
    jumpgate_rollout_owner: "jumpgate-ci-rollout",
    jumpgate_rollout_kind: "canary",
    jumpgate_rollout_build_sha: buildSha,
    jumpgate_rollout_id: `git-${buildSha}`,
  };
}

function isOwnedCanaryFixture(value) {
  const metadata = value.config?.metadata;
  const markerKeys = Object.keys(metadata || {})
    .filter((key) => key.startsWith("jumpgate_rollout_"))
    .sort();
  return (
    JSON.stringify(markerKeys) ===
      JSON.stringify([
        "jumpgate_rollout_build_sha",
        "jumpgate_rollout_id",
        "jumpgate_rollout_kind",
        "jumpgate_rollout_owner",
      ]) &&
    metadata?.jumpgate_rollout_owner === "jumpgate-ci-rollout" &&
    metadata?.jumpgate_rollout_kind === "canary" &&
    /^[a-f0-9]{40}$/.test(metadata?.jumpgate_rollout_build_sha || "") &&
    metadata?.jumpgate_rollout_id === `git-${metadata.jumpgate_rollout_build_sha}`
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function imageRef(image) {
  if (image === IMAGE) {
    return {
      registry: "registry.fly.io",
      repository: APP,
      tag: `git-${BUILD_SHA}`,
      digest: DIGEST,
    };
  }
  return {
    registry: "registry.fly.io",
    repository: APP,
    tag: "old",
    digest: OLD_DIGEST,
  };
}

function configuredCheckNames(config) {
  const names = Object.keys(config.checks || {});
  let ordinal = 0;
  for (const service of config.services || []) {
    for (const check of service.checks || []) {
      names.push(
        `servicecheck-${String(ordinal).padStart(2, "0")}-${check.type}-${check.port || service.internal_port}`
      );
      ordinal += 1;
    }
  }
  return names;
}

function passingChecks(config) {
  return configuredCheckNames(config).map((name) => ({ name, status: "passing" }));
}

function machine(id, state, secret = `${id}-private`) {
  const value = {
    id,
    name: `jumpgate-${id}`,
    state,
    region: "ams",
    instance_id: `${id}-instance-1`,
    version: `${id}-version-1`,
    host_status: "ok",
    cordoned: false,
    config: {
      image: OLD_IMAGE,
      env: { INTERNAL_TEST_VALUE: secret },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
      metadata: { fly_process_group: "app" },
      services: [
        {
          internal_port: 7515,
          protocol: "tcp",
          ports: [
            { port: 80, handlers: ["http"] },
            { port: 443, handlers: ["tls", "http"] },
          ],
          autostop: true,
          autostart: true,
          min_machines_running: 1,
          checks: [
            {
              type: "http",
              port: 7515,
              method: "GET",
              path: "/health/ready",
            },
          ],
        },
      ],
      checks: {
        ready: { type: "http", port: 7515, method: "GET", path: "/health/ready" },
      },
    },
    image_ref: imageRef(OLD_IMAGE),
    checks: [],
  };
  value.checks = state === "started" ? passingChecks(value.config) : [];
  return value;
}

function coreSnapshot(value) {
  return {
    id: value.id,
    name: value.name,
    state: value.state,
    cordoned: value.cordoned,
    region: value.region,
    config: clone(value.config),
    image_ref: clone(value.image_ref),
  };
}

class FakeMachinesClient {
  constructor(initialMachines, options = {}) {
    this.options = options;
    this.machines = new Map(initialMachines.map((value) => [value.id, clone(value)]));
    this.original = new Map(
      initialMachines
        .filter((value) => !isOwnedCanaryFixture(value))
        .map((value) => [value.id, coreSnapshot(value)])
    );
    this.calls = [];
    this.updates = [];
    this.creates = [];
    this.leases = new Map();
    this.acquireCounts = new Map();
    this.releaseAttempts = new Map();
    this.nowMs = 1_750_000_000_000;
    this.forwardUpdateCount = 0;
    this.rollbackUpdateCount = 0;
    this.versionCounter = 1;
    this.attestationInjected = false;
    this.canaryCounter = 0;
  }

  now = () => this.nowMs;

  async sleep(milliseconds) {
    this.nowMs += Math.max(1, milliseconds);
  }

  async list(_app, _deadlineAt, label) {
    this.calls.push(`list:${label}`);
    const listed = [...this.machines.values()]
      .filter((value) => value.state !== "destroyed")
      .map(clone);
    if (
      this.options.attestationFailure &&
      !this.attestationInjected &&
      label === "attestation/with-canary"
    ) {
      this.attestationInjected = true;
      const original = listed.find((value) => this.original.has(value.id));
      original.image_ref.digest = "sha256:" + "9".repeat(64);
    }
    return listed;
  }

  async get(_app, id, _deadlineAt, label) {
    this.calls.push(`get:${id}:${label}`);
    const current = this.machines.get(id);
    if (!current || current.state === "destroyed") throw new RolloutFailure(`${label}/status`);
    return clone(current);
  }

  async getOptional(_app, id, _deadlineAt, label) {
    this.calls.push(`get-optional:${id}:${label}`);
    const current = this.machines.get(id);
    if (!current || current.state === "destroyed") return null;
    return clone(current);
  }

  async synchronizeSecretsVersion(_app, _deadlineAt, label) {
    this.calls.push(`secrets:${label}`);
    if (this.options.secretsSyncFailure && label.startsWith("rollback/")) {
      throw new RolloutFailure(`${label}/status`);
    }
    return {
      version: SECRETS_VERSION,
      secrets: [{ name: "metadata-must-never-be-logged", digest: "private" }],
    };
  }

  leaseValue(id, nonce) {
    const current = this.machines.get(id);
    return {
      status: "success",
      data: {
        nonce,
        version: current.instance_id,
        expires_at: Math.ceil((this.nowMs + LEASE_TTL_SECONDS * 1000) / 1000),
      },
    };
  }

  async acquireLease(_app, id, _deadlineAt, label) {
    this.calls.push(`lease:${id}:${label}`);
    const current = this.machines.get(id);
    assert.ok(current, id);
    this.acquireCounts.set(id, (this.acquireCounts.get(id) || 0) + 1);
    const active = this.leases.get(id);
    if (active && active.expiresAt > this.nowMs) throw new RolloutFailure(`${label}/conflict`);
    const nonce = `nonce-${id}-${this.calls.length}`;
    this.leases.set(id, {
      nonce,
      expiresAt: this.nowMs + LEASE_TTL_SECONDS * 1000,
    });
    return this.leaseValue(id, nonce);
  }

  async refreshLease(_app, id, nonce, _deadlineAt, label) {
    this.calls.push(`refresh:${id}:${label}`);
    const active = this.leases.get(id);
    assert.equal(active?.nonce, nonce);
    active.expiresAt = this.nowMs + LEASE_TTL_SECONDS * 1000;
    return this.leaseValue(id, nonce);
  }

  async getLeaseOptional(_app, id, _deadlineAt, label) {
    this.calls.push(`get-lease:${id}:${label}`);
    const active = this.leases.get(id);
    if (!active || active.expiresAt <= this.nowMs) return null;
    if (this.options.releaseOwnershipConflict) {
      return this.leaseValue(id, `other-owner-${id}`);
    }
    return this.leaseValue(id, active.nonce);
  }

  async releaseLease(_app, id, nonce, _deadlineAt, label) {
    this.calls.push(`release:${id}:${label}`);
    const active = this.leases.get(id);
    assert.equal(active?.nonce, nonce);
    const attempts = (this.releaseAttempts.get(id) || 0) + 1;
    this.releaseAttempts.set(id, attempts);
    if (this.options.lostLeaseDelete && attempts === 1) {
      throw new RolloutFailure(`${label}/transport`);
    }
    if (this.options.releaseFailureConfirmedAbsent) {
      this.leases.delete(id);
      throw new RolloutFailure(`${label}/transport`);
    }
    if (this.options.releaseFailure) throw new RolloutFailure(`${label}/transport`);
    this.leases.delete(id);
  }

  nextMachineVersion(current) {
    this.versionCounter += 1;
    current.instance_id = `${current.id}-instance-${this.versionCounter}`;
    current.version = `${current.id}-version-${this.versionCounter}`;
  }

  async update(_app, id, nonce, input, _deadlineAt, label) {
    this.calls.push(`update:${id}:${label}`);
    const active = this.leases.get(id);
    assert.equal(active?.nonce, nonce);
    assert.equal(input.min_secrets_version, SECRETS_VERSION);
    const current = this.machines.get(id);
    assert.equal(input.current_version, current.instance_id);
    const isForward = input.config.image === IMAGE;
    if (isForward) this.forwardUpdateCount += 1;
    else this.rollbackUpdateCount += 1;
    this.updates.push({
      id,
      input: clone(input),
      kind: isForward ? "forward" : "rollback",
    });

    current.config = clone(input.config);
    current.image_ref = imageRef(input.config.image);
    if (input.skip_launch) {
      const configured = this.options.nonRunningUpdateState;
      current.state =
        typeof configured === "function"
          ? configured({ id, isForward, label, previousState: current.state })
          : configured || (["created", "stopped"].includes(current.state) ? current.state : "created");
    } else {
      current.state = "started";
    }
    current.checks = current.state === "started" ? passingChecks(current.config) : [];
    this.nextMachineVersion(current);

    if (isForward && this.options.healthFailureId === id) {
      current.checks = configuredCheckNames(current.config).map((name) => ({
        name,
        status: "critical",
      }));
    }
    if (!isForward && this.options.rollbackHealthFailureId === id) {
      current.checks = configuredCheckNames(current.config).map((name) => ({
        name,
        status: "critical",
      }));
    }
    if (isForward && this.options.failForwardUpdateNumber === this.forwardUpdateCount) {
      throw new RolloutFailure(`${label}/status`);
    }
    if (!isForward && this.options.rollbackFailureId === id) {
      throw new RolloutFailure(`${label}/status`);
    }
    return clone(current);
  }

  async wait(_app, id, instanceId, state, _deadlineAt, label) {
    this.calls.push(`wait:${id}:${label}`);
    assert.equal(state, "started", "non-running reconciliation must not use /wait");
    const current = this.machines.get(id);
    assert.equal(current.instance_id, instanceId);
    this.nowMs += 61_000;
  }

  async start(_app, id, nonce, _deadlineAt, label) {
    this.calls.push(`start:${id}:${label}`);
    assert.equal(this.leases.get(id)?.nonce, nonce);
    const current = this.machines.get(id);
    current.state = "started";
    current.checks = passingChecks(current.config);
  }

  async stop(_app, id, nonce, _deadlineAt, label) {
    this.calls.push(`stop:${id}:${label}`);
    assert.equal(this.leases.get(id)?.nonce, nonce);
    const current = this.machines.get(id);
    current.state = "stopped";
    current.checks = [];
  }

  async cordon(_app, id, nonce, _deadlineAt, label) {
    this.calls.push(`cordon:${id}:${label}`);
    assert.equal(this.leases.get(id)?.nonce, nonce);
    this.machines.get(id).cordoned = true;
  }

  async uncordon(_app, id, nonce, _deadlineAt, label) {
    this.calls.push(`uncordon:${id}:${label}`);
    assert.equal(this.leases.get(id)?.nonce, nonce);
    this.machines.get(id).cordoned = false;
  }

  async create(_app, input, deadlineAt, label) {
    this.calls.push(`create:${label}`);
    assert.equal(input.min_secrets_version, SECRETS_VERSION);
    assert.equal(input.skip_launch, false);
    assert.equal(input.skip_service_registration, false);
    this.creates.push(clone(input));
    this.canaryCounter += 1;
    const id = `canary-${this.canaryCounter}`;
    const created = {
      id,
      name: input.name,
      state: "started",
      region: input.region,
      instance_id: `${id}-instance-1`,
      version: `${id}-version-1`,
      host_status: "ok",
      cordoned: this.options.canaryCordoned === true,
      config: clone(input.config),
      image_ref: imageRef(input.config.image),
      checks: [],
    };
    if (this.options.canaryAutostopMutation) {
      created.config.services[0].autostop = true;
    }
    created.checks = passingChecks(created.config);
    if (this.options.canaryHealthFailure) {
      created.checks = created.checks.map((check) => ({ ...check, status: "critical" }));
    }
    if (!this.options.lostSlowCanaryCreateWithoutMachine) {
      this.machines.set(id, created);
    }
    if (
      this.options.lostSlowCanaryCreateResponse ||
      this.options.lostSlowCanaryCreateWithoutMachine
    ) {
      this.nowMs = deadlineAt + 1;
      throw new RolloutFailure(`${label}/transport`);
    }
    if (this.options.canaryCreateFailure) {
      throw new RolloutFailure(`${label}/transport`);
    }
    if (this.options.malformedCanaryCreateResponse) return { malformed: true };
    return clone(created);
  }

  async destroy(_app, id, nonce, _deadlineAt, label) {
    this.calls.push(`destroy:${id}:${label}`);
    assert.equal(this.leases.get(id)?.nonce, nonce);
    if (this.options.canaryCleanupFailure) {
      throw new RolloutFailure(`${label}/status`);
    }
    this.leases.delete(id);
    this.machines.delete(id);
    if (this.options.canaryDestroyAmbiguous) {
      throw new RolloutFailure(`${label}/transport`);
    }
  }
}

function assertFleetRestored(client) {
  const active = [...client.machines.values()].filter((value) => value.state !== "destroyed");
  assert.equal(active.length, client.original.size);
  for (const [id, expected] of client.original) {
    assert.deepEqual(coreSnapshot(client.machines.get(id)), expected);
  }
}

async function rollout(client, logs = []) {
  return runRollout({
    app: APP,
    image: IMAGE,
    deadlineMs: DEADLINE_MS,
    client,
    log: (line) => logs.push(line),
  });
}

test("multi-Machine rollout reconciles created/stopped via GET and preserves full configs", async () => {
  const initial = [
    machine("machine-a", "started"),
    machine("machine-b", "started"),
    machine("machine-c", "stopped"),
    machine("machine-d", "created"),
  ];
  const client = new FakeMachinesClient(initial);
  const logs = [];
  const result = await rollout(client, logs);

  assert.deepEqual(result, { machineCount: 4, updatedCount: 4, digest: DIGEST });
  assert.deepEqual(
    client.updates.filter((value) => value.kind === "forward").map((value) => value.id),
    ["machine-c", "machine-d", "machine-a", "machine-b"]
  );
  assert.equal(
    client.calls.some((value) => value.startsWith("wait:machine-c") || value.startsWith("wait:machine-d")),
    false
  );
  assert.equal(client.machines.get("machine-c").state, "stopped");
  assert.equal(client.machines.get("machine-d").state, "created");
  for (const update of client.updates) {
    assert.equal(update.input.min_secrets_version, SECRETS_VERSION);
    assert.equal(update.input.config.env.INTERNAL_TEST_VALUE.endsWith("-private"), true);
  }
  assert.equal(client.creates.length, 0);
  assert.equal(logs.join("\n").includes("private"), false);
  assert.equal(client.calls.some((value) => value.startsWith("refresh:")), true);
});

test("sole serving Machine gets an exact-digest same-region canary until final health", async () => {
  const original = machine("machine-a", "started", "sole-private");
  const client = new FakeMachinesClient([original]);
  const result = await rollout(client);

  assert.deepEqual(result, { machineCount: 1, updatedCount: 1, digest: DIGEST });
  assert.equal(client.creates.length, 1);
  const create = client.creates[0];
  const expectedCanaryConfig = clone(original.config);
  expectedCanaryConfig.image = IMAGE;
  expectedCanaryConfig.metadata.jumpgate_rollout_owner = "jumpgate-ci-rollout";
  expectedCanaryConfig.metadata.jumpgate_rollout_kind = "canary";
  expectedCanaryConfig.metadata.jumpgate_rollout_build_sha = BUILD_SHA;
  expectedCanaryConfig.metadata.jumpgate_rollout_id = `git-${BUILD_SHA}`;
  expectedCanaryConfig.services[0].autostop = false;
  expectedCanaryConfig.services[0].autostart = false;
  assert.deepEqual(create.config, expectedCanaryConfig);
  assert.equal(create.region, original.region);
  assert.equal(create.min_secrets_version, SECRETS_VERSION);
  const createIndex = client.calls.findIndex((value) => value.startsWith("create:"));
  const updateIndex = client.calls.findIndex((value) => value.startsWith("update:machine-a:machine-1/update"));
  const destroyIndex = client.calls.findIndex((value) => value.startsWith("destroy:canary-1"));
  assert.ok(createIndex < updateIndex);
  assert.ok(updateIndex < destroyIndex);
  assert.equal(client.machines.has("canary-1"), false);
  assert.equal(client.machines.get("machine-a").config.image, IMAGE);
});

test("sole-Machine canary cloning fails closed for mounts before mutation", async () => {
  const mounted = machine("machine-a", "started");
  mounted.config.mounts = [{ volume: "vol_private", path: "/data" }];
  const client = new FakeMachinesClient([mounted]);
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "canary/mounts"
  );
  assert.equal(client.forwardUpdateCount, 0);
  assert.equal(client.creates.length, 0);
});

test("sole-Machine canary cloning rejects malformed storage fields", async () => {
  const malformed = machine("machine-a", "started");
  malformed.config.mounts = { volume: "ambiguous" };
  const client = new FakeMachinesClient([malformed]);
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "canary/mounts"
  );
  assert.equal(client.forwardUpdateCount, 0);
  assert.equal(client.creates.length, 0);
});

test("failure on the Nth Machine rolls every attempted mutation back in reverse", async () => {
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started")],
    { failForwardUpdateNumber: 2 }
  );
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "rollout/reverted"
  );
  assertFleetRestored(client);
  assert.deepEqual(
    client.updates.filter((value) => value.kind === "rollback").map((value) => value.id),
    ["machine-b", "machine-a"]
  );
});

test("health failure restores the exact original fleet", async () => {
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started")],
    { healthFailureId: "machine-a" }
  );
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "rollout/reverted"
  );
  assertFleetRestored(client);
});

test("final digest attestation failure triggers full reconciliation", async () => {
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started")],
    { attestationFailure: true }
  );
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "rollout/reverted"
  );
  assertFleetRestored(client);
});

test("rollback failure emits only the stable emergency code", async () => {
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started")],
    { failForwardUpdateNumber: 2, rollbackFailureId: "machine-a" }
  );
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === EMERGENCY_CODE
  );
});

test("stopped Machine rollback uses start/stop to restore its exact desired state", async () => {
  const client = new FakeMachinesClient(
    [
      machine("machine-a", "started"),
      machine("machine-b", "started"),
      machine("machine-c", "stopped"),
    ],
    {
      failForwardUpdateNumber: 2,
      nonRunningUpdateState({ id, isForward }) {
        if (id === "machine-c" && !isForward) return "created";
        return id === "machine-c" ? "stopped" : "created";
      },
    }
  );
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "rollout/reverted"
  );
  assertFleetRestored(client);
  assert.equal(client.calls.some((value) => value.startsWith("start:machine-c:")), true);
  assert.equal(client.calls.some((value) => value.startsWith("stop:machine-c:")), true);
});

test("canary health failure cleans up without touching the original", async () => {
  const client = new FakeMachinesClient([machine("machine-a", "started")], {
    canaryHealthFailure: true,
  });
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "canary/verify/timeout"
  );
  assertFleetRestored(client);
  assert.equal(client.forwardUpdateCount, 0);
  assert.equal(client.machines.has("canary-1"), false);
});

test("canary cleanup failure rolls the original back and raises emergency", async () => {
  const client = new FakeMachinesClient([machine("machine-a", "started")], {
    canaryCleanupFailure: true,
  });
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === EMERGENCY_CODE
  );
  assert.deepEqual(
    coreSnapshot(client.machines.get("machine-a")),
    client.original.get("machine-a")
  );
  assert.equal(client.machines.has("canary-1"), true);
});

test("ambiguous canary delete is reconciled before rollback verification", async () => {
  const client = new FakeMachinesClient([machine("machine-a", "started")], {
    canaryDestroyAmbiguous: true,
  });
  await assert.doesNotReject(rollout(client));
  assert.equal(client.machines.has("canary-1"), false);
  assert.equal(client.machines.get("machine-a").config.image, IMAGE);
});

test("release is idempotent only after GET confirms the lease is absent", async () => {
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started")],
    { releaseFailureConfirmedAbsent: true }
  );
  await assert.doesNotReject(rollout(client));
  assert.equal(client.calls.some((value) => value.includes("release/confirm")), true);
});

test("release never masks an active lease owned by another nonce", async () => {
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started")],
    { releaseFailure: true, releaseOwnershipConflict: true }
  );
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === EMERGENCY_CODE
  );
  assert.equal(
    client.calls.some((value) => value.includes("release/confirm")),
    true
  );
});

test("lost lease DELETE retains one lease session through rollback and retries after reconciliation", async () => {
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started")],
    { failForwardUpdateNumber: 2, lostLeaseDelete: true }
  );
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "rollout/reverted"
  );
  assertFleetRestored(client);
  assert.equal(client.acquireCounts.get("machine-a"), 1);
  assert.equal(client.acquireCounts.get("machine-b"), 1);
  assert.ok(client.releaseAttempts.get("machine-a") >= 2);
  assert.ok(client.releaseAttempts.get("machine-b") >= 2);
  const reconciledAt = client.calls.findIndex((value) => value === "list:rollback/verify-final");
  const releasedAt = client.calls.findIndex((value) => value.startsWith("release:"));
  assert.ok(reconciledAt >= 0 && releasedAt > reconciledAt);
});

test("malformed canary create response is reconciled by deterministic name and metadata", async () => {
  const client = new FakeMachinesClient([machine("machine-a", "started")], {
    malformedCanaryCreateResponse: true,
  });
  await assert.doesNotReject(rollout(client));
  assert.equal(client.creates.length, 1);
  assert.equal(client.machines.has("canary-1"), false);
  assert.equal(client.acquireCounts.get("canary-1"), 1);
  assert.equal(
    client.calls.some((value) => value === "list:canary/reconcile-create"),
    true
  );
});

test("lost slow create response is reconciled under rollback reserve and leaves no orphan", async () => {
  const client = new FakeMachinesClient([machine("machine-a", "started")], {
    lostSlowCanaryCreateResponse: true,
  });
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "canary/create/transport"
  );
  assertFleetRestored(client);
  assert.equal(client.machines.has("canary-1"), false);
  const reconcileAt = client.calls.findIndex(
    (value) => value === "list:rollback/reconcile-canary"
  );
  const cleanupAt = client.calls.findIndex((value) => value.startsWith("destroy:canary-1:"));
  assert.ok(reconcileAt >= 0 && cleanupAt > reconcileAt);
  assert.equal(client.acquireCounts.get("canary-1"), 1);
});

test("unresolved ambiguous create fails emergency without claiming absence", async () => {
  const client = new FakeMachinesClient([machine("machine-a", "started")], {
    lostSlowCanaryCreateWithoutMachine: true,
  });
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === EMERGENCY_CODE
  );
  assertFleetRestored(client);
  assert.ok(
    client.calls.filter((value) => value === "list:rollback/reconcile-canary").length > 1
  );
  assert.equal(client.calls.some((value) => value.startsWith("destroy:")), false);
});

test("preflight removes every owned canary from prior builds before selecting production fleet", async () => {
  const production = machine("machine-a", "started");
  const legacy = machine("stale-legacy", "started");
  legacy.name = "jumpgate-canary-deadbeef0000";
  Object.assign(legacy.config.metadata, rolloutMetadata("e".repeat(40)));
  const owned = machine("stale-owned", "stopped");
  owned.name = "jumpgate-rollout-canary-feedface0000";
  Object.assign(owned.config.metadata, rolloutMetadata("f".repeat(40)));
  const client = new FakeMachinesClient([production, legacy, owned]);
  await assert.doesNotReject(rollout(client));
  assert.equal(client.machines.has("stale-legacy"), false);
  assert.equal(client.machines.has("stale-owned"), false);
  const firstSecrets = client.calls.findIndex((value) => value === "secrets:secrets-sync");
  for (const id of ["stale-legacy", "stale-owned"]) {
    assert.ok(client.calls.findIndex((value) => value.startsWith(`destroy:${id}:`)) < firstSecrets);
  }
});

test("metadata-free legacy canary name fails closed without deletion", async () => {
  const production = machine("machine-a", "started");
  const legacy = machine("legacy-name", "stopped");
  legacy.name = "jumpgate-canary-deadbeef0000";
  const client = new FakeMachinesClient([production, legacy]);
  await assert.rejects(
    rollout(client),
    (error) =>
      error instanceof RolloutFailure &&
      error.message === "preflight/manual-canary-reconciliation"
  );
  assert.equal(client.machines.has("legacy-name"), true);
  assert.equal(client.calls.some((value) => value.startsWith("destroy:legacy-name:")), false);
  assert.equal(client.calls.some((value) => value.startsWith("lease:")), false);
});

test("invalid or non-exact rollout metadata never grants cleanup authority", async () => {
  const production = machine("machine-a", "started");
  const wrongOwner = machine("wrong-owner", "stopped");
  Object.assign(wrongOwner.config.metadata, rolloutMetadata("d".repeat(40)), {
    jumpgate_rollout_owner: "untrusted-rollout",
  });
  const wrongId = machine("wrong-id", "stopped");
  Object.assign(wrongId.config.metadata, rolloutMetadata("c".repeat(40)), {
    jumpgate_rollout_id: "git-not-a-valid-build-sha",
  });
  const extraMarker = machine("extra-marker", "stopped");
  Object.assign(extraMarker.config.metadata, rolloutMetadata("b".repeat(40)), {
    jumpgate_rollout_untrusted: "present",
  });
  const client = new FakeMachinesClient([production, wrongOwner, wrongId, extraMarker]);
  await assert.rejects(
    rollout(client),
    (error) =>
      error instanceof RolloutFailure &&
      error.message === "preflight/manual-canary-reconciliation"
  );
  assert.equal(client.machines.has("wrong-owner"), true);
  assert.equal(client.machines.has("wrong-id"), true);
  assert.equal(client.machines.has("extra-marker"), true);
  assert.equal(client.calls.some((value) => value.startsWith("destroy:")), false);
  assert.equal(client.calls.some((value) => value.startsWith("lease:")), false);
});

test("legitimate production Machine with rollout prefix name is never cleanup-owned", async () => {
  const prefixed = machine("machine-a", "started");
  prefixed.name = "jumpgate-rollout-canary-production";
  const client = new FakeMachinesClient([prefixed, machine("machine-b", "started")]);
  await assert.doesNotReject(rollout(client));
  assert.equal(client.machines.has("machine-a"), true);
  assert.equal(client.machines.get("machine-a").name, prefixed.name);
  assert.equal(client.calls.some((value) => value.startsWith("destroy:machine-a:")), false);
  assert.equal(client.creates.length, 0);
});

test("cordoned started Machine is not accepted as the sole availability peer", async () => {
  const target = machine("machine-a", "started");
  const cordonedPeer = machine("machine-b", "started");
  cordonedPeer.cordoned = true;
  const client = new FakeMachinesClient([target, cordonedPeer]);
  await assert.doesNotReject(rollout(client));
  assert.equal(client.creates.length, 1, "the serving target needs a temporary peer");
});

test("availability peer must share process group and complete service topology", async () => {
  const target = machine("machine-a", "started");
  const wrongTopology = machine("machine-b", "started");
  wrongTopology.config.metadata.fly_process_group = "worker";
  wrongTopology.config.services[0].ports[0].port = 8080;
  const client = new FakeMachinesClient([target, wrongTopology]);
  await assert.rejects(
    rollout(client),
    (error) =>
      error instanceof RolloutFailure &&
      error.message === "availability/machine-a/zero-peers"
  );
  assert.equal(client.forwardUpdateCount, 0);
});

test("omitted service check cannot be replaced by an unrelated passing status", async () => {
  const target = machine("machine-a", "started");
  const incompletePeer = machine("machine-b", "started");
  incompletePeer.checks = [
    { name: "ready", status: "passing" },
    { name: "unrelated", status: "passing" },
  ];
  assert.equal(healthChecksPass(incompletePeer), false);
  const client = new FakeMachinesClient([target, incompletePeer]);
  await assert.doesNotReject(rollout(client));
  assert.equal(client.creates.length, 1, "the incomplete peer must not protect the target");
});

test("canary with API-mutated autostop policy fails closed and is removed", async () => {
  const client = new FakeMachinesClient([machine("machine-a", "started")], {
    canaryAutostopMutation: true,
  });
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "canary/create/config"
  );
  assertFleetRestored(client);
  assert.equal(client.machines.has("canary-1"), false);
});

test("rollback uses trusted preflight secrets version when fresh synchronization fails", async () => {
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started")],
    { failForwardUpdateNumber: 2, secretsSyncFailure: true }
  );
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "rollout/reverted"
  );
  assertFleetRestored(client);
  assert.equal(client.calls.includes("secrets:rollback/secrets-sync"), true);
  for (const update of client.updates.filter((value) => value.kind === "rollback")) {
    assert.equal(update.input.min_secrets_version, SECRETS_VERSION);
  }
});

test("dynamic rollback reserve reconciles a nine-Machine fleet in reverse", async () => {
  const fleet = Array.from({ length: 9 }, (_value, index) =>
    machine(`machine-${String.fromCharCode(97 + index)}`, "started")
  );
  const client = new FakeMachinesClient(fleet, { failForwardUpdateNumber: 9 });
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "rollout/reverted"
  );
  assertFleetRestored(client);
  assert.deepEqual(
    client.updates.filter((value) => value.kind === "rollback").map((value) => value.id),
    [...fleet].reverse().map((value) => value.id)
  );
});

test("forward rollout preserves exact created and stopped states with safe stopped transition", async () => {
  const created = machine("machine-c", "created");
  created.cordoned = true;
  const stopped = machine("machine-d", "stopped");
  const client = new FakeMachinesClient(
    [machine("machine-a", "started"), machine("machine-b", "started"), created, stopped],
    {
      nonRunningUpdateState({ id, isForward, label, previousState }) {
        if (!isForward) return previousState;
        if (id === "machine-c") return label.includes("created/retry") ? "created" : "stopped";
        if (id === "machine-d") return "created";
        return previousState;
      },
    }
  );
  await assert.doesNotReject(rollout(client));
  assert.equal(client.machines.get("machine-c").state, "created");
  assert.equal(client.machines.get("machine-c").cordoned, true);
  assert.equal(client.machines.get("machine-d").state, "stopped");
  assert.equal(client.machines.get("machine-d").cordoned, false);
  assert.equal(client.calls.some((value) => value.startsWith("cordon:machine-d:")), true);
  assert.equal(client.calls.some((value) => value.startsWith("start:machine-d:")), true);
  assert.equal(client.calls.some((value) => value.startsWith("stop:machine-d:")), true);
  assert.equal(client.calls.some((value) => value.startsWith("uncordon:machine-d:")), true);
});

test("client timeout exceeds Fly server wait and lease TTL covers health polling", () => {
  assert.ok(REQUEST_TIMEOUT_MS > SERVER_WAIT_SECONDS * 1000);
  assert.ok(LEASE_TTL_SECONDS * 1000 > REQUEST_TIMEOUT_MS + 2 * SERVER_WAIT_SECONDS * 1000);
});

test("Machines client secrets sync uses the pinned flyctl null-unset schema", async () => {
  let observed;
  const client = new MachinesClient({
    token: TOKEN,
    fetchImpl: async (url, request) => {
      observed = { url, request };
      return new Response(
        JSON.stringify({
          version: 7,
          secrets: [{ name: "must-not-appear", digest: "must-not-appear" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });
  const response = await client.synchronizeSecretsVersion(APP, Date.now() + 10_000, "sync");
  assert.equal(response.version, 7);
  assert.equal(observed.url.origin, "https://api.machines.dev");
  assert.equal(observed.url.pathname, `/v1/apps/${APP}/secrets`);
  const body = JSON.parse(observed.request.body);
  const entries = Object.entries(body.values);
  assert.equal(entries.length, 1);
  assert.match(entries[0][0], /^BogusDummySecret_[a-f0-9]{16}$/);
  assert.equal(entries[0][1], null);
});

test("Machines client cordon lifecycle calls preserve the active lease nonce", async () => {
  const observed = [];
  const client = new MachinesClient({
    token: TOKEN,
    fetchImpl: async (url, request) => {
      observed.push({ url, request });
      return new Response(null, { status: 204 });
    },
  });
  const deadlineAt = Date.now() + 10_000;
  await client.cordon(APP, "machine-a", "nonce-machine-a", deadlineAt, "cordon-test");
  await client.uncordon(APP, "machine-a", "nonce-machine-a", deadlineAt, "uncordon-test");
  assert.deepEqual(
    observed.map((entry) => entry.url.pathname),
    [
      `/v1/apps/${APP}/machines/machine-a/cordon`,
      `/v1/apps/${APP}/machines/machine-a/uncordon`,
    ]
  );
  assert.equal(
    observed.every(
      (entry) => entry.request.headers["fly-machine-lease-nonce"] === "nonce-machine-a"
    ),
    true
  );
});

test("Machines rollout fails closed for zero Machines and transient initial state", async () => {
  await assert.rejects(
    rollout(new FakeMachinesClient([])),
    (error) => error instanceof RolloutFailure && error.message === "preflight/list/zero-machines"
  );

  const transient = machine("machine-a", "started");
  transient.state = "starting";
  const client = new FakeMachinesClient([transient]);
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "preflight/production-1/state"
  );
  assert.equal(client.calls.some((value) => value.startsWith("lease:")), false);
});

test("Machines rollout rejects reserved ephemeral process groups", async () => {
  const ephemeral = machine("machine-a", "started");
  ephemeral.config.metadata.fly_process_group = "fly_app_console";
  const client = new FakeMachinesClient([ephemeral]);
  await assert.rejects(
    rollout(client),
    (error) => error instanceof RolloutFailure && error.message === "preflight/list/machine-1/reserved"
  );
  assert.equal(client.calls.some((value) => value.startsWith("lease:")), false);
});

test("release context requires protected main and exact build SHA", () => {
  const expected = parseImageReference(IMAGE, APP);
  assert.doesNotThrow(() =>
    requireReleaseContext(
      {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: BUILD_SHA,
        JUMPGATE_PRODUCTION_RELEASE: "true",
        JUMPGATE_REF_PROTECTED: "true",
      },
      expected
    )
  );
  assert.throws(
    () =>
      requireReleaseContext(
        {
          GITHUB_ACTIONS: "true",
          GITHUB_REF: "refs/heads/feature",
          GITHUB_SHA: BUILD_SHA,
          JUMPGATE_PRODUCTION_RELEASE: "true",
          JUMPGATE_REF_PROTECTED: "true",
        },
        expected
      ),
    /release-context\/ref/
  );
});
