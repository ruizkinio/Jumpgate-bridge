"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const https = require("node:https");
const path = require("node:path");

const ALGORITHM = "AWS4-HMAC-SHA256";
const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");
const CANARY = Buffer.from([0xa5]);
const CANARY_SHA256 = crypto.createHash("sha256").update(CANARY).digest("hex");
const CANARY_CHECKSUM = Buffer.from(CANARY_SHA256, "hex").toString("base64");
const ERASURE_CANARY = Buffer.from([0x5a]);
const ERASURE_CANARY_SHA256 = crypto
  .createHash("sha256")
  .update(ERASURE_CANARY)
  .digest("hex");
const ERASURE_CANARY_CHECKSUM = Buffer.from(ERASURE_CANARY_SHA256, "hex").toString(
  "base64"
);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const OWNER_ID = "jumpgate-ci-private-owner";
const PRIVACY_VERSION_ID = "jumpgate-ci-privacy-1";
const HARNESS_LOG_SCHEMA = "jumpgate-s3-harness-v2";
const PUT_ATTEMPT_HEADER = "x-amz-meta-jumpgate-put-attempt";
const PUT_ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OPAQUE_COMPONENT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const REQUIRED_SIGNED_HEADERS = Object.freeze([
  "host",
  "x-amz-content-sha256",
  "x-amz-date",
]);
const PUT_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  "content-type": "application/octet-stream",
  "if-none-match": "*",
  "x-amz-checksum-sha256": CANARY_CHECKSUM,
  "x-amz-meta-jumpgate-content-length": "1",
  "x-amz-meta-jumpgate-schema": "1",
  "x-amz-meta-jumpgate-sha256": CANARY_SHA256,
  "x-amz-server-side-encryption": "AES256",
});
const ERASURE_PUT_HEADERS = Object.freeze({
  ...PUT_HEADERS,
  "x-amz-checksum-sha256": ERASURE_CANARY_CHECKSUM,
  "x-amz-meta-jumpgate-sha256": ERASURE_CANARY_SHA256,
});
// AWS's SigV4 signer treats Cache-Control as unsignable, so validate its value
// exactly but require signatures for every integrity-bearing PUT header.
const SIGNED_PUT_HEADERS = Object.freeze(
  Object.keys(PUT_HEADERS)
    .filter((name) => name !== "cache-control")
    .concat("content-length", PUT_ATTEMPT_HEADER)
    .sort()
);
const CHECKSUM_READ_HEADERS = Object.freeze({ "x-amz-checksum-mode": "ENABLED" });
const BASE_REQUEST_HEADERS = Object.freeze([
  "amz-sdk-invocation-id",
  "amz-sdk-request",
  "authorization",
  "connection",
  "host",
  "user-agent",
  "x-amz-content-sha256",
  "x-amz-date",
  "x-amz-user-agent",
]);
const OPERATION_HEADER_ALLOWLISTS = Object.freeze(
  Object.fromEntries(
    [
      ["HeadBucket", []],
      ["GetBucketAcl", []],
      ["GetBucketPolicyStatus", []],
      ["PutObject", [...Object.keys(PUT_HEADERS), PUT_ATTEMPT_HEADER, "content-length"]],
      [
        "PutErasureObject",
        [...Object.keys(ERASURE_PUT_HEADERS), PUT_ATTEMPT_HEADER, "content-length"],
      ],
      ["HeadObject", Object.keys(CHECKSUM_READ_HEADERS)],
      ["HeadErasureObject", Object.keys(CHECKSUM_READ_HEADERS)],
      ["GetObject", Object.keys(CHECKSUM_READ_HEADERS)],
      ["GetObjectAcl", []],
      ["ListObjectVersions", []],
      ["DeleteObject", []],
    ].map(([operation, headers]) => [
      operation,
      Object.freeze([...new Set([...BASE_REQUEST_HEADERS, ...headers])].sort()),
    ])
  )
);

class ProtocolError extends Error {
  constructor(status, code, label) {
    super(label);
    this.name = "ProtocolError";
    this.status = status;
    this.code = code;
    this.label = label;
  }
}

function protocolError(status, code, label) {
  return new ProtocolError(status, code, label);
}

