"use strict";

const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");
const nodeFetch = require("node-fetch");

const DEFAULT_POLICY = Object.freeze({
  dnsTimeoutMs: 1500,
  admissionTimeoutMs: 2000,
  totalTimeoutMs: 8000,
  maxDecodedBytes: 1024 * 1024,
  maxWireBytes: 4 * 1024 * 1024,
  maxBinaryDecodedBytes: 8 * 1024 * 1024,
  maxContentEncodingRatio: 100,
  maxRedirects: 3,
  maxDnsAnswers: 16,
  maxConcurrent: 8,
  maxConcurrentPerKey: 4,
  maxQueued: 64,
  maxQueuedPerKey: 16,
});

const REDIRECT_STATUSES = Object.freeze(new Set([301, 302, 303, 307, 308]));
const HOP_BY_HOP_HEADERS = Object.freeze(
  new Set([
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ])
);
const POLICY_OWNED_HEADERS = Object.freeze(
  new Set(["host", "content-length", "accept-encoding"])
);
const SUPPORTED_CONTENT_ENCODINGS = Object.freeze(
  new Set(["identity", "gzip", "x-gzip", "deflate", "br"])
);
const POLICY_ERROR_MARKER = Symbol("upstreamPolicyError");

const IPV4_NON_GLOBAL_RANGES = createBinaryRanges(4, [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);

const IPV4_MAPPED_IPV6_RANGE = createBinaryRange(6, "::ffff:0:0", 96);
const IPV6_GLOBAL_UNICAST_RANGE = createBinaryRange(6, "2000::", 3);
const IPV6_NON_GLOBAL_RANGES = createBinaryRanges(6, [
  ["::", 96], // IPv4-compatible, unspecified, and loopback addresses.
  ["::ffff:0:0:0", 96], // IPv4-translatable addresses.
  ["64:ff9b::", 96], // Well-known IPv4/IPv6 translation prefix.
  ["64:ff9b:1::", 48], // Local-use IPv4/IPv6 translation prefix.
  ["100::", 64], // Discard-only prefix.
  ["100:0:0:1::", 64], // Dummy IPv6 prefix.
  ["2001::", 23], // IETF protocol assignments, including transition mechanisms.
  ["2001:db8::", 32], // Documentation.
  ["2002::", 16], // 6to4.
  ["2d00::", 8], // IANA-reserved global-unicast space.
  ["2e00::", 7], // IANA-reserved global-unicast space.
  ["3000::", 4], // IANA-reserved global-unicast space.
  ["3ffe::", 16], // Former 6bone space.
  ["3fff::", 20], // Documentation.
  ["5f00::", 16], // Segment-routing SIDs.
  ["fc00::", 7], // Unique-local.
  ["fe80::", 10], // Link-local.
  ["fec0::", 10], // Deprecated site-local.
  ["ff00::", 8], // Multicast.
]);

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  Object.defineProperty(error, POLICY_ERROR_MARKER, { value: true });
  return error;
}

function normalizeAdmissionKey(value) {
  if (value === undefined) return "default";
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new TypeError("admissionKey must be a bounded non-empty string");
  }
  return value;
}

function assertPositiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(name + " must be a bounded positive integer");
  }
  return value;
}

function readPerKeyLimit(value, name, globalLimit, defaultLimit, maximum) {
  const fallback = Math.min(defaultLimit, Math.max(1, Math.ceil(globalLimit / 2)));
  const limit = assertPositiveInteger(value ?? fallback, name, maximum);
  if (limit > globalLimit || (globalLimit > 1 && limit === globalLimit)) {
    throw new TypeError(name + " must reserve capacity within its global limit");
  }
  return limit;
}

