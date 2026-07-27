(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else api.mount(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const JUMPGATE_ADDON_ID = "com.jumpgate.bridge";
  const MAX_IMPORTED_PROVIDERS = 64;
  const MAX_MANAGED_DEVICES = 128;
  const PAIRING_RECOVERY_STORAGE_KEY = "jumpgate.pairing.activation.v1";
  const PAIRING_RECOVERY_TTL_MS = 10 * 60 * 1000;
  const PROFILE_DELETE_CONFIRMATION = "DELETE PROFILE";
  const MANAGEMENT_AUTH_REQUIRED_MESSAGE =
    "Management authorization expired. Generate a new pairing code in Jumpgate Manager, enter it here, and pair again before changing providers.";

  function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isActivationRetryToken(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  }

  function encodeBase64Url(bytes, encodeBase64) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
      throw new TypeError("activation retry entropy is invalid");
    }
    if (typeof encodeBase64 !== "function") {
      throw new TypeError("base64 encoder is unavailable");
    }
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const token = encodeBase64(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (!isActivationRetryToken(token)) {
      throw new Error("activation retry token generation failed");
    }
    return token;
  }

  function createActivationRetryToken(cryptoApi, encodeBase64) {
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") {
      throw new Error("Secure browser randomness is unavailable");
    }
    const bytes = new Uint8Array(32);
    try {
      cryptoApi.getRandomValues(bytes);
      return encodeBase64Url(bytes, encodeBase64);
    } finally {
      bytes.fill(0);
    }
  }

  function validatePairingRecoveryRecord(value, nowMs) {
    if (!isRecord(value)) throw new Error("Stored pairing recovery state is invalid");
    const fields = Object.keys(value).sort();
    if (
      fields.length !== 5 ||
      fields[0] !== "config" ||
      fields[1] !== "retryToken" ||
      fields[2] !== "submittedAt" ||
      fields[3] !== "userCode" ||
      fields[4] !== "v" ||
      value.v !== 1 ||
      !isActivationRetryToken(value.retryToken) ||
      typeof value.config !== "string" ||
      !value.config ||
      value.config.length > 1024 * 1024 ||
      typeof value.userCode !== "string" ||
      !/^[A-Z0-9]{8}$/.test(value.userCode) ||
      !Number.isSafeInteger(value.submittedAt) ||
      value.submittedAt < 0
    ) {
      throw new Error("Stored pairing recovery state is invalid");
    }
    const now = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
    if (value.submittedAt > now + 60 * 1000) {
      throw new Error("Stored pairing recovery time is invalid");
    }
    return Object.freeze({
      v: 1,
      retryToken: value.retryToken,
      config: value.config,
      userCode: value.userCode,
      submittedAt: value.submittedAt,
    });
  }

  function persistPairingRecovery(storage, value) {
    if (!storage || typeof storage.setItem !== "function" || typeof storage.getItem !== "function") {
      throw new Error("Session recovery storage is unavailable");
    }
    const record = validatePairingRecoveryRecord(value, value && value.submittedAt);
    const serialized = JSON.stringify(record);
    try {
      storage.setItem(PAIRING_RECOVERY_STORAGE_KEY, serialized);
      if (storage.getItem(PAIRING_RECOVERY_STORAGE_KEY) !== serialized) {
        throw new Error("Session recovery storage did not retain pairing state");
      }
    } catch (_error) {
      throw new Error("Pairing cannot start because session recovery storage is unavailable");
    }
    return record;
  }

  function readPairingRecovery(storage, nowMs) {
    if (!storage || typeof storage.getItem !== "function" || typeof storage.removeItem !== "function") {
      throw new Error("Session recovery storage is unavailable");
    }
    let serialized;
    try {
      serialized = storage.getItem(PAIRING_RECOVERY_STORAGE_KEY);
    } catch (_error) {
      throw new Error("Session recovery storage is unavailable");
    }
    if (!serialized) return null;
    let record;
    try {
      record = validatePairingRecoveryRecord(JSON.parse(serialized), nowMs);
    } catch (_error) {
      try {
        storage.removeItem(PAIRING_RECOVERY_STORAGE_KEY);
      } catch (_removeError) {}
      throw new Error("Stored pairing recovery state is invalid");
    }
    const now = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
    if (record.submittedAt + PAIRING_RECOVERY_TTL_MS <= now) {
      storage.removeItem(PAIRING_RECOVERY_STORAGE_KEY);
      return null;
    }
    return record;
  }

  function clearPairingRecovery(storage) {
    if (!storage || typeof storage.removeItem !== "function") return false;
    try {
      storage.removeItem(PAIRING_RECOVERY_STORAGE_KEY);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function preparePairingActivation(storage, cryptoApi, encodeBase64, input, nowMs) {
    if (!isRecord(input)) throw new TypeError("pairing activation input is invalid");
    const userCode = input.userCode;
    const config = input.config;
    if (typeof userCode !== "string" || !/^[A-Z0-9]{8}$/.test(userCode)) {
      throw new TypeError("pairing user code is invalid");
    }
    if (typeof config !== "string" || !config || config.length > 1024 * 1024) {
      throw new TypeError("pairing config is invalid");
    }
    const now = Number.isSafeInteger(nowMs) ? nowMs : Date.now();
    const existing = readPairingRecovery(storage, now);
    if (existing) {
      if (existing.userCode !== userCode || existing.config !== config) {
        throw new Error(
          "An earlier pairing attempt is awaiting recovery in this tab. Reload before starting another."
        );
      }
      return existing;
    }
    const retryToken = createActivationRetryToken(cryptoApi, encodeBase64);
    return persistPairingRecovery(storage, {
      v: 1,
      retryToken,
      config,
      userCode,
      submittedAt: now,
    });
  }

  function pairingActivationPayload(attempt, recovery) {
    const record = validatePairingRecoveryRecord(attempt, attempt && attempt.submittedAt);
    return recovery
      ? { config: record.config, activationRetryToken: record.retryToken }
      : {
          userCode: record.userCode,
          config: record.config,
          activationRetryToken: record.retryToken,
        };
  }

  function requestPairingActivation(fetchApi, attempt, recovery) {
    if (typeof fetchApi !== "function") throw new TypeError("pairing fetch is unavailable");
    return fetchApi("/pair/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(pairingActivationPayload(attempt, recovery)),
    });
  }

  function boundedDisplayText(value, fallback, maximumLength) {
    if (typeof value !== "string") return fallback;
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return normalized ? normalized.slice(0, maximumLength) : fallback;
  }

  function parseManagedDevicesResponse(value) {
    if (!isRecord(value) || value.ok !== true || !Array.isArray(value.devices)) {
      throw new Error("Jumpgate returned an invalid paired-device list");
    }
    if (value.devices.length > MAX_MANAGED_DEVICES) {
      throw new Error("Jumpgate returned too many paired devices");
    }
    const devices = value.devices.map((device) => {
      if (!isRecord(device)) throw new Error("Jumpgate returned an invalid paired device");
      const idFromDeviceId = typeof device.deviceId === "string" ? device.deviceId : "";
      const idFromId = typeof device.id === "string" ? device.id : "";
      if (idFromDeviceId && idFromId && idFromDeviceId !== idFromId) {
        throw new Error("Jumpgate returned an ambiguous paired device");
      }
      const id = (idFromDeviceId || idFromId).trim();
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
        throw new Error("Jumpgate returned an invalid paired device");
      }
      const displayName = boundedDisplayText(device.displayName, "", 128);
      if (!displayName) {
        throw new Error("Jumpgate returned an invalid paired device name");
      }
      if (device.current !== undefined && typeof device.current !== "boolean") {
        throw new Error("Jumpgate returned an invalid current-device marker");
      }
      const lastSeenAt = device.lastSeenAt;
      if (
        lastSeenAt !== undefined &&
        lastSeenAt !== null &&
        !(Number.isSafeInteger(lastSeenAt) && lastSeenAt >= 0) &&
        !(typeof lastSeenAt === "string" && Number.isFinite(Date.parse(lastSeenAt)))
      ) {
        throw new Error("Jumpgate returned an invalid device activity time");
      }
      return Object.freeze({
        id,
        displayName,
        current: device.current === true,
        lastSeenAt: lastSeenAt === undefined ? null : lastSeenAt,
      });
    });
    const traktLinked = value.traktLinked;
    if (traktLinked !== undefined && typeof traktLinked !== "boolean") {
      throw new Error("Jumpgate returned an invalid Trakt state");
    }
    return Object.freeze({ devices, traktLinked });
  }

  function safeSameOriginRedirect(value, origin) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("Jumpgate did not return a Trakt connection route");
    }
    let expectedOrigin;
    let target;
    try {
      expectedOrigin = new URL(origin).origin;
      target = new URL(value, expectedOrigin);
    } catch (_error) {
      throw new Error("Jumpgate returned an invalid Trakt connection route");
    }
    if (
      target.origin !== expectedOrigin ||
      (target.protocol !== "https:" && target.protocol !== "http:") ||
      target.username ||
      target.password
    ) {
      throw new Error("Jumpgate returned an unsafe Trakt connection route");
    }
    return target.href;
  }

  function managementFailureMessage(status) {
    if (status === 401 || status === 403) return "Pair Jumpgate again to authorize profile changes.";
    if (status === 404) return "This profile item is no longer available. Refresh and try again.";
    if (status === 409) return "The profile changed while this action was running. Refresh and try again.";
    if (status === 429) return "Too many profile actions. Wait briefly and try again.";
    return "Jumpgate could not complete this profile action.";
  }

  function isManagementAuthRequiredResponse(response, body) {
    return Boolean(response && response.status === 401);
  }

  function isManagementAuthorityTerminalResponse(response, body) {
    return Boolean(
      isManagementAuthRequiredResponse(response, body) ||
        (response &&
          response.status === 403 &&
          isRecord(body) &&
          body.error === "profile_unavailable")
    );
  }

  function createManagementTraktSubmitter(options) {
    const input = options || {};
    if (!input.document || typeof input.document.createElement !== "function") {
      throw new TypeError("document is required");
    }
    if (typeof input.isAuthorityCurrent !== "function") {
      throw new TypeError("management authority validator is required");
    }
    let submitted = false;

    return Object.freeze({
      reset() {
        submitted = false;
      },
      submit(authority) {
        if (submitted || !validManagementAuthority(authority)) return false;
        if (!input.isAuthorityCurrent(authority)) return false;
        submitted = true;
        try {
          const form = input.document.createElement("form");
          const csrf = input.document.createElement("input");
          form.setAttribute("method", "post");
          form.setAttribute("action", "/api/profile/trakt/connect");
          form.setAttribute("enctype", "application/x-www-form-urlencoded");
          csrf.setAttribute("type", "hidden");
          csrf.setAttribute("name", "csrf");
          csrf.value = authority.csrf;
          form.appendChild(csrf);
          if (!input.isAuthorityCurrent(authority)) {
            submitted = false;
            return false;
          }
          input.document.body.appendChild(form);
          form.submit();
          return true;
        } catch (error) {
          submitted = false;
          throw error;
        }
      },
    });
  }

  function managementAuthRequiredError(status) {
    const error = codedError("management_auth_required", MANAGEMENT_AUTH_REQUIRED_MESSAGE);
    error.status = status;
    return error;
  }

  function staleManagementAuthorityError(cause) {
    return codedError(
      "stale_management_authority",
      "Management authority changed while the request was running",
      cause
    );
  }

  function validManagementAuthority(authority) {
    return Boolean(
      isRecord(authority) &&
        Number.isSafeInteger(authority.epoch) &&
        authority.epoch >= 0 &&
        typeof authority.csrf === "string" &&
        authority.csrf
    );
  }

  function createManagementProfileRequester(options) {
    const input = options || {};
    if (typeof input.fetch !== "function") throw new TypeError("fetch is required");
    if (typeof input.getAuthority !== "function") {
      throw new TypeError("management authority getter is required");
    }
    if (typeof input.isAuthorityCurrent !== "function") {
      throw new TypeError("management authority validator is required");
    }

    return async function request(url, requestOptions) {
      const authority = input.getAuthority();
      if (!validManagementAuthority(authority)) throw managementAuthRequiredError(401);
      const request = requestOptions || {};
      const headers = new Headers(request.headers || {});
      headers.set("X-Jumpgate-CSRF", authority.csrf);
      const response = await input.fetch(url, {
        ...request,
        headers,
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      const authorityIsCurrent = input.isAuthorityCurrent(authority);
      if (isManagementAuthorityTerminalResponse(response, body)) {
        if (!authorityIsCurrent) throw staleManagementAuthorityError();
        const error = managementAuthRequiredError(response.status);
        if (typeof input.onAuthRequired === "function") input.onAuthRequired(error, authority);
        throw error;
      }
      if (!authorityIsCurrent) throw staleManagementAuthorityError();
      if (!response.ok || !body.ok) {
        const error = new Error(body.error || "Request failed");
        error.code = body.error || "request_failed";
        error.status = response.status;
        throw error;
      }
      return body;
    };
  }

  function createProfileManagementApi(options) {
    const input = options || {};
    if (typeof input.fetch !== "function") throw new TypeError("fetch is required");
    if (!validManagementAuthority(input.authority)) throw new TypeError("management authority is required");
    if (input.csrf !== undefined && input.csrf !== input.authority.csrf) {
      throw new TypeError("management CSRF does not match authority");
    }
    if (typeof input.isAuthorityCurrent !== "function") {
      throw new TypeError("management authority validator is required");
    }
    async function request(path, requestOptions, expectedStatus) {
      const request = requestOptions || {};
      const headers = new Headers(request.headers || {});
      headers.set("X-Jumpgate-CSRF", input.authority.csrf);
      let response;
      try {
        response = await input.fetch(path, {
          ...request,
          headers,
          credentials: "same-origin",
          cache: "no-store",
        });
      } catch (error) {
        if (!input.isAuthorityCurrent(input.authority)) {
          throw staleManagementAuthorityError(error);
        }
        throw new Error("Jumpgate could not complete this profile action.");
      }
      let body = null;
      if (response.status !== 204) body = await response.json().catch(() => null);
      const authorityIsCurrent = input.isAuthorityCurrent(input.authority);
      if (isManagementAuthorityTerminalResponse(response, body)) {
        if (!authorityIsCurrent) throw staleManagementAuthorityError();
        const error = managementAuthRequiredError(response.status);
        if (typeof input.onAuthRequired === "function") {
          input.onAuthRequired(error, input.authority);
        }
        throw error;
      }
      if (!authorityIsCurrent) throw staleManagementAuthorityError();
      if (
        !response.ok ||
        (expectedStatus !== undefined && response.status !== expectedStatus) ||
        (response.status !== 204 && (!isRecord(body) || body.ok !== true))
      ) {
        throw new Error(managementFailureMessage(response.status));
      }
      return body || { ok: true };
    }

    return Object.freeze({
      async getDevices(options) {
        return parseManagedDevicesResponse(
          await request("/api/profile/devices", { ...(options || {}), method: "GET" })
        );
      },
      revokeDevice(deviceId) {
        if (typeof deviceId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(deviceId)) {
          throw new TypeError("device id is invalid");
        }
        return request("/api/profile/devices/" + encodeURIComponent(deviceId), { method: "DELETE" });
      },
      clearHistory() {
        return request("/api/profile/history", { method: "DELETE" });
      },
      disconnectTrakt() {
        return request("/api/profile/trakt", { method: "DELETE" });
      },
      async connectTrakt() {
        const body = await request("/api/profile/trakt/connect", { method: "POST" });
        return safeSameOriginRedirect(body.url, input.origin);
      },
      deleteProfile() {
        return request("/api/profile", { method: "DELETE" }, 202);
      },
    });
  }

  function resourceNames(descriptor) {
    const resources =
      descriptor && descriptor.manifest && Array.isArray(descriptor.manifest.resources)
        ? descriptor.manifest.resources
        : [];
    const names = [];
    for (const resource of resources) {
      const name =
        typeof resource === "string"
          ? resource
          : isRecord(resource) && typeof resource.name === "string"
          ? resource.name
          : "";
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  function gatewayCandidates(addons) {
    if (!Array.isArray(addons)) throw new TypeError("addons must be an array");
    const candidates = addons.filter((descriptor) => {
      if (!isRecord(descriptor) || !isRecord(descriptor.manifest)) return false;
      if (descriptor.manifest.id === JUMPGATE_ADDON_ID) return false;
      const resources = resourceNames(descriptor);
      return resources.includes("stream") || resources.includes("subtitles");
    });
    return candidates;
  }

  function parseManualCollection(value) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError("Paste descriptor JSON first");
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch (_error) {
      throw new TypeError("Manual descriptor JSON is invalid");
    }
    if (isRecord(parsed) && ("authKey" in parsed || "auth_key" in parsed)) {
      throw new TypeError("Do not paste a Stremio account key; paste only addon descriptors");
    }
    const addons = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.addons : null;
    if (!Array.isArray(addons)) throw new TypeError("JSON must be an addon array or an object with addons");
    return addons;
  }

  function codedError(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function isCancellationError(error) {
    return Boolean(
      error &&
        (error.code === "aborted" ||
          error.code === "stale_management_authority" ||
          error.name === "AbortError")
    );
  }

  function localApprovalDeadlineMessage(expiresAt, now) {
    const current = now === undefined ? Date.now() : now;
    const seconds = Math.max(0, Math.ceil((expiresAt - current) / 1000));
    return seconds
      ? "This page's local approval deadline: " +
          Math.floor(seconds / 60) +
          ":" +
          String(seconds % 60).padStart(2, "0") +
          " remaining."
      : "This page's local approval deadline passed. Start a new read.";
  }

  function createOperationMutex() {
    let active = null;
    let nextId = 0;
    return Object.freeze({
      acquire(kind) {
        if (active) return null;
        const token = { id: ++nextId, kind: String(kind || "operation") };
        active = token;
        return Object.freeze({
          id: token.id,
          kind: token.kind,
          isOwner() {
            return active === token;
          },
          release() {
            if (active !== token) return false;
            active = null;
            return true;
          },
        });
      },
      isLocked() {
        return active !== null;
      },
    });
  }

  function canExposePrivateInstall(state) {
    const value = state || {};
    return Boolean(value.hasConfig && value.paired && value.providersReady && value.installUrl);
  }

  function workspaceStatus(state) {
    if (!state || state.hasConfig !== true) {
      return {
        state: "profile",
        label: "Profile required",
        text: "Generate a private playback profile to begin.",
      };
    }
    if (state.paired !== true) {
      return {
        state: "pair",
        label: "Pairing required",
        text: "Playback is associated only with the intended private Jumpgate profile.",
      };
    }
    if (state.providersReady !== true) {
      return {
        state: "providers",
        label: "Providers required",
        text: "Connect or import the stream and subtitle providers for this profile.",
      };
    }
    if (state.installPromptOpened === true) {
      return {
        state: "opened",
        label: "Install prompt opened",
        text: "Complete the private addon installation in the active Stremio profile.",
      };
    }
    return {
      state: "ready",
      label: "Ready to install",
      text: "The private Stremio link and HTTPS manifest are unlocked for this profile.",
    };
  }

  function createOneShotSettlement(resolve, reject, onSettle) {
    if (typeof resolve !== "function" || typeof reject !== "function") {
      throw new TypeError("settlement callbacks are required");
    }
    let settled = false;
    function settle(callback, value) {
      if (settled) return false;
      settled = true;
      try {
        if (typeof onSettle === "function") onSettle();
      } finally {
        callback(value);
      }
      return true;
    }
    return Object.freeze({
      resolve(value) {
        return settle(resolve, value);
      },
      reject(error) {
        return settle(reject, error);
      },
      isSettled() {
        return settled;
      },
    });
  }

  function providerSelectionModel(previews, requestedSelections) {
    if (!Array.isArray(previews)) throw new TypeError("previews must be an array");
    if (requestedSelections !== undefined && !Array.isArray(requestedSelections)) {
      throw new TypeError("requestedSelections must be an array");
    }
    let selected = 0;
    return previews.map((preview, index) => {
      const enabled = Boolean(preview && preview.gatewayEligible === true);
      const requested = requestedSelections === undefined
        ? true
        : requestedSelections[index] === true;
      const checked = enabled && requested === true && selected < MAX_IMPORTED_PROVIDERS;
      if (checked) selected += 1;
      return { checked, enabled };
    });
  }

  function defaultProviderSelection(previews) {
    return providerSelectionModel(previews).map((selection) => selection.checked);
  }

  function validateProviderSelection(descriptors) {
    if (!Array.isArray(descriptors) || descriptors.length < 1) {
      throw new TypeError("Select at least one stream or subtitle provider");
    }
    if (descriptors.length > MAX_IMPORTED_PROVIDERS) {
      throw new RangeError("Select at most " + MAX_IMPORTED_PROVIDERS + " providers");
    }
    return descriptors;
  }

  async function previewDescriptorBatches(descriptors, previewBatch) {
    if (!Array.isArray(descriptors)) throw new TypeError("descriptors must be an array");
    if (typeof previewBatch !== "function") throw new TypeError("previewBatch must be a function");
    const previews = [];
    for (let offset = 0; offset < descriptors.length; offset += MAX_IMPORTED_PROVIDERS) {
      const batch = descriptors.slice(offset, offset + MAX_IMPORTED_PROVIDERS);
      const result = await previewBatch(batch, offset);
      if (!Array.isArray(result) || result.length !== batch.length) {
        throw new Error("Provider preview response did not match the requested descriptors");
      }
      previews.push(...result);
    }
    return previews;
  }

  async function runBridgeProviderImport(options) {
    const input = options || {};
    if (!isRecord(input.sourceCollection) || !Array.isArray(input.sourceCollection.addons)) {
      throw new TypeError("source collection is invalid");
    }
    validateProviderSelection(input.descriptors);
    if (
      typeof input.getCurrentProviders !== "function" ||
      typeof input.createBackup !== "function" ||
      typeof input.putProviders !== "function"
    ) {
      throw new TypeError("Bridge import callbacks are required");
    }

    const current = await input.getCurrentProviders();
    if (!isRecord(current) || !Number.isSafeInteger(current.revision) || current.revision < 0) {
      throw new Error("Jumpgate returned an invalid provider revision");
    }
    const backup = await input.createBackup(input.sourceCollection.addons);
    if (!isRecord(backup) || typeof backup.id !== "string" || !backup.id) {
      throw codedError("backup_failed", "Jumpgate did not confirm the encrypted source backup");
    }
    const imported = await input.putProviders(input.descriptors, current.revision);
    if (
      !isRecord(imported) ||
      !Number.isSafeInteger(imported.count) ||
      imported.count !== input.descriptors.length
    ) {
      throw new Error("Jumpgate did not confirm a usable provider import");
    }
    return { backup, imported };
  }

  async function runProviderSetupTransition(state, options) {
    const previous = isRecord(state) ? state : {};
    const result = await runBridgeProviderImport(options);
    return {
      result,
      state: {
        ...previous,
        providersReady: true,
        installPromptOpened: false,
      },
    };
  }

  function mount(browser) {
    const document = browser.document;
    if (!document) return;
    const byId = (id) => document.getElementById(id);
    const bootstrapElement = byId("jumpgate-bootstrap");
    let bootstrap = bootstrapElement ? JSON.parse(bootstrapElement.textContent || "{}") : {};
    let initial = bootstrap.initial || null;
    let pairPrefill = bootstrap.pairPrefill || null;
    const managementTraktConnectProtocol =
      bootstrap.managementTraktConnect === undefined ||
      bootstrap.managementTraktConnect === "ajax-v1"
        ? "ajax-v1"
        : bootstrap.managementTraktConnect === "form-v2"
        ? "form-v2"
        : null;

    let pairedForConfig = false;
    let providersReady = false;
    let installPromptOpened = false;
    let privateBridgeBaseUrl = "";
    let privateInstallUrl = "";
    let privateManifestUrl = "";
    let managementCsrf = "";
    let managementAuthorityEpoch = 0;
    let pairExpiryTimer = null;
    let pairExpiresAtMs = 0;
    let pairStatusBaseMessage = "";
    let pairStatusIsError = false;
    let pairExpiryAnnounced = false;
    let profileManagementApi = null;
    let profileManagementBusy = false;
    let profileManagementBusyEpoch = null;
    let managementRefreshController = null;
    let profileTraktLinked = null;
    const providerOperationMutex = createOperationMutex();
    const privateCapabilityFields = new Set(["bridge", "manifest", "install", "installManifest"]);
    let activeProviderOperation = null;

    function captureManagementAuthority() {
      return managementCsrf
        ? Object.freeze({ epoch: managementAuthorityEpoch, csrf: managementCsrf })
        : null;
    }

    function isManagementAuthorityCurrent(authority) {
      return Boolean(
        validManagementAuthority(authority) &&
          authority.epoch === managementAuthorityEpoch &&
          authority.csrf === managementCsrf &&
          pairedForConfig
      );
    }

    const managementTraktSubmitter = createManagementTraktSubmitter({
      document,
      isAuthorityCurrent: isManagementAuthorityCurrent,
    });

    function advanceManagementAuthority() {
      managementAuthorityEpoch += 1;
      managementTraktSubmitter.reset();
      clearProviderAuthorityUi(activeProviderOperation);
      dismissDeleteProfileDialog();
      setStatus("", false);
    }

    function abortManagementRefresh() {
      const controller = managementRefreshController;
      managementRefreshController = null;
      if (controller && !controller.signal.aborted) controller.abort();
    }

    function setHidden(element, hidden) {
      if (element) element.classList.toggle("hidden", Boolean(hidden));
    }

    function setStatus(message, isError) {
      const element = byId("stremioStatus");
      element.textContent = message || "";
      element.classList.toggle("status-error", Boolean(isError));
      element.classList.toggle("status-ok", Boolean(message) && !isError);
    }

    function setManagementStatus(message, isError) {
      const element = byId("managementStatus");
      element.textContent = message || "";
      element.classList.toggle("status-error", Boolean(isError));
      element.classList.toggle("status-ok", Boolean(message) && !isError);
    }

    function setDeleteDialogStatus(message, isError) {
      const element = byId("deleteDialogStatus");
      element.textContent = message || "";
      element.classList.toggle("status-error", Boolean(isError));
      element.classList.toggle("status-ok", Boolean(message) && !isError);
    }

    function refreshManagementActionAvailability() {
      for (const button of document.querySelectorAll("[data-management-action]")) {
        button.disabled = profileManagementBusy || !profileManagementApi;
      }
      if (!profileManagementBusy && profileManagementApi) {
        byId("disconnectTraktBtn").disabled = profileTraktLinked !== true;
      }
      byId("profileManagement").setAttribute("aria-busy", profileManagementBusy ? "true" : "false");
    }

    function setManagementPending(pending, authority) {
      if (pending) {
        profileManagementBusy = true;
        profileManagementBusyEpoch = authority ? authority.epoch : managementAuthorityEpoch;
      } else if (
        authority &&
        profileManagementBusyEpoch !== null &&
        profileManagementBusyEpoch !== authority.epoch
      ) {
        return;
      } else {
        profileManagementBusy = false;
        profileManagementBusyEpoch = null;
      }
      refreshManagementActionAvailability();
    }

    function renderTraktManagementState() {
      const element = byId("traktManagementState");
      element.classList.toggle("connected", profileTraktLinked === true);
      element.textContent = profileTraktLinked === true
        ? "Trakt connected"
        : profileTraktLinked === false
        ? "Trakt disconnected"
        : "Connection status unavailable";
      byId("reconnectTraktBtn").textContent = profileTraktLinked === true ? "Reconnect Trakt" : "Connect Trakt";
      refreshManagementActionAvailability();
    }

    function formatDeviceActivity(value) {
      if (value === null || value === undefined) return "Activity time unavailable";
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return "Activity time unavailable";
      try {
        return "Last active " + new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(date);
      } catch (_error) {
        return "Last active " + date.toISOString();
      }
    }

    function renderManagedDevices(devices) {
      const list = byId("deviceList");
      list.replaceChildren();
      if (!devices.length) {
        const empty = document.createElement("p");
        empty.className = "device-empty";
        empty.setAttribute("role", "listitem");
        empty.textContent = "No active paired devices were returned for this profile.";
        list.appendChild(empty);
        return;
      }
      for (const device of devices) {
        const row = document.createElement("div");
        row.className = "device-row";
        row.setAttribute("role", "listitem");
        const copy = document.createElement("div");
        copy.className = "device-copy";
        const name = document.createElement("div");
        name.className = "device-name";
        const label = document.createElement("span");
        label.textContent = device.displayName;
        name.appendChild(label);
        if (device.current === true) {
          const current = document.createElement("span");
          current.className = "current-device-badge";
          current.textContent = "Current device";
          name.appendChild(current);
        }
        const activity = document.createElement("span");
        activity.className = "device-meta";
        activity.textContent = formatDeviceActivity(device.lastSeenAt);
        copy.append(name, activity);
        const revoke = document.createElement("button");
        revoke.className = "b compact";
        revoke.type = "button";
        revoke.setAttribute("data-management-action", "");
        revoke.textContent = device.current === true ? "Revoke current device" : "Revoke device";
        revoke.addEventListener("click", () => void revokeManagedDevice(device));
        row.append(copy, revoke);
        list.appendChild(row);
      }
      refreshManagementActionAvailability();
    }

    async function loadProfileManagementState(api, authority, options) {
      if (!api || !isManagementAuthorityCurrent(authority)) {
        throw staleManagementAuthorityError();
      }
      const state = await api.getDevices(options);
      if (!isManagementAuthorityCurrent(authority)) throw staleManagementAuthorityError();
      if (state.traktLinked !== undefined) profileTraktLinked = state.traktLinked;
      renderManagedDevices(state.devices);
      renderTraktManagementState();
      return state;
    }

    async function refreshProfileManagement() {
      if (!profileManagementApi || profileManagementBusy) return;
      const api = profileManagementApi;
      const authority = captureManagementAuthority();
      if (!isManagementAuthorityCurrent(authority)) return;
      abortManagementRefresh();
      const controller = new AbortController();
      managementRefreshController = controller;
      setManagementPending(true, authority);
      setManagementStatus("Refreshing paired-profile state...", false);
      try {
        await loadProfileManagementState(api, authority, { signal: controller.signal });
        if (managementRefreshController === controller && isManagementAuthorityCurrent(authority)) {
          setManagementStatus("Paired-profile state refreshed.", false);
        }
      } catch (error) {
        if (
          managementRefreshController === controller &&
          isManagementAuthorityCurrent(authority) &&
          !isCancellationError(error)
        ) {
          setManagementStatus(error.message || "Jumpgate could not refresh this profile.", true);
        }
      } finally {
        if (managementRefreshController === controller) {
          managementRefreshController = null;
          setManagementPending(false, authority);
        }
      }
    }

    async function runManagementAction(pendingMessage, successMessage, action) {
      if (!profileManagementApi || profileManagementBusy) return false;
      const api = profileManagementApi;
      const authority = captureManagementAuthority();
      if (!isManagementAuthorityCurrent(authority)) return false;
      setManagementPending(true, authority);
      setManagementStatus(pendingMessage, false);
      try {
        await action(api);
        if (!isManagementAuthorityCurrent(authority)) return false;
        await loadProfileManagementState(api, authority);
        if (!isManagementAuthorityCurrent(authority)) return false;
        setManagementStatus(successMessage, false);
        return true;
      } catch (error) {
        if (isManagementAuthorityCurrent(authority) && !isCancellationError(error)) {
          setManagementStatus(error.message || "Jumpgate could not complete this profile action.", true);
        }
        return false;
      } finally {
        setManagementPending(false, authority);
      }
    }

    async function revokeManagedDevice(device) {
      const confirmed = browser.confirm(
        "Revoke " + device.displayName + "? This revokes its Bridge bearer credential. " +
          "It does not revoke already-issued links or tokens."
      );
      if (!confirmed) return;
      await runManagementAction(
        "Revoking the selected device credential...",
        "The device credential was revoked and the paired-device list was refreshed.",
        (api) => api.revokeDevice(device.id)
      );
    }

    async function clearBridgeHistory() {
      const confirmed = browser.confirm(
        "Clear current Bridge history? This removes current Bridge history. Future playback creates new entries."
      );
      if (!confirmed) return;
      await runManagementAction(
        "Clearing current Bridge history...",
        "Current Bridge history was cleared. Future playback will create new entries.",
        (api) => api.clearHistory()
      );
    }

    async function disconnectManagedTrakt() {
      const confirmed = browser.confirm(
        "Disconnect Trakt? This does not delete history already stored by Trakt."
      );
      if (!confirmed) return;
      const completed = await runManagementAction(
        "Disconnecting Trakt...",
        "Trakt was disconnected. History already stored by Trakt was not deleted.",
        (api) => api.disconnectTrakt()
      );
      if (completed) {
        profileTraktLinked = false;
        renderTraktManagementState();
      }
    }

    function renderOperationStatus(operation) {
      if (!operation || !operation.finalStatus) return;
      setStatus(operation.finalStatus.message, operation.finalStatus.isError);
    }

    function setFinalOperationStatus(operation, message, isError) {
      operation.finalStatus = { message, isError: Boolean(isError) };
      if (!operation.suppressFinalStatus) renderOperationStatus(operation);
    }

    function handleManagementAuthRequired(_error, authority) {
      if (!isManagementAuthorityCurrent(authority)) return false;
      const operation = activeProviderOperation;
      const matchingOperationHandled = Boolean(
        operation &&
        operation.owner.isOwner() &&
        operation.authority.epoch === authority.epoch
      );
      if (matchingOperationHandled) {
        operation.managementAuthRequired = true;
        cancelProviderOperation(operation, MANAGEMENT_AUTH_REQUIRED_MESSAGE);
      }
      abortManagementRefresh();
      advanceManagementAuthority();
      privateBridgeBaseUrl = "";
      privateInstallUrl = "";
      privateManifestUrl = "";
      managementCsrf = "";
      profileManagementApi = null;
      profileManagementBusy = false;
      profileManagementBusyEpoch = null;
      profileTraktLinked = null;
      pairedForConfig = false;
      providersReady = false;
      installPromptOpened = false;
      pairPrefill = null;
      if (pairExpiryTimer) clearInterval(pairExpiryTimer);
      pairExpiryTimer = null;
      pairExpiresAtMs = 0;
      pairExpiryAnnounced = false;
      byId("pairCode").value = "";
      byId("pairTimer").textContent = "";
      byId("providerList").replaceChildren();
      renderManagedDevices([]);
      clearApprovalMaterial(operation);
      setHidden(byId("providerPreview"), true);
      setHidden(byId("cancelStremioBtn"), true);
      setHidden(byId("profileManagement"), true);
      renderTraktManagementState();
      setPairStatus(MANAGEMENT_AUTH_REQUIRED_MESSAGE, true);
      setManagementStatus(MANAGEMENT_AUTH_REQUIRED_MESSAGE, true);
      if (matchingOperationHandled) {
        setFinalOperationStatus(operation, MANAGEMENT_AUTH_REQUIRED_MESSAGE, true);
      } else {
        setStatus(MANAGEMENT_AUTH_REQUIRED_MESSAGE, true);
      }
      refreshSteps();
      return true;
    }

    function beginProviderOperation(kind) {
      const authority = captureManagementAuthority();
      if (!isManagementAuthorityCurrent(authority)) return null;
      const owner = providerOperationMutex.acquire(kind);
      if (!owner) return null;
      const operation = {
        kind,
        owner,
        authority,
        controller: new AbortController(),
        decision: null,
        finalStatus: null,
        timer: null,
      };
      activeProviderOperation = operation;
      refreshSteps();
      return operation;
    }

    function providerOperationIsCurrent(operation) {
      return Boolean(
        operation &&
          activeProviderOperation === operation &&
          operation.owner.isOwner() &&
          !operation.controller.signal.aborted &&
          isManagementAuthorityCurrent(operation.authority)
      );
    }

    function requireCurrentProviderOperation(operation) {
      if (!providerOperationIsCurrent(operation)) throw staleManagementAuthorityError();
      return operation;
    }

    function cancelProviderDecision(operation, reason) {
      if (!operation || !operation.owner.isOwner() || !operation.decision) return false;
      return operation.decision.cancel(reason || "Provider selection canceled");
    }

    function cancelProviderOperation(operation, reason) {
      if (!operation || !operation.owner.isOwner()) return false;
      cancelProviderDecision(operation, reason);
      if (!operation.controller.signal.aborted) operation.controller.abort();
      clearLinkDeadline(operation);
      return true;
    }

    function clearLinkDeadline(operation) {
      if (operation && operation.timer) clearInterval(operation.timer);
      if (operation) operation.timer = null;
      const timer = byId("stremioTimer");
      if (timer) timer.textContent = "";
    }

    function clearApprovalMaterial(operation) {
      clearLinkDeadline(operation);
      const qr = byId("stremioQr");
      const code = byId("stremioCode");
      const link = byId("stremioApprovalLink");
      if (qr) qr.removeAttribute("src");
      if (code) code.textContent = "";
      if (link) link.removeAttribute("href");
      setHidden(byId("stremioLink"), true);
    }

    function clearProviderAuthorityUi(operation) {
      clearApprovalMaterial(operation);
      byId("providerList").replaceChildren();
      setHidden(byId("providerPreview"), true);
      setHidden(byId("cancelStremioBtn"), true);
    }

    function finishProviderOperation(operation) {
      if (!operation || !operation.owner.isOwner()) return false;
      if (operation.decision) operation.decision.cancel("Provider operation ended");
      clearProviderAuthorityUi(operation);
      operation.owner.release();
      if (activeProviderOperation === operation) activeProviderOperation = null;
      refreshSteps();
      return true;
    }

    function toggleSkipTrakt() {
      byId("skipTraktBtn").disabled = !byId("skipTraktAcknowledge").checked;
    }

    async function copyText(value) {
      if (browser.navigator.clipboard && browser.navigator.clipboard.writeText) {
        try {
          await browser.navigator.clipboard.writeText(value);
          return true;
        } catch (_error) {
          // Fall through to the selected-input copy path.
        }
      }
      try {
        return document.execCommand("copy") === true;
      } catch (_error) {
        return false;
      }
    }

    function copyField(id) {
      const element = byId(id);
      if (!element || element.disabled || !element.value) return false;
      if (
        privateCapabilityFields.has(id) &&
        !canExposePrivateInstall({
          hasConfig: Boolean(byId("configBlob").value),
          paired: pairedForConfig,
          providersReady,
          installUrl: privateInstallUrl,
        })
      ) {
        setStatus("Pair Jumpgate and import providers before revealing the private install URL.", true);
        return false;
      }
      element.focus();
      element.select();
      if (typeof element.setSelectionRange === "function") {
        element.setSelectionRange(0, element.value.length);
      }
      const labels = {
        bridge: "Kodi Bridge URL",
        manifest: "Jumpgate manifest URL",
        install: "Stremio app link",
        installManifest: "HTTPS manifest URL",
      };
      void copyText(element.value).then((copied) => {
        setStatus(
          copied
            ? (labels[id] || "Link") + " copied."
            : (labels[id] || "Link") + " selected. Use your browser's copy command.",
          false
        );
      });
      return true;
    }

    function normalizeUserCode(raw) {
      return String(raw || "")
        .toUpperCase()
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/[^A-Z0-9]/g, "");
    }

    function formatUserCode(raw) {
      const code = normalizeUserCode(raw);
      if (!code || code.length <= 4) return code;
      return code.slice(0, 4) + "-" + code.slice(4, 8);
    }

    function setStep(id, state) {
      const element = byId(id);
      if (!element) return;
      element.classList.remove("current", "done", "locked", "pending");
      element.classList.add(state);
      if (state === "current") element.setAttribute("aria-current", "step");
      else element.removeAttribute("aria-current");
    }

    function refreshSteps() {
      const hasConfig = Boolean(byId("configBlob").value);
      const pairComplete = hasConfig && pairedForConfig;
      const providerComplete = pairComplete && providersReady;
      setStep("stepGenerate", hasConfig ? "done" : "current");
      setStep("stepPair", pairComplete ? "done" : hasConfig ? "current" : "locked");
      setStep("stepProviders", providerComplete ? "done" : pairComplete ? "current" : "locked");
      setStep("stepInstall", installPromptOpened ? "done" : providerComplete ? "current" : "locked");
      const providerBusy = providerOperationMutex.isLocked();
      byId("connectStremioBtn").disabled = providerBusy || !(hasConfig && pairedForConfig && managementCsrf);
      byId("previewManualBtn").disabled = providerBusy || !(hasConfig && pairedForConfig && managementCsrf);
      const installReady = canExposePrivateInstall({
        hasConfig,
        paired: pairedForConfig,
        providersReady,
        installUrl: privateInstallUrl,
      });
      const installInput = byId("install");
      const manifestInput = byId("installManifest");
      const bridgeInput = byId("bridge");
      const technicalManifestInput = byId("manifest");
      const copyInstallButton = byId("copyInstallBtn");
      const copyManifestButton = byId("copyManifestBtn");
      const copyBridgeButton = byId("copyBridgeBtn");
      const copyTechnicalManifestButton = byId("copyTechnicalManifestBtn");
      const manifestReady = installReady && Boolean(privateManifestUrl);
      const technicalReady = manifestReady && Boolean(privateBridgeBaseUrl);
      installInput.value = installReady ? privateInstallUrl : "";
      manifestInput.value = manifestReady ? privateManifestUrl : "";
      bridgeInput.value = technicalReady ? privateBridgeBaseUrl : "";
      technicalManifestInput.value = technicalReady ? privateManifestUrl : "";
      installInput.disabled = !installReady;
      manifestInput.disabled = !manifestReady;
      bridgeInput.disabled = !technicalReady;
      technicalManifestInput.disabled = !technicalReady;
      copyInstallButton.disabled = !installReady;
      copyManifestButton.disabled = !manifestReady;
      copyBridgeButton.disabled = !technicalReady;
      copyTechnicalManifestButton.disabled = !technicalReady;
      setHidden(byId("installMaterial"), !installReady);
      setHidden(byId("technicalDetails"), !technicalReady);
      byId("installConfiguredBtn").disabled = !installReady;
      const workspace = workspaceStatus({
        hasConfig,
        paired: pairComplete,
        providersReady: providerComplete,
        installPromptOpened,
      });
      byId("workspaceStatus").dataset.state = workspace.state;
      byId("workspaceStatusLabel").textContent = workspace.label;
      byId("workspaceStatusText").textContent = workspace.text;
      refreshManagementActionAvailability();
    }

    function extractConfigBlob(rawUrl) {
      const raw = String(rawUrl || "").trim();
      if (!raw) return "";
      try {
        const parts = new URL(raw).pathname.split("/").filter(Boolean);
        if (parts[0] === "_c" && parts[1]) return parts[1];
        return parts[0] || "";
      } catch (_error) {
        const clean = raw.split("?")[0].split("#")[0];
        const match = clean.match(/(?:^|\/)\_c\/([^/]+)/i);
        if (match && match[1]) return match[1];
        const parts = clean.split("/").filter(Boolean);
        if (parts[0] === "_c" && parts[1]) return parts[1];
        return parts[0] || "";
      }
    }

    function resolveConfigBlob(value) {
      if (value && typeof value.config === "string" && value.config.trim()) return value.config.trim();
      return extractConfigBlob((value && value.bridgeBaseUrl) || "") ||
        extractConfigBlob((value && value.manifestUrl) || "");
    }

    function formatPairTimeLeft() {
      if (!pairExpiresAtMs || pairedForConfig) return "";
      const left = Math.max(0, Math.floor((pairExpiresAtMs - Date.now()) / 1000));
      if (left <= 0) return "expired";
      return String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0");
    }

    function renderPairStatus() {
      const element = byId("pairStatus");
      const message = pairStatusBaseMessage || "";
      element.textContent = message;
      element.classList.toggle("status-error", pairStatusIsError);
      element.classList.toggle("status-ok", Boolean(message) && !pairStatusIsError);
    }

    function renderPairTimer() {
      const element = byId("pairTimer");
      const timeLeft = formatPairTimeLeft();
      if (!timeLeft || pairedForConfig) {
        element.textContent = "";
        return;
      }
      if (timeLeft === "expired") {
        element.textContent = "Pair code expired.";
        if (!pairExpiryAnnounced) {
          pairExpiryAnnounced = true;
          if (pairExpiryTimer) clearInterval(pairExpiryTimer);
          pairExpiryTimer = null;
          setPairStatus("Pair code expired. Generate a new one from Jumpgate.", true);
        }
        return;
      }
      element.textContent = "Pair code expires in " + timeLeft + ".";
    }

    function setPairStatus(message, isError) {
      pairStatusBaseMessage = message || "";
      pairStatusIsError = Boolean(isError);
      renderPairStatus();
    }

    function startPairTimer(expiresAtMs) {
      pairExpiresAtMs = Number(expiresAtMs) || 0;
      pairExpiryAnnounced = false;
      if (pairExpiryTimer) clearInterval(pairExpiryTimer);
      renderPairTimer();
      pairExpiryTimer = pairExpiresAtMs && !pairedForConfig ? setInterval(renderPairTimer, 1000) : null;
    }

    function buildSettingsPayload() {
      return {
        subtitle_languages: String(byId("subtitleLanguages").value || "").trim(),
        subtitles_enabled: Boolean(byId("subtitlesEnabled").checked),
      };
    }

    function cancelStremio() {
      if (activeProviderOperation && activeProviderOperation.kind === "stremio") {
        cancelProviderOperation(activeProviderOperation, "Stremio connection canceled");
      }
    }

    function showResult(value) {
      if (activeProviderOperation) cancelProviderOperation(activeProviderOperation, "Provider operation canceled");
      abortManagementRefresh();
      advanceManagementAuthority();
      setHidden(byId("result"), false);
      // Install capabilities are accepted only from a successful pairing response.
      privateBridgeBaseUrl = "";
      privateInstallUrl = "";
      privateManifestUrl = "";
      byId("bridge").value = "";
      byId("manifest").value = "";
      byId("install").value = "";
      byId("installManifest").value = "";
      byId("configBlob").value = resolveConfigBlob(value);
      const details = [];
      if (value.name) details.push("profile: " + value.name);
      if (value.traktLinked) details.push("Trakt linked");
      if (value.tmdbKeyStored) details.push("TMDB key set");
      byId("meta").textContent = details.join(" | ");
      const runtimePair = value.pairPrefill || null;
      const activePair = pairPrefill && pairPrefill.code ? pairPrefill : runtimePair;
      if (activePair && activePair.code) {
        byId("pairCode").value = formatUserCode(activePair.code);
        startPairTimer(activePair.expiresAt || 0);
      }
      pairedForConfig = false;
      providersReady = false;
      installPromptOpened = false;
      managementCsrf = "";
      profileManagementApi = null;
      profileManagementBusy = false;
      profileManagementBusyEpoch = null;
      profileTraktLinked = value.traktLinked === true ? true : false;
      setHidden(byId("profileManagement"), true);
      renderTraktManagementState();
      renderManagedDevices([]);
      setManagementStatus("", false);
      setPairStatus("Pair Jumpgate, then connect Stremio providers.", false);
      setStatus("", false);
      refreshSteps();
    }

    function resetDeleteProfileDialog() {
      byId("deleteProfileConfirmation").value = "";
      byId("deleteProfileConfirmation").disabled = false;
      byId("confirmDeleteProfileBtn").disabled = true;
      byId("confirmDeleteProfileBtn").textContent = "Delete profile permanently";
      setDeleteDialogStatus("", false);
    }

    function dismissDeleteProfileDialog() {
      const dialog = byId("deleteProfileDialog");
      if (dialog.open) dialog.close();
      resetDeleteProfileDialog();
    }

    function openDeleteProfileDialog() {
      if (!profileManagementApi || profileManagementBusy) return;
      const dialog = byId("deleteProfileDialog");
      resetDeleteProfileDialog();
      dialog.showModal();
      byId("deleteProfileConfirmation").focus();
    }

    function closeDeleteProfileDialog() {
      dismissDeleteProfileDialog();
      if (!byId("openDeleteProfileBtn").disabled) byId("openDeleteProfileBtn").focus();
    }

    function clearPrivateConfigurationState() {
      if (activeProviderOperation) cancelProviderOperation(activeProviderOperation, "Profile deleted");
      abortManagementRefresh();
      advanceManagementAuthority();
      privateBridgeBaseUrl = "";
      privateInstallUrl = "";
      privateManifestUrl = "";
      managementCsrf = "";
      profileManagementApi = null;
      profileManagementBusy = false;
      profileManagementBusyEpoch = null;
      profileTraktLinked = null;
      pairedForConfig = false;
      providersReady = false;
      installPromptOpened = false;
      pairPrefill = null;
      initial = null;
      bootstrap = {};
      if (pairExpiryTimer) clearInterval(pairExpiryTimer);
      pairExpiryTimer = null;
      pairExpiresAtMs = 0;
      bootstrapElement.textContent = "{}";
      for (const id of [
        "configBlob",
        "bridge",
        "manifest",
        "install",
        "installManifest",
        "pairCode",
        "manualDescriptors",
        "tmdbKey",
        "subtitleLanguages",
      ]) {
        byId(id).value = "";
      }
      byId("name").value = "";
      byId("subtitlesEnabled").checked = false;
      byId("skipTraktAcknowledge").checked = false;
      toggleSkipTrakt();
      byId("meta").textContent = "";
      byId("pairTimer").textContent = "";
      byId("providerList").replaceChildren();
      renderManagedDevices([]);
      clearApprovalMaterial(activeProviderOperation);
      setHidden(byId("providerPreview"), true);
      setHidden(byId("profileManagement"), true);
      setHidden(byId("result"), true);
      setStatus("", false);
      setPairStatus("", false);
      setManagementStatus("", false);
      renderTraktManagementState();
      refreshSteps();
      if (browser.location.search || browser.location.hash) {
        browser.history.replaceState(null, "", browser.location.pathname);
      }
      byId("name").focus();
    }

    async function deleteManagedProfile() {
      if (
        !profileManagementApi ||
        profileManagementBusy ||
        byId("deleteProfileConfirmation").value !== PROFILE_DELETE_CONFIRMATION
      ) {
        return;
      }
      const api = profileManagementApi;
      const authority = captureManagementAuthority();
      if (!isManagementAuthorityCurrent(authority)) return;
      setManagementPending(true, authority);
      byId("deleteProfileConfirmation").disabled = true;
      byId("confirmDeleteProfileBtn").disabled = true;
      byId("confirmDeleteProfileBtn").textContent = "Deletion requested...";
      setDeleteDialogStatus("Requesting destructive profile deletion...", false);
      try {
        await api.deleteProfile();
        if (!isManagementAuthorityCurrent(authority)) return;
        const dialog = byId("deleteProfileDialog");
        if (dialog.open) dialog.close();
        clearPrivateConfigurationState();
      } catch (error) {
        if (!isManagementAuthorityCurrent(authority) || isCancellationError(error)) return;
        const message = error.message || "Jumpgate could not complete this profile action.";
        setDeleteDialogStatus(message, true);
        setManagementStatus(message, true);
        setManagementPending(false, authority);
        byId("deleteProfileConfirmation").disabled = false;
        byId("confirmDeleteProfileBtn").textContent = "Delete profile permanently";
        byId("confirmDeleteProfileBtn").disabled = false;
        byId("deleteProfileConfirmation").focus();
      }
    }

    async function readJsonResponse(response) {
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok) {
        const error = new Error(body.error || "Request failed");
        error.code = body.error || "request_failed";
        error.status = response.status;
        throw error;
      }
      return body;
    }

    function pairingSessionStorage() {
      try {
        return browser.sessionStorage;
      } catch (_error) {
        throw new Error("Pairing cannot start because session recovery storage is unavailable");
      }
    }

    async function sendPairingActivation(attempt, recovery) {
      const response = await requestPairingActivation(
        browser.fetch.bind(browser),
        attempt,
        recovery
      );
      return readJsonResponse(response);
    }

    function applyPairingSuccess(body, config) {
      if (typeof body.managementCsrf !== "string" || !body.managementCsrf) {
        throw new Error("Pairing did not create a management session");
      }
      if (
        body.config !== config ||
        typeof body.bridgeBaseUrl !== "string" ||
        !body.bridgeBaseUrl ||
        typeof body.manifestUrl !== "string" ||
        !body.manifestUrl ||
        typeof body.installUrl !== "string" ||
        !body.installUrl.startsWith("stremio://")
      ) {
        throw new Error("Pairing did not return the private install links");
      }
      if (activeProviderOperation) {
        activeProviderOperation.suppressFinalStatus = true;
        cancelProviderOperation(activeProviderOperation, "Management authority changed");
      }
      abortManagementRefresh();
      advanceManagementAuthority();
      setHidden(byId("result"), false);
      byId("configBlob").value = config;
      managementCsrf = body.managementCsrf;
      privateBridgeBaseUrl = body.bridgeBaseUrl;
      privateManifestUrl = body.manifestUrl;
      privateInstallUrl = body.installUrl;
      pairedForConfig = true;
      providersReady = false;
      installPromptOpened = false;
      profileManagementBusy = false;
      profileManagementBusyEpoch = null;
      const authority = captureManagementAuthority();
      profileManagementApi = createProfileManagementApi({
        fetch: browser.fetch.bind(browser),
        authority,
        isAuthorityCurrent: isManagementAuthorityCurrent,
        origin: browser.location.origin,
        onAuthRequired: handleManagementAuthRequired,
      });
      setHidden(byId("profileManagement"), false);
      renderTraktManagementState();
      if (pairExpiryTimer) clearInterval(pairExpiryTimer);
      pairExpiryTimer = null;
      byId("pairTimer").textContent = "";
      setPairStatus(
        body.name
          ? "Paired with " + body.name + ". Connect Stremio providers next."
          : "Paired. Connect Stremio providers next.",
        false
      );
      refreshSteps();
      void refreshProfileManagement();
    }

    function clearDefinitivePairingFailure(error, storage) {
      if (error && [400, 404, 409, 410].includes(error.status)) {
        clearPairingRecovery(storage);
      }
    }

    async function recoverPendingPairing() {
      let storage;
      let attempt;
      try {
        storage = pairingSessionStorage();
        attempt = readPairingRecovery(storage, Date.now());
      } catch (error) {
        setPairStatus(error.message || "Pairing recovery is unavailable.", true);
        return;
      }
      if (!attempt) return;
      setHidden(byId("result"), false);
      byId("configBlob").value = attempt.config;
      byId("pairCode").value = formatUserCode(attempt.userCode);
      setPairStatus("Recovering the previous pairing response...", false);
      try {
        const body = await sendPairingActivation(attempt, true);
        applyPairingSuccess(body, attempt.config);
        clearPairingRecovery(storage);
      } catch (error) {
        clearDefinitivePairingFailure(error, storage);
        setPairStatus(
          error.message || "The previous pairing response could not be recovered.",
          true
        );
      }
    }

    const profileRequest = createManagementProfileRequester({
      fetch: browser.fetch.bind(browser),
      getAuthority: captureManagementAuthority,
      isAuthorityCurrent: isManagementAuthorityCurrent,
      onAuthRequired: handleManagementAuthRequired,
    });

    async function generateConfigured() {
      if (!byId("skipTraktAcknowledge").checked) {
        browser.alert("Use Connect Trakt + Generate, or explicitly acknowledge skipping Trakt.");
        return;
      }
      const response = await browser.fetch("/configure/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: byId("name").value,
          tmdbKey: byId("tmdbKey").value,
          existingConfig: byId("configBlob").value,
          pairCode: byId("pairCode").value,
          pairExpiresAt: pairExpiresAtMs,
          settings: buildSettingsPayload(),
        }),
      });
      const body = await readJsonResponse(response);
      showResult(body);
    }

    async function connectTrakt() {
      if (!profileManagementApi || !managementCsrf) {
        browser.alert("Pair Jumpgate before connecting Trakt.");
        return;
      }
      if (profileManagementBusy) return;
      const authority = captureManagementAuthority();
      if (!isManagementAuthorityCurrent(authority)) return;
      const api = profileManagementApi;
      let navigationStarted = false;
      setManagementPending(true, authority);
      try {
        if (!managementTraktConnectProtocol) {
          throw new Error(
            "This page and Bridge disagree on the Trakt connection protocol. Reload and try again."
          );
        }
        if (managementTraktConnectProtocol === "form-v2") {
          navigationStarted = managementTraktSubmitter.submit(authority);
          if (navigationStarted) {
            setManagementStatus("Opening the Trakt connection flow...", false);
          }
          return;
        }
        const target = await api.connectTrakt();
        if (!isManagementAuthorityCurrent(authority)) return;
        navigationStarted = true;
        setManagementStatus("Opening the Trakt connection flow...", false);
        browser.location.assign(target);
      } catch (error) {
        if (isManagementAuthorityCurrent(authority) && !isCancellationError(error)) {
          if (managementTraktConnectProtocol === "form-v2") {
            managementTraktSubmitter.reset();
          }
          browser.alert(error.message || "Unable to start Trakt OAuth");
        }
      } finally {
        if (!navigationStarted) setManagementPending(false, authority);
      }
    }

    function installConfigured() {
      if (byId("installConfiguredBtn").disabled) {
        browser.alert("Pair Jumpgate and import providers first.");
        return;
      }
      const url = privateInstallUrl;
      if (!url) {
        setStatus("The private Jumpgate install URL is unavailable.", true);
        return;
      }
      installPromptOpened = true;
      refreshSteps();
      setStatus(
        "Opening the private, profile-specific Jumpgate install URL. Stremio will ask to install it; keep the same Stremio profile active.",
        false
      );
      browser.location.href = url;
    }

    async function pairJumpgate() {
      const pairButton = byId("pairBtn");
      const normalized = normalizeUserCode(byId("pairCode").value || "");
      const config = String(byId("configBlob").value || "").trim() || extractConfigBlob(byId("bridge").value);
      if (!normalized) return setPairStatus("Enter the pairing code from Jumpgate.", true);
      if (!config) return setPairStatus("Generate a configured profile first.", true);
      byId("pairCode").value = formatUserCode(normalized);
      pairButton.disabled = true;
      setPairStatus("Pairing...", false);
      let storage;
      try {
        storage = pairingSessionStorage();
        const attempt = preparePairingActivation(
          storage,
          browser.crypto,
          browser.btoa.bind(browser),
          { userCode: normalized, config },
          Date.now()
        );
        const body = await sendPairingActivation(attempt, false);
        applyPairingSuccess(body, attempt.config);
        clearPairingRecovery(storage);
      } catch (error) {
        clearDefinitivePairingFailure(error, storage);
        setPairStatus(error.message || "Pairing failed.", true);
      } finally {
        pairButton.disabled = false;
      }
    }

    function renderLinkTimer(expiresAt) {
      byId("stremioTimer").textContent = localApprovalDeadlineMessage(expiresAt);
    }

    function selectedProviderDecision(previews, descriptors, sourceCollection, operation) {
      requireCurrentProviderOperation(operation);
      const signal = operation.controller.signal;
      const list = byId("providerList");
      list.replaceChildren();
      const selectionModel = providerSelectionModel(previews);
      previews.forEach((preview, index) => {
        const label = document.createElement("label");
        label.className = "provider";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.id = "providerOption-" + operation.owner.id + "-" + index;
        label.htmlFor = checkbox.id;
        checkbox.checked = selectionModel[index].checked;
        checkbox.disabled = !selectionModel[index].enabled;
        checkbox.dataset.providerIndex = String(index);
        const content = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = preview.name || preview.manifestId || "Unnamed addon";
        content.appendChild(title);
        const signals = document.createElement("span");
        signals.className = "provider-signals";
        const names = [];
        if (preview.supportsStream) names.push("streams");
        if (preview.supportsSubtitles) names.push("subtitles");
        if (preview.official) names.push("official");
        if (preview.protected) names.push("protected");
        if (preview.configurable) names.push("configured");
        if (preview.insecureTransport) names.push("HTTP transport");
        if (preview.unsupportedTransport) names.push("unsupported transport");
        if (!preview.gatewayEligible && !preview.unsupportedTransport) {
          names.push("no usable stream or subtitle route");
        }
        for (const name of names) {
          const signal = document.createElement("span");
          signal.className = "provider-signal";
          signal.textContent = name;
          signals.appendChild(signal);
        }
        content.appendChild(signals);
        label.append(checkbox, content);
        list.appendChild(label);
      });
      setHidden(byId("providerPreview"), false);
      setStatus(
        "Review the providers and confirm. Keep the Stremio profile used for approval active for the install prompt. No account key is sent to Jumpgate.",
        false
      );

      return new Promise((resolve, reject) => {
        let decision;
        const settlement = createOneShotSettlement(resolve, reject, () => {
          signal.removeEventListener("abort", onAbort);
          if (operation.decision === decision) operation.decision = null;
          if (operation.owner.isOwner()) setHidden(byId("providerPreview"), true);
        });
        const onAbort = () => decision.cancel("Provider operation canceled");
        decision = {
          cancel(reason) {
            return settlement.reject(codedError("aborted", reason || "Provider selection canceled"));
          },
          confirm() {
            const selected = [];
            const requested = previews.map(() => false);
            for (const checkbox of list.querySelectorAll("input[data-provider-index]")) {
              const index = Number(checkbox.dataset.providerIndex);
              if (Number.isSafeInteger(index) && index >= 0 && index < requested.length) {
                requested[index] = checkbox.checked === true;
              }
            }
            const confirmed = providerSelectionModel(previews, requested);
            for (let index = 0; index < confirmed.length; index += 1) {
              if (confirmed[index].checked && descriptors[index]) {
                selected.push(descriptors[index]);
              }
            }
            try {
              validateProviderSelection(selected);
            } catch (error) {
              setStatus(error.message + ".", true);
              return;
            }
            settlement.resolve({
              descriptors: selected,
              sourceCollection,
            });
          },
        };
        operation.decision = decision;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    }

    async function previewProviders(descriptors, sourceCollection, operation) {
      const previews = await previewDescriptorBatches(descriptors, async (batch) => {
        requireCurrentProviderOperation(operation);
        const response = await profileRequest("/api/profile/providers/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ descriptors: batch }),
          signal: operation.controller.signal,
        });
        requireCurrentProviderOperation(operation);
        return response.providers;
      });
      requireCurrentProviderOperation(operation);
      return selectedProviderDecision(
        previews,
        descriptors,
        sourceCollection,
        operation
      );
    }

    async function persistSelection(decision, operation) {
      requireCurrentProviderOperation(operation);
      const signal = operation.controller.signal;
      const transition = await runProviderSetupTransition(
        { providersReady, installPromptOpened },
        {
          sourceCollection: decision.sourceCollection,
          descriptors: decision.descriptors,
          async getCurrentProviders() {
            requireCurrentProviderOperation(operation);
            const current = await profileRequest("/api/profile/providers", { signal });
            requireCurrentProviderOperation(operation);
            return current;
          },
          async createBackup(collection) {
            requireCurrentProviderOperation(operation);
            const created = await profileRequest("/api/profile/backups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                collection,
                reason: "before-browser-provider-import",
              }),
              signal,
            });
            requireCurrentProviderOperation(operation);
            return created.backup;
          },
          async putProviders(descriptors, expectedRevision) {
            requireCurrentProviderOperation(operation);
            const imported = await profileRequest("/api/profile/providers", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ descriptors, expectedRevision }),
              signal,
            });
            requireCurrentProviderOperation(operation);
            return imported;
          },
        }
      );

      requireCurrentProviderOperation(operation);
      providersReady = transition.state.providersReady;
      installPromptOpened = transition.state.installPromptOpened;
      refreshSteps();
      return {
        count: transition.result.imported.count,
        backupId: transition.result.backup.id,
      };
    }

    async function connectStremio() {
      if (!pairedForConfig || !managementCsrf) {
        setStatus("Pair Jumpgate before connecting Stremio.", true);
        return;
      }
      if (!browser.JumpgateStremioAccount) {
        setStatus("The Stremio account client failed to load.", true);
        return;
      }
      const operation = beginProviderOperation("stremio");
      if (!operation) {
        browser.alert("Finish or cancel the active provider operation first.");
        return;
      }
      const signal = operation.controller.signal;
      setHidden(byId("cancelStremioBtn"), false);
      setStatus("Creating a short-lived Stremio approval code...", false);
      try {
        const client = browser.JumpgateStremioAccount.createStremioAccountClient();
        const session = await client.createLinkSession({ signal });
        requireCurrentProviderOperation(operation);
        byId("stremioCode").textContent = session.code;
        byId("stremioApprovalLink").href = session.link;
        byId("stremioQr").src = session.qrcode;
        setHidden(byId("stremioLink"), false);
        renderLinkTimer(session.expiresAt);
        operation.timer = setInterval(() => renderLinkTimer(session.expiresAt), 1000);
        setStatus(
          "Approve using the Stremio profile you want to configure. This read-only scan applies only to the profile active during approval.",
          false
        );

        const collection = await session.readAddonCollection({
          onApproved() {
            if (!providerOperationIsCurrent(operation)) return;
            clearApprovalMaterial(operation);
            setStatus("Approval received. Reading the active profile's addon collection once in this browser...", false);
          },
        });
        requireCurrentProviderOperation(operation);
        setStatus("The active profile's addon collection was read once in this browser.", false);
        const candidates = gatewayCandidates(collection.addons);
        if (!candidates.length) throw new Error("No stream or subtitle providers were found");
        const decision = await previewProviders(candidates, collection, operation);
        setStatus("Backing up the source descriptors and importing the confirmed providers into Jumpgate...", false);
        const completed = await persistSelection(decision, operation);
        requireCurrentProviderOperation(operation);
        setFinalOperationStatus(
          operation,
          "Imported " + completed.count + " provider" + (completed.count === 1 ? "" : "s") +
            " into Jumpgate. Keep the same Stremio profile active, then open Stremio or copy either private install link below.",
          false
        );
      } catch (error) {
        if (operation.managementAuthRequired) {
          setFinalOperationStatus(operation, MANAGEMENT_AUTH_REQUIRED_MESSAGE, true);
        } else if (isCancellationError(error)) {
          setFinalOperationStatus(operation, "Stremio connection canceled.", true);
        } else {
          setFinalOperationStatus(
            operation,
            "Provider import failed. Your Stremio account was not changed. " +
              (error.message || "Jumpgate could not import the selected providers."),
            true
          );
        }
      } finally {
        finishProviderOperation(operation);
      }
    }

    async function previewManual() {
      const operation = beginProviderOperation("manual");
      if (!operation) {
        browser.alert("Finish or cancel the active provider operation first.");
        return;
      }
      try {
        const addons = parseManualCollection(byId("manualDescriptors").value);
        const candidates = gatewayCandidates(addons);
        if (!candidates.length) throw new Error("No stream or subtitle providers were found");
        const decision = await previewProviders(candidates, { addons }, operation);
        setStatus("Backing up and importing the confirmed manual provider selection...", false);
        const completed = await persistSelection(decision, operation);
        requireCurrentProviderOperation(operation);
        byId("manualDescriptors").value = "";
        setFinalOperationStatus(
          operation,
          "Imported " + completed.count + " manual providers. Open Stremio or copy either private install link below.",
          false
        );
      } catch (error) {
        if (operation.managementAuthRequired) {
          setFinalOperationStatus(operation, MANAGEMENT_AUTH_REQUIRED_MESSAGE, true);
        } else if (isCancellationError(error)) {
          setFinalOperationStatus(operation, "Manual provider import canceled.", true);
        } else {
          setFinalOperationStatus(operation, error.message || "Manual provider import failed.", true);
        }
      } finally {
        finishProviderOperation(operation);
      }
    }

    byId("pairCode").addEventListener("input", () => {
      byId("pairCode").value = formatUserCode(byId("pairCode").value);
    });
    byId("connectTraktBtn").addEventListener("click", () => void connectTrakt());
    byId("skipTraktAcknowledge").addEventListener("change", toggleSkipTrakt);
    byId("skipTraktBtn").addEventListener("click", () => void generateConfigured().catch((error) => browser.alert(error.message)));
    byId("pairBtn").addEventListener("click", () => void pairJumpgate());
    byId("connectStremioBtn").addEventListener("click", () => void connectStremio());
    byId("cancelStremioBtn").addEventListener("click", cancelStremio);
    byId("confirmProvidersBtn").addEventListener("click", () => {
      if (activeProviderOperation && activeProviderOperation.decision) {
        activeProviderOperation.decision.confirm();
      }
    });
    byId("cancelProvidersBtn").addEventListener("click", () => {
      if (activeProviderOperation) cancelProviderOperation(activeProviderOperation, "Provider selection canceled");
    });
    byId("previewManualBtn").addEventListener("click", () => void previewManual());
    byId("installConfiguredBtn").addEventListener("click", installConfigured);
    byId("refreshDevicesBtn").addEventListener("click", () => void refreshProfileManagement());
    byId("clearHistoryBtn").addEventListener("click", () => void clearBridgeHistory());
    byId("reconnectTraktBtn").addEventListener("click", () => void connectTrakt());
    byId("disconnectTraktBtn").addEventListener("click", () => void disconnectManagedTrakt());
    byId("openDeleteProfileBtn").addEventListener("click", openDeleteProfileDialog);
    byId("cancelDeleteProfileBtn").addEventListener("click", closeDeleteProfileDialog);
    byId("deleteProfileConfirmation").addEventListener("input", () => {
      byId("confirmDeleteProfileBtn").disabled =
        profileManagementBusy || byId("deleteProfileConfirmation").value !== PROFILE_DELETE_CONFIRMATION;
    });
    byId("deleteProfileForm").addEventListener("submit", (event) => {
      event.preventDefault();
      void deleteManagedProfile();
    });
    byId("deleteProfileDialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDeleteProfileDialog();
    });
    for (const id of ["bridge", "manifest", "install", "installManifest"]) {
      byId(id).addEventListener("click", (event) => {
        if (!event.currentTarget.disabled && event.currentTarget.value) event.currentTarget.select();
      });
    }
    for (const button of document.querySelectorAll("[data-copy]")) {
      button.addEventListener("click", () => {
        if (!button.disabled) copyField(button.dataset.copy);
      });
    }

    if (pairPrefill && pairPrefill.code) {
      byId("pairCode").value = formatUserCode(pairPrefill.code);
      startPairTimer(pairPrefill.expiresAt || 0);
      setPairStatus("Pair code loaded from Jumpgate. Generate a profile, then pair.", false);
    }
    if (initial) showResult(initial);
    else refreshSteps();
    if ((initial || (pairPrefill && pairPrefill.code)) && browser.location.search) {
      browser.history.replaceState(null, "", browser.location.pathname + browser.location.hash);
    }
    void recoverPendingPairing();
  }

  return Object.freeze({
    canExposePrivateInstall,
    clearPairingRecovery,
    createActivationRetryToken,
    createManagementTraktSubmitter,
    createManagementProfileRequester,
    createProfileManagementApi,
    createOneShotSettlement,
    createOperationMutex,
    defaultProviderSelection,
    gatewayCandidates,
    localApprovalDeadlineMessage,
    mount,
    parseManagedDevicesResponse,
    parseManualCollection,
    pairingActivationPayload,
    preparePairingActivation,
    previewDescriptorBatches,
    persistPairingRecovery,
    providerSelectionModel,
    resourceNames,
    readPairingRecovery,
    requestPairingActivation,
    runBridgeProviderImport,
    runProviderSetupTransition,
    safeSameOriginRedirect,
    validateProviderSelection,
    workspaceStatus,
  });
});
