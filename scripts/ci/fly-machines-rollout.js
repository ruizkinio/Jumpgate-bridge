"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const OFFICIAL_API_BASE = new URL("https://api.machines.dev/v1/");
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const SERVER_WAIT_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 75_000;
const HEALTH_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;
const LEASE_TTL_SECONDS = 300;
const LEASE_REFRESH_SKEW_MS = 90_000;
const MAX_ROLLOUT_DEADLINE_MS = 4 * 60 * 60_000;
const STABLE_STATES = new Set(["created", "started", "stopped"]);
const NON_RUNNING_STATES = new Set(["created", "stopped"]);
const CANARY_NAME_PREFIX = "jumpgate-rollout-canary-";
const LEGACY_CANARY_NAME_PREFIX = "jumpgate-canary-";
const CANARY_METADATA = Object.freeze({
  owner: "jumpgate-ci-rollout",
  kind: "canary",
});
const CANARY_METADATA_KEYS = Object.freeze([
  "jumpgate_rollout_build_sha",
  "jumpgate_rollout_id",
  "jumpgate_rollout_kind",
  "jumpgate_rollout_owner",
]);
const ROLLOUT_ID_PATTERN = /^git-[a-f0-9]{40}$/;
const ROLLBACK_BASE_BUDGET_MS = 2 * REQUEST_TIMEOUT_MS + HEALTH_TIMEOUT_MS;
const ROLLBACK_STARTED_BUDGET_MS = 2 * REQUEST_TIMEOUT_MS + HEALTH_TIMEOUT_MS;
const ROLLBACK_CREATED_BUDGET_MS = 2 * (REQUEST_TIMEOUT_MS + HEALTH_TIMEOUT_MS);
const ROLLBACK_STOPPED_BUDGET_MS = 5 * (REQUEST_TIMEOUT_MS + HEALTH_TIMEOUT_MS);
const CANARY_RECONCILE_BUDGET_MS =
  3 * (REQUEST_TIMEOUT_MS + HEALTH_TIMEOUT_MS) + REQUEST_TIMEOUT_MS;
const RESERVED_PROCESS_GROUPS = new Set([
  "fly_app_console",
  "fly_app_release_command",
  "release_command",
]);
const EMERGENCY_CODE = "rollback/emergency";

class RolloutFailure extends Error {
  constructor(label) {
    super(label);
    this.name = "RolloutFailure";
  }
}

class ApiFailure extends RolloutFailure {
  constructor(label, status) {
    super(label);
    this.name = "ApiFailure";
    this.status = status;
  }
}

