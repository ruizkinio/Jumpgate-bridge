"use strict";

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const {
  computeAdvertisedCapabilities,
  isProviderResourceSupported,
} = require("./provider-support");
const {
  buildProviderResourceRequest,
  normalizeProviderResponse,
  normalizeResourceRequest,
} = require("./stremio-transport");
const {
  fingerprintStream,
} = require("./source-context");
const {
  resolveProviderCollectionCoordinator,
} = require("./provider-collection-coordinator");
const { assertIdentifier } = require("./storage/repository-utils");
const { normalizeSubtitleSourceCapability } = require("./subtitle-source");
const { UpstreamFetchPolicy } = require("./upstream-fetch-policy");

const SUPPORTED_RESOURCES = new Set(["stream", "subtitles"]);
const MAX_PROVIDERS = 64;
const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 256;
const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT_ENTRIES = 256;
const DEFAULT_MAX_AGGREGATE_ITEMS = 512;
const DEFAULT_MAX_STREAM_ITEMS = 128;
const DEFAULT_MAX_CONTEXTS_PER_PROFILE = 128;
const DEFAULT_MAX_AGGREGATE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PROVIDER_CONCURRENCY = 4;
const DEFAULT_MAX_PROVIDER_QUEUE_ENTRIES = 1024;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const DEFAULT_MAX_BREAKER_ENTRIES = 256;
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;
const BREAKER_NEUTRAL_ERROR_CODES = new Set([
  "ABORT_ERR",
  "ERR_ABORTED",
  "gateway_aborted",
  "upstream_aborted",
  "upstream_admission_timeout",
  "upstream_queue_full",
  "stale_provider_revision",
]);
const CALLER_ABORT_REASON = Symbol("caller-abort");
const PROFILE_CLEARED_REASON = Symbol("profile-cleared");

class ProviderGatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderGatewayError";
    this.code = code;
  }
}

class ProfileClearedError extends Error {
  constructor() {
    super("gateway profile was cleared");
    this.name = "ProfileClearedError";
    this.code = "gateway_profile_cleared";
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readPositiveInteger(value, name, fallback, maximum) {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new TypeError(name + " is invalid");
  }
  return normalized;
}

function readClock(clock) {
  const now = Number(clock());
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("clock returned an invalid time");
  return now;
}

function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableSerialize).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + stableSerialize(value[key]))
      .join(",") +
    "}"
  );
}

function cloneJson(value, name) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_error) {
    throw new TypeError(name + " is not JSON serializable");
  }
  if (serialized === undefined) throw new TypeError(name + " is not JSON serializable");
  const clone = JSON.parse(serialized);
  if (!isDeepStrictEqual(value, clone)) throw new TypeError(name + " is not losslessly JSON serializable");
  return clone;
}

function hashScope(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(String(Buffer.byteLength(value, "utf8")), "ascii");
    hash.update(":", "ascii");
    hash.update(value, "utf8");
    hash.update("\0", "ascii");
  }
  return hash.digest("hex");
}

function normalizeCollection(collection) {
  if (!collection || typeof collection !== "object") {
    throw new TypeError("provider collection is invalid");
  }
  if (!Number.isSafeInteger(collection.revision) || collection.revision < 0) {
    throw new TypeError("provider collection revision is invalid");
  }
  if (!Array.isArray(collection.providers) || collection.providers.length > MAX_PROVIDERS) {
    throw new TypeError("provider collection is invalid");
  }
  const providers = collection.providers.map((selection, index) => {
    if (!isPlainObject(selection) || !isPlainObject(selection.descriptor)) {
      throw new TypeError("provider selection is invalid");
    }
    return {
      providerId: assertIdentifier(selection.providerId, "provider id"),
      ordinal:
        Number.isSafeInteger(selection.ordinal) && selection.ordinal >= 0
          ? selection.ordinal
          : index,
      descriptor: selection.descriptor,
      originalIndex: index,
    };
  });
  providers.sort((left, right) => left.ordinal - right.ordinal || left.originalIndex - right.originalIndex);
  return { revision: collection.revision, providers };
}

function sourceKind(stream) {
  if (!isPlainObject(stream)) return "unknown";
  if (Object.prototype.hasOwnProperty.call(stream, "url")) return "url";
  if (Object.prototype.hasOwnProperty.call(stream, "ytId")) return "youtube";
  if (["rarUrls", "zipUrls", "7zipUrls", "tgzUrls", "tarUrls"].some((key) => Object.prototype.hasOwnProperty.call(stream, key))) {
    return "archive";
  }
  if (Object.prototype.hasOwnProperty.call(stream, "nzbUrl") || Object.prototype.hasOwnProperty.call(stream, "nzbUrls")) {
    return "nzb";
  }
  if (Object.prototype.hasOwnProperty.call(stream, "infoHash")) return "torrent";
  if (Object.prototype.hasOwnProperty.call(stream, "playerFrameUrl")) return "player-frame";
  if (["externalUrl", "androidTvUrl", "tizenUrl", "webosUrl"].some((key) => Object.prototype.hasOwnProperty.call(stream, key))) {
    return "external";
  }
  return "unknown";
}

