const express = require("express");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const zlib = require("zlib");
const { version: BRIDGE_VERSION } = require("./package.json");
const CONFIGURE_ASSET_REVISION = `${BRIDGE_VERSION}-r15`;
const { PairingCoordinator } = require("./lib/pairing-coordinator");
const { ClaimBoundHistoryService } = require("./lib/claim-bound-history-service");
const { ProfileLifecycleService } = require("./lib/profile-lifecycle-service");
const { ProviderCollectionCoordinator } = require("./lib/provider-collection-coordinator");
const {
  ProviderGatewayError,
  ProviderGatewayService,
  buildPlaybackIdentity,
} = require("./lib/provider-gateway-service");
const { ProviderImportService } = require("./lib/provider-import-service");
const { SubtitleDeletionWorker } = require("./lib/subtitle-deletion-worker");
const { SubtitleDeliveryService } = require("./lib/subtitle-delivery-service");
const { SubtitleDiscoveryService } = require("./lib/subtitle-discovery-service");
const { SubtitleSource } = require("./lib/subtitle-source");
const { TraktScrobbleService } = require("./lib/trakt-scrobble-service");
const {
  buildTraktConsentUrl,
  resolveTraktAuthorizeUrl,
} = require("./lib/trakt-authorize-url");
const {
  MANAGEMENT_TRAKT_AJAX_PROTOCOL,
  MANAGEMENT_TRAKT_EXPANSION_CAPABILITY,
  MANAGEMENT_TRAKT_FORM_PROTOCOL,
  resolveManagementTraktClientProtocol,
} = require("./lib/management-trakt-client-protocol");
const { createPublicBaseUrlResolver } = require("./lib/public-base-url");
const {
  firstPublicArtworkUrl,
  publicArtworkUrl,
} = require("./lib/public-artwork");
const {
  isPublicAddonPath,
  resolveTrustProxy,
  setBaselineSecurityHeaders,
  setPublicAddonCors,
} = require("./lib/http-boundary");
const { createRateLimitMiddleware } = require("./lib/rate-limit-middleware");
const {
  assertValidationScenario,
  loadReleaseValidationConfig,
  waitForRequest,
} = require("./lib/release-validation");
const UAT_VOBSUB_FIXTURE = require("./lib/uat-vobsub-fixture");
const { HistoryService, projectCanonicalIdentity } = require("./lib/history-service");
const { assertCanonicalUuid } = require("./lib/history-protocol");
const {
  getPreparedHttpResponse,
  normalizePreparedHttpHeadResponse,
  normalizePreparedHttpResponse,
  preparedJsonResponse,
} = require("./lib/prepared-http-response");
const { projectPublicPlaybackClaim } = require("./lib/playback-claim-projection");
const { decodeResourceRequest } = require("./lib/stremio-transport");
const {
  ProfileProvisioner,
  deriveProfileIdentityHash,
  hashConfigBlob: hashFullConfigBlob,
} = require("./lib/profile-provisioner");
const {
  createStorageRuntime,
  loadStorageConfig,
} = require("./lib/storage");
const { isProductionLikeEnvironment } = require("./lib/runtime-environment");

const RELEASE_VALIDATION = loadReleaseValidationConfig(process.env);
const UAT_VOBSUB_ASSETS = RELEASE_VALIDATION.vobsubFixtureEnabled
  ? UAT_VOBSUB_FIXTURE.loadAssets()
  : null;

if (!process.env.CONFIG_SECRET) {
  if (process.env.NODE_ENV === "production" || RELEASE_VALIDATION.enabled) {
    console.error("FATAL: CONFIG_SECRET environment variable is required in production");
    process.exit(1);
  }
  console.warn("WARNING: CONFIG_SECRET not set. Using insecure dev default. Do NOT use in production.");
  process.env.CONFIG_SECRET = "jumpgate-dev-secret-do-not-use-in-production";
}

const ADDON_ID = "com.jumpgate.bridge";
const ADDON_NAME = "Jumpgate Bridge";
const CONTINUE_CATALOG_ID = "jumpgate-continue";

function parseBuildSha(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error("invalid JUMPGATE_BUILD_SHA");
  }
  return value;
}

// Key derivation for configured-mode URL encryption.
const ENCRYPTION_KEY = crypto.scryptSync(process.env.CONFIG_SECRET, "jumpgate-bridge-v1", 32);
const BUILD_SHA = parseBuildSha(process.env.JUMPGATE_BUILD_SHA);

const TRAKT_CLIENT_ID =
  process.env.TRAKT_CLIENT_ID ||
  "d4161a7a106424551add171e5470112e4afdaf2438e6ef2fe0548edc75924868";
const TRAKT_CLIENT_SECRET = (process.env.TRAKT_CLIENT_SECRET || "").trim();
if (!TRAKT_CLIENT_SECRET) {
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: TRAKT_CLIENT_SECRET environment variable is required in production");
    process.exit(1);
  }
  console.warn("WARNING: TRAKT_CLIENT_SECRET not set. Trakt OAuth/token refresh will be disabled.");
}
const TRAKT_AUTHORIZE_URL = resolveTraktAuthorizeUrl(process.env);
const TRAKT_AUTHORIZE_ORIGIN = new URL(TRAKT_AUTHORIZE_URL).origin;
const TRAKT_TOKEN_URL =
  process.env.NODE_ENV === "test" && process.env.JUMPGATE_TEST_TRAKT_TOKEN_URL
    ? process.env.JUMPGATE_TEST_TRAKT_TOKEN_URL
    : "https://api.trakt.tv/oauth/token";
const TRAKT_SCROBBLE_BASE_URL =
  process.env.NODE_ENV === "test" && process.env.JUMPGATE_TEST_TRAKT_SCROBBLE_BASE_URL
    ? process.env.JUMPGATE_TEST_TRAKT_SCROBBLE_BASE_URL.replace(/\/+$/, "")
    : "https://api.trakt.tv/scrobble";
const TRAKT_USER_AGENT = `Jumpgate-Bridge/${BRIDGE_VERSION}`;
const TRAKT_EXPIRY_SKEW_SEC = 60;
const TRAKT_PROVIDER = "trakt";
const TRAKT_REFRESH_WAIT_TIMEOUT_MS =
  process.env.NODE_ENV === "test" && /^\d{1,6}$/.test(process.env.JUMPGATE_TEST_TRAKT_REFRESH_WAIT_TIMEOUT_MS || "")
    ? Math.max(50, Number(process.env.JUMPGATE_TEST_TRAKT_REFRESH_WAIT_TIMEOUT_MS))
    : 45 * 1000;
const TRAKT_REFRESH_POLL_MS = 50;
const REPOSITORY_WRITE_ATTEMPTS = 8;
const MANAGEMENT_OAUTH_STATE_COOKIE = "jg_management_oauth_state";
const MANAGEMENT_OAUTH_BINDING_COOKIE = "jg_management_oauth_binding";
const MANAGEMENT_OAUTH_BINDING_COOKIE_PREFIX = "jg_management_oauth_binding_";
const MANAGEMENT_OAUTH_STATE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MANAGEMENT_OAUTH_COOKIE_SLOT_LENGTH = 22;
const MANAGEMENT_TRAKT_CLIENT_PROTOCOL = resolveManagementTraktClientProtocol(process.env);
const MANAGEMENT_TRAKT_IP_LAUNCH_LIMIT = process.env.NODE_ENV === "test" ? 10000 : 120;
const MANAGEMENT_TRAKT_IP_LAUNCH_WINDOW_MS = 60 * 1000;
const MANAGEMENT_TRAKT_LAUNCH_LIMIT = 8;
const MANAGEMENT_TRAKT_LAUNCH_WINDOW_MS = 10 * 60 * 1000;
let managementTraktIpLaunchLimit = MANAGEMENT_TRAKT_IP_LAUNCH_LIMIT;
const MANAGEMENT_SESSION_COOKIE = "jg_management_session";
const PAIR_POLL_INTERVAL_SEC = 2;
const PROFILE_ID_BYTES = 16;
const RESUME_TTL = 7 * 24 * 60 * 60 * 1000;
const META_CACHE_TTL = 24 * 60 * 60 * 1000;
const META_CACHE_MAX_ENTRIES = 2000;
const RESUME_CLEAR_RATIO = 0.9;
const CATALOG_MIN_RATIO = 0.05;
// One catalog request may scan two durable pages, return one bounded Stremio
// page, and use only a small fixed number of outbound metadata lookups.
const HISTORY_SCAN_PAGE_SIZE = 500;
const HISTORY_SCAN_MAX_RECORDS = 1000;
const CONTINUE_CATALOG_MAX_METAS = 100;
const TMDB_CATALOG_CONCURRENCY = 8;
const CONFIGURED_STREAM_DISPLAY_TIMEOUT_MS = 2500;
const TMDB_DISPLAY_TITLE_MAX_LENGTH = 256;
const TMDB_DISPLAY_TITLE_MAX_BYTES = TMDB_DISPLAY_TITLE_MAX_LENGTH * 4;
const TMDB_DISPLAY_MIN_YEAR = 1000;
const TMDB_DISPLAY_MAX_YEAR = 9999;
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const MAX_CONFIG_BLOB_BYTES = 128 * 1024;
const MAX_CONFIG_JSON_BYTES = 64 * 1024;
const TRAKT_GENERATION_PATTERN = /^tg1:[A-Za-z0-9_-]{43}$/;
const resolvePublicBaseUrl = createPublicBaseUrlResolver(process.env);

const metaCache = new Map();
let storageRuntime = null;
let storageRepositories = null;
let pairingCoordinator = null;
let providerImportService = null;
let providerGatewayService = null;
let subtitleDeliveryService = null;
let subtitleDiscoveryService = null;
let subtitleDeletionWorker = null;
let historyService = null;
let claimBoundHistoryService = null;
let profileLifecycleService = null;
let traktScrobbleService = null;
let storagePromise = null;
let testProviderGatewayFetchPolicy = null;
let testSubtitleSourceFetchPolicy = null;
let testHistoryService = null;
let testTmdbMetaLoader = null;
let testTraktAuthCodeExchange = null;
let testTraktRefresh = null;
let testTraktScrobbleDispatch = null;

async function initializeBridgeStorage() {
  const config = loadStorageConfig(process.env);
  const runtime = await createStorageRuntime(config, {
    onStorageError(kind, error) {
      const code =
        error && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
          ? " code=" + error.code
          : "";
      console.error("[storage:" + kind + "] connection error" + code);
    },
  });
  const profileProvisioner = new ProfileProvisioner({
    profiles: runtime.repositories.profiles,
    legacyConfigAliases: runtime.repositories.legacyConfigAliases,
    envelopeCrypto: runtime.envelopeCrypto,
  });
  const coordinator = new PairingCoordinator({
    pairings: runtime.repositories.pairings,
    devices: runtime.repositories.devices,
    managementSessions: runtime.repositories.managementSessions,
    profiles: runtime.repositories.profiles,
    profileProvisioner,
    decryptConfig,
    allowInsecureLoopback:
      process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test",
  });
  const providerCollectionCoordinator = new ProviderCollectionCoordinator({
    mode: config.providerMutationMode,
    providers: runtime.repositories.providers,
    playbackContexts: runtime.repositories.playbackContexts,
    subtitleDeliveries: runtime.repositories.subtitleDeliveries,
  });
  const imports = new ProviderImportService({
    profiles: runtime.repositories.profiles,
    addonCollectionBackups: runtime.repositories.addonCollectionBackups,
    providerCollectionCoordinator,
  });
  const gateway = new ProviderGatewayService({
    playbackContexts: runtime.repositories.playbackContexts,
    providerCollectionCoordinator,
    ...(testProviderGatewayFetchPolicy ? { fetchPolicy: testProviderGatewayFetchPolicy } : {}),
    onProviderError(event) {
      console.warn(
        "[gateway:" + event.phase + "] provider=" + event.providerScope +
          " profile=" + event.profileScope + " code=" + event.code
      );
    },
  });
  const history = new HistoryService({ repository: runtime.repositories.history });
  const lifecycleService = new ProfileLifecycleService({
    profiles: runtime.repositories.profiles,
    devices: runtime.repositories.devices,
    lifecycleInvalidations: runtime.repositories.lifecycleInvalidations,
    managementSessions: runtime.repositories.managementSessions,
    providerGateway: gateway,
    playbackContexts: runtime.repositories.playbackContexts,
    historyGrants: runtime.repositories.historyGrants,
    subtitleDeliveries: runtime.repositories.subtitleDeliveries,
    subtitleManifests: runtime.repositories.subtitleManifests,
  });
  const claimBoundHistory = new ClaimBoundHistoryService({
    historyGrants: runtime.repositories.historyGrants,
    playbackContexts: runtime.repositories.playbackContexts,
    claimSource: (binding, request, options) =>
      lifecycleService.claim(binding, request, options),
  });
  const subtitleSource = new SubtitleSource({
    ...(testSubtitleSourceFetchPolicy ? { fetchPolicy: testSubtitleSourceFetchPolicy } : {}),
  });
  const subtitleDelivery = new SubtitleDeliveryService({
    repository: runtime.repositories.subtitleDeliveries,
    manifests: runtime.repositories.subtitleManifests,
    objectStore: runtime.subtitleObjectStore,
    source: subtitleSource,
    tokenService: runtime.tokenService,
  });
  const subtitleDiscovery = new SubtitleDiscoveryService({
    playbackContexts: runtime.repositories.playbackContexts,
    subtitleDeliveries: runtime.repositories.subtitleDeliveries,
    gateway,
    delivery: subtitleDelivery,
    tokenService: runtime.tokenService,
  });
  const deletionWorker = new SubtitleDeletionWorker({
    repository: runtime.repositories.subtitleManifests,
    objectStore: runtime.subtitleObjectStore,
  });
  const scrobbles = new TraktScrobbleService({
    playbackContexts: runtime.repositories.playbackContexts,
    playbackSessions: runtime.repositories.playbackSessions,
    getCredential: (profileId) => getConfiguredTraktToken(profileId, null),
    dispatch: (request) => dispatchTraktScrobble(request),
    onWorkerError(error) {
      const code =
        error && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
          ? " code=" + error.code
          : "";
      console.error("[trakt:worker] dispatch pass failed" + code);
    },
  });
  storageRuntime = runtime;
  storageRepositories = runtime.repositories;
  pairingCoordinator = coordinator;
  providerImportService = imports;
  providerGatewayService = gateway;
  subtitleDeliveryService = subtitleDelivery;
  subtitleDiscoveryService = subtitleDiscovery;
  subtitleDeletionWorker = deletionWorker;
  historyService = history;
  claimBoundHistoryService = claimBoundHistory;
  profileLifecycleService = lifecycleService;
  traktScrobbleService = scrobbles;
  scrobbles.start();
  return runtime;
}

function ensureStorageReady() {
  if (!storagePromise) storagePromise = initializeBridgeStorage();
  return storagePromise;
}

function repositories() {
  if (!storageRepositories) throw new Error("storage runtime is not ready");
  return storageRepositories;
}

function activeHistoryService() {
  const service = testHistoryService || historyService;
  if (!service) throw new Error("history service is not ready");
  return service;
}

function encryptConfig(configObj) {
  const json = JSON.stringify(configObj);
  const compressed = zlib.gzipSync(Buffer.from(json, "utf8"));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64url");
}

function decryptConfig(base64urlBlob) {
  if (
    typeof base64urlBlob !== "string" ||
    base64urlBlob.length < 16 ||
    base64urlBlob.length > MAX_CONFIG_BLOB_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(base64urlBlob)
  ) {
    throw new Error("Config blob is invalid");
  }
  const blob = Buffer.from(base64urlBlob, "base64url");
  if (blob.toString("base64url") !== base64urlBlob) throw new Error("Config blob is not canonical");
  if (blob.length < 29) throw new Error("Config blob too short");

  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const json = zlib
    .gunzipSync(compressed, { maxOutputLength: MAX_CONFIG_JSON_BYTES })
    .toString("utf8");
  return normalizeConfig(JSON.parse(json));
}

function getCookie(req, name) {
  const header = req && req.headers ? req.headers.cookie : "";
  if (!header || typeof header !== "string") return "";
  const parts = header.split(";").map((p) => p.trim());
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    if (k !== name) continue;
    return part.slice(idx + 1).trim();
  }
  return "";
}

function serializeCookie(name, value, opts) {
  const parts = [];
  parts.push(name + "=" + encodeURIComponent(value || ""));
  parts.push("Path=" + (opts && opts.path ? opts.path : "/"));
  if (opts && typeof opts.maxAgeSec === "number") parts.push("Max-Age=" + Math.max(0, Math.floor(opts.maxAgeSec)));
  if (opts && Number.isSafeInteger(opts.expiresAt)) {
    const expires = new Date(opts.expiresAt);
    if (!Number.isFinite(expires.getTime())) throw new TypeError("cookie expiry is invalid");
    parts.push("Expires=" + expires.toUTCString());
  }
  if (opts && opts.httpOnly) parts.push("HttpOnly");
  if (opts && opts.secure) parts.push("Secure");
  parts.push("SameSite=" + (opts && opts.sameSite ? opts.sameSite : "Lax"));
  return parts.join("; ");
}

function setCookie(res, name, value, opts) {
  res.append("Set-Cookie", serializeCookie(name, value, opts));
}

function normalizeTraktTokens(trakt) {
  const token = trakt || {};
  return {
    access_token: typeof token.access_token === "string" ? token.access_token : "",
    refresh_token: typeof token.refresh_token === "string" ? token.refresh_token : "",
    token_expiry: Number.isFinite(Number(token.token_expiry)) ? Number(token.token_expiry) : 0,
  };
}

function normalizeConfig(config) {
  const safe = config || {};
  const profileIdRaw = typeof safe.profileId === "string" ? safe.profileId.trim() : "";
  const profileId = /^[A-Za-z0-9_-]{16,64}$/.test(profileIdRaw) ? profileIdRaw : "";
  const profileScopeRaw = typeof safe.profileScope === "string" ? safe.profileScope.trim() : "";
  const profileScope = /^[a-f0-9]{24}$/.test(profileScopeRaw) ? profileScopeRaw : "";
  const tmdbKeyRaw = typeof safe.tmdbKey === "string" ? safe.tmdbKey.trim() : "";
  // TMDB v3 API keys are 32 hex chars. If invalid, drop it to avoid
  // breaking decrypt/normalize on old/malformed blobs.
  const tmdbKey = /^[a-f0-9]{32}$/i.test(tmdbKeyRaw) ? tmdbKeyRaw : "";
  const settings = safe.settings && typeof safe.settings === "object" ? safe.settings : {};
  return {
    v: safe.v || 1,
    profileId,
    profileScope,
    name: typeof safe.name === "string" ? safe.name : "",
    tmdbKey,
    trakt: normalizeTraktTokens(safe.trakt),
    upstream: typeof safe.upstream === "string" ? safe.upstream : "",
    settings: {
      subtitle_languages:
        typeof settings.subtitle_languages === "string" && settings.subtitle_languages.trim()
          ? settings.subtitle_languages
          : "en",
      subtitles_enabled:
        typeof settings.subtitles_enabled === "boolean"
          ? settings.subtitles_enabled
          : true,
      trakt_enabled:
        typeof settings.trakt_enabled === "boolean"
          ? settings.trakt_enabled
          : true,
      bridge_url:
        typeof settings.bridge_url === "string"
          ? settings.bridge_url
          : "",
      auto_update_check:
        typeof settings.auto_update_check === "boolean"
          ? settings.auto_update_check
          : true,
    },
  };
}

function normalizeSubtitleLanguagesInput(input) {
  const raw = String(input || "")
    .trim()
    .toLowerCase();
  if (!raw) return "en";

  const seen = new Set();
  const out = [];
  for (const token of raw.split(",")) {
    const value = token.trim();
    if (!value) continue;
    if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/.test(value))
      throw new Error("subtitleLanguages must be comma-separated language codes (e.g. en,es,pt-br)");
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  if (!out.length) return "en";
  return out.join(",");
}

function normalizeBooleanInput(value, defaultValue) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
    if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  }
  return Boolean(defaultValue);
}

function hashConfigBlob(configBlob) {
  return crypto.createHash("sha256").update(configBlob).digest("hex").slice(0, 24);
}