function requireCondition(condition, label) {
  if (!condition) throw new RolloutFailure(label);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeFailure(error, label) {
  return error instanceof RolloutFailure ? error : new RolloutFailure(label);
}

function readArgument(args, name) {
  const prefix = `--${name}=`;
  const match = args.find((value) => value.startsWith(prefix));
  if (!match) throw new RolloutFailure(`arguments/${name}`);
  return match.slice(prefix.length);
}

function readIntegerArgument(args, name, minimum, maximum) {
  const value = Number(readArgument(args, name));
  requireCondition(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    `arguments/${name}`
  );
  return value;
}

function validateAppName(app) {
  requireCondition(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(app),
    "arguments/app"
  );
  return app;
}

function parseImageReference(image, app) {
  const escapedApp = app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^registry\\.fly\\.io/${escapedApp}:git-([a-f0-9]{40})@(sha256:[a-f0-9]{64})$`
  ).exec(image);
  requireCondition(match !== null, "arguments/image");
  return {
    value: image,
    registry: "registry.fly.io",
    repository: app,
    tag: `git-${match[1]}`,
    buildSha: match[1],
    digest: match[2],
  };
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch (_error) {
    // API bodies are intentionally discarded and never logged.
  }
}

async function readBoundedBody(response, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES) {
      await cancelBody(response);
      throw new RolloutFailure(`${label}/size`);
    }
  }
  requireCondition(response.body !== null, `${label}/body`);

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RolloutFailure(`${label}/size`);
      }
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    if (error instanceof RolloutFailure) throw error;
    throw new RolloutFailure(`${label}/body`);
  }
  return Buffer.concat(chunks, length);
}

class MachinesClient {
  constructor({ token, fetchImpl = globalThis.fetch, now = Date.now, sleepImpl } = {}) {
    requireCondition(
      typeof token === "string" &&
        token.length >= 8 &&
        token.length <= 8192 &&
        token === token.trim() &&
        !/[\x00-\x1f\x7f]/.test(token),
      "authentication/token"
    );
    requireCondition(typeof fetchImpl === "function", "client/fetch");
    requireCondition(typeof now === "function", "client/clock");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleepImpl =
      sleepImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async request(pathname, options) {
    const {
      deadlineAt,
      label,
      method = "GET",
      body,
      leaseNonce,
      parseJson = true,
      statuses = [200],
    } = options;
    const remainingMs = deadlineAt - this.now();
    requireCondition(remainingMs > 0, `${label}/deadline`);

    const url = new URL(pathname.replace(/^\/+/, ""), OFFICIAL_API_BASE);
    requireCondition(url.origin === OFFICIAL_API_BASE.origin, `${label}/url`);
    requireCondition(url.pathname.startsWith("/v1/apps/"), `${label}/url`);

    const headers = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (leaseNonce !== undefined) headers["fly-machine-lease-nonce"] = leaseNonce;

    let serializedBody;
    try {
      serializedBody = body === undefined ? undefined : JSON.stringify(body);
    } catch (_error) {
      throw new RolloutFailure(`${label}/request`);
    }

    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: serializedBody,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
      });
    } catch (_error) {
      throw new ApiFailure(`${label}/transport`);
    }

    if (!statuses.includes(response.status)) {
      const status = response.status;
      await cancelBody(response);
      throw new ApiFailure(`${label}/status`, status);
    }
    if (!parseJson) {
      await cancelBody(response);
      return null;
    }
    if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") || "")) {
      await cancelBody(response);
      throw new RolloutFailure(`${label}/content-type`);
    }

    const bytes = await readBoundedBody(response, label);
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (_error) {
      throw new RolloutFailure(`${label}/json`);
    }
  }

  list(app, deadlineAt, label = "list") {
    return this.request(`/apps/${encodeURIComponent(app)}/machines`, {
      deadlineAt,
      label,
    });
  }

  get(app, machineId, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`,
      { deadlineAt, label }
    );
  }

  async getOptional(app, machineId, deadlineAt, label) {
    try {
      return await this.get(app, machineId, deadlineAt, label);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return null;
      throw error;
    }
  }

  synchronizeSecretsVersion(app, deadlineAt, label) {
    const probe = `BogusDummySecret_${crypto.randomBytes(8).toString("hex")}`;
    return this.request(`/apps/${encodeURIComponent(app)}/secrets`, {
      deadlineAt,
      label,
      method: "POST",
      body: { values: { [probe]: null } },
    });
  }

  create(app, input, deadlineAt, label) {
    return this.request(`/apps/${encodeURIComponent(app)}/machines`, {
      deadlineAt,
      label,
      method: "POST",
      body: input,
      statuses: [200, 201],
    });
  }

  acquireLease(app, machineId, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/lease`,
      {
        deadlineAt,
        label,
        method: "POST",
        body: {
          description: "jumpgate-production-rollout",
          ttl: LEASE_TTL_SECONDS,
        },
        statuses: [200, 201],
      }
    );
  }

  refreshLease(app, machineId, nonce, deadlineAt, label) {
    const query = new URLSearchParams({ ttl: String(LEASE_TTL_SECONDS) });
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/lease?${query}`,
      {
        deadlineAt,
        label,
        method: "POST",
        leaseNonce: nonce,
        statuses: [200, 201],
      }
    );
  }

  async getLeaseOptional(app, machineId, deadlineAt, label) {
    try {
      return await this.request(
        `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/lease`,
        { deadlineAt, label }
      );
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 404) return null;
      throw error;
    }
  }

  releaseLease(app, machineId, nonce, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/lease`,
      {
        deadlineAt,
        label,
        method: "DELETE",
        leaseNonce: nonce,
        parseJson: false,
        statuses: [200, 204],
      }
    );
  }

  update(app, machineId, nonce, input, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}`,
      {
        deadlineAt,
        label,
        method: "POST",
        leaseNonce: nonce,
        body: input,
      }
    );
  }

  start(app, machineId, nonce, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/start`,
      {
        deadlineAt,
        label,
        method: "POST",
        leaseNonce: nonce,
        parseJson: false,
        statuses: [200, 202],
      }
    );
  }

  stop(app, machineId, nonce, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/stop`,
      {
        deadlineAt,
        label,
        method: "POST",
        leaseNonce: nonce,
        body: { signal: "SIGINT", timeout: "30s" },
        parseJson: false,
        statuses: [200, 202],
      }
    );
  }

  cordon(app, machineId, nonce, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/cordon`,
      {
        deadlineAt,
        label,
        method: "POST",
        leaseNonce: nonce,
        parseJson: false,
        statuses: [200, 202, 204],
      }
    );
  }

  uncordon(app, machineId, nonce, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/uncordon`,
      {
        deadlineAt,
        label,
        method: "POST",
        leaseNonce: nonce,
        parseJson: false,
        statuses: [200, 202, 204],
      }
    );
  }

  destroy(app, machineId, nonce, deadlineAt, label) {
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}?force=true`,
      {
        deadlineAt,
        label,
        method: "DELETE",
        leaseNonce: nonce,
        parseJson: false,
        statuses: [200, 202, 204],
      }
    );
  }

  wait(app, machineId, instanceId, state, deadlineAt, label) {
    const query = new URLSearchParams({
      instance_id: instanceId,
      state,
      timeout: String(SERVER_WAIT_SECONDS),
    });
    return this.request(
      `/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/wait?${query}`,
      { deadlineAt, label, parseJson: false }
    );
  }

  sleep(milliseconds) {
    return this.sleepImpl(milliseconds);
  }
}

function validateMachine(machine, label, { allowTransient = false } = {}) {
  requireCondition(isRecord(machine), `${label}/shape`);
  requireCondition(
    typeof machine.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(machine.id),
    `${label}/id`
  );
  requireCondition(
    typeof machine.state === "string" && machine.state.length > 0,
    `${label}/state`
  );
  if (machine.state === "destroyed") return machine;
  if (!allowTransient) requireCondition(STABLE_STATES.has(machine.state), `${label}/state`);
  requireCondition(typeof machine.cordoned === "boolean", `${label}/cordoned`);
  requireCondition(
    typeof machine.region === "string" && /^[a-z0-9]{3,16}$/.test(machine.region),
    `${label}/region`
  );
  if (machine.name !== undefined && machine.name !== null) {
    requireCondition(
      typeof machine.name === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(machine.name),
      `${label}/name`
    );
  }
  requireCondition(isRecord(machine.config), `${label}/config`);
  requireCondition(typeof machine.config.image === "string", `${label}/config-image`);
  if (machine.config.metadata !== undefined && machine.config.metadata !== null) {
    requireCondition(isRecord(machine.config.metadata), `${label}/metadata`);
    const processGroup =
      machine.config.metadata.fly_process_group || machine.config.metadata.process_group;
    requireCondition(!RESERVED_PROCESS_GROUPS.has(processGroup), `${label}/reserved`);
  }
  requireCondition(isRecord(machine.image_ref), `${label}/image-ref`);
  requireCondition(
    typeof machine.instance_id === "string" && machine.instance_id.length > 0,
    `${label}/instance`
  );
  if (machine.version !== undefined && machine.version !== null) {
    requireCondition(
      typeof machine.version === "string" && machine.version.length > 0,
      `${label}/version`
    );
  }
  if (machine.host_status !== undefined) {
    requireCondition(machine.host_status === "ok", `${label}/host`);
  }
  return machine;
}

function activeMachines(value, label, { allowEmpty = false, allowTransient = false } = {}) {
  requireCondition(Array.isArray(value), `${label}/shape`);
  const seen = new Set();
  const active = [];
  for (let index = 0; index < value.length; index += 1) {
    const machine = validateMachine(value[index], `${label}/machine-${index + 1}`, {
      allowTransient,
    });
    requireCondition(!seen.has(machine.id), `${label}/duplicate`);
    seen.add(machine.id);
    if (machine.state !== "destroyed") active.push(machine);
  }
  if (!allowEmpty) requireCondition(active.length > 0, `${label}/zero-machines`);
  return active;
}

function matchesImage(machine, expected) {
  const reportedTag = machine.image_ref.tag;
  return (
    machine.config.image === expected.value &&
    machine.image_ref.registry === expected.registry &&
    machine.image_ref.repository === expected.repository &&
    (reportedTag === undefined || reportedTag === null || reportedTag === expected.tag) &&
    machine.image_ref.digest === expected.digest
  );
}

function matchesSnapshotImage(machine, snapshot) {
  const expected = snapshot.imageRef;
  const actual = machine.image_ref;
  const reportedTag = actual.tag;
  return (
    actual.registry === expected.registry &&
    actual.repository === expected.repository &&
    (reportedTag === undefined || reportedTag === null || reportedTag === expected.tag) &&
    actual.digest === expected.digest
  );
}

function cloneJson(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    throw new RolloutFailure(`${label}/clone`);
  }
}

function requirePort(value, label) {
  requireCondition(Number.isSafeInteger(value) && value >= 1 && value <= 65_535, label);
  return value;
}

function processGroup(config) {
  if (!isRecord(config?.metadata)) return null;
  const value = config.metadata.fly_process_group ?? config.metadata.process_group;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return null;
  if (RESERVED_PROCESS_GROUPS.has(value)) return null;
  return value;
}

function serviceRoutingTopology(config, label) {
  requireCondition(Array.isArray(config?.services) && config.services.length > 0, `${label}/services`);
  return config.services.map((service, serviceIndex) => {
    const serviceLabel = `${label}/service-${serviceIndex + 1}`;
    requireCondition(isRecord(service), `${serviceLabel}/shape`);
    requireCondition(service.protocol === "tcp" || service.protocol === "udp", `${serviceLabel}/protocol`);
    requirePort(service.internal_port, `${serviceLabel}/internal-port`);
    requireCondition(Array.isArray(service.ports) && service.ports.length > 0, `${serviceLabel}/ports`);
    for (let portIndex = 0; portIndex < service.ports.length; portIndex += 1) {
      const port = service.ports[portIndex];
      const portLabel = `${serviceLabel}/port-${portIndex + 1}`;
      requireCondition(isRecord(port), `${portLabel}/shape`);
      if (port.port !== undefined) {
        requirePort(port.port, `${portLabel}/port`);
      } else {
        requirePort(port.start_port, `${portLabel}/start`);
        requirePort(port.end_port, `${portLabel}/end`);
        requireCondition(port.start_port <= port.end_port, `${portLabel}/range`);
      }
    }
    const normalized = cloneJson(service, serviceLabel);
    delete normalized.autostop;
    delete normalized.autostart;
    delete normalized.min_machines_running;
    return normalized;
  });
}

function configuredCheckNames(config, label) {
  const names = [];
  if (config?.checks !== undefined && config.checks !== null) {
    requireCondition(isRecord(config.checks), `${label}/top-level/shape`);
    for (const name of Object.keys(config.checks)) {
      requireCondition(/^[A-Za-z0-9_.:-]{1,256}$/.test(name), `${label}/top-level/name`);
      names.push(name);
    }
  }

  requireCondition(Array.isArray(config?.services), `${label}/services/shape`);
  let serviceCheckIndex = 0;
  for (let serviceIndex = 0; serviceIndex < config.services.length; serviceIndex += 1) {
    const service = config.services[serviceIndex];
    requireCondition(isRecord(service), `${label}/service-${serviceIndex + 1}/shape`);
    const checks = service.checks ?? [];
    requireCondition(Array.isArray(checks), `${label}/service-${serviceIndex + 1}/checks`);
    for (let checkIndex = 0; checkIndex < checks.length; checkIndex += 1) {
      const check = checks[checkIndex];
      const checkLabel = `${label}/service-${serviceIndex + 1}/check-${checkIndex + 1}`;
      requireCondition(isRecord(check), `${checkLabel}/shape`);
      requireCondition(check.type === "tcp" || check.type === "http", `${checkLabel}/type`);
      const port = requirePort(check.port ?? service.internal_port, `${checkLabel}/port`);
      const ordinal = String(serviceCheckIndex).padStart(2, "0");
      names.push(`servicecheck-${ordinal}-${check.type}-${port}`);
      serviceCheckIndex += 1;
    }
  }
  requireCondition(new Set(names).size === names.length, `${label}/duplicate`);
  return names;
}

function healthChecksPass(machine) {
  let expectedNames;
  try {
    expectedNames = configuredCheckNames(machine.config, "health/config");
  } catch (_error) {
    return false;
  }
  if (expectedNames.length === 0 || !Array.isArray(machine.checks)) return false;

  const byName = new Map();
  for (const check of machine.checks) {
    if (!isRecord(check) || typeof check.name !== "string") continue;
    const statuses = byName.get(check.name) || [];
    statuses.push(check.status);
    byName.set(check.name, statuses);
  }
  return expectedNames.every((name) => {
    const statuses = byName.get(name);
    return statuses?.length === 1 && statuses[0] === "passing";
  });
}

function sameServiceTopology(left, right) {
  try {
    return (
      processGroup(left.config) !== null &&
      processGroup(left.config) === processGroup(right.config) &&
      isDeepStrictEqual(
        serviceRoutingTopology(left.config, "topology/left"),
        serviceRoutingTopology(right.config, "topology/right")
      )
    );
  } catch (_error) {
    return false;
  }
}

function isServingMachine(machine, reference = machine) {
  if (machine.state !== "started" || machine.cordoned !== false) return false;
  if (!sameServiceTopology(machine, reference)) return false;
  return healthChecksPass(machine);
}

function canaryLifecycleDisabled(machine) {
  return (
    Array.isArray(machine.config?.services) &&
    machine.config.services.length > 0 &&
    machine.config.services.every(
      (service) => isRecord(service) && service.autostop === false && service.autostart === false
    )
  );
}

function isRolloutCanary(machine) {
  const metadata = machine.config?.metadata;
  if (!isRecord(metadata)) return false;
  const markerKeys = Object.keys(metadata)
    .filter((key) => key.startsWith("jumpgate_rollout_"))
    .sort();
  if (!isDeepStrictEqual(markerKeys, CANARY_METADATA_KEYS)) return false;
  const buildSha = metadata.jumpgate_rollout_build_sha;
  return (
    metadata.jumpgate_rollout_owner === CANARY_METADATA.owner &&
    metadata.jumpgate_rollout_kind === CANARY_METADATA.kind &&
    typeof buildSha === "string" &&
    /^[a-f0-9]{40}$/.test(buildSha) &&
    metadata.jumpgate_rollout_id === `git-${buildSha}` &&
    ROLLOUT_ID_PATTERN.test(metadata.jumpgate_rollout_id)
  );
}

function requiresManualCanaryReconciliation(machine) {
  if (isRolloutCanary(machine)) return false;
  const metadata = machine.config?.metadata;
  const hasUntrustedRolloutMetadata =
    isRecord(metadata) && Object.keys(metadata).some((key) => key.startsWith("jumpgate_rollout_"));
  return (
    hasUntrustedRolloutMetadata ||
    machine.name?.startsWith(LEGACY_CANARY_NAME_PREFIX) === true
  );
}

function canaryMetadata(expected) {
  return {
    jumpgate_rollout_owner: CANARY_METADATA.owner,
    jumpgate_rollout_kind: CANARY_METADATA.kind,
    jumpgate_rollout_build_sha: expected.buildSha,
    jumpgate_rollout_id: `git-${expected.buildSha}`,
  };
}

function canaryIdentityMatches(machine, record) {
  if (machine.name !== record.name || !isRecord(machine.config?.metadata)) return false;
  return Object.entries(record.metadata).every(
    ([key, value]) => machine.config.metadata[key] === value
  );
}

function snapshotMachine(machine, label) {
  return {
    id: machine.id,
    name: machine.name ?? null,
    state: machine.state,
    region: machine.region,
    instanceId: machine.instance_id,
    version: machine.version ?? null,
    cordoned: machine.cordoned,
    config: cloneJson(machine.config, `${label}/config`),
    imageRef: cloneJson(machine.image_ref, `${label}/image-ref`),
  };
}

function sameDesiredState(originalState, currentState) {
  return originalState === currentState;
}

function targetConfig(snapshot, expected) {
  const config = cloneJson(snapshot.config, `snapshot-${snapshot.id}/target`);
  config.image = expected.value;
  return config;
}

function requireSecretsVersion(value, label) {
  requireCondition(isRecord(value), `${label}/shape`);
  requireCondition(
    Number.isSafeInteger(value.version) && value.version >= 0,
    `${label}/version`
  );
  return value.version;
}

function requireLease(value, label, expectedNonce) {
  requireCondition(isRecord(value), `${label}/shape`);
  requireCondition(value.status === "success", `${label}/status`);
  requireCondition(isRecord(value.data), `${label}/data`);
  requireCondition(
    typeof value.data.nonce === "string" && /^[A-Za-z0-9_-]{8,256}$/.test(value.data.nonce),
    `${label}/nonce`
  );
  if (expectedNonce !== undefined) {
    requireCondition(value.data.nonce === expectedNonce, `${label}/ownership`);
  }
  requireCondition(
    typeof value.data.version === "string" && value.data.version.length > 0,
    `${label}/version`
  );
  requireCondition(
    Number.isSafeInteger(value.data.expires_at) && value.data.expires_at > 0,
    `${label}/expiry`
  );
  return {
    nonce: value.data.nonce,
    version: value.data.version,
    expiresAt: value.data.expires_at * 1000,
  };
}

class LeaseSession {
  constructor({ app, client, label, machineId, lease }) {
    this.app = app;
    this.client = client;
    this.label = label;
    this.machineId = machineId;
    this.nonce = lease.nonce;
    this.version = lease.version;
    this.expiresAt = lease.expiresAt;
    this.closed = false;
  }

  static async acquire({ app, client, deadlineAt, label, machineId }) {
    const response = await client.acquireLease(app, machineId, deadlineAt, `${label}/acquire`);
    const lease = requireLease(response, `${label}/acquire`);
    requireCondition(
      lease.expiresAt - client.now() >= LEASE_REFRESH_SKEW_MS,
      `${label}/acquire/ttl`
    );
    return new LeaseSession({ app, client, label, machineId, lease });
  }

  async ensureFresh(deadlineAt, force = false) {
    requireCondition(!this.closed, `${this.label}/closed`);
    if (!force && this.expiresAt - this.client.now() > LEASE_REFRESH_SKEW_MS) return;
    const response = await this.client.refreshLease(
      this.app,
      this.machineId,
      this.nonce,
      deadlineAt,
      `${this.label}/refresh`
    );
    const lease = requireLease(response, `${this.label}/refresh`, this.nonce);
    requireCondition(
      lease.expiresAt - this.client.now() >= LEASE_REFRESH_SKEW_MS,
      `${this.label}/refresh/ttl`
    );
    this.version = lease.version;
    this.expiresAt = lease.expiresAt;
  }

  markMachineAbsent() {
    this.closed = true;
  }

  async releaseAfterReconciled(deadlineAt) {
    if (this.closed) return;
    let releaseFailure;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.releaseLease(
          this.app,
          this.machineId,
          this.nonce,
          deadlineAt,
          `${this.label}/release`
        );
        this.closed = true;
        return;
      } catch (error) {
        releaseFailure = normalizeFailure(error, `${this.label}/release/internal`);
      }

      const current = await this.client.getLeaseOptional(
        this.app,
        this.machineId,
        deadlineAt,
        `${this.label}/release/confirm`
      );
      if (current === null) {
        this.closed = true;
        return;
      }
      const lease = requireLease(current, `${this.label}/release/confirm`);
      if (lease.nonce !== this.nonce) {
        throw new RolloutFailure(`${this.label}/release/ownership`);
      }
      if (lease.expiresAt <= this.client.now()) {
        this.closed = true;
        return;
      }
      if (attempt < 2) await this.client.sleep(POLL_INTERVAL_MS);
    }
    throw releaseFailure || new RolloutFailure(`${this.label}/release/active`);
  }
}

class LeaseRegistry {
  constructor({ app, client }) {
    this.app = app;
    this.client = client;
    this.sessions = new Map();
    this.order = [];
  }

  async acquire(machineId, deadlineAt, label) {
    const existing = this.sessions.get(machineId);
    if (existing) {
      await existing.ensureFresh(deadlineAt);
      return existing;
    }
    const session = await LeaseSession.acquire({
      app: this.app,
      client: this.client,
      deadlineAt,
      label,
      machineId,
    });
    this.sessions.set(machineId, session);
    this.order.push(session);
    session.registry = this;
    const fresh = validateMachine(
      await this.client.get(this.app, machineId, deadlineAt, `${label}/fresh`),
      `${label}/fresh`,
      { allowTransient: true }
    );
    requireCondition(session.version === fresh.instance_id, `${label}/lease-version`);
    return session;
  }

  async ensureAllFresh(deadlineAt) {
    for (const session of this.order) {
      if (!session.closed) await session.ensureFresh(deadlineAt);
    }
  }

  async releaseAllAfterReconciled(deadlineAt) {
    let failure = null;
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      try {
        await this.order[index].releaseAfterReconciled(deadlineAt);
      } catch (error) {
        failure ||= normalizeFailure(error, "leases/release");
      }
    }
    if (failure) throw failure;
  }
}

function rollbackBudgetForState(state) {
  if (state === "started") return ROLLBACK_STARTED_BUDGET_MS;
  if (state === "created") return ROLLBACK_CREATED_BUDGET_MS;
  return ROLLBACK_STOPPED_BUDGET_MS;
}

function rollbackReserveMs({ canaryRecord, fleetSize, mutationJournal }) {
  const machineBudget = mutationJournal.reduce(
    (total, entry) => total + rollbackBudgetForState(entry.snapshot.state),
    0
  );
  const canaryBudget =
    canaryRecord && canaryRecord.status !== "absent" && canaryRecord.status !== "removed"
      ? CANARY_RECONCILE_BUDGET_MS
      : 0;
  const leaseBudget =
    (mutationJournal.length + (canaryBudget > 0 ? 1 : 0)) * REQUEST_TIMEOUT_MS;
  const retainedLeaseCount = mutationJournal.length + (canaryBudget > 0 ? 1 : 0);
  const refreshSweepBudget =
    retainedLeaseCount * retainedLeaseCount * REQUEST_TIMEOUT_MS;
  return (
    ROLLBACK_BASE_BUDGET_MS +
    fleetSize * REQUEST_TIMEOUT_MS +
    machineBudget +
    canaryBudget +
    leaseBudget +
    refreshSweepBudget
  );
}

function requireForwardDeadline({ canaryRecord, client, deadlineAt, fleetSize, mutationJournal }) {
  const forwardDeadlineAt =
    deadlineAt - rollbackReserveMs({ canaryRecord, fleetSize, mutationJournal });
  requireCondition(
    forwardDeadlineAt - client.now() >= REQUEST_TIMEOUT_MS,
    "rollout/rollback-reserve"
  );
  return forwardDeadlineAt;
}

async function keepTransactionLeasesFresh(lease, deadlineAt, force = false) {
  if (lease.registry) await lease.registry.ensureAllFresh(deadlineAt);
  else await lease.ensureFresh(deadlineAt);
  if (force) await lease.ensureFresh(deadlineAt, true);
}

async function pollMachine({
  app,
  client,
  deadlineAt,
  label,
  lease,
  machineId,
  predicate,
  timeoutMs = HEALTH_TIMEOUT_MS,
}) {
  const verificationDeadline = Math.min(deadlineAt, client.now() + timeoutMs);
  while (client.now() < verificationDeadline) {
    if (lease) await keepTransactionLeasesFresh(lease, verificationDeadline);
    const machine = validateMachine(
      await client.get(app, machineId, verificationDeadline, `${label}/get`),
      `${label}/get`,
      { allowTransient: true }
    );
    if (machine.state !== "destroyed" && predicate(machine)) return machine;
    const delay = Math.min(POLL_INTERVAL_MS, verificationDeadline - client.now());
    if (delay > 0) await client.sleep(delay);
  }
  throw new RolloutFailure(`${label}/timeout`);
}

async function waitForStarted({
  app,
  client,
  config,
  deadlineAt,
  expectedImage,
  instanceId,
  label,
  lease,
  machineId,
  requireHealth = true,
  cordoned,
}) {
  if (lease) await keepTransactionLeasesFresh(lease, deadlineAt, true);
  await client.wait(app, machineId, instanceId, "started", deadlineAt, `${label}/wait`);
  if (lease) await keepTransactionLeasesFresh(lease, deadlineAt, true);
  return pollMachine({
    app,
    client,
    deadlineAt,
    label: `${label}/verify`,
    lease,
    machineId,
    predicate(machine) {
      return (
        machine.state === "started" &&
        machine.instance_id === instanceId &&
        (cordoned === undefined || machine.cordoned === cordoned) &&
        isDeepStrictEqual(machine.config, config) &&
        expectedImage(machine) &&
        (!requireHealth || healthChecksPass(machine))
      );
    },
  });
}

async function waitForNonRunning({
  app,
  client,
  config,
  deadlineAt,
  expectedImage,
  instanceId,
  label,
  lease,
  machineId,
  cordoned,
}) {
  return pollMachine({
    app,
    client,
    deadlineAt,
    label: `${label}/verify`,
    lease,
    machineId,
    predicate(machine) {
      return (
        NON_RUNNING_STATES.has(machine.state) &&
        machine.instance_id === instanceId &&
        (cordoned === undefined || machine.cordoned === cordoned) &&
        isDeepStrictEqual(machine.config, config) &&
        expectedImage(machine)
      );
    },
  });
}

async function updateOriginal({
  app,
  canaryRecord,
  client,
  deadlineAt,
  expected,
  fleetSize,
  leases,
  minSecretsVersion,
  mutationJournal,
  ordinal,
  snapshot,
}) {
  const label = `machine-${ordinal}`;
  const acquisitionDeadline = requireForwardDeadline({
    canaryRecord,
    client,
    deadlineAt,
    fleetSize,
    mutationJournal,
  });
  const lease = await leases.acquire(snapshot.id, acquisitionDeadline, `${label}/lease`);
  const fresh = validateMachine(
    await client.get(app, snapshot.id, acquisitionDeadline, `${label}/fresh`),
    `${label}/fresh`
  );
  requireCondition(fresh.state === snapshot.state, `${label}/state-drift`);
  requireCondition(fresh.cordoned === snapshot.cordoned, `${label}/cordon-drift`);
  requireCondition(fresh.instance_id === snapshot.instanceId, `${label}/instance-drift`);
  if (snapshot.version !== null) {
    requireCondition(fresh.version === snapshot.version, `${label}/version-drift`);
  }
  requireCondition(isDeepStrictEqual(fresh.config, snapshot.config), `${label}/config-drift`);
  if (matchesImage(fresh, expected)) return false;

  const config = targetConfig(snapshot, expected);
  const journalEntry = { snapshot, lease, mutationAttempted: false };
  mutationJournal.push(journalEntry);
  const mutationDeadlineAt = requireForwardDeadline({
    canaryRecord,
    client,
    deadlineAt,
    fleetSize,
    mutationJournal,
  });
  journalEntry.mutationAttempted = true;
  await leases.ensureAllFresh(mutationDeadlineAt);
  const updated = await client.update(
    app,
    fresh.id,
    lease.nonce,
    {
      config,
      current_version: fresh.instance_id,
      skip_launch: snapshot.state !== "started",
      min_secrets_version: minSecretsVersion,
    },
    mutationDeadlineAt,
    `${label}/update`
  );
  requireCondition(isRecord(updated) && updated.id === fresh.id, `${label}/update/identity`);
  requireCondition(
    typeof updated.instance_id === "string" && updated.instance_id.length > 0,
    `${label}/update/instance`
  );

  if (snapshot.state === "started") {
    await waitForStarted({
      app,
      client,
      config,
      cordoned: snapshot.cordoned,
      deadlineAt: mutationDeadlineAt,
      expectedImage: (machine) => matchesImage(machine, expected),
      instanceId: updated.instance_id,
      label,
      lease,
      machineId: fresh.id,
    });
  } else {
    let current = await waitForNonRunning({
      app,
      client,
      config,
      deadlineAt: mutationDeadlineAt,
      expectedImage: (machine) => matchesImage(machine, expected),
      instanceId: updated.instance_id,
      label,
      lease,
      machineId: fresh.id,
    });
    current = await transitionToExactState({
      app,
      client,
      config,
      current,
      deadlineAt: mutationDeadlineAt,
      desiredCordoned: snapshot.cordoned,
      desiredState: snapshot.state,
      expectedImage: (machine) => matchesImage(machine, expected),
      label,
      lease,
      minSecretsVersion,
      machineId: snapshot.id,
    });
    requireCondition(current.state === snapshot.state, `${label}/state`);
  }
  return true;
}

function validateCanarySource(snapshot) {
  const config = snapshot.config;
  serviceRoutingTopology(config, "canary/topology");
  requireCondition(processGroup(config) !== null, "canary/process-group");
  requireCondition(configuredCheckNames(config, "canary/checks").length > 0, "canary/checks");
  requireCondition(
    config.mounts === undefined ||
      config.mounts === null ||
      (Array.isArray(config.mounts) && config.mounts.length === 0),
    "canary/mounts"
  );
  requireCondition(
    config.volumes === undefined ||
      config.volumes === null ||
      (Array.isArray(config.volumes) && config.volumes.length === 0),
    "canary/volumes"
  );
  requireCondition(config.cache_drive === undefined || config.cache_drive === null, "canary/cache");
  requireCondition(config.rootfs === undefined || config.rootfs === null, "canary/rootfs");
  requireCondition(config.auto_destroy !== true, "canary/auto-destroy");
  requireCondition(config.schedule === undefined || config.schedule === null || config.schedule === "", "canary/schedule");
  requireCondition(
    config.standbys === undefined ||
      config.standbys === null ||
      (Array.isArray(config.standbys) && config.standbys.length === 0),
    "canary/standbys"
  );
  requireCondition(config.spot === undefined || config.spot === null, "canary/spot");
  if (isRecord(config.guest) && config.guest.persist_rootfs !== undefined) {
    requireCondition(
      config.guest.persist_rootfs === null || config.guest.persist_rootfs === "never",
      "canary/persist-rootfs"
    );
  }
}

function canaryName(expected) {
  return `${CANARY_NAME_PREFIX}${expected.buildSha.slice(0, 12)}`;
}

function prepareCanaryRecord(source, expected) {
  validateCanarySource(source);
  const metadata = canaryMetadata(expected);
  const config = targetConfig(source, expected);
  config.metadata = { ...(isRecord(config.metadata) ? config.metadata : {}), ...metadata };
  config.services = config.services.map((service) => ({
    ...cloneJson(service, "canary/service"),
    autostop: false,
    autostart: false,
  }));
  return {
    kind: "canary",
    name: canaryName(expected),
    metadata,
    source,
    region: source.region,
    config,
    id: null,
    lease: null,
    status: "intended",
    cleanupState: "not-submitted",
  };
}

async function locateCanary({ app, client, deadlineAt, record, originalIds, label }) {
  const reconcileDeadline = Math.min(deadlineAt, client.now() + HEALTH_TIMEOUT_MS);
  while (client.now() < reconcileDeadline) {
    const listed = activeMachines(
      await client.list(app, reconcileDeadline, label),
      label,
      { allowEmpty: true, allowTransient: true }
    );
    const named = listed.filter((machine) => machine.name === record.name);
    requireCondition(named.length <= 1, `${label}/ambiguous`);
    if (named.length === 1) {
      requireCondition(canaryIdentityMatches(named[0], record), `${label}/metadata`);
      requireCondition(!originalIds.has(named[0].id), `${label}/identity`);
      return named[0];
    }
    await client.sleep(Math.min(POLL_INTERVAL_MS, reconcileDeadline - client.now()));
  }
  return null;
}

async function createCanary({
  app,
  canaryRecord,
  client,
  deadlineAt,
  expected,
  fleetSize,
  leases,
  minSecretsVersion,
  mutationJournal,
  originalIds,
}) {
  const record = canaryRecord;
  requireCondition(record?.status === "intended", "canary/journal");
  const createDeadlineAt = requireForwardDeadline({
    canaryRecord: record,
    client,
    deadlineAt,
    fleetSize,
    mutationJournal,
  });
  let created;
  let createFailure = null;
  record.status = "unknown";
  record.cleanupState = "metadata-reconciliation-required";
  try {
    created = await client.create(
      app,
      {
        name: record.name,
        region: record.region,
        config: record.config,
        skip_launch: false,
        skip_service_registration: false,
        min_secrets_version: minSecretsVersion,
      },
      createDeadlineAt,
      "canary/create"
    );
  } catch (error) {
    createFailure = normalizeFailure(error, "canary/create/internal");
  }

  let responseValid = false;
  if (created !== undefined) {
    try {
      const candidate = validateMachine(created, "canary/create", { allowTransient: true });
      responseValid =
        candidate.region === record.region &&
        !originalIds.has(candidate.id) &&
        canaryIdentityMatches(candidate, record) &&
        isDeepStrictEqual(candidate.config, record.config) &&
        matchesImage(candidate, expected);
    } catch (_error) {
      responseValid = false;
    }
  }
  if (!responseValid) {
    created = await locateCanary({
      app,
      client,
      deadlineAt: createDeadlineAt,
      record,
      originalIds,
      label: "canary/reconcile-create",
    });
    if (created === null) {
      throw createFailure || new RolloutFailure("canary/create/response");
    }
  }

  const machine = validateMachine(created, "canary/create", { allowTransient: true });
  requireCondition(canaryIdentityMatches(machine, record), "canary/create/identity");
  requireCondition(machine.region === record.region, "canary/create/region");
  requireCondition(!originalIds.has(machine.id), "canary/create/identity");
  requireCondition(isDeepStrictEqual(machine.config, record.config), "canary/create/config");
  requireCondition(matchesImage(machine, expected), "canary/create/image");
  record.id = machine.id;
  record.status = "tracked";
  record.cleanupState = "tracked";
  record.lease = await leases.acquire(machine.id, createDeadlineAt, "canary/lease");

  const serving = await waitForStarted({
    app,
    client,
    config: record.config,
    cordoned: false,
    deadlineAt: createDeadlineAt,
    expectedImage: (current) => matchesImage(current, expected),
    instanceId: machine.instance_id,
    label: "canary",
    lease: record.lease,
    machineId: machine.id,
  });
  requireCondition(canaryLifecycleDisabled(serving), "canary/autostop");
  requireCondition(isServingMachine(serving, record.source), "canary/routing");
  record.status = "serving";
  return record;
}

async function removeCanary({ app, canaryRecord, client, deadlineAt, leases, originalIds }) {
  if (!canaryRecord || canaryRecord.status === "absent" || canaryRecord.status === "removed") {
    return;
  }
  const record = canaryRecord;
  if (record.id === null) {
    const located = await locateCanary({
      app,
      client,
      deadlineAt,
      record,
      originalIds,
      label: "canary/cleanup/locate",
    });
    if (located === null) {
      record.status = "absent";
      record.cleanupState = "complete";
      return;
    }
    record.id = located.id;
    record.status = "tracked";
    record.cleanupState = "tracked";
  }

  const existing = await client.getOptional(app, record.id, deadlineAt, "canary/cleanup/get");
  if (existing === null || existing.state === "destroyed") {
    record.lease?.markMachineAbsent();
    record.status = "removed";
    record.cleanupState = "complete";
    return;
  }
  const machine = validateMachine(existing, "canary/cleanup/get", { allowTransient: true });
  requireCondition(canaryIdentityMatches(machine, record), "canary/cleanup/identity");
  const lease = record.lease ||
    (await leases.acquire(record.id, deadlineAt, `canary/cleanup/${record.id}/lease`));
  record.lease = lease;

  let lastFailure = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await keepTransactionLeasesFresh(lease, deadlineAt);
    try {
      await client.destroy(
        app,
        record.id,
        lease.nonce,
        deadlineAt,
        `canary/cleanup/destroy-${attempt + 1}`
      );
    } catch (error) {
      lastFailure = normalizeFailure(error, "canary/cleanup/destroy");
    }

    const verifyDeadline = Math.min(deadlineAt, client.now() + HEALTH_TIMEOUT_MS);
    while (client.now() < verifyDeadline) {
      const current = await client.getOptional(
        app,
        record.id,
        verifyDeadline,
        "canary/cleanup/verify"
      );
      if (current === null || current.state === "destroyed") {
        lease.markMachineAbsent();
        record.status = "removed";
        record.cleanupState = "complete";
        return;
      }
      requireCondition(canaryIdentityMatches(current, record), "canary/cleanup/verify/identity");
      await keepTransactionLeasesFresh(lease, verifyDeadline);
      await client.sleep(Math.min(POLL_INTERVAL_MS, verifyDeadline - client.now()));
    }
  }
  throw lastFailure || new RolloutFailure("canary/cleanup/timeout");
}

function ownedCanaryRecord(machine) {
  requireCondition(isRolloutCanary(machine), "preflight/canary/ownership");
  const metadata = {};
  if (isRecord(machine.config?.metadata)) {
    for (const [key, value] of Object.entries(machine.config.metadata)) {
      if (key.startsWith("jumpgate_rollout_") && typeof value === "string") {
        metadata[key] = value;
      }
    }
  }
  return {
    kind: "canary",
    name: machine.name,
    metadata,
    source: null,
    region: machine.region,
    config: cloneJson(machine.config, "preflight/canary/config"),
    id: machine.id,
    lease: null,
    status: "tracked",
    cleanupState: "tracked",
  };
}

async function reconcileStaleCanaries({ app, client, deadlineAt, leases }) {
  const listed = activeMachines(await client.list(app, deadlineAt, "preflight/list"), "preflight/list", {
    allowTransient: true,
  });
  requireCondition(
    !listed.some(requiresManualCanaryReconciliation),
    "preflight/manual-canary-reconciliation"
  );
  const stale = listed.filter(isRolloutCanary).sort((left, right) => left.id.localeCompare(right.id));
  const production = listed.filter((machine) => !isRolloutCanary(machine));
  requireCondition(production.length > 0, "preflight/zero-production");
  production.forEach((machine, index) =>
    validateMachine(machine, `preflight/production-${index + 1}`)
  );
  requireCondition(
    production.some((machine) => isServingMachine(machine)),
    "preflight/zero-serving-production"
  );
  if (stale.length === 0) return production;

  const originalIds = new Set(production.map((machine) => machine.id));
  const productionSnapshots = new Map(
    production.map((machine, index) => [
      machine.id,
      snapshotMachine(machine, `preflight/production-${index + 1}`),
    ])
  );
  for (const machine of stale) {
    await removeCanary({
      app,
      canaryRecord: ownedCanaryRecord(machine),
      client,
      deadlineAt,
      leases,
      originalIds,
    });
  }

  const after = activeMachines(
    await client.list(app, deadlineAt, "preflight/verify"),
    "preflight/verify"
  );
  requireCondition(!after.some(isRolloutCanary), "preflight/stale-canary");
  requireCondition(after.length === production.length, "preflight/machine-set");
  for (const machine of after) {
    const before = productionSnapshots.get(machine.id);
    requireCondition(before !== undefined, "preflight/machine-set");
    requireCondition(machine.state === before.state, "preflight/production-drift");
    requireCondition(machine.cordoned === before.cordoned, "preflight/production-drift");
    requireCondition(machine.region === before.region, "preflight/production-drift");
    requireCondition((machine.name ?? null) === before.name, "preflight/production-drift");
    requireCondition(machine.instance_id === before.instanceId, "preflight/production-drift");
    requireCondition((machine.version ?? null) === before.version, "preflight/production-drift");
    requireCondition(isDeepStrictEqual(machine.config, before.config), "preflight/production-drift");
    requireCondition(matchesSnapshotImage(machine, before), "preflight/production-drift");
  }
  requireCondition(after.some((machine) => isServingMachine(machine)), "preflight/zero-serving-production");
  return after;
}

function expectedActiveIds(snapshots, canaryRecord) {
  const ids = new Set(snapshots.map((snapshot) => snapshot.id));
  if (canaryRecord?.id && !["absent", "removed"].includes(canaryRecord.status)) {
    ids.add(canaryRecord.id);
  }
  return ids;
}

async function requireServingPeer({ app, canaryRecord, client, deadlineAt, snapshots, targetId }) {
  const listed = activeMachines(
    await client.list(app, deadlineAt, `availability/${targetId}`),
    `availability/${targetId}`
  );
  const expectedIds = expectedActiveIds(snapshots, canaryRecord);
  requireCondition(listed.length === expectedIds.size, `availability/${targetId}/machine-set`);
  requireCondition(
    listed.every((machine) => expectedIds.has(machine.id)),
    `availability/${targetId}/machine-set`
  );
  const target = listed.find((machine) => machine.id === targetId);
  requireCondition(target !== undefined, `availability/${targetId}/target`);
  const peers = listed.filter(
    (machine) => machine.id !== targetId && isServingMachine(machine, target)
  );
  requireCondition(peers.length > 0, `availability/${targetId}/zero-peers`);
}

async function verifyReleaseFleet({
  app,
  canaryRecord,
  client,
  deadlineAt,
  expected,
  label,
  snapshots,
}) {
  const listed = activeMachines(await client.list(app, deadlineAt, label), label);
  const expectedIds = expectedActiveIds(snapshots, canaryRecord);
  requireCondition(listed.length === expectedIds.size, `${label}/machine-set`);
  requireCondition(listed.every((machine) => expectedIds.has(machine.id)), `${label}/machine-set`);

  const byId = new Map(listed.map((machine) => [machine.id, machine]));
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const machine = byId.get(snapshot.id);
    requireCondition(machine !== undefined, `${label}/machine-${index + 1}/missing`);
    requireCondition(
      machine.state === snapshot.state,
      `${label}/machine-${index + 1}/state`
    );
    requireCondition(machine.cordoned === snapshot.cordoned, `${label}/machine-${index + 1}/cordoned`);
    requireCondition(
      isDeepStrictEqual(machine.config, targetConfig(snapshot, expected)),
      `${label}/machine-${index + 1}/config`
    );
    requireCondition(matchesImage(machine, expected), `${label}/machine-${index + 1}/image`);
    if (machine.state === "started") {
      requireCondition(healthChecksPass(machine), `${label}/machine-${index + 1}/health`);
    }
  }

  if (canaryRecord?.id && !["absent", "removed"].includes(canaryRecord.status)) {
    const machine = byId.get(canaryRecord.id);
    requireCondition(machine !== undefined, `${label}/canary/missing`);
    requireCondition(canaryIdentityMatches(machine, canaryRecord), `${label}/canary/identity`);
    requireCondition(machine.region === canaryRecord.region, `${label}/canary/region`);
    requireCondition(machine.state === "started", `${label}/canary/state`);
    requireCondition(machine.cordoned === false, `${label}/canary/cordoned`);
    requireCondition(isDeepStrictEqual(machine.config, canaryRecord.config), `${label}/canary/config`);
    requireCondition(matchesImage(machine, expected), `${label}/canary/image`);
    requireCondition(canaryLifecycleDisabled(machine), `${label}/canary/autostop`);
    requireCondition(isServingMachine(machine, canaryRecord.source), `${label}/canary/routing`);
  }
  requireCondition(
    listed.some((machine) => isServingMachine(machine)),
    `${label}/zero-serving`
  );
}

async function setCordonState({
  app,
  client,
  current,
  deadlineAt,
  desiredCordoned,
  expectedImage,
  label,
  lease,
  machineId,
}) {
  if (current.cordoned === desiredCordoned) return current;
  await keepTransactionLeasesFresh(lease, deadlineAt);
  const operation = desiredCordoned ? "cordon" : "uncordon";
  await client[operation](
    app,
    machineId,
    lease.nonce,
    deadlineAt,
    `${label}/${operation}`
  );
  return pollMachine({
    app,
    client,
    deadlineAt,
    label: `${label}/${operation}/verify`,
    lease,
    machineId,
    predicate(machine) {
      return (
        machine.state === current.state &&
        machine.cordoned === desiredCordoned &&
        isDeepStrictEqual(machine.config, current.config) &&
        expectedImage(machine)
      );
    },
  });
}

async function transitionToExactState({
  app,
  client,
  config,
  current,
  deadlineAt,
  desiredCordoned,
  desiredState,
  expectedImage,
  label,
  lease,
  machineId,
  minSecretsVersion,
}) {
  if (current.state === desiredState) {
    return setCordonState({
      app,
      client,
      current,
      deadlineAt,
      desiredCordoned,
      expectedImage,
      label,
      lease,
      machineId,
    });
  }

  if (desiredState === "created") {
    requireCondition(current.state === "stopped", `${label}/created/from-state`);
    current = await setCordonState({
      app,
      client,
      current,
      deadlineAt,
      desiredCordoned,
      expectedImage,
      label: `${label}/created/safety`,
      lease,
      machineId,
    });
    await keepTransactionLeasesFresh(lease, deadlineAt);
    const retried = await client.update(
      app,
      machineId,
      lease.nonce,
      {
        config: cloneJson(config, `${label}/created/retry-config`),
        current_version: current.instance_id,
        skip_launch: true,
        min_secrets_version: minSecretsVersion,
      },
      deadlineAt,
      `${label}/created/retry`
    );
    requireCondition(
      isRecord(retried) && typeof retried.instance_id === "string",
      `${label}/created/retry-response`
    );
    return pollMachine({
      app,
      client,
      deadlineAt,
      label: `${label}/created`,
      lease,
      machineId,
      predicate(machine) {
        return (
          machine.state === "created" &&
          machine.cordoned === desiredCordoned &&
          machine.instance_id === retried.instance_id &&
          isDeepStrictEqual(machine.config, config) &&
          expectedImage(machine)
        );
      },
    });
  }

  requireCondition(desiredState === "stopped", `${label}/target-state`);
  requireCondition(current.state === "created", `${label}/stopped/from-state`);
  current = await setCordonState({
    app,
    client,
    current,
    deadlineAt,
    desiredCordoned: true,
    expectedImage,
    label: `${label}/stopped/safety`,
    lease,
    machineId,
  });
  await keepTransactionLeasesFresh(lease, deadlineAt);
  await client.start(
    app,
    machineId,
    lease.nonce,
    deadlineAt,
    `${label}/stopped/start`
  );
  const started = await pollMachine({
    app,
    client,
    deadlineAt,
    label: `${label}/stopped/started`,
    lease,
    machineId,
    predicate(machine) {
      return (
        machine.state === "started" &&
        machine.cordoned === true &&
        isDeepStrictEqual(machine.config, config) &&
        expectedImage(machine)
      );
    },
  });
  await keepTransactionLeasesFresh(lease, deadlineAt);
  await client.stop(
    app,
    machineId,
    lease.nonce,
    deadlineAt,
    `${label}/stopped/stop`
  );
  current = await pollMachine({
    app,
    client,
    deadlineAt,
    label: `${label}/stopped/verify`,
    lease,
    machineId,
    predicate(machine) {
      return (
        machine.state === "stopped" &&
        machine.cordoned === true &&
        machine.instance_id === started.instance_id &&
        isDeepStrictEqual(machine.config, config) &&
        expectedImage(machine)
      );
    },
  });
  return setCordonState({
    app,
    client,
    current,
    deadlineAt,
    desiredCordoned,
    expectedImage,
    label: `${label}/stopped/final-cordon`,
    lease,
    machineId,
  });
}

async function restoreSnapshot({ app, client, deadlineAt, entry, minSecretsVersion }) {
  const { lease, snapshot } = entry;
  requireCondition(lease instanceof LeaseSession && !lease.closed, `rollback/${snapshot.id}/lease`);
  await keepTransactionLeasesFresh(lease, deadlineAt);
  const fresh = validateMachine(
    await client.get(app, snapshot.id, deadlineAt, `rollback/${snapshot.id}/fresh`),
    `rollback/${snapshot.id}/fresh`,
    { allowTransient: true }
  );
  const restored = await client.update(
    app,
    snapshot.id,
    lease.nonce,
    {
      config: cloneJson(snapshot.config, `rollback/${snapshot.id}/config`),
      current_version: fresh.instance_id,
      skip_launch: snapshot.state !== "started",
      min_secrets_version: minSecretsVersion,
    },
    deadlineAt,
    `rollback/${snapshot.id}/update`
  );
  requireCondition(isRecord(restored) && restored.id === snapshot.id, `rollback/${snapshot.id}/identity`);
  requireCondition(
    typeof restored.instance_id === "string" && restored.instance_id.length > 0,
    `rollback/${snapshot.id}/instance`
  );

  let current;
  if (snapshot.state === "started") {
    current = await waitForStarted({
      app,
      client,
      config: snapshot.config,
      cordoned: snapshot.cordoned,
      deadlineAt,
      expectedImage: (machine) => matchesSnapshotImage(machine, snapshot),
      instanceId: restored.instance_id,
      label: `rollback/${snapshot.id}`,
      lease,
      machineId: snapshot.id,
    });
  } else {
    current = await waitForNonRunning({
      app,
      client,
      config: snapshot.config,
      deadlineAt,
      expectedImage: (machine) => matchesSnapshotImage(machine, snapshot),
      instanceId: restored.instance_id,
      label: `rollback/${snapshot.id}`,
      lease,
      machineId: snapshot.id,
    });
    current = await transitionToExactState({
      app,
      client,
      config: snapshot.config,
      current,
      deadlineAt,
      desiredCordoned: snapshot.cordoned,
      desiredState: snapshot.state,
      expectedImage: (machine) => matchesSnapshotImage(machine, snapshot),
      label: `rollback/${snapshot.id}`,
      lease,
      machineId: snapshot.id,
      minSecretsVersion,
    });
  }
  requireCondition(current.state === snapshot.state, `rollback/${snapshot.id}/state`);
  requireCondition(current.cordoned === snapshot.cordoned, `rollback/${snapshot.id}/cordoned`);
}

async function verifyOriginalFleet({ app, canaryRecord, client, deadlineAt, label, snapshots }) {
  const listed = activeMachines(await client.list(app, deadlineAt, label), label);
  const expectedIds = expectedActiveIds(snapshots, canaryRecord);
  requireCondition(listed.length === expectedIds.size, `${label}/machine-set`);
  requireCondition(listed.every((machine) => expectedIds.has(machine.id)), `${label}/machine-set`);
  const byId = new Map(listed.map((machine) => [machine.id, machine]));
  for (let index = 0; index < snapshots.length; index += 1) {
    const snapshot = snapshots[index];
    const machine = byId.get(snapshot.id);
    requireCondition(machine !== undefined, `${label}/machine-${index + 1}/missing`);
    requireCondition(machine.state === snapshot.state, `${label}/machine-${index + 1}/state`);
    requireCondition(machine.cordoned === snapshot.cordoned, `${label}/machine-${index + 1}/cordoned`);
    requireCondition(machine.region === snapshot.region, `${label}/machine-${index + 1}/region`);
    requireCondition((machine.name ?? null) === snapshot.name, `${label}/machine-${index + 1}/name`);
    requireCondition(
      isDeepStrictEqual(machine.config, snapshot.config),
      `${label}/machine-${index + 1}/config`
    );
    requireCondition(
      matchesSnapshotImage(machine, snapshot),
      `${label}/machine-${index + 1}/image`
    );
    if (machine.state === "started") {
      requireCondition(healthChecksPass(machine), `${label}/machine-${index + 1}/health`);
    }
  }
  if (canaryRecord?.id && !["absent", "removed"].includes(canaryRecord.status)) {
    const machine = byId.get(canaryRecord.id);
    requireCondition(machine !== undefined, `${label}/canary/missing`);
    requireCondition(canaryIdentityMatches(machine, canaryRecord), `${label}/canary/identity`);
    if (canaryRecord.status === "serving") {
      requireCondition(canaryLifecycleDisabled(machine), `${label}/canary/autostop`);
      requireCondition(isServingMachine(machine, canaryRecord.source), `${label}/canary/routing`);
    }
  }
  requireCondition(
    snapshots.some((snapshot) => snapshot.state === "started") &&
      listed.some((machine) => isServingMachine(machine)),
    `${label}/zero-serving`
  );
}

async function rollbackTransaction({
  app,
  canaryRecord,
  client,
  deadlineAt,
  leases,
  mutationJournal,
  originalIds,
  preflightMinSecretsVersion,
  snapshots,
}) {
  let rollbackFailed = false;
  let minSecretsVersion = preflightMinSecretsVersion;
  try {
    minSecretsVersion = requireSecretsVersion(
      await client.synchronizeSecretsVersion(app, deadlineAt, "rollback/secrets-sync"),
      "rollback/secrets-sync"
    );
  } catch (_error) {
    minSecretsVersion = preflightMinSecretsVersion;
  }

  for (let index = mutationJournal.length - 1; index >= 0; index -= 1) {
    try {
      await leases.ensureAllFresh(deadlineAt);
      await restoreSnapshot({
        app,
        client,
        deadlineAt,
        entry: mutationJournal[index],
        minSecretsVersion,
      });
    } catch (_error) {
      rollbackFailed = true;
    }
  }

  if (canaryRecord && canaryRecord.status === "unknown") {
    try {
      const located = await locateCanary({
        app,
        client,
        deadlineAt,
        record: canaryRecord,
        originalIds,
        label: "rollback/reconcile-canary",
      });
      if (located === null) {
        canaryRecord.cleanupState = "preflight-metadata-reconciliation-required";
        rollbackFailed = true;
      } else {
        canaryRecord.id = located.id;
        canaryRecord.status = "tracked";
        canaryRecord.cleanupState = "tracked";
        canaryRecord.lease = await leases.acquire(
          located.id,
          deadlineAt,
          "rollback/canary/lease"
        );
      }
    } catch (_error) {
      rollbackFailed = true;
    }
  }

  try {
    await verifyOriginalFleet({
      app,
      canaryRecord,
      client,
      deadlineAt,
      label: "rollback/verify-originals",
      snapshots,
    });
  } catch (_error) {
    rollbackFailed = true;
  }

  // Preserve the temporary healthy peer if the serving originals were not restored.
  if (rollbackFailed) throw new RolloutFailure(EMERGENCY_CODE);

  if (canaryRecord && !["absent", "removed"].includes(canaryRecord.status)) {
    try {
      await removeCanary({
        app,
        canaryRecord,
        client,
        deadlineAt,
        leases,
        originalIds,
      });
    } catch (_error) {
      throw new RolloutFailure(EMERGENCY_CODE);
    }
  }

  try {
    await verifyOriginalFleet({
      app,
      canaryRecord: null,
      client,
      deadlineAt,
      label: "rollback/verify-final",
      snapshots,
    });
  } catch (_error) {
    throw new RolloutFailure(EMERGENCY_CODE);
  }
  try {
    await leases.releaseAllAfterReconciled(deadlineAt);
  } catch (_error) {
    throw new RolloutFailure(EMERGENCY_CODE);
  }
}

async function runRollout({ app, image, token, deadlineMs, client, log = console.log }) {
  validateAppName(app);
  const expected = parseImageReference(image, app);
  requireCondition(
    Number.isSafeInteger(deadlineMs) && deadlineMs >= 10_000 && deadlineMs <= MAX_ROLLOUT_DEADLINE_MS,
    "arguments/deadline-ms"
  );
  const machinesClient = client || new MachinesClient({ token });
  const startedAt = machinesClient.now();
  const deadlineAt = startedAt + deadlineMs;
  const leases = new LeaseRegistry({ app, client: machinesClient });
  const initial = await reconcileStaleCanaries({
    app,
    client: machinesClient,
    deadlineAt,
    leases,
  });
  requireCondition(initial.some((machine) => isServingMachine(machine)), "initial/zero-serving");
  initial.forEach((machine, index) => {
    requireCondition(processGroup(machine.config) !== null, `initial/machine-${index + 1}/process-group`);
    serviceRoutingTopology(machine.config, `initial/machine-${index + 1}/topology`);
    requireCondition(
      configuredCheckNames(machine.config, `initial/machine-${index + 1}/checks`).length > 0,
      `initial/machine-${index + 1}/checks`
    );
  });

  const snapshots = initial.map((machine, index) =>
    snapshotMachine(machine, `initial/machine-${index + 1}`)
  );
  const originalIds = new Set(snapshots.map((snapshot) => snapshot.id));
  const mutationJournal = [];
  let canaryRecord = null;
  const preflightDeadlineAt = requireForwardDeadline({
    canaryRecord,
    client: machinesClient,
    deadlineAt,
    fleetSize: snapshots.length,
    mutationJournal,
  });
  const preflightMinSecretsVersion = requireSecretsVersion(
    await machinesClient.synchronizeSecretsVersion(
      app,
      preflightDeadlineAt,
      "secrets-sync"
    ),
    "secrets-sync"
  );

  const ordered = [...snapshots].sort((left, right) => {
    const leftRunning = left.state === "started";
    const rightRunning = right.state === "started";
    if (leftRunning !== rightRunning) return leftRunning ? 1 : -1;
    return left.id.localeCompare(right.id);
  });
  const startedNeedingUpdate = ordered.filter(
    (snapshot) =>
      snapshot.state === "started" &&
      !matchesImage(initial.find((machine) => machine.id === snapshot.id), expected)
  );
  const serving = initial.filter((machine) => isServingMachine(machine));
  let updatedCount = 0;

  try {
    const soleServing = serving.length === 1 ? serving[0] : null;
    if (
      soleServing &&
      startedNeedingUpdate.some((snapshot) => snapshot.id === soleServing.id)
    ) {
      const source = snapshots.find((snapshot) => snapshot.id === soleServing.id);
      canaryRecord = prepareCanaryRecord(source, expected);
      canaryRecord = await createCanary({
        app,
        canaryRecord,
        client: machinesClient,
        deadlineAt,
        expected,
        fleetSize: snapshots.length,
        leases,
        minSecretsVersion: preflightMinSecretsVersion,
        mutationJournal,
        originalIds,
      });
      log("Fly Machines rollout: temporary serving canary verified.");
    }

    for (let index = 0; index < ordered.length; index += 1) {
      const snapshot = ordered[index];
      const original = initial.find((machine) => machine.id === snapshot.id);
      if (matchesImage(original, expected)) continue;
      if (snapshot.state === "started") {
        const availabilityDeadlineAt = requireForwardDeadline({
          canaryRecord,
          client: machinesClient,
          deadlineAt,
          fleetSize: snapshots.length,
          mutationJournal,
        });
        await requireServingPeer({
          app,
          canaryRecord,
          client: machinesClient,
          deadlineAt: availabilityDeadlineAt,
          snapshots,
          targetId: snapshot.id,
        });
      }
      const updated = await updateOriginal({
        app,
        canaryRecord,
        client: machinesClient,
        deadlineAt,
        expected,
        fleetSize: snapshots.length,
        leases,
        minSecretsVersion: preflightMinSecretsVersion,
        mutationJournal,
        ordinal: index + 1,
        snapshot,
      });
      if (updated) {
        updatedCount += 1;
        log(`Fly Machines rollout: verified machine ${index + 1}/${ordered.length}.`);
      }
    }

    let attestationDeadlineAt = requireForwardDeadline({
      canaryRecord,
      client: machinesClient,
      deadlineAt,
      fleetSize: snapshots.length,
      mutationJournal,
    });
    await verifyReleaseFleet({
      app,
      canaryRecord,
      client: machinesClient,
      deadlineAt: attestationDeadlineAt,
      expected,
      label: "attestation/with-canary",
      snapshots,
    });

    if (canaryRecord && !["absent", "removed"].includes(canaryRecord.status)) {
      await removeCanary({
        app,
        canaryRecord,
        client: machinesClient,
        deadlineAt: attestationDeadlineAt,
        leases,
        originalIds,
      });
    }

    attestationDeadlineAt = requireForwardDeadline({
      canaryRecord,
      client: machinesClient,
      deadlineAt,
      fleetSize: snapshots.length,
      mutationJournal,
    });
    await verifyReleaseFleet({
      app,
      canaryRecord: null,
      client: machinesClient,
      deadlineAt: attestationDeadlineAt,
      expected,
      label: "attestation/final",
      snapshots,
    });
  } catch (error) {
    const failure = normalizeFailure(error, "rollout/internal");
    if (leases.order.length > 0 || mutationJournal.length > 0 || canaryRecord !== null) {
      try {
        await rollbackTransaction({
          app,
          canaryRecord,
          client: machinesClient,
          deadlineAt,
          leases,
          mutationJournal,
          originalIds,
          preflightMinSecretsVersion,
          snapshots,
        });
      } catch (_rollbackError) {
        throw new RolloutFailure(EMERGENCY_CODE);
      }
      if (mutationJournal.length > 0) throw new RolloutFailure("rollout/reverted");
    }
    throw failure;
  }

  try {
    await leases.releaseAllAfterReconciled(deadlineAt);
  } catch (_error) {
    throw new RolloutFailure(EMERGENCY_CODE);
  }

  log(`Fly Machines rollout passed: ${snapshots.length} machine(s), exact digest verified.`);
  return { machineCount: snapshots.length, updatedCount, digest: expected.digest };
}

function requireReleaseContext(environment, expected) {
  requireCondition(environment.GITHUB_ACTIONS === "true", "release-context/actions");
  requireCondition(environment.GITHUB_REF === "refs/heads/main", "release-context/ref");
  requireCondition(environment.JUMPGATE_REF_PROTECTED === "true", "release-context/protected");
  requireCondition(
    environment.JUMPGATE_PRODUCTION_RELEASE === "true",
    "release-context/production"
  );
  requireCondition(environment.GITHUB_SHA === expected.buildSha, "release-context/sha");
}

async function main() {
  const args = process.argv.slice(2);
  const app = validateAppName(readArgument(args, "app"));
  const image = readArgument(args, "image");
  const expected = parseImageReference(image, app);
  requireReleaseContext(process.env, expected);
  const deadlineMs = readIntegerArgument(args, "deadline-ms", 10_000, MAX_ROLLOUT_DEADLINE_MS);
  await runRollout({
    app,
    image,
    token: process.env.FLY_API_TOKEN,
    deadlineMs,
  });
}

if (require.main === module) {
  main().catch((error) => {
    const label = error instanceof RolloutFailure ? error.message : "internal";
    console.error(`Fly Machines rollout failed: ${label}`);
    process.exitCode = 1;
  });
}

module.exports = {
  EMERGENCY_CODE,
  LEASE_TTL_SECONDS,
  MachinesClient,
  REQUEST_TIMEOUT_MS,
  RolloutFailure,
  SERVER_WAIT_SECONDS,
  activeMachines,
  healthChecksPass,
  matchesImage,
  parseImageReference,
  requireReleaseContext,
  runRollout,
};