function isCanonicalOpaqueComponent(value) {
  if (typeof value !== "string" || !OPAQUE_COMPONENT_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value;
}

function readConfig(env = process.env) {
  const config = {
    accessKeyId: env.S3_HARNESS_ACCESS_KEY_ID,
    secretAccessKey: env.S3_HARNESS_SECRET_ACCESS_KEY,
    region: env.S3_HARNESS_REGION,
    bucket: env.S3_HARNESS_BUCKET,
    expectedObjectKey: env.S3_HARNESS_EXPECTED_OBJECT_KEY,
    expectedErasurePrefix: env.S3_HARNESS_EXPECTED_ERASURE_PREFIX,
    probeId: env.S3_HARNESS_PROBE_ID,
    publicAttestation: env.S3_HARNESS_PUBLIC_ATTESTATION === "1",
    publicDelayMs: Number(env.S3_HARNESS_PUBLIC_DELAY_MS),
    tlsCertFile: env.S3_HARNESS_TLS_CERT_FILE,
    tlsKeyFile: env.S3_HARNESS_TLS_KEY_FILE,
    port: Number(env.S3_HARNESS_PORT),
  };
  if (!/^[A-Za-z0-9]{16,128}$/.test(config.accessKeyId || "")) {
    throw new Error("invalid access key id");
  }
  if (
    typeof config.secretAccessKey !== "string" ||
    config.secretAccessKey.length < 32 ||
    config.secretAccessKey.length > 256 ||
    /[\r\n\0]/.test(config.secretAccessKey)
  ) {
    throw new Error("invalid secret access key");
  }
  if (config.region !== "auto") throw new Error("invalid region");
  if (
    !/^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(config.bucket || "")
  ) {
    throw new Error("invalid bucket");
  }
  const objectKeyMatch =
    /^subtitles\/v1\/[a-z][a-z0-9-]{0,31}\/([A-Za-z0-9_-]{43})\/([A-Za-z0-9_-]{43})$/.exec(
      config.expectedObjectKey || ""
    );
  if (
    !objectKeyMatch ||
    !isCanonicalOpaqueComponent(objectKeyMatch[1]) ||
    !isCanonicalOpaqueComponent(objectKeyMatch[2])
  ) {
    throw new Error("invalid expected object key");
  }
  const erasurePrefixMatch =
    /^subtitles\/v1\/[a-z][a-z0-9-]{0,31}\/([A-Za-z0-9_-]{43})\/$/.exec(
      config.expectedErasurePrefix || ""
    );
  if (
    !erasurePrefixMatch ||
    !isCanonicalOpaqueComponent(erasurePrefixMatch[1]) ||
    config.expectedObjectKey.startsWith(config.expectedErasurePrefix)
  ) {
    throw new Error("invalid expected erasure prefix");
  }
  if (!/^[a-f0-9]{32}$/.test(config.probeId || "")) {
    throw new Error("invalid probe id");
  }
  if (!new Set(["0", "1"]).has(env.S3_HARNESS_PUBLIC_ATTESTATION)) {
    throw new Error("invalid public attestation mode");
  }
  if (
    !Number.isSafeInteger(config.publicDelayMs) ||
    config.publicDelayMs < 0 ||
    config.publicDelayMs > 5000
  ) {
    throw new Error("invalid public attestation delay");
  }
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("invalid port");
  }
  for (const [name, filename] of [
    ["TLS certificate", config.tlsCertFile],
    ["TLS key", config.tlsKeyFile],
  ]) {
    if (typeof filename !== "string" || !path.isAbsolute(filename)) {
      throw new Error("invalid " + name);
    }
  }
  return Object.freeze(config);
}

function headerValue(request, name) {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw protocolError(400, "InvalidRequest", "header/" + name);
  }
  return value;
}

function rejectDuplicateHeaders(request) {
  const names = new Set();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index].toLowerCase();
    if (names.has(name)) throw protocolError(400, "InvalidRequest", "header/duplicate");
    names.add(name);
  }
}

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase()
  );
}

function parseTarget(rawTarget) {
  if (
    typeof rawTarget !== "string" ||
    rawTarget.length < 1 ||
    rawTarget.length > 2048 ||
    rawTarget.includes("#") ||
    /[\r\n\0\\]/.test(rawTarget)
  ) {
    throw protocolError(400, "InvalidURI", "target");
  }
  const separator = rawTarget.indexOf("?");
  const pathname = separator === -1 ? rawTarget : rawTarget.slice(0, separator);
  const rawQuery = separator === -1 ? "" : rawTarget.slice(separator + 1);
  if (separator !== -1 && rawQuery.length === 0) {
    throw protocolError(400, "InvalidArgument", "target/query");
  }
  if (!/^\/[A-Za-z0-9_\/-]*$/.test(pathname) || pathname.includes("//")) {
    throw protocolError(400, "InvalidURI", "target/path");
  }
  const query = [];
  if (rawQuery) {
    for (const pair of rawQuery.split("&")) {
      if (!pair) throw protocolError(400, "InvalidArgument", "target/query");
      const equals = pair.indexOf("=");
      const rawName = equals === -1 ? pair : pair.slice(0, equals);
      const rawValue = equals === -1 ? "" : pair.slice(equals + 1);
      if (!rawName || rawName.includes("+") || rawValue.includes("+")) {
        throw protocolError(400, "InvalidArgument", "target/query");
      }
      let name;
      let value;
      try {
        name = decodeURIComponent(rawName);
        value = decodeURIComponent(rawValue);
      } catch (_error) {
        throw protocolError(400, "InvalidArgument", "target/query");
      }
      query.push([awsEncode(name), awsEncode(value)]);
    }
  }
  query.sort((left, right) =>
    left[0] < right[0]
      ? -1
      : left[0] > right[0]
        ? 1
        : left[1] < right[1]
          ? -1
          : left[1] > right[1]
            ? 1
            : 0
  );
  return {
    pathname,
    canonicalQuery: query.map(([name, value]) => name + "=" + value).join("&"),
  };
}

function parseAuthorization(value) {
  const match = new RegExp(
    "^" +
      ALGORITHM +
      " Credential=([^/ ,]+)/([0-9]{8})/([a-z0-9-]+)/([a-z0-9-]+)/aws4_request, " +
      "SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$"
  ).exec(value);
  if (!match) throw protocolError(403, "SignatureDoesNotMatch", "sigv4/authorization");
  return {
    accessKeyId: match[1],
    date: match[2],
    region: match[3],
    service: match[4],
    signedHeadersText: match[5],
    signature: match[6],
  };
}

function parseAmzDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw protocolError(403, "RequestTimeTooSkewed", "sigv4/date");
  const numbers = match.slice(1).map(Number);
  const timestamp = Date.UTC(
    numbers[0],
    numbers[1] - 1,
    numbers[2],
    numbers[3],
    numbers[4],
    numbers[5]
  );
  const roundTrip = new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(".000", "");
  if (roundTrip !== value) throw protocolError(403, "RequestTimeTooSkewed", "sigv4/date");
  return timestamp;
}

function normalizedHeaderValue(value) {
  return value.trim().replace(/[\t ]+/g, " ");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function deriveSigningKey(secretAccessKey, date, region, service) {
  return hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, date), region), service), "aws4_request");
}

function isCanonicalPutAttempt(value) {
  return PUT_ATTEMPT_PATTERN.test(value || "") && isCanonicalOpaqueComponent(value);
}

function deriveSequenceId(probeId, ordinal) {
  if (!/^[a-f0-9]{32}$/.test(probeId || "") || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("invalid harness sequence identity input");
  }
  return crypto
    .createHash("sha256")
    .update("jumpgate-s3-harness-sequence-v1\0" + probeId + "\0" + ordinal, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function deriveObjectId(identity, role) {
  if (
    !/^[a-f0-9]{32}$/.test(identity || "") ||
    !new Set(["privacy", "erasure", "unbound"]).has(role)
  ) {
    throw new Error("invalid harness object identity input");
  }
  return crypto
    .createHash("sha256")
    .update("jumpgate-s3-harness-object-v1\0" + identity + "\0" + role, "utf8")
    .digest("hex");
}

function deriveResourceId(probeId, role, value) {
  if (
    !/^[a-f0-9]{32}$/.test(probeId || "") ||
    !new Set(["erasure-object", "erasure-scope"]).has(role) ||
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("invalid harness resource identity input");
  }
  return crypto
    .createHash("sha256")
    .update(
      "jumpgate-s3-harness-resource-v1\0" + probeId + "\0" + role + "\0" + value,
      "utf8"
    )
    .digest("hex");
}

function timingSafeHexEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function verifySigV4(request, body, target, config, now) {
  rejectDuplicateHeaders(request);
  const authorization = parseAuthorization(headerValue(request, "authorization"));
  if (authorization.accessKeyId !== config.accessKeyId) {
    throw protocolError(403, "InvalidAccessKeyId", "sigv4/access");
  }
  if (authorization.region !== "auto") {
    throw protocolError(403, "AuthorizationHeaderMalformed", "sigv4/region");
  }
  if (authorization.service !== "s3") {
    throw protocolError(403, "AuthorizationHeaderMalformed", "sigv4/service");
  }
  const amzDate = headerValue(request, "x-amz-date");
  const timestamp = parseAmzDate(amzDate);
  if (authorization.date !== amzDate.slice(0, 8)) {
    throw protocolError(403, "AuthorizationHeaderMalformed", "sigv4/scope-date");
  }
  if (Math.abs(now() - timestamp) > MAX_CLOCK_SKEW_MS) {
    throw protocolError(403, "RequestTimeTooSkewed", "sigv4/clock-skew");
  }

  const signedHeaders = authorization.signedHeadersText.split(";");
  if (
    signedHeaders.length < REQUIRED_SIGNED_HEADERS.length ||
    new Set(signedHeaders).size !== signedHeaders.length ||
    [...signedHeaders].sort().some((name, index) => name !== signedHeaders[index]) ||
    REQUIRED_SIGNED_HEADERS.some((name) => !signedHeaders.includes(name))
  ) {
    throw protocolError(403, "SignatureDoesNotMatch", "sigv4/signed-headers");
  }
  const canonicalHeaders = signedHeaders
    .map((name) => name + ":" + normalizedHeaderValue(headerValue(request, name)) + "\n")
    .join("");
  const payloadHash = headerValue(request, "x-amz-content-sha256");
  const actualPayloadHash = crypto.createHash("sha256").update(body).digest("hex");
  if (payloadHash !== actualPayloadHash) {
    throw protocolError(403, "XAmzContentSHA256Mismatch", "sigv4/payload");
  }
  const canonicalRequest = [
    request.method,
    target.pathname,
    target.canonicalQuery,
    canonicalHeaders,
    authorization.signedHeadersText,
    payloadHash,
  ].join("\n");
  const scope =
    authorization.date + "/" + authorization.region + "/" + authorization.service + "/aws4_request";
  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const expected = crypto
    .createHmac(
      "sha256",
      deriveSigningKey(
        config.secretAccessKey,
        authorization.date,
        authorization.region,
        authorization.service
      )
    )
    .update(stringToSign, "utf8")
    .digest("hex");
  if (!timingSafeHexEqual(expected, authorization.signature)) {
    throw protocolError(403, "SignatureDoesNotMatch", "sigv4/signature");
  }
  return new Set(signedHeaders);
}

function requireSigned(signedHeaders, names) {
  if (names.some((name) => !signedHeaders.has(name))) {
    throw protocolError(403, "SignatureDoesNotMatch", "sigv4/operation-headers");
  }
}

function validateOperationHeaders(operation, request, signedHeaders) {
  const allowed = OPERATION_HEADER_ALLOWLISTS[operation];
  if (!allowed) throw protocolError(405, "MethodNotAllowed", "operation/header-policy");
  const allowedNames = new Set(allowed);
  const receivedNames = Object.keys(request.headers);
  if (receivedNames.some((name) => !allowedNames.has(name))) {
    throw protocolError(400, "InvalidRequest", "header/not-allowed");
  }

  // The pinned AWS signer signs every x-amz header it emits, including its
  // user-agent. No x-amz signing exception is needed or accepted here.
  requireSigned(
    signedHeaders,
    receivedNames.filter((name) => name.startsWith("x-amz-"))
  );
  requireSigned(
    signedHeaders,
    receivedNames.filter(
      (name) => name === "amz-sdk-invocation-id" || name === "amz-sdk-request"
    )
  );
}

function scopedErasurePrefix(value, config) {
  if (typeof value !== "string" || !value.startsWith(config.expectedErasurePrefix)) {
    return null;
  }
  const suffix = value.slice(config.expectedErasurePrefix.length);
  if (!suffix.endsWith("/")) return null;
  const scope = suffix.slice(0, -1);
  return isCanonicalOpaqueComponent(scope) ? value : null;
}

function erasureObjectKey(pathname, config, expectedScopedPrefix = null) {
  const sharedPrefix = "/" + config.expectedErasurePrefix;
  if (!pathname.startsWith(sharedPrefix)) return null;
  const segments = pathname.slice(sharedPrefix.length).split("/");
  if (segments.length !== 3 || segments.some((segment) => !isCanonicalOpaqueComponent(segment))) {
    return null;
  }
  const actualScopedPrefix = config.expectedErasurePrefix + segments[0] + "/";
  if (
    expectedScopedPrefix !== null &&
    scopedErasurePrefix(expectedScopedPrefix, config) !== actualScopedPrefix
  ) {
    return null;
  }
  return config.expectedErasurePrefix + segments.join("/");
}

function erasureScopeForKey(key, config) {
  if (erasureObjectKey("/" + key, config) === null) return null;
  const suffix = key.slice(config.expectedErasurePrefix.length);
  const separator = suffix.indexOf("/");
  if (separator < 1) return null;
  return config.expectedErasurePrefix + suffix.slice(0, separator) + "/";
}

function listVersionsPrefix(query, config, expectedObjectKey = null) {
  const match = /^max-keys=1000&prefix=([^&]+)&versions=$/.exec(query);
  if (!match) return null;
  let prefix;
  try {
    prefix = decodeURIComponent(match[1]);
  } catch (_error) {
    return null;
  }
  if (awsEncode(prefix) !== match[1]) return null;
  const namespacePrefix = scopedErasurePrefix(prefix, config);
  if (namespacePrefix !== null) return namespacePrefix;
  const objectKey = erasureObjectKey("/" + prefix, config);
  if (objectKey === null) return null;
  return expectedObjectKey === null || objectKey === expectedObjectKey ? objectKey : null;
}

function getErasureSequence(versionState, sequenceId, create = false) {
  let authority = versionState.erasureSequences.get(sequenceId);
  if (!authority && create) {
    authority = {
      authorizedKeys: new Set(),
      putKey: null,
      scopeId: null,
      scopedPrefix: null,
    };
    versionState.erasureSequences.set(sequenceId, authority);
  }
  return authority || null;
}

function authorizedErasureObjectKey(pathname, config, versionState, sequenceId) {
  const key = erasureObjectKey(pathname, config);
  const authority = getErasureSequence(versionState, sequenceId);
  return key !== null && authority && authority.authorizedKeys.has(key) ? key : null;
}

function deleteVersionId(query) {
  const match = /^versionId=(jumpgate-ci-erasure-[1-9][0-9]*)&x-id=DeleteObject$/.exec(query);
  return match ? match[1] : null;
}

function headVersionId(query) {
  const match = /^versionId=(jumpgate-ci-(?:privacy|erasure)-[1-9][0-9]*)$/.exec(query);
  return match ? match[1] : null;
}

function getVersionId(query) {
  const match = /^versionId=(jumpgate-ci-privacy-[1-9][0-9]*)&x-id=GetObject$/.exec(query);
  return match ? match[1] : null;
}

function aclVersionId(query) {
  const match = /^acl=&versionId=(jumpgate-ci-privacy-[1-9][0-9]*)$/.exec(query);
  return match ? match[1] : null;
}

function operationVersionId(operation, query) {
  if (operation === "HeadObject" || operation === "HeadErasureObject") {
    return headVersionId(query);
  }
  if (operation === "GetObject") return getVersionId(query);
  if (operation === "GetObjectAcl") return aclVersionId(query);
  return null;
}

function requestVersionContext(operation, target) {
  let requestedVersionId = null;
  if (target) {
    requestedVersionId =
      operation === "DeleteObject"
        ? deleteVersionId(target.canonicalQuery)
        : operationVersionId(operation, target.canonicalQuery);
  }
  return {
    versionSelector: requestedVersionId === null ? "none" : "exact",
    requestedVersionId,
  };
}

function classifyOperation(request, target, config, versionState) {
  const host = headerValue(request, "host");
  const expectedHost = config.bucket + ".fly.storage.tigris.dev";
  if (host !== expectedHost) throw protocolError(404, "NoSuchBucket", "host");
  const query = target.canonicalQuery;
  if (target.pathname === "/") {
    if (request.method === "HEAD" && query === "") return "HeadBucket";
    if (request.method === "GET" && query === "acl=") return "GetBucketAcl";
    if (request.method === "GET" && query === "policyStatus=") {
      return "GetBucketPolicyStatus";
    }
    if (request.method === "GET") {
      if (listVersionsPrefix(query, config) !== null) return "ListObjectVersions";
    }
  }
  if (target.pathname === "/" + config.expectedObjectKey) {
    if (request.method === "PUT" && query === "x-id=PutObject") return "PutObject";
    if (request.method === "HEAD" && (query === "" || headVersionId(query))) {
      return "HeadObject";
    }
    if (request.method === "GET" && (query === "x-id=GetObject" || getVersionId(query))) {
      return "GetObject";
    }
    if (request.method === "GET" && (query === "acl=" || aclVersionId(query))) {
      return "GetObjectAcl";
    }
  }
  if (erasureObjectKey(target.pathname, config)) {
    if (request.method === "PUT" && query === "x-id=PutObject") {
      return "PutErasureObject";
    }
    const requestedVersionId = headVersionId(query);
    if (
      request.method === "HEAD" &&
      (query === "" || (requestedVersionId && requestedVersionId.startsWith("jumpgate-ci-erasure-")))
    ) {
      return "HeadErasureObject";
    }
    if (request.method === "DELETE" && deleteVersionId(query)) return "DeleteObject";
    throw protocolError(400, "InvalidRequest", "operation/erasure-object");
  }
  if (request.method === "DELETE") {
    throw protocolError(405, "MethodNotAllowed", "operation/delete");
  }
  if (target.pathname === "/" + config.expectedObjectKey) {
    throw protocolError(400, "InvalidRequest", "operation/object");
  }
  if (target.pathname === "/") {
    throw protocolError(400, "InvalidRequest", "operation/bucket");
  }
  throw protocolError(404, "NoSuchKey", "operation/key");
}

function validateOperation(operation, request, body, signedHeaders) {
  validateOperationHeaders(operation, request, signedHeaders);
  if (operation !== "PutObject" && operation !== "PutErasureObject") {
    if (body.length !== 0) throw protocolError(400, "InvalidRequest", "body/unexpected");
    if (
      operation === "HeadObject" ||
      operation === "HeadErasureObject" ||
      operation === "GetObject"
    ) {
      for (const [name, value] of Object.entries(CHECKSUM_READ_HEADERS)) {
        if (headerValue(request, name) !== value) {
          throw protocolError(400, "InvalidRequest", "object/checksum-mode");
        }
      }
      requireSigned(signedHeaders, Object.keys(CHECKSUM_READ_HEADERS));
    }
    return null;
  }
  const canary = operation === "PutObject" ? CANARY : ERASURE_CANARY;
  const putHeaders = operation === "PutObject" ? PUT_HEADERS : ERASURE_PUT_HEADERS;
  if (body.length !== 1 || body[0] !== canary[0]) {
    throw protocolError(400, "InvalidRequest", "canary/body");
  }
  for (const [name, value] of Object.entries(putHeaders)) {
    if (headerValue(request, name) !== value) {
      throw protocolError(400, "InvalidRequest", "canary/header");
    }
  }
  const putAttempt = headerValue(request, PUT_ATTEMPT_HEADER);
  if (!isCanonicalPutAttempt(putAttempt)) {
    throw protocolError(400, "InvalidRequest", "canary/put-attempt");
  }
  requireSigned(signedHeaders, SIGNED_PUT_HEADERS);
  if (request.headers["content-length"] !== "1" || request.headers["transfer-encoding"] !== undefined) {
    throw protocolError(400, "InvalidRequest", "canary/framing");
  }
  return putAttempt;
}

function aclXml() {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<AccessControlPolicy xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    "<Owner><ID>" + OWNER_ID + "</ID></Owner>" +
    '<AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">' +
    "<ID>" + OWNER_ID + "</ID></Grantee><Permission>FULL_CONTROL</Permission>" +
    "</Grant></AccessControlList></AccessControlPolicy>"
  );
}

function policyStatusXml(isPublic) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<PolicyStatus xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    "<IsPublic>" + String(isPublic) + "</IsPublic></PolicyStatus>"
  );
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function listVersionsXml(config, versionState, prefix) {
  const versions = [...versionState.objects.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, object]) =>
        "<Version><Key>" +
        xmlEscape(key) +
        "</Key><VersionId>" +
        xmlEscape(object.versionId) +
        "</VersionId><IsLatest>true</IsLatest><ETag>&quot;" +
        crypto.createHash("md5").update(ERASURE_CANARY).digest("hex") +
        "&quot;</ETag><Size>1</Size><StorageClass>STANDARD</StorageClass></Version>"
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
    "<Name>" +
    xmlEscape(config.bucket) +
    "</Name><Prefix>" +
    xmlEscape(prefix) +
    "</Prefix><MaxKeys>1000</MaxKeys>" +
    versions +
    "<IsTruncated>false</IsTruncated></ListVersionsResult>"
  );
}