function generateOpaqueId(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function getProfileScope(configBlob, config) {
  if (config && config.profileScope) return config.profileScope;
  const stableId = config && config.profileId ? "profile:" + config.profileId : "legacy:" + hashConfigBlob(configBlob);
  return crypto.createHash("sha256").update(stableId).digest("hex").slice(0, 24);
}

function resolveProfileIdentity(existingConfigBlob) {
  const blob = typeof existingConfigBlob === "string" ? existingConfigBlob.trim() : "";
  if (!blob) return { profileId: generateOpaqueId(PROFILE_ID_BYTES), profileScope: "" };
  const existing = decryptConfig(blob);
  if (existing.profileId) {
    return { profileId: existing.profileId, profileScope: existing.profileScope || "" };
  }
  return {
    profileId: "",
    profileScope: existing.profileScope || getProfileScope(blob, existing),
  };
}

function getBearerToken(req) {
  const value = String((req && req.headers && req.headers.authorization) || "");
  const match = value.match(/^Bearer\s+([A-Za-z0-9_-]{32,128})$/i);
  return match ? match[1] : "";
}

async function resolveConfiguredProfile(req) {
  const configHash = hashFullConfigBlob(req.params.config);
  let profileId = await repositories().legacyConfigAliases.getProfileId(configHash);
  if (!profileId) {
    const identityHash = deriveProfileIdentityHash(req.userConfig, req.params.config);
    profileId = await repositories().legacyConfigAliases.getProfileId(identityHash);
    if (profileId) {
      // Server-authenticated regenerated configs inherit only an already-paired identity.
      await repositories().legacyConfigAliases.bind(profileId, configHash);
    }
  }
  if (!profileId) return false;
  const profile = await repositories().profiles.getById(profileId);
  if (!profile || profile.status !== "active") return false;
  req.profileId = profileId;
  req.historyGeneration = profile.historyGeneration;
  // Keep existing handlers profile-stable while they migrate to durable history/OAuth repositories.
  req.configHash = profileId;
  req.profileLogHash = crypto.createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 12);
  return true;
}

async function configMiddleware(req, res, next) {
  try {
    req.userConfig = decryptConfig(req.params.config);
  } catch (_err) {
    console.warn("[config] decryption failed");
    return res.status(400).json({ error: "Invalid or corrupted configuration" });
  }
  const paired = await resolveConfiguredProfile(req);
  if (!paired) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(403).json({ error: "Configuration is not paired with Jumpgate" });
  }
  next();
}

async function configAliasMiddleware(req, _res, next) {
  try {
    req.userConfig = decryptConfig(req.params.config);
  } catch (_err) {
    return next("route");
  }
  const paired = await resolveConfiguredProfile(req);
  if (!paired) return next("route");
  next();
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJsonForScript(value) {
  return JSON.stringify(value || null)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function getPublicBaseUrl(req) {
  return resolvePublicBaseUrl(req);
}

const PUBLICATION_POLICY_URL_ENV = Object.freeze({
  privacy: "JUMPGATE_PRIVACY_POLICY_URL",
  security: "JUMPGATE_SECURITY_POLICY_URL",
  support: "JUMPGATE_SUPPORT_POLICY_URL",
});

function normalizePublicationStatus(value) {
  if (value === undefined || value === null || value === "") {
    return "Pre-release deployment";
  }
  if (typeof value !== "string") {
    throw new TypeError("JUMPGATE_DEPLOYMENT_STATUS must be a string");
  }
  const status = value.trim();
  if (
    status !== value ||
    status.length === 0 ||
    status.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(status)
  ) {
    throw new TypeError("JUMPGATE_DEPLOYMENT_STATUS is invalid");
  }
  return status;
}

function isLoopbackPolicyHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return net.isIP(normalized) === 4 && normalized.startsWith("127.");
}

function normalizePublicationPolicyUrl(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(name + " must be a non-empty URL without surrounding whitespace");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    throw new TypeError(name + " must be a valid absolute URL");
  }
  if (
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackPolicyHost(parsed.hostname))) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError(name + " must use HTTPS (or loopback HTTP) without credentials, query, or fragment");
  }
  return parsed.href;
}

function resolvePublicationPresentation(env = {}) {
  if (!env || typeof env !== "object") {
    throw new TypeError("publication environment must be an object");
  }
  const status = normalizePublicationStatus(env.JUMPGATE_DEPLOYMENT_STATUS);
  const configured = Object.entries(PUBLICATION_POLICY_URL_ENV).map(([kind, name]) => ({
    kind,
    name,
    value: env[name],
    present: env[name] !== undefined && env[name] !== null && env[name] !== "",
  }));
  const configuredCount = configured.filter((entry) => entry.present).length;
  if (configuredCount !== 0 && configuredCount !== configured.length) {
    throw new TypeError("privacy, security, and support policy URLs must be configured together");
  }
  const policyUrls = configuredCount === 0
    ? null
    : Object.fromEntries(
        configured.map((entry) => [
          entry.kind,
          normalizePublicationPolicyUrl(entry.value, entry.name),
        ])
      );
  return Object.freeze({ status, policyUrls: policyUrls && Object.freeze(policyUrls) });
}

function renderPublicationPolicyLinks(presentation) {
  if (!presentation.policyUrls) {
    return '<p class="publication-links-unavailable" role="status">Privacy, security, and support policy links are not published for this deployment.</p>';
  }
  const links = [
    ["privacy", "Privacy notice"],
    ["security", "Security policy"],
    ["support", "Support policy"],
  ].map(([kind, label]) =>
    `<a href="${escapeHtml(presentation.policyUrls[kind])}" target="_blank" rel="noopener noreferrer" aria-label="${label} (opens in a new tab)">${label.split(" ")[0]}</a>`
  );
  return `<nav class="publication-links" aria-label="Deployment policies">${links.join("")}</nav>`;
}

const publicationPresentation = resolvePublicationPresentation(process.env);

function getTraktRedirectUri(req) {
  return getPublicBaseUrl(req) + "/auth/trakt/callback";
}

function normalizePairExpiryInput(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  const rounded = Math.floor(parsed);
  // Treat values below year-2001 epoch as relative seconds.
  if (rounded < 1000000000) return Date.now() + rounded * 1000;
  return rounded;
}

function buildPairPrefillPayload(codeInput, expiresInput, req) {
  const normalizedCode = normalizePairUserCode(codeInput);
  if (!normalizedCode) return null;
  const code = formatPairUserCode(normalizedCode);
  const expiresAt = normalizePairExpiryInput(expiresInput);
  const prefillUrl = req ? buildPairPrefillUrl(req, code, expiresAt) : "";
  return { code, expiresAt, prefillUrl };
}

function buildPairPrefillUrl(req, pairCode, pairExpiresAt) {
  const params = new URLSearchParams();
  const formattedCode = formatPairUserCode(pairCode);
  if (formattedCode) params.set("pairCode", formattedCode);
  const expiresAt = normalizePairExpiryInput(pairExpiresAt);
  if (expiresAt > 0) params.set("pairExpiresAt", String(expiresAt));
  const base = getPublicBaseUrl(req) + "/configure";
  return params.toString() ? base + "?" + params.toString() : base;
}

function normalizePairUserCode(input) {
  return String(input || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizePairDeviceCode(input) {
  return String(input || "").trim();
}

function formatPairUserCode(raw) {
  const code = normalizePairUserCode(raw);
  if (code.length <= 4) return code;
  return code.slice(0, 4) + "-" + code.slice(4, 8);
}

function getOriginValidationOrigin(req) {
  return new URL(getPublicBaseUrl(req)).origin;
}

function isAllowedRequestOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients (Kodi) won't send Origin.
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.origin === getOriginValidationOrigin(req);
  } catch (_err) {
    return false;
  }
}

function hasExactBrowserOrigin(req) {
  const origin = req && req.headers ? req.headers.origin : "";
  if (typeof origin !== "string" || !origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.origin === origin && parsed.origin === getOriginValidationOrigin(req);
  } catch (_error) {
    return false;
  }
}

function managementOAuthCookieSlot(stateToken) {
  if (
    typeof stateToken !== "string" ||
    !MANAGEMENT_OAUTH_STATE_TOKEN_PATTERN.test(stateToken)
  ) {
    return "";
  }
  return crypto
    .createHash("sha256")
    .update(stateToken, "ascii")
    .digest("base64url")
    .slice(0, MANAGEMENT_OAUTH_COOKIE_SLOT_LENGTH);
}

function managementOAuthBindingCookieName(stateToken) {
  const slot = managementOAuthCookieSlot(stateToken);
  return slot ? MANAGEMENT_OAUTH_BINDING_COOKIE_PREFIX + slot : "";
}

function compareSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function normalizeIp(raw) {
  let ip = String(raw || "").trim();
  if (!ip) return "";
  if (ip === "::1" || ip === "::ffff:127.0.0.1" || ip === "127.0.0.1") return "localhost";
  const v4WithPort = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) ip = v4WithPort[1];
  return ip;
}

function parseContentId(type, id) {
  const rawId = String(id || "");
  const parts = rawId.split(":");
  let season = "";
  let episode = "";

  if (/^tt\d{7,}$/.test(parts[0] || "")) {
    season = parts[1] || "";
    episode = parts[2] || "";
  } else if (type === "series") {
    // Best-effort extraction for non-imdb ids like tmdb:tv:12345:1:2
    const numeric = parts.filter((p) => /^\d+$/.test(p));
    if (numeric.length >= 2) {
      season = numeric[numeric.length - 2];
      episode = numeric[numeric.length - 1];
    }
  }

  return { season, episode, rawId };
}

function extractImdbFromId(type, id) {
  const raw = String(id || "");
  const pattern = type === "series" ? /^(tt\d{7,}):\d+:\d+$/ : /^(tt\d{7,})$/;
  const match = raw.match(pattern);
  return match ? match[1] : "";
}

function normalizeTmdbKeyInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (!/^[a-f0-9]{32}$/i.test(raw)) {
    throw new Error("tmdbKey must be a valid TMDB v3 API key (32 hex chars)");
  }
  return raw;
}

function pickBestTmdbLogo(logos) {
  const list = Array.isArray(logos) ? logos.filter((l) => l && typeof l.file_path === "string") : [];
  if (list.length === 0) return null;

  const langRank = (iso) => {
    if (iso === "en") return 0;
    if (iso === null || iso === undefined) return 1;
    return 2;
  };

  const sorted = list.slice().sort((a, b) => {
    const la = langRank(a.iso_639_1);
    const lb = langRank(b.iso_639_1);
    if (la !== lb) return la - lb;

    const va = Number.isFinite(Number(a.vote_average)) ? Number(a.vote_average) : 0;
    const vb = Number.isFinite(Number(b.vote_average)) ? Number(b.vote_average) : 0;
    if (va !== vb) return vb - va;

    const wa = Number.isFinite(Number(a.width)) ? Number(a.width) : 0;
    const wb = Number.isFinite(Number(b.width)) ? Number(b.width) : 0;
    return wb - wa;
  });

  return sorted[0] || null;
}

function boundedTmdbDisplayTitle(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > TMDB_DISPLAY_TITLE_MAX_LENGTH ||
    Buffer.byteLength(value, "utf8") > TMDB_DISPLAY_TITLE_MAX_BYTES ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return "";
  }
  return value;
}

function tmdbReleaseYear(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isSafeInteger(year) ||
    year < TMDB_DISPLAY_MIN_YEAR ||
    year > TMDB_DISPLAY_MAX_YEAR ||
    !Number.isSafeInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isSafeInteger(day) ||
    day < 1
  ) {
    return null;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth ? year : null;
}

function getMetaCacheKey(imdbId, apiKey) {
  const keyHash = crypto.createHash("sha256").update(String(apiKey || "")).digest("hex").slice(0, 12);
  return String(imdbId || "") + "|" + keyHash;
}

function pruneMetaCacheHardLimit() {
  if (metaCache.size <= META_CACHE_MAX_ENTRIES) return;
  const entries = Array.from(metaCache.entries()).sort((a, b) => {
    const ats = Number(a && a[1] && a[1].ts) || 0;
    const bts = Number(b && b[1] && b[1].ts) || 0;
    return ats - bts;
  });
  const removeCount = metaCache.size - META_CACHE_MAX_ENTRIES;
  for (let i = 0; i < removeCount; i++) {
    const key = entries[i] && entries[i][0] ? entries[i][0] : "";
    if (key) metaCache.delete(key);
  }
}

function getCachedTmdbMeta(imdbId, keyOverride) {
  const apiKey = (keyOverride || TMDB_API_KEY || "").trim();
  if (!apiKey) return null;
  const cacheKey = getMetaCacheKey(imdbId, apiKey);
  const cached = metaCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.ts >= META_CACHE_TTL) return null;
  return cached;
}

function warmTmdbMetaAsync(imdbId, keyOverride) {
  if (!/^tt\d{7,}$/.test(String(imdbId || ""))) return;
  const apiKey = (keyOverride || TMDB_API_KEY || "").trim();
  if (!apiKey) return;
  const cached = getCachedTmdbMeta(imdbId, keyOverride);
  if (cached) return;
  getTmdbMeta(imdbId, keyOverride).catch(() => {});
}

async function getTmdbMeta(imdbId, keyOverride, options = {}) {
  const apiKey = (keyOverride || TMDB_API_KEY || "").trim();
  if (!/^[a-f0-9]{32}$/i.test(apiKey) || !/^tt\d{7,}$/.test(String(imdbId || ""))) {
    return null;
  }
  const fetchTmdb = typeof options.fetch === "function" ? options.fetch : fetch;
  const fetchOptions = {
    timeout: 2500,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const cacheKey = getMetaCacheKey(imdbId, apiKey);
  const cached = metaCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < META_CACHE_TTL) return cached;

  try {
    const findUrl =
      "https://api.themoviedb.org/3/find/" +
      imdbId +
      "?api_key=" +
      apiKey +
      "&external_source=imdb_id";
    const res = await fetchTmdb(findUrl, fetchOptions).catch(() => null);
    if (!res || !res.ok) return null;

    const data = await res.json().catch(() => ({}));
    const movie = Array.isArray(data && data.movie_results) ? data.movie_results[0] : null;
    const tv = Array.isArray(data && data.tv_results) ? data.tv_results[0] : null;
    const item = movie || tv;
    const mediaType = movie ? "movie" : tv ? "tv" : "";
    if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || !mediaType) return null;

    let logo = "";
    try {
      const imagesUrl =
        "https://api.themoviedb.org/3/" +
        mediaType +
        "/" +
        item.id +
        "/images?api_key=" +
        apiKey +
        "&include_image_language=en,null";
      const imgRes = await fetchTmdb(imagesUrl, fetchOptions).catch(() => null);
      if (imgRes && imgRes.ok) {
        const images = await imgRes.json().catch(() => ({}));
        const best = pickBestTmdbLogo(images && images.logos);
        if (best && typeof best.file_path === "string" && best.file_path) {
          // Keep logo small for near-instant overlay decode/render on lower-end devices.
          logo = publicArtworkUrl("https://image.tmdb.org/t/p/w185" + best.file_path);
        }
      }
    } catch (_err) {
      logo = "";
    }
    if (options.signal && options.signal.aborted) return null;

    const meta = {
      name: boundedTmdbDisplayTitle(item.title || item.name) || imdbId,
      year: tmdbReleaseYear(item.release_date) ?? tmdbReleaseYear(item.first_air_date),
      poster: item.poster_path
        ? publicArtworkUrl("https://image.tmdb.org/t/p/w342" + item.poster_path)
        : "",
      background: item.backdrop_path
        ? publicArtworkUrl("https://image.tmdb.org/t/p/w780" + item.backdrop_path)
        : "",
      logo,
      ts: Date.now(),
    };
    metaCache.set(cacheKey, meta);
    pruneMetaCacheHardLimit();
    return meta;
  } catch (err) {
    console.error("[tmdb] metadata lookup failed");
    return null;
  }
}

function getCatalogEntries(type, historyRecords, nowMs) {
  const winners = new Map();
  const recency = (record) => [
    Number.isSafeInteger(record.lastPlayedAt) ? record.lastPlayedAt : 0,
    Number.isSafeInteger(record.changeSequence) ? record.changeSequence : 0,
    Number.isSafeInteger(record.updatedAt) ? record.updatedAt : 0,
    Number.isSafeInteger(record.revision) ? record.revision : 0,
  ];
  const isNewer = (candidate, current) => {
    const left = recency(candidate);
    const right = recency(current);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] > right[index];
    }
    return false;
  };

  for (const record of historyRecords) {
    if (!record) continue;
    const identity = projectCanonicalIdentity(record.canonicalIdentity);
    if (!identity) continue;
    const entryType = identity.mediaType === "episode" ? "series" : "movie";
    if (entryType !== type) continue;
    const identityKey = JSON.stringify([
      identity.provider,
      identity.id,
      identity.mediaType,
      identity.mediaType === "episode" ? identity.season : null,
      identity.mediaType === "episode" ? identity.episode : null,
    ]);
    const current = winners.get(identityKey);
    if (!current || isNewer(record, current.record)) winners.set(identityKey, { identity, record });
  }

  const entries = [];
  const deduplicated = Array.from(winners.values()).sort((left, right) =>
    isNewer(left.record, right.record) ? -1 : isNewer(right.record, left.record) ? 1 : 0
  );
  for (const { identity, record } of deduplicated) {
    const isEpisode = identity.mediaType === "episode";
    const season = isEpisode ? identity.season : undefined;
    const episode = isEpisode ? identity.episode : undefined;
    const entryType = isEpisode ? "series" : "movie";
    if (record.completed || nowMs - record.lastPlayedAt > RESUME_TTL) continue;
    if (!record.durationMs || record.durationMs <= 0) continue;

    const pct = record.positionMs / record.durationMs;
    if (pct < CATALOG_MIN_RATIO || pct > RESUME_CLEAR_RATIO) continue;

    const baseId = identity.provider === "imdb" ? identity.id : identity.provider + ":" + identity.id;
    const metaId = isEpisode ? baseId + ":" + season + ":" + episode : baseId;
    const display = record.displaySnapshot && typeof record.displaySnapshot === "object"
      ? record.displaySnapshot
      : {};
    entries.push({
      imdb: identity.provider === "imdb" ? identity.id : "",
      metaId,
      season,
      episode,
      isEpisode,
      entryType,
      pct,
      title:
        typeof display.title === "string" &&
        display.title.length <= 256 &&
        !/[\u0000-\u001f\u007f]/.test(display.title)
          ? display.title
          : "",
      poster: publicArtworkUrl(display.poster),
    });
    if (entries.length >= CONTINUE_CATALOG_MAX_METAS) break;
  }
  return entries;
}

async function listRecentHistory(profileId, nowMs) {
  const records = [];
  let cursor;
  while (records.length < HISTORY_SCAN_MAX_RECORDS) {
    const pageLimit = Math.min(
      HISTORY_SCAN_PAGE_SIZE,
      HISTORY_SCAN_MAX_RECORDS - records.length
    );
    const page = await repositories().history.list(profileId, {
      limit: pageLimit,
      ...(cursor ? { cursor } : {}),
    });
    const accepted = page.slice(0, pageLimit);
    records.push(...accepted);
    if (accepted.length < pageLimit || records.length >= HISTORY_SCAN_MAX_RECORDS) break;
    const last = accepted[accepted.length - 1];
    if (last.lastPlayedAt < nowMs - RESUME_TTL) break;
    cursor = {
      lastPlayedAt: last.lastPlayedAt,
      revision: last.revision,
      contentKey: last.contentKey,
    };
  }
  return records;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  let stopped = false;
  let firstError;
  async function worker() {
    for (;;) {
      if (stopped) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          firstError = error;
        }
        return;
      }
    }
  }
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (stopped) throw firstError;
  return results;
}

async function buildCatalogMetas(type, historyRecords, tmdbKeyOverride, nowMs) {
  const entries = getCatalogEntries(type, historyRecords, nowMs);
  const loadTmdbMeta = testTmdbMetaLoader || getTmdbMeta;
  return mapWithConcurrency(
    entries,
    TMDB_CATALOG_CONCURRENCY,
    async ({ imdb, metaId, season, episode, isEpisode, entryType, pct, title, poster: displayPoster }) => {
      const tmdb = imdb ? await loadTmdbMeta(imdb, tmdbKeyOverride || "") : null;
      const name = tmdb ? tmdb.name : title || metaId;
      const poster = firstPublicArtworkUrl(tmdb && tmdb.poster, displayPoster);

      return {
        id: metaId,
        type: entryType,
        name: name + (isEpisode ? " S" + season + "E" + episode : ""),
        ...(poster ? { poster } : {}),
        description: Math.round(pct * 100) + "% watched",
      };
    }
  );
}

function extractConfigBlobFromBridgeBaseUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const parsePathParts = (pathname) => String(pathname || "").split("/").filter(Boolean);

  try {
    const parsed = new URL(raw);
    const parts = parsePathParts(parsed.pathname);
    if (parts[0] === "_c" && parts[1]) return parts[1];
    if (parts[0]) return parts[0];
    return "";
  } catch (_err) {
    // fall through to non-URL parsing
  }

  const trimmed = raw.split("?")[0].split("#")[0];
  const canonicalMatch = trimmed.match(/(?:^|\/)_c\/([^/]+)/i);
  if (canonicalMatch && canonicalMatch[1]) return canonicalMatch[1];

  const parts = parsePathParts(trimmed);
  if (parts[0] === "_c" && parts[1]) return parts[1];
  if (parts[0]) return parts[0];
  return "";
}

