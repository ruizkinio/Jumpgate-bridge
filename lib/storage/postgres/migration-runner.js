"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { codedError } = require("../repository-utils");
const { PostgresDatabase } = require("./database");
const { containsTransactionControl } = require("./migration-transaction-scanner");
const { resultRows } = require("./repository-helpers");

const DEFAULT_MIGRATION_DIRECTORY = path.join(__dirname, "..", "..", "..", "migrations", "postgres");
const DEFAULT_LOCK_KEYS = Object.freeze([0x4a554d50, 0x47415445]);
const MIGRATION_NAME = /^[0-9]{4,}_[a-z0-9][a-z0-9_]*\.sql$/;
const MIGRATION_VERSION = /^[0-9]{4,}_[a-z0-9][a-z0-9_]*$/;

function migrationError(code, message, migration) {
  const error = codedError(code, message);
  if (migration) error.migration = migration;
  return error;
}

function assertLockKey(value, name) {
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new TypeError(name + " must be a signed 32-bit integer");
  }
  return value;
}

function assertMigrationCeiling(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !MIGRATION_VERSION.test(value)) {
    throw new TypeError("migrationCeiling must be an exact migration version");
  }
  return value;
}

function assertAbortSignal(signal) {
  if (signal === undefined) return null;
  if (
    !signal ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("migration signal is invalid");
  }
  return signal;
}