function buildPlaybackIdentity(request) {
  const contentKey = hashScope("stremio", request.type, request.id);
  let canonicalIdentity = null;
  let season = null;
  let episode = null;
  const movie = request.type === "movie" ? request.id.match(/^(tt\d{7,})$/) : null;
  const series = request.type === "series" ? request.id.match(/^(tt\d{7,}):(\d+):(\d+)$/) : null;

  if (movie) {
    canonicalIdentity = {
      provider: "imdb",
      id: movie[1],
      mediaType: "movie",
      provenance: "metadata-request",
      confidence: "canonical",
    };
  } else if (series) {
    season = Number(series[2]);
    episode = Number(series[3]);
    if (Number.isSafeInteger(season) && Number.isSafeInteger(episode)) {
      canonicalIdentity = {
        provider: "imdb",
        id: series[1],
        mediaType: "episode",
        season,
        episode,
        provenance: "metadata-request",
        confidence: "canonical",
      };
    } else {
      season = null;
      episode = null;
    }
  }

  return {
    contentKey,
    canonicalIdentity,
    traktEligible: canonicalIdentity !== null,
    season,
    episode,
  };
}

function privateStreamBehaviorHints(stream) {
  if (!isPlainObject(stream) || !isPlainObject(stream.behaviorHints)) return {};
  const hints = stream.behaviorHints;
  const request = {};
  if (
    typeof hints.videoHash === "string" &&
    hints.videoHash.length > 0 &&
    hints.videoHash.length <= 256 &&
    hints.videoHash.trim() === hints.videoHash &&
    !/[\u0000-\u001f\u007f]/.test(hints.videoHash)
  ) {
    request.videoHash = hints.videoHash;
  }
  if (Number.isSafeInteger(hints.videoSize) && hints.videoSize > 0) {
    request.videoSize = hints.videoSize;
  }
  if (
    typeof hints.filename === "string" &&
    hints.filename.length > 0 &&
    hints.filename.length <= 2048 &&
    hints.filename.trim() === hints.filename &&
    !/[\u0000-\u001f\u007f]/.test(hints.filename)
  ) {
    request.filename = hints.filename;
  }
  return request;
}

function createPlaybackContext(request, stream, providerId, display = {}) {
  const identity = buildPlaybackIdentity(request);
  const fingerprints = fingerprintStream(stream);
  if (fingerprints.length === 0) {
    throw new TypeError("stream does not contain a playable source");
  }
  return {
    schemaVersion: 1,
    contentKey: identity.contentKey,
    canonicalIdentity: identity.canonicalIdentity,
    traktEligible: identity.traktEligible,
    request: {
      resource: request.resource,
      type: request.type,
      metaId: request.id,
      videoId: request.id,
      metaProvider: identity.canonicalIdentity ? "imdb" : "stremio",
      streamProvider: providerId,
      ...privateStreamBehaviorHints(stream),
    },
    display: {
      title: typeof display.title === "string" ? display.title : "",
      year: Number.isSafeInteger(display.year) ? display.year : null,
      season: identity.season,
      episode: identity.episode,
      poster: typeof display.poster === "string" && display.poster ? display.poster : null,
      background: typeof display.background === "string" && display.background ? display.background : null,
      logo: typeof display.logo === "string" && display.logo ? display.logo : null,
    },
    source: { type: sourceKind(stream), provider: providerId },
    fingerprints,
    inlineSubtitles: Array.isArray(stream.subtitles) ? stream.subtitles : [],
  };
}

function responseItems(resource, response) {
  return resource === "stream" ? response.streams : response.subtitles;
}

function providerErrorCode(error) {
  if (error && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)) {
    return error.code;
  }
  return "provider_failed";
}

function gatewayCancellationError(signal) {
  return signal && signal.reason === PROFILE_CLEARED_REASON
    ? new ProfileClearedError()
    : new ProviderGatewayError("gateway_aborted", "gateway request was canceled");
}

function throwIfGatewayAborted(signal) {
  if (signal && signal.aborted) throw gatewayCancellationError(signal);
}

function assertOptionalAbortSignal(signal) {
  if (
    signal !== undefined &&
    signal !== null &&
    (typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    throw new TypeError("gateway query signal is invalid");
  }
  return signal || null;
}

function waitForGatewayOperation(operation, signal) {
  const pending = Promise.resolve(operation);
  if (!signal) return pending;
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.reject(gatewayCancellationError(signal));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, gatewayCancellationError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
    if (signal.aborted) onAbort();
  });
}

function runGatewayOperation(factory, signal) {
  throwIfGatewayAborted(signal);
  let operation;
  try {
    operation = factory();
  } catch (error) {
    if (signal && signal.aborted) return Promise.reject(gatewayCancellationError(signal));
    return Promise.reject(error);
  }
  return waitForGatewayOperation(operation, signal);
}

function createOperationSignal(callerSignal, profileEpoch) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(CALLER_ABORT_REASON);
  const onProfileClear = () => controller.abort(PROFILE_CLEARED_REASON);
  if (callerSignal) {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  if (!profileEpoch.cleared) profileEpoch.operations.add(controller);
  if (callerSignal && callerSignal.aborted) onCallerAbort();
  else if (profileEpoch.cleared) onProfileClear();
  return {
    signal: controller.signal,
    cleanup() {
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
      profileEpoch.operations.delete(controller);
    },
  };
}

function isBreakerNeutralError(error) {
  return Boolean(
    error &&
      (error.name === "AbortError" || BREAKER_NEUTRAL_ERROR_CODES.has(String(error.code || "")))
  );
}

function subtitleDedupeKey(subtitle) {
  if (typeof subtitle.url === "string" && subtitle.url) {
    return stableSerialize([
      "url",
      subtitle.url,
      typeof subtitle.lang === "string" ? subtitle.lang : "",
      typeof subtitle.id === "string" ? subtitle.id : "",
    ]);
  }
  return "json:" + stableSerialize(subtitle);
}

