"use strict";

const crypto = require("node:crypto");
const { clearNormalizedSubtitlePayload } = require("./subtitle-source");
const { assertRepository } = require("./storage/contracts");
const {
  assertAbortSignal,
  assertObjectStore,
  objectStoreError,
} = require("./storage/object-store");
const {
  assertBoundedString,
  assertPlainObject,
  assertPositiveInteger,
  codedError,
  readClock,
} = require("./storage/repository-utils");

const MAX_PARTS = 2;
const BUSY_RETRY_AFTER_SECONDS = 1;
const BUSY_ERROR_CODES = new Set([
  "subtitle_delivery_busy",
  "subtitle_fetch_busy",
  "subtitle_upload_busy",
]);
const TEXT_FORMATS = new Map([
  ["srt", [".srt", "application/x-subrip"]],
  ["vtt", [".vtt", "text/vtt"]],
  ["ass", [".ass", "text/x-ssa"]],
  ["ssa", [".ssa", "text/x-ssa"]],
  ["sami", [".smi", "application/x-sami"]],
  ["microdvd", [".sub", "text/x-microdvd"]],
  ["txt", [".txt", "text/plain"]],
]);

function deliveryError(code, message, statusCode = 500) {
  const error = codedError(code, message);
  error.status = statusCode;
  error.statusCode = statusCode;
  return error;
}

function busyDeliveryError() {
  const error = deliveryError(
    "subtitle_delivery_busy",
    "subtitle delivery is already being prepared",
    409
  );
  error.retryAfterSeconds = BUSY_RETRY_AFTER_SECONDS;
  return error;
}

function stableMaterializationError(error) {
  if (error && BUSY_ERROR_CODES.has(error.code)) return busyDeliveryError();
  if (error && ["subtitle_source_unavailable", "subtitle_payload_rejected"].includes(error.code)) {
    return error;
  }
  const code = error && typeof error.code === "string" ? error.code : "";
  if (code.startsWith("upstream_")) {
    return deliveryError(
      "subtitle_source_unavailable",
      "subtitle source could not be fetched",
      502
    );
  }
  if (code.startsWith("subtitle_") || error instanceof TypeError || error instanceof RangeError) {
    return deliveryError(
      "subtitle_payload_rejected",
      "subtitle payload could not be accepted",
      422
    );
  }
  return error;
}

function binding(value) {
  const input = assertPlainObject(value, "subtitle delivery binding");
  const result = {};
  for (const field of [
    "profileId",
    "deviceId",
    "sessionId",
    "generation",
    "contextId",
    "contextRevision",
    "providerRevision",
  ]) {
    result[field] = assertBoundedString(input[field], "subtitle delivery " + field, 256);
  }
  const hasProfileRevision = input.profileRevision !== undefined;
  const hasDeviceGeneration = input.deviceGeneration !== undefined;
  if (hasProfileRevision !== hasDeviceGeneration) {
    throw new TypeError("subtitle durable binding is incomplete");
  }
  if (hasProfileRevision) {
    result.profileRevision = assertPositiveInteger(
      input.profileRevision,
      "subtitle profile revision",
      Number.MAX_SAFE_INTEGER
    );
    result.deviceGeneration = assertPositiveInteger(
      input.deviceGeneration,
      "subtitle device generation",
      Number.MAX_SAFE_INTEGER
    );
  }
  return result;
}

function requireDurableBinding(value) {
  if (!Number.isSafeInteger(value.profileRevision) || !Number.isSafeInteger(value.deviceGeneration)) {
    throw deliveryError(
      "subtitle_delivery_changed",
      "subtitle delivery authorization changed",
      409
    );
  }
  return value;
}

function invalidationScope(value) {
  const input = assertPlainObject(value, "subtitle invalidation scope");
  const result = {};
  for (const field of ["profileId", "deviceId", "sessionId"]) {
    result[field] = assertBoundedString(input[field], "subtitle invalidation " + field, 256);
  }
  return result;
}