function setConfigurePrivacyHeaders(res, scriptNonce) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  // Preserve an exact form Origin without disclosing capability-bearing paths or queries.
  res.setHeader("Referrer-Policy", "strict-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (scriptNonce) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; " +
        "script-src 'nonce-" +
        scriptNonce +
        "'; script-src-attr 'none'; style-src 'self'; style-src-attr 'none'; " +
        "img-src 'self' data: https:; font-src 'self'; " +
        "connect-src 'self' https://link.stremio.com https://api.strem.io; " +
        "base-uri 'none'; form-action 'self' " +
        TRAKT_AUTHORIZE_ORIGIN +
        "; frame-ancestors 'none'; object-src 'none'"
    );
  }
}

function configuredStreamImdbId(request) {
  if (!request || request.resource !== "stream") return "";
  try {
    const identity = buildPlaybackIdentity(request).canonicalIdentity;
    return identity && identity.provider === "imdb" && /^tt\d{7,}$/.test(identity.id)
      ? identity.id
      : "";
  } catch (_error) {
    return "";
  }
}

function sanitizeConfiguredStreamDisplay(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const display = {};
  const title = boundedTmdbDisplayTitle(metadata.name);
  if (title) display.title = title;
  if (
    Number.isSafeInteger(metadata.year) &&
    metadata.year >= TMDB_DISPLAY_MIN_YEAR &&
    metadata.year <= TMDB_DISPLAY_MAX_YEAR
  ) {
    display.year = metadata.year;
  }
  const poster = publicArtworkUrl(metadata.poster);
  if (poster) display.poster = poster;
  const background = publicArtworkUrl(metadata.background);
  if (background) display.background = background;
  const logo = publicArtworkUrl(metadata.logo);
  if (logo) display.logo = logo;
  return display;
}

async function loadConfiguredStreamDisplay(request, keyOverride, options = {}) {
  const imdbId = configuredStreamImdbId(request);
  const apiKey = (keyOverride || TMDB_API_KEY || "").trim();
  if (!imdbId || !/^[a-f0-9]{32}$/i.test(apiKey)) return {};

  const parentSignal = options.signal;
  if (parentSignal && parentSignal.aborted) return {};
  const controller = new AbortController();
  let timeoutId = null;
  let removeParentAbort = () => {};
  const stopped = new Promise((resolve) => {
    const stop = () => {
      if (!controller.signal.aborted) controller.abort();
      resolve(null);
    };
    timeoutId = setTimeout(stop, CONFIGURED_STREAM_DISPLAY_TIMEOUT_MS);
    if (typeof timeoutId.unref === "function") timeoutId.unref();
    if (parentSignal && typeof parentSignal.addEventListener === "function") {
      parentSignal.addEventListener("abort", stop, { once: true });
      removeParentAbort = () => parentSignal.removeEventListener("abort", stop);
    }
  });

  try {
    const loader = testTmdbMetaLoader || getTmdbMeta;
    const metadata = await Promise.race([
      Promise.resolve().then(() => loader(imdbId, apiKey, { signal: controller.signal })),
      stopped,
    ]);
    return sanitizeConfiguredStreamDisplay(metadata);
  } catch (_error) {
    return {};
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    removeParentAbort();
  }
}

function buildConfiguredUrls(req, configBlob) {
  const base = getPublicBaseUrl(req);

  // Stremio deeplink format (Android): stremio://<host>/<path>
  // IMPORTANT: Do NOT embed "https://..." after stremio://, because Stremio
  // parses the host as "https" and then tries to fetch https://https//host/...
  // (see user report 2026-02-15).
  const toHttpsUrl = (rawUrl) => {
    try {
      const u = new URL(rawUrl);
      u.protocol = "https:";
      return u.toString();
    } catch (_e) {
      return String(rawUrl || "").replace(/^http:\/\//i, "https://");
    }
  };

  const toStremioDeeplink = (rawUrl) => {
    try {
      const u = new URL(toHttpsUrl(rawUrl));
      return "stremio://" + u.host + u.pathname + u.search;
    } catch (_e) {
      const s = String(rawUrl || "");
      return "stremio://" + s.replace(/^https?:\/\//i, "");
    }
  };

  const bridgeBaseUrl = base + "/_c/" + configBlob;
  const manifestUrl = bridgeBaseUrl + "/manifest.json";
  return {
    config: configBlob,
    bridgeBaseUrl,
    manifestUrl,
    installUrl: toStremioDeeplink(manifestUrl),
  };
}

function isTokenFresh(token) {
  const nowSec = Math.floor(Date.now() / 1000);
  return Boolean(token.access_token) && token.token_expiry > nowSec + TRAKT_EXPIRY_SKEW_SEC;
}

function hasTraktCredentials(token) {
  return Boolean(token && (token.access_token || token.refresh_token));
}

function createTraktGeneration() {
  return "tg1:" + crypto.randomBytes(32).toString("base64url");
}

function readTraktGeneration(credentials) {
  const value = credentials && credentials.credential_generation;
  return typeof value === "string" && TRAKT_GENERATION_PATTERN.test(value) ? value : null;
}

function traktCredential(tokens, generation) {
  if (!TRAKT_GENERATION_PATTERN.test(generation)) {
    throw new TypeError("Trakt credential generation is invalid");
  }
  return {
    ...normalizeTraktTokens(tokens),
    credential_generation: generation,
    connection_state: "connected",
  };
}

function traktFenceError() {
  const error = new Error("Trakt credential fence changed");
  error.code = "trakt_generation_changed";
  return error;
}

function isRevisionConflict(error) {
  return Boolean(error && error.code === "revision_conflict");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function monotonicMilliseconds() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function readTraktRefreshState(credentials) {
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    return { status: "invalid" };
  }
  // A legacy expiring lock cannot prove that its token was never sent upstream.
  if (Object.prototype.hasOwnProperty.call(credentials, "refresh_lock")) {
    return { status: "invalid" };
  }
  if (credentials.connection_state === "disconnected") {
    if (hasTraktCredentials(normalizeTraktTokens(credentials)) || !readTraktGeneration(credentials)) {
      return { status: "invalid" };
    }
    return { status: "disconnected" };
  }
  if (!Object.prototype.hasOwnProperty.call(credentials, "refresh_state")) {
    return { status: "ready" };
  }
  const state = credentials.refresh_state;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { status: "invalid" };
  }
  if (state.status === "reauthorization_required") {
    return { status: "reauthorization_required" };
  }
  if (
    state.status === "refreshing" &&
    typeof state.attempt_id === "string" &&
    /^[A-Za-z0-9_-]{24,64}$/.test(state.attempt_id)
  ) {
    return { status: "refreshing", attemptId: state.attempt_id };
  }
  return { status: "invalid" };
}

function tokenFreeTraktCredential(status, attemptId, generation) {
  if (!TRAKT_GENERATION_PATTERN.test(generation)) {
    throw new TypeError("Trakt credential generation is invalid");
  }
  return {
    access_token: "",
    refresh_token: "",
    token_expiry: 0,
    credential_generation: generation,
    connection_state: status === "disconnected" ? "disconnected" : "connected",
    refresh_state:
      status === "refreshing"
        ? { status, attempt_id: attemptId }
        : { status },
  };
}

function tokenUnavailableError() {
  const error = new Error("Trakt token unavailable");
  error.code = "token_unavailable";
  return error;
}

function traktApiHeaders(additional = {}) {
  return {
    Accept: "application/json",
    "User-Agent": TRAKT_USER_AGENT,
    "trakt-api-version": "2",
    "trakt-api-key": TRAKT_CLIENT_ID,
    ...additional,
  };
}

function traktExchangeError(category, status) {
  const allowed = new Set([
    "invalid_client",
    "invalid_grant",
    "oauth_rejected",
    "response_invalid",
    "transport",
    "upstream_rejected",
  ]);
  const boundedCategory = allowed.has(category) ? category : "upstream_rejected";
  const error = new Error("Trakt authorization exchange failed");
  error.code = "trakt_exchange_" + boundedCategory;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    error.traktStatus = status;
  }
  return error;
}

function traktCallbackError(category) {
  const error = new Error("Trakt callback rejected");
  error.code = "trakt_callback_" + category;
  return error;
}

function managementTraktCallbackFailure(stage, error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  let category = "service_unavailable";
  let message = "Trakt connection is temporarily unavailable. Try again shortly.";

  if (code === "trakt_callback_authorization_denied") {
    category = "authorization_denied";
    message = "Trakt authorization was cancelled. Start again when you are ready.";
  } else if (code === "trakt_callback_state_invalid") {
    category = "state_invalid";
    message = "Trakt connection state expired or was lost. Start again from this paired profile.";
  } else if (code === "trakt_callback_profile_changed" || code === "trakt_generation_changed") {
    category = "profile_changed";
    message = "This Jumpgate profile changed while Trakt was connecting. Start again.";
  } else if (code === "trakt_exchange_invalid_client") {
    category = "invalid_client";
    message = "The Bridge Trakt application is not configured correctly. Contact the deployment owner.";
  } else if (code === "trakt_exchange_invalid_grant") {
    category = "invalid_grant";
    message = "Trakt rejected the authorization response. Start again; if this repeats, the Bridge Trakt callback settings need attention.";
  } else if (code.startsWith("trakt_exchange_")) {
    category = code.slice("trakt_exchange_".length);
    message = "Trakt could not complete the connection. Try again shortly.";
  } else if (stage === "credential_write") {
    category = "credential_write";
    message = "Trakt authorized, but Jumpgate could not save the connection. Start again.";
  }

  const status =
    error && Number.isInteger(error.traktStatus) && error.traktStatus >= 100 && error.traktStatus <= 599
      ? " status=" + error.traktStatus
      : "";
  if (!["authorization_denied", "profile_changed", "state_invalid"].includes(category)) {
    console.error("[trakt:oauth] callback failed stage=" + stage + " category=" + category + status);
  }
  return message;
}

async function failClosedTraktCredential(repository, profileId, record, expectedAttemptId) {
  let current = record;
  for (let attempt = 0; attempt < REPOSITORY_WRITE_ATTEMPTS; attempt += 1) {
    if (!current) return null;
    const state = readTraktRefreshState(current.credentials);
    const generation = readTraktGeneration(current.credentials);
    if (!generation) return current;
    if (state.status === "disconnected") return current;
    if (state.status === "reauthorization_required") return current;
    if (expectedAttemptId) {
      if (state.status !== "refreshing" || state.attemptId !== expectedAttemptId) return current;
    } else if (state.status === "ready") {
      return current;
    }

    try {
      return await repository.put(
        profileId,
        TRAKT_PROVIDER,
        tokenFreeTraktCredential("reauthorization_required", null, generation),
        current.revision
      );
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      current = await repository.get(profileId, TRAKT_PROVIDER);
    }
  }
  throw tokenUnavailableError();
}

async function ensureTraktCredentialGeneration(profileId, options = {}) {
  const repository = repositories().oauthCredentials;
  let current = options.current === undefined
    ? await repository.get(profileId, TRAKT_PROVIDER)
    : options.current;
  for (let attempt = 0; attempt < REPOSITORY_WRITE_ATTEMPTS; attempt += 1) {
    const existingGeneration = readTraktGeneration(current && current.credentials);
    if (existingGeneration) return current;
    const generation = createTraktGeneration();
    const credentials = current
      ? {
          ...current.credentials,
          credential_generation: generation,
          connection_state: current.credentials.connection_state === "disconnected"
            ? "disconnected"
            : "connected",
        }
      : tokenFreeTraktCredential("disconnected", null, generation);
    try {
      return await repository.put(
        profileId,
        TRAKT_PROVIDER,
        credentials,
        current ? current.revision : 0
      );
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      current = await repository.get(profileId, TRAKT_PROVIDER);
    }
  }
  throw new Error("Trakt credential generation changed too many times");
}

async function getOrSeedTraktCredential(profileId, config) {
  const repository = repositories().oauthCredentials;
  const current = await repository.get(profileId, TRAKT_PROVIDER);
  if (current) return ensureTraktCredentialGeneration(profileId, { current });

  const fallback = normalizeTraktTokens(config && config.trakt);
  if (!hasTraktCredentials(fallback)) return null;
  const seeded = traktCredential(fallback, createTraktGeneration());
  try {
    return await repository.put(profileId, TRAKT_PROVIDER, seeded, 0);
  } catch (error) {
    if (!isRevisionConflict(error)) throw error;
    const raced = await repository.get(profileId, TRAKT_PROVIDER);
    return raced ? ensureTraktCredentialGeneration(profileId, { current: raced }) : null;
  }
}

async function replaceTraktCredential(profileId, tokens, fence = {}) {
  const repository = repositories().oauthCredentials;
  const credentials = normalizeTraktTokens(tokens);
  if (!hasTraktCredentials(credentials)) return null;

  for (let attempt = 0; attempt < REPOSITORY_WRITE_ATTEMPTS; attempt += 1) {
    const current = await repository.get(profileId, TRAKT_PROVIDER);
    const currentGeneration = readTraktGeneration(current && current.credentials);
    if (
      fence.expectedRevision !== undefined &&
      (!current || current.revision !== fence.expectedRevision)
    ) {
      throw traktFenceError();
    }
    if (
      fence.expectedGeneration !== undefined &&
      currentGeneration !== fence.expectedGeneration
    ) {
      throw traktFenceError();
    }
    if (
      fence.expectedGeneration === undefined &&
      current &&
      readTraktRefreshState(current.credentials).status === "disconnected"
    ) {
      throw traktFenceError();
    }
    const generation = fence.expectedGeneration || currentGeneration || createTraktGeneration();
    try {
      return await repository.put(
        profileId,
        TRAKT_PROVIDER,
        traktCredential(credentials, generation),
        current ? current.revision : 0
      );
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      if (fence.expectedRevision !== undefined || fence.expectedGeneration !== undefined) {
        throw traktFenceError();
      }
    }
  }
  throw new Error("Trakt credentials changed too many times");
}

async function disconnectTraktCredential(profileId) {
  const repository = repositories().oauthCredentials;
  let current = await ensureTraktCredentialGeneration(profileId);
  for (let attempt = 0; attempt < REPOSITORY_WRITE_ATTEMPTS; attempt += 1) {
    const marker = tokenFreeTraktCredential("disconnected", null, createTraktGeneration());
    try {
      return await repository.put(profileId, TRAKT_PROVIDER, marker, current.revision);
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      current = await repository.get(profileId, TRAKT_PROVIDER);
      if (!current) current = await ensureTraktCredentialGeneration(profileId, { current: null });
    }
  }
  throw new Error("Trakt disconnect changed too many times");
}

function isTraktCredentialLinked(record) {
  if (!record || readTraktRefreshState(record.credentials).status !== "ready") return false;
  return hasTraktCredentials(normalizeTraktTokens(record.credentials));
}

async function exchangeTraktAuthCode(code, redirectUri) {
  if (testTraktAuthCodeExchange) {
    return normalizeTraktTokens(await testTraktAuthCodeExchange(code, redirectUri));
  }
  if (!TRAKT_CLIENT_SECRET) throw new Error("TRAKT_CLIENT_SECRET is not configured");
  const payload = {
    code,
    client_id: TRAKT_CLIENT_ID,
    client_secret: TRAKT_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  };

  let res;
  try {
    res = await fetch(TRAKT_TOKEN_URL, {
      method: "POST",
      headers: traktApiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload),
      timeout: 10000,
    });
  } catch (_error) {
    throw traktExchangeError("transport");
  }

  let body = null;
  try {
    body = await res.json();
  } catch (_error) {
    throw traktExchangeError("response_invalid", res.status);
  }
  if (!res.ok) {
    const oauthError = body && typeof body.error === "string" ? body.error : "";
    if (oauthError === "invalid_client") throw traktExchangeError("invalid_client", res.status);
    if (oauthError === "invalid_grant") throw traktExchangeError("invalid_grant", res.status);
    if (oauthError) throw traktExchangeError("oauth_rejected", res.status);
    throw traktExchangeError("upstream_rejected", res.status);
  }
  if (!body || typeof body.access_token !== "string" || !body.access_token) {
    throw traktExchangeError("response_invalid", res.status);
  }

  const createdAt = Number(body.created_at) || Math.floor(Date.now() / 1000);
  const expiresIn = Number(body.expires_in) || 24 * 60 * 60;
  return normalizeTraktTokens({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_expiry: createdAt + expiresIn,
  });
}

async function refreshTraktToken(refreshToken) {
  if (testTraktRefresh) {
    return normalizeTraktTokens(await testTraktRefresh(refreshToken));
  }
  if (!TRAKT_CLIENT_SECRET) throw new Error("TRAKT_CLIENT_SECRET is not configured");
  const payload = {
    refresh_token: refreshToken,
    client_id: TRAKT_CLIENT_ID,
    client_secret: TRAKT_CLIENT_SECRET,
    grant_type: "refresh_token",
  };

  const res = await fetch(TRAKT_TOKEN_URL, {
    method: "POST",
    headers: traktApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
    timeout: 10000,
  });

  let body;
  try {
    body = await res.json();
  } catch (_error) {
    throw tokenUnavailableError();
  }
  if (!res.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
    throw tokenUnavailableError();
  }
  if (typeof body.refresh_token !== "string" || !body.refresh_token) {
    throw tokenUnavailableError();
  }

  const createdAt = Number(body.created_at) || Math.floor(Date.now() / 1000);
  const expiresIn = Number(body.expires_in) || 24 * 60 * 60;
  return normalizeTraktTokens({
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_expiry: createdAt + expiresIn,
  });
}

