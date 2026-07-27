"use strict";

const fs = require("node:fs");
const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const { parse } = require("smol-toml");

const PACKAGE_VERSION = require("../../package.json").version;

const execFileAsync = promisify(execFile);
const IMAGE_PATTERN = /^registry\.fly\.io\/([a-z0-9-]+):git-([a-f0-9]{40})@(sha256:[a-f0-9]{64})$/;
const MACHINE_ID_PATTERN = /^[a-f0-9]{14}$/;
const CLAIM_WRITER_ROLLOUT_ENV = "JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE";
const RELEASE_COMMAND = "node scripts/production-release-protocols.js apply-env";
const PROTOCOL_STATUS_COMMAND = "node scripts/playback-claim-writer-protocol.js status";
const PROTOCOL_STATUS_MARKER = "JUMPGATE_WRITER_PROTOCOL_STATUS_JSON=";
const MACHINE_VERSION_COMMAND =
  "node -e '" +
  'const maximum=16384;fetch("http://127.0.0.1:7515/version",' +
  '{redirect:"error",signal:AbortSignal.timeout(5000)}).then(async(response)=>{' +
  'if(response.status!==200||!response.body)throw new Error();' +
  'const reader=response.body.getReader();const chunks=[];let length=0;' +
  'for(;;){const result=await reader.read();if(result.done)break;' +
  'length+=result.value.byteLength;if(length>maximum)throw new Error();' +
  'chunks.push(Buffer.from(result.value))}' +
  'process.stdout.write(Buffer.concat(chunks,length))}).catch(()=>process.exit(1))' +
  "'";
const CANDIDATE_PROTOCOL_STATUS_COMMAND =
  "/bin/sh -lc '" +
  'status="$(' + PROTOCOL_STATUS_COMMAND + ')" || exit $?; ' +
  'printf "%s\\n" "$status" | sed "s/^/' + PROTOCOL_STATUS_MARKER + '/"' +
  "'";
const ROLLOUT_PHASES = new Set(["transition", "v6"]);
const REQUIRED_ENV = Object.freeze({
  JUMPGATE_DURABLE_DRIVER: "postgres",
  JUMPGATE_POSTGRES_MIGRATION_CEILING: "0011_history_http_receipts",
  JUMPGATE_PROVIDER_MUTATION_MODE: "fenced",
  JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE: "v6",
  JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION: "4",
  JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
  JUMPGATE_TTL_DRIVER: "redis",
  NODE_ENV: "production",
});
const DEFAULT_INTERVALS = 3;
const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_CONVERGENCE_POLLS = 24;
const DEFAULT_CONVERGENCE_DELAY_MS = 5_000;
const MAX_MACHINE_LIST_BYTES = 4 * 1024 * 1024;
const MAX_MACHINE_COMMAND_BYTES = 64 * 1024;
const MACHINE_LIST_TIMEOUT_MS = 15_000;
const MACHINE_START_TIMEOUT_MS = 60_000;
const MAX_PROTOCOL_STATUS_BYTES = 16 * 1024;
const MAX_MACHINE_VERSION_BYTES = 16 * 1024;
const MACHINE_VERSION_PROBE_TIMEOUT_MS = 15_000;
const PROTOCOL_PROBE_MACHINE_LIFETIME_SECONDS = 300;
const PROTOCOL_PROBE_TIMEOUT_MS = 4 * 60 * 1000;