function normalizedFiles(value) {
  const normalized = assertPlainObject(value, "normalized subtitle payload");
  let files;
  if (normalized.type === "text") {
    const expected = TEXT_FORMATS.get(normalized.format);
    if (!expected || normalized.extension !== expected[0] || normalized.mediaType !== expected[1]) {
      throw new TypeError("normalized text subtitle metadata is invalid");
    }
    files = [{
      role: "subtitle",
      extension: normalized.extension,
      mediaType: normalized.mediaType,
      data: normalized.data,
    }];
  } else if (normalized.type === "vobsub") {
    if (normalized.format !== "vobsub") {
      throw new TypeError("normalized VobSub format is invalid");
    }
    files = normalized.files;
  } else {
    throw new TypeError("normalized subtitle payload type is invalid");
  }
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_PARTS) {
    throw new TypeError("normalized subtitle files are invalid");
  }
  const copies = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = assertPlainObject(files[index], "normalized subtitle file");
      if (!Buffer.isBuffer(file.data) && !(file.data instanceof Uint8Array)) {
        throw new TypeError("normalized subtitle file data is invalid");
      }
      const data = Buffer.from(file.data);
      if (data.length < 1) throw new TypeError("normalized subtitle file data is empty");
      try {
        const role = assertBoundedString(file.role, "normalized subtitle role", 16);
        const extension = assertBoundedString(file.extension, "normalized subtitle extension", 16);
        const mediaType = assertBoundedString(file.mediaType, "normalized subtitle media type", 128);
        if (normalized.type === "vobsub") {
          const expected = index === 0
            ? ["index", ".idx", "application/x-vobsub"]
            : ["sub", ".sub", "application/octet-stream"];
          if (files.length !== 2 || role !== expected[0] || extension !== expected[1] || mediaType !== expected[2]) {
            throw new TypeError("normalized VobSub file metadata is invalid");
          }
        }
        copies.push({
          partNumber: index + 1,
          sizeBytes: data.length,
          checksum: crypto.createHash("sha256").update(data).digest("hex"),
          role,
          extension,
          mediaType,
          data,
        });
      } catch (error) {
        data.fill(0);
        throw error;
      }
    }
    return copies;
  } catch (error) {
    clearFiles(copies);
    throw error;
  }
}

function publicParts(parts) {
  return parts.map((part) => Object.freeze({
    partNumber: part.partNumber,
    sizeBytes: part.sizeBytes,
    checksum: part.checksum,
    role: part.role,
    extension: part.extension,
    mediaType: part.mediaType,
  }));
}

function clearFiles(files) {
  for (const file of files) file.data.fill(0);
}

function clearOwnedBody(body) {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) body.fill(0);
}

function attachCleanupError(error, cleanupError) {
  if (!cleanupError || !error || (typeof error !== "object" && typeof error !== "function")) return;
  try {
    Object.defineProperty(error, "cleanupError", {
      configurable: true,
      enumerable: false,
      value: cleanupError,
    });
  } catch (_ignored) {
    // The operation error remains authoritative.
  }
}