function boundedJsonItems(value, maxItems, maxBytes) {
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderGatewayError("provider_response_invalid", "provider response items must be an array");
  }
  const items = [];
  let bytes = 2;
  for (const item of value) {
    if (items.length >= maxItems) break;
    if (!isPlainObject(item)) {
      throw new ProviderGatewayError("provider_response_invalid", "provider response contains a malformed item");
    }
    let serialized;
    try {
      serialized = JSON.stringify(item);
    } catch (_error) {
      throw new ProviderGatewayError("provider_response_invalid", "provider response item is not JSON serializable");
    }
    if (serialized === undefined) {
      throw new ProviderGatewayError("provider_response_invalid", "provider response item is not JSON serializable");
    }
    const itemBytes = Buffer.byteLength(serialized, "utf8") + 1;
    if (bytes + itemBytes > maxBytes) break;
    bytes += itemBytes;
    items.push(item);
  }
  return items;
}

function normalizeBoundedProviderResponse(protocol, resource, response, maxItems, maxBytes) {
  if (!isPlainObject(response)) {
    throw new ProviderGatewayError("provider_response_invalid", "provider response root must be an object");
  }
  const root = resource === "stream" ? "streams" : "subtitles";
  if (protocol === "v3" || protocol === "standard") {
    if (!Object.prototype.hasOwnProperty.call(response, root)) {
      throw new ProviderGatewayError("provider_response_invalid", "provider response has the wrong root");
    }
    return normalizeProviderResponse(protocol, resource, {
      [root]: boundedJsonItems(response[root], maxItems, maxBytes),
    });
  }
  if (protocol === "legacy") {
    if (Object.prototype.hasOwnProperty.call(response, "error")) {
      return normalizeProviderResponse(protocol, resource, { error: response.error });
    }
    if (!Object.prototype.hasOwnProperty.call(response, "result")) {
      throw new ProviderGatewayError("provider_response_invalid", "legacy provider response has the wrong root");
    }
    if (resource === "stream") {
      return normalizeProviderResponse(protocol, resource, {
        result: boundedJsonItems(response.result, maxItems, maxBytes),
      });
    }
    if (!isPlainObject(response.result)) {
      throw new ProviderGatewayError("provider_response_invalid", "legacy subtitles result is malformed");
    }
    return normalizeProviderResponse(protocol, resource, {
      result: {
        id: response.result.id,
        all: boundedJsonItems(response.result.all, maxItems, maxBytes),
      },
    });
  }
  throw new ProviderGatewayError("provider_response_invalid", "provider response protocol is unsupported");
}

function privateSubtitleLanguage(value) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 35 ||
    value.trim() !== value ||
    !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(value)
  ) {
    return "und";
  }
  return value.replaceAll("_", "-").toLowerCase();
}

function privateSubtitleFormat(parsed) {
  const match = parsed.pathname.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  if (!match) return "unknown";
  const extension = match[1];
  if (["srt", "vtt", "ass", "ssa", "smi", "sami", "sub", "txt"].includes(extension)) {
    return extension;
  }
  if (extension === "idx") return "idx";
  if (["zip", "gz", "gzip"].includes(extension)) return "archive";
  return "unknown";
}

function normalizePrivateSubtitleCandidate(providerId, value) {
  const scopedProviderId = assertIdentifier(providerId, "subtitle provider id");
  if (!isPlainObject(value) || typeof value.url !== "string") return null;
  try {
    const source = normalizeSubtitleSourceCapability({
      v: 1,
      url: value.url,
      ...(value.headers === undefined ? {} : { headers: value.headers }),
    });
    const format = privateSubtitleFormat(source.parsed);
    // A single .sub URL is ambiguous between text and VobSub binary, and the
    // paired .idx may have been removed by provider response bounds. Capability
    // v1 cannot persist two URL/header resources, so reject both direct forms.
    if (format === "idx" || format === "sub") return null;
    return Object.freeze({
      providerId: scopedProviderId,
      sourceCapability: Object.freeze({
        url: source.url,
        headers: Object.freeze({ ...source.headers }),
      }),
      display: Object.freeze({
        language: privateSubtitleLanguage(value.lang),
        format,
      }),
    });
  } catch (_error) {
    return null;
  }
}

function normalizePrivateSubtitleCandidates(providerId, values) {
  if (!Array.isArray(values)) throw new TypeError("private subtitle candidates must be an array");
  const candidates = [];
  for (const value of values) {
    const candidate = normalizePrivateSubtitleCandidate(providerId, value);
    if (candidate) candidates.push(candidate);
  }
  return Object.freeze(candidates);
}

