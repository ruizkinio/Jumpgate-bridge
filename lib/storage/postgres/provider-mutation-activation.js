"use strict";

const {
  assertMutationFence,
  codedError,
  compareMutationFences,
} = require("../repository-utils");
const { PostgresDatabase } = require("./database");
const { normalizeProviderMutationMode } = require("./provider-repository");
const { affectedRows, firstRow } = require("./repository-helpers");

const DEFAULT_PROVIDER_MUTATION_PROTOCOL_TIMEOUT_MS = 15_000;
// Keep transition serialization identical to PostgresMigrationRunner.
const PROVIDER_MUTATION_PROTOCOL_LOCK_KEYS = Object.freeze([0x4a554d50, 0x47415445]);
const PROVIDER_MUTATION_PROTOCOL_ACTIONS = Object.freeze({
  activate: activateProviderMutationProtocol,
  pause: pauseProviderMutations,
  resume: resumeProviderMutations,
  status: readProviderMutationProtocolState,
});

function protocolError(code, message) {
  return codedError(code, message);
}

function protocolUnavailable(message) {
  return protocolError("provider_mutation_protocol_unavailable", message);
}

function readPositiveInteger(value, name, fallback) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 300_000) {
    throw new TypeError(name + " must be an integer between 1 and 300000");
  }
  return resolved;
}

function readLockKeys(value) {
  if (value === undefined) return PROVIDER_MUTATION_PROTOCOL_LOCK_KEYS;
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((key) => !Number.isSafeInteger(key) || key < -2147483648 || key > 2147483647)
  ) {
    throw new TypeError("advisoryLockKeys must contain two signed 32-bit integers");
  }
  return value;
}

function resolveContext(databaseOrOptions) {
  if (databaseOrOptions && typeof databaseOrOptions.transaction === "function") {
    return {
      advisoryLockKeys: PROVIDER_MUTATION_PROTOCOL_LOCK_KEYS,
      database: databaseOrOptions,
      timeoutMs: DEFAULT_PROVIDER_MUTATION_PROTOCOL_TIMEOUT_MS,
    };
  }
  const options = databaseOrOptions || {};
  const database = options.database && typeof options.database.transaction === "function"
    ? options.database
    : options.pool
      ? new PostgresDatabase({ pool: options.pool })
      : null;
  if (!database) throw new TypeError("database is required");
  return {
    advisoryLockKeys: readLockKeys(options.advisoryLockKeys),
    database,
    timeoutMs: readPositiveInteger(
      options.timeoutMs,
      "provider mutation protocol timeoutMs",
      DEFAULT_PROVIDER_MUTATION_PROTOCOL_TIMEOUT_MS
    ),
  };
}

async function setBoundedTimeouts(transaction, timeoutMs) {
  await transaction.query(
    `SELECT set_config('lock_timeout', $1, true),
            set_config('statement_timeout', $1, true)`,
    [String(timeoutMs) + "ms"]
  );
}

function normalizeProtocolState(row, installed = true) {
  if (!installed) {
    return Object.freeze({
      installed: false,
      phase: "legacy",
      enforcementActive: false,
      mutationsPaused: false,
      activatedAt: null,
      pausedAt: null,
      activationFence: null,
      allocatorFence: null,
    });
  }
  if (
    !row ||
    typeof row.enforcement_active !== "boolean" ||
    typeof row.mutations_paused !== "boolean"
  ) {
    throw protocolUnavailable("provider mutation protocol state is unavailable");
  }

  const active = row.enforcement_active;
  const paused = row.mutations_paused;
  const activatedAt = row.activated_at || null;
  const pausedAt = row.paused_at || null;
  let activationFence;
  let allocatorFence;
  try {
    activationFence = row.activation_fence === null || row.activation_fence === undefined
      ? null
      : assertMutationFence(String(row.activation_fence), "provider activation fence");
    if (row.allocator_fence === null || row.allocator_fence === undefined) {
      throw new TypeError("provider mutation fence counter is unavailable");
    }
    allocatorFence = assertMutationFence(
      String(row.allocator_fence),
      "provider mutation fence counter"
    );
  } catch (_error) {
    throw protocolUnavailable("provider mutation protocol state is inconsistent");
  }

  if (
    (active && (!activatedAt || activationFence === null)) ||
    (!active && (activatedAt || activationFence !== null)) ||
    (paused && !pausedAt) ||
    (!paused && pausedAt) ||
    (activationFence !== null && compareMutationFences(activationFence, allocatorFence) > 0)
  ) {
    throw protocolUnavailable("provider mutation protocol state is inconsistent");
  }

  return Object.freeze({
    installed: true,
    phase: active ? "active" : paused ? "paused" : "expanded",
    enforcementActive: active,
    mutationsPaused: paused,
    activatedAt,
    pausedAt,
    activationFence,
    allocatorFence,
  });
}