function stripIpv6Brackets(value) {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function parseIpv4Bytes(address) {
  if (!net.isIPv4(address)) return null;
  return Uint8Array.from(address.split("."), (part) => Number(part));
}

function parseIpv6Words(segment) {
  if (!segment) return [];
  const words = [];
  for (const part of segment.split(":")) {
    if (part.includes(".")) {
      const ipv4 = parseIpv4Bytes(part);
      if (!ipv4) return null;
      words.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      continue;
    }
    if (!/^[a-f0-9]{1,4}$/i.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function parseIpv6Bytes(address) {
  if (!net.isIPv6(address)) return null;
  const compression = address.indexOf("::");
  let words;
  if (compression === -1) {
    words = parseIpv6Words(address);
    if (!words || words.length !== 8) return null;
  } else {
    const left = parseIpv6Words(address.slice(0, compression));
    const right = parseIpv6Words(address.slice(compression + 2));
    if (!left || !right) return null;
    const omittedWords = 8 - left.length - right.length;
    if (omittedWords < 1) return null;
    words = [...left, ...new Array(omittedWords).fill(0), ...right];
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < words.length; index += 1) {
    bytes[index * 2] = words[index] >>> 8;
    bytes[index * 2 + 1] = words[index] & 0xff;
  }
  return bytes;
}

function parseIpAddress(address) {
  const normalized = stripIpv6Brackets(String(address || "")).toLowerCase();
  if (!normalized || normalized.includes("%")) return null;
  const ipv4 = parseIpv4Bytes(normalized);
  if (ipv4) return { family: 4, bytes: ipv4 };
  const ipv6 = parseIpv6Bytes(normalized);
  return ipv6 ? { family: 6, bytes: ipv6 } : null;
}

function createBinaryRange(family, address, prefix) {
  const parsed = parseIpAddress(address);
  if (!parsed || parsed.family !== family) throw new Error("invalid internal IP range");
  return Object.freeze({ bytes: parsed.bytes, prefix });
}

function createBinaryRanges(family, ranges) {
  return Object.freeze(
    ranges.map(([address, prefix]) => createBinaryRange(family, address, prefix))
  );
}

function matchesBinaryPrefix(bytes, range) {
  if (bytes.length !== range.bytes.length) return false;
  const wholeBytes = Math.floor(range.prefix / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== range.bytes[index]) return false;
  }
  const remainingBits = range.prefix % 8;
  if (!remainingBits) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes] & mask) === (range.bytes[wholeBytes] & mask);
}

function isGlobalIpv4Bytes(bytes) {
  return !IPV4_NON_GLOBAL_RANGES.some((range) => matchesBinaryPrefix(bytes, range));
}

function isGlobalParsedAddress(parsed) {
  if (parsed.family === 4) return isGlobalIpv4Bytes(parsed.bytes);
  if (matchesBinaryPrefix(parsed.bytes, IPV4_MAPPED_IPV6_RANGE)) {
    return isGlobalIpv4Bytes(parsed.bytes.subarray(12));
  }
  return (
    matchesBinaryPrefix(parsed.bytes, IPV6_GLOBAL_UNICAST_RANGE) &&
    !IPV6_NON_GLOBAL_RANGES.some((range) => matchesBinaryPrefix(parsed.bytes, range))
  );
}

function isGlobalUnicastAddress(address) {
  const parsed = parseIpAddress(address);
  return parsed ? isGlobalParsedAddress(parsed) : false;
}

function validateEndpoint(rawUrl) {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl ||
    rawUrl.length > 8192 ||
    rawUrl.trim() !== rawUrl ||
    /[\u0000-\u001f\u007f]/.test(rawUrl)
  ) {
    throw policyError("upstream_url_invalid", "upstream URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_error) {
    throw policyError("upstream_url_invalid", "upstream URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw policyError("upstream_scheme_blocked", "upstream URL scheme is not allowed");
  }
  if (parsed.username || parsed.password) {
    throw policyError("upstream_credentials_blocked", "upstream URL credentials are not allowed");
  }
  if (parsed.hash) throw policyError("upstream_fragment_blocked", "upstream URL fragments are not allowed");
  const hostname = stripIpv6Brackets(parsed.hostname);
  if (!hostname || hostname.length > 253 || hostname.includes("%")) {
    throw policyError("upstream_host_invalid", "upstream hostname is invalid");
  }
  return Object.freeze({ rawUrl, parsed, hostname });
}

function raceWithAbort(promise, signal, code, message) {
  const operation = Promise.resolve(promise);
  if (!signal) return operation;
  if (signal.aborted) {
    operation.catch(() => {});
    return Promise.reject(policyError(code, message));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(policyError(code, message));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function createDeadlineSignal(callerSignal, timeoutMs) {
  const controller = new AbortController();
  let abortSource = null;
  const abort = (source) => {
    if (abortSource !== null) return;
    abortSource = source;
    controller.abort();
  };
  const onCallerAbort = () => {
    abort("caller");
  };
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => abort("timeout"), timeoutMs);
  return {
    signal: controller.signal,
    callerAborted: () => abortSource === "caller",
    timedOut: () => abortSource === "timeout",
    cleanup() {
      clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

function deadlinePolicyError(requestDeadline, admissionDeadline) {
  if (admissionDeadline && admissionDeadline.timedOut()) {
    return policyError("upstream_admission_timeout", "upstream admission timed out");
  }
  if (requestDeadline.callerAborted()) {
    return policyError("upstream_aborted", "upstream request was canceled");
  }
  if (admissionDeadline && requestDeadline.timedOut()) {
    return policyError("upstream_admission_timeout", "upstream admission timed out");
  }
  if (requestDeadline.timedOut()) {
    return policyError("upstream_timeout", "upstream request timed out");
  }
  return null;
}

function createPinnedLookup(expectedHostname, addresses) {
  const expected = String(expectedHostname).replace(/\.$/, "").toLowerCase();
  let cursor = 0;
  return (hostname, options, callback) => {
    const actual = String(hostname || "").replace(/\.$/, "").toLowerCase();
    if (actual !== expected) {
      callback(policyError("upstream_pin_mismatch", "pinned DNS hostname changed"));
      return;
    }
    const normalizedOptions = typeof options === "number" ? { family: options } : options || {};
    const family = Number(normalizedOptions.family) || 0;
    const eligible = addresses.filter((entry) => !family || entry.family === family);
    if (!eligible.length) {
      callback(policyError("upstream_dns_family", "pinned DNS family is unavailable"));
      return;
    }
    if (normalizedOptions.all) {
      callback(null, eligible.map((entry) => ({ address: entry.address, family: entry.family })));
      return;
    }
    const selected = eligible[cursor % eligible.length];
    cursor += 1;
    callback(null, selected.address, selected.family);
  };
}

async function resolveAndPin(rawUrl, options = {}) {
  const endpoint = validateEndpoint(rawUrl);
  const resolver = options.resolver || dns.promises.lookup.bind(dns.promises);
  const maxDnsAnswers = options.maxDnsAnswers ?? DEFAULT_POLICY.maxDnsAnswers;
  const dnsTimeoutMs = options.dnsTimeoutMs ?? DEFAULT_POLICY.dnsTimeoutMs;
  assertPositiveInteger(maxDnsAnswers, "maxDnsAnswers", 256);
  assertPositiveInteger(dnsTimeoutMs, "dnsTimeoutMs", 60000);

  let answers;
  const literalFamily = net.isIP(endpoint.hostname);
  if (literalFamily) {
    answers = [{ address: endpoint.hostname, family: literalFamily }];
  } else {
    const deadline = createDeadlineSignal(options.signal, dnsTimeoutMs);
    try {
      answers = await raceWithAbort(
        resolver(endpoint.hostname, { all: true, verbatim: true }),
        deadline.signal,
        "upstream_dns_timeout",
        "upstream DNS resolution timed out"
      );
    } catch (error) {
      if (deadline.signal.aborted && deadline.callerAborted()) {
        throw policyError("upstream_aborted", "upstream request was canceled");
      }
      throw error;
    } finally {
      deadline.cleanup();
    }
  }
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > maxDnsAnswers) {
    throw policyError("upstream_dns_invalid", "upstream DNS response is invalid");
  }
  const normalized = [];
  const seen = new Set();
  for (const answer of answers) {
    const address = stripIpv6Brackets(String(answer && answer.address ? answer.address : ""));
    const family = Number(answer && answer.family) || net.isIP(address);
    if ((family !== 4 && family !== 6) || net.isIP(address) !== family) {
      throw policyError("upstream_dns_invalid", "upstream DNS response is invalid");
    }
    if (!isGlobalUnicastAddress(address)) {
      throw policyError("upstream_address_blocked", "upstream resolved to a non-public address");
    }
    const key = family + ":" + address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(Object.freeze({ address, family }));
    }
  }
  return Object.freeze({
    ...endpoint,
    addresses: Object.freeze(normalized),
    lookup: createPinnedLookup(endpoint.hostname, normalized),
  });
}

class BoundedSemaphore {
  constructor(maxConcurrent, maxQueued, maxConcurrentPerKey, maxQueuedPerKey) {
    this._maxConcurrent = assertPositiveInteger(maxConcurrent, "maxConcurrent", 1024);
    this._maxQueued = assertPositiveInteger(maxQueued, "maxQueued", 100000);
    this._maxConcurrentPerKey = readPerKeyLimit(
      maxConcurrentPerKey,
      "maxConcurrentPerKey",
      this._maxConcurrent,
      DEFAULT_POLICY.maxConcurrentPerKey,
      1024
    );
    this._maxQueuedPerKey = readPerKeyLimit(
      maxQueuedPerKey,
      "maxQueuedPerKey",
      this._maxQueued,
      DEFAULT_POLICY.maxQueuedPerKey,
      100000
    );
    this._active = 0;
    this._queued = 0;
    this._queueGroups = [];
    this._groupsByKey = new Map();
  }

  acquire(signal, admissionKey) {
    if (signal && signal.aborted) {
      return Promise.reject(policyError("upstream_aborted", "upstream request was canceled"));
    }
    const key = normalizeAdmissionKey(admissionKey);
    let group = this._groupsByKey.get(key);
    if (
      this._active < this._maxConcurrent &&
      (!group || group.active < this._maxConcurrentPerKey)
    ) {
      group = group || this._createGroup(key);
      return Promise.resolve(this._grant(group));
    }
    if (
      this._queued >= this._maxQueued ||
      (group && group.entries.length >= this._maxQueuedPerKey)
    ) {
      return Promise.reject(policyError("upstream_queue_full", "upstream request queue is full"));
    }
    return new Promise((resolve, reject) => {
      group = group || this._createGroup(key);
      const entry = { group, resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        if (this._removeQueuedEntry(entry)) {
          reject(policyError("upstream_aborted", "upstream request was canceled"));
        }
      };
      if (signal) signal.addEventListener("abort", entry.onAbort, { once: true });
      group.entries.push(entry);
      this._queued += 1;
      this._enqueueGroup(group);
      this._drainQueue();
    });
  }

  _createGroup(key) {
    const group = { key, active: 0, entries: [], inQueue: false };
    this._groupsByKey.set(key, group);
    return group;
  }

  _enqueueGroup(group) {
    if (group.inQueue || group.entries.length === 0) return;
    group.inQueue = true;
    this._queueGroups.push(group);
  }

  _removeQueuedEntry(entry) {
    const group = entry.group;
    const index = group.entries.indexOf(entry);
    if (index < 0) return false;
    group.entries.splice(index, 1);
    this._queued -= 1;
    if (entry.signal) entry.signal.removeEventListener("abort", entry.onAbort);
    if (group.entries.length === 0) this._removeGroupFromQueue(group);
    this._deleteGroupIfIdle(group);
    return true;
  }

  _removeGroupFromQueue(group) {
    if (!group.inQueue) return;
    group.inQueue = false;
    const index = this._queueGroups.indexOf(group);
    if (index >= 0) this._queueGroups.splice(index, 1);
  }

  _deleteGroupIfIdle(group) {
    if (group.active === 0 && group.entries.length === 0) {
      this._removeGroupFromQueue(group);
      if (this._groupsByKey.get(group.key) === group) this._groupsByKey.delete(group.key);
    }
  }

  _nextQueuedEntry() {
    let groupsRemaining = this._queueGroups.length;
    while (groupsRemaining > 0) {
      groupsRemaining -= 1;
      const group = this._queueGroups.shift();
      group.inQueue = false;
      if (group.active >= this._maxConcurrentPerKey) {
        this._enqueueGroup(group);
        continue;
      }

      let entry = null;
      while (group.entries.length > 0 && !entry) {
        const candidate = group.entries.shift();
        this._queued -= 1;
        if (candidate.signal) {
          candidate.signal.removeEventListener("abort", candidate.onAbort);
        }
        if (candidate.signal && candidate.signal.aborted) {
          candidate.reject(policyError("upstream_aborted", "upstream request was canceled"));
        } else {
          entry = candidate;
        }
      }
      this._enqueueGroup(group);
      if (entry) return entry;
      this._deleteGroupIfIdle(group);
    }
    return null;
  }

  _grant(group) {
    this._active += 1;
    group.active += 1;
    return this._releaseHandle(group);
  }

  _drainQueue() {
    while (this._active < this._maxConcurrent) {
      const entry = this._nextQueuedEntry();
      if (!entry) return;
      entry.resolve(this._grant(entry.group));
    }
  }

  _releaseHandle(group) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._active -= 1;
      group.active -= 1;
      this._deleteGroupIfIdle(group);
      this._drainQueue();
    };
  }
}

function assertPlainHeaderObject(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("upstreamHeaders must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("upstreamHeaders must be a plain object");
  }
  return value;
}

function normalizeHeaderName(value, label) {
  if (typeof value !== "string" || !/^[!#$%&'*+.^_|~0-9A-Za-z-]{1,128}$/.test(value)) {
    throw policyError("upstream_header_invalid", label + " contains an invalid header name");
  }
  return value.toLowerCase();
}

function assertForwardableHeaderName(name) {
  if (HOP_BY_HOP_HEADERS.has(name) || POLICY_OWNED_HEADERS.has(name)) {
    throw policyError("upstream_header_blocked", "upstream header is controlled by policy");
  }
}

function normalizeHeaderValue(value) {
  if (typeof value !== "string" || value.length > 8192) {
    throw policyError("upstream_header_invalid", "upstream header value is invalid");
  }
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
    throw policyError("upstream_header_invalid", "upstream header value contains controls");
  }
  return value;
}

function sanitizeForwardHeaders(upstreamHeaders, allowedHeaderNames) {
  const source = assertPlainHeaderObject(upstreamHeaders);
  if (allowedHeaderNames === undefined || allowedHeaderNames === null) {
    allowedHeaderNames = [];
  }
  if (!Array.isArray(allowedHeaderNames) || allowedHeaderNames.length > 32) {
    throw new TypeError("allowedHeaderNames must be a bounded array");
  }

  const allowed = new Set();
  for (const value of allowedHeaderNames) {
    const name = normalizeHeaderName(value, "allowedHeaderNames");
    assertForwardableHeaderName(name);
    allowed.add(name);
  }

  const forwarded = {};
  const seen = new Set();
  let totalBytes = 0;
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = normalizeHeaderName(rawName, "upstreamHeaders");
    assertForwardableHeaderName(name);
    if (seen.has(name)) {
      throw policyError("upstream_header_invalid", "upstream header names must be unique");
    }
    seen.add(name);
    const value = normalizeHeaderValue(rawValue);
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes > 32 * 1024) {
      throw policyError("upstream_header_invalid", "upstream headers exceed the byte limit");
    }
    if (allowed.has(name)) forwarded[name] = value;
  }
  return forwarded;
}