class ProviderGatewayService {
  constructor(options = {}) {
    if (
      !options.playbackContexts ||
      typeof options.playbackContexts.record !== "function" ||
      typeof options.playbackContexts.getProfileGeneration !== "function" ||
      typeof options.playbackContexts.invalidateProfile !== "function"
    ) {
      throw new TypeError("playbackContexts repository is required");
    }
    this._providerCollections = resolveProviderCollectionCoordinator(options);
    this._playbackContexts = options.playbackContexts;
    this._fetchPolicy = options.fetchPolicy || new UpstreamFetchPolicy(options.fetchOptions);
    if (!this._fetchPolicy || typeof this._fetchPolicy.fetchJson !== "function") {
      throw new TypeError("fetchPolicy must provide fetchJson()");
    }
    this._clock = options.clock || Date.now;
    if (typeof this._clock !== "function") throw new TypeError("clock must be a function");
    this._cacheTtlMs = readPositiveInteger(options.cacheTtlMs, "cacheTtlMs", DEFAULT_CACHE_TTL_MS, MAX_TIMER_MS);
    this._maxCacheEntries = readPositiveInteger(
      options.maxCacheEntries,
      "maxCacheEntries",
      DEFAULT_MAX_CACHE_ENTRIES,
      100_000
    );
    this._maxCacheBytes = readPositiveInteger(
      options.maxCacheBytes,
      "maxCacheBytes",
      DEFAULT_MAX_CACHE_BYTES,
      512 * 1024 * 1024
    );
    this._maxInFlightEntries = readPositiveInteger(
      options.maxInFlightEntries,
      "maxInFlightEntries",
      DEFAULT_MAX_IN_FLIGHT_ENTRIES,
      100_000
    );
    this._maxAggregateItems = readPositiveInteger(
      options.maxAggregateItems,
      "maxAggregateItems",
      DEFAULT_MAX_AGGREGATE_ITEMS,
      16_384
    );
    this._maxContextsPerProfile = readPositiveInteger(
      options.maxContextsPerProfile,
      "maxContextsPerProfile",
      DEFAULT_MAX_CONTEXTS_PER_PROFILE,
      100_000
    );
    this._maxStreamItems = readPositiveInteger(
      options.maxStreamItems,
      "maxStreamItems",
      options.maxAggregateItems === undefined
        ? Math.min(DEFAULT_MAX_STREAM_ITEMS, this._maxContextsPerProfile)
        : this._maxAggregateItems,
      16_384
    );
    if (this._maxStreamItems > this._maxContextsPerProfile) {
      throw new TypeError("maxStreamItems cannot exceed maxContextsPerProfile");
    }
    this._maxAggregateBytes = readPositiveInteger(
      options.maxAggregateBytes,
      "maxAggregateBytes",
      DEFAULT_MAX_AGGREGATE_BYTES,
      64 * 1024 * 1024
    );
    this._maxProviderConcurrency = readPositiveInteger(
      options.maxProviderConcurrency,
      "maxProviderConcurrency",
      DEFAULT_MAX_PROVIDER_CONCURRENCY,
      MAX_PROVIDERS
    );
    this._maxProviderQueueEntries = readPositiveInteger(
      options.maxProviderQueueEntries,
      "maxProviderQueueEntries",
      DEFAULT_MAX_PROVIDER_QUEUE_ENTRIES,
      100_000
    );
    this._failureThreshold = readPositiveInteger(
      options.failureThreshold,
      "failureThreshold",
      DEFAULT_FAILURE_THRESHOLD,
      100
    );
    this._breakerCooldownMs = readPositiveInteger(
      options.breakerCooldownMs,
      "breakerCooldownMs",
      DEFAULT_BREAKER_COOLDOWN_MS,
      MAX_TIMER_MS
    );
    this._maxBreakerEntries = readPositiveInteger(
      options.maxBreakerEntries,
      "maxBreakerEntries",
      DEFAULT_MAX_BREAKER_ENTRIES,
      100_000
    );
    this._onProviderError = options.onProviderError || (() => {});
    if (typeof this._onProviderError !== "function") throw new TypeError("onProviderError must be a function");
    this._contextFactory = options.contextFactory || createPlaybackContext;
    if (typeof this._contextFactory !== "function") throw new TypeError("contextFactory must be a function");
    this._cache = new Map();
    this._cacheBytes = 0;
    this._inFlight = new Map();
    this._profileEpochs = new Map();
    this._profileInvalidations = new Map();
    this._breakers = new Map();
    this._breakerProfiles = new Map();
    this._providerSchedulers = new Map();
  }

  async capabilities(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const authoritative = await this._readAuthoritativeProviderSnapshot(id);
    const collection = authoritative.collection;
    return {
      revision: collection.revision,
      ...computeAdvertisedCapabilities(collection.providers),
    };
  }

  async query(profileId, input, options = {}) {
    return this._query(profileId, input, options, false, false);
  }

  async queryWithSnapshot(profileId, input, options = {}) {
    return this._query(profileId, input, options, true, false);
  }

  async discoverSubtitles(profileId, input, options = {}) {
    return this._query(profileId, input, options, true, true);
  }