function rolloutError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireCondition(condition, message, code = "fly_rollout_invalid") {
  if (!condition) throw rolloutError(code, message);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactString(value, name) {
  requireCondition(typeof value === "string" && value.length > 0, name + " is invalid");
  return value;
}

function exactInteger(value, name, minimum, maximum) {
  requireCondition(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    name + " is invalid"
  );
  return value;
}

function exactMachineId(value) {
  requireCondition(
    typeof value === "string" && MACHINE_ID_PATTERN.test(value),
    "Fly Machine id is invalid"
  );
  return value;
}

function readToml(filename) {
  const bytes = fs.readFileSync(filename);
  requireCondition(bytes.length > 0 && bytes.length <= 1024 * 1024, "fly.toml size is invalid");
  requireCondition(!bytes.includes(0), "fly.toml contains NUL bytes");
  try {
    return parse(bytes.toString("utf8"));
  } catch (_error) {
    throw rolloutError("fly_config_invalid", "fly.toml could not be parsed");
  }
}

function normalizeDesiredCheck(check, internalPort) {
  requireCondition(isRecord(check), "Fly service check is invalid");
  requireCondition(check.method === "GET", "Fly service check method must be GET");
  requireCondition(check.path === "/health/ready", "Fly service check path is invalid");
  return Object.freeze({
    type: "http",
    method: "GET",
    path: check.path,
    port: internalPort,
    gracePeriod: exactString(check.grace_period, "Fly service check grace period"),
    interval: exactString(check.interval, "Fly service check interval"),
    timeout: exactString(check.timeout, "Fly service check timeout"),
  });
}

function loadDesiredState(filename, expectedApp) {
  const config = readToml(filename);
  const app = exactString(config.app, "Fly app");
  requireCondition(app === expectedApp, "Fly app does not match the managed deployment");
  const primaryRegion = exactString(config.primary_region, "Fly primary region");
  requireCondition(/^[a-z0-9]{3}$/.test(primaryRegion), "Fly primary region is invalid");
  requireCondition(isRecord(config.env), "Fly environment is missing");
  const env = {};
  for (const [name, value] of Object.entries(config.env)) {
    requireCondition(/^[A-Z][A-Z0-9_]*$/.test(name), "Fly environment name is invalid");
    env[name] = String(value);
  }
  for (const [name, value] of Object.entries(REQUIRED_ENV)) {
    requireCondition(env[name] === value, "Fly environment is not at the checked-in protocol ceiling");
  }
  requireCondition(isRecord(config.deploy), "Fly deploy configuration is missing");
  requireCondition(
    config.deploy.release_command === RELEASE_COMMAND,
    "Fly release command is not the guarded storage protocol transition"
  );

  const service = config.http_service;
  requireCondition(isRecord(service), "Fly http_service is missing");
  const internalPort = exactInteger(service.internal_port, "Fly internal port", 1, 65535);
  const minMachinesRunning = exactInteger(
    service.min_machines_running,
    "Fly minimum Machines",
    2,
    64
  );
  requireCondition(minMachinesRunning === 2, "Fly requires exactly two minimum serving Machines");
  requireCondition(service.force_https === true, "Fly force_https must be enabled");
  requireCondition(service.auto_start_machines === true, "Fly auto-start must be enabled");
  requireCondition(service.auto_stop_machines === "stop", "Fly auto-stop mode must be stop");
  requireCondition(
    Array.isArray(service.processes) &&
      service.processes.length === 1 &&
      service.processes[0] === "app",
    "Fly service process group must be app"
  );
  requireCondition(
    Array.isArray(service.checks) && service.checks.length === 1,
    "Fly requires one readiness service check"
  );
  const check = normalizeDesiredCheck(service.checks[0], internalPort);
  requireCondition(Array.isArray(config.vm) && config.vm.length === 1, "Fly VM shape is invalid");
  const vm = config.vm[0];
  requireCondition(isRecord(vm), "Fly VM configuration is invalid");
  requireCondition(vm.memory === "1gb", "Fly VM memory declaration is invalid");
  const guest = Object.freeze({
    cpuKind: exactString(vm.cpu_kind, "Fly VM CPU kind"),
    cpus: exactInteger(vm.cpus, "Fly VM CPU count", 1, 64),
    memoryMb: exactInteger(vm.memory_mb, "Fly VM memory", 256, 262_144),
  });

  return Object.freeze({
    app,
    env: Object.freeze(env),
    guest,
    processGroup: "app",
    internalPort,
    minMachinesRunning,
    primaryRegion,
    autoStart: true,
    autoStop: "stop",
    ports: Object.freeze([
      Object.freeze({ port: 80, handlers: Object.freeze(["http"]), forceHttps: true }),
      Object.freeze({ port: 443, handlers: Object.freeze(["http", "tls"]), forceHttps: false }),
    ]),
    checks: Object.freeze([check]),
    releaseCommand: RELEASE_COMMAND,
    permanentErasureMode: env.JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE,
  });
}

function desiredStateForPhase(desired, phase) {
  requireCondition(isRecord(desired), "desired Fly state is invalid");
  requireCondition(
    typeof phase === "string" && ROLLOUT_PHASES.has(phase),
    "managed rollout phase must be transition or v6",
    "fly_arguments_invalid"
  );
  return Object.freeze({
    ...desired,
    env: Object.freeze({
      ...desired.env,
      [CLAIM_WRITER_ROLLOUT_ENV]: phase,
    }),
    rolloutPhase: phase,
  });
}

function assertDeployable(desired) {
  requireCondition(isRecord(desired), "desired Fly state is invalid");
  if (
    desired.permanentErasureMode ===
    "blocked-tigris-provider-confirmation-required"
  ) {
    throw rolloutError(
      "subtitle_permanent_erasure_unverifiable",
      "Tigris cannot attest or purge soft-deleted subtitle bytes; provider confirmation is required"
    );
  }
  for (const [name, value] of Object.entries(REQUIRED_ENV)) {
    requireCondition(desired.env?.[name] === value, "desired Fly protocol state is invalid");
  }
  requireCondition(desired.minMachinesRunning === 2, "desired Fly fleet is below two Machines");
  return desired;
}

function parseImage(image, app) {
  const match = IMAGE_PATTERN.exec(image);
  requireCondition(match && match[1] === app, "immutable image reference is invalid");
  return { value: image, buildSha: match[2], digest: match[3] };
}

function machineProcessGroup(machine) {
  const metadata = machine.config?.metadata;
  if (!isRecord(metadata)) return null;
  const hasFlyProcessGroup = Object.prototype.hasOwnProperty.call(metadata, "fly_process_group");
  const hasProcessGroup = Object.prototype.hasOwnProperty.call(metadata, "process_group");
  if (hasFlyProcessGroup && hasProcessGroup) {
    if (metadata.fly_process_group !== metadata.process_group) return null;
    return metadata.fly_process_group;
  }
  if (hasFlyProcessGroup) return metadata.fly_process_group;
  if (hasProcessGroup) return metadata.process_group;
  return null;
}

function collectServingMachines(machines, expectedProcessGroup) {
  requireCondition(Array.isArray(machines), "Fly Machine sample is invalid");
  requireCondition(
    typeof expectedProcessGroup === "string" && expectedProcessGroup.length > 0,
    "expected Fly process group is invalid"
  );
  const seen = new Set();
  const serving = [];
  for (const machine of machines) {
    requireCondition(isRecord(machine), "Fly Machine is invalid");
    exactMachineId(machine.id);
    requireCondition(!seen.has(machine.id), "Fly Machine sample contains duplicate ids");
    seen.add(machine.id);
    if (machine.state === "destroyed") continue;

    requireCondition(isRecord(machine.config), "Machine configuration is missing");
    const processGroup = machineProcessGroup(machine);
    const serviceBearing =
      Array.isArray(machine.config.services) && machine.config.services.length > 0;
    if (machine.state === "started" && serviceBearing) {
      requireCondition(
        processGroup === expectedProcessGroup,
        "started service-bearing Machine is outside the managed app process group"
      );
    }
    requireCondition(
      machine.state === "started",
      "Fly fleet contains a non-serving extra Machine"
    );
    requireCondition(
      processGroup === expectedProcessGroup,
      "Fly fleet contains an unexpected Machine process group"
    );
    requireCondition(serviceBearing, "Fly fleet contains a started Machine without the managed service");
    serving.push(machine);
  }
  serving.sort((left, right) => left.id.localeCompare(right.id));
  requireCondition(
    serving.length === 2,
    "fleet attestation requires exactly two serving app Machines"
  );
  return serving;
}

function assertMachineEnv(machine, desired) {
  requireCondition(isRecord(machine.config.env), "Machine environment is missing");
  const actual = { ...machine.config.env };
  if (Object.prototype.hasOwnProperty.call(actual, "PRIMARY_REGION")) {
    requireCondition(
      actual.PRIMARY_REGION === desired.primaryRegion,
      "Machine derived primary region is invalid"
    );
    delete actual.PRIMARY_REGION;
  }
  requireCondition(
    Object.prototype.hasOwnProperty.call(actual, "FLY_PROCESS_GROUP") &&
      actual.FLY_PROCESS_GROUP === desired.processGroup,
    "Machine derived process group is invalid"
  );
  delete actual.FLY_PROCESS_GROUP;
  requireCondition(
    JSON.stringify(Object.keys(actual).sort()) ===
      JSON.stringify(Object.keys(desired.env).sort()),
    "Machine environment contains state outside checked-in Fly configuration"
  );
  for (const [name, value] of Object.entries(desired.env)) {
    requireCondition(
      String(actual[name]) === value,
      "Machine environment does not match checked-in desired state"
    );
  }
}

function assertMachineGuest(machine, desired) {
  const guest = machine.config.guest;
  requireCondition(isRecord(guest), "Machine guest configuration is missing");
  requireCondition(guest.cpu_kind === desired.guest.cpuKind, "Machine CPU kind is invalid");
  requireCondition(guest.cpus === desired.guest.cpus, "Machine CPU count is invalid");
  requireCondition(guest.memory_mb === desired.guest.memoryMb, "Machine memory is invalid");
}

function servicePorts(service, desired) {
  requireCondition(Array.isArray(service.ports), "Machine service ports are missing");
  const ports = service.ports.map((entry) => {
    requireCondition(isRecord(entry), "Machine service port is invalid");
    const port = exactInteger(entry.port, "Machine service port", 1, 65535);
    requireCondition(Array.isArray(entry.handlers), "Machine service handlers are missing");
    const handlers = entry.handlers.map((handler) => exactString(handler, "Machine service handler"));
    requireCondition(new Set(handlers).size === handlers.length, "Machine service handlers are duplicated");
    return {
      port,
      handlers: handlers.sort(),
      forceHttps: entry.force_https === true,
    };
  }).sort((left, right) => left.port - right.port);
  requireCondition(
    JSON.stringify(ports) === JSON.stringify(desired.ports),
    "Machine service public ports are invalid"
  );
  return ports;
}

function assertMachineService(machine, desired) {
  const services = machine.config.services;
  requireCondition(Array.isArray(services) && services.length === 1, "Machine services are invalid");
  const service = services[0];
  requireCondition(isRecord(service), "Machine service is invalid");
  requireCondition(service.protocol === "tcp", "Machine service protocol is invalid");
  requireCondition(
    service.internal_port === desired.internalPort,
    "Machine service internal port is invalid"
  );
  requireCondition(
    service.min_machines_running === desired.minMachinesRunning,
    "Machine service minimum fleet is invalid"
  );
  requireCondition(service.autostart === desired.autoStart, "Machine auto-start policy is invalid");
  requireCondition(
    desired.autoStop === "stop" && service.autostop === true,
    "Machine auto-stop policy is invalid"
  );
  servicePorts(service, desired);
  requireCondition(
    Array.isArray(service.checks) && service.checks.length === desired.checks.length,
    "Machine service checks are invalid"
  );
  for (let index = 0; index < desired.checks.length; index += 1) {
    const actual = service.checks[index];
    const expected = desired.checks[index];
    requireCondition(isRecord(actual), "Machine service check is invalid");
    requireCondition(actual.type === expected.type, "Machine service check type is invalid");
    requireCondition(actual.method === expected.method, "Machine service check method is invalid");
    requireCondition(actual.path === expected.path, "Machine service check path is invalid");
    requireCondition(
      (actual.port ?? service.internal_port) === expected.port,
      "Machine service check port is invalid"
    );
    requireCondition(
      actual.grace_period === expected.gracePeriod,
      "Machine service check grace period is invalid"
    );
    requireCondition(actual.interval === expected.interval, "Machine service check interval is invalid");
    requireCondition(actual.timeout === expected.timeout, "Machine service check timeout is invalid");
  }
}

function machineServiceHealthPassing(machine, desired) {
  requireCondition(
    Array.isArray(machine.checks) && machine.checks.length === desired.checks.length,
    "Machine service check result is missing"
  );
  const expectedNames = desired.checks.map((check, index) =>
    `servicecheck-${String(index).padStart(2, "0")}-${check.type}-${check.port}`
  );
  const checksByName = new Map();
  for (const check of machine.checks) {
    requireCondition(
      isRecord(check) && typeof check.name === "string" && !checksByName.has(check.name),
      "Machine service check result is invalid"
    );
    checksByName.set(check.name, check.status);
  }
  for (const name of expectedNames) {
    const status = checksByName.get(name);
    requireCondition(
      status === "passing" || status === "warning" || status === "critical",
      "Machine service check result status is invalid"
    );
  }
  return expectedNames.every((name) => checksByName.get(name) === "passing");
}

function assertServiceHealth(machine, desired) {
  requireCondition(machineServiceHealthPassing(machine, desired), "Machine service check is not passing");
}

function assertMachineDefinition(machine, desired, expectedImage) {
  requireCondition(machine.cordoned === false, "serving Machine is cordoned");
  requireCondition(machine.config.image === expectedImage.value, "Machine immutable image differs");
  requireCondition(
    machine.image_ref?.digest === expectedImage.digest,
    "Machine immutable image digest differs"
  );
  assertMachineEnv(machine, desired);
  assertMachineGuest(machine, desired);
  assertMachineService(machine, desired);
}

function validateFleetSample(machines, desired, image) {
  const expectedImage = parseImage(image, desired.app);
  const serving = collectServingMachines(machines, desired.processGroup);
  for (const machine of serving) {
    assertMachineDefinition(machine, desired, expectedImage);
    assertServiceHealth(machine, desired);
  }
  return serving.map((machine) => machine.id);
}

function collectConvergenceMachines(machines, expectedProcessGroup) {
  requireCondition(Array.isArray(machines), "Fly Machine sample is invalid");
  requireCondition(
    typeof expectedProcessGroup === "string" && expectedProcessGroup.length > 0,
    "expected Fly process group is invalid"
  );
  const seen = new Set();
  const candidates = [];
  for (const machine of machines) {
    requireCondition(isRecord(machine), "Fly Machine is invalid");
    exactMachineId(machine.id);
    requireCondition(!seen.has(machine.id), "Fly Machine sample contains duplicate ids");
    seen.add(machine.id);
    if (machine.state === "destroyed") continue;

    requireCondition(isRecord(machine.config), "Machine configuration is missing");
    requireCondition(
      machine.state === "started" || machine.state === "stopped",
      "Fly convergence contains an invalid Machine state"
    );
    requireCondition(
      machineProcessGroup(machine) === expectedProcessGroup,
      "Fly convergence contains an unexpected Machine process group"
    );
    requireCondition(
      Array.isArray(machine.config.services) && machine.config.services.length > 0,
      "Fly convergence contains a Machine without the managed service"
    );
    candidates.push(machine);
  }
  candidates.sort((left, right) => left.id.localeCompare(right.id));
  requireCondition(
    candidates.length === 2,
    "fleet convergence requires exactly two app Machines"
  );
  return candidates;
}

function validateConvergenceSample(machines, desired, image) {
  const expectedImage = parseImage(image, desired.app);
  const candidates = collectConvergenceMachines(machines, desired.processGroup);
  for (const machine of candidates) {
    assertMachineDefinition(machine, desired, expectedImage);
    machineServiceHealthPassing(machine, desired);
  }
  return candidates;
}

function normalizeProtocolStatus(value) {
  requireCondition(isRecord(value), "writer protocol status is invalid", "fly_protocol_status_invalid");
  requireCondition(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(["action", "changed", "state", "version"]),
    "writer protocol status shape is invalid",
    "fly_protocol_status_invalid"
  );
  requireCondition(
    value.action === "status" && value.changed === false,
    "writer protocol status identity is invalid",
    "fly_protocol_status_invalid"
  );
  if (value.state === "ready" && (value.version === "5" || value.version === "6")) {
    return Object.freeze({ ...value });
  }
  if (
    (value.state === "missing" || value.state === "malformed" || value.state === "wrong_type") &&
    value.version === null
  ) {
    return Object.freeze({ ...value });
  }
  throw rolloutError("fly_protocol_status_invalid", "writer protocol status value is invalid");
}

function parseProtocolStatusOutput(stdout) {
  requireCondition(
    typeof stdout === "string" && Buffer.byteLength(stdout, "utf8") <= MAX_PROTOCOL_STATUS_BYTES,
    "writer protocol status output is invalid",
    "fly_protocol_status_invalid"
  );
  const text = stdout.trim();
  requireCondition(
    text.length > 0 && !text.includes("\n") && !text.includes("\r"),
    "writer protocol status output is not a single record",
    "fly_protocol_status_invalid"
  );
  try {
    return normalizeProtocolStatus(JSON.parse(text));
  } catch (error) {
    if (error?.code === "fly_protocol_status_invalid") throw error;
    throw rolloutError("fly_protocol_status_invalid", "writer protocol status output is invalid JSON");
  }
}

function planWriterProtocolRollout(status) {
  const observed = normalizeProtocolStatus(status);
  requireCondition(
    observed.state === "missing" || observed.state === "ready",
    "writer protocol state is not safe to deploy",
    "fly_protocol_state_invalid"
  );
  const transitionRequired = observed.state === "missing" || observed.version === "5";
  const phases = transitionRequired ? ["transition", "v6"] : ["v6"];
  return Object.freeze({
    observedProtocol: observed.version || "missing",
    path: phases.join("-then-"),
    phases: Object.freeze(phases),
    transitionRequired,
  });
}

function assertProtocolBoundary(status, phase) {
  requireCondition(
    typeof phase === "string" && ROLLOUT_PHASES.has(phase),
    "writer protocol attestation phase is invalid",
    "fly_arguments_invalid"
  );
  const observed = normalizeProtocolStatus(status);
  const expectedVersion = phase === "transition" ? "5" : "6";
  requireCondition(
    observed.state === "ready" && observed.version === expectedVersion,
    "writer protocol does not match the attested rollout boundary",
    "fly_protocol_boundary_invalid"
  );
  return observed;
}

function environmentWithoutRedisUrl(environment) {
  const sanitized = { ...(environment || {}) };
  delete sanitized.REDIS_URL;
  return sanitized;
}

function protocolProbeEnvironment(environment) {
  return {
    ...environmentWithoutRedisUrl(environment),
    NO_COLOR: "1",
  };
}

function parseCandidateProtocolStatusOutput(stdout, stderr = "") {
  requireCondition(
    typeof stdout === "string" && typeof stderr === "string" &&
      Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") <=
        MAX_PROTOCOL_STATUS_BYTES,
    "candidate writer protocol output is invalid",
    "fly_protocol_status_invalid"
  );
  const records = (stdout + "\n" + stderr)
    .split(/[\r\n]+/)
    .filter((line) => line.startsWith(PROTOCOL_STATUS_MARKER))
    .map((line) => line.slice(PROTOCOL_STATUS_MARKER.length));
  requireCondition(
    records.length === 1,
    "candidate writer protocol output is ambiguous",
    "fly_protocol_status_invalid"
  );
  return parseProtocolStatusOutput(records[0]);
}

async function readCandidateWriterProtocolStatus(
  flyctl,
  app,
  image,
  region,
  options = {}
) {
  exactString(flyctl, "FLYCTL_BIN");
  requireCondition(/^[a-z0-9-]+$/.test(app), "Fly app is invalid");
  parseImage(image, app);
  requireCondition(/^[a-z0-9]{3}$/.test(region), "Fly primary region is invalid");
  const execute = options.execFile || execFileAsync;
  requireCondition(typeof execute === "function", "Fly protocol executor is invalid");

  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  const tempCwd = await fs.promises.mkdtemp(
    path.join(tempRoot, "jumpgate-fly-protocol-")
  );
  requireCondition(
    path.dirname(path.resolve(tempCwd)) === tempRoot,
    "candidate writer protocol temporary directory is invalid",
    "fly_protocol_probe_failed"
  );

  let result;
  let probeFailed = false;
  try {
    result = await execute(
      flyctl,
      [
        "machine",
        "run",
        image,
        "/bin/sleep",
        String(PROTOCOL_PROBE_MACHINE_LIFETIME_SECONDS),
        "--app",
        app,
        "--region",
        region,
        "--env",
        "NO_COLOR=1",
        "--shell",
        "--command",
        CANDIDATE_PROTOCOL_STATUS_COMMAND,
        "--rm",
        "--restart",
        "no",
        "--skip-dns-registration",
      ],
      {
        cwd: tempCwd,
        encoding: "utf8",
        env: protocolProbeEnvironment(options.env || process.env),
        maxBuffer: MAX_PROTOCOL_STATUS_BYTES,
        timeout: PROTOCOL_PROBE_TIMEOUT_MS,
        windowsHide: true,
      }
    );
  } catch (_error) {
    probeFailed = true;
  } finally {
    try {
      await fs.promises.rm(tempCwd, { force: true, recursive: true });
    } catch (_error) {
      throw rolloutError(
        "fly_protocol_probe_cleanup_failed",
        "candidate writer protocol probe cleanup failed"
      );
    }
  }
  if (probeFailed) {
    throw rolloutError("fly_protocol_probe_failed", "candidate writer protocol probe failed");
  }
  requireCondition(isRecord(result), "candidate writer protocol probe reply is invalid");
  return parseCandidateProtocolStatusOutput(result.stdout, result.stderr);
}

async function readWriterProtocolStatus(flyctl, app, machineId, options = {}) {
  exactString(flyctl, "FLYCTL_BIN");
  requireCondition(/^[a-z0-9-]+$/.test(app), "Fly app is invalid");
  exactMachineId(machineId);
  const execute = options.execFile || execFileAsync;
  requireCondition(typeof execute === "function", "Fly protocol executor is invalid");
  let result;
  try {
    result = await execute(
      flyctl,
      [
        "ssh",
        "console",
        "--app",
        app,
        "--machine",
        machineId,
        "--command",
        PROTOCOL_STATUS_COMMAND,
        "--quiet",
      ],
      {
        encoding: "utf8",
        env: protocolProbeEnvironment(options.env || process.env),
        maxBuffer: MAX_PROTOCOL_STATUS_BYTES,
        windowsHide: true,
      }
    );
  } catch (_error) {
    throw rolloutError("fly_protocol_probe_failed", "writer protocol status probe failed");
  }
  requireCondition(isRecord(result), "writer protocol probe reply is invalid");
  return parseProtocolStatusOutput(result.stdout);
}

function assertMachineVersion(value, expectedVersion, expectedBuildSha) {
  requireCondition(
    typeof expectedVersion === "string" &&
      /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(expectedVersion),
    "expected package version is invalid",
    "fly_runtime_version_invalid"
  );
  requireCondition(
    typeof expectedBuildSha === "string" && /^[a-f0-9]{40}$/.test(expectedBuildSha),
    "expected build SHA is invalid",
    "fly_runtime_version_invalid"
  );
  requireCondition(
    isRecord(value),
    "Machine runtime version is invalid",
    "fly_runtime_version_invalid"
  );
  const parts = expectedVersion.split(".").map(Number);
  requireCondition(
    value.version === expectedVersion &&
      value.major === parts[0] &&
      value.minor === parts[1] &&
      value.patch === parts[2],
    "Machine runtime package version differs",
    "fly_runtime_version_invalid"
  );
  requireCondition(
    value.buildSha === expectedBuildSha,
    "Machine runtime build SHA differs",
    "fly_runtime_version_invalid"
  );
  requireCondition(
    isRecord(value.capabilities) &&
      value.capabilities.managementTraktOAuth === "m1-m2-v1",
    "Machine runtime management capability differs",
    "fly_runtime_version_invalid"
  );
  return value;
}

function parseMachineVersionOutput(stdout) {
  requireCondition(
    typeof stdout === "string" && Buffer.byteLength(stdout, "utf8") <= MAX_MACHINE_VERSION_BYTES,
    "Machine runtime version output is invalid",
    "fly_runtime_version_invalid"
  );
  const text = stdout.trim();
  requireCondition(
    text.length > 0 && !text.includes("\n") && !text.includes("\r"),
    "Machine runtime version output is not a single record",
    "fly_runtime_version_invalid"
  );
  try {
    return JSON.parse(text);
  } catch (_error) {
    throw rolloutError("fly_runtime_version_invalid", "Machine runtime version output is invalid JSON");
  }
}

async function readMachineVersion(flyctl, app, machineId, options = {}) {
  exactString(flyctl, "FLYCTL_BIN");
  requireCondition(/^[a-z0-9-]+$/.test(app), "Fly app is invalid");
  exactMachineId(machineId);
  const execute = options.execFile || execFileAsync;
  requireCondition(typeof execute === "function", "Fly runtime version executor is invalid");
  let result;
  try {
    result = await execute(
      flyctl,
      [
        "ssh",
        "console",
        "--app",
        app,
        "--machine",
        machineId,
        "--command",
        MACHINE_VERSION_COMMAND,
        "--quiet",
      ],
      {
        encoding: "utf8",
        env: protocolProbeEnvironment(options.env || process.env),
        maxBuffer: MAX_MACHINE_VERSION_BYTES,
        timeout: MACHINE_VERSION_PROBE_TIMEOUT_MS,
        windowsHide: true,
      }
    );
  } catch (_error) {
    throw rolloutError("fly_runtime_version_probe_failed", "Machine runtime version probe failed");
  }
  requireCondition(
    isRecord(result),
    "Machine runtime version probe reply is invalid",
    "fly_runtime_version_probe_failed"
  );
  return parseMachineVersionOutput(result.stdout);
}

async function attestRepeatedly(options) {
  requireCondition(isRecord(options), "Fly attestation options are invalid");
  const desired = desiredStateForPhase(options.desired, options.phase);
  const expectedImage = parseImage(options.image, desired.app);
  const intervals = exactInteger(options.intervals, "attestation intervals", 3, 12);
  const delayMs = exactInteger(options.delayMs, "attestation delay", 0, 60_000);
  requireCondition(typeof options.sample === "function", "Machine sampler is required");
  requireCondition(typeof options.externalProbe === "function", "external readiness probe is required");
  requireCondition(typeof options.protocolProbe === "function", "writer protocol probe is required");
  requireCondition(typeof options.versionProbe === "function", "Machine runtime version probe is required");
  requireCondition(typeof options.sleep === "function", "attestation sleep is required");
  let stableIds = null;
  let protocolVersion = null;
  for (let index = 0; index < intervals; index += 1) {
    const ids = validateFleetSample(
      await options.sample(),
      desired,
      options.image
    );
    if (stableIds === null) {
      stableIds = ids;
    } else {
      requireCondition(
        JSON.stringify(ids) === JSON.stringify(stableIds),
        "serving Machine identities changed during attestation"
      );
    }
    for (const machineId of ids) {
      const protocol = assertProtocolBoundary(
        await options.protocolProbe(machineId),
        options.phase
      );
      protocolVersion = protocol.version;
      assertMachineVersion(
        await options.versionProbe(machineId),
        PACKAGE_VERSION,
        expectedImage.buildSha
      );
    }
    await options.externalProbe();
    if (index + 1 < intervals) await options.sleep(delayMs);
  }
  return Object.freeze({
    machineIds: stableIds,
    intervals,
    phase: options.phase,
    protocolVersion,
  });
}

function sameMachineIds(machines, expectedIds) {
  return JSON.stringify(machines.map((machine) => machine.id)) === JSON.stringify(expectedIds);
}

function convergenceFleetPassing(machines, desired) {
  for (const machine of machines) {
    if (machine.state !== "started") return false;
    if (!machineServiceHealthPassing(machine, desired)) return false;
  }
  return true;
}

async function convergeFleet(options) {
  requireCondition(isRecord(options), "Fly convergence options are invalid");
  const desired = desiredStateForPhase(options.desired, options.phase);
  const polls = exactInteger(options.polls, "convergence polls", 1, 120);
  const delayMs = exactInteger(options.delayMs, "convergence delay", 0, 60_000);
  requireCondition(typeof options.sample === "function", "Machine sampler is required");
  requireCondition(typeof options.startMachine === "function", "Machine starter is required");
  requireCondition(typeof options.sleep === "function", "convergence sleep is required");

  let candidates = validateConvergenceSample(
    await options.sample(),
    desired,
    options.image
  );
  const stableIds = candidates.map((machine) => machine.id);
  if (convergenceFleetPassing(candidates, desired)) {
    return Object.freeze({ machineIds: stableIds, phase: options.phase, startedIds: [] });
  }

  const startedIds = candidates
    .filter((machine) => machine.state === "stopped")
    .map((machine) => machine.id);
  for (const machineId of startedIds) {
    await options.startMachine(machineId);
  }

  const observedStarted = new Set(
    candidates.filter((machine) => machine.state === "started").map((machine) => machine.id)
  );
  for (let index = 0; index < polls; index += 1) {
    if (index > 0) await options.sleep(delayMs);
    candidates = validateConvergenceSample(
      await options.sample(),
      desired,
      options.image
    );
    requireCondition(
      sameMachineIds(candidates, stableIds),
      "Machine identities changed during fleet convergence",
      "fly_convergence_drift"
    );
    for (const machine of candidates) {
      requireCondition(
        !(observedStarted.has(machine.id) && machine.state !== "started"),
        "Machine state regressed during fleet convergence",
        "fly_convergence_drift"
      );
      if (machine.state === "started") observedStarted.add(machine.id);
    }
    if (convergenceFleetPassing(candidates, desired)) {
      return Object.freeze({ machineIds: stableIds, phase: options.phase, startedIds });
    }
  }
  throw rolloutError("fly_convergence_timeout", "Fly fleet convergence timed out");
}

function readArgument(args, name, options = {}) {
  const prefix = "--" + name + "=";
  const values = args.filter((value) => value.startsWith(prefix));
  if (values.length === 0 && options.optional) return options.defaultValue;
  requireCondition(values.length === 1, "argument " + name + " is required", "fly_arguments_invalid");
  const value = values[0].slice(prefix.length);
  requireCondition(value.length > 0, "argument " + name + " is invalid", "fly_arguments_invalid");
  return value;
}

async function listMachines(flyctl, app, options = {}) {
  exactString(flyctl, "FLYCTL_BIN");
  requireCondition(/^[a-z0-9-]+$/.test(app), "Fly app is invalid");
  const execute = options.execFile || execFileAsync;
  requireCondition(typeof execute === "function", "Fly Machine list executor is invalid");
  let result;
  try {
    result = await execute(
      flyctl,
      ["machine", "list", "--app", app, "--json"],
      {
        encoding: "utf8",
        maxBuffer: MAX_MACHINE_LIST_BYTES,
        timeout: MACHINE_LIST_TIMEOUT_MS,
        windowsHide: true,
      }
    );
  } catch (_error) {
    throw rolloutError("fly_machine_list_failed", "Fly Machine list failed");
  }
  requireCondition(isRecord(result) && typeof result.stdout === "string", "Fly Machine reply is invalid");
  requireCondition(
    Buffer.byteLength(result.stdout, "utf8") <= MAX_MACHINE_LIST_BYTES,
    "Fly Machine response is oversized"
  );
  try {
    return JSON.parse(result.stdout);
  } catch (_error) {
    throw rolloutError("fly_attestation_invalid", "Fly Machine response is invalid JSON");
  }
}

async function startMachine(flyctl, app, machineId, options = {}) {
  exactString(flyctl, "FLYCTL_BIN");
  requireCondition(/^[a-z0-9-]+$/.test(app), "Fly app is invalid");
  exactMachineId(machineId);
  const execute = options.execFile || execFileAsync;
  requireCondition(typeof execute === "function", "Fly Machine start executor is invalid");
  try {
    await execute(
      flyctl,
      ["machine", "start", machineId, "--app", app],
      {
        encoding: "utf8",
        maxBuffer: MAX_MACHINE_COMMAND_BYTES,
        timeout: MACHINE_START_TIMEOUT_MS,
        windowsHide: true,
      }
    );
  } catch (_error) {
    throw rolloutError("fly_convergence_start_failed", "Fly Machine start failed");
  }
}

async function externalReadiness(baseUrl) {
  const base = new URL(baseUrl);
  requireCondition(base.protocol === "https:", "external readiness URL must use HTTPS");
  base.pathname = "/health/ready";
  base.search = "";
  base.hash = "";
  let response;
  try {
    response = await fetch(base, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch (_error) {
    throw rolloutError("fly_external_readiness_failed", "external readiness transport failed");
  }
  requireCondition(response.status === 200, "external readiness status failed");
  const body = await response.text();
  requireCondition(
    body === '{"ok":true,"status":"ready"}',
    "external readiness body failed"
  );
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  requireCondition(
    command === "validate" || command === "plan" || command === "converge" || command === "attest",
    "managed rollout command is invalid"
  );
  const app = readArgument(args, "app");
  const config = readArgument(args, "config");
  const desired = loadDesiredState(config, app);
  assertDeployable(desired);
  if (command === "validate") {
    process.stdout.write("Managed Fly desired state is deployable.\n");
    return;
  }
  const flyctl = process.env.FLYCTL_BIN;
  requireCondition(typeof flyctl === "string" && flyctl.length > 0, "FLYCTL_BIN is required");
  if (command === "plan") {
    const image = readArgument(args, "image");
    const status = await readCandidateWriterProtocolStatus(
      flyctl,
      app,
      image,
      desired.primaryRegion
    );
    const plan = planWriterProtocolRollout(status);
    process.stdout.write(
      "observed_protocol=" + plan.observedProtocol + "\n" +
      "transition_required=" + String(plan.transitionRequired) + "\n" +
      "rollout_path=" + plan.path + "\n"
    );
    return;
  }
  const image = readArgument(args, "image");
  const phase = readArgument(args, "phase");
  if (command === "converge") {
    const result = await convergeFleet({
      desired,
      phase,
      image,
      polls: DEFAULT_CONVERGENCE_POLLS,
      delayMs: DEFAULT_CONVERGENCE_DELAY_MS,
      sample: () => listMachines(flyctl, app),
      startMachine: (machineId) => startMachine(flyctl, app, machineId),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
    process.stdout.write(
      "Managed Fly " + result.phase + " fleet converged with " +
        result.machineIds.length + " started Machines.\n"
    );
    return;
  }
  const baseUrl = readArgument(args, "base-url");
  const result = await attestRepeatedly({
    desired,
    phase,
    image,
    intervals: DEFAULT_INTERVALS,
    delayMs: DEFAULT_DELAY_MS,
    sample: () => listMachines(flyctl, app),
    externalProbe: () => externalReadiness(baseUrl),
    protocolProbe: (machineId) => readWriterProtocolStatus(flyctl, app, machineId),
    versionProbe: (machineId) => readMachineVersion(flyctl, app, machineId),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  process.stdout.write(
    "Managed Fly " + result.phase + " fleet attested across " + result.intervals + " intervals.\n"
  );
}

if (require.main === module) {
  main().catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "fly_managed_rollout_failed";
    process.stderr.write("Managed Fly rollout failed: " + code + "\n");
    process.exitCode = 1;
  });
}

module.exports = {
  assertProtocolBoundary,
  assertDeployable,
  attestRepeatedly,
  CANDIDATE_PROTOCOL_STATUS_COMMAND,
  collectServingMachines,
  convergeFleet,
  desiredStateForPhase,
  environmentWithoutRedisUrl,
  loadDesiredState,
  MACHINE_VERSION_COMMAND,
  normalizeProtocolStatus,
  parseCandidateProtocolStatusOutput,
  parseProtocolStatusOutput,
  planWriterProtocolRollout,
  PROTOCOL_STATUS_MARKER,
  assertMachineVersion,
  readCandidateWriterProtocolStatus,
  readMachineVersion,
  readWriterProtocolStatus,
  startMachine,
  validateConvergenceSample,
  validateFleetSample,
};