function readBoundedOption(value, fallback, name, maximum) {
  return assertPositiveInteger(value ?? fallback, name, maximum);
}

function readResponseHeader(response, name) {
  return response && response.headers && typeof response.headers.get === "function"
    ? response.headers.get(name)
    : null;
}

function destroyBody(body) {
  if (body && typeof body.destroy === "function" && !body.destroyed) body.destroy();
}

function readDeclaredLength(response, maximum, errorCode) {
  const raw = readResponseHeader(response, "content-length");
  if (raw === null || raw === undefined || raw === "") return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    destroyBody(response && response.body);
    throw policyError("upstream_content_length_invalid", "upstream content length is invalid");
  }
  const declared = Number(raw);
  if (!Number.isSafeInteger(declared) || declared > maximum) {
    destroyBody(response && response.body);
    throw policyError(errorCode, "upstream response exceeds the byte limit");
  }
  return declared;
}

async function readBoundedStream(body, maxBytes, signal, errorCode) {
  if (!body) return Buffer.alloc(0);
  const onAbort = () => destroyBody(body);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const read = (async () => {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        destroyBody(body);
        throw policyError(errorCode, "upstream response exceeds the byte limit");
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  })();
  try {
    return await raceWithAbort(
      read,
      signal,
      "upstream_timeout",
      "upstream response timed out"
    );
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function readDecodedBody(response, maxBytes, signal) {
  readDeclaredLength(response, maxBytes, "upstream_body_too_large");
  return readBoundedStream(response.body, maxBytes, signal, "upstream_body_too_large");
}

function normalizeContentEncoding(response) {
  const raw = String(readResponseHeader(response, "content-encoding") || "identity")
    .trim()
    .toLowerCase();
  if (!raw || raw.includes(",") || !SUPPORTED_CONTENT_ENCODINGS.has(raw)) {
    destroyBody(response && response.body);
    throw policyError(
      "upstream_content_encoding_blocked",
      "upstream content encoding is not supported"
    );
  }
  return raw;
}

function createContentDecoder(encoding) {
  if (encoding === "gzip" || encoding === "x-gzip") return zlib.createGunzip();
  if (encoding === "deflate") return zlib.createUnzip();
  if (encoding === "br") return zlib.createBrotliDecompress();
  return null;
}

async function decodeContentBody(wireBody, encoding, maxBytes, maxRatio, signal) {
  if (encoding === "identity") {
    if (wireBody.length > maxBytes) {
      throw policyError("upstream_decoded_body_too_large", "upstream response exceeds the byte limit");
    }
    return wireBody;
  }
  const decoder = createContentDecoder(encoding);
  const decodedLimit = Math.min(maxBytes, Math.max(1, wireBody.length) * maxRatio);
  const decodedStream = Readable.from([wireBody]).pipe(decoder);
  try {
    return await readBoundedStream(
      decodedStream,
      decodedLimit,
      signal,
      "upstream_decoded_body_too_large"
    );
  } catch (error) {
    if (error && error.code === "upstream_decoded_body_too_large") throw error;
    if (signal && signal.aborted) throw error;
    throw policyError(
      "upstream_content_encoding_invalid",
      "upstream content encoding could not be decoded"
    );
  } finally {
    destroyBody(decoder);
  }
}

function parseSafeContentType(response) {
  const raw = String(readResponseHeader(response, "content-type") || "");
  const [mediaTypePart, ...parameters] = raw.split(";");
  const mediaType = mediaTypePart.trim().toLowerCase();
  const safeMediaType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : null;
  let charset = null;
  for (const parameter of parameters) {
    const match = /^\s*charset\s*=\s*["']?([a-z0-9._-]{1,40})["']?\s*$/i.exec(parameter);
    if (match) {
      charset = match[1].toLowerCase();
      break;
    }
  }
  return { contentType: safeMediaType, charset };
}

class UpstreamFetchPolicy {
  constructor(options = {}) {
    this._fetch = options.fetch || nodeFetch;
    this._resolver = options.resolver || dns.promises.lookup.bind(dns.promises);
    this._policy = {
      dnsTimeoutMs: options.dnsTimeoutMs ?? DEFAULT_POLICY.dnsTimeoutMs,
      admissionTimeoutMs: options.admissionTimeoutMs ?? DEFAULT_POLICY.admissionTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs ?? DEFAULT_POLICY.totalTimeoutMs,
      maxDecodedBytes: options.maxDecodedBytes ?? DEFAULT_POLICY.maxDecodedBytes,
      maxWireBytes: options.maxWireBytes ?? DEFAULT_POLICY.maxWireBytes,
      maxBinaryDecodedBytes:
        options.maxBinaryDecodedBytes ?? DEFAULT_POLICY.maxBinaryDecodedBytes,
      maxContentEncodingRatio:
        options.maxContentEncodingRatio ?? DEFAULT_POLICY.maxContentEncodingRatio,
      maxRedirects: options.maxRedirects ?? DEFAULT_POLICY.maxRedirects,
      maxDnsAnswers: options.maxDnsAnswers ?? DEFAULT_POLICY.maxDnsAnswers,
    };
    assertPositiveInteger(this._policy.dnsTimeoutMs, "dnsTimeoutMs", 60000);
    assertPositiveInteger(this._policy.admissionTimeoutMs, "admissionTimeoutMs", 120000);
    assertPositiveInteger(this._policy.totalTimeoutMs, "totalTimeoutMs", 120000);
    assertPositiveInteger(this._policy.maxDecodedBytes, "maxDecodedBytes", 16 * 1024 * 1024);
    assertPositiveInteger(this._policy.maxWireBytes, "maxWireBytes", 32 * 1024 * 1024);
    assertPositiveInteger(
      this._policy.maxBinaryDecodedBytes,
      "maxBinaryDecodedBytes",
      64 * 1024 * 1024
    );
    assertPositiveInteger(
      this._policy.maxContentEncodingRatio,
      "maxContentEncodingRatio",
      1000
    );
    assertPositiveInteger(this._policy.maxRedirects + 1, "maxRedirects", 16);
    assertPositiveInteger(this._policy.maxDnsAnswers, "maxDnsAnswers", 256);
    this._semaphore = new BoundedSemaphore(
      options.maxConcurrent ?? DEFAULT_POLICY.maxConcurrent,
      options.maxQueued ?? DEFAULT_POLICY.maxQueued,
      options.maxConcurrentPerKey,
      options.maxQueuedPerKey
    );
  }

  async fetchJson(rawUrl, options = {}) {
    return this._withAdmission(options, (signal) => this._fetchJson(rawUrl, signal));
  }

  async fetchBuffer(rawUrl, options = {}) {
    const headers = sanitizeForwardHeaders(
      options.upstreamHeaders,
      options.allowedHeaderNames
    );
    const limits = {
      maxWireBytes: readBoundedOption(
        options.maxWireBytes,
        this._policy.maxWireBytes,
        "maxWireBytes",
        this._policy.maxWireBytes
      ),
      maxDecodedBytes: readBoundedOption(
        options.maxDecodedBytes,
        this._policy.maxBinaryDecodedBytes,
        "maxDecodedBytes",
        this._policy.maxBinaryDecodedBytes
      ),
      maxContentEncodingRatio: readBoundedOption(
        options.maxContentEncodingRatio,
        this._policy.maxContentEncodingRatio,
        "maxContentEncodingRatio",
        this._policy.maxContentEncodingRatio
      ),
    };
    const timeoutMs = readBoundedOption(
      options.timeoutMs,
      this._policy.totalTimeoutMs,
      "timeoutMs",
      this._policy.totalTimeoutMs
    );
    try {
      return await this._withAdmission(
        options,
        (signal) => this._fetchBuffer(rawUrl, signal, headers, limits),
        timeoutMs
      );
    } catch (error) {
      if (error && error[POLICY_ERROR_MARKER]) throw error;
      throw policyError("upstream_fetch_failed", "upstream request failed");
    }
  }

  async _withAdmission(options, operation, totalTimeoutMs = this._policy.totalTimeoutMs) {
    const admissionKey = normalizeAdmissionKey(options.admissionKey);
    const requestDeadline = createDeadlineSignal(options.signal, totalTimeoutMs);
    let release = null;
    try {
      const admission = createDeadlineSignal(
        requestDeadline.signal,
        this._policy.admissionTimeoutMs
      );
      try {
        try {
          release = await this._semaphore.acquire(admission.signal, admissionKey);
        } catch (error) {
          throw deadlinePolicyError(requestDeadline, admission) || error;
        }
        const admissionError = deadlinePolicyError(requestDeadline, admission);
        if (admissionError) throw admissionError;
      } finally {
        admission.cleanup();
      }

      try {
        return await operation(requestDeadline.signal);
      } catch (error) {
        throw deadlinePolicyError(requestDeadline) || error;
      }
    } finally {
      if (release) release();
      requestDeadline.cleanup();
    }
  }

  async _fetchJson(rawUrl, signal) {
    let current = validateEndpoint(rawUrl).rawUrl;
    let redirects = 0;
    const visited = new Set();
    while (true) {
      const pinned = await resolveAndPin(current, {
        resolver: this._resolver,
        signal,
        dnsTimeoutMs: this._policy.dnsTimeoutMs,
        maxDnsAnswers: this._policy.maxDnsAnswers,
      });
      const canonical = pinned.parsed.href;
      if (visited.has(canonical)) throw policyError("upstream_redirect_loop", "upstream redirect loop detected");
      visited.add(canonical);
      const agent =
        pinned.parsed.protocol === "https:"
          ? new https.Agent({ keepAlive: false, lookup: pinned.lookup })
          : new http.Agent({ keepAlive: false, lookup: pinned.lookup });
      let response;
      try {
        response = await raceWithAbort(
          this._fetch(current, {
            method: "GET",
            redirect: "manual",
            compress: true,
            signal,
            agent,
            headers: { Accept: "application/json" },
          }),
          signal,
          "upstream_timeout",
          "upstream request timed out"
        );
        const status = Number(response && response.status);
        if (REDIRECT_STATUSES.has(status)) {
          destroyBody(response.body);
          if (redirects >= this._policy.maxRedirects) {
            throw policyError("upstream_redirect_limit", "upstream redirect limit exceeded");
          }
          const location = response.headers && response.headers.get("location");
          if (!location) throw policyError("upstream_redirect_invalid", "upstream redirect is invalid");
          const next = new URL(location, current).toString();
          const nextEndpoint = validateEndpoint(next);
          if (pinned.parsed.protocol === "https:" && nextEndpoint.parsed.protocol !== "https:") {
            throw policyError("upstream_redirect_downgrade", "HTTPS redirect downgrade is blocked");
          }
          current = nextEndpoint.rawUrl;
          redirects += 1;
          continue;
        }
        if (!Number.isInteger(status) || status < 200 || status >= 300) {
          destroyBody(response && response.body);
          throw policyError("upstream_http_status", "upstream returned a non-success status");
        }
        const body = await readDecodedBody(response, this._policy.maxDecodedBytes, signal);
        let value;
        try {
          value = JSON.parse(body.toString("utf8"));
        } catch (_error) {
          throw policyError("upstream_json_invalid", "upstream returned invalid JSON");
        }
        return { value, status, redirects };
      } finally {
        agent.destroy();
      }
    }
  }

  async _fetchBuffer(rawUrl, signal, forwardedHeaders, limits) {
    const initialEndpoint = validateEndpoint(rawUrl);
    let current = initialEndpoint.rawUrl;
    let redirects = 0;
    let forwardProviderHeaders = true;
    const visited = new Set();
    while (true) {
      const pinned = await resolveAndPin(current, {
        resolver: this._resolver,
        signal,
        dnsTimeoutMs: this._policy.dnsTimeoutMs,
        maxDnsAnswers: this._policy.maxDnsAnswers,
      });
      const canonical = pinned.parsed.href;
      if (visited.has(canonical)) {
        throw policyError("upstream_redirect_loop", "upstream redirect loop detected");
      }
      visited.add(canonical);
      const agent =
        pinned.parsed.protocol === "https:"
          ? new https.Agent({ keepAlive: false, lookup: pinned.lookup })
          : new http.Agent({ keepAlive: false, lookup: pinned.lookup });
      try {
        const requestHeaders = {
          accept: "*/*",
          ...(forwardProviderHeaders ? forwardedHeaders : {}),
          "accept-encoding": "gzip, deflate, br, identity",
        };
        const response = await raceWithAbort(
          this._fetch(current, {
            method: "GET",
            redirect: "manual",
            compress: false,
            signal,
            agent,
            headers: requestHeaders,
          }),
          signal,
          "upstream_timeout",
          "upstream request timed out"
        );
        const status = Number(response && response.status);
        if (REDIRECT_STATUSES.has(status)) {
          destroyBody(response.body);
          if (redirects >= this._policy.maxRedirects) {
            throw policyError("upstream_redirect_limit", "upstream redirect limit exceeded");
          }
          const location = readResponseHeader(response, "location");
          if (!location) {
            throw policyError("upstream_redirect_invalid", "upstream redirect is invalid");
          }
          let nextEndpoint;
          try {
            nextEndpoint = validateEndpoint(new URL(location, current).toString());
          } catch (error) {
            if (error && typeof error.code === "string") throw error;
            throw policyError("upstream_redirect_invalid", "upstream redirect is invalid");
          }
          if (pinned.parsed.protocol === "https:" && nextEndpoint.parsed.protocol !== "https:") {
            throw policyError("upstream_redirect_downgrade", "HTTPS redirect downgrade is blocked");
          }
          if (nextEndpoint.parsed.origin !== pinned.parsed.origin) {
            forwardProviderHeaders = false;
          }
          current = nextEndpoint.rawUrl;
          redirects += 1;
          continue;
        }
        if (!Number.isInteger(status) || status < 200 || status >= 300) {
          destroyBody(response && response.body);
          throw policyError("upstream_http_status", "upstream returned a non-success status");
        }

        const encoding = normalizeContentEncoding(response);
        const declaredLength = readDeclaredLength(
          response,
          limits.maxWireBytes,
          "upstream_wire_body_too_large"
        );
        const wireBody = await readBoundedStream(
          response.body,
          limits.maxWireBytes,
          signal,
          "upstream_wire_body_too_large"
        );
        if (declaredLength !== null && wireBody.length !== declaredLength) {
          throw policyError(
            "upstream_content_length_invalid",
            "upstream content length does not match the response body"
          );
        }
        const body = await decodeContentBody(
          wireBody,
          encoding,
          limits.maxDecodedBytes,
          limits.maxContentEncodingRatio,
          signal
        );
        const metadata = parseSafeContentType(response);
        return { body, status, redirects, ...metadata };
      } finally {
        agent.destroy();
      }
    }
  }
}

module.exports = {
  DEFAULT_POLICY,
  UpstreamFetchPolicy,
  createPinnedLookup,
  isGlobalUnicastAddress,
  resolveAndPin,
  sanitizeForwardHeaders,
  validateEndpoint,
};