  async _query(profileId, input, options, includeSnapshot, privateSubtitles) {
    const id = assertIdentifier(profileId, "profile id");
    if (!isPlainObject(options)) throw new TypeError("gateway query options are invalid");
    const signal = assertOptionalAbortSignal(options.signal);
    throwIfGatewayAborted(signal);
    const request = normalizeResourceRequest(input);
    if (!SUPPORTED_RESOURCES.has(request.resource)) {
      throw new ProviderGatewayError("unsupported_resource", "gateway resource is unsupported");
    }
    if (privateSubtitles && request.resource !== "subtitles") {
      throw new ProviderGatewayError("unsupported_resource", "private discovery requires subtitles");
    }
    const profileScope = hashScope("profile", id);
    const projectResult = (response, snapshot = null) =>
      includeSnapshot ? { response, snapshot } : response;
    await this._waitForProfileInvalidation(profileScope, signal);
    throwIfGatewayAborted(signal);
    const profileEpoch = this._captureProfileEpoch(profileScope);
    let operation;
    try {
      operation = createOperationSignal(signal, profileEpoch);
    } catch (error) {
      this._releaseProfileEpoch(profileScope, profileEpoch);
      throw error;
    }
    const emptyResponse = request.resource === "stream"
      ? { streams: [] }
      : privateSubtitles
        ? { candidates: [] }
        : { subtitles: [] };
    try {
      const authoritative = await this._readAuthoritativeProviderSnapshot(
        id,
        operation.signal
      );
      const collection = authoritative.collection;
      const generation = authoritative.generation;
      throwIfGatewayAborted(operation.signal);
      if (!this._isCurrentProfileEpoch(profileScope, profileEpoch)) {
        return projectResult(emptyResponse);
      }
      const snapshot = Object.freeze({
        providerRevision: String(collection.revision),
        generation,
      });
      const breakerRevision = this._activateBreakerRevision(id, collection.revision);
      if (!breakerRevision) return projectResult(emptyResponse, snapshot);
      const selected = collection.providers.filter((provider) =>
        isProviderResourceSupported(provider.descriptor, request)
      );
      const cacheKey = this._cacheKey(id, collection.revision, generation, request);
      let providerResults = this._readCache(cacheKey);
      let fetched = null;
      if (!providerResults) {
        fetched = await runGatewayOperation(
          () => this._fetchSelectedCoalesced(
            cacheKey,
            profileScope,
            profileEpoch,
            id,
            collection.revision,
            request,
            selected,
            operation.signal,
            breakerRevision,
            !signal
          ),
          operation.signal
        );
        providerResults = fetched.results;
      }

      throwIfGatewayAborted(operation.signal);
      const bounded = this._boundResults(providerResults, request.resource);
      if (request.resource === "stream") {
        const streams = [];
        for (const provider of bounded) {
          for (const stream of provider.items) {
            throwIfGatewayAborted(operation.signal);
            try {
              const context = this._contextFactory(
                request,
                stream,
                provider.providerId,
                isPlainObject(options.display) ? options.display : {}
              );
              throwIfGatewayAborted(operation.signal);
              if (this._isCurrentProfileEpoch(profileScope, profileEpoch)) {
                await runGatewayOperation(
                  () =>
                    this._playbackContexts.record(id, context, {
                      generation,
                      providerRevision: snapshot.providerRevision,
                      signal: operation.signal,
                    }),
                  operation.signal
                );
              }
            } catch (error) {
              throwIfGatewayAborted(operation.signal);
              this._reportProviderError(id, provider.providerId, error, "context_record");
              continue;
            }
            throwIfGatewayAborted(operation.signal);
            streams.push(stream);
          }
        }
        throwIfGatewayAborted(operation.signal);
        this._writeFetchedCache(cacheKey, fetched, profileScope, profileEpoch);
        return projectResult({ streams }, snapshot);
      }

      if (privateSubtitles) {
        const candidates = [];
        for (const provider of bounded) {
          throwIfGatewayAborted(operation.signal);
          candidates.push(...normalizePrivateSubtitleCandidates(provider.providerId, provider.items));
        }
        throwIfGatewayAborted(operation.signal);
        this._writeFetchedCache(cacheKey, fetched, profileScope, profileEpoch);
        return projectResult({ candidates }, snapshot);
      }

      const subtitles = [];
      const seen = new Set();
      for (const provider of bounded) {
        for (const subtitle of provider.items) {
          throwIfGatewayAborted(operation.signal);
          const key = subtitleDedupeKey(subtitle);
          if (seen.has(key)) continue;
          seen.add(key);
          subtitles.push(subtitle);
        }
      }
      throwIfGatewayAborted(operation.signal);
      this._writeFetchedCache(cacheKey, fetched, profileScope, profileEpoch);
      return projectResult({ subtitles }, snapshot);
    } catch (error) {
      if (error instanceof ProfileClearedError) return projectResult(emptyResponse);
      throw error;
    } finally {
      operation.cleanup();
      this._releaseProfileEpoch(profileScope, profileEpoch);
    }
  }

  async clearProfile(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const scope = hashScope("profile", id);
    const previous = this._profileInvalidations.get(scope);
    this._clearLocalProfileState(scope);
    const transition = (async () => {
      if (previous) {
        try {
          await previous;
        } catch (_error) {
          // A later clear is an explicit retry of a failed invalidation.
        }
      }
      return this._providerCollections.invalidate(id);
    })();
    this._profileInvalidations.set(scope, transition);
    transition.then(
      () => {
        if (this._profileInvalidations.get(scope) === transition) {
          this._profileInvalidations.delete(scope);
        }
      },
      () => {}
    );
    return transition;
  }

  pruneCache() {
    const now = readClock(this._clock);
    let removed = 0;
    for (const [key, entry] of this._cache) {
      if (entry.expiresAt > now) continue;
      this._deleteCacheEntry(key, entry);
      removed += 1;
    }
    return removed;
  }

  _clearLocalProfileState(scope) {
    const epoch = this._profileEpochs.get(scope);
    this._profileEpochs.delete(scope);
    for (const [key, entry] of this._cache) {
      if (entry.profileScope === scope) this._deleteCacheEntry(key, entry);
    }
    for (const [key, entry] of this._inFlight) {
      if (entry.profileScope === scope) this._inFlight.delete(key);
    }
    for (const [key, entry] of this._breakers) {
      if (entry.profileScope === scope) this._breakers.delete(key);
    }
    this._breakerProfiles.delete(scope);
    if (epoch) {
      epoch.cleared = true;
      for (const controller of epoch.operations) {
        if (!controller.signal.aborted) controller.abort(PROFILE_CLEARED_REASON);
      }
      epoch.operations.clear();
    }
  }

  async _waitForProfileInvalidation(profileScope, signal) {
    while (true) {
      const transition = this._profileInvalidations.get(profileScope);
      if (!transition) return;
      await runGatewayOperation(() => transition, signal);
      if (this._profileInvalidations.get(profileScope) === transition) return;
    }
  }

  async _readAuthoritativeProviderSnapshot(profileId, signal) {
    try {
      const snapshot = await runGatewayOperation(
        () =>
          this._providerCollections.readSnapshot(
            profileId,
            signal ? { signal } : {}
          ),
        signal
      );
      return {
        collection: normalizeCollection(snapshot.collection),
        generation: snapshot.generation,
      };
    } catch (error) {
      if (!error || error.code !== "provider_snapshot_contention") throw error;
      throw new ProviderGatewayError(error.code, error.message);
    }
  }