function setRequestId(response) {
  response.setHeader("x-amz-request-id", "jumpgate-ci-s3-harness");
}

function sendXml(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/xml");
  response.setHeader("content-length", Buffer.byteLength(body));
  setRequestId(response);
  response.end(body);
}

function sendError(response, error, method) {
  const status = error instanceof ProtocolError ? error.status : 500;
  const code = error instanceof ProtocolError ? error.code : "InternalError";
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Error><Code>" + code + "</Code><Message>Request rejected</Message></Error>";
  response.statusCode = status;
  response.setHeader("content-type", "application/xml");
  response.setHeader("content-length", method === "HEAD" ? "0" : String(Buffer.byteLength(body)));
  setRequestId(response);
  response.end(method === "HEAD" ? undefined : body);
}

function setObjectHeaders(response, options = {}) {
  const canary = options.canary || CANARY;
  const headers = options.headers || PUT_HEADERS;
  if (!isCanonicalPutAttempt(options.putAttempt)) {
    throw protocolError(500, "InternalError", "state/put-attempt");
  }
  response.setHeader("cache-control", headers["cache-control"]);
  response.setHeader("content-type", headers["content-type"]);
  response.setHeader("content-length", "1");
  response.setHeader("etag", '"' + crypto.createHash("md5").update(canary).digest("hex") + '"');
  response.setHeader("x-amz-checksum-sha256", headers["x-amz-checksum-sha256"]);
  response.setHeader(
    "x-amz-meta-jumpgate-content-length",
    headers["x-amz-meta-jumpgate-content-length"]
  );
  response.setHeader("x-amz-meta-jumpgate-schema", headers["x-amz-meta-jumpgate-schema"]);
  response.setHeader("x-amz-meta-jumpgate-sha256", headers["x-amz-meta-jumpgate-sha256"]);
  response.setHeader(PUT_ATTEMPT_HEADER, options.putAttempt);
  response.setHeader(
    "x-amz-server-side-encryption",
    headers["x-amz-server-side-encryption"]
  );
  if (options.versionId) response.setHeader("x-amz-version-id", options.versionId);
  setRequestId(response);
}

