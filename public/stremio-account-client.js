(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.JumpgateStremioAccount = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LINK_ORIGIN = "https://link.stremio.com";
  const ACCOUNT_ORIGIN = "https://api.strem.io";
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
  const MAX_ADDONS = 256;
  const PENDING_LINK_CODE = 101;
  const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;
  const DEFAULT_LINK_LIFETIME_MS = 4 * 60 * 1000;
  const MAX_LINK_LIFETIME_MS = 4 * 60 * 1000;
  const MAX_TIMEOUT_MS = 15 * 60 * 1000;
  const UINT64_MAX = "18446744073709551615";
  const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

  class StremioAccountError extends Error {
    constructor(code, message, status) {
      super(message);
      this.name = "StremioAccountError";
      this.code = code;
      this.status = status || 0;
    }
  }

  function abortedError() {
    return new StremioAccountError("aborted", "Stremio link was canceled");
  }

  function expiredError() {
    return new StremioAccountError("link_expired", "Stremio link expired before approval");
  }

  function requestTimeoutError() {
    return new StremioAccountError("request_timeout", "Stremio account request timed out");
  }

  function isAbortError(error) {
    return Boolean(error && (error.name === "AbortError" || error.code === "ABORT_ERR"));
  }

  function assertAbortSignal(signal) {
    if (signal === undefined || signal === null) return null;
    if (
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function"
    ) {
      throw new TypeError("signal is invalid");
    }
    return signal;
  }

  function assertBoundedString(value, name, maximumLength, pattern) {
    if (
      typeof value !== "string" ||
      !value ||
      value.length > maximumLength ||
      value.trim() !== value ||
      /[\u0000-\u001f\u007f]/.test(value) ||
      (pattern && !pattern.test(value))
    ) {
      throw new TypeError(name + " is invalid");
    }
    return value;
  }

  function assertHttpsUrl(value, name, allowedOrigin) {
    const text = assertBoundedString(value, name, 2048);
    let parsed;
    try {
      parsed = new URL(text);
    } catch (_error) {
      throw new TypeError(name + " is invalid");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
      throw new TypeError(name + " is invalid");
    }
    if (allowedOrigin && parsed.origin !== allowedOrigin) throw new TypeError(name + " has an unexpected origin");
    return parsed.toString();
  }

  function byteLength(text) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(text).byteLength;
    if (typeof Buffer === "function") return Buffer.byteLength(text, "utf8");
    return unescape(encodeURIComponent(text)).length;
  }

  function serializeJson(value, maximumBytes) {
    let text;
    try {
      text = JSON.stringify(value);
    } catch (_error) {
      throw new TypeError("request body is not JSON serializable");
    }
    if (typeof text !== "string") throw new TypeError("request body is not JSON serializable");
    if (byteLength(text) > maximumBytes) {
      throw new StremioAccountError("request_too_large", "Stremio request exceeds the size limit");
    }
    return text;
  }

  function responseTooLarge(status) {
    return new StremioAccountError("response_too_large", "Stremio response exceeds the size limit", status);
  }

  function asByteChunk(value) {
    if (typeof Uint8Array === "function" && value instanceof Uint8Array) return value;
    if (typeof ArrayBuffer === "function" && value instanceof ArrayBuffer) return new Uint8Array(value);
    if (typeof ArrayBuffer === "function" && ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  function decodeByteChunks(chunks) {
    if (typeof Buffer === "function") {
      return Buffer.concat(
        chunks.map(function (chunk) {
          return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        })
      ).toString("utf8");
    }
    let binary = "";
    for (const chunk of chunks) {
      for (let offset = 0; offset < chunk.byteLength; offset += 0x8000) {
        binary += String.fromCharCode.apply(null, chunk.subarray(offset, offset + 0x8000));
      }
    }
    return decodeURIComponent(escape(binary));
  }

  function cancelReader(reader) {
    try {
      const canceled = reader.cancel();
      if (canceled && typeof canceled.catch === "function") canceled.catch(function () {});
    } catch (_error) {
      // The size-limit error remains authoritative if cancellation itself fails.
    }
  }

  function cancelResponseBody(body) {
    if (!body) return;
    if (typeof body.cancel === "function") {
      try {
        const canceled = body.cancel();
        if (canceled && typeof canceled.catch === "function") canceled.catch(function () {});
      } catch (_error) {
        // The response error remains authoritative if cancellation itself fails.
      }
      return;
    }
    if (typeof body.getReader !== "function") return;

    let reader;
    try {
      reader = body.getReader();
      cancelReader(reader);
    } catch (_error) {
      return;
    }
    if (reader && typeof reader.releaseLock === "function") {
      try {
        reader.releaseLock();
      } catch (_error) {
        // The response error remains authoritative if releasing the lock fails.
      }
    }
  }

  async function readBoundedText(response, maximumBytes, status, signal) {
    const body = response.body;
    const contentLength =
      response.headers && typeof response.headers.get === "function"
        ? response.headers.get("content-length")
        : null;
    if (contentLength !== null && /^\d+$/.test(String(contentLength).trim())) {
      const declaredBytes = Number(contentLength);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
        cancelResponseBody(body);
        throw responseTooLarge(status);
      }
    }

    if (body && typeof body.getReader === "function") {
      const reader = body.getReader();
      const decoder = typeof TextDecoder === "function" ? new TextDecoder("utf-8") : null;
      const parts = [];
      let totalBytes = 0;
      const onAbort = signal
        ? function () {
            cancelReader(reader);
          }
        : null;
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        while (true) {
          const item = await reader.read();
          if (!item || typeof item.done !== "boolean") {
            cancelReader(reader);
            throw new StremioAccountError("invalid_response", "Stremio returned an invalid response", status);
          }
          if (item.done) break;
          const chunk = asByteChunk(item.value);
          if (!chunk) {
            cancelReader(reader);
            throw new StremioAccountError("invalid_response", "Stremio returned an invalid response", status);
          }
          totalBytes += chunk.byteLength;
          if (totalBytes > maximumBytes) {
            cancelReader(reader);
            throw responseTooLarge(status);
          }
          parts.push(decoder ? decoder.decode(chunk, { stream: true }) : chunk);
        }
        if (decoder) {
          parts.push(decoder.decode());
          return parts.join("");
        }
        return decodeByteChunks(parts);
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (typeof reader.releaseLock === "function") {
          try {
            reader.releaseLock();
          } catch (_error) {
            // Reader cleanup must not replace the request result.
          }
        }
      }
    }

    if (typeof response.text !== "function") {
      throw new StremioAccountError("invalid_response", "Stremio returned an invalid response", status);
    }
    const text = await response.text();
    if (typeof text !== "string") {
      throw new StremioAccountError("invalid_response", "Stremio returned an invalid response", status);
    }
    if (byteLength(text) > maximumBytes) throw responseTooLarge(status);
    return text;
  }

  async function readApiResult(response, maximumBytes, signal) {
    if (!response || typeof response !== "object") {
      throw new StremioAccountError("invalid_response", "Stremio returned an invalid response");
    }
    const status = Number(response.status) || 0;
    const text = await readBoundedText(response, maximumBytes, status, signal);
    let body;
    try {
      body = JSON.parse(text);
    } catch (_error) {
      throw new StremioAccountError("invalid_json", "Stremio returned invalid JSON", status);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new StremioAccountError("invalid_response", "Stremio returned an invalid response", status);
    }
    if (!response.ok) {
      throw new StremioAccountError("http_error", "Stremio request failed", status);
    }
    if (body.error) {
      const code = Number(body.error.code);
      const message =
        typeof body.error.message === "string" && body.error.message
          ? body.error.message.slice(0, 256)
          : "Stremio rejected the request";
      throw new StremioAccountError(Number.isSafeInteger(code) ? code : "api_error", message, status);
    }
    if (!Object.prototype.hasOwnProperty.call(body, "result")) {
      throw new StremioAccountError("invalid_response", "Stremio response is missing result", status);
    }
    return body.result;
  }

  function defaultSleep(milliseconds, signal) {
    return new Promise(function (resolve, reject) {
      let timer = null;
      let settled = false;

      function cleanup() {
        if (timer !== null) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      }

      function settle(callback, value) {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      }

      function onAbort() {
        settle(reject, abortedError());
      }

      if (signal && signal.aborted) {
        reject(abortedError());
        return;
      }
      timer = setTimeout(function () {
        settle(resolve);
      }, milliseconds);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function isManifestString(value, maximumLength) {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximumLength &&
      !/[\u0000-\u001f\u007f]/.test(value)
    );
  }

  function isUint64Decimal(value) {
    return value.length < UINT64_MAX.length || (value.length === UINT64_MAX.length && value <= UINT64_MAX);
  }

  function isSemver(value) {
    if (typeof value !== "string" || value.length > 256) return false;
    const match = SEMVER_PATTERN.exec(value);
    return Boolean(
      match && isUint64Decimal(match[1]) && isUint64Decimal(match[2]) && isUint64Decimal(match[3])
    );
  }

  function isStringArray(value) {
    if (!Array.isArray(value)) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] !== "string") return false;
    }
    return true;
  }

  function isOptionalStringArray(record, name) {
    return (
      !Object.prototype.hasOwnProperty.call(record, name) ||
      record[name] === null ||
      isStringArray(record[name])
    );
  }

  function isManifestResource(value) {
    if (typeof value === "string") return true;
    return (
      isRecord(value) &&
      typeof value.name === "string" &&
      isOptionalStringArray(value, "types") &&
      isOptionalStringArray(value, "idPrefixes")
    );
  }

  function isManifestResourceArray(value) {
    if (!Array.isArray(value)) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!isManifestResource(value[index])) return false;
    }
    return true;
  }

  function isTransportUrl(value) {
    if (typeof value !== "string" || !value || value.length > 2048 || value.trim() !== value) return false;
    let parsed;
    try {
      parsed = new URL(value);
    } catch (_error) {
      return false;
    }
    return (
      (parsed.protocol === "https:" ||
        parsed.protocol === "http:" ||
        parsed.protocol === "ipfs:" ||
        parsed.protocol === "ipns:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  }

  function isAddonDescriptor(value) {
    if (!isRecord(value) || !isRecord(value.manifest) || !isTransportUrl(value.transportUrl)) return false;
    const manifest = value.manifest;
    if (
      !isManifestString(manifest.id, 1024) ||
      !isSemver(manifest.version) ||
      !isManifestString(manifest.name, 1024) ||
      !isStringArray(manifest.types) ||
      !isManifestResourceArray(manifest.resources) ||
      !isOptionalStringArray(manifest, "idPrefixes")
    ) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(value, "flags")) {
      if (!isRecord(value.flags)) return false;
      if (
        (Object.prototype.hasOwnProperty.call(value.flags, "official") &&
          typeof value.flags.official !== "boolean") ||
        (Object.prototype.hasOwnProperty.call(value.flags, "protected") &&
          typeof value.flags.protected !== "boolean")
      ) {
        return false;
      }
    }
    return true;
  }

  function isRfc3339(value) {
    if (typeof value !== "string" || value.length > 64) return false;
    const match =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
        value
      );
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
    const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return (
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth[month - 1] &&
      hour <= 23 &&
      minute <= 59 &&
      second <= 59 &&
      offsetHour <= 23 &&
      offsetMinute <= 59 &&
      Number.isFinite(Date.parse(value))
    );
  }

  function validateAddonCollection(result) {
    if (!isRecord(result) || !Array.isArray(result.addons) || !isRfc3339(result.lastModified)) {
      throw new StremioAccountError("invalid_collection", "Stremio addon collection is invalid");
    }
    if (result.addons.length > MAX_ADDONS) {
      throw new StremioAccountError("collection_too_large", "Stremio addon collection exceeds the entry limit");
    }
    for (const descriptor of result.addons) {
      if (!isAddonDescriptor(descriptor)) {
        throw new StremioAccountError("invalid_collection", "Stremio addon collection is invalid");
      }
    }
    return { addons: result.addons, lastModified: result.lastModified };
  }

  function createStremioAccountClient(options) {
    const settings = options || {};
    const fetchImpl = settings.fetch === undefined ? (typeof fetch === "function" ? fetch : null) : settings.fetch;
    if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
    const clock = settings.clock === undefined ? Date.now : settings.clock;
    const sleep = settings.sleep === undefined ? defaultSleep : settings.sleep;
    if (typeof clock !== "function" || typeof sleep !== "function") throw new TypeError("clock and sleep must be functions");
    const requestTimeoutMs =
      settings.requestTimeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : settings.requestTimeoutMs;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 ||
      requestTimeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new TypeError("requestTimeoutMs is invalid");
    }

    function clockNow() {
      const timestamp = clock();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new TypeError("clock returned an invalid timestamp");
      }
      return timestamp;
    }

    function deadlineAfter(milliseconds) {
      const deadline = clockNow() + milliseconds;
      if (!Number.isSafeInteger(deadline)) throw new TypeError("request deadline is invalid");
      return deadline;
    }

    async function request(url, options, maximumBytes) {
      const requestOptions = options || {};
      const requestSignal = requestOptions.signal || null;
      try {
        const response = await fetchImpl(url, {
          cache: "no-store",
          credentials: "omit",
          mode: "cors",
          redirect: "error",
          referrerPolicy: "no-referrer",
          ...requestOptions,
        });
        return await readApiResult(
          response,
          maximumBytes === undefined ? MAX_RESPONSE_BYTES : maximumBytes,
          requestSignal
        );
      } catch (error) {
        if (isAbortError(error)) throw abortedError();
        throw error;
      }
    }

    async function requestUntil(
      url,
      options,
      maximumBytes,
      expiresAt,
      callerSignal,
      deadlineErrorFactory
    ) {
      if (callerSignal && callerSignal.aborted) throw abortedError();
      const remaining = expiresAt - clockNow();
      if (remaining <= 0) throw deadlineErrorFactory();
      if (typeof AbortController !== "function") throw new TypeError("AbortController is required");

      const controller = new AbortController();
      let abortKind = null;
      let onInternalAbort;
      const abortPromise = new Promise(function (_resolve, reject) {
        onInternalAbort = function () {
          reject(abortKind === "caller" ? abortedError() : deadlineErrorFactory());
        };
        controller.signal.addEventListener("abort", onInternalAbort, { once: true });
      });
      const onCallerAbort = function () {
        if (abortKind) return;
        abortKind = "caller";
        controller.abort();
      };
      if (callerSignal) callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      const deadlineTimer = setTimeout(function () {
        if (abortKind) return;
        abortKind = "deadline";
        controller.abort();
      }, remaining);
      const requestPromise = request(
        url,
        { ...options, signal: controller.signal },
        maximumBytes
      );

      try {
        const result = await Promise.race([requestPromise, abortPromise]);
        if ((callerSignal && callerSignal.aborted) || abortKind === "caller") {
          if (!controller.signal.aborted) controller.abort();
          throw abortedError();
        }
        if (abortKind === "deadline" || clockNow() >= expiresAt) {
          if (!controller.signal.aborted) controller.abort();
          throw deadlineErrorFactory();
        }
        return result;
      } catch (error) {
        if ((callerSignal && callerSignal.aborted) || abortKind === "caller") {
          throw abortedError();
        }
        if (abortKind === "deadline") {
          throw deadlineErrorFactory();
        }
        if (isAbortError(error) || (error instanceof StremioAccountError && error.code === "aborted")) {
          throw abortedError();
        }
        throw error;
      } finally {
        clearTimeout(deadlineTimer);
        controller.signal.removeEventListener("abort", onInternalAbort);
        if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }

    function requestBeforeDeadline(
      url,
      options,
      maximumBytes,
      expiresAt,
      callerSignal
    ) {
      return requestUntil(
        url,
        options,
        maximumBytes,
        expiresAt,
        callerSignal,
        expiredError
      );
    }

    function requestWithTimeout(
      url,
      options,
      maximumBytes,
      timeoutMs,
      callerSignal,
      deadlineErrorFactory
    ) {
      return requestUntil(
        url,
        options,
        maximumBytes,
        deadlineAfter(timeoutMs),
        callerSignal,
        deadlineErrorFactory
      );
    }

    async function createLinkSession(sessionOptions) {
      const input = sessionOptions || {};
      const signal = assertAbortSignal(input.signal);
      const expiresInMs = input.expiresInMs === undefined ? DEFAULT_LINK_LIFETIME_MS : input.expiresInMs;
      const pollIntervalMs = input.pollIntervalMs === undefined ? 2000 : input.pollIntervalMs;
      if (
        !Number.isSafeInteger(expiresInMs) ||
        expiresInMs < 60 * 1000 ||
        expiresInMs > MAX_LINK_LIFETIME_MS
      ) {
        throw new TypeError("expiresInMs is invalid");
      }
      if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 10000) {
        throw new TypeError("pollIntervalMs is invalid");
      }

      const createdAt = clockNow();
      const expiresAt = createdAt + expiresInMs;
      if (!Number.isSafeInteger(expiresAt)) throw new TypeError("link expiration timestamp is invalid");
      const createUrl = LINK_ORIGIN + "/api/v2/create?type=Create";
      const result = await requestBeforeDeadline(createUrl, { method: "GET" }, 64 * 1024, expiresAt, signal);
      if (!isRecord(result)) {
        throw new StremioAccountError("invalid_link", "Stremio returned an invalid link session");
      }
      const code = assertBoundedString(result.code, "link code", 128, /^[A-Za-z0-9_-]{4,128}$/);
      const link = assertHttpsUrl(result.link, "link URL", LINK_ORIGIN);
      const qrcode = assertHttpsUrl(result.qrcode, "QR URL", LINK_ORIGIN);
      let consumed = false;

      return Object.freeze({
        code,
        link,
        qrcode,
        expiresAt,
        async readAddonCollection(readOptions) {
          if (consumed) throw new StremioAccountError("session_consumed", "Stremio link session was already used");
          const options = readOptions || {};
          if (!isRecord(options)) throw new TypeError("read options are invalid");
          const onApproved = options.onApproved;
          if (onApproved !== undefined && typeof onApproved !== "function") {
            throw new TypeError("onApproved must be a function");
          }
          consumed = true;
          let authKey = null;
          let collectionBody = null;

          try {
            while (true) {
              if (signal && signal.aborted) throw abortedError();
              if (clockNow() >= expiresAt) throw expiredError();
              const readUrl = LINK_ORIGIN + "/api/v2/read?type=Read&code=" + encodeURIComponent(code);
              try {
                const readResult = await requestBeforeDeadline(
                  readUrl,
                  { method: "GET" },
                  64 * 1024,
                  expiresAt,
                  signal
                );
                if (!isRecord(readResult) || typeof readResult.authKey !== "string") {
                  throw new StremioAccountError("invalid_link", "Stremio link response is invalid");
                }
                authKey = readResult.authKey;
                assertBoundedString(authKey, "auth key", 2048);
                if (onApproved) onApproved();
                break;
              } catch (error) {
                if (!(error instanceof StremioAccountError) || error.code !== PENDING_LINK_CODE) throw error;
              }

              const remaining = expiresAt - clockNow();
              if (remaining <= 0) throw expiredError();
              try {
                await sleep(Math.min(pollIntervalMs, remaining), signal);
              } catch (error) {
                if (signal && signal.aborted) throw abortedError();
                if (clockNow() >= expiresAt) throw expiredError();
                if (isAbortError(error) || (error instanceof StremioAccountError && error.code === "aborted")) {
                  throw abortedError();
                }
                throw error;
              }
            }

            collectionBody = serializeJson(
              { type: "AddonCollectionGet", authKey, update: true },
              MAX_REQUEST_BYTES
            );
            const collection = await requestWithTimeout(
              ACCOUNT_ORIGIN + "/api/addonCollectionGet",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: collectionBody,
              },
              MAX_RESPONSE_BYTES,
              requestTimeoutMs,
              signal,
              requestTimeoutError
            );
            return validateAddonCollection(collection);
          } finally {
            collectionBody = null;
            authKey = null;
          }
        },
      });
    }

    return Object.freeze({ createLinkSession });
  }

  return Object.freeze({
    ACCOUNT_ORIGIN,
    LINK_ORIGIN,
    StremioAccountError,
    createStremioAccountClient,
  });
});