  _captureProfileEpoch(profileScope) {
    let epoch = this._profileEpochs.get(profileScope);
    if (!epoch) {
      epoch = { active: 0, cleared: false, operations: new Set() };
      this._profileEpochs.set(profileScope, epoch);
    }
    epoch.active += 1;
    return epoch;
  }

  _isCurrentProfileEpoch(profileScope, epoch) {
    return this._profileEpochs.get(profileScope) === epoch;
  }

  _releaseProfileEpoch(profileScope, epoch) {
    epoch.active = Math.max(0, epoch.active - 1);
    if (epoch.active === 0 && this._isCurrentProfileEpoch(profileScope, epoch)) {
      this._profileEpochs.delete(profileScope);
      this._trimBreakerProfiles();
    }
  }

  _fetchSelectedCoalesced(
    cacheKey,
    profileScope,
    profileEpoch,
    profileId,
    revision,
    request,
    selected,
    signal,
    breakerRevision,
    coalesce
  ) {
    const run = () => this._fetchSelected(
      profileId,
      revision,
      request,
      selected,
      signal,
      breakerRevision
    );
    if (!coalesce) return run();

    const existing = this._inFlight.get(cacheKey);
    if (existing && existing.profileEpoch === profileEpoch) return existing.promise;
    if (existing) this._inFlight.delete(cacheKey);
    if (this._inFlight.size >= this._maxInFlightEntries) return run();

    const entry = { profileEpoch, profileScope, promise: null };
    entry.promise = run().finally(() => {
      if (this._inFlight.get(cacheKey) === entry) this._inFlight.delete(cacheKey);
    });
    this._inFlight.set(cacheKey, entry);
    return entry.promise;
  }

  async _fetchSelected(profileId, revision, request, selected, signal, breakerRevision) {
    throwIfGatewayAborted(signal);
    const attempts = [];
    let complete = true;
    try {
      for (const provider of selected) {
        const permit = this._takeBreakerPermit(
          profileId,
          revision,
          provider.providerId,
          breakerRevision
        );
        if (!permit) {
          complete = false;
          continue;
        }
        attempts.push({ provider, permit, outcome: null });
      }
    } catch (error) {
      for (const attempt of attempts) this._releaseProviderPermit(attempt.permit);
      throw error;
    }

    const batch = this._createProviderBatch(hashScope("profile", profileId), signal);
    try {
      await Promise.all(
        attempts.map(async (attempt) => {
          try {
            const value = await this._scheduleProvider(batch, () => {
              if (!this._isCurrentBreakerPermit(attempt.permit)) {
                throw new ProviderGatewayError(
                  "stale_provider_revision",
                  "provider revision became stale before admission"
                );
              }
              throwIfGatewayAborted(signal);
              return this._fetchProvider(profileId, attempt.provider, request, signal);
            });
            attempt.outcome = { status: "fulfilled", value };
          } catch (error) {
            attempt.outcome = { status: "rejected", reason: error };
          }
        })
      );
    } finally {
      this._closeProviderBatch(batch);
    }

    const results = [];
    const maxItems = request.resource === "stream"
      ? Math.min(this._maxAggregateItems, this._maxStreamItems)
      : this._maxAggregateItems;
    let retainedItems = 0;
    let retainedBytes = 2;
    const unresolved = new Set(attempts);
    try {
      throwIfGatewayAborted(signal);
      for (const attempt of attempts) {
        const outcome = attempt.outcome;
        if (!outcome) {
          complete = false;
          this._releaseProviderPermit(attempt.permit);
        } else if (outcome.status === "fulfilled" && this._isCurrentBreakerPermit(attempt.permit)) {
          try {
            let items = [];
            const remainingItems = maxItems - retainedItems;
            const remainingBytes = this._maxAggregateBytes - retainedBytes;
            if (remainingItems > 0 && remainingBytes >= 3) {
              const normalized = normalizeBoundedProviderResponse(
                outcome.value.protocol,
                request.resource,
                outcome.value.response,
                remainingItems,
                remainingBytes + 2
              );
              items = responseItems(request.resource, normalized);
              for (const item of items) {
                retainedItems += 1;
                retainedBytes += Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
              }
            }
            this._recordProviderSuccess(attempt.permit);
            if (items.length) {
              results.push({ providerId: attempt.provider.providerId, items });
            }
          } catch (error) {
            complete = false;
            if (isBreakerNeutralError(error)) this._releaseProviderPermit(attempt.permit);
            else this._recordProviderFailure(attempt.permit);
            this._reportProviderError(
              profileId,
              attempt.provider.providerId,
              error,
              "upstream_fetch"
            );
          }
        } else {
          complete = false;
          if (outcome.status === "fulfilled" || isBreakerNeutralError(outcome.reason)) {
            this._releaseProviderPermit(attempt.permit);
          } else {
            this._recordProviderFailure(attempt.permit);
          }
          this._reportProviderError(
            profileId,
            attempt.provider.providerId,
            outcome.status === "fulfilled"
              ? new ProviderGatewayError("stale_provider_revision", "provider revision became stale")
              : outcome.reason,
            "upstream_fetch"
          );
        }
        unresolved.delete(attempt);
      }
    } finally {
      for (const attempt of unresolved) this._releaseProviderPermit(attempt.permit);
    }
    throwIfGatewayAborted(signal);
    return { complete, results };
  }