async function executeOperation(
  operation,
  response,
  state,
  versionState,
  config,
  target,
  putAttempt,
  sequenceId
) {
  if (operation === "HeadBucket") {
    response.statusCode = 200;
    setRequestId(response);
    return response.end();
  }
  if (operation === "GetBucketAcl" || operation === "GetObjectAcl") {
    if (operation === "GetObjectAcl" && !state.stored) {
      throw protocolError(404, "NoSuchKey", "state/missing");
    }
    if (operation === "GetObjectAcl") {
      const requestedVersionId = operationVersionId(operation, target.canonicalQuery);
      if (requestedVersionId && requestedVersionId !== versionState.privacyVersionId) {
        throw protocolError(404, "NoSuchVersion", "state/missing-version");
      }
      response.setHeader("x-amz-version-id", versionState.privacyVersionId);
    }
    return sendXml(response, 200, aclXml());
  }
  if (operation === "GetBucketPolicyStatus") {
    if (config.publicAttestation && config.publicDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, config.publicDelayMs));
    }
    return sendXml(response, 200, policyStatusXml(config.publicAttestation));
  }
  if (operation === "ListObjectVersions") {
    const prefix = listVersionsPrefix(target.canonicalQuery, config);
    if (prefix === null) throw protocolError(400, "InvalidRequest", "operation/bucket");
    const namespacePrefix = scopedErasurePrefix(prefix, config);
    if (namespacePrefix !== null) {
      const authority = getErasureSequence(versionState, sequenceId, true);
      const scopeId = deriveResourceId(
        config.probeId,
        "erasure-scope",
        namespacePrefix
      );
      if (authority.scopedPrefix === null) {
        authority.scopedPrefix = namespacePrefix;
        authority.scopeId = scopeId;
      } else if (
        authority.scopedPrefix !== namespacePrefix ||
        authority.scopeId !== scopeId
      ) {
        throw protocolError(400, "InvalidRequest", "operation/bucket");
      }
      for (const key of versionState.objects.keys()) {
        if (key.startsWith(namespacePrefix)) authority.authorizedKeys.add(key);
      }
    } else {
      const authority = getErasureSequence(versionState, sequenceId);
      if (!authority || !authority.authorizedKeys.has(prefix)) {
        throw protocolError(400, "InvalidRequest", "operation/bucket");
      }
    }
    return sendXml(response, 200, listVersionsXml(config, versionState, prefix));
  }
  if (operation === "PutObject") {
    if (state.stored) throw protocolError(412, "PreconditionFailed", "state/replay");
    state.stored = true;
    state.mutations += 1;
    versionState.privacyVersionId = PRIVACY_VERSION_ID;
    versionState.privacyPutAttempt = putAttempt;
    response.statusCode = 200;
    response.setHeader("etag", '"' + crypto.createHash("md5").update(CANARY).digest("hex") + '"');
    response.setHeader("x-amz-checksum-sha256", CANARY_CHECKSUM);
    response.setHeader("x-amz-server-side-encryption", "AES256");
    response.setHeader("x-amz-version-id", versionState.privacyVersionId);
    setRequestId(response);
    return response.end();
  }
  if (operation === "PutErasureObject") {
    const key = erasureObjectKey(target.pathname, config);
    const authority = getErasureSequence(versionState, sequenceId);
    if (
      !key ||
      !authority ||
      authority.scopedPrefix === null ||
      !key.startsWith(authority.scopedPrefix)
    ) {
      throw protocolError(400, "InvalidRequest", "operation/erasure-object");
    }
    if (authority.putKey !== null && key !== authority.putKey) {
      throw protocolError(404, "NoSuchKey", "operation/key");
    }
    authority.putKey = key;
    authority.authorizedKeys.add(key);
    if (versionState.objects.has(key)) {
      throw protocolError(412, "PreconditionFailed", "state/replay");
    }
    const versionId = "jumpgate-ci-erasure-" + versionState.nextVersion++;
    versionState.objects.set(key, {
      objectId: deriveResourceId(config.probeId, "erasure-object", key),
      putAttempt,
      versionId,
    });
    versionState.deletedObjects.delete(key);
    state.mutations += 1;
    response.statusCode = 200;
    response.setHeader(
      "etag",
      '"' + crypto.createHash("md5").update(ERASURE_CANARY).digest("hex") + '"'
    );
    response.setHeader("x-amz-checksum-sha256", ERASURE_CANARY_CHECKSUM);
    response.setHeader("x-amz-server-side-encryption", "AES256");
    response.setHeader("x-amz-version-id", versionId);
    setRequestId(response);
    return response.end();
  }
  if (operation === "HeadErasureObject") {
    const key = authorizedErasureObjectKey(
      target.pathname,
      config,
      versionState,
      sequenceId
    );
    const object = key && versionState.objects.get(key);
    const requestedVersionId = operationVersionId(operation, target.canonicalQuery);
    if (!object) {
      const deletedObject = key && versionState.deletedObjects.get(key);
      if (!requestedVersionId) {
        throw protocolError(404, "NoSuchVersion", "state/missing-version");
      }
      if (!deletedObject) {
        throw protocolError(404, "NoSuchKey", "state/unrelated-missing");
      }
      if (requestedVersionId !== deletedObject.versionId) {
        throw protocolError(404, "NoSuchVersion", "state/missing-version");
      }
      throw protocolError(404, "NoSuchKey", "state/missing");
    }
    if (requestedVersionId && requestedVersionId !== object.versionId) {
      throw protocolError(404, "NoSuchVersion", "state/missing-version");
    }
    response.statusCode = 200;
    setObjectHeaders(response, {
      canary: ERASURE_CANARY,
      headers: ERASURE_PUT_HEADERS,
      putAttempt: object.putAttempt,
      versionId: object.versionId,
    });
    return response.end();
  }
  if (operation === "DeleteObject") {
    const key = authorizedErasureObjectKey(
      target.pathname,
      config,
      versionState,
      sequenceId
    );
    const versionId = deleteVersionId(target.canonicalQuery);
    const object = key && versionState.objects.get(key);
    if (!key || !versionId || !object || object.versionId !== versionId) {
      throw protocolError(404, "NoSuchVersion", "state/missing-version");
    }
    versionState.objects.delete(key);
    versionState.deletedObjects.set(key, object);
    state.mutations += 1;
    response.statusCode = 204;
    response.setHeader("x-amz-version-id", versionId);
    setRequestId(response);
    return response.end();
  }
  if (!state.stored) throw protocolError(404, "NoSuchKey", "state/missing");
  const requestedVersionId = operationVersionId(operation, target.canonicalQuery);
  if (requestedVersionId && requestedVersionId !== versionState.privacyVersionId) {
    throw protocolError(404, "NoSuchVersion", "state/missing-version");
  }
  if (operation === "HeadObject") {
    response.statusCode = 200;
    setObjectHeaders(response, {
      putAttempt: versionState.privacyPutAttempt,
      versionId: versionState.privacyVersionId,
    });
    return response.end();
  }
  if (operation === "GetObject") {
    response.statusCode = 200;
    setObjectHeaders(response, {
      putAttempt: versionState.privacyPutAttempt,
      versionId: versionState.privacyVersionId,
    });
    return response.end(CANARY);
  }
  throw protocolError(405, "MethodNotAllowed", "operation/unknown");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > 1024) {
        reject(protocolError(413, "EntityTooLarge", "body/size"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks, length)));
    request.once("error", () => reject(protocolError(400, "InvalidRequest", "body/read")));
  });
}