async function dispatchTraktScrobble(request) {
  if (testTraktScrobbleDispatch) return testTraktScrobbleDispatch(request);
  let response;
  try {
    response = await fetch(TRAKT_SCROBBLE_BASE_URL + "/" + request.action, {
      method: "POST",
      headers: traktApiHeaders({
        Authorization: "Bearer " + request.accessToken,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(request.payload),
      timeout: 10000,
      size: 64 * 1024,
    });
  } catch (error) {
    const bounded = new Error("Trakt scrobble transport failed");
    if (error && ["EAI_AGAIN", "ECONNREFUSED", "ENOTFOUND"].includes(error.code)) {
      bounded.preEffect = true;
    }
    throw bounded;
  }
  await response.text().catch(() => "");
  return { status: response.status };
}

async function getConfiguredTraktToken(profileId, config) {
  const repository = repositories().oauthCredentials;
  let record = await getOrSeedTraktCredential(profileId, config);
  if (!record) return null;

  const deadline = monotonicMilliseconds() + TRAKT_REFRESH_WAIT_TIMEOUT_MS;
  let observedRefresh = false;
  for (;;) {
    const state = readTraktRefreshState(record.credentials);
    const generation = readTraktGeneration(record.credentials);
    if (!generation) throw tokenUnavailableError();
    if (state.status === "disconnected" || state.status === "reauthorization_required") {
      throw tokenUnavailableError();
    }
    if (state.status === "invalid") {
      await failClosedTraktCredential(repository, profileId, record, null);
      throw tokenUnavailableError();
    }
    if (state.status === "refreshing") {
      observedRefresh = true;
      const remaining = deadline - monotonicMilliseconds();
      if (remaining <= 0) {
        await failClosedTraktCredential(repository, profileId, record, state.attemptId);
        throw tokenUnavailableError();
      }
      await delay(Math.min(TRAKT_REFRESH_POLL_MS, remaining));
      record = await repository.get(profileId, TRAKT_PROVIDER);
      if (!record) return null;
      continue;
    }

    const token = normalizeTraktTokens(record.credentials);
    if (!hasTraktCredentials(token)) return null;
    if (isTokenFresh(token)) return { ...token, refreshed: observedRefresh };
    if (!token.refresh_token) return null;

    const attemptId = crypto.randomBytes(24).toString("base64url");
    let claimed;
    try {
      claimed = await repository.put(
        profileId,
        TRAKT_PROVIDER,
        tokenFreeTraktCredential("refreshing", attemptId, generation),
        record.revision
      );
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
      record = await repository.get(profileId, TRAKT_PROVIDER);
      if (!record) return null;
      continue;
    }

    let fresh;
    try {
      fresh = await refreshTraktToken(token.refresh_token);
    } catch (_error) {
      try {
        await failClosedTraktCredential(repository, profileId, claimed, attemptId);
      } catch (_persistenceError) {}
      throw tokenUnavailableError();
    }

    try {
      const persisted = await repository.put(
        profileId,
        TRAKT_PROVIDER,
        traktCredential(fresh, generation),
        claimed.revision
      );
      return { ...normalizeTraktTokens(persisted.credentials), refreshed: true };
    } catch (error) {
      const current = await repository.get(profileId, TRAKT_PROVIDER).catch(() => null);
      const currentState = readTraktRefreshState(current && current.credentials);
      const currentToken = normalizeTraktTokens(current && current.credentials);
      if (
        readTraktGeneration(current && current.credentials) === generation &&
        currentState.status === "ready" &&
        isTokenFresh(currentToken)
      ) {
        return { ...currentToken, refreshed: true };
      }
      try {
        await failClosedTraktCredential(repository, profileId, current || claimed, attemptId);
      } catch (_persistenceError) {}
      throw tokenUnavailableError();
    }
  }
}
const CONFIGURE_TEMPLATE_PATH = path.join(__dirname, "public", "configure.html");
const CONFIGURE_TEMPLATE = fs.readFileSync(CONFIGURE_TEMPLATE_PATH, "utf8");
const RELEASE_VALIDATION_TEMPLATE = fs.readFileSync(
  path.join(__dirname, "public", "release-validation.html"),
  "utf8"
);
const CONFIGURE_TEMPLATE_TOKEN = /@@JUMPGATE_[A-Z_]+@@/g;

function renderConfigurePage(req, res, opts) {
  const options = opts || {};
  const scriptNonce = crypto.randomBytes(18).toString("base64url");
  const generated = options.generated || null;
  const pairPrefill = options.pairPrefill || null;
  const replacements = Object.freeze({
    "@@JUMPGATE_ASSET_REVISION@@": CONFIGURE_ASSET_REVISION,
    "@@JUMPGATE_BOOTSTRAP_JSON@@": safeJsonForScript({
      initial: generated,
      pairPrefill,
      managementTraktConnect: MANAGEMENT_TRAKT_CLIENT_PROTOCOL,
    }),
    "@@JUMPGATE_ERROR@@": options.error
      ? `<div class="msg err" role="alert">${escapeHtml(options.error)}</div>`
      : "",
    "@@JUMPGATE_DEPLOYMENT_STATUS@@": escapeHtml(publicationPresentation.status),
    "@@JUMPGATE_GENERATE_STEP_CLASS@@": generated ? "done" : "current",
    "@@JUMPGATE_NAME@@": escapeHtml(options.name || ""),
    "@@JUMPGATE_NOTICE@@": options.notice
      ? `<div class="msg ok" role="status">${escapeHtml(options.notice)}</div>`
      : "",
    "@@JUMPGATE_POLICY_LINKS@@": renderPublicationPolicyLinks(publicationPresentation),
    "@@JUMPGATE_SCRIPT_NONCE@@": scriptNonce,
    "@@JUMPGATE_SUBTITLE_LANGUAGES@@": escapeHtml(options.subtitleLanguages || "en"),
    "@@JUMPGATE_SUBTITLES_CHECKED@@": options.subtitlesEnabled === false ? "" : " checked",
    "@@JUMPGATE_TMDB_STATUS@@": options.tmdbKeyStored
      ? "TMDB key already stored in this private config (hidden)."
      : "If blank, the server default key is used when available.",
  });
  const html = CONFIGURE_TEMPLATE.replace(CONFIGURE_TEMPLATE_TOKEN, (token) => {
    if (!Object.prototype.hasOwnProperty.call(replacements, token)) {
      throw new Error("unknown configure template token: " + token);
    }
    return replacements[token];
  });

  setConfigurePrivacyHeaders(res, scriptNonce);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function isSyntheticReleaseValidationConfig(config) {
  const trakt = normalizeTraktTokens(config && config.trakt);
  return Boolean(
    config &&
      config.v === 2 &&
      /^[A-Za-z0-9_-]{16,64}$/.test(config.profileId || "") &&
      config.profileScope === "" &&
      config.name === "Release Validation" &&
      config.tmdbKey === "" &&
      config.upstream === "" &&
      trakt.access_token === "" &&
      trakt.refresh_token === "" &&
      trakt.token_expiry === 0 &&
      config.settings &&
      config.settings.subtitle_languages === "en" &&
      config.settings.subtitles_enabled === RELEASE_VALIDATION.vobsubFixtureEnabled &&
      config.settings.trakt_enabled === false &&
      config.settings.bridge_url === ""
  );
}

function renderReleaseValidationPage(req, res, pairCode) {
  const scriptNonce = crypto.randomBytes(18).toString("base64url");
  const profileIdentity = resolveProfileIdentity("");
  const config = encryptConfig(
    normalizeConfig({
      v: 2,
      ...profileIdentity,
      name: "Release Validation",
      tmdbKey: "",
      trakt: {},
      settings: {
        subtitle_languages: "en",
        subtitles_enabled: RELEASE_VALIDATION.vobsubFixtureEnabled,
        trakt_enabled: false,
        bridge_url: "",
      },
    })
  );
  const replacements = {
    "@@JUMPGATE_ASSET_REVISION@@": CONFIGURE_ASSET_REVISION,
    "@@JUMPGATE_SCRIPT_NONCE@@": scriptNonce,
    "@@JUMPGATE_UAT_PAIR_CODE@@": escapeHtml(pairCode || ""),
    "@@JUMPGATE_UAT_BOOTSTRAP_JSON@@": safeJsonForScript({ config }),
  };
  let html = RELEASE_VALIDATION_TEMPLATE;
  for (const [token, value] of Object.entries(replacements)) html = html.split(token).join(value);
  setConfigurePrivacyHeaders(res, scriptNonce);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function normalizeRequestTargetForLog(rawTarget) {
  const raw = String(rawTarget || "");
  // A slash-led request target is origin-form even when its path starts with //.
  // URL parsers otherwise misread the first path segment as a scheme-relative host.
  if (raw.startsWith("/")) return raw.replace(/^\/+/, "/");

  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(raw);
  if (!scheme) return raw;
  const remainder = raw.slice(scheme[0].length);
  if (!remainder.startsWith("//")) return raw;

  const leadingSlashes = /^\/+/.exec(remainder);
  if (leadingSlashes && leadingSlashes[0].length === 3) {
    return "/" + remainder.slice(3);
  }

  try {
    const target = new URL(raw);
    return target.pathname + target.search + target.hash;
  } catch (_error) {
    const authorityStart = scheme[0].length + 2;
    const pathStart = raw.indexOf("/", authorityStart);
    return pathStart < 0 ? "/" : raw.slice(pathStart);
  }
}

function normalizeUnreservedPathEncoding(rawPath) {
  return rawPath.replace(/%([A-Fa-f0-9]{2})/g, (encoded, pair) => {
    const character = String.fromCharCode(Number.parseInt(pair, 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : encoded;
  });
}

function sanitizeLogField(value, maximumLength = 512) {
  const sanitized = String(value || "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
  return sanitized.length <= maximumLength
    ? sanitized
    : sanitized.slice(0, maximumLength) + "<truncated>";
}

function redactPathForLog(rawPath) {
  const raw = normalizeRequestTargetForLog(rawPath);
  const noQuery = normalizeUnreservedPathEncoding(raw.split("?")[0].split("#")[0]);
  // Redact configured install blobs in the URL path.
  // Canonical: /_c/<config>/...
  let p = noQuery.replace(/^\/_c\/[^/]+/i, "/_c/<redacted>");
  // Legacy aliases: /<config>/...
  p = p.replace(/^\/[A-Za-z0-9_-]{40,}(?=\/)/, "/<redacted>");
  p = p.replace(/^\/p\/[^/]+/i, "/p/<redacted>");
  p = p.replace(
    /^.*?(?:\/|%2f)api(?:\/|%2f)profile(?:\/|%2f)backups(?:\/|%2f)[^/]+/i,
    "/api/profile/backups/<redacted>"
  );
  p = p.replace(
    /(\/(?:stream|subtitles)\/[^/]+\/)[^/]+\/[^/]+(?=\.json$)/gi,
    "$1<redacted>/<redacted>"
  );
  p = p.replace(/(\/(?:stream|subtitles)\/[^/]+\/)[^/]+(?=\.json|\/|$)/gi, "$1<redacted>");
  p = p.replace(/(\/meta\/)[^/]+(?=\.json|\/|$)/gi, "$1<redacted>");
  p = p.replace(/^(\/v1\/history\/)[^/]+/i, "$1<redacted>");
  p = p.replace(/^(\/api\/profile\/devices\/)[^/]+/i, "$1<redacted>");
  p = p.replace(
    /^\/v1\/subtitles\/(?!(?:discover|resolve)$).*/i,
    "/v1/subtitles/<redacted>"
  );
  return sanitizeLogField(p, 2048);
}

function safeReqUrlForLog(req) {
  const path = req.originalUrl || req.url || "";
  return redactPathForLog(path);
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", resolveTrustProxy(process.env));
app.use((req, res, next) => {
  setBaselineSecurityHeaders(res, process.env.NODE_ENV);
  if (isPublicAddonPath(req.path)) {
    setPublicAddonCors(res);
    if (req.method === "OPTIONS" && !RELEASE_VALIDATION.enabled) return res.sendStatus(204);
  }
  next();
});
if (process.env.NODE_ENV === "test") {
  app.setProviderGatewayFetchPolicyForTest = (fetchPolicy) => {
    if (storagePromise) throw new Error("storage has already initialized");
    if (!fetchPolicy || typeof fetchPolicy.fetchJson !== "function") {
      throw new TypeError("test fetch policy must provide fetchJson()");
    }
    testProviderGatewayFetchPolicy = fetchPolicy;
  };
  app.setSubtitleSourceFetchPolicyForTest = (fetchPolicy) => {
    if (storagePromise) throw new Error("storage has already initialized");
    if (!fetchPolicy || typeof fetchPolicy.fetchBuffer !== "function") {
      throw new TypeError("test subtitle source policy must provide fetchBuffer()");
    }
    testSubtitleSourceFetchPolicy = fetchPolicy;
  };
  app.setHistoryServiceForTest = (service) => {
    if (
      service !== null &&
      (!service || typeof service.get !== "function" || typeof service.put !== "function")
    ) {
      throw new TypeError("test history service must provide get() and put()");
    }
    testHistoryService = service;
  };
  app.revokeDeviceForTest = async (profileId, deviceId) => {
    await ensureStorageReady();
    return profileLifecycleService.revokeDevice(profileId, deviceId);
  };
  app.repositoriesForTest = async () => {
    await ensureStorageReady();
    return repositories();
  };
  app.subtitleDiscoveryServiceForTest = async () => {
    await ensureStorageReady();
    return subtitleDiscoveryService;
  };
  app.upsertHistoryForTest = async (profileId, entry, expectedRevision = 0) => {
    await ensureStorageReady();
    return repositories().history.upsert(profileId, entry, expectedRevision);
  };
  app.setTmdbMetaLoaderForTest = (loader) => {
    if (loader !== null && typeof loader !== "function") {
      throw new TypeError("test TMDB metadata loader must be a function");
    }
    testTmdbMetaLoader = loader;
  };
  app.getTmdbMetaForTest = getTmdbMeta;
  app.configuredStreamDisplayTimeoutMsForTest = CONFIGURED_STREAM_DISPLAY_TIMEOUT_MS;
  app.setTraktAuthCodeExchangeForTest = (exchange) => {
    if (exchange !== null && typeof exchange !== "function") {
      throw new TypeError("test Trakt auth-code exchange must be a function");
    }
    testTraktAuthCodeExchange = exchange;
  };
  app.traktApiHeadersForTest = traktApiHeaders;
  app.setTraktRefreshForTest = (refresh) => {
    if (refresh !== null && typeof refresh !== "function") {
      throw new TypeError("test Trakt refresh must be a function");
    }
    testTraktRefresh = refresh;
  };
  app.setTraktScrobbleDispatchForTest = (dispatch) => {
    if (dispatch !== null && typeof dispatch !== "function") {
      throw new TypeError("test Trakt scrobble dispatch must be a function");
    }
    testTraktScrobbleDispatch = dispatch;
  };
  app.setManagementTraktIpLaunchLimitForTest = (limit) => {
    if (limit === null) {
      managementTraktIpLaunchLimit = MANAGEMENT_TRAKT_IP_LAUNCH_LIMIT;
      return;
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) {
      throw new TypeError("test management Trakt IP launch limit is invalid");
    }
    managementTraktIpLaunchLimit = limit;
  };
  app.historyCatalogLimitsForTest = Object.freeze({
    maxMetas: CONTINUE_CATALOG_MAX_METAS,
    maxScannedRecords: HISTORY_SCAN_MAX_RECORDS,
    tmdbConcurrency: TMDB_CATALOG_CONCURRENCY,
  });
  app.mapWithConcurrencyForTest = mapWithConcurrency;
  app.redactPathForLogForTest = redactPathForLog;
  app.sanitizeLogFieldForTest = sanitizeLogField;
  app.createStorageCleanupRunnerForTest = createStorageCleanupRunner;
  app.resolvePublicationPresentationForTest = resolvePublicationPresentation;
  app.renderPublicationPolicyLinksForTest = renderPublicationPolicyLinks;
}

function asyncHandler(handler) {
  return function wrappedAsyncHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function rateLimitKey(req) {
  return normalizeIp(req.ip) || "unknown";
}

function pairActivationRateLimitKey(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const input = body.userCode || body.user_code || body.pairCode || body.pair_code || "";
  const userCode = normalizePairUserCode(input);
  if (userCode) return "code:" + userCode;
  const retryToken = body.activationRetryToken;
  if (typeof retryToken === "string") {
    try {
      return (
        "retry:" +
        storageRuntime.tokenService.hashToken("pair-activation-retry-rate-limit", retryToken)
      );
    } catch (_error) {}
  }
  return "invalid-pair-activation:" + rateLimitKey(req);
}

function pairTokenRateLimitKey(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const input = body.deviceCode || body.device_code || "";
  return normalizePairDeviceCode(input) || "invalid-device-code:" + rateLimitKey(req);
}

function hashRateLimitClientKey(clientSignal) {
  if (!storageRuntime || !storageRuntime.tokenService) {
    throw new Error("storage runtime is not ready");
  }
  return storageRuntime.tokenService.hashOpaque("rate-limit-client", clientSignal, 512);
}

function getRateLimitRepository() {
  return repositories().rateLimits;
}

const globalRateLimiter = createRateLimitMiddleware({
  scope: "http-global",
  windowMs: 60 * 1000,
  limit:
    process.env.NODE_ENV === "test" &&
    /^(?:[1-9]\d{0,5}|1000000)$/.test(process.env.JUMPGATE_TEST_GLOBAL_RATE_LIMIT || "")
      ? Number(process.env.JUMPGATE_TEST_GLOBAL_RATE_LIMIT)
      : 300,
  getRepository: getRateLimitRepository,
  keyGenerator: rateLimitKey,
  hashClientKey: hashRateLimitClientKey,
  // Pairing uses polling by design; route-level limiters below handle it.
  skip: (req) =>
    String(req.path || "").startsWith("/pair/") ||
    (req.method === "POST" && req.path === "/api/profile/trakt/connect"),
  message: "Rate limit exceeded. Please retry in a moment.",
});

const pairIpAbuseRateLimiter = createRateLimitMiddleware({
  scope: "pair-ip-abuse",
  windowMs: 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 10000 : 3000,
  getRepository: getRateLimitRepository,
  keyGenerator: rateLimitKey,
  hashClientKey: hashRateLimitClientKey,
  message: "Pairing traffic is temporarily rate-limited. Please retry shortly.",
});

const pairCodeRateLimiter = createRateLimitMiddleware({
  scope: "pair-device-code",
  windowMs: 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 10000 : 120,
  getRepository: getRateLimitRepository,
  keyGenerator: rateLimitKey,
  hashClientKey: hashRateLimitClientKey,
  message: "Too many pair code requests. Please wait a minute and try again.",
});

const pairActivateRateLimiter = createRateLimitMiddleware({
  scope: "pair-activate",
  windowMs: 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 10000 : 40,
  getRepository: getRateLimitRepository,
  keyGenerator: pairActivationRateLimitKey,
  hashClientKey: hashRateLimitClientKey,
  message: "Too many pairing attempts. Please retry shortly.",
});

const pairTokenRateLimiter = createRateLimitMiddleware({
  scope: "pair-device-token",
  windowMs: 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 10000 : 300,
  getRepository: getRateLimitRepository,
  keyGenerator: pairTokenRateLimitKey,
  hashClientKey: hashRateLimitClientKey,
  message: "Pair polling is temporarily rate-limited. Please retry shortly.",
});

if (process.env.NODE_ENV === "test") {
  app.getPairRateLimitSignalsForTest = (req) => ({
    activation: pairActivationRateLimitKey(req),
    token: pairTokenRateLimitKey(req),
  });
}

app.get("/health/live", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, status: "live" });
});

app.get("/health/ready", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    await ensureStorageReady();
    if (!storageRuntime || typeof storageRuntime.healthCheck !== "function") {
      throw new Error("storage runtime health check is unavailable");
    }
    await storageRuntime.healthCheck();
    return res.json({ ok: true, status: "ready" });
  } catch (_error) {
    return res.status(503).json({ ok: false, status: "not_ready" });
  }
});

app.use(
  asyncHandler(async (_req, _res, next) => {
    await ensureStorageReady();
    next();
  })
);

app.use(globalRateLimiter);

app.use((req, _res, next) => {
  const requestTarget = safeReqUrlForLog(req).replace(/\r|\n/g, "");
  console.log("[REQ] " + req.method + " " + requestTarget);
  next();
});

if (RELEASE_VALIDATION.enabled) {
  app.use((req, res, next) => {
    const exact = new Map([
      ["GET /", true],
      ["GET /configure", true],
      ["GET /favicon.ico", true],
      ["GET /version", true],
      ["POST /pair/device/code", true],
      ["POST /pair/device/token", true],
      ["POST /pair/activate", true],
    ]);
    const key = req.method + " " + req.path;
    const fixtureConfiguredRoute =
      RELEASE_VALIDATION.vobsubFixtureEnabled &&
      (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") &&
      (/^\/_c\/[A-Za-z0-9_-]{16,4096}\/(?:manifest\.json|stream\/movie\/jumpgate-uat-vobsub-v1\.json|subtitles\/movie\/jumpgate-uat-vobsub-v1(?:\/filename(?:=|%3D)jumpgate-uat-vobsub-v1\.mp4)?\.json)$/i.test(req.path) ||
        /^\/_c\/[A-Za-z0-9_-]{16,4096}\/uat-vobsub\/(?:manifest\.json|stream\/movie\/jumpgate-uat-vobsub-v1\.json|subtitles\/movie\/jumpgate-uat-vobsub-v1(?:\/filename(?:=|%3D)jumpgate-uat-vobsub-v1\.mp4)?\.json|media\/jumpgate-uat-vobsub-v1\.mp4|subtitles\/jumpgate-uat-vobsub-v1\.zip)$/i.test(req.path));
    const fixtureCatalogRoute =
      RELEASE_VALIDATION.vobsubFixtureEnabled &&
      (req.method === "GET" || req.method === "OPTIONS") &&
      /^\/_c\/[A-Za-z0-9_-]{16,4096}\/catalog\/movie\/jumpgate-uat-vobsub\.json$/.test(req.path);
    const fixtureDeviceRoute =
      RELEASE_VALIDATION.vobsubFixtureEnabled &&
      ((req.method === "POST" && [
        "/v1/playback/claim",
        "/v1/playback/release",
        "/v1/subtitles/discover",
        "/v1/subtitles/resolve",
        "/v1/history/events",
      ].includes(req.path)) ||
        ((req.method === "GET" || req.method === "HEAD") &&
          /^\/v1\/subtitles\/[A-Za-z0-9_-]{8,128}\/[A-Za-z0-9_-]{8,256}\/[12]\/[a-f0-9]{64}\.(?:idx|sub)$/.test(req.path)));
    const fixtureManagementRoute =
      RELEASE_VALIDATION.vobsubFixtureEnabled &&
      req.method === "DELETE" &&
      req.path === "/api/profile";
    if (
      exact.has(key) ||
      fixtureConfiguredRoute ||
      fixtureCatalogRoute ||
      fixtureDeviceRoute ||
      fixtureManagementRoute ||
      (req.method === "GET" && /^\/(?:assets|p)\//.test(req.path))
    ) {
      return next();
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).json({ ok: false, error: "not_found" });
  });
  app.use((req, res, next) => {
    if (req.method === "OPTIONS" && isPublicAddonPath(req.path)) return res.sendStatus(204);
    next();
  });
}

async function requireDeviceAuth(req, res, next) {
  const token = getBearerToken(req);
  const device = token ? await pairingCoordinator.authenticate(token) : null;
  let profile = null;
  let historyGeneration = null;
  let playbackGeneration = null;
  if (device && device.id && device.profileId) {
    profile = await repositories().profiles.getById(device.profileId);
    if (profile && profile.status === "active") {
      [historyGeneration, playbackGeneration] = await Promise.all([
        repositories().history.getGeneration(device.profileId),
        repositories().playbackContexts.getProfileGeneration(device.profileId),
      ]);
    }
  }
  if (
    !device ||
    !device.id ||
    !device.profileId ||
    !Number.isSafeInteger(device.generation) ||
    device.generation < 1 ||
    !profile ||
    profile.status !== "active" ||
    historyGeneration === null ||
    typeof playbackGeneration !== "string"
  ) {
    if (!res.hasHeader("Cache-Control")) res.setHeader("Cache-Control", "no-store");
    return res.status(401).json({ ok: false, error: "device_auth_required" });
  }
  req.deviceBinding = {
    deviceId: device.id,
    deviceGeneration: device.generation,
    profileId: device.profileId,
    profileRevision: profile.revision,
    historyGeneration,
    playbackGeneration,
  };
  next();
}

function isDeviceDisclosureFenceError(error) {
  return Boolean(
    error &&
      (error.code === "profile_generation_changed" ||
        error.code === "device_generation_changed" ||
        error.code === "profile_inactive")
  );
}

async function commitDeviceResponse(binding, res, prepared, signal = null) {
  const response = normalizePreparedHttpResponse(prepared);
  await profileLifecycleService.commitDisclosure(binding, () => {
    if (signal && signal.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      const error = new Error("device response was aborted");
      error.name = "AbortError";
      throw error;
    }
    res.statusCode = response.status;
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value);
    }
    res.end(response.body);
  });
}

async function commitDeviceHeadResponse(binding, res, prepared, signal = null) {
  const response = normalizePreparedHttpHeadResponse(prepared);
  await profileLifecycleService.commitDisclosure(binding, () => {
    if (signal && signal.aborted) {
      if (signal.reason instanceof Error) throw signal.reason;
      const error = new Error("device response was aborted");
      error.name = "AbortError";
      throw error;
    }
    res.statusCode = response.status;
    for (const [name, value] of Object.entries(response.headers)) {
      res.setHeader(name, value);
    }
    res.end();
  });
}

function sendDeviceDisclosureFenceFailure(res) {
  if (res.headersSent) return;
  return res.status(409).json({ ok: false, error: "device_generation_changed" });
}

function setHistoryResponseHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function sendHistoryError(res, error) {
  if (
    error &&
    (
      error.code === "history_generation_changed" ||
      error.code === "device_generation_changed" ||
      error.code === "profile_generation_changed" ||
      error.code === "profile_inactive"
    )
  ) {
    return res.status(409).json({ ok: false, error: "history_generation_changed" });
  }
  if (
    error &&
    (error.code === "history_conflict" || error.code === "history_identity_conflict")
  ) {
    return res.status(409).json({ ok: false, error: error.code });
  }
  if (
    error &&
    error.status === 400 &&
    (error.code === "invalid_content_key" || error.code === "invalid_history_request")
  ) {
    return res.status(400).json({ ok: false, error: error.code });
  }
  throw error;
}

function sendHistoryGrantFailure(res, error) {
  if (isDeviceDisclosureFenceError(error)) return sendDeviceDisclosureFenceFailure(res);
  const code = error && typeof error.code === "string" ? error.code : "";
  if (code === "history_grant_required" || code === "history_grant_invalid") {
    return res.status(401).json({ ok: false, error: code });
  }
  if (
    code === "invalid_playback_claim" ||
    code === "invalid_history_event" ||
    code === "invalid_idempotency_key"
  ) {
    return res.status(400).json({ ok: false, error: code });
  }
  if (
    code === "history_claim_conflict" ||
    code === "history_event_idempotency_conflict" ||
    code === "history_grant_released" ||
    code === "history_grant_stale" ||
    code === "history_session_stale" ||
    code === "history_terminal_receipt_required" ||
    code === "playback_generation_changed" ||
    code === "profile_generation_changed" ||
    code === "device_generation_changed"
  ) {
    return res.status(409).json({ ok: false, error: code });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return res.status(400).json({ ok: false, error: "invalid_history_request" });
  }
  throw error;
}

function sendLegacyLifecycleGone(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return res.status(410).json({ ok: false, error: "history_grant_required" });
}

function sendLegacyIdentityGone(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  return res.status(410).json({ ok: false, error: "source_claim_required" });
}

app.post("/v1/trakt/scrobble/:event", (_req, res) => sendLegacyLifecycleGone(res));

app.get(
  "/v1/history/:contentKey",
  setHistoryResponseHeaders,
  asyncHandler(requireDeviceAuth),
  asyncHandler(async (req, res) => {
    try {
      const history = await activeHistoryService().get(req.deviceBinding, req.params.contentKey);
      const prepared = history
        ? preparedJsonResponse(200, history)
        : preparedJsonResponse(404, { ok: false, error: "history_not_found" });
      await commitDeviceResponse(req.deviceBinding, res, prepared);
      return;
    } catch (error) {
      return sendHistoryError(res, error);
    }
  })
);

app.put("/v1/history/:contentKey", (_req, res) => sendLegacyLifecycleGone(res));

app.delete("/v1/history/:contentKey", (_req, res) => sendLegacyLifecycleGone(res));

app.post(
  "/v1/history/events",
  setHistoryResponseHeaders,
  asyncHandler(requireDeviceAuth),
  express.raw({ type: "application/json", limit: "12kb" }),
  asyncHandler(async (req, res) => {
    res.setHeader("Pragma", "no-cache");
    try {
      const result = await claimBoundHistoryService.applyEvent(
        req.deviceBinding,
        req.headers,
        req.body
      );
      const prepared = getPreparedHttpResponse(result);
      if (!prepared) throw new Error("history event response receipt is unavailable");
      await commitDeviceResponse(req.deviceBinding, res, prepared);
    } catch (error) {
      return sendHistoryGrantFailure(res, error);
    }
  })
);

function secureCookieForRequest(req) {
  if (isProductionLikeEnvironment(process.env.NODE_ENV)) return true;
  try {
    return new URL(getPublicBaseUrl(req)).protocol === "https:";
  } catch (_error) {
    return false;
  }
}

async function requireManagementAuth(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  if (!isAllowedRequestOrigin(req)) {
    return res.status(403).json({ ok: false, error: "origin_not_allowed" });
  }
  const sessionToken = getCookie(req, MANAGEMENT_SESSION_COOKIE);
  const csrfToken =
    typeof req.headers["x-jumpgate-csrf"] === "string"
      ? req.headers["x-jumpgate-csrf"].trim()
      : "";
  const binding =
    sessionToken && csrfToken
      ? await repositories().managementSessions.authenticate(sessionToken, csrfToken)
      : null;
  const profile = binding && binding.profileId
    ? await repositories().profiles.getById(binding.profileId)
    : null;
  if (
    !binding ||
    !binding.profileId ||
    !Number.isSafeInteger(binding.managementGeneration) ||
    binding.managementGeneration < 0 ||
    !profile ||
    profile.status !== "active"
  ) {
    return res.status(401).json({ ok: false, error: "management_auth_required" });
  }
  req.managementBinding = {
    profileId: binding.profileId,
    managementGeneration: binding.managementGeneration,
    sessionToken,
    expiresAt: binding.expiresAt,
  };
  next();
}

app.post(
  "/v1/playback/claim",
  asyncHandler(requireDeviceAuth),
  express.raw({ type: "application/json", limit: "8kb" }),
  asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const abort = requestAbortSignal(req, res);
    const binding = req.deviceBinding;
    const profileLogHash = crypto
      .createHash("sha256")
      .update(binding.profileId, "utf8")
      .digest("hex")
      .slice(0, 12);
    let result = null;
    try {
      try {
        result = await claimBoundHistoryService.claim(
          binding,
          req.body,
          { signal: abort.signal }
        );
      } catch (error) {
        if (abort.signal.aborted) return;
        if (
          error &&
          (error.code === "profile_generation_changed" || error.code === "device_generation_changed")
        ) {
          return res.status(409).json({ ok: false, error: "playback_generation_changed" });
        }
        if (error && error.code === "playback_claim_deadline") {
          return res.status(503).json({ ok: false, error: "playback_claim_unavailable" });
        }
        if (
          error &&
          (error.code === "history_claim_conflict" || error.code === "claim_request_conflict")
        ) {
          return res.status(409).json({ ok: false, error: error.code });
        }
        if (!(error instanceof TypeError)) throw error;
        console.log("[context:claim] status=invalid profile=" + profileLogHash);
        return res.status(400).json({ ok: false, error: "invalid_claim_request" });
      }

      if (abort.signal.aborted) {
        await claimBoundHistoryService.abandonClaimDelivery(binding, result);
        return;
      }
      if (result && result.status === "claimed" && typeof result.sessionId === "string") {
        const active = await repositories().playbackContexts.getActiveClaim(
          binding.profileId,
          binding.deviceId,
          result.sessionId
        );
        if (!active) throw new Error("active playback claim is unavailable");
        const supersededSessionId = active && active.deliveryBinding &&
          active.deliveryBinding.supersededSessionId;
        if (supersededSessionId) {
          await repositories().subtitleDeliveries.invalidateSession(
            binding.profileId,
            supersededSessionId
          );
        }
      }
      if (abort.signal.aborted) {
        await claimBoundHistoryService.abandonClaimDelivery(binding, result);
        return;
      }
      const replay = getPreparedHttpResponse(result);
      const publicResult = replay
        ? null
        : {
            ...projectPublicPlaybackClaim(result, binding.profileId),
            sessionRevision: result.sessionRevision,
            historyGrant: result.historyGrant,
            historyGrantKind: result.historyGrantKind,
          };
      const prepared = await claimBoundHistoryService.commitClaimResponse(
        result,
        replay || preparedJsonResponse(200, publicResult, {
          "cache-control": "no-store",
          pragma: "no-cache",
        })
      );
      console.log("[context:claim] status=" + result.status + " profile=" + profileLogHash);
      const disclosed = await claimBoundHistoryService.commitClaimDisclosure(binding, result);
      if (!disclosed) {
        const error = new Error("playback claim disclosure authority changed");
        error.code = "device_generation_changed";
        throw error;
      }
      await commitDeviceResponse(binding, res, prepared, abort.signal);
      return;
    } catch (error) {
      try {
        await claimBoundHistoryService.abandonClaimDelivery(binding, result);
      } catch (cleanupError) {
        console.error("[context:claim] delivery cleanup failed profile=" + profileLogHash);
        error = new AggregateError(
          [error, cleanupError],
          "playback claim response failed and its delivery lease could not be abandoned"
        );
      }
      if (abort.signal.aborted) return;
      if (isDeviceDisclosureFenceError(error)) {
        return sendDeviceDisclosureFenceFailure(res);
      }
      console.error("[context:claim] finalization failed profile=" + profileLogHash);
      return res.status(503).json({ ok: false, error: "playback_claim_unavailable" });
    } finally {
      abort.cleanup();
    }
  })
);

app.post(
  "/v1/playback/release",
  asyncHandler(requireDeviceAuth),
  express.json({ limit: "1kb" }),
  asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const binding = req.deviceBinding;
    const profileLogHash = crypto
      .createHash("sha256")
      .update(binding.profileId, "utf8")
      .digest("hex")
      .slice(0, 12);
    try {
      const sessionId = req.body && req.body.sessionId;
      if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) {
        throw new TypeError("sessionId is invalid");
      }
      const terminalReceiptId = assertCanonicalUuid(
        req.body && req.body.terminalReceiptId,
        "terminalReceiptId",
        "history_terminal_receipt_required"
      );
      const released = await claimBoundHistoryService.release(
        binding,
        sessionId,
        terminalReceiptId
      );
      if (released) {
        await repositories().subtitleDeliveries.invalidateRelease(
          binding.profileId,
          binding.deviceId,
          sessionId
        );
        await repositories().playbackContexts.release(
          binding.profileId,
          binding.deviceId,
          sessionId
        );
      }
      console.log(
        "[context:release] status=" +
          (released ? "released" : "not_found") +
          " profile=" +
          profileLogHash
      );
      await commitDeviceResponse(
        binding,
        res,
        preparedJsonResponse(200, { status: released ? "released" : "not_found" })
      );
    } catch (error) {
      if (isDeviceDisclosureFenceError(error)) {
        return sendDeviceDisclosureFenceFailure(res);
      }
      if (error && error.code === "history_terminal_receipt_required") {
        return res.status(409).json({ ok: false, error: error.code });
      }
      if (!(error instanceof TypeError)) throw error;
      console.log("[context:release] status=invalid profile=" + profileLogHash);
      res.status(400).json({ ok: false, error: "invalid_release_request" });
    }
  })
);

function setSubtitleResponseHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Content-Encoding", "identity");
  next();
}

function sendSubtitleNotFound(res) {
  return res.status(404).json({ ok: false, error: "not_found" });
}

function sendSubtitleRequestFailure(res, error) {
  if (error instanceof TypeError || error instanceof RangeError) {
    return res.status(400).json({ ok: false, error: "invalid_subtitle_request" });
  }
  if (error && [
    "subtitle_delivery_busy",
    "subtitle_fetch_busy",
    "subtitle_upload_busy",
  ].includes(error.code)) {
    const supplied = Number.isSafeInteger(error.retryAfterSeconds)
      ? error.retryAfterSeconds
      : 1;
    const retryAfter = Math.min(60, Math.max(1, supplied));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(409).json({ ok: false, error: "subtitle_busy" });
  }
  if (error && error.code === "subtitle_source_unavailable") {
    return res.status(502).json({ ok: false, error: "subtitle_source_unavailable" });
  }
  if (error && error.code === "subtitle_payload_rejected") {
    return res.status(422).json({ ok: false, error: "subtitle_payload_rejected" });
  }
  throw error;
}

app.post(
  "/v1/subtitles/discover",
  setSubtitleResponseHeaders,
  asyncHandler(requireDeviceAuth),
  express.json({ limit: "2kb" }),
  asyncHandler(async (req, res) => {
    const abort = requestAbortSignal(req, res);
    const deviceScope = req.deviceBinding;
    try {
      const result = await subtitleDiscoveryService.discover(deviceScope, {
        ...(req.body || {}),
        signal: abort.signal,
      });
      const prepared = result
        ? preparedJsonResponse(200, result)
        : preparedJsonResponse(404, { ok: false, error: "not_found" });
      await commitDeviceResponse(req.deviceBinding, res, prepared);
      return;
    } catch (error) {
      if (abort.signal.aborted) return;
      if (isDeviceDisclosureFenceError(error)) return sendDeviceDisclosureFenceFailure(res);
      return sendSubtitleRequestFailure(res, error);
    } finally {
      abort.cleanup();
    }
  })
);

app.post(
  "/v1/subtitles/resolve",
  setSubtitleResponseHeaders,
  asyncHandler(requireDeviceAuth),
  express.json({ limit: "2kb" }),
  asyncHandler(async (req, res) => {
    const abort = requestAbortSignal(req, res);
    const deviceScope = req.deviceBinding;
    let result = null;
    try {
      result = await subtitleDiscoveryService.resolve(deviceScope, {
        ...(req.body || {}),
        signal: abort.signal,
      });
      const prepared = result
        ? preparedJsonResponse(200, result)
        : preparedJsonResponse(404, { ok: false, error: "not_found" });
      await commitDeviceResponse(req.deviceBinding, res, prepared);
      return;
    } catch (error) {
      if (result && typeof result.artifactId === "string") {
        try {
          await subtitleDeliveryService.invalidate(
            {
              profileId: deviceScope.profileId,
              deviceId: deviceScope.deviceId,
              sessionId: req.body && req.body.sessionId,
            },
            result.artifactId,
            "terminal_disclosure_rejected"
          );
        } catch (cleanupError) {
          if (error && (typeof error === "object" || typeof error === "function")) {
            try {
              Object.defineProperty(error, "cleanupError", {
                configurable: true,
                enumerable: false,
                value: cleanupError,
              });
            } catch (_ignored) {
              // The terminal disclosure failure remains authoritative.
            }
          }
        }
      }
      if (abort.signal.aborted) return;
      if (isDeviceDisclosureFenceError(error)) return sendDeviceDisclosureFenceFailure(res);
      return sendSubtitleRequestFailure(res, error);
    } finally {
      abort.cleanup();
    }
  })
);

async function subtitleReadHandler(req, res) {
  const abort = requestAbortSignal(req, res);
  try {
    const range = req.get("Range");
    if (range !== undefined && range !== "bytes=0-") {
      return res.status(416).json({ ok: false, error: "invalid_range" });
    }
    let partNumber = NaN;
    if (/^[1-9]\d*$/.test(String(req.params.partNumber || ""))) {
      partNumber = Number(req.params.partNumber);
    }
    const result = await subtitleDiscoveryService.read(
      {
        profileId: req.deviceBinding.profileId,
        deviceId: req.deviceBinding.deviceId,
      },
      {
        sessionId: req.params.sessionId,
        artifactId: req.params.artifactId,
        partNumber,
        fileName: req.params.fileName,
        method: req.method,
        signal: abort.signal,
      }
    );
    if (!result) {
      await commitDeviceResponse(
        req.deviceBinding,
        res,
        preparedJsonResponse(404, { ok: false, error: "not_found" })
      );
      return;
    }
    const ownedBody = Buffer.isBuffer(result.body) ? result.body : null;
    const body = req.method === "HEAD" ? null : ownedBody;
    let cleared = false;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      if (ownedBody) ownedBody.fill(0);
    };
    res.once("finish", clear);
    res.once("close", clear);
    try {
      const prepared = {
        status: 200,
        headers: {
          "Content-Type": result.mediaType,
          "Content-Length": String(result.sizeBytes),
          "Content-Disposition": "inline; filename=\"" + req.params.fileName + "\"",
        },
      };
      if (req.method === "HEAD") {
        await commitDeviceHeadResponse(req.deviceBinding, res, prepared);
      } else {
        await commitDeviceResponse(req.deviceBinding, res, {
          ...prepared,
          body,
        });
      }
      return;
    } catch (error) {
      clear();
      throw error;
    }
  } catch (error) {
    if (abort.signal.aborted) return;
    if (isDeviceDisclosureFenceError(error)) return sendDeviceDisclosureFenceFailure(res);
    if (error instanceof TypeError || error instanceof RangeError ||
        (error && [
          "authority_conflict",
          "authority_stale",
          "subtitle_authorization_changed",
          "subtitle_delivery_changed",
        ].includes(error.code))) {
      return sendSubtitleNotFound(res);
    }
    throw error;
  } finally {
    abort.cleanup();
  }
}

const subtitleReadPath = "/v1/subtitles/:sessionId/:artifactId/:partNumber/:fileName";
app.head(
  subtitleReadPath,
  setSubtitleResponseHeaders,
  asyncHandler(requireDeviceAuth),
  asyncHandler(subtitleReadHandler)
);
app.get(
  subtitleReadPath,
  setSubtitleResponseHeaders,
  asyncHandler(requireDeviceAuth),
  asyncHandler(subtitleReadHandler)
);

function createStorageCleanupRunner(options) {
  if (
    !options ||
    typeof options.runEveryPass !== "function" ||
    typeof options.runDurableCleanup !== "function" ||
    typeof options.onPassError !== "function" ||
    typeof options.onTimerError !== "function"
  ) {
    throw new TypeError("storage cleanup runner options are invalid");
  }
  let activePromise = null;
  let timerObserverCount = 0;

  function reportSafely(callback, error) {
    try {
      return Promise.resolve(callback(error)).catch(() => {});
    } catch (_error) {
      return Promise.resolve();
    }
  }

  function runEveryPassSafely() {
    try {
      return Promise.resolve(options.runEveryPass()).catch((error) =>
        reportSafely(options.onPassError, error)
      );
    } catch (error) {
      return reportSafely(options.onPassError, error);
    }
  }

  function getOrStartDurableCleanup() {
    if (activePromise) return { promise: activePromise, started: false };
    const operation = Promise.resolve().then(options.runDurableCleanup);
    let trackedPromise;
    trackedPromise = operation.finally(() => {
      if (activePromise === trackedPromise) activePromise = null;
    });
    activePromise = trackedPromise;
    return { promise: trackedPromise, started: true };
  }

  function run() {
    const passPromise = runEveryPassSafely();
    const durable = getOrStartDurableCleanup();
    return Promise.all([passPromise, durable.promise]).then(() => undefined);
  }

  function runTimerPass() {
    const passPromise = runEveryPassSafely();
    const durable = getOrStartDurableCleanup();
    if (!durable.started) return passPromise.then(() => undefined);

    timerObserverCount = 1;
    return Promise.all([passPromise, durable.promise])
      .catch((error) => reportSafely(options.onTimerError, error))
      .finally(() => {
        timerObserverCount = 0;
      });
  }

  return {
    getActivePromise: () => activePromise,
    getState: () => ({
      durableCleanupActive: activePromise !== null,
      timerObserverCount,
    }),
    run,
    runTimerPass,
  };
}