  async _fetchProvider(profileId, provider, request, signal) {
    const upstream = buildProviderResourceRequest(provider.descriptor.transportUrl, request);
    const fetched = await this._fetchPolicy.fetchJson(upstream.url, {
      admissionKey: hashScope("profile", profileId),
      signal,
    });
    if (!fetched || !Object.prototype.hasOwnProperty.call(fetched, "value")) {
      throw new ProviderGatewayError("provider_response_invalid", "fetch policy returned an invalid response");
    }
    return { protocol: upstream.protocol, response: fetched.value };
  }

  _boundResults(providerResults, resource) {
    const results = [];
    let count = 0;
    let bytes = 2;
    const maxItems = resource === "stream"
      ? Math.min(this._maxAggregateItems, this._maxStreamItems)
      : this._maxAggregateItems;
    for (const provider of providerResults) {
      const items = [];
      for (const item of provider.items) {
        if (count >= maxItems) break;
        const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
        if (bytes + itemBytes > this._maxAggregateBytes) break;
        bytes += itemBytes;
        count += 1;
        items.push(item);
      }
      if (items.length) results.push({ providerId: provider.providerId, items });
      if (count >= maxItems || bytes >= this._maxAggregateBytes) break;
    }
    return results;
  }

  _cacheKey(profileId, revision, generation, request) {
    return hashScope("gateway-cache", profileId, revision, generation, stableSerialize(request));
  }

  _readCache(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    const now = readClock(this._clock);
    if (entry.expiresAt <= now) {
      this._deleteCacheEntry(key, entry);
      return null;
    }
    this._cache.delete(key);
    this._cache.set(key, entry);
    return cloneJson(entry.value, "gateway cache entry");
  }

  _writeFetchedCache(key, fetched, profileScope, profileEpoch) {
    if (
      !fetched ||
      !fetched.complete ||
      !this._isCurrentProfileEpoch(profileScope, profileEpoch)
    ) {
      return;
    }
    this._writeCache(key, fetched.results, profileScope);
  }

  _writeCache(key, value, profileScope) {
    const safeValue = cloneJson(value, "gateway cache entry");
    const bytes = Buffer.byteLength(JSON.stringify(safeValue), "utf8");
    if (bytes > this._maxCacheBytes) return;
    const now = readClock(this._clock);
    const existing = this._cache.get(key);
    if (existing && existing.expiresAt > now) return;
    if (existing) this._deleteCacheEntry(key, existing);
    const entry = {
      bytes,
      expiresAt: now + this._cacheTtlMs,
      profileScope,
      value: safeValue,
    };
    this._cache.set(key, entry);
    this._cacheBytes += bytes;
    while (this._cache.size > this._maxCacheEntries || this._cacheBytes > this._maxCacheBytes) {
      const oldest = this._cache.entries().next().value;
      if (!oldest) break;
      this._deleteCacheEntry(oldest[0], oldest[1]);
    }
  }

  _deleteCacheEntry(key, entry) {
    if (!this._cache.delete(key)) return;
    this._cacheBytes = Math.max(0, this._cacheBytes - entry.bytes);
  }

  _breakerKey(profileId, revision, providerId) {
    return hashScope("gateway-breaker", profileId, revision, providerId);
  }

  _activateBreakerRevision(profileId, revision) {
    const profileScope = hashScope("profile", profileId);
    const current = this._breakerProfiles.get(profileScope);
    if (current && revision < current.revision) return null;
    const revisionChanged = !current || current.revision < revision;
    for (const [key, state] of this._breakers) {
      if (
        state.profileScope === profileScope &&
        (revisionChanged || state.revision !== revision || state.marker !== current)
      ) {
        this._breakers.delete(key);
      }
    }

    const marker = current && current.revision === revision
      ? current
      : { profileScope, revision };
    this._breakerProfiles.delete(profileScope);
    this._breakerProfiles.set(profileScope, marker);
    this._trimBreakerProfiles();
    return marker;
  }

  _createProviderBatch(profileScope, signal) {
    const batch = {
      closed: false,
      jobs: new Set(),
      onAbort: null,
      profileScope,
      signal,
    };
    if (signal) {
      batch.onAbort = () => this._cancelProviderJobs(batch);
      signal.addEventListener("abort", batch.onAbort, { once: true });
      if (signal.aborted) batch.onAbort();
    }
    return batch;
  }

  _closeProviderBatch(batch) {
    if (batch.closed) return;
    batch.closed = true;
    if (batch.signal && batch.onAbort) {
      batch.signal.removeEventListener("abort", batch.onAbort);
    }
    this._cancelProviderJobs(batch);
  }

  _scheduleProvider(batch, factory) {
    throwIfGatewayAborted(batch.signal);
    let scheduler = this._providerSchedulers.get(batch.profileScope);
    if (!scheduler) {
      scheduler = { active: 0, queue: [] };
      this._providerSchedulers.set(batch.profileScope, scheduler);
    }
    if (
      scheduler.active >= this._maxProviderConcurrency &&
      scheduler.queue.length >= this._maxProviderQueueEntries
    ) {
      return Promise.reject(
        new ProviderGatewayError("upstream_queue_full", "profile provider queue is full")
      );
    }

    return new Promise((resolve, reject) => {
      const job = {
        batch,
        factory,
        publicSettled: false,
        reject,
        resolve,
        scheduler,
        state: "queued",
      };
      batch.jobs.add(job);
      if (scheduler.active < this._maxProviderConcurrency) this._startProviderJob(job);
      else scheduler.queue.push(job);
    });
  }

