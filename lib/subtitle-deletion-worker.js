"use strict";

const crypto = require("node:crypto");
const {
  assertAbortSignal,
  assertObjectStore,
  objectStoreError,
} = require("./storage/object-store");
const {
  assertBoundedString,
  assertPlainObject,
  assertPositiveInteger,
} = require("./storage/repository-utils");

const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_LEASE_MS = 60 * 1000;
const DEFAULT_SECOND_PASS_DELAY_MS = 30 * 1000;
const DEFAULT_MAX_JOBS_PER_RUN = 32;
const MAX_JOBS_PER_RUN = 256;

function assertDeletionRepository(repository) {
  if (!repository || typeof repository !== "object") {
    throw new TypeError("subtitle deletion repository is required");
  }
  for (const method of [
    "claimDeletion",
    "recordDeletionAbsence",
    "retryDeletion",
    "confirmDeletion",
  ]) {
    if (typeof repository[method] !== "function") {
      throw new TypeError("subtitle deletion repository must implement " + method + "()");
    }
  }
  return repository;
}

function safeErrorCode(error) {
  return error && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
    ? error.code
    : "subtitle_deletion_failed";
}

function attachCleanupError(error, cleanupError) {
  if (!error || !cleanupError || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, "cleanupError", {
      configurable: true,
      enumerable: false,
      value: cleanupError,
    });
  } catch (_ignored) {
    // The deletion error remains authoritative.
  }
}

class SubtitleDeletionWorker {
  constructor(options = {}) {
    const supplied = assertPlainObject(options, "subtitle deletion worker options");
    this._repository = assertDeletionRepository(supplied.repository);
    this._objectStore = assertObjectStore(supplied.objectStore);
    this._workerId = assertBoundedString(
      supplied.workerId || "subtitle-worker-" + crypto.randomBytes(12).toString("base64url"),
      "subtitle deletion worker id",
      256
    );
    this._retryDelayMs = assertPositiveInteger(
      supplied.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "subtitle deletion retry delay",
      5 * 60 * 1000
    );
    this._leaseMs = assertPositiveInteger(
      supplied.leaseMs ?? DEFAULT_LEASE_MS,
      "subtitle deletion lease",
      5 * 60 * 1000
    );
    this._secondPassDelayMs = assertPositiveInteger(
      supplied.secondPassDelayMs ?? DEFAULT_SECOND_PASS_DELAY_MS,
      "subtitle deletion second pass delay",
      24 * 60 * 60 * 1000
    );
    this._maxJobsPerRun = assertPositiveInteger(
      supplied.maxJobsPerRun ?? DEFAULT_MAX_JOBS_PER_RUN,
      "subtitle deletion job limit",
      MAX_JOBS_PER_RUN
    );
  }

  async runOnce(options = {}) {
    const supplied = assertPlainObject(options, "subtitle deletion run options");
    const signal = assertAbortSignal(supplied.signal);
    const claim = await this._repository.claimDeletion({
      workerId: this._workerId,
      leaseMs: this._leaseMs,
    });
    if (!claim) return null;
    try {
      let result;
      if (claim.phase === "empty") {
        result = await this._repository.confirmDeletion({
          artifactId: claim.artifactId,
          deletionToken: claim.deletionToken,
          verifiedAbsent: true,
        });
      } else {
        await this._deleteAndVerify(claim.parts, signal);
        result = claim.phase === "first"
            ? await this._repository.recordDeletionAbsence({
              artifactId: claim.artifactId,
              deletionToken: claim.deletionToken,
              secondPassDelayMs: this._secondPassDelayMs,
              verifiedAbsent: true,
            })
          : claim.phase === "second"
            ? await this._repository.confirmDeletion({
                artifactId: claim.artifactId,
                deletionToken: claim.deletionToken,
                verifiedAbsent: true,
              })
            : (() => { throw new TypeError("subtitle deletion phase is invalid"); })();
      }
      return result
        ? Object.freeze({
            status: result.status,
            artifactId: claim.artifactId,
            phase: claim.phase,
            ...(result.retryAt ? { retryAt: result.retryAt } : {}),
            ...(result.released ? { released: Object.freeze({ ...result.released }) } : {}),
          })
        : Object.freeze({ status: "lost", artifactId: claim.artifactId, phase: claim.phase });
    } catch (error) {
      let retry = null;
      try {
        retry = await this._repository.retryDeletion({
          artifactId: claim.artifactId,
          deletionToken: claim.deletionToken,
          retryDelayMs: this._retryDelayMs,
        });
      } catch (cleanupError) {
        attachCleanupError(error, cleanupError);
        throw error;
      }
      return Object.freeze({
        status: retry ? "retrying" : "lost",
        artifactId: claim.artifactId,
        phase: claim.phase,
        errorCode: safeErrorCode(error),
        ...(retry ? { retryAt: retry.retryAt } : {}),
      });
    }
  }

  async runUntilIdle(options = {}) {
    const supplied = assertPlainObject(options, "subtitle deletion batch options");
    const signal = assertAbortSignal(supplied.signal);
    const maximum = assertPositiveInteger(
      supplied.maxJobs ?? this._maxJobsPerRun,
      "subtitle deletion batch limit",
      MAX_JOBS_PER_RUN
    );
    const results = [];
    while (results.length < maximum) {
      if (signal && signal.aborted) break;
      const result = await this.runOnce(signal ? { signal } : {});
      if (!result) break;
      results.push(result);
    }
    return Object.freeze({
      processed: results.length,
      hasMore: results.length === maximum,
      results: Object.freeze(results),
    });
  }

  async _deleteAndVerify(parts, signal) {
    if (!Array.isArray(parts) || parts.length > 2) {
      throw new TypeError("subtitle deletion parts are invalid");
    }
    const deletes = await Promise.allSettled(
      parts.map((part) => this._objectStore.delete(
        part.objectKey,
        {
          checksumSha256: part.checksum,
          contentLength: part.sizeBytes,
          ...(signal ? { signal } : {}),
        }
      ))
    );
    const failed = deletes.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    for (const part of parts) {
      try {
        await this._objectStore.head(part.objectKey, {
          checksumSha256: part.checksum,
          contentLength: part.sizeBytes,
          maxBytes: part.sizeBytes,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (error && error.code === "object_store_not_found") continue;
        throw error;
      }
      throw objectStoreError("object_store_integrity", "delete");
    }
  }
}

module.exports = {
  DEFAULT_SUBTITLE_DELETION_JOBS_PER_RUN: DEFAULT_MAX_JOBS_PER_RUN,
  DEFAULT_SUBTITLE_DELETION_LEASE_MS: DEFAULT_LEASE_MS,
  DEFAULT_SUBTITLE_DELETION_RETRY_MS: DEFAULT_RETRY_DELAY_MS,
  DEFAULT_SUBTITLE_DELETION_SECOND_PASS_DELAY_MS: DEFAULT_SECOND_PASS_DELAY_MS,
  SubtitleDeletionWorker,
};