function runEveryStorageCleanupPass() {
  const nowMs = Date.now();
  for (const [imdb, meta] of metaCache) {
    if (nowMs - meta.ts > META_CACHE_TTL) metaCache.delete(imdb);
  }
  if (providerGatewayService) providerGatewayService.pruneCache();
}

async function runDurableStorageCleanup() {
  if (!storageRepositories) return;
  if (profileLifecycleService) {
    await runDurableCleanupStep(
      async () => {
        const result = await profileLifecycleService.resumeInvalidations(8);
        if (result.failed > 0) throw new Error("lifecycle invalidation retry failed");
      },
      "[storage:lifecycle-invalidations] cleanup failed"
    );
    await runDurableCleanupStep(
      async () => {
        const result = await profileLifecycleService.resumePending(8);
        if (result.failed > 0) throw new Error("profile erasure retry failed");
      },
      "[storage:profile-erasures] cleanup failed"
    );
  }
  await runDurableCleanupStep(
    () => storageRepositories.playbackContexts.prune(),
    "[storage:playback-contexts] prune failed"
  );
  await runDurableCleanupStep(
    () => storageRepositories.historyGrants.prune(),
    "[storage:history-grants] prune failed"
  );
  await runDurableCleanupStep(
    () => storageRepositories.subtitleDeliveries.prune(),
    "[storage:subtitle-deliveries] prune failed"
  );
  if (subtitleDeletionWorker) {
    await runDurableCleanupStep(
      () => subtitleDeletionWorker.runUntilIdle({ maxJobs: 8 }),
      "[storage:subtitle-deletions] cleanup failed"
    );
  }
}

async function runDurableCleanupStep(operation, failureMessage) {
  try {
    await operation();
  } catch (_error) {
    try {
      console.error(failureMessage);
    } catch (_logError) {
      // One failed cleanup step or diagnostic must not suppress later steps.
    }
  }
}

const storageCleanupRunner = createStorageCleanupRunner({
  runEveryPass: runEveryStorageCleanupPass,
  runDurableCleanup: runDurableStorageCleanup,
  onPassError() {
    console.error("[storage:in-process-cache] prune failed");
  },
  onTimerError() {
    console.error("[storage:cleanup] timer pass failed");
  },
});

async function ensureSyntheticUatProvider(profileId, configBlob, publicBaseUrl) {
  if (!RELEASE_VALIDATION.vobsubFixtureEnabled) return null;
  const visible = await providerImportService.list(profileId);
  if (visible.revision === 0 && visible.providers.length === 0) {
    try {
      return await providerImportService.import(profileId, {
        expectedRevision: 0,
        descriptors: [UAT_VOBSUB_FIXTURE.descriptor(publicBaseUrl, configBlob)],
      });
    } catch (error) {
      if (!isRevisionConflict(error)) throw error;
    }
  }
  return assertSyntheticUatProvider(profileId, configBlob, publicBaseUrl);
}

async function assertSyntheticUatProvider(profileId, configBlob, publicBaseUrl) {
  if (!RELEASE_VALIDATION.vobsubFixtureEnabled) return null;
  const visible = await providerImportService.list(profileId);
  const stored = await repositories().providers.list(profileId);
  if (
    visible.revision === 1 &&
    visible.providers.length === 1 &&
    stored.revision === 1 &&
    stored.providers.length === 1 &&
    UAT_VOBSUB_FIXTURE.isExactDescriptor(
      stored.providers[0].descriptor,
      publicBaseUrl,
      configBlob
    )
  ) {
    return visible;
  }
  const error = new Error("synthetic UAT provider collection is not exact");
  error.code = "synthetic_provider_collection_invalid";
  throw error;
}

function runStorageCleanup() {
  return storageCleanupRunner.run();
}

function runStorageCleanupTimerPass() {
  return storageCleanupRunner.runTimerPass();
}

// Durable cleanup coalesces, but every timer callback still prunes in-process caches.
const cleanupTimer = setInterval(() => {
  void runStorageCleanupTimerPass();
}, 30000);
cleanupTimer.unref();

app.get("/", (_req, res) => res.redirect("/configure"));

app.get("/favicon.ico", (_req, res) => res.status(204).end());

const CONFIGURE_ASSETS = new Map(
  [
    ["configure.css", { contentType: "text/css; charset=utf-8", maxAge: 300 }],
    ["configure.js", { contentType: "application/javascript; charset=utf-8", maxAge: 300 }],
    ["release-validation.js", { contentType: "application/javascript; charset=utf-8", maxAge: 300 }],
    ["stremio-account-client.js", { contentType: "application/javascript; charset=utf-8", maxAge: 300 }],
    ["jumpgate-mark.svg", { contentType: "image/svg+xml; charset=utf-8", maxAge: 86400, publicMedia: true }],
    ["jumpgate-mark.png", { contentType: "image/png", maxAge: 86400, publicMedia: true }],
    ["jumpgate-backdrop.svg", { contentType: "image/svg+xml; charset=utf-8", maxAge: 86400, publicMedia: true }],
    ["jumpgate-backdrop.jpg", { contentType: "image/jpeg", maxAge: 86400, publicMedia: true }],
    ["trakt-lockup-negative.svg", { contentType: "image/svg+xml; charset=utf-8", maxAge: 86400 }],
    ["Trakt-BRANDING.txt", { contentType: "text/plain; charset=utf-8", maxAge: 86400 }],
    ["RobotoCondensed-Variable.ttf", { contentType: "font/ttf", maxAge: 86400 }],
    ["RobotoCondensed-OFL.txt", { contentType: "text/plain; charset=utf-8", maxAge: 86400 }],
    ["Oxanium-Variable.ttf", { contentType: "font/ttf", maxAge: 86400 }],
    ["Oxanium-OFL.txt", { contentType: "text/plain; charset=utf-8", maxAge: 86400 }],
    ["SourceSans3-Variable.ttf", { contentType: "font/ttf", maxAge: 86400 }],
    ["SourceSans3-OFL.txt", { contentType: "text/plain; charset=utf-8", maxAge: 86400 }],
  ].map(([fileName, asset]) => [
    fileName,
    Object.freeze({
      ...asset,
      absolutePath: path.join(__dirname, "public", fileName),
    }),
  ])
);

app.get("/assets/:asset", (req, res, next) => {
  const asset = CONFIGURE_ASSETS.get(req.params.asset);
  if (!asset) return next();
  res.setHeader("Cache-Control", "public, max-age=" + asset.maxAge);
  res.setHeader("Cross-Origin-Resource-Policy", asset.publicMedia ? "cross-origin" : "same-origin");
  if (asset.publicMedia) res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", asset.contentType);
  res.sendFile(asset.absolutePath);
});

app.get("/p/:code", (req, res) => {
  const pairCode = formatPairUserCode(req.params.code || "");
  if (!pairCode) return res.redirect("/configure");
  const pairExpiresAt =
    typeof req.query.pairExpiresAt === "string" ? req.query.pairExpiresAt : 0;
  return res.redirect(buildPairPrefillUrl(req, pairCode, pairExpiresAt));
});

app.get("/configure", (req, res) => {
  const queryConfig = typeof req.query.config === "string" ? req.query.config : "";
  const queryNotice = typeof req.query.notice === "string" ? req.query.notice : "";
  const queryError = typeof req.query.error === "string" ? req.query.error : "";
  const queryPairCode =
    typeof req.query.pairCode === "string"
      ? req.query.pairCode
      : typeof req.query.pair === "string"
      ? req.query.pair
      : "";
  if (RELEASE_VALIDATION.enabled) {
    return renderReleaseValidationPage(req, res, formatPairUserCode(queryPairCode));
  }
  const queryPairExpiresAt =
    typeof req.query.pairExpiresAt === "string"
      ? req.query.pairExpiresAt
      : typeof req.query.expiresIn === "string"
      ? req.query.expiresIn
      : 0;

  let generated = null;
  let prefillName = "";
  let prefillTmdbKeyStored = false;
  let prefillSubtitleLanguages = "en";
  let prefillSubtitlesEnabled = true;

  if (queryConfig) {
    try {
      const decoded = decryptConfig(queryConfig);
      generated = {
        config: queryConfig,
        name: decoded.name || "",
        traktLinked: Boolean(decoded.trakt && decoded.trakt.refresh_token),
        tmdbKeyStored: Boolean(decoded.tmdbKey),
        subtitleLanguages:
          decoded.settings && typeof decoded.settings.subtitle_languages === "string"
            ? decoded.settings.subtitle_languages
            : "en",
        subtitlesEnabled:
          decoded.settings && typeof decoded.settings.subtitles_enabled === "boolean"
            ? decoded.settings.subtitles_enabled
            : true,
      };
      prefillName = decoded.name || "";
      prefillTmdbKeyStored = Boolean(decoded.tmdbKey);
      prefillSubtitleLanguages =
        decoded.settings && typeof decoded.settings.subtitle_languages === "string"
          ? decoded.settings.subtitle_languages
          : "en";
      prefillSubtitlesEnabled =
        decoded.settings && typeof decoded.settings.subtitles_enabled === "boolean"
          ? decoded.settings.subtitles_enabled
          : true;
    } catch (_err) {
      // ignore malformed query config
    }
  }

  const pairPrefill = buildPairPrefillPayload(queryPairCode, queryPairExpiresAt, req);

  renderConfigurePage(req, res, {
    name: prefillName,
    tmdbKeyStored: prefillTmdbKeyStored,
    subtitleLanguages: prefillSubtitleLanguages,
    subtitlesEnabled: prefillSubtitlesEnabled,
    pairPrefill,
    generated,
    notice: queryNotice,
    error: queryError,
  });
});

app.post("/configure/generate", express.json({ limit: "8kb" }), (req, res) => {
  if (RELEASE_VALIDATION.enabled) return res.status(404).json({ ok: false, error: "not_found" });
  try {
    const name = String(req.body && req.body.name ? req.body.name : "").trim().slice(0, 64);
    const tmdbKey = normalizeTmdbKeyInput(req.body && req.body.tmdbKey ? req.body.tmdbKey : "");
    const subtitleLanguages = normalizeSubtitleLanguagesInput(
      req.body && req.body.settings && req.body.settings.subtitle_languages
        ? req.body.settings.subtitle_languages
        : "en"
    );
    const subtitlesEnabled = normalizeBooleanInput(
      req.body && req.body.settings ? req.body.settings.subtitles_enabled : undefined,
      true
    );
    const pairPrefill = buildPairPrefillPayload(
      req.body && req.body.pairCode ? req.body.pairCode : "",
      req.body && req.body.pairExpiresAt ? req.body.pairExpiresAt : 0,
      req
    );
    const profileIdentity = resolveProfileIdentity(
      req.body && typeof req.body.existingConfig === "string" ? req.body.existingConfig : ""
    );

    const config = normalizeConfig({
      v: 2,
      ...profileIdentity,
      name,
      tmdbKey,
      trakt: {},
      settings: {
        subtitle_languages: subtitleLanguages,
        subtitles_enabled: subtitlesEnabled,
      },
    });
    const blob = encryptConfig(config);

    res.json({
      ok: true,
      config: blob,
      name,
      traktLinked: false,
      tmdbKeyStored: Boolean(tmdbKey),
      subtitleLanguages,
      subtitlesEnabled,
      pairPrefill,
    });
  } catch (_err) {
    res.status(400).json({ ok: false, error: "invalid_config" });
  }
});

function sendPairingFailure(res, error) {
  const code = error && error.code;
  if (code === "pairing_capacity" || code === "device_limit") {
    return res.status(503).json({
      ok: false,
      error: "Pairing capacity is temporarily full. Retry shortly.",
      retryAfterSec: PAIR_POLL_INTERVAL_SEC,
    });
  }
  if (code === "pairing_conflict" || code === "profile_alias_conflict" || code === "pairing_device_conflict") {
    return res.status(409).json({ ok: false, error: "Pair code is already bound to another profile" });
  }
  if (code === "profile_unavailable") {
    return res.status(403).json({ ok: false, error: "profile_unavailable" });
  }
  if (
    code === "profile_generation_changed" ||
    code === "device_generation_changed" ||
    code === "profile_inactive"
  ) {
    return res.status(409).json({ ok: false, error: "pairing_binding_changed" });
  }
  if (error instanceof TypeError) {
    return res.status(400).json({ ok: false, error: "Invalid pairing request" });
  }
  const logCode =
    typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : "";
  console.error("[pairing] operation failed" + (logCode ? " code=" + logCode : ""));
  return res.status(500).json({ ok: false, error: "Pairing is temporarily unavailable" });
}

function setPairActivationPrivacyHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

app.post(
  "/pair/device/code",
  pairIpAbuseRateLimiter,
  pairCodeRateLimiter,
  express.json({ limit: "1kb" }),
  asyncHandler(async (req, res) => {
    try {
      const validationScenario = assertValidationScenario(
        req.body && req.body.validationScenario,
        RELEASE_VALIDATION
      );
      const deviceName =
        req.body && typeof req.body.deviceName === "string"
          ? req.body.deviceName.trim().slice(0, 128)
          : "Jumpgate";
      if (
        validationScenario === "delayed-issue" &&
        !(await waitForRequest(req, res, RELEASE_VALIDATION.delayedIssueMs))
      ) {
        return;
      }
      const issued = await pairingCoordinator.issue({
        deviceName,
        validationScenario: validationScenario || undefined,
        ttlMs:
          validationScenario === "short-expiry"
            ? RELEASE_VALIDATION.shortExpiryMs
            : undefined,
      });
      const formattedUserCode = formatPairUserCode(issued.userCode);
      const verificationUrl = getPublicBaseUrl(req) + "/configure";
      const verificationUrlWithCode = buildPairPrefillUrl(req, formattedUserCode, issued.expiresAt);
      const verificationShortUrl =
        getPublicBaseUrl(req) +
        "/p/" +
        encodeURIComponent(formattedUserCode) +
        "?pairExpiresAt=" +
        encodeURIComponent(String(issued.expiresAt));
      const expiresSec = Math.max(1, Math.floor((issued.expiresAt - Date.now()) / 1000));

      res.setHeader("Cache-Control", "no-store");
      res.json({
        ok: true,
        user_code: formattedUserCode,
        userCode: formattedUserCode,
        user_code_compact: normalizePairUserCode(formattedUserCode),
        userCodeCompact: normalizePairUserCode(formattedUserCode),
        device_code: issued.deviceCode,
        deviceCode: issued.deviceCode,
        verification_url: verificationUrl,
        verificationUrl,
        verification_url_with_code: verificationUrlWithCode,
        verificationUrlWithCode,
        verification_short_url: verificationShortUrl,
        verificationShortUrl,
        expires_in: expiresSec,
        expiresIn: expiresSec,
        expires_at: issued.expiresAt,
        expiresAt: issued.expiresAt,
        interval: PAIR_POLL_INTERVAL_SEC,
      });
    } catch (error) {
      sendPairingFailure(res, error);
    }
  })
);

app.post(
  "/pair/activate",
  setPairActivationPrivacyHeaders,
  pairIpAbuseRateLimiter,
  express.json({ limit: "8kb" }),
  pairActivateRateLimiter,
  asyncHandler(async (req, res) => {
    const userCodeInput =
      req.body && (req.body.userCode || req.body.user_code || req.body.pairCode || req.body.pair_code)
        ? req.body.userCode || req.body.user_code || req.body.pairCode || req.body.pair_code
        : "";
    const userCode = normalizePairUserCode(userCodeInput);
    if (userCodeInput && !userCode) {
      return res.status(400).json({ ok: false, error: "Invalid userCode" });
    }

    const activationRetryToken =
      req.body && typeof req.body.activationRetryToken === "string"
        ? req.body.activationRetryToken
        : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(activationRetryToken)) {
      return res.status(400).json({ ok: false, error: "Invalid activation retry token" });
    }

    const requestedConfig =
      req.body && typeof req.body.config === "string" ? String(req.body.config).trim() : "";
    const bridgeBaseInput =
      req.body && typeof req.body.bridgeBaseUrl === "string" ? String(req.body.bridgeBaseUrl).trim() : "";
    const configBlob = requestedConfig || extractConfigBlobFromBridgeBaseUrl(bridgeBaseInput);
    if (!configBlob) return res.status(400).json({ ok: false, error: "Missing config" });

    try {
      if (RELEASE_VALIDATION.enabled) {
        let candidateConfig = null;
        try {
          candidateConfig = decryptConfig(configBlob);
        } catch (_error) {}
        if (!isSyntheticReleaseValidationConfig(candidateConfig)) {
          return res.status(400).json({ ok: false, error: "synthetic_config_required" });
        }
      }
      const urls = buildConfiguredUrls(req, configBlob);
      const activated = await pairingCoordinator.activate({
        userCode,
        configBlob,
        activationRetryToken,
        // The server derives its own canonical origin; callers cannot bind a hostile host.
        bridgeBaseUrl: urls.bridgeBaseUrl,
      });
      if (!activated || activated.status === "not_found") {
        return res.status(404).json({ ok: false, error: "Invalid pair code" });
      }
      if (activated.status === "expired") {
        return res.status(410).json({ ok: false, error: "Pair code expired" });
      }
      await getOrSeedTraktCredential(activated.profileId, decryptConfig(configBlob));
      await ensureSyntheticUatProvider(activated.profileId, configBlob, getPublicBaseUrl(req));
      const management = activated.management;
      if (!management) throw new Error("pairing activation did not issue management authority");
      const cookie = serializeCookie(MANAGEMENT_SESSION_COOKIE, management.sessionToken, {
        path: "/api/profile",
        expiresAt: management.expiresAt,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      });
      await commitDeviceResponse(
        {
          profileId: activated.profileId,
          profileRevision: activated.profileRevision,
          deviceId: activated.deviceId,
          deviceGeneration: activated.deviceGeneration,
        },
        res,
        preparedJsonResponse(
          200,
          {
            ok: true,
            paired: true,
            ...buildConfiguredUrls(req, configBlob),
            profile_id: activated.profileId,
            profileId: activated.profileId,
            name: activated.name,
            settings: activated.settings,
            managementCsrf: management.csrfToken,
            managementExpiresAt: management.expiresAt,
          },
          {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
            "Set-Cookie": cookie,
          }
        )
      );
    } catch (error) {
      sendPairingFailure(res, error);
    }
  })
);

app.post(
  "/pair/device/token",
  pairIpAbuseRateLimiter,
  express.json({ limit: "4kb" }),
  pairTokenRateLimiter,
  asyncHandler(async (req, res) => {
    const deviceCodeInput =
      req.body && (req.body.deviceCode || req.body.device_code)
        ? req.body.deviceCode || req.body.device_code
        : "";
    const deviceCode = normalizePairDeviceCode(deviceCodeInput);
    if (!deviceCode) return res.status(400).json({ ok: false, error: "Missing deviceCode" });

    res.setHeader("Cache-Control", "no-store");
    try {
      const validation = RELEASE_VALIDATION.enabled
        ? await pairingCoordinator.claimValidation(deviceCode)
        : null;
      if (validation && validation.rateLimitNow) {
        res.setHeader("Retry-After", String(RELEASE_VALIDATION.retryAfterSec));
        return res.status(429).json({ ok: false, error: "Pairing temporarily rate-limited" });
      }
      if (validation && validation.scenario === "terminal-failure") {
        return res.status(422).json({ ok: false, error: "Injected pairing terminal failure" });
      }
      if (
        validation &&
        (validation.scenario === "delayed-poll" || validation.scenario === "short-expiry")
      ) {
        const delayMs =
          validation.scenario === "short-expiry"
            ? RELEASE_VALIDATION.shortExpiryMs
            : RELEASE_VALIDATION.delayedPollMs;
        if (!(await waitForRequest(req, res, delayMs))) return;
      }
      let disclosed = false;
      const result = await pairingCoordinator.redeem(
        deviceCode,
        (redeemed) => {
          disclosed = true;
          res.setHeader("Cache-Control", "no-store");
          res.json({
            ok: true,
            paired: true,
            profile_id: redeemed.profileId,
            profileId: redeemed.profileId,
            bridgeBaseUrl: redeemed.bridgeBaseUrl,
            config: redeemed.config,
            device_id: redeemed.deviceId,
            deviceId: redeemed.deviceId,
            device_token: redeemed.deviceToken,
            deviceToken: redeemed.deviceToken,
            name: redeemed.name || "",
            settings: redeemed.settings,
          });
        },
        RELEASE_VALIDATION.vobsubFixtureEnabled
          ? (redeemed) => assertSyntheticUatProvider(
              redeemed.profileId,
              redeemed.configBlob,
              new URL(redeemed.bridgeBaseUrl).origin
            )
          : undefined
      );
      if (!result || result.status === "not_found") {
        return res.status(404).json({ ok: false, error: "Invalid device code" });
      }
      if (result.status === "expired") {
        return res.status(410).json({ ok: false, error: "Pairing expired" });
      }
      if (result.status === "cancelled") {
        return res.status(410).json({ ok: false, error: "Pairing cancelled" });
      }
      if (result.status === "pending") {
        return res.json({
          ok: true,
          paired: false,
          interval: PAIR_POLL_INTERVAL_SEC,
          expires_at: result.expiresAt,
          expiresAt: result.expiresAt,
        });
      }
      if (result.status !== "redeemed") {
        throw new Error("pairing redemption returned an invalid state");
      }
      if (!disclosed || !res.headersSent) {
        throw new Error("pairing redemption did not commit its disclosure");
      }
      return;
    } catch (error) {
      sendPairingFailure(res, error);
    }
  })
);

