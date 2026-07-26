"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { readClock } = require("../repository-utils");
const { containsTransactionControl } = require("./migration-transaction-scanner");

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_MIGRATION_BUSY_TIMEOUT_MS = DEFAULT_BUSY_TIMEOUT_MS;
const MAX_BUSY_TIMEOUT_MS = 600000;
const DEFAULT_MIGRATIONS_PATH = path.join(__dirname, "../../../migrations/sqlite");
const MIGRATION_FILE_PATTERN = /^[0-9]{4,}_[a-z0-9][a-z0-9_]*\.sql$/;

function assertDatabaseHandle(database) {
  if (
    !database ||
    typeof database !== "object" ||
    typeof database.prepare !== "function" ||
    typeof database.exec !== "function" ||
    typeof database.pragma !== "function"
  ) {
    throw new TypeError("database must be a better-sqlite3-compatible handle");
  }
  return database;
}

function assertBusyTimeout(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BUSY_TIMEOUT_MS) {
    throw new TypeError(name + " is invalid");
  }
  return value;
}

function configureSqliteDatabase(database, options = {}) {
  const db = assertDatabaseHandle(database);
  const busyTimeoutMs = assertBusyTimeout(
    options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    "busyTimeoutMs"
  );

  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = " + busyTimeoutMs);

  const foreignKeys = db.pragma("foreign_keys", { simple: true });
  if (foreignKeys !== undefined && foreignKeys !== 1) {
    throw new Error("SQLite foreign key enforcement could not be enabled");
  }
  return db;
}

function synchronousResult(work) {
  const result = work();
  if (result && typeof result.then === "function") {
    throw new TypeError("SQLite transaction work must be synchronous");
  }
  return result;
}

function withSavepoint(database, work) {
  const savepoint = "jumpgate_" + crypto.randomUUID().replace(/-/g, "");
  database.exec("SAVEPOINT " + savepoint);
  try {
    const result = synchronousResult(work);
    database.exec("RELEASE SAVEPOINT " + savepoint);
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK TO SAVEPOINT " + savepoint);
    } catch (_rollbackError) {
      // Preserve the operation error; it is the actionable failure.
    }
    try {
      database.exec("RELEASE SAVEPOINT " + savepoint);
    } catch (_releaseError) {
      // The outer transaction remains responsible for its own final rollback.
    }
    throw error;
  }
}

function withTransaction(database, beginStatement, work) {
  const db = assertDatabaseHandle(database);
  if (typeof work !== "function") throw new TypeError("transaction work must be a function");

  if (db.inTransaction === true) return withSavepoint(db, work);

  db.exec(beginStatement);
  try {
    const result = synchronousResult(work);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      if (db.inTransaction !== false) db.exec("ROLLBACK");
    } catch (_rollbackError) {
      // Preserve the operation error; it is the actionable failure.
    }
    throw error;
  }
}

function withImmediateTransaction(database, work) {
  return withTransaction(database, "BEGIN IMMEDIATE", work);
}

function withReadTransaction(database, work) {
  return withTransaction(database, "BEGIN", work);
}

function readBusyTimeout(database) {
  const value = database.pragma("busy_timeout", { simple: true });
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_BUSY_TIMEOUT_MS;
}

function withBusyTimeout(database, busyTimeoutMs, work) {
  const previousBusyTimeoutMs = readBusyTimeout(database);
  if (previousBusyTimeoutMs !== busyTimeoutMs) {
    database.pragma("busy_timeout = " + busyTimeoutMs);
  }
  let workFailed = false;
  try {
    return work();
  } catch (error) {
    workFailed = true;
    throw error;
  } finally {
    if (previousBusyTimeoutMs !== busyTimeoutMs) {
      try {
        database.pragma("busy_timeout = " + previousBusyTimeoutMs);
      } catch (error) {
        if (!workFailed) throw error;
      }
    }
  }
}

function migrationError(code, message, migration) {
  const error = new Error(message);
  error.code = code;
  if (migration) error.migration = migration;
  return error;
}

function migrationTimeoutError(timeoutMs, phase) {
  const error = new Error((phase || "SQLite migration") + " timed out after " + timeoutMs + "ms");
  error.code = "storage_timeout";
  error.phase = phase || "SQLite migration";
  error.timeoutMs = timeoutMs;
  return error;
}