function nextSequenceId(sequenceState, probeId, operation) {
  if (operation === "HeadBucket" || sequenceState.id === null) {
    sequenceState.ordinal += 1;
    sequenceState.id = deriveSequenceId(probeId, sequenceState.ordinal);
  }
  return sequenceState.id;
}

function targetObjectKey(target, config, versionState, sequenceId) {
  if (!target) return null;
  if (target.pathname === "/" + config.expectedObjectKey) {
    return config.expectedObjectKey;
  }
  return authorizedErasureObjectKey(
    target.pathname,
    config,
    versionState,
    sequenceId
  );
}

function responseVersionId(response) {
  const value = response.getHeader("x-amz-version-id");
  return typeof value === "string" ? value : null;
}

function publicOperationName(operation) {
  if (operation === "PutErasureObject") return "PutObject";
  if (operation === "HeadErasureObject") return "HeadObject";
  return operation;
}

function erasureScopeId(key, config) {
  const scope = key === null ? null : erasureScopeForKey(key, config);
  return scope === null
    ? null
    : deriveResourceId(config.probeId, "erasure-scope", scope);
}

function boundObjectId(key, versionState, config) {
  if (key === null) return null;
  if (key === config.expectedObjectKey) return versionState.privacyObjectId;
  return deriveResourceId(config.probeId, "erasure-object", key);
}