function sendProfileApiFailure(res, error) {
  const code = error && error.code;
  if (code === "revision_conflict") {
    return res.status(409).json({ ok: false, error: "revision_conflict" });
  }
  if (code === "profile_unavailable") {
    return res.status(403).json({ ok: false, error: "profile_unavailable" });
  }
  if (code === "backup_limit") {
    return res.status(409).json({ ok: false, error: "backup_limit" });
  }
  if (code === "recursive_provider") {
    return res.status(400).json({ ok: false, error: "recursive_provider" });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return res.status(400).json({ ok: false, error: "invalid_provider_collection" });
  }
  console.error(
    "[profile-api] operation failed" +
      (typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? " code=" + code : "")
  );
  return res.status(503).json({ ok: false, error: "service_unavailable" });
}

function sendLifecycleApiFailure(res, error) {
  const code = error && error.code;
  if (code === "profile_unavailable" || code === "profile_inactive") {
    return res.status(403).json({ ok: false, error: "profile_unavailable" });
  }
  if (code === "revision_conflict" || code === "trakt_generation_changed") {
    return res.status(409).json({ ok: false, error: "profile_changed" });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return res.status(400).json({ ok: false, error: "invalid_profile_request" });
  }
  console.error(
    "[profile-lifecycle] operation failed" +
      (typeof code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(code) ? " code=" + code : "")
  );
  return res.status(503).json({ ok: false, error: "service_unavailable" });
}

app.get(
  "/api/profile/devices",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      const profileId = req.managementBinding.profileId;
      const [devices, trakt] = await Promise.all([
        repositories().devices.list(profileId),
        repositories().oauthCredentials.get(profileId, TRAKT_PROVIDER),
      ]);
      res.json({
        ok: true,
        devices: devices.map((device) => ({
          id: device.id,
          deviceId: device.id,
          displayName: device.displayName,
          lastSeenAt: device.lastSeenAt,
          current: false,
        })),
        traktLinked: isTraktCredentialLinked(trakt),
      });
    } catch (error) {
      sendLifecycleApiFailure(res, error);
    }
  })
);

app.delete(
  "/api/profile/devices/:deviceId",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      const profileId = req.managementBinding.profileId;
      const revoked = await profileLifecycleService.revokeDevice(
        profileId,
        req.params.deviceId
      );
      if (!revoked) return res.status(404).json({ ok: false, error: "device_not_found" });
      return res.json({ ok: true, status: "revoked" });
    } catch (error) {
      return sendLifecycleApiFailure(res, error);
    }
  })
);

app.delete(
  "/api/profile/history",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      const cleared = await profileLifecycleService.clearHistory(
        req.managementBinding.profileId
      );
      res.json({ ok: true, historyGeneration: cleared.historyGeneration });
    } catch (error) {
      sendLifecycleApiFailure(res, error);
    }
  })
);

app.delete(
  "/api/profile/trakt",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      await disconnectTraktCredential(req.managementBinding.profileId);
      res.json({ ok: true, status: "disconnected" });
    } catch (error) {
      sendLifecycleApiFailure(res, error);
    }
  })
);

const parseManagementTraktConnectBody = express.urlencoded({
  extended: false,
  inflate: false,
  limit: "1kb",
  parameterLimit: 4,
  type: "application/x-www-form-urlencoded",
});

function sendManagementTraktRedirect(res, kind, message) {
  const params = new URLSearchParams({ [kind]: message });
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.status(303);
  res.setHeader("Location", "/configure?" + params.toString());
  return res.end();
}

function rejectManagementTraktLaunch(res, message) {
  return sendManagementTraktRedirect(res, "error", message);
}

function isManagementTraktAjaxRequest(req) {
  const headers = req && req.headers ? req.headers : {};
  const contentLength = headers["content-length"];
  return (
    !headers["content-type"] &&
    !headers["transfer-encoding"] &&
    (contentLength === undefined || contentLength === "0") &&
    typeof headers["x-jumpgate-csrf"] === "string" &&
    Boolean(headers["x-jumpgate-csrf"].trim())
  );
}

function classifyManagementTraktLaunch(req, _res, next) {
  req.managementTraktProtocol = isManagementTraktAjaxRequest(req)
    ? MANAGEMENT_TRAKT_AJAX_PROTOCOL
    : MANAGEMENT_TRAKT_FORM_PROTOCOL;
  next();
}

function rejectManagementTraktRequest(req, res, message, status, errorCode) {
  if (req.managementTraktProtocol === MANAGEMENT_TRAKT_AJAX_PROTOCOL) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    return res.status(status || 400).json({
      ok: false,
      error: errorCode || "trakt_launch_failed",
    });
  }
  return rejectManagementTraktLaunch(res, message);
}

function requireManagementTraktLaunchOrigin(req, res, next) {
  if (!hasExactBrowserOrigin(req)) {
    return rejectManagementTraktRequest(
      req,
      res,
      "Unable to start Trakt from this page. Try again.",
      403,
      "origin_not_allowed"
    );
  }
  next();
}

function parseManagementTraktLaunch(req, res, next) {
  if (req.managementTraktProtocol === MANAGEMENT_TRAKT_AJAX_PROTOCOL) return next();
  if (!req.is("application/x-www-form-urlencoded")) {
    return rejectManagementTraktLaunch(res, "Unable to start Trakt from this page. Try again.");
  }
  return parseManagementTraktConnectBody(req, res, (error) => {
    const body = req.body;
    const fields = body && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body)
      : [];
    if (
      error ||
      fields.length !== 1 ||
      fields[0] !== "csrf" ||
      typeof body.csrf !== "string" ||
      !body.csrf
    ) {
      return rejectManagementTraktLaunch(res, "Unable to start Trakt from this page. Try again.");
    }
    req.managementFormCsrf = body.csrf;
    next();
  });
}

async function requireManagementTraktLaunchAuth(req, res, next) {
  if (req.managementTraktProtocol === MANAGEMENT_TRAKT_AJAX_PROTOCOL) {
    return requireManagementAuth(req, res, next);
  }
  try {
    const sessionToken = getCookie(req, MANAGEMENT_SESSION_COOKIE);
    const binding = await repositories().managementSessions.authenticate(
      sessionToken,
      req.managementFormCsrf
    );
    const profile = binding && binding.profileId
      ? await repositories().profiles.getById(binding.profileId)
      : null;
    if (
      !binding ||
      !binding.profileId ||
      !Number.isSafeInteger(binding.managementGeneration) ||
      binding.managementGeneration < 0 ||
      !profile ||
      profile.status !== "active"
    ) {
      return rejectManagementTraktLaunch(res, "Pair Jumpgate again before connecting Trakt.");
    }
    req.managementBinding = {
      profileId: binding.profileId,
      managementGeneration: binding.managementGeneration,
      sessionToken,
      expiresAt: binding.expiresAt,
    };
    next();
  } catch (_error) {
    return rejectManagementTraktLaunch(res, "Pair Jumpgate again before connecting Trakt.");
  }
}

async function applyManagementTraktLaunchRateLimit(
  req,
  res,
  next,
  scope,
  clientSignal,
  limit,
  windowMs
) {
  try {
    const clientKeyHash = hashRateLimitClientKey(clientSignal);
    const result = await getRateLimitRepository().consume(
      scope,
      clientKeyHash,
      limit,
      windowMs
    );
    if (
      !result ||
      typeof result.allowed !== "boolean" ||
      !Number.isSafeInteger(result.remaining) ||
      result.remaining < 0 ||
      result.remaining > limit ||
      !Number.isSafeInteger(result.resetAt) ||
      result.resetAt < 1
    ) {
      throw new Error("invalid Trakt launch rate-limit result");
    }
    const resetAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    res.setHeader(
      "RateLimit-Policy",
      String(limit) + ";w=" + String(Math.ceil(windowMs / 1000))
    );
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(result.remaining));
    res.setHeader("RateLimit-Reset", String(resetAfterSec));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(resetAfterSec));
      return rejectManagementTraktRequest(
        req,
        res,
        "Too many Trakt connection attempts. Wait briefly and try again.",
        429,
        "rate_limited"
      );
    }
    next();
  } catch (_error) {
    return rejectManagementTraktRequest(
      req,
      res,
      "Trakt connection is temporarily unavailable.",
      503,
      "trakt_unavailable"
    );
  }
}

async function requireManagementTraktLaunchIpRateLimit(req, res, next) {
  return applyManagementTraktLaunchRateLimit(
    req,
    res,
    next,
    "management-trakt-launch-ip",
    "ip:" + rateLimitKey(req),
    managementTraktIpLaunchLimit,
    MANAGEMENT_TRAKT_IP_LAUNCH_WINDOW_MS
  );
}

async function requireManagementTraktContinuationIpRateLimit(req, res, next) {
  return applyManagementTraktLaunchRateLimit(
    req,
    res,
    next,
    "management-trakt-continuation-ip",
    "ip:" + rateLimitKey(req),
    managementTraktIpLaunchLimit,
    MANAGEMENT_TRAKT_IP_LAUNCH_WINDOW_MS
  );
}

async function requireManagementTraktLaunchRateLimit(req, res, next) {
  return applyManagementTraktLaunchRateLimit(
    req,
    res,
    next,
    "management-trakt-launch",
    "profile:" + req.managementBinding.profileId,
    MANAGEMENT_TRAKT_LAUNCH_LIMIT,
    MANAGEMENT_TRAKT_LAUNCH_WINDOW_MS
  );
}

app.post(
  "/api/profile/trakt/connect",
  classifyManagementTraktLaunch,
  asyncHandler(requireManagementTraktLaunchIpRateLimit),
  requireManagementTraktLaunchOrigin,
  parseManagementTraktLaunch,
  asyncHandler(requireManagementTraktLaunchAuth),
  asyncHandler(requireManagementTraktLaunchRateLimit),
  asyncHandler(async (req, res) => {
    let issued = null;
    try {
      const profileId = req.managementBinding.profileId;
      const credential = await ensureTraktCredentialGeneration(profileId);
      const generation = readTraktGeneration(credential.credentials);
      issued = await repositories().oauthStates.issue(profileId, {
        kind: "management-trakt-connect",
        protocol: req.managementTraktProtocol,
        credentialGeneration: generation,
        credentialRevision: credential.revision,
      }, {
        managementGeneration: req.managementBinding.managementGeneration,
      });
      if (!Number.isSafeInteger(issued.expiresAt) || issued.expiresAt <= Date.now()) {
        throw new Error("Trakt OAuth state issuance was invalid");
      }
      const secure = secureCookieForRequest(req);
      const maxAgeSec = Math.max(0, Math.floor((issued.expiresAt - Date.now()) / 1000));
      if (req.managementTraktProtocol === MANAGEMENT_TRAKT_AJAX_PROTOCOL) {
        setCookie(res, MANAGEMENT_OAUTH_STATE_COOKIE, issued.stateToken, {
          path: "/api/profile/trakt/connect/continue",
          maxAgeSec,
          expiresAt: issued.expiresAt,
          httpOnly: true,
          secure,
          sameSite: "Strict",
        });
        setCookie(res, MANAGEMENT_OAUTH_BINDING_COOKIE, issued.browserBindingToken, {
          path: "/auth/trakt/callback",
          maxAgeSec,
          expiresAt: issued.expiresAt,
          httpOnly: true,
          secure,
          sameSite: "Lax",
        });
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Pragma", "no-cache");
        return res.json({ ok: true, url: "/api/profile/trakt/connect/continue" });
      }

      const cookieName = managementOAuthBindingCookieName(issued.stateToken);
      if (!cookieName) throw new Error("Trakt OAuth cookie slot was invalid");
      setCookie(res, cookieName, issued.browserBindingToken, {
        path: "/auth/trakt/callback",
        maxAgeSec,
        expiresAt: issued.expiresAt,
        httpOnly: true,
        secure,
        sameSite: "Lax",
      });
      const params = new URLSearchParams({
        response_type: "code",
        client_id: TRAKT_CLIENT_ID,
        redirect_uri: getTraktRedirectUri(req),
        state: "m2." + issued.stateToken,
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.status(303);
      res.setHeader("Location", buildTraktConsentUrl(TRAKT_AUTHORIZE_URL, params));
      return res.end();
    } catch (error) {
      if (issued && issued.stateToken) {
        await repositories().oauthStates.cancel(issued.stateToken).catch(() => {});
      }
      res.removeHeader("Set-Cookie");
      return rejectManagementTraktRequest(
        req,
        res,
        "Trakt connection is temporarily unavailable.",
        503,
        "trakt_unavailable"
      );
    }
  })
);

app.get(
  "/api/profile/trakt/connect/continue",
  asyncHandler(requireManagementTraktContinuationIpRateLimit),
  (req, res) => {
    const stateToken = getCookie(req, MANAGEMENT_OAUTH_STATE_COOKIE);
    setCookie(res, MANAGEMENT_OAUTH_STATE_COOKIE, "", {
      path: "/api/profile/trakt/connect/continue",
      maxAgeSec: 0,
      httpOnly: true,
      secure: secureCookieForRequest(req),
      sameSite: "Strict",
    });
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!MANAGEMENT_OAUTH_STATE_TOKEN_PATTERN.test(stateToken)) {
      return rejectManagementTraktLaunch(
        res,
        "Trakt connection state expired. Pair Jumpgate and start again."
      );
    }
    const params = new URLSearchParams({
      response_type: "code",
      client_id: TRAKT_CLIENT_ID,
      redirect_uri: getTraktRedirectUri(req),
      state: "m1." + stateToken,
    });
    res.status(303);
    res.setHeader("Location", buildTraktConsentUrl(TRAKT_AUTHORIZE_URL, params));
    return res.end();
  }
);

app.delete(
  "/api/profile",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      const result = await profileLifecycleService.requestErasure(
        req.managementBinding.profileId
      );
      return res.status(202).json({
        ok: true,
        status: result.status === "deleted" ? "pending" : result.status,
      });
    } catch (error) {
      return sendLifecycleApiFailure(res, error);
    }
  })
);

app.post(
  "/api/profile/providers/preview",
  asyncHandler(requireManagementAuth),
  express.json({ limit: "5mb" }),
  (req, res) => {
    try {
      const descriptors = req.body && req.body.descriptors;
      res.json({ ok: true, providers: providerImportService.preview(descriptors) });
    } catch (error) {
      sendProfileApiFailure(res, error);
    }
  }
);

app.get(
  "/api/profile/providers",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      const collection = await providerImportService.list(req.managementBinding.profileId);
      res.json({ ok: true, ...collection });
    } catch (error) {
      sendProfileApiFailure(res, error);
    }
  })
);

app.put(
  "/api/profile/providers",
  asyncHandler(requireManagementAuth),
  express.json({ limit: "5mb" }),
  asyncHandler(async (req, res) => {
    try {
      const imported = await providerImportService.import(
        req.managementBinding.profileId,
        req.body
      );
      res.json({ ok: true, ...imported });
    } catch (error) {
      sendProfileApiFailure(res, error);
    }
  })
);

app.get(
  "/api/profile/backups",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      const backups = await repositories().addonCollectionBackups.list(
        req.managementBinding.profileId,
        { limit: 20 }
      );
      res.json({ ok: true, backups });
    } catch (error) {
      sendProfileApiFailure(res, error);
    }
  })
);

app.post(
  "/api/profile/backups",
  asyncHandler(requireManagementAuth),
  express.json({ limit: "5mb" }),
  asyncHandler(async (req, res) => {
    try {
      const backup = await providerImportService.backup(
        req.managementBinding.profileId,
        req.body && req.body.collection,
        req.body && req.body.reason ? req.body.reason : "before-stremio-addon-update"
      );
      res.json({ ok: true, backup });
    } catch (error) {
      sendProfileApiFailure(res, error);
    }
  })
);

app.get(
  "/api/profile/backups/:backupId",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      const backup = await repositories().addonCollectionBackups.get(
        req.managementBinding.profileId,
        req.params.backupId
      );
      if (!backup) return res.status(404).json({ ok: false, error: "backup_not_found" });
      res.json({ ok: true, backup });
    } catch (error) {
      sendProfileApiFailure(res, error);
    }
  })
);

app.post(
  "/api/profile/backups/:backupId/restored",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    try {
      const restored = await repositories().addonCollectionBackups.markRestored(
        req.managementBinding.profileId,
        req.params.backupId
      );
      if (!restored) return res.status(404).json({ ok: false, error: "backup_not_found" });
      res.json({ ok: true });
    } catch (error) {
      sendProfileApiFailure(res, error);
    }
  })
);

app.post(
  "/api/profile/session/revoke",
  asyncHandler(requireManagementAuth),
  asyncHandler(async (req, res) => {
    await repositories().managementSessions.revoke(req.managementBinding.sessionToken);
    res.json({ ok: true });
  })
);

async function handleManagementTraktCallback(
  req,
  res,
  protocol,
  stateToken,
  code,
  oauthError
) {
  let stage = "state_consume";
  const cookieName =
    protocol === MANAGEMENT_TRAKT_AJAX_PROTOCOL
      ? MANAGEMENT_OAUTH_BINDING_COOKIE
      : managementOAuthBindingCookieName(stateToken);
  if (!cookieName) {
    return rejectManagementTraktLaunch(
      res,
      "Trakt connection state is invalid. Pair Jumpgate and start again."
    );
  }
  const bindingToken = getCookie(req, cookieName);
  setCookie(res, cookieName, "", {
    path: "/auth/trakt/callback",
    maxAgeSec: 0,
    httpOnly: true,
    secure: secureCookieForRequest(req),
    sameSite: "Lax",
  });
  res.setHeader("Cache-Control", "no-store");
  try {
    const consumed = await repositories().oauthStates.consume(stateToken, bindingToken);
    if (!consumed || !consumed.payload || consumed.payload.kind !== "management-trakt-connect") {
      throw traktCallbackError("state_invalid");
    }
    stage = "state_validate";
    if (
      (protocol === MANAGEMENT_TRAKT_FORM_PROTOCOL &&
        consumed.payload.protocol !== MANAGEMENT_TRAKT_FORM_PROTOCOL) ||
      (protocol === MANAGEMENT_TRAKT_AJAX_PROTOCOL &&
        consumed.payload.protocol !== undefined &&
        consumed.payload.protocol !== MANAGEMENT_TRAKT_AJAX_PROTOCOL)
    ) {
      throw traktCallbackError("state_invalid");
    }
    const generation = consumed.payload.credentialGeneration;
    const revision = consumed.payload.credentialRevision;
    if (
      !TRAKT_GENERATION_PATTERN.test(generation) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    ) {
      throw traktCallbackError("state_invalid");
    }
    stage = "authorization";
    if (oauthError || !code) throw traktCallbackError("authorization_denied");
    stage = "profile_fence";
    const profile = await repositories().profiles.getById(consumed.profileId);
    const current = await repositories().oauthCredentials.get(consumed.profileId, TRAKT_PROVIDER);
    if (
      !profile ||
      profile.status !== "active" ||
      !current ||
      current.revision !== revision ||
      readTraktGeneration(current.credentials) !== generation
    ) {
      throw traktCallbackError("profile_changed");
    }
    stage = "token_exchange";
    const tokens = await exchangeTraktAuthCode(code, getTraktRedirectUri(req));
    stage = "credential_write";
    await replaceTraktCredential(consumed.profileId, tokens, {
      expectedGeneration: generation,
      expectedRevision: revision,
    });
    return sendManagementTraktRedirect(
      res,
      "notice",
      "Trakt connected. Pairing remains profile-scoped."
    );
  } catch (error) {
    return rejectManagementTraktLaunch(
      res,
      managementTraktCallbackFailure(stage, error)
    );
  }
}

