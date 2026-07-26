"use strict";

class ContractFailure extends Error {
  constructor(label) {
    super(label);
    this.name = "ContractFailure";
  }
}

function readArgument(args, name) {
  const prefix = "--" + name + "=";
  const match = args.find((value) => value.startsWith(prefix));
  if (!match) throw new Error("missing required " + name);
  return match.slice(prefix.length);
}

function readInteger(args, name, minimum, maximum) {
  const parsed = Number(readArgument(args, name));
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("invalid " + name);
  }
  return parsed;
}

function requireContract(condition, label) {
  if (!condition) throw new ContractFailure(label);
}

const args = process.argv.slice(2);
const baseUrl = new URL(readArgument(args, "base-url"));
if (!/^https?:$/.test(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
  throw new Error("invalid base-url");
}
baseUrl.pathname = "/";
baseUrl.search = "";
baseUrl.hash = "";

const expectedVersion = readArgument(args, "expected-version");
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(expectedVersion)) {
  throw new Error("invalid expected-version");
}
const expectedVersionParts = expectedVersion.split(".").map(Number);
const expectedBuildArgument = readArgument(args, "expected-build-sha");
const expectedBuildSha =
  expectedBuildArgument === "null" ? null : expectedBuildArgument;
if (expectedBuildSha !== null && !/^[a-f0-9]{40}$/.test(expectedBuildSha)) {
  throw new Error("invalid expected-build-sha");
}
const expectedReadinessArgument =
  args.find((value) => value.startsWith("--expected-readiness="))?.split("=", 2)[1] ||
  "ready";
if (!new Set(["ready", "not-ready"]).has(expectedReadinessArgument)) {
  throw new Error("invalid expected-readiness");
}

const deadlineMs = readInteger(args, "deadline-ms", 100, 10 * 60 * 1000);
const delayMs = readInteger(args, "delay-ms", 0, 10 * 1000);
const deadlineAt = Date.now() + deadlineMs;

async function readBoundedBody(response, maximumBytes, label) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new ContractFailure(label + "/size");
  }
  if (!response.body) throw new ContractFailure(label + "/body");

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new ContractFailure(label + "/size");
      }
      chunks.push(Buffer.from(result.value));
    }
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure(label + "/body");
  }
  return Buffer.concat(chunks, length);
}

async function request(pathname, expectedStatus, expectedContentType, maximumBytes, label) {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new ContractFailure(label + "/deadline");
  try {
    const response = await fetch(new URL(pathname, baseUrl), {
      cache: "no-store",
      headers: { "accept-encoding": "identity" },
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(5000, remainingMs)),
    });
    requireContract(response.status === expectedStatus, label + "/status");
    const contentType = response.headers.get("content-type") || "";
    requireContract(expectedContentType.test(contentType), label + "/content-type");
    return { response, body: await readBoundedBody(response, maximumBytes, label) };
  } catch (error) {
    if (error instanceof ContractFailure) throw error;
    throw new ContractFailure(label + "/transport");
  }
}

async function readJson(pathname, label) {
  const { body } = await request(
    pathname,
    200,
    /^application\/json(?:;|$)/i,
    64 * 1024,
    label
  );
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (_error) {
    throw new ContractFailure(label + "/json");
  }
}

function requireExactHeader(response, name, value, label) {
  requireContract(response.headers.get(name) === value, label + "/header-" + name);
}

function requireAbsentHeader(response, name, label) {
  requireContract(response.headers.get(name) === null, label + "/header-" + name);
}

async function readExactHealth(pathname, status, expectedBody, label) {
  const expectedBytes = Buffer.from(expectedBody, "utf8");
  const { response, body } = await request(
    pathname,
    status,
    /^application\/json; charset=utf-8$/,
    expectedBytes.length,
    label
  );
  requireContract(body.equals(expectedBytes), label + "/body");
  requireExactHeader(response, "cache-control", "no-store", label);
  requireExactHeader(response, "content-length", String(expectedBytes.length), label);
  requireExactHeader(response, "x-content-type-options", "nosniff", label);
  requireExactHeader(response, "referrer-policy", "no-referrer", label);
  requireExactHeader(response, "x-frame-options", "DENY", label);
  requireExactHeader(
    response,
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
    label
  );
  requireExactHeader(
    response,
    "strict-transport-security",
    "max-age=31536000; includeSubDomains",
    label
  );
  for (const name of [
    "access-control-allow-origin",
    "ratelimit-limit",
    "ratelimit-policy",
    "ratelimit-remaining",
    "ratelimit-reset",
    "x-powered-by",
  ]) {
    requireAbsentHeader(response, name, label);
  }
}

async function runSemanticContract() {
  await readExactHealth(
    "/health/live",
    200,
    '{"ok":true,"status":"live"}',
    "health-live"
  );
  if (expectedReadinessArgument === "not-ready") {
    await readExactHealth(
      "/health/ready",
      503,
      '{"ok":false,"status":"not_ready"}',
      "health-ready"
    );
    return "not-ready";
  }
  await readExactHealth(
    "/health/ready",
    200,
    '{"ok":true,"status":"ready"}',
    "health-ready"
  );

  const version = await readJson("/version", "version");
  requireContract(version && version.version === expectedVersion, "version/semantic");
  requireContract(
    version.major === expectedVersionParts[0] &&
      version.minor === expectedVersionParts[1] &&
      version.patch === expectedVersionParts[2],
    "version/parts"
  );
  requireContract(version.buildSha === expectedBuildSha, "version/build");

  const manifest = await readJson("/manifest.json", "manifest");
  requireContract(manifest && manifest.id === "com.jumpgate.bridge", "manifest/id");
  requireContract(manifest.version === expectedVersion, "manifest/version");
  requireContract(
    manifest.behaviorHints &&
      manifest.behaviorHints.configurable === true &&
      manifest.behaviorHints.configurationRequired === true,
    "manifest/behavior"
  );

  const { body: configure } = await request(
    "/configure",
    200,
    /^text\/html(?:;|$)/i,
    512 * 1024,
    "configure"
  );
  const html = configure.toString("utf8");
  requireContract(
    html.includes("<title>Jumpgate Bridge Configure</title>") &&
      html.includes('id="connectStremioBtn"'),
    "configure/semantic"
  );
}

const sleep = async (milliseconds) => {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

async function main() {
  let lastLabel = "deadline";
  while (Date.now() < deadlineAt) {
    try {
      const result = await runSemanticContract();
      if (result === "not-ready") {
        console.log("HTTP smoke passed: live and negative readiness attestation.");
      } else {
        console.log("HTTP smoke passed: live, ready, version, manifest, configure.");
      }
      return;
    } catch (error) {
      lastLabel = error instanceof ContractFailure ? error.message : "internal";
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(delayMs, remainingMs));
    }
  }
  console.error("HTTP smoke failed: " + lastLabel);
  process.exitCode = 1;
}

main().catch(() => {
  console.error("HTTP smoke failed: internal");
  process.exitCode = 1;
});