function acceptedLogContext(
  operation,
  response,
  target,
  versionState,
  config,
  sequenceId
) {
  const versionContext = requestVersionContext(operation, target);
  if (operation === "ListObjectVersions") {
    const prefix = listVersionsPrefix(target.canonicalQuery, config);
    const objects = [...versionState.objects.entries()].filter(([key]) =>
      prefix !== null && key.startsWith(prefix)
    );
    const object = objects.length === 1 ? objects[0][1] : null;
    const scope =
      prefix === null
        ? null
        : scopedErasurePrefix(prefix, config) || erasureScopeForKey(prefix, config);
    return {
      scopeId:
        scope === null
          ? null
          : deriveResourceId(config.probeId, "erasure-scope", scope),
      objectId: object === null ? null : object.objectId,
      ...versionContext,
      versionId: object === null ? null : object.versionId,
      objectCount: objects.length,
    };
  }
  const key = targetObjectKey(target, config, versionState, sequenceId);
  return {
    scopeId: erasureScopeId(key, config),
    objectId: boundObjectId(key, versionState, config),
    ...versionContext,
    versionId: key === null ? null : responseVersionId(response),
    objectCount: null,
  };
}

function rejectedLogContext(operation, response, target, versionState, config, sequenceId) {
  const key = targetObjectKey(target, config, versionState, sequenceId);
  return {
    scopeId: erasureScopeId(key, config),
    objectId: boundObjectId(key, versionState, config),
    ...requestVersionContext(operation, target),
    versionId: responseVersionId(response),
  };
}