function throwIfAborted(signal) {
  if (!signal || !signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("PostgreSQL migration aborted");
  error.code = "storage_aborted";
  if (signal.reason !== undefined) error.cause = signal.reason;
  throw error;
}

function migrationTimeoutError(phase, timeoutMs) {
  const error = new Error(phase + " timed out after " + timeoutMs + "ms");
  error.code = "storage_timeout";
  error.phase = phase;
  error.timeoutMs = timeoutMs;
  return error;
}

function createMigrationBudget(options) {
  const configuredDeadline = options.migrationDeadlineMs;
  const timeoutMs = options.migrationTimeoutMs;
  if (configuredDeadline === undefined && timeoutMs === undefined) {
    return {
      start() {
        return {
          check() {},
          databaseTimeout() {
            return null;
          },
          remaining() {
            return null;
          },
          timeoutError() {
            return null;
          },
        };
      },
    };
  }
  const now = options.migrationNow || Date.now;
  const phase = options.migrationPhase || "PostgreSQL migration";
  if (typeof now !== "function") {
    throw new TypeError("PostgreSQL migration deadline is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("PostgreSQL migration timeout is invalid");
  }
  const deadlineMs =
    configuredDeadline === undefined ? null : Number(configuredDeadline);
  if (deadlineMs !== null && !Number.isFinite(deadlineMs)) {
    throw new TypeError("PostgreSQL migration deadline is invalid");
  }

  return {
    start() {
      const startedAt = Number(now());
      if (!Number.isFinite(startedAt)) {
        throw new TypeError("PostgreSQL migration clock is invalid");
      }
      const effectiveDeadline = deadlineMs === null ? startedAt + timeoutMs : deadlineMs;
      const remaining = () => {
        const current = Number(now());
        if (!Number.isFinite(current)) {
          throw new TypeError("PostgreSQL migration clock is invalid");
        }
        return Math.floor(effectiveDeadline - current);
      };
      return {
        check() {
          if (remaining() < 1) throw migrationTimeoutError(phase, timeoutMs);
        },
        databaseTimeout() {
          const remainingMs = remaining();
          if (remainingMs < 1) throw migrationTimeoutError(phase, timeoutMs);
          return remainingMs + "ms";
        },
        remaining() {
          const remainingMs = remaining();
          if (remainingMs < 1) throw migrationTimeoutError(phase, timeoutMs);
          return remainingMs;
        },
        timeoutError() {
          return migrationTimeoutError(phase, timeoutMs);
        },
      };
    },
  };
}

function signalReason(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const error = new Error("PostgreSQL migration aborted");
  error.code = "storage_aborted";
  if (signal && signal.reason !== undefined) error.cause = signal.reason;
  return error;
}

function raceWithSignal(operation, signal) {
  if (!signal) return Promise.resolve(operation);
  if (signal.aborted) return Promise.reject(signalReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, signalReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

function createRunSignal(externalSignal, budget) {
  const controller = new AbortController();
  let timeoutHandle = null;
  const forwardAbort = () => {
    if (!controller.signal.aborted) controller.abort(signalReason(externalSignal));
  };
  if (externalSignal) {
    externalSignal.addEventListener("abort", forwardAbort, { once: true });
    if (externalSignal.aborted) forwardAbort();
  }
  if (!controller.signal.aborted) {
    const remainingMs = budget.remaining();
    if (remainingMs !== null) {
      timeoutHandle = setTimeout(() => {
        if (!controller.signal.aborted) {
          controller.abort(budget.timeoutError());
        }
      }, remainingMs);
    }
  }
  return {
    signal: controller.signal,
    close() {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
    },
  };
}

function resolveDatabase(options) {
  const candidate = options.database || options.db;
  if (candidate) {
    if (typeof candidate.transaction !== "function") {
      throw new TypeError("database must implement transaction()");
    }
    return candidate;
  }
  if (options.pool) return new PostgresDatabase({ pool: options.pool });
  throw new TypeError("database is required");
}

function decodeMigration(bytes, filename) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a || bytes.includes(0x0d)) {
    throw migrationError(
      "migration_line_endings",
      filename + " must contain exact LF line endings and end with LF",
      filename
    );
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw migrationError("migration_encoding", filename + " must not contain a UTF-8 BOM", filename);
  }
  const sql = bytes.toString("utf8");
  if (!Buffer.from(sql, "utf8").equals(bytes)) {
    throw migrationError("migration_encoding", filename + " must be valid UTF-8", filename);
  }
  if (containsTransactionControl(sql)) {
    throw migrationError(
      "migration_transaction_control",
      filename + " must not contain transaction-control statements",
      filename
    );
  }
  return sql;
}

async function readMigrations(fileSystem, directory) {
  const entries = await fileSystem.readdir(directory, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    const isFile = typeof entry === "string" || typeof entry.isFile !== "function" || entry.isFile();
    if (!isFile || !name.endsWith(".sql")) continue;
    if (!MIGRATION_NAME.test(name)) {
      throw migrationError("migration_filename", "invalid migration filename: " + name, name);
    }
    names.push(name);
  }
  if (names.length === 0) throw new Error("no PostgreSQL migration files found in " + directory);
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const migrations = [];
  for (const filename of names) {
    const bytes = await fileSystem.readFile(path.join(directory, filename));
    const sql = decodeMigration(bytes, filename);
    migrations.push({
      checksum: crypto.createHash("sha256").update(bytes).digest("hex"),
      filename,
      sql,
      version: filename.slice(0, -4),
    });
  }
  return migrations;
}

class PostgresMigrationRunner {
  constructor(options = {}) {
    this._database = resolveDatabase(options);
    this._directory = path.resolve(
      options.directory ||
        options.migrationDirectory ||
        options.migrationsPath ||
        DEFAULT_MIGRATION_DIRECTORY
    );
    this._fs = options.fs || fs;
    if (!this._fs || typeof this._fs.readdir !== "function" || typeof this._fs.readFile !== "function") {
      throw new TypeError("migration fs must implement readdir() and readFile()");
    }
    const keys = options.advisoryLockKeys || DEFAULT_LOCK_KEYS;
    if (!Array.isArray(keys) || keys.length !== 2) {
      throw new TypeError("advisoryLockKeys must contain two integers");
    }
    this._lockKeys = [assertLockKey(keys[0], "advisory lock key"), assertLockKey(keys[1], "advisory lock key")];
    this._migrationCeiling = assertMigrationCeiling(options.migrationCeiling);
    this._signal = assertAbortSignal(options.signal);
    this._budget = createMigrationBudget(options);
  }

  async run() {
    const budget = this._budget.start();
    throwIfAborted(this._signal);
    budget.check();
    const run = createRunSignal(this._signal, budget);
    try {
      const migrations = await raceWithSignal(
        readMigrations(this._fs, this._directory),
        run.signal
      );
      throwIfAborted(run.signal);
      budget.check();
      const ceilingIndex = this._migrationCeiling === null
        ? migrations.length - 1
        : migrations.findIndex((migration) => migration.version === this._migrationCeiling);
      if (ceilingIndex < 0) {
        throw migrationError(
          "migration_ceiling_invalid",
          "migration ceiling is not present on disk: " + this._migrationCeiling,
          this._migrationCeiling
        );
      }
      const operation = Promise.resolve().then(() =>
        this._database.transaction(async (transaction) => {
          const query = async (text, values) => {
            throwIfAborted(run.signal);
            budget.check();
            const pending =
              values === undefined
                ? transaction.query(text)
                : transaction.query(text, values);
            const result = await raceWithSignal(pending, run.signal);
            throwIfAborted(run.signal);
            budget.check();
            return result;
          };
          const databaseTimeout = budget.databaseTimeout();
          if (databaseTimeout !== null) {
            await query(
              "SELECT set_config('lock_timeout', $1, true), " +
                "set_config('statement_timeout', $1, true)",
              [databaseTimeout]
            );
          }
          await query(
            "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
            this._lockKeys
          );
          await query(
            "CREATE TABLE IF NOT EXISTS schema_migrations (" +
              "version text PRIMARY KEY, " +
              "checksum char(64) NOT NULL, " +
              "applied_at timestamptz NOT NULL DEFAULT now()" +
              ")"
          );
          const stored = resultRows(
            await query("SELECT version, checksum FROM schema_migrations ORDER BY version")
          );
          const appliedByVersion = new Map();
          for (const row of stored) {
            const version = String(row.version);
            const checksum = String(row.checksum).trim();
            if (appliedByVersion.has(version)) {
              throw migrationError(
                "migration_history_invalid",
                "duplicate applied migration: " + version,
                version
              );
            }
            if (!/^[a-f0-9]{64}$/.test(checksum)) {
              throw migrationError(
                "migration_history_invalid",
                "invalid stored checksum for " + version,
                version
              );
            }
            appliedByVersion.set(version, checksum);
          }

          const knownVersions = new Set(migrations.map((migration) => migration.version));
          for (const version of appliedByVersion.keys()) {
            if (!knownVersions.has(version)) {
              throw migrationError(
                "migration_file_missing",
                "applied migration is missing from disk: " + version,
                version
              );
            }
          }

          const applied = [];
          const alreadyApplied = [];
          let foundPending = false;
          for (const [index, migration] of migrations.entries()) {
            const storedChecksum = appliedByVersion.get(migration.version);
            if (storedChecksum !== undefined) {
              if (foundPending) {
                throw migrationError(
                  "migration_history_invalid",
                  "applied migrations are not a filename-ordered prefix",
                  migration.filename
                );
              }
              if (storedChecksum !== migration.checksum) {
                throw migrationError(
                  "migration_checksum_mismatch",
                  "checksum mismatch for applied migration: " + migration.filename,
                  migration.filename
                );
              }
              alreadyApplied.push(migration.version);
              continue;
            }

            foundPending = true;
            if (index > ceilingIndex) continue;
            await query(migration.sql);
            await query(
              "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
              [migration.version, migration.checksum]
            );
            applied.push(migration.version);
          }
          budget.check();
          return {
            applied,
            alreadyApplied,
            verified: migrations.map((migration) => migration.version),
          };
        }, {
          beforeCommit: () => {
            throwIfAborted(run.signal);
            budget.check();
          },
          signal: run.signal,
        })
      );
      return await raceWithSignal(operation, run.signal);
    } finally {
      run.close();
    }
  }
}

function readPostgresMigrations(options = {}) {
  if (typeof options === "string") {
    return readMigrations(fs, path.resolve(options));
  }
  const fileSystem = options.fs || fs;
  const directory = path.resolve(
    options.directory ||
      options.migrationDirectory ||
      options.migrationsPath ||
      DEFAULT_MIGRATION_DIRECTORY
  );
  return readMigrations(fileSystem, directory);
}

function runPostgresMigrations(databaseOrOptions, options = {}) {
  if (databaseOrOptions && typeof databaseOrOptions.transaction === "function") {
    return new PostgresMigrationRunner({ ...options, database: databaseOrOptions }).run();
  }
  return new PostgresMigrationRunner(databaseOrOptions || {}).run();
}

module.exports = {
  DEFAULT_MIGRATION_DIRECTORY,
  PostgresMigrationRunner,
  applyPostgresMigrations: runPostgresMigrations,
  readPostgresMigrations,
  runPostgresMigrations,
};