  _startProviderJob(job) {
    if (job.state !== "queued") return;
    if (job.batch.closed || (job.batch.signal && job.batch.signal.aborted)) {
      this._rejectQueuedProviderJob(job, gatewayCancellationError(job.batch.signal));
      return;
    }
    job.state = "active";
    job.scheduler.active += 1;
    Promise.resolve()
      .then(job.factory)
      .then(
        (value) => this._settleProviderJob(job, job.resolve, value),
        (error) => this._settleProviderJob(job, job.reject, error)
      )
      .finally(() => {
        job.state = "settled";
        job.batch.jobs.delete(job);
        job.scheduler.active = Math.max(0, job.scheduler.active - 1);
        this._drainProviderScheduler(job.batch.profileScope, job.scheduler);
      });
  }

  _rejectQueuedProviderJob(job, error) {
    if (job.state !== "queued") return;
    job.state = "settled";
    job.batch.jobs.delete(job);
    this._settleProviderJob(job, job.reject, error);
  }

  _settleProviderJob(job, settle, value) {
    if (job.publicSettled) return;
    job.publicSettled = true;
    settle(value);
  }

  _cancelProviderJobs(batch) {
    const scheduler = this._providerSchedulers.get(batch.profileScope);
    if (!scheduler) return;
    const error = gatewayCancellationError(batch.signal);
    const retained = [];
    for (const job of scheduler.queue) {
      if (job.batch === batch) {
        this._rejectQueuedProviderJob(job, error);
      } else {
        retained.push(job);
      }
    }
    scheduler.queue = retained;
    for (const job of batch.jobs) {
      if (job.state === "active") this._settleProviderJob(job, job.reject, error);
    }
    this._drainProviderScheduler(batch.profileScope, scheduler);
  }

  _drainProviderScheduler(profileScope, scheduler) {
    while (scheduler.active < this._maxProviderConcurrency && scheduler.queue.length > 0) {
      this._startProviderJob(scheduler.queue.shift());
    }
    if (scheduler.active === 0 && scheduler.queue.length === 0) {
      this._providerSchedulers.delete(profileScope);
    }
  }

  _trimBreakerProfiles() {
    while (this._breakerProfiles.size > this._maxBreakerEntries) {
      let oldest = null;
      for (const entry of this._breakerProfiles.entries()) {
        const epoch = this._profileEpochs.get(entry[0]);
        if (!epoch || epoch.active === 0) {
          oldest = entry;
          break;
        }
      }
      if (!oldest) break;
      this._breakerProfiles.delete(oldest[0]);
      for (const [key, state] of this._breakers) {
        if (state.profileScope === oldest[0]) this._breakers.delete(key);
      }
    }
  }

  _isCurrentBreakerPermit(permit) {
    return this._breakerProfiles.get(permit.profileScope) === permit.marker;
  }

  _touchBreakerState(key, state) {
    this._breakers.delete(key);
    this._breakers.set(key, state);
  }

  _trimBreakerStates() {
    while (this._breakers.size > this._maxBreakerEntries) {
      const oldest = this._breakers.entries().next().value;
      if (!oldest) break;
      this._breakers.delete(oldest[0]);
    }
  }

  _takeBreakerPermit(profileId, revision, providerId, marker) {
    const key = this._breakerKey(profileId, revision, providerId);
    const profileScope = hashScope("profile", profileId);
    const now = readClock(this._clock);
    if (
      !marker ||
      marker.profileScope !== profileScope ||
      marker.revision !== revision ||
      this._breakerProfiles.get(profileScope) !== marker
    ) {
      return null;
    }
    let state = this._breakers.get(key);
    if (state && state.marker !== marker) {
      this._breakers.delete(key);
      state = null;
    }
    if (!state) return { key, marker, profileScope, probe: false, revision };
    this._touchBreakerState(key, state);
    if (state.openUntil > now) return null;
    if (state.openUntil > 0) {
      if (state.probeInFlight) return null;
      state.probeInFlight = true;
      return { key, marker, profileScope, probe: true, revision };
    }
    return { key, marker, profileScope, probe: false, revision };
  }

  _recordProviderSuccess(permit) {
    if (!this._isCurrentBreakerPermit(permit)) return;
    this._breakers.delete(permit.key);
  }

  _recordProviderFailure(permit) {
    if (!this._isCurrentBreakerPermit(permit)) return;
    const now = readClock(this._clock);
    const previous = this._breakers.get(permit.key);
    const failures = permit.probe
      ? this._failureThreshold
      : Math.min(this._failureThreshold, (previous ? previous.failures : 0) + 1);
    this._touchBreakerState(permit.key, {
      failures,
      openUntil: failures >= this._failureThreshold ? now + this._breakerCooldownMs : 0,
      probeInFlight: false,
      marker: permit.marker,
      profileScope: permit.profileScope,
      revision: permit.revision,
    });
    this._trimBreakerStates();
  }

  _releaseProviderPermit(permit) {
    if (!this._isCurrentBreakerPermit(permit)) return;
    const state = this._breakers.get(permit.key);
    if (state && permit.probe) state.probeInFlight = false;
  }

  _reportProviderError(profileId, providerId, error, phase) {
    try {
      this._onProviderError({
        phase,
        profileScope: hashScope("profile", profileId).slice(0, 12),
        providerScope: hashScope("provider", providerId).slice(0, 12),
        code: providerErrorCode(error),
      });
    } catch (_error) {
      // Observability must never alter gateway behavior.
    }
  }
}

module.exports = {
  ProviderGatewayError,
  ProviderGatewayService,
  buildPlaybackIdentity,
  createPlaybackContext,
  normalizePrivateSubtitleCandidate,
  normalizePrivateSubtitleCandidates,
  sourceKind,
};
