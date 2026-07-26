"use strict";

function assertQueryTarget(value, name) {
  if (!value || typeof value.query !== "function") {
    throw new TypeError(name + " must implement query()");
  }
  return value;
}

function attachRollbackError(error, rollbackError) {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return;
  if (Object.prototype.hasOwnProperty.call(error, "rollbackError")) return;
  try {
    Object.defineProperty(error, "rollbackError", {
      configurable: true,
      enumerable: false,
      value: rollbackError,
    });
  } catch (_err) {
    // Preserve the original transaction error even if it is not extensible.
  }
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
    throw new TypeError("transaction signal is invalid");
  }
  return signal;
}

function abortReason(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const error = new Error("PostgreSQL transaction aborted");
  error.code = "storage_aborted";
  if (signal && signal.reason !== undefined) error.cause = signal.reason;
  return error;
}

class PostgresDatabase {
  constructor(options = {}) {
    const pool = options && options.pool ? options.pool : options;
    assertQueryTarget(pool, "PostgreSQL pool");
    if (typeof pool.connect !== "function") {
      throw new TypeError("PostgreSQL pool must implement connect()");
    }
    this.pool = pool;
  }

  query(text, values) {
    return values === undefined ? this.pool.query(text) : this.pool.query(text, values);
  }

  async transaction(callback, options = {}) {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("transaction options are invalid");
    }
    const signal = assertAbortSignal(options.signal);
    if (options.beforeCommit !== undefined && typeof options.beforeCommit !== "function") {
      throw new TypeError("transaction beforeCommit must be a function");
    }
    const client = assertQueryTarget(await this.pool.connect(), "PostgreSQL client");
    if (typeof client.release !== "function") {
      throw new TypeError("PostgreSQL client must implement release()");
    }

    let transactionOpen = false;
    let released = false;
    let aborted = false;
    let abortedWith = null;
    const onAbort = () => {
      if (aborted) return;
      aborted = true;
      abortedWith = abortReason(signal);
      if (!released) {
        released = true;
        try {
          client.release(abortedWith);
        } catch (_releaseError) {
          const stream = client.connection && client.connection.stream;
          if (stream && typeof stream.destroy === "function") stream.destroy(abortedWith);
        }
      }
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    try {
      if (aborted) throw abortedWith;
      await client.query("BEGIN");
      transactionOpen = true;
      if (aborted) throw abortedWith;
      const result = await callback(client);
      if (aborted) throw abortedWith;
      if (options.beforeCommit) options.beforeCommit();
      await client.query("COMMIT");
      transactionOpen = false;
      if (aborted) throw abortedWith;
      return result;
    } catch (error) {
      if (transactionOpen && !aborted) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          attachRollbackError(error, rollbackError);
        }
      }
      if (aborted) throw abortedWith;
      throw error;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (!released) {
        released = true;
        client.release();
      }
    }
  }

  async end() {
    if (typeof this.pool.end === "function") await this.pool.end();
  }
}

function createPostgresDatabase(pool) {
  return pool instanceof PostgresDatabase ? pool : new PostgresDatabase({ pool });
}

module.exports = {
  PostgresDatabase,
  createPostgresDatabase,
};
