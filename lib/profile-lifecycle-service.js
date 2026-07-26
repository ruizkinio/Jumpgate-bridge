"use strict";

const { assertRepository } = require("./storage/contracts");
const {
  addDuration,
  assertIdentifier,
  assertPlainObject,
  codedError,
  readClock,
} = require("./storage/repository-utils");

const DEFAULT_WRITE_ATTEMPTS = 8;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 5 * 60 * 1000;
const DEFAULT_CLAIM_DEADLINE_MS = 5000;
const MAX_CLAIM_DEADLINE_MS = 60_000;
const PLAYBACK_CLAIM_CLEANUP_OWNER = Symbol.for(
  "jumpgate.playbackClaimCleanupOwner"
);

function assertAbortSignal(signal) {
  if (signal === undefined) return null;
  if (
    !signal ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("playback claim signal is invalid");
  }
  return signal;
}

function abortReason(signal) {
  if (signal && signal.reason instanceof Error) return signal.reason;
  const error = new Error("playback claim was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

class ProfileLifecycleService {
  constructor(options = {}) {
    this._profiles = assertRepository("profiles", options.profiles);
    this._managementSessions = assertRepository(
      "managementSessions",
      options.managementSessions
    );
    if (!options.providerGateway || typeof options.providerGateway.clearProfile !== "function") {
      throw new TypeError("providerGateway is required");
    }
    this._providerGateway = options.providerGateway;
    this._devices = options.devices || null;
    this._lifecycleInvalidations = options.lifecycleInvalidations || null;
    this._playbackContexts = options.playbackContexts || null;
    this._historyGrants = options.historyGrants || null;
    this._subtitleDeliveries = options.subtitleDeliveries || null;
    this._subtitleManifests = assertRepository(
      "subtitleManifests",
      options.subtitleManifests
    );
    this._clock = options.clock || Date.now;
    this._retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this._retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    if (
      !Number.isSafeInteger(this._retryBaseMs) ||
      this._retryBaseMs < 1 ||
      !Number.isSafeInteger(this._retryMaxMs) ||
      this._retryMaxMs < this._retryBaseMs
    ) {
      throw new TypeError("profile lifecycle retry policy is invalid");
    }
    this._writeAttempts = options.writeAttempts ?? DEFAULT_WRITE_ATTEMPTS;
    if (
      !Number.isSafeInteger(this._writeAttempts) ||
      this._writeAttempts < 1 ||
      this._writeAttempts > 32
    ) {
      throw new TypeError("profile lifecycle writeAttempts is invalid");
    }
    this._claimDeadlineMs = options.claimDeadlineMs ?? DEFAULT_CLAIM_DEADLINE_MS;
    if (
      !Number.isSafeInteger(this._claimDeadlineMs) ||
      this._claimDeadlineMs < 1 ||
      this._claimDeadlineMs > MAX_CLAIM_DEADLINE_MS
    ) {
      throw new TypeError("playback claim deadline is invalid");
    }
  }

  async requestErasure(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    let profile = await this._profiles.getById(id);
    for (let attempt = 0; attempt < this._writeAttempts; attempt += 1) {
      if (!profile) throw codedError("profile_unavailable", "profile is unavailable");
      if (profile.deletionState === "pending" || profile.deletionState === "deleted") break;
      if (profile.status !== "active") {
        throw codedError("profile_unavailable", "profile is unavailable");
      }
      try {
        profile = await this._profiles.beginErasure(id, profile.revision);
        if (!profile) throw codedError("profile_unavailable", "profile is unavailable");
        break;
      } catch (error) {
        if (!error || error.code !== "revision_conflict" || attempt + 1 >= this._writeAttempts) {
          throw error;
        }
        profile = await this._profiles.getById(id);
      }
    }
    try {
      return await this.resumeErasure(id);
    } catch (error) {
      const accepted = await this._profiles.getErasureStatus(id).catch(() => null);
      if (accepted && accepted.status === "pending") return accepted;
      throw error;
    }
  }

  async resumeErasure(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const before = await this._profiles.getErasureStatus(id);
    if (!before) throw codedError("profile_unavailable", "profile is unavailable");
    if (before.status === "deleted") return before;
    if (before.status !== "pending") {
      throw codedError("profile_erasure_state", "profile erasure state is invalid");
    }

    // beginErasure has already denied all durable profile authentication.
    await this._managementSessions.revokeProfile(id);
    const pendingInvalidation = this._lifecycleInvalidations
      ? await this._lifecycleInvalidations.getPending("profile", id)
      : null;
    try {
      await this._providerGateway.clearProfile(id);
      await this._subtitleManifests.requestProfileDeletion(
        id,
        "profile_erasure_final_sweep"
      );
      if (pendingInvalidation) {
        await this._lifecycleInvalidations.complete(pendingInvalidation.id);
      }
    } catch (error) {
      if (pendingInvalidation) await this._deferInvalidation(pendingInvalidation);
      throw error;
    }
    await this._managementSessions.revokeProfile(id);
    const erased = await this._profiles.erase(id);
    if (!erased) throw codedError("profile_erasure_state", "profile erasure did not complete");
    const after = await this._profiles.getErasureStatus(id);
    if (!after || after.status !== "deleted") {
      throw codedError("profile_erasure_state", "profile erasure could not be confirmed");
    }
    return after;
  }

  async resumePending(limit = 32) {
    const pending = await this._profiles.listPendingErasures(limit);
    let completed = 0;
    let failed = 0;
    for (const item of pending) {
      try {
        await this.resumeErasure(item.profileId);
        completed += 1;
      } catch (_error) {
        await this._profiles.deferErasure(
          item.profileId,
          item.attemptCount,
          this._retryAt(item.attemptCount)
        );
        failed += 1;
      }
    }
    return Object.freeze({ processed: pending.length, completed, failed });
  }

  async revokeDevice(profileId, deviceId) {
    this._assertDeviceInvalidationDependencies();
    const result = await this._devices.revokeWithInvalidation(profileId, deviceId);
    if (!result.revoked || !result.invalidation) return result.revoked;
    try {
      await this._processInvalidation(result.invalidation);
      return true;
    } catch (error) {
      await this._deferInvalidation(result.invalidation);
      throw error;
    }
  }

  async clearHistory(profileId) {
    if (!this._historyGrants || typeof this._historyGrants.clearHistory !== "function") {
      throw new TypeError("history grant lifecycle dependency is required");
    }
    return this._historyGrants.clearHistory(assertIdentifier(profileId, "profile id"));
  }

  async claim(binding, request, options = {}) {
    this._assertClaimDependencies();
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new TypeError("device binding is invalid");
    }
    const supplied = assertPlainObject(options || {}, "playback claim options");
    for (const key of Reflect.ownKeys(supplied)) {
      if (key !== "signal" && key !== "sessionId" && key !== "requestDigest") {
        throw new TypeError("playback claim options contain an unknown field");
      }
    }
    const signal = assertAbortSignal(supplied.signal);
    const sessionId = assertIdentifier(supplied.sessionId, "history session id");
    if (typeof supplied.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(supplied.requestDigest)) {
      throw new TypeError("playback claim request digest is invalid");
    }
    if (signal && signal.aborted) throw abortReason(signal);

    let admittedResult = null;
    try {
      return await this._devices.withClaimAdmission(
        binding.profileId,
        binding.deviceId,
        binding.profileRevision,
        binding.deviceGeneration,
        async () => {
          admittedResult = await this._claimWithDeadline(binding, request, signal, {
            sessionId,
            requestDigest: supplied.requestDigest,
          });
          return admittedResult;
        }
      );
    } catch (error) {
      if (admittedResult) this._releaseClaimResult(binding, admittedResult);
      throw error;
    }
  }

  async _claimWithDeadline(binding, request, externalSignal, claimAuthority) {
    const controller = new AbortController();
    const deadlineError = codedError(
      "playback_claim_deadline",
      "playback claim exceeded its deadline"
    );
    const relayAbort = () => controller.abort(abortReason(externalSignal));
    if (externalSignal) externalSignal.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(() => controller.abort(deadlineError), this._claimDeadlineMs);
    const aborted = new Promise((resolve, reject) => {
      const rejectAborted = () => reject(abortReason(controller.signal));
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    const claimPromise = Promise.resolve().then(() =>
      this._playbackContexts.claim(
        binding.profileId,
        binding.deviceId,
        request,
        {
          generation: binding.playbackGeneration,
          deviceGeneration: binding.deviceGeneration,
          signal: controller.signal,
          sessionId: claimAuthority.sessionId,
          requestDigest: claimAuthority.requestDigest,
        }
      )
    );
    try {
      return await Promise.race([claimPromise, aborted]);
    } catch (error) {
      if (controller.signal.aborted) {
        claimPromise.then(
          (result) => this._releaseClaimResult(binding, result),
          () => {}
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener("abort", relayAbort);
    }
  }

  _releaseClaimResult(binding, result) {
    if (!result || result.status !== "claimed" || typeof result.sessionId !== "string") return;
    const cleanupOwner = result[PLAYBACK_CLAIM_CLEANUP_OWNER];
    if (cleanupOwner !== undefined) {
      if (
        typeof cleanupOwner !== "string" ||
        !this._playbackContexts ||
        typeof this._playbackContexts.releaseOwned !== "function"
      ) {
        return;
      }
      Promise.resolve()
        .then(() => this._playbackContexts.releaseOwned(
          binding.profileId,
          binding.deviceId,
          result.sessionId,
          cleanupOwner
        ))
        .catch(() => false);
      return;
    }
    Promise.resolve()
      .then(() => this._playbackContexts.release(
        binding.profileId,
        binding.deviceId,
        result.sessionId
      ))
      .catch(() => false);
  }

  async commitDisclosure(binding, emitSync) {
    if (!this._devices || typeof this._devices.commitDisclosure !== "function") {
      throw new TypeError("device disclosure dependency is required");
    }
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw new TypeError("device binding is invalid");
    }
    return this._devices.commitDisclosure(
      binding.profileId,
      binding.deviceId,
      binding.profileRevision,
      binding.deviceGeneration,
      emitSync
    );
  }

  async resumeInvalidations(limit = 32) {
    this._assertDeviceInvalidationDependencies();
    const pending = await this._lifecycleInvalidations.listPending(limit);
    let completed = 0;
    let failed = 0;
    for (const item of pending) {
      try {
        await this._processInvalidation(item);
        completed += 1;
      } catch (_error) {
        await this._deferInvalidation(item);
        failed += 1;
      }
    }
    return Object.freeze({ processed: pending.length, completed, failed });
  }

  async _processInvalidation(item) {
    if (!item || typeof item !== "object") {
      throw new TypeError("lifecycle invalidation is invalid");
    }
    if (item.kind === "profile") {
      await this._providerGateway.clearProfile(item.profileId);
      await this._subtitleManifests.requestProfileDeletion(
        item.profileId,
        "profile_invalidation_final_sweep"
      );
    } else if (item.kind === "device") {
      await this._playbackContexts.invalidateDevice(
        item.profileId,
        item.deviceId,
        item.deviceGeneration
      );
      await this._subtitleDeliveries.invalidateDevice(item.profileId, item.deviceId);
      await this._subtitleManifests.requestDeviceDeletion(
        item.profileId,
        item.deviceId,
        "device_invalidation_final_sweep"
      );
    } else {
      throw new TypeError("lifecycle invalidation kind is invalid");
    }
    await this._lifecycleInvalidations.complete(item.id);
  }

  async _deferInvalidation(item) {
    await this._lifecycleInvalidations.defer(
      item.id,
      item.attemptCount,
      this._retryAt(item.attemptCount)
    );
  }

  _retryAt(attemptCount) {
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) {
      throw new TypeError("lifecycle retry attempt count is invalid");
    }
    const exponent = Math.min(attemptCount, 30);
    const delay = Math.min(this._retryMaxMs, this._retryBaseMs * (2 ** exponent));
    return addDuration(readClock(this._clock), delay, "lifecycle retry delay");
  }

  _assertClaimDependencies() {
    if (
      !this._devices ||
      typeof this._devices.withClaimAdmission !== "function" ||
      !this._playbackContexts ||
      typeof this._playbackContexts.claim !== "function" ||
      typeof this._playbackContexts.release !== "function"
    ) {
      throw new TypeError("playback claim dependencies are required");
    }
  }

  _assertDeviceInvalidationDependencies() {
    if (
      !this._devices ||
      typeof this._devices.revokeWithInvalidation !== "function" ||
      !this._lifecycleInvalidations ||
      typeof this._lifecycleInvalidations.listPending !== "function" ||
      !this._playbackContexts ||
      typeof this._playbackContexts.invalidateDevice !== "function" ||
      !this._subtitleDeliveries ||
      typeof this._subtitleDeliveries.invalidateDevice !== "function" ||
      !this._subtitleManifests ||
      typeof this._subtitleManifests.requestDeviceDeletion !== "function"
    ) {
      throw new TypeError("device lifecycle dependencies are required");
    }
  }
}

module.exports = {
  DEFAULT_CLAIM_DEADLINE_MS,
  ProfileLifecycleService,
};