async function readProviderMutationProtocolState(databaseOrOptions) {
  const context = resolveContext(databaseOrOptions);
  return context.database.transaction(async (transaction) => {
    await setBoundedTimeouts(transaction, context.timeoutMs);
    const presence = firstRow(
      await transaction.query(
        `SELECT
           to_regclass('provider_mutation_protocol') IS NOT NULL AS protocol_installed,
           to_regclass('provider_mutation_fence_counter') IS NOT NULL AS allocator_installed`
      )
    );
    if (!presence) {
      throw protocolUnavailable("provider mutation protocol catalog state is unavailable");
    }
    if (!presence.protocol_installed && !presence.allocator_installed) {
      return normalizeProtocolState(null, false);
    }
    if (!presence.protocol_installed || !presence.allocator_installed) {
      throw protocolUnavailable("provider mutation protocol installation is incomplete");
    }
    const state = firstRow(
      await transaction.query(
        `SELECT
           protocol.enforcement_active,
           protocol.mutations_paused,
           protocol.activated_at,
           protocol.paused_at,
           protocol.activation_fence::text AS activation_fence,
           allocator.mutation_fence::text AS allocator_fence
         FROM provider_mutation_protocol AS protocol
         CROSS JOIN provider_mutation_fence_counter AS allocator
        WHERE protocol.singleton_id = 1 AND allocator.singleton_id = 1`
      )
    );
    return normalizeProtocolState(state);
  });
}

function normalizeAttestationOptions(value) {
  if (typeof value === "string") return { mode: normalizeProviderMutationMode(value) };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("provider mutation attestation options are required");
  }
  const mode = normalizeProviderMutationMode(value.mode);
  const migrationCeiling = value.migrationCeiling;
  if (
    migrationCeiling !== undefined &&
    (typeof migrationCeiling !== "string" || !/^[0-9]{4,}_[a-z0-9][a-z0-9_]*$/.test(migrationCeiling))
  ) {
    throw new TypeError("provider mutation attestation migrationCeiling is invalid");
  }
  if (mode === "fenced" && migrationCeiling !== undefined && migrationCeiling < "0004_provider_mutation_fence") {
    throw protocolError(
      "provider_mutation_protocol_mismatch",
      "fenced provider mutation mode requires the provider mutation fence migration"
    );
  }
  return { mode, migrationCeiling };
}

async function attestProviderMutationMode(databaseOrOptions, modeOrOptions) {
  const attestation = normalizeAttestationOptions(modeOrOptions);
  const expectedMode = attestation.mode;
  const state = await readProviderMutationProtocolState(databaseOrOptions);
  const compatible = expectedMode === "legacy"
    ? !state.enforcementActive
    : state.installed && (state.enforcementActive || state.mutationsPaused);
  if (!compatible) {
    throw protocolError(
      "provider_mutation_protocol_mismatch",
      "provider mutation mode " + expectedMode + " does not match protocol phase " + state.phase
    );
  }
  return state;
}

async function lockProviderMutationTransition(context, transaction) {
  await setBoundedTimeouts(transaction, context.timeoutMs);
  await transaction.query(
    "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
    context.advisoryLockKeys
  );
  await transaction.query("LOCK TABLE provider_collections IN ACCESS EXCLUSIVE MODE");
  const protocol = firstRow(
    await transaction.query(
      `SELECT
         enforcement_active,
         mutations_paused,
         activated_at,
         paused_at,
         activation_fence::text AS activation_fence
       FROM provider_mutation_protocol
      WHERE singleton_id = 1
      FOR UPDATE`
    )
  );
  const allocator = firstRow(
    await transaction.query(
      `SELECT mutation_fence::text AS allocator_fence
         FROM provider_mutation_fence_counter
        WHERE singleton_id = 1
        FOR UPDATE`
    )
  );
  return normalizeProtocolState(protocol && allocator ? { ...protocol, ...allocator } : null);
}

async function runProviderMutationTransition(databaseOrOptions, operation) {
  const context = resolveContext(databaseOrOptions);
  return context.database.transaction(async (transaction) => {
    const state = await lockProviderMutationTransition(context, transaction);
    return operation(transaction, state);
  });
}

async function pauseProviderMutations(databaseOrOptions) {
  return runProviderMutationTransition(databaseOrOptions, async (transaction, state) => {
    if (state.mutationsPaused) return { paused: true, changed: false };
    const result = await transaction.query(
      `UPDATE provider_mutation_protocol
          SET mutations_paused = true, paused_at = now()
        WHERE singleton_id = 1 AND mutations_paused = false
        RETURNING paused_at`
    );
    if (affectedRows(result) !== 1 || !firstRow(result).paused_at) {
      throw protocolUnavailable("provider mutation pause failed");
    }
    return { paused: true, changed: true };
  });
}