function createProtocolHandler(config, options = {}) {
  const state = options.state || { stored: false, mutations: 0 };
  const versionState = {
    deletedObjects: new Map(),
    erasureSequences: new Map(),
    nextVersion: 1,
    objects: new Map(),
    privacyObjectId: deriveObjectId(config.probeId, "privacy"),
    privacyPutAttempt: state.stored ? options.privacyPutAttempt || null : null,
    privacyVersionId: state.stored ? PRIVACY_VERSION_ID : null,
  };
  const sequenceState = { id: null, ordinal: 0 };
  const now = options.now || Date.now;
  const log = options.log || ((message) => console.log(message));
  const handler = async (request, response) => {
    let authenticated = false;
    let body = Buffer.alloc(0);
    let operation = null;
    let sequenceId = null;
    let target = null;
    try {
      body = await readBody(request);
      target = parseTarget(request.url);
      const signedHeaders = verifySigV4(request, body, target, config, now);
      authenticated = true;
      operation = classifyOperation(request, target, config, versionState);
      sequenceId = nextSequenceId(sequenceState, config.probeId, operation);
      const putAttempt = validateOperation(operation, request, body, signedHeaders);
      await executeOperation(
        operation,
        response,
        state,
        versionState,
        config,
        target,
        putAttempt,
        sequenceId
      );
      const publicOperation = publicOperationName(operation);
      const context = acceptedLogContext(
        operation,
        response,
        target,
        versionState,
        config,
        sequenceId
      );
      const record = {
        schema: HARNESS_LOG_SCHEMA,
        event: "operation",
        probeId: config.probeId,
        sequenceId,
        authenticated: true,
        operation: publicOperation,
        outcome: "accepted",
        scopeId: context.scopeId,
        objectId: context.objectId,
        versionSelector: context.versionSelector,
        requestedVersionId: context.requestedVersionId,
        versionId: context.versionId,
        objectCount: context.objectCount,
      };
      if (operation === "GetBucketPolicyStatus") {
        record.isPublic = config.publicAttestation;
      }
      log(JSON.stringify(record));
    } catch (error) {
      if (!response.headersSent && !response.destroyed) sendError(response, error, request.method);
      const label = error instanceof ProtocolError ? error.label : "internal";
      if (sequenceId === null) {
        sequenceId = nextSequenceId(sequenceState, config.probeId, null);
      }
      const context = rejectedLogContext(
        operation,
        response,
        target,
        versionState,
        config,
        sequenceId
      );
      log(
        JSON.stringify({
          schema: HARNESS_LOG_SCHEMA,
          event: "request",
          probeId: config.probeId,
          sequenceId,
          authenticated,
          operation: publicOperationName(operation),
          outcome: "rejected",
          reason: label,
          scopeId: context.scopeId,
          objectId: context.objectId,
          versionSelector: context.versionSelector,
          requestedVersionId: context.requestedVersionId,
          versionId: context.versionId,
        })
      );
    } finally {
      if (body.length > 0) body.fill(0);
    }
  };
  handler.state = state;
  return handler;
}

function createHttpsHarness(config, options = {}) {
  const tls = {
    cert: fs.readFileSync(config.tlsCertFile),
    key: fs.readFileSync(config.tlsKeyFile),
    minVersion: "TLSv1.2",
  };
  return https.createServer(tls, createProtocolHandler(config, options));
}

function main() {
  const config = readConfig();
  const server = createHttpsHarness(config);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close((error) => {
      if (error) process.exitCode = 1;
    });
  };
  server.once("error", () => {
    console.error("[s3-harness] server failed");
    process.exitCode = 1;
  });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        schema: HARNESS_LOG_SCHEMA,
        event: "ready",
        probeId: config.probeId,
        mode: config.publicAttestation ? "public" : "private",
      })
    );
  });
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("[s3-harness] startup failed");
    process.exitCode = 1;
  }
}

module.exports = {
  ALGORITHM,
  CANARY,
  CANARY_CHECKSUM,
  CANARY_SHA256,
  CHECKSUM_READ_HEADERS,
  EMPTY_SHA256,
  ERASURE_CANARY,
  ERASURE_CANARY_CHECKSUM,
  ERASURE_CANARY_SHA256,
  ERASURE_PUT_HEADERS,
  HARNESS_LOG_SCHEMA,
  MAX_CLOCK_SKEW_MS,
  OPERATION_HEADER_ALLOWLISTS,
  PUT_ATTEMPT_HEADER,
  PUT_HEADERS,
  SIGNED_PUT_HEADERS,
  ProtocolError,
  createHttpsHarness,
  createProtocolHandler,
  deriveObjectId,
  deriveResourceId,
  deriveSequenceId,
  deriveSigningKey,
  isCanonicalPutAttempt,
  parseAuthorization,
  parseTarget,
  readConfig,
  verifySigV4,
};