function uploadDeadline(parentSignal, deadline, now) {
  if (!Number.isSafeInteger(deadline) || deadline < 0 || !Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("subtitle upload deadline is invalid");
  }
  const controller = new AbortController();
  let timer = null;
  let settled = false;
  let rejectDeadline;
  const expired = new Promise((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abortWith = (reason) => {
    if (settled) return;
    settled = true;
    rejectDeadline(reason);
    controller.abort(reason);
  };
  const onParentAbort = () => {
    const reason = parentSignal && parentSignal.reason instanceof Error
      ? parentSignal.reason
      : objectStoreError("object_store_aborted", "put");
    abortWith(reason);
  };
  if (parentSignal) parentSignal.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal && parentSignal.aborted) {
    onParentAbort();
  } else {
    const timeout = deliveryError("subtitle_upload_timeout", "subtitle upload timed out", 503);
    const delay = deadline - now;
    if (delay <= 0) abortWith(timeout);
    else timer = setTimeout(() => abortWith(timeout), delay);
  }
  return {
    expired,
    signal: controller.signal,
    cleanup() {
      if (timer !== null) clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
      settled = true;
    },
  };
}

class SubtitleDeliveryService {
  constructor(options = {}) {
    const supplied = assertPlainObject(options, "subtitle delivery service options");
    this._repository = assertRepository("subtitleDeliveries", supplied.repository);
    this._manifests = assertRepository(
      "subtitleManifests",
      supplied.manifests || supplied.manifestRepository
    );
    this._objectStore = assertObjectStore(supplied.objectStore);
    if (!supplied.source || typeof supplied.source.fetch !== "function") {
      throw new TypeError("subtitle source must provide fetch()");
    }
    if (!supplied.tokenService || typeof supplied.tokenService.issue !== "function") {
      throw new TypeError("tokenService is required");
    }
    this._source = supplied.source;
    this._tokens = supplied.tokenService;
    this._clock = supplied.clock || Date.now;
  }

  async resolve(rawBinding, request = {}) {
    const scoped = binding(rawBinding);
    const supplied = assertPlainObject(request, "subtitle resolution request");
    const signal = assertAbortSignal(supplied.signal);
    const discoveryKey = assertBoundedString(supplied.discoveryKey, "subtitle discovery key", 1024);
    const reservation = await this._repository.reserve({
      ...scoped,
      discoveryKey,
      sourceCapability: supplied.sourceCapability,
    });
    if (!reservation) return null;
    if (reservation.state === "committed") {
      return Object.freeze({
        status: "ready",
        artifactId: reservation.artifactId,
        expiresAt: reservation.expiresAt,
        parts: Object.freeze(publicParts(reservation.parts)),
      });
    }
    const fetchToken = this._tokens.issue("subtitle-fetch", 32).token;
    let fetchState;
    try {
      fetchState = await this._repository.beginFetch({
        artifactId: reservation.artifactId,
        ...scoped,
        fetchToken,
      });
      if (!fetchState) {
        await this._cleanupFetch(reservation, scoped, fetchToken, null);
        return null;
      }
      if (fetchState.status === "committed") {
        return Object.freeze({
          status: "ready",
          artifactId: reservation.artifactId,
          expiresAt: fetchState.expiresAt,
          parts: Object.freeze(publicParts(fetchState.parts)),
        });
      }
      if (fetchState.status !== "fetching" || !fetchState.sourceCapability) {
        throw busyDeliveryError();
      }
    } catch (error) {
      const stable = error && BUSY_ERROR_CODES.has(error.code) ? busyDeliveryError() : error;
      await this._cleanupFetch(reservation, scoped, fetchToken, stable);
      throw stable;
    }

    let files;
    let fetched = null;
    try {
      fetched = await this._source.fetch(fetchState.sourceCapability, {
        admissionScope: scoped.profileId,
        ...(signal ? { signal } : {}),
      });
      files = normalizedFiles(fetched.normalized);
    } catch (error) {
      const stable = stableMaterializationError(error);
      await this._cleanupFetch(reservation, scoped, fetchToken, stable);
      throw stable;
    } finally {
      clearNormalizedSubtitlePayload(fetched && fetched.normalized);
    }

    try {
      const uploadToken = this._tokens.issue("subtitle-upload", 32).token;
      let staged;
      try {
        staged = await this._repository.stageUpload({
          artifactId: reservation.artifactId,
          ...scoped,
          fetchToken,
          uploadToken,
          parts: files.map(({ data: _data, ...part }) => part),
        });
        if (!staged || (staged.status !== "uploading" && staged.status !== "committed")) {
          throw deliveryError("subtitle_delivery_changed", "subtitle delivery authorization changed", 409);
        }
        if (staged.status === "committed") {
          return Object.freeze({
            status: "ready",
            artifactId: reservation.artifactId,
            expiresAt: staged.expiresAt,
            parts: Object.freeze(publicParts(staged.parts)),
          });
        }
      } catch (error) {
        const stable = error && BUSY_ERROR_CODES.has(error.code) ? busyDeliveryError() : error;
        await this._cleanupUpload(reservation.artifactId, uploadToken, stable);
        await this._cleanupFetch(reservation, scoped, fetchToken, stable);
        throw stable;
      }

      const fileByNumber = new Map(files.map((file) => [file.partNumber, file]));
      const durable = requireDurableBinding(scoped);
      const manifestParts = staged.parts.map((part) => ({
        partNumber: part.partNumber,
        objectKey: part.objectKey,
        sizeBytes: part.sizeBytes,
        checksum: part.checksum,
        mediaType: part.mediaType,
      }));
      try {
        await this._manifests.reserve({
          profileId: durable.profileId,
          profileRevision: durable.profileRevision,
          deviceId: durable.deviceId,
          deviceGeneration: durable.deviceGeneration,
          artifactId: staged.artifactId,
          sessionId: durable.sessionId,
          playbackGeneration: durable.generation,
          contextRevision: durable.contextRevision,
          providerRevision: durable.providerRevision,
          expiresAt: staged.expiresAt,
          uploadSettlementDeadline: staged.uploadSettlementDeadline,
          parts: manifestParts,
        });
      } catch (error) {
        await this._cleanupUpload(reservation.artifactId, uploadToken, error);
        await this._cleanupManifest(
          durable.profileId,
          reservation.artifactId,
          "manifest_reserve_failed",
          error
        );
        throw error;
      }

      const deadline = uploadDeadline(
        signal,
        staged.uploadExpiresAt,
        readClock(this._clock)
      );
      const pendingWrites = Promise.allSettled(
        staged.parts.map(async (part) => {
          const file = fileByNumber.get(part.partNumber);
          if (!file || file.sizeBytes !== part.sizeBytes || file.checksum !== part.checksum ||
              file.mediaType !== part.mediaType) {
            throw deliveryError(
              "subtitle_stage_integrity",
              "staged subtitle metadata does not match normalized content"
            );
          }
          return this._objectStore.put(part.objectKey, file.data, {
            checksumSha256: part.checksum,
            contentLength: part.sizeBytes,
            contentType: part.mediaType,
            signal: deadline.signal,
          });
        })
      );
      let writes;
      try {
        writes = await Promise.race([pendingWrites, deadline.expired]);
      } catch (error) {
        await this._cleanupUpload(reservation.artifactId, uploadToken, error);
        await this._cleanupManifest(
          durable.profileId,
          reservation.artifactId,
          "upload_failed",
          error
        );
        throw error;
      } finally {
        deadline.cleanup();
      }
      const failedWrite = writes.find((result) => result.status === "rejected");
      if (failedWrite) {
        await this._cleanupUpload(reservation.artifactId, uploadToken, failedWrite.reason);
        await this._cleanupManifest(
          durable.profileId,
          reservation.artifactId,
          "upload_failed",
          failedWrite.reason
        );
        throw failedWrite.reason;
      }

      const uploadReceipts = writes.map((result, index) => {
        const stored = result.value;
        const stagedPart = staged.parts[index];
        return {
          partNumber: stagedPart.partNumber,
          objectKey: stored.key,
          sizeBytes: stored.contentLength,
          checksum: stored.checksumSha256,
          mediaType: stored.contentType,
        };
      });
      let committed;
      try {
        committed = await this._repository.commit({
          artifactId: reservation.artifactId,
          ...scoped,
          uploadToken,
          receipts: uploadReceipts,
        });
        if (!committed) {
          throw deliveryError("subtitle_delivery_changed", "subtitle delivery authorization changed", 409);
        }
      } catch (error) {
        await this._cleanupUpload(reservation.artifactId, uploadToken, error);
        await this._cleanupManifest(
          durable.profileId,
          reservation.artifactId,
          "delivery_commit_failed",
          error
        );
        throw error;
      }
      const durableCommitted = await this._manifests.commit({
        profileId: durable.profileId,
        artifactId: committed.artifactId,
      });
      if (!durableCommitted) {
        const changed = deliveryError(
          "subtitle_delivery_changed",
          "subtitle delivery authorization changed",
          409
        );
        await this._invalidateDelivery(durable, changed);
        await this._cleanupManifest(
          durable.profileId,
          committed.artifactId,
          "manifest_commit_failed",
          changed
        );
        throw changed;
      }
      return Object.freeze({
        status: "ready",
        artifactId: committed.artifactId,
        expiresAt: committed.expiresAt,
        parts: Object.freeze(publicParts(committed.parts)),
      });
    } finally {
      clearFiles(files);
    }
  }

  async read(rawBinding, artifactId, partNumber, options = {}) {
    const scoped = binding(rawBinding);
    const id = assertBoundedString(artifactId, "subtitle artifact id", 256);
    const number = assertPositiveInteger(partNumber, "subtitle part number", MAX_PARTS);
    const supplied = assertPlainObject(options, "subtitle read options");
    const method = String(supplied.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new TypeError("subtitle read method is invalid");
    const signal = assertAbortSignal(supplied.signal);
    const lease = await this._repository.authorize({
      artifactId: id,
      ...scoped,
      method,
    });
    if (!lease) return null;
    let ownedBody = null;
    let response = null;
    let operationError = null;
    try {
      const part = lease.parts.find((candidate) => candidate.partNumber === number);
      if (part) {
        const expected = {
          checksumSha256: part.checksum,
          contentLength: part.sizeBytes,
          maxBytes: part.sizeBytes,
          ...(signal ? { signal } : {}),
        };
        const stored = method === "HEAD"
          ? await this._objectStore.head(part.objectKey, expected)
          : await this._objectStore.get(part.objectKey, expected);
        if (method === "GET") ownedBody = stored.body;
        if (stored.contentType !== part.mediaType) {
          throw objectStoreError("object_store_integrity", method === "HEAD" ? "head" : "get");
        }
        const current = await this._repository.revalidate({
          artifactId: id,
          ...scoped,
          leaseToken: lease.leaseToken,
        });
        if (!current) {
          throw deliveryError("subtitle_authorization_changed", "subtitle delivery authorization changed", 409);
        }
        response = Object.freeze({
          artifactId: id,
          partNumber: number,
          role: part.role,
          extension: part.extension,
          mediaType: part.mediaType,
          checksum: part.checksum,
          sizeBytes: part.sizeBytes,
          ...(method === "GET" ? { body: ownedBody } : {}),
        });
      }
    } catch (error) {
      operationError = error;
    }

    let releaseError = null;
    try {
      await this._repository.releaseLease(id, lease.leaseToken);
    } catch (error) {
      releaseError = error;
    }

    if (operationError) {
      clearOwnedBody(ownedBody);
      if (releaseError) attachCleanupError(operationError, releaseError);
      throw operationError;
    }
    if (releaseError) {
      clearOwnedBody(ownedBody);
      throw releaseError;
    }

    ownedBody = null;
    return response;
  }

  async invalidate(rawBinding, artifactId, reason = "disclosure_rejected") {
    const scoped = invalidationScope(rawBinding);
    const id = assertBoundedString(artifactId, "subtitle artifact id", 256);
    const failure = deliveryError(
      "subtitle_authorization_changed",
      "subtitle delivery authorization changed",
      409
    );
    await this._invalidateDelivery(scoped, failure);
    await this._cleanupManifest(scoped.profileId, id, reason, failure);
    return true;
  }

  async _cleanupFetch(reservation, scoped, fetchToken, error) {
    const cleanupErrors = [];
    let canceled = false;
    try {
      canceled = Boolean(await this._repository.cancelReservation({
        artifactId: reservation.artifactId,
        ...scoped,
        ...(reservation.reservationToken
          ? { reservationToken: reservation.reservationToken }
          : {}),
        fetchToken,
      }));
    } catch (failure) {
      cleanupErrors.push(failure);
    }
    if (!canceled) {
      try {
        await this._repository.releaseFetch(reservation.artifactId, fetchToken);
      } catch (failure) {
        cleanupErrors.push(failure);
      }
    }
    const cleanupError = cleanupErrors.length > 1
      ? new AggregateError(cleanupErrors, "subtitle fetch cleanup failed")
      : cleanupErrors[0];
    attachCleanupError(error, cleanupError);
  }

  async _cleanupUpload(artifactId, uploadToken, error) {
    let cleanupError = null;
    try {
      await this._repository.abortUpload({ artifactId, uploadToken });
    } catch (failure) {
      cleanupError = failure;
    }
    attachCleanupError(error, cleanupError);
  }

  async _cleanupManifest(profileId, artifactId, reason, error) {
    let cleanupError = null;
    try {
      await this._manifests.requestArtifactDeletion(profileId, artifactId, reason);
    } catch (failure) {
      cleanupError = failure;
    }
    attachCleanupError(error, cleanupError);
  }

  async _invalidateDelivery(scoped, error) {
    let cleanupError = null;
    try {
      await this._repository.invalidateRelease(
        scoped.profileId,
        scoped.deviceId,
        scoped.sessionId
      );
    } catch (failure) {
      cleanupError = failure;
    }
    attachCleanupError(error, cleanupError);
  }
}

module.exports = {
  BUSY_RETRY_AFTER_SECONDS,
  SubtitleDeliveryService,
  deliveryError,
};