app.get("/auth/trakt/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const oauthError = typeof req.query.error === "string" ? req.query.error : "";

  const legacyManagementState = /^m1\.([A-Za-z0-9_-]{43})$/.exec(state);
  if (legacyManagementState) {
    return handleManagementTraktCallback(
      req,
      res,
      MANAGEMENT_TRAKT_AJAX_PROTOCOL,
      legacyManagementState[1],
      code,
      oauthError
    );
  }
  const formManagementState = /^m2\.([A-Za-z0-9_-]{43})$/.exec(state);
  if (formManagementState) {
    return handleManagementTraktCallback(
      req,
      res,
      MANAGEMENT_TRAKT_FORM_PROTOCOL,
      formManagementState[1],
      code,
      oauthError
    );
  }
  return rejectManagementTraktLaunch(
    res,
    "Trakt connection state is invalid. Pair Jumpgate and start again."
  );
});

function manifestArtwork(req) {
  const baseUrl = getPublicBaseUrl(req);
  return {
    logo: baseUrl + "/assets/jumpgate-mark.png",
    background: baseUrl + "/assets/jumpgate-backdrop.jpg",
  };
}

app.get("/manifest.json", (req, res) => {
  res.json({
    id: ADDON_ID,
    version: BRIDGE_VERSION,
    name: ADDON_NAME + " (Setup Required)",
    description:
      "Pair Jumpgate, choose the providers from your active Stremio profile, then install its private playback bridge.",
    ...manifestArtwork(req),
    catalogs: [],
    resources: [],
    types: [],
    behaviorHints: { configurable: true, configurationRequired: true },
  });
});

function createVersionPayload(buildSha = BUILD_SHA) {
  const parts = BRIDGE_VERSION.split(".").map(Number);
  return {
    version: BRIDGE_VERSION,
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    buildSha,
    capabilities: {
      managementTraktOAuth: MANAGEMENT_TRAKT_EXPANSION_CAPABILITY,
    },
  };
}

function sendVersion(res) {
  res.setHeader("Cache-Control", "no-store");
  res.json(createVersionPayload());
}

app.get("/version", (_req, res) => sendVersion(res));

app.get("/catalog/:type/" + CONTINUE_CATALOG_ID + ".json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ metas: [] });
});

app.get("/stream/:type/:id.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ streams: [] });
});

app.get("/identify", (_req, res) => sendLegacyIdentityGone(res));

app.get("/meta/:imdb", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(403).json({ ok: false, error: "pairing_required" });
});

app.post("/resume", (_req, res) => sendLegacyLifecycleGone(res));

async function configuredManifestHandler(req, res) {
  const config = req.userConfig;
  const profileName = config.name ? " (" + config.name + ")" : "";
  const capabilities = await providerGatewayService.capabilities(req.profileId);
  const types = Array.from(new Set(["movie", "series", ...capabilities.types]));
  const catalogs = [
    { type: "movie", id: CONTINUE_CATALOG_ID, name: "Continue Watching" },
    { type: "series", id: CONTINUE_CATALOG_ID, name: "Continue Watching" },
  ];
  if (
    RELEASE_VALIDATION.vobsubFixtureEnabled &&
    isSyntheticReleaseValidationConfig(config)
  ) {
    catalogs.unshift({
      type: "movie",
      id: UAT_VOBSUB_FIXTURE.CATALOG_ID,
      name: "Jumpgate VobSub Pipeline Test",
    });
  }
  res.json({
    id: ADDON_ID,
    version: BRIDGE_VERSION,
    name: ADDON_NAME + profileName,
    description: config.name
      ? "Private Stremio-to-Kodi handoff for " + config.name + ", with provider gatewaying, subtitles, and optional Trakt sync."
      : "Private Stremio-to-Kodi handoff with provider gatewaying, subtitles, and optional Trakt sync.",
    ...manifestArtwork(req),
    catalogs,
    resources: [...capabilities.resources, "catalog"],
    types,
    behaviorHints: { configurable: true, configurationRequired: false },
  });
}

function requireSyntheticUatFixture(req, res, next) {
  if (
    !RELEASE_VALIDATION.vobsubFixtureEnabled ||
    !UAT_VOBSUB_ASSETS ||
    !isSyntheticReleaseValidationConfig(req.userConfig)
  ) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  next();
}

function sendUatFixtureManifest(_req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.json(UAT_VOBSUB_FIXTURE.manifest());
}

function sendUatFixtureStream(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.json(UAT_VOBSUB_FIXTURE.streamResponse(getPublicBaseUrl(req), req.params.config));
}

function sendUatFixtureSubtitles(req, res) {
  if (
    req.params.extra !== undefined &&
    req.params.extra !== "filename=jumpgate-uat-vobsub-v1.mp4"
  ) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.json(UAT_VOBSUB_FIXTURE.subtitlesResponse(getPublicBaseUrl(req), req.params.config));
}

function sendUatFixtureMedia(req, res) {
  return UAT_VOBSUB_FIXTURE.sendAsset(req, res, UAT_VOBSUB_ASSETS.media, {
    allowRange: true,
  });
}

function sendUatFixtureSubtitleArchive(req, res) {
  return UAT_VOBSUB_FIXTURE.sendAsset(req, res, UAT_VOBSUB_ASSETS.subtitles);
}

function rawGatewayRequestFromUrl(req, expectedResource) {
  const originalUrl = String(req.originalUrl || req.url || "");
  const queryIndex = originalUrl.indexOf("?");
  const pathname = queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
  const segments = pathname.split("/").filter(Boolean);
  const resourceIndex = segments[0] === "_c" ? 2 : 1;
  const expectedLength = resourceIndex + (req.params.extra === undefined ? 3 : 4);
  if (segments.length !== expectedLength || segments[resourceIndex] !== expectedResource) {
    throw new ProviderGatewayError("invalid_resource_path", "gateway resource path is invalid");
  }

  const type = segments[resourceIndex + 1];
  let id = segments[resourceIndex + 2];
  let rawExtra;
  if (req.params.extra === undefined) {
    if (!id.endsWith(".json")) {
      throw new ProviderGatewayError("invalid_resource_path", "gateway resource path is invalid");
    }
    id = id.slice(0, -5);
  } else {
    rawExtra = segments[resourceIndex + 3];
    if (!rawExtra.endsWith(".json")) {
      throw new ProviderGatewayError("invalid_resource_path", "gateway resource path is invalid");
    }
    rawExtra = rawExtra.slice(0, -5);
    if (
      RELEASE_VALIDATION.vobsubFixtureEnabled &&
      expectedResource === "subtitles" &&
      rawExtra.toLowerCase() === "filename%3djumpgate-uat-vobsub-v1.mp4"
    ) {
      rawExtra = "filename=jumpgate-uat-vobsub-v1.mp4";
    }
  }
  return decodeResourceRequest(expectedResource, type, id, rawExtra);
}

function requestAbortSignal(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortIfIncomplete = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  res.once("close", abortIfIncomplete);
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener("aborted", abort);
      res.removeListener("close", abortIfIncomplete);
    },
  };
}

function isInvalidGatewayRequest(error) {
  if (error instanceof TypeError || error instanceof RangeError) return true;
  return Boolean(
    error instanceof ProviderGatewayError &&
      (error.code === "invalid_resource_path" || error.code === "unsupported_resource")
  );
}

async function configuredStreamHandler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const abort = requestAbortSignal(req, res);
  try {
    const request = rawGatewayRequestFromUrl(req, "stream");
    console.log("[stream:configured] profile=" + req.profileLogHash);
    const display = await loadConfiguredStreamDisplay(
      request,
      (req.userConfig && req.userConfig.tmdbKey) || "",
      { signal: abort.signal }
    );
    const response = await providerGatewayService.query(
      req.profileId,
      request,
      { signal: abort.signal, display }
    );
    res.json(response);
  } catch (error) {
    if (abort.signal.aborted) return;
    if (isInvalidGatewayRequest(error)) return res.status(400).json({ streams: [] });
    throw error;
  } finally {
    abort.cleanup();
  }
}

async function configuredSubtitlesHandler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const abort = requestAbortSignal(req, res);
  try {
    const request = rawGatewayRequestFromUrl(req, "subtitles");
    console.log("[subtitles:configured] profile=" + req.profileLogHash);
    const response = await providerGatewayService.query(
      req.profileId,
      request,
      { signal: abort.signal }
    );
    res.json(response);
  } catch (error) {
    if (abort.signal.aborted) return;
    if (isInvalidGatewayRequest(error)) return res.status(400).json({ subtitles: [] });
    throw error;
  } finally {
    abort.cleanup();
  }
}

async function configuredCatalogHandler(req, res) {
  const catalogId = req.params.catalogId || CONTINUE_CATALOG_ID;
  const now = Date.now();
  const historyRecords = await listRecentHistory(req.profileId, now);
  const metas = await buildCatalogMetas(
    req.params.type,
    historyRecords,
    (req.userConfig && req.userConfig.tmdbKey) || "",
    now
  );
  console.log(
    "[catalog:configured] " +
      metas.length +
      " items (hash: " +
      req.profileLogHash +
      ")"
  );
  res.json({ metas });
}

function configuredUatCatalogHandler(req, res) {
  if (
    !RELEASE_VALIDATION.vobsubFixtureEnabled ||
    !isSyntheticReleaseValidationConfig(req.userConfig) ||
    req.params.type !== "movie"
  ) {
    return res.status(404).json({ ok: false, error: "not_found" });
  }
  res.setHeader("Cache-Control", "private, no-store");
  return res.json(UAT_VOBSUB_FIXTURE.catalogResponse(getPublicBaseUrl(req)));
}

function setConfiguredCatalogPrivacyHeaders(_req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  next();
}

async function configuredMetaHandler(req, res) {
  const imdb = String(req.params.imdb || "").trim();
  if (!/^tt\d{7,}$/.test(imdb)) return res.status(400).json({ ok: false, error: "invalid imdb" });

  try {
    const tmdb = await getTmdbMeta(imdb, (req.userConfig && req.userConfig.tmdbKey) || "");
    res.json({
      ok: true,
      imdb,
      name: tmdb ? tmdb.name : imdb,
      poster: publicArtworkUrl(tmdb && tmdb.poster),
      background: publicArtworkUrl(tmdb && tmdb.background),
      logo: publicArtworkUrl(tmdb && tmdb.logo),
    });
  } catch (_err) {
    res.status(503).json({ ok: false, error: "metadata_unavailable" });
  }
}

async function configuredConfigureHandler(req, res) {
  const config = req.userConfig;
  const credential = await getOrSeedTraktCredential(req.profileId, config);
  const traktLinked = hasTraktCredentials(
    normalizeTraktTokens(credential && credential.credentials)
  );
  renderConfigurePage(req, res, {
    name: config.name || "",
    tmdbKeyStored: Boolean(config.tmdbKey),
    subtitleLanguages:
      config.settings && typeof config.settings.subtitle_languages === "string"
        ? config.settings.subtitle_languages
        : "en",
    subtitlesEnabled:
      config.settings && typeof config.settings.subtitles_enabled === "boolean"
        ? config.settings.subtitles_enabled
        : true,
    generated: {
      config: req.params.config,
      name: config.name || "",
      traktLinked,
      tmdbKeyStored: Boolean(config.tmdbKey),
      subtitleLanguages:
        config.settings && typeof config.settings.subtitle_languages === "string"
          ? config.settings.subtitle_languages
          : "en",
      subtitlesEnabled:
        config.settings && typeof config.settings.subtitles_enabled === "boolean"
          ? config.settings.subtitles_enabled
          : true,
    },
  });
}

app.get("/_c/:config/manifest.json", asyncHandler(configMiddleware), asyncHandler(configuredManifestHandler));
app.get(
  "/_c/:config/uat-vobsub/manifest.json",
  asyncHandler(configMiddleware),
  requireSyntheticUatFixture,
  sendUatFixtureManifest
);
app.get(
  "/_c/:config/uat-vobsub/stream/movie/" + UAT_VOBSUB_FIXTURE.CONTENT_ID + ".json",
  asyncHandler(configMiddleware),
  requireSyntheticUatFixture,
  sendUatFixtureStream
);
app.get(
  "/_c/:config/uat-vobsub/subtitles/movie/" + UAT_VOBSUB_FIXTURE.CONTENT_ID + ".json",
  asyncHandler(configMiddleware),
  requireSyntheticUatFixture,
  sendUatFixtureSubtitles
);
app.get(
  "/_c/:config/uat-vobsub/subtitles/movie/" + UAT_VOBSUB_FIXTURE.CONTENT_ID + "/:extra.json",
  asyncHandler(configMiddleware),
  requireSyntheticUatFixture,
  sendUatFixtureSubtitles
);
app.head(
  "/_c/:config/uat-vobsub/media/" + UAT_VOBSUB_FIXTURE.CONTENT_ID + ".mp4",
  asyncHandler(configMiddleware),
  requireSyntheticUatFixture,
  sendUatFixtureMedia
);
app.get(
  "/_c/:config/uat-vobsub/media/" + UAT_VOBSUB_FIXTURE.CONTENT_ID + ".mp4",
  asyncHandler(configMiddleware),
  requireSyntheticUatFixture,
  sendUatFixtureMedia
);
app.head(
  "/_c/:config/uat-vobsub/subtitles/" + UAT_VOBSUB_FIXTURE.CONTENT_ID + ".zip",
  asyncHandler(configMiddleware),
  requireSyntheticUatFixture,
  sendUatFixtureSubtitleArchive
);
app.get(
  "/_c/:config/uat-vobsub/subtitles/" + UAT_VOBSUB_FIXTURE.CONTENT_ID + ".zip",
  asyncHandler(configMiddleware),
  requireSyntheticUatFixture,
  sendUatFixtureSubtitleArchive
);
app.get(
  "/_c/:config/stream/:type/:id/:extra.json",
  asyncHandler(configMiddleware),
  asyncHandler(configuredStreamHandler)
);
app.get("/_c/:config/stream/:type/:id.json", asyncHandler(configMiddleware), asyncHandler(configuredStreamHandler));
app.get(
  "/_c/:config/subtitles/:type/:id/:extra.json",
  asyncHandler(configMiddleware),
  asyncHandler(configuredSubtitlesHandler)
);
app.get(
  "/_c/:config/subtitles/:type/:id.json",
  asyncHandler(configMiddleware),
  asyncHandler(configuredSubtitlesHandler)
);
app.get(
  "/_c/:config/catalog/:type/" + CONTINUE_CATALOG_ID + ".json",
  setConfiguredCatalogPrivacyHeaders,
  asyncHandler(configMiddleware),
  asyncHandler(configuredCatalogHandler)
);
app.get(
  "/_c/:config/catalog/:type/" + UAT_VOBSUB_FIXTURE.CATALOG_ID + ".json",
  setConfiguredCatalogPrivacyHeaders,
  asyncHandler(configMiddleware),
  configuredUatCatalogHandler
);
app.get("/_c/:config/identify", (_req, res) => sendLegacyIdentityGone(res));
app.get("/_c/:config/meta/:imdb", asyncHandler(configMiddleware), configuredMetaHandler);
app.post("/_c/:config/resume", (_req, res) => sendLegacyLifecycleGone(res));
app.get("/_c/:config/configure", asyncHandler(configMiddleware), asyncHandler(configuredConfigureHandler));
app.get("/_c/:config/version", asyncHandler(configMiddleware), (_req, res) => sendVersion(res));

app.get("/:config/manifest.json", asyncHandler(configAliasMiddleware), asyncHandler(configuredManifestHandler));
app.get(
  "/:config/stream/:type/:id/:extra.json",
  asyncHandler(configAliasMiddleware),
  asyncHandler(configuredStreamHandler)
);
app.get("/:config/stream/:type/:id.json", asyncHandler(configAliasMiddleware), asyncHandler(configuredStreamHandler));
app.get(
  "/:config/subtitles/:type/:id/:extra.json",
  asyncHandler(configAliasMiddleware),
  asyncHandler(configuredSubtitlesHandler)
);
app.get(
  "/:config/subtitles/:type/:id.json",
  asyncHandler(configAliasMiddleware),
  asyncHandler(configuredSubtitlesHandler)
);
app.get(
  "/:config/catalog/:type/" + CONTINUE_CATALOG_ID + ".json",
  setConfiguredCatalogPrivacyHeaders,
  asyncHandler(configAliasMiddleware),
  asyncHandler(configuredCatalogHandler)
);
app.get("/:config/identify", (_req, res) => sendLegacyIdentityGone(res));
app.get("/:config/meta/:imdb", asyncHandler(configAliasMiddleware), configuredMetaHandler);
app.post("/:config/resume", (_req, res) => sendLegacyLifecycleGone(res));
app.get("/:config/configure", asyncHandler(configAliasMiddleware), asyncHandler(configuredConfigureHandler));
app.get("/:config/version", asyncHandler(configAliasMiddleware), (_req, res) => sendVersion(res));

if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
  app.post("/test-encrypt", express.json({ limit: "16kb" }), (req, res) => {
    try {
      const blob = encryptConfig(req.body);
      const roundTrip = decryptConfig(blob);
      res.json({
        blob,
        blobLength: blob.length,
        roundTrip,
        match: JSON.stringify(req.body) === JSON.stringify(roundTrip),
      });
    } catch (_err) {
      res.status(500).json({ error: "encryption_failed" });
    }
  });
}

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "not_found" });
});

app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  if (status >= 500) {
    const code =
      error && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
        ? " code=" + error.code
        : "";
    console.error("[request] operation failed" + code);
  }
  if (status === 413) return res.status(413).json({ ok: false, error: "request_too_large" });
  if (status >= 400 && status < 500) {
    return res.status(status).json({ ok: false, error: "invalid_request" });
  }
  return res.status(503).json({ ok: false, error: "service_unavailable" });
});

app.storageReady = ensureStorageReady;
if (process.env.NODE_ENV === "test") {
  app.parseBuildShaForTest = parseBuildSha;
  app.createVersionPayloadForTest = createVersionPayload;
  app.runStorageCleanupForTest = async () => {
    await ensureStorageReady();
    return runStorageCleanup();
  };
}
app.closeStorage = async () => {
  clearInterval(cleanupTimer);
  const activeCleanup = storageCleanupRunner.getActivePromise();
  if (activeCleanup) await activeCleanup.catch(() => {});
  if (!storagePromise) return;
  try {
    await storagePromise;
  } catch (_error) {
    return;
  }
  if (traktScrobbleService) await traktScrobbleService.stop();
  if (storageRuntime && storageRuntime.state !== "closed") await storageRuntime.close();
};

function resolveListenHost(environment, env) {
  if (!Object.prototype.hasOwnProperty.call(env, "HOST")) {
    return isProductionLikeEnvironment(environment) ? "0.0.0.0" : "127.0.0.1";
  }
  const raw = typeof env.HOST === "string" ? env.HOST : "";
  const host = raw.trim();
  if (host !== raw || (host !== "localhost" && net.isIP(host) === 0)) {
    throw new Error("invalid HOST");
  }
  return host;
}

function resolveListenPort(env) {
  if (!Object.prototype.hasOwnProperty.call(env, "PORT")) return 7515;
  const raw = typeof env.PORT === "string" ? env.PORT : "";
  if (!/^[0-9]+$/.test(raw)) throw new Error("invalid PORT");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid PORT");
  }
  return port;
}

if (require.main === module && !process.env.VERCEL) {
  let PORT = null;
  let HOST = null;
  try {
    PORT = resolveListenPort(process.env);
    HOST = resolveListenHost(process.env.NODE_ENV, process.env);
  } catch (_error) {
    console.error(_error && _error.message === "invalid PORT" ? "[startup] invalid PORT" : "[startup] invalid HOST");
    process.exitCode = 1;
  }

  if (HOST !== null && PORT !== null) {
    let server = null;
    let shutdownPromise = null;
    const shutdown = (signal) => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        if (signal) console.log("[shutdown] received " + signal);
        if (server) {
          await new Promise((resolve) => server.close(resolve));
        }
        await app.closeStorage();
      })().catch(() => {
        console.error("[shutdown] graceful shutdown failed");
        process.exitCode = 1;
      });
      return shutdownPromise;
    };

    server = app.listen(PORT, HOST, () => {
      const address = server.address();
      const actualAddress = address && typeof address === "object" ? address.address : HOST;
      const actualPort = address && typeof address === "object" ? address.port : PORT;
      console.log("[startup] listening address=" + actualAddress + " port=" + actualPort);
      console.log("Configure at: http://localhost:" + PORT + "/configure");
    });
    server.on("error", () => {
      console.error("[startup] HTTP server failed");
      process.exitCode = 1;
      void shutdown();
    });
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));

    void ensureStorageReady().catch((error) => {
      const code =
        error && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
          ? " code=" + error.code
          : "";
      console.error("[startup] storage initialization failed" + code);
      process.exitCode = 1;
      void shutdown();
    });
  }
}

module.exports = app;