function createMigrationBudget(options) {
  if (options.migrationDeadlineMs === undefined) {
    return {
      boundedBusyTimeout(value) {
        return value;
      },
      check() {},
    };
  }
  const deadlineMs = Number(options.migrationDeadlineMs);
  const now = options.migrationNow || Date.now;
  const phase = options.migrationPhase || "SQLite migration";
  const timeoutMs = options.migrationTimeoutMs;
  if (!Number.isFinite(deadlineMs) || typeof now !== "function") {
    throw new TypeError("SQLite migration deadline is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("SQLite migration timeout is invalid");
  }

  function remaining() {
    const current = Number(now());
    if (!Number.isFinite(current)) throw new TypeError("SQLite migration clock is invalid");
    const remainingMs = Math.floor(deadlineMs - current);
    if (remainingMs < 1) throw migrationTimeoutError(timeoutMs, phase);
    return remainingMs;
  }

  return {
    boundedBusyTimeout(value) {
      return Math.max(1, Math.min(value, remaining()));
    },
    check() {
      remaining();
    },
  };
}

function decodeMigration(source, filename) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a || bytes.includes(0x0d)) {
    throw migrationError(
      "migration_line_endings",
      filename + " must contain exact LF line endings and end with LF",
      filename
    );
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw migrationError(
      "migration_encoding",
      filename + " must not contain a UTF-8 BOM",
      filename
    );
  }
  const sql = bytes.toString("utf8");
  if (!Buffer.from(sql, "utf8").equals(bytes)) {
    throw migrationError(
      "migration_encoding",
      filename + " must be valid UTF-8",
      filename
    );
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

function readSqliteMigrations(options = {}) {
  if (typeof options === "string") options = { migrationsPath: options };
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("SQLite migration options are invalid");
  }
  const fileSystem = options.fs || fs;
  if (
    typeof fileSystem.readdirSync !== "function" ||
    typeof fileSystem.readFileSync !== "function"
  ) {
    throw new TypeError("migration fs must implement readdirSync() and readFileSync()");
  }
  const directory = path.resolve(
    options.directory ||
      options.migrationDirectory ||
      options.migrationsPath ||
      DEFAULT_MIGRATIONS_PATH
  );
  const entries = fileSystem
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => {
      const name = typeof entry === "string" ? entry : entry.name;
      const isFile =
        typeof entry === "string" ||
        typeof entry.isFile !== "function" ||
        entry.isFile();
      return isFile && name.endsWith(".sql");
    })
    .map((entry) => (typeof entry === "string" ? entry : entry.name))
    .sort();

  if (entries.length === 0) throw new Error("no SQLite migration files found in " + directory);

  const versions = new Set();
  return entries.map((filename) => {
    if (!MIGRATION_FILE_PATTERN.test(filename)) {
      throw migrationError(
        "migration_filename",
        "invalid SQLite migration filename: " + filename,
        filename
      );
    }
    const version = filename.slice(0, -4);
    if (versions.has(version)) {
      throw migrationError(
        "migration_filename",
        "duplicate SQLite migration version: " + version,
        filename
      );
    }
    versions.add(version);

    const source = fileSystem.readFileSync(path.join(directory, filename));
    const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
    const sql = decodeMigration(bytes, filename);
    return {
      version,
      filename,
      sql,
      checksum: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function runMigrations(database, options = {}) {
  const db = assertDatabaseHandle(database);
  const budget = createMigrationBudget(options);
  budget.check();
  const migrations = readSqliteMigrations(options);
  budget.check();
  const clock = options.clock || Date.now;
  const configuredBusyTimeoutMs = readBusyTimeout(db);
  const requestedMigrationBusyTimeoutMs = assertBusyTimeout(
    options.migrationBusyTimeoutMs ??
      (configuredBusyTimeoutMs >= 1 && configuredBusyTimeoutMs <= MAX_BUSY_TIMEOUT_MS
        ? configuredBusyTimeoutMs
        : DEFAULT_MIGRATION_BUSY_TIMEOUT_MS),
    "migrationBusyTimeoutMs"
  );
  const migrationBusyTimeoutMs = budget.boundedBusyTimeout(requestedMigrationBusyTimeoutMs);

  return withBusyTimeout(db, migrationBusyTimeoutMs, () =>
    withImmediateTransaction(db, () => {
      budget.check();
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          checksum TEXT NOT NULL CHECK (
            length(checksum) = 64 AND checksum NOT GLOB '*[^a-f0-9]*'
          ),
          applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
        )
      `);
      budget.check();
      const storedRows = db
        .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
        .all();
      budget.check();
      const appliedByVersion = new Map();
      for (const row of storedRows) {
        const version = String(row.version);
        const checksum = String(row.checksum).trim();
        if (appliedByVersion.has(version) || !/^[a-f0-9]{64}$/.test(checksum)) {
          throw migrationError(
            "migration_history_invalid",
            "invalid applied SQLite migration: " + version,
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
            "applied SQLite migration file is missing: " + version,
            version
          );
        }
      }

      const alreadyApplied = [];
      let foundPending = false;
      for (const migration of migrations) {
        const storedChecksum = appliedByVersion.get(migration.version);
        if (storedChecksum !== undefined) {
          if (foundPending) {
            throw migrationError(
              "migration_history_invalid",
              "applied SQLite migrations are not a filename-ordered prefix",
              migration.filename
            );
          }
          if (storedChecksum !== migration.checksum) {
            throw migrationError(
              "migration_checksum_mismatch",
              "SQLite migration checksum mismatch: " + migration.version,
              migration.filename
            );
          }
          alreadyApplied.push(migration.version);
          continue;
        }
        foundPending = true;
      }

      const applied = [];
      const insertMigration = db.prepare(
        "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)"
      );
      for (const migration of migrations) {
        if (appliedByVersion.has(migration.version)) continue;
        budget.check();
        db.exec(migration.sql);
        budget.check();
        insertMigration.run(migration.version, migration.checksum, readClock(clock));
        budget.check();
        applied.push(migration.version);
      }

      budget.check();
      return {
        applied,
        alreadyApplied,
        verified: migrations.map((migration) => migration.version),
      };
    })
  );
}

class SqliteMigrationRunner {
  constructor(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("SQLite migration options are invalid");
    }
    this._database = assertDatabaseHandle(options.database || options.db);
    this._options = { ...options };
    delete this._options.database;
    delete this._options.db;
  }

  run() {
    return runMigrations(this._database, this._options);
  }
}

function runSqliteMigrations(databaseOrOptions, options = {}) {
  if (databaseOrOptions && typeof databaseOrOptions.prepare === "function") {
    return new SqliteMigrationRunner({ ...options, database: databaseOrOptions }).run();
  }
  return new SqliteMigrationRunner(databaseOrOptions || {}).run();
}

function openSqliteDatabase(options = {}) {
  const filename = options.filename || options.databasePath || options.path || ":memory:";
  if (typeof filename !== "string" || filename.length === 0) {
    throw new TypeError("SQLite filename is invalid");
  }

  let Database = options.Database || options.databaseConstructor;
  if (Database === undefined) {
    try {
      // Deliberately lazy: importing this module does not require the native addon.
      Database = require("better-sqlite3");
    } catch (cause) {
      const error = new Error(
        "better-sqlite3 is required when an injected database handle is not provided"
      );
      error.code = "better_sqlite3_unavailable";
      error.cause = cause;
      throw error;
    }
  }
  if (typeof Database !== "function") throw new TypeError("SQLite database constructor is invalid");
  return new Database(filename, options.openOptions || options.databaseOptions || {});
}

module.exports = {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_MIGRATION_BUSY_TIMEOUT_MS,
  DEFAULT_MIGRATION_DIRECTORY: DEFAULT_MIGRATIONS_PATH,
  DEFAULT_MIGRATIONS_PATH,
  SqliteMigrationRunner,
  applySqliteMigrations: runSqliteMigrations,
  assertDatabaseHandle,
  configureSqliteDatabase,
  openSqliteDatabase,
  readSqliteMigrations,
  runSqliteMigrations,
  withImmediateTransaction,
  withReadTransaction,
};