async function pauseProviderMutationsForActivation(databaseOrOptions) {
  return runProviderMutationTransition(databaseOrOptions, async (transaction, state) => {
    if (state.enforcementActive || state.mutationsPaused) {
      return { paused: state.mutationsPaused, changed: false };
    }
    const result = await transaction.query(
      `UPDATE provider_mutation_protocol
          SET mutations_paused = true, paused_at = now()
        WHERE singleton_id = 1
          AND enforcement_active = false
          AND mutations_paused = false
        RETURNING paused_at`
    );
    if (affectedRows(result) !== 1 || !firstRow(result).paused_at) {
      throw protocolUnavailable("provider mutation activation pause failed");
    }
    return { paused: true, changed: true };
  });
}

async function resumeProviderMutations(databaseOrOptions) {
  return runProviderMutationTransition(databaseOrOptions, async (transaction, state) => {
    if (!state.mutationsPaused) return { resumed: false, changed: false };
    const result = await transaction.query(
      `UPDATE provider_mutation_protocol
          SET mutations_paused = false, paused_at = NULL
        WHERE singleton_id = 1 AND mutations_paused = true`
    );
    if (affectedRows(result) !== 1) {
      throw protocolUnavailable("provider mutation resume failed");
    }
    return { resumed: true, changed: true };
  });
}

async function activateProviderMutationProtocol(databaseOrOptions) {
  return runProviderMutationTransition(databaseOrOptions, async (transaction, state) => {
    if (state.enforcementActive) {
      return {
        activated: false,
        mutationFence: state.activationFence,
        activationFence: state.activationFence,
      };
    }
    if (!state.mutationsPaused) {
      throw protocolError(
        "provider_mutations_not_paused",
        "provider mutations must be paused before activation"
      );
    }

    const allocator = await transaction.query(
      `UPDATE provider_mutation_fence_counter
          SET mutation_fence = GREATEST(
            mutation_fence,
            COALESCE((SELECT MAX(mutation_fence) FROM provider_collections), 0)
          )
        WHERE singleton_id = 1
        RETURNING mutation_fence::text AS mutation_fence`
    );
    if (affectedRows(allocator) !== 1) {
      throw protocolUnavailable("provider mutation fence counter is unavailable");
    }
    const activationFence = assertMutationFence(
      String(firstRow(allocator).mutation_fence),
      "provider activation fence"
    );
    const activation = await transaction.query(
      `UPDATE provider_mutation_protocol
          SET enforcement_active = true,
              activated_at = now(),
              activation_fence = $1::numeric,
              mutations_paused = false,
              paused_at = NULL
        WHERE singleton_id = 1 AND enforcement_active = false AND mutations_paused = true
        RETURNING activated_at`,
      [activationFence]
    );
    if (affectedRows(activation) !== 1 || !firstRow(activation).activated_at) {
      throw protocolUnavailable("provider mutation protocol activation failed");
    }
    return {
      activated: true,
      mutationFence: activationFence,
      activationFence,
    };
  });
}

function readProviderMutationProtocolCliTimeout(env) {
  const raw = env.JUMPGATE_PROVIDER_PROTOCOL_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_PROVIDER_MUTATION_PROTOCOL_TIMEOUT_MS;
  if (!/^[1-9][0-9]{0,5}$/.test(raw) || Number(raw) > 300_000) {
    throw new Error("JUMPGATE_PROVIDER_PROTOCOL_TIMEOUT_MS must be between 1 and 300000");
  }
  return Number(raw);
}

async function runProviderMutationProtocolCli(options = {}) {
  const env = options.env || process.env;
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || process.stdout;
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const action = argv[0];
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_MUTATION_PROTOCOL_ACTIONS, action) || argv.length !== 1) {
    throw new Error("usage: node scripts/activate-provider-mutation-protocol.js status|pause|resume|activate");
  }
  const timeoutMs = readProviderMutationProtocolCliTimeout(env);
  const Pool = options.Pool || require("pg").Pool;
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: timeoutMs });
  try {
    const result = await PROVIDER_MUTATION_PROTOCOL_ACTIONS[action]({ pool, timeoutMs });
    stdout.write(JSON.stringify(result) + "\n");
    return result;
  } finally {
    await pool.end();
  }
}

function reportProviderMutationProtocolCliError(error, stderr = process.stderr) {
  const code = error && error.code ? " [" + error.code + "]" : "";
  stderr.write("provider mutation protocol command failed" + code + "\n");
  process.exitCode = 1;
}

module.exports = {
  activateProviderMutationProtocol,
  attestProviderMutationMode,
  attestProviderMutationProtocol: attestProviderMutationMode,
  DEFAULT_PROVIDER_MUTATION_PROTOCOL_TIMEOUT_MS,
  getProviderMutationProtocolStatus: readProviderMutationProtocolState,
  pauseProviderMutations,
  pauseProviderMutationsForActivation,
  PROVIDER_MUTATION_PROTOCOL_LOCK_KEYS,
  readProviderMutationProtocolState,
  reportProviderMutationProtocolCliError,
  resumeProviderMutations,
  runProviderMutationProtocolCli,
};

if (require.main === module) {
  runProviderMutationProtocolCli().catch(reportProviderMutationProtocolCliError);
}
