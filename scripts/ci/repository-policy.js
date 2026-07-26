"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const { TextDecoder } = require("node:util");
const MarkdownIt = require("markdown-it");
const { parse: parseToml } = require("smol-toml");
const { resolveTrustProxy } = require("../../lib/http-boundary");
const { createPublicBaseUrlResolver } = require("../../lib/public-base-url");
const { loadStorageConfig } = require("../../lib/storage/config");
const { createFiles: createContainerSmokeFiles } = require("./container-smoke-env");
const { assertRubyPsych } = require("./tooling-prerequisites");

const DEFAULT_ROOT = path.join(__dirname, "..", "..");
const WORKFLOW_ACTION_PARSER = path.join(__dirname, "workflow-action-refs.rb");
const WORKFLOW_RELEASE_METADATA_PARSER_PATH =
  "scripts/ci/workflow-release-metadata.rb";
const WORKFLOW_RELEASE_METADATA_PARSER = path.join(
  DEFAULT_ROOT,
  WORKFLOW_RELEASE_METADATA_PARSER_PATH
);
const REMOTE_ACTION_PATTERN =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[a-f0-9]{40}$/;
const DOCKER_ACTION_PATTERN =
  /^docker:\/\/[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;
const APPROVED_SPDX_LICENSE = "MIT";
const APPROVED_LICENSE_SHA256 =
  "cdb1ed6a66c7aba80dbd29116a28fc1445abfa45aa70f401dbb4f1980d51cec7";
const APPROVED_LICENSE_BYTES = Buffer.from(
  [
    "MIT License",
    "",
    "Copyright (c) 2026 Jumpgate contributors",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy",
    'of this software and associated documentation files (the "Software"), to deal',
    "in the Software without restriction, including without limitation the rights",
    "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
    "copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all",
    "copies or substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
    "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
    "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
    "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
    "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
    "SOFTWARE.",
    "",
  ].join("\n"),
  "utf8"
);
const PUBLIC_REPOSITORY_URL = "https://github.com/ruizkinio/Jumpgate-bridge";
const PUBLIC_REPOSITORY_LINE = `[Repository](${PUBLIC_REPOSITORY_URL})`;
const PRIVATE_ADVISORY_URL = `${PUBLIC_REPOSITORY_URL}/security/advisories/new`;
const PRIVATE_ADVISORY_SECURITY_LINE =
  `Report suspected vulnerabilities privately through [GitHub Security Advisories](${PRIVATE_ADVISORY_URL}).`;
const PRIVATE_REPORTING_STATUS =
  "Private vulnerability reporting is available through the verified link in SECURITY.md.";
const REQUIRED_CHECK_CONTEXTS = Object.freeze([
  "Quality / Node 24",
  "Redis 7 / 48 live contracts",
  "Redis 8 / 48 live contracts",
  "PostgreSQL 16 / 22 live storage contracts",
  "PostgreSQL 17 / 22 live storage contracts",
  "Bridge / Kodi fingerprint parity",
  "Immutable production image / PostgreSQL + Redis + private S3",
]);
const DEPLOY_CHECK_CONTEXT = "Fly production / exact tested digest";
const PUBLISH_LIFECYCLE_SCRIPTS = Object.freeze([
  "prepublish",
  "prepublishOnly",
  "prepack",
  "prepare",
  "postpack",
  "publish",
  "postpublish",
]);
const PUBLICATION_POLICY_FILES = Object.freeze([
  "README.md",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
  "public/configure.html",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/ISSUE_TEMPLATE/support_request.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/workflows/fly-deploy.yml",
  "scripts/ci/RELEASE_GATES.md",
  WORKFLOW_RELEASE_METADATA_PARSER_PATH,
]);
const REGULAR_GIT_FILE_MODES = new Set(["100644", "100755"]);
const GIT_OBJECT_ID_LENGTHS = Object.freeze({ sha1: 40, sha256: 64 });
const INDEX_TREE_PREFIX = "jumpgate-index-tree-";
const NPM_PACK_PREFIX = "jumpgate-npm-pack-";
const REDIS_V5_FIXTURE_PATH = "test/fixtures/redis-playback-claim-v5.json";
const REDIS_V5_SCRIPT_LOADER_PATH = "lib/storage/redis/scripts/index.js";
const REDIS_V5_FIXTURE_SHA256 =
  "26acab99f5dceb12d0492de0128d31684b62dbb868d8606c177d302348b15100";
const REDIS_V5_POLICY_FILES = Object.freeze([
  REDIS_V5_FIXTURE_PATH,
  REDIS_V5_SCRIPT_LOADER_PATH,
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ROOT_PACKAGE_FILES = new Set([
  "LICENSE",
  "README.md",
  "index.js",
  "package.json",
]);
const PACKAGE_DIRECTORY_EXTENSIONS = new Map([
  ["lib", new Set([".js", ".json", ".lua", ".md"])],
  ["migrations", new Set([".md", ".sql"])],
  [
    "public",
    new Set([
      ".css",
      ".html",
      ".ico",
      ".jpeg",
      ".jpg",
      ".js",
      ".png",
      ".svg",
      ".ttf",
      ".txt",
      ".woff",
      ".woff2",
    ]),
  ],
]);
const CI_ONLY_RUNTIME_CONFIGURATION = new Set(["NODE_EXTRA_CA_CERTS"]);
const FLY_IMPLICIT_RUNTIME_CONFIGURATION = new Set(["PORT"]);
const FLY_REQUIRED_SECRET_CONFIGURATION = new Set([
  "CONFIG_SECRET",
  "DATABASE_URL",
  "JUMPGATE_ENVELOPE_KEYRING",
  "JUMPGATE_ENVELOPE_PRIMARY_KEY_ID",
  "JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID",
  "JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING",
  "JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID",
  "JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY",
  "JUMPGATE_TOKEN_PEPPER",
  "REDIS_URL",
  "TRAKT_CLIENT_SECRET",
]);
const FLY_OPTIONAL_SECRET_CONFIGURATION = new Set(["TRAKT_CLIENT_ID"]);
const FLY_DEPLOYMENT_SPECIFIC_CONFIGURATION = new Set([
  "JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE",
  "JUMPGATE_SUBTITLE_S3_BUCKET",
  "PUBLIC_BASE_URL",
]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function loadRedisRuntimeScriptDefinitions(root) {
  readMaterializedBytes(root, REDIS_V5_SCRIPT_LOADER_PATH);
  const loaderPath = path.join(
    root,
    ...REDIS_V5_SCRIPT_LOADER_PATH.split("/")
  );
  const resolvedLoaderPath = require.resolve(loaderPath);
  delete require.cache[resolvedLoaderPath];
  try {
    const loaded = require(resolvedLoaderPath);
    if (
      !loaded ||
      typeof loaded !== "object" ||
      !loaded.SCRIPT_DEFINITIONS ||
      typeof loaded.SCRIPT_DEFINITIONS !== "object" ||
      Array.isArray(loaded.SCRIPT_DEFINITIONS)
    ) {
      throw new TypeError("Redis runtime script loader exports are invalid");
    }
    return loaded.SCRIPT_DEFINITIONS;
  } finally {
    delete require.cache[resolvedLoaderPath];
  }
}

function validateRedisV5ScriptFixture(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Redis V5 policy input is invalid");
  }
  if (!Buffer.isBuffer(input.fixtureBytes)) {
    throw new TypeError("Redis V5 policy fixtureBytes must be a Buffer");
  }
  if (
    !input.scriptDefinitions ||
    typeof input.scriptDefinitions !== "object" ||
    Array.isArray(input.scriptDefinitions)
  ) {
    throw new TypeError("Redis V5 policy scriptDefinitions must be an object");
  }

  const violations = [];
  if (sha256(input.fixtureBytes) !== REDIS_V5_FIXTURE_SHA256) {
    violations.push(
      "Redis V5 fixture: immutable fixture bytes changed; add a new protocol fixture/version"
    );
  }

  let fixture;
  try {
    fixture = JSON.parse(UTF8_DECODER.decode(input.fixtureBytes));
  } catch (_error) {
    return [...violations, "Redis V5 fixture: fixture JSON is malformed"];
  }
  const expectedKeys = [
    "compositeRedisSha1",
    "fixtureVersion",
    "policySha256",
    "protocolVersion",
    "scriptName",
    "scriptSource",
    "sharedSource",
  ];
  const definition =
    fixture && typeof fixture === "object" && !Array.isArray(fixture)
      ? input.scriptDefinitions[fixture.scriptName]
      : null;
  const scriptDirectory = path.posix.dirname(REDIS_V5_SCRIPT_LOADER_PATH);
  const isLoaderLuaPath = (value) =>
    typeof value === "string" &&
    path.posix.dirname(value) === scriptDirectory &&
    /^[a-z0-9][a-z0-9-]*\.lua$/.test(path.posix.basename(value));
  const expectedScriptSource =
    definition &&
    typeof definition.filename === "string" &&
    /^[a-z0-9][a-z0-9-]*\.lua$/.test(definition.filename)
      ? path.posix.join(scriptDirectory, definition.filename)
      : null;
  if (
    !fixture ||
    typeof fixture !== "object" ||
    Array.isArray(fixture) ||
    JSON.stringify(Object.keys(fixture).sort()) !== JSON.stringify(expectedKeys) ||
    fixture.fixtureVersion !== 1 ||
    fixture.protocolVersion !== 5 ||
    fixture.scriptName !== "playbackClaim" ||
    !isLoaderLuaPath(fixture.sharedSource) ||
    fixture.scriptSource !== expectedScriptSource ||
    !/^[a-f0-9]{40}$/.test(fixture.compositeRedisSha1) ||
    !/^[a-f0-9]{64}$/.test(fixture.policySha256) ||
    !definition ||
    definition.name !== fixture.scriptName ||
    typeof definition.source !== "string" ||
    !/^[a-f0-9]{40}$/.test(definition.sha)
  ) {
    return [...violations, "Redis V5 fixture: protocol metadata is invalid"];
  }

  const composite = Buffer.from(definition.source, "utf8");
  const redisSha1 = crypto.createHash("sha1").update(composite).digest("hex");
  const policySha256 = sha256(composite);
  if (definition.sha !== redisSha1) {
    violations.push("Redis V5 fixture: runtime loader SHA-1 does not match its composed source");
  }
  if (fixture.compositeRedisSha1 !== redisSha1) {
    violations.push(
      "Redis V5 fixture: composite Redis SHA-1 changed; add a new protocol fixture/version"
    );
  }
  if (fixture.policySha256 !== policySha256) {
    violations.push(
      "Redis V5 fixture: independent policy SHA-256 changed; add a new protocol fixture/version"
    );
  }
  return violations;
}

if (sha256(APPROVED_LICENSE_BYTES) !== APPROVED_LICENSE_SHA256) {
  throw new Error("approved LICENSE bytes do not match their pinned digest");
}

function collectAssignmentNames(text, allowComments = false) {
  const prefix = allowComments ? "(?:#\\s*)?" : "";
  const pattern = new RegExp("^" + prefix + "([A-Z][A-Z0-9_]*)=", "gm");
  return new Set([...text.matchAll(pattern)].map((match) => match[1]));
}

function parseDotenvAssignments(text) {
  const assignments = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("unsupported production dotenv entry");
    if (assignments.has(match[1])) throw new Error("duplicate production dotenv entry");
    assignments.set(match[1], match[2]);
  }
  return assignments;
}

function markdownSectionTokens(tokens, tag, title) {
  const starts = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      tokens[index].type === "heading_open" &&
      tokens[index].tag === tag &&
      tokens[index + 1].type === "inline" &&
      tokens[index + 1].content.trim() === title
    ) {
      starts.push(index + 3);
    }
  }
  if (starts.length === 0) return [];
  if (starts.length !== 1) throw new Error("duplicate Markdown section");
  const level = Number(tag.slice(1));
  let end = tokens.length;
  for (let index = starts[0]; index < tokens.length; index += 1) {
    if (
      tokens[index].type === "heading_open" &&
      Number(tokens[index].tag.slice(1)) <= level
    ) {
      end = index;
      break;
    }
  }
  return tokens.slice(starts[0], end);
}

function markdownVariableTableNames(tokens) {
  const tableStarts = tokens
    .map((token, index) => (token.type === "table_open" ? index : -1))
    .filter((index) => index >= 0);
  if (tableStarts.length !== 1) throw new Error("expected one environment table");
  const start = tableStarts[0];
  const endOffset = tokens.slice(start + 1).findIndex((token) => token.type === "table_close");
  if (endOffset < 0) throw new Error("unterminated Markdown table");
  const table = tokens.slice(start + 1, start + 1 + endOffset);
  const header = [];
  let inHeader = false;
  for (const token of table) {
    if (token.type === "thead_open") inHeader = true;
    else if (token.type === "thead_close") inHeader = false;
    else if (inHeader && token.type === "inline") header.push(token.content.trim());
  }
  if (
    header.length !== 3 ||
    header[0] !== "Variable" ||
    header[1] !== "Local default" ||
    header[2] !== "Production requirement"
  ) {
    throw new Error("unexpected environment table header");
  }

  const names = new Set();
  let firstCell = false;
  let inBody = false;
  for (const token of table) {
    if (token.type === "tbody_open") {
      inBody = true;
    } else if (token.type === "tbody_close") {
      inBody = false;
    }
    if (inBody && token.type === "tr_open") {
      firstCell = true;
    } else if (firstCell && token.type === "inline") {
      const code = (token.children || []).find((child) => child.type === "code_inline");
      if (code && /^[A-Z][A-Z0-9_]*$/.test(code.content)) {
        if (names.has(code.content)) throw new Error("duplicate environment variable row");
        names.add(code.content);
      }
      firstCell = false;
    }
  }
  return names;
}

function parseMarkdownConfiguration(text) {
  const tokens = new MarkdownIt({ html: true }).parse(text, {});
  const production = markdownSectionTokens(tokens, "h3", "Production Topology");
  const environment = markdownSectionTokens(tokens, "h2", "Environment Variables");
  const dotenvFences = production.filter(
    (token) => token.type === "fence" && token.info.trim().split(/\s+/)[0] === "dotenv"
  );
  if (dotenvFences.length !== 1) throw new Error("expected one production dotenv block");
  return {
    productionAssignments: parseDotenvAssignments(dotenvFences[0].content),
    environmentVariables: markdownVariableTableNames(environment),
  };
}

function parseFlyConfiguration(text) {
  const document = parseToml(text);
  const environment = Object.hasOwn(document, "env") ? document.env : {};
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("Fly env must be a TOML table");
  }
  const entries = Object.entries(environment);
  if (entries.some(([, value]) => typeof value !== "string")) {
    throw new Error("Fly env values must be strings");
  }
  const httpService = document.http_service;
  if (
    httpService === null ||
    typeof httpService !== "object" ||
    Array.isArray(httpService) ||
    !Number.isSafeInteger(httpService.internal_port) ||
    httpService.internal_port < 1 ||
    httpService.internal_port > 65535
  ) {
    throw new Error("Fly http_service.internal_port must be a valid port");
  }
  return {
    environment: new Map(entries),
    internalPort: httpService.internal_port,
  };
}

function validateConfigurationDocumentation(documents, runtimeConfiguration, options = {}) {
  const violations = [];
  const names = Object.keys(runtimeConfiguration).filter(
    (name) => !CI_ONLY_RUNTIME_CONFIGURATION.has(name)
  );
  const runtimeNames = new Set(names);
  let markdown = null;
  try {
    markdown = parseMarkdownConfiguration(documents.readme);
  } catch (_error) {
    violations.push("README.md: unsupported or malformed documentation structure");
  }
  const exampleAssignments = collectAssignmentNames(documents.environment, true);
  let flyConfiguration = null;
  try {
    flyConfiguration = parseFlyConfiguration(documents.fly);
  } catch (_error) {
    violations.push("fly.toml: unsupported or malformed configuration");
  }
  const flyEnvironment = flyConfiguration ? flyConfiguration.environment : null;

  if (
    flyConfiguration &&
    Object.hasOwn(runtimeConfiguration, "PORT") &&
    String(flyConfiguration.internalPort) !== runtimeConfiguration.PORT
  ) {
    violations.push("fly.toml: http_service.internal_port does not match runtime PORT");
  }

  for (const name of names) {
    if (markdown && !markdown.productionAssignments.has(name)) {
      violations.push(`README.md: production topology example omits ${name}`);
    }
    if (markdown && !markdown.environmentVariables.has(name)) {
      violations.push(`README.md: environment table omits ${name}`);
    }
    if (
      markdown &&
      markdown.productionAssignments.has(name) &&
      !FLY_REQUIRED_SECRET_CONFIGURATION.has(name) &&
      !FLY_OPTIONAL_SECRET_CONFIGURATION.has(name) &&
      !FLY_DEPLOYMENT_SPECIFIC_CONFIGURATION.has(name) &&
      markdown.productionAssignments.get(name) !== runtimeConfiguration[name]
    ) {
      violations.push(`README.md: production value for ${name} does not match runtime fixture`);
    }
    if (!exampleAssignments.has(name)) {
      violations.push(`.env.example: production configuration omits ${name}`);
    }
    if (
      flyEnvironment !== null &&
      !flyEnvironment.has(name) &&
      !FLY_REQUIRED_SECRET_CONFIGURATION.has(name) &&
      !FLY_OPTIONAL_SECRET_CONFIGURATION.has(name) &&
      !FLY_IMPLICIT_RUNTIME_CONFIGURATION.has(name)
    ) {
      violations.push(`fly.toml: deployment configuration omits ${name}`);
    }
    if (
      flyEnvironment !== null &&
      flyEnvironment.has(name) &&
      !FLY_REQUIRED_SECRET_CONFIGURATION.has(name) &&
      !FLY_OPTIONAL_SECRET_CONFIGURATION.has(name) &&
      !FLY_DEPLOYMENT_SPECIFIC_CONFIGURATION.has(name) &&
      flyEnvironment.get(name) !== runtimeConfiguration[name]
    ) {
      violations.push(`fly.toml: deployment value for ${name} does not match runtime fixture`);
    }
  }

  if (flyEnvironment !== null) {
    for (const name of flyEnvironment.keys()) {
      if (
        FLY_REQUIRED_SECRET_CONFIGURATION.has(name) ||
        FLY_OPTIONAL_SECRET_CONFIGURATION.has(name)
      ) {
        violations.push(`fly.toml: ${name} must be supplied outside committed [env]`);
      } else if (
        !runtimeNames.has(name) &&
        !FLY_DEPLOYMENT_SPECIFIC_CONFIGURATION.has(name)
      ) {
        violations.push(`fly.toml: deployment configuration includes unexpected ${name}`);
      }
    }
    if (typeof options.validateFlyRuntime === "function") {
      try {
        options.validateFlyRuntime(Object.fromEntries(flyEnvironment));
      } catch (_error) {
        violations.push("fly.toml: deployment values violate the production runtime contract");
      }
    }
  }
  return violations;
}

function spawn(root, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.encoding || "buffer",
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + " failed with exit code " + result.status);
  }
  return result.stdout;
}

function findActionReferences(workflowText, options = {}) {
  const rubyCommand = options.rubyCommand || "ruby";
  const parserPath = options.parserPath || WORKFLOW_ACTION_PARSER;
  assertRubyPsych({ rubyCommand });
  const result = spawnSync(rubyCommand, [parserPath], {
    encoding: "utf8",
    input: workflowText,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("workflow action parser failed");
  }

  let references;
  try {
    references = JSON.parse(result.stdout);
  } catch (_error) {
    throw new Error("workflow action parser returned invalid output");
  }
  if (
    !Array.isArray(references) ||
    references.some((reference) => typeof reference !== "string" || reference.length === 0)
  ) {
    throw new Error("workflow action parser returned invalid references");
  }
  return references;
}

function parseWorkflowReleaseMetadata(workflowText, options = {}) {
  const rubyCommand = options.rubyCommand || "ruby";
  const parserPath = options.parserPath || WORKFLOW_RELEASE_METADATA_PARSER;
  assertRubyPsych({ rubyCommand });
  const result = spawnSync(rubyCommand, [parserPath], {
    encoding: "utf8",
    input: workflowText,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error("workflow release metadata parser failed");
  }

  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch (_error) {
    throw new Error("workflow release metadata parser returned invalid output");
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !metadata.triggers ||
    typeof metadata.triggers !== "object" ||
    Array.isArray(metadata.triggers) ||
    !metadata.jobs ||
    typeof metadata.jobs !== "object" ||
    Array.isArray(metadata.jobs)
  ) {
    throw new Error("workflow release metadata parser returned invalid metadata");
  }
  return metadata;
}

function validateActionReference(reference) {
  if (reference.startsWith("./")) {
    const segments = reference.slice(2).split("/");
    return segments.length > 0 &&
      segments.every(
        (segment) =>
          segment !== "." &&
          segment !== ".." &&
          /^[A-Za-z0-9_.@-]+$/.test(segment)
      )
      ? null
      : "local action path is malformed";
  }
  if (reference.startsWith("docker://")) {
    return DOCKER_ACTION_PATTERN.test(reference)
      ? null
      : "docker action is not pinned to a sha256 digest";
  }
  return REMOTE_ACTION_PATTERN.test(reference)
    ? null
    : "remote action is not pinned to a full commit SHA";
}

function normalizePackagePath(entryPath) {
  if (
    typeof entryPath !== "string" ||
    entryPath.length === 0 ||
    entryPath.startsWith("/") ||
    entryPath.includes("\\") ||
    entryPath.includes("\0") ||
    entryPath.includes("//")
  ) {
    return null;
  }
  const segments = entryPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return entryPath;
}

function parseGitIndexEntries(output) {
  const bytes = Buffer.isBuffer(output)
    ? output
    : Buffer.from(String(output === undefined || output === null ? "" : output), "utf8");
  if (bytes.length === 0) return [];

  const entries = [];
  let offset = 0;
  while (offset < bytes.length) {
    const terminator = bytes.indexOf(0, offset);
    if (terminator < 0 || terminator === offset) {
      throw new Error("git index returned an invalid entry");
    }
    const record = bytes.subarray(offset, terminator);
    const separator = record.indexOf(0x09);
    const metadata = separator < 0 ? "" : record.subarray(0, separator).toString("ascii");
    const fields = metadata.split(" ");
    let filename = "";
    try {
      filename = separator < 0 ? "" : UTF8_DECODER.decode(record.subarray(separator + 1));
    } catch (_error) {
      throw new Error("git index returned an invalid UTF-8 path");
    }
    if (
      fields.length !== 3 ||
      !/^[0-7]{6}$/.test(fields[0]) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fields[1]) ||
      !/^[0-3]$/.test(fields[2]) ||
      filename.length === 0
    ) {
      throw new Error("git index returned an invalid entry");
    }
    entries.push({
      mode: fields[0],
      objectId: fields[1],
      path: filename,
      stage: Number(fields[2]),
    });
    offset = terminator + 1;
  }
  return entries;
}

function portableIndexPath(filename) {
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    filename.startsWith("/") ||
    filename.startsWith("\\") ||
    /^[A-Za-z]:/.test(filename) ||
    filename.includes("\\") ||
    filename.includes("\0") ||
    Buffer.byteLength(filename, "utf8") > 4096
  ) {
    return null;
  }

  const segments = filename.split("/");
  for (const segment of segments) {
    const reservedBasename = segment.split(".", 1)[0];
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.normalize("NFC") !== segment ||
      Buffer.byteLength(segment, "utf8") > 255 ||
      /[\u0000-\u001f\u007f<>:"|?*]/u.test(segment) ||
      /[ .]$/u.test(segment) ||
      /^\.git$/i.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(reservedBasename)
    ) {
      return null;
    }
  }
  return segments;
}

function validateSelectedIndexEntries(entries, objectFormat) {
  if (!Array.isArray(entries)) throw new TypeError("selected Git entries must be an array");
  const objectIdLength = GIT_OBJECT_ID_LENGTHS[objectFormat];
  if (!objectIdLength) return ["Git index: repository object format is unsupported"];

  const violations = [];
  const portablePaths = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      violations.push("Git index: entry metadata is malformed");
      continue;
    }
    if (entry.stage !== 0) {
      violations.push(`${entry.path || "<unknown>"}: unmerged Git index stages are forbidden`);
    }
    if (!REGULAR_GIT_FILE_MODES.has(entry.mode)) {
      violations.push(`${entry.path || "<unknown>"}: special Git index modes are forbidden`);
    }
    if (
      typeof entry.objectId !== "string" ||
      entry.objectId.length !== objectIdLength ||
      !/^[a-f0-9]+$/.test(entry.objectId)
    ) {
      violations.push(`${entry.path || "<unknown>"}: object ID does not match ${objectFormat}`);
    }
    const segments = portableIndexPath(entry.path);
    if (segments === null) {
      violations.push(`${entry.path || "<unknown>"}: Git index path is not portable and safe`);
      continue;
    }
    portablePaths.push({
      key: segments.map((segment) => segment.toLowerCase()).join("/"),
      path: entry.path,
    });
  }

  portablePaths.sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  );
  const seenPaths = new Map();
  for (const current of portablePaths) {
    const segments = current.key.split("/");
    for (let length = 1; length <= segments.length; length += 1) {
      const candidate = segments.slice(0, length).join("/");
      const previous = seenPaths.get(candidate);
      if (previous) {
        violations.push(
          `${current.path}: Git index path collides with ${previous} on a portable filesystem`
        );
        break;
      }
    }
    seenPaths.set(current.key, current.path);
  }
  return violations;
}

function selectedRepositoryObjectFormat(root, environment) {
  const objectFormat = spawn(root, "git", ["rev-parse", "--show-object-format"], {
    encoding: "utf8",
    env: environment,
  }).trim();
  if (!Object.prototype.hasOwnProperty.call(GIT_OBJECT_ID_LENGTHS, objectFormat)) {
    throw new Error("selected Git repository uses an unsupported object format");
  }
  return objectFormat;
}

function readSelectedIndexBlobs(root, entries, environment, objectFormat) {
  if (entries.length === 0) return [];
  const output = spawn(root, "git", ["cat-file", "--batch"], {
    env: environment,
    input: Buffer.from(entries.map((entry) => entry.objectId).join("\n") + "\n", "ascii"),
  });
  const blobs = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error("git cat-file returned a truncated batch header");
    const header = output.subarray(offset, headerEnd).toString("ascii");
    const match = header.match(/^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/);
    if (!match || match[1] !== entry.objectId) {
      throw new Error("git cat-file did not return the selected blob");
    }
    const size = Number.parseInt(match[2], 10);
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + size;
    if (
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(bodyEnd) ||
      bodyEnd >= output.length ||
      output[bodyEnd] !== 0x0a
    ) {
      throw new Error("git cat-file returned malformed batch bytes");
    }
    const bytes = Buffer.from(output.subarray(bodyStart, bodyEnd));
    const calculatedObjectId = crypto
      .createHash(objectFormat)
      .update(Buffer.from(`blob ${size}\0`, "ascii"))
      .update(bytes)
      .digest("hex");
    if (calculatedObjectId !== entry.objectId) {
      throw new Error("git cat-file bytes do not match the selected object ID");
    }
    blobs.push(bytes);
    offset = bodyEnd + 1;
  }
  if (offset !== output.length) throw new Error("git cat-file returned unexpected batch bytes");
  return blobs;
}

function materializeSelectedIndex(root, entries, options = {}) {
  const environment = options.env || process.env;
  const objectFormat = options.objectFormat || selectedRepositoryObjectFormat(root, environment);
  const indexViolations = validateSelectedIndexEntries(entries, objectFormat);
  if (indexViolations.length > 0) {
    throw new Error("selected Git index cannot be materialized: " + indexViolations.join("; "));
  }
  const blobs = readSelectedIndexBlobs(root, entries, environment, objectFormat);

  const materializedRoot = fs.mkdtempSync(path.join(os.tmpdir(), INDEX_TREE_PREFIX));
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const segments = portableIndexPath(entry.path);
      if (segments === null) throw new Error("selected Git index path became unsafe");
      const destination = path.join(materializedRoot, ...segments);
      const relative = path.relative(materializedRoot, destination);
      if (relative === "" || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
        throw new Error("selected Git index path escaped its materialization root");
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, blobs[index], {
        flag: "wx",
        mode: entry.mode === "100755" ? 0o755 : 0o644,
      });
    }
    return materializedRoot;
  } catch (error) {
    fs.rmSync(materializedRoot, { force: true, recursive: true });
    throw error;
  }
}

function isRootLicenseName(filename) {
  return (
    typeof filename === "string" &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    filename.toLowerCase() === "license"
  );
}

function validateTrackedLicenseEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("tracked entries must be an array");
  const exact = entries.filter((entry) => entry && entry.path === "LICENSE");
  const caseVariants = entries.filter(
    (entry) => entry && isRootLicenseName(entry.path) && entry.path !== "LICENSE"
  );
  const violations = [];
  if (exact.length !== 1) {
    violations.push("LICENSE: repository must track exactly one root LICENSE entry");
  }
  if (caseVariants.length > 0) {
    violations.push("LICENSE: tracked root license name must use exact LICENSE casing");
  }
  if (
    exact.some(
      (entry) =>
        entry.stage !== 0 ||
        !REGULAR_GIT_FILE_MODES.has(entry.mode)
    )
  ) {
    violations.push("LICENSE: Git entry must be a regular non-symlink stage-0 file");
  }
  return violations;
}

function readIndexedFileBytes(root, entries, filename, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError("tracked entries must be an array");
  const matches = entries.filter(
    (entry) =>
      entry &&
      entry.path === filename &&
      entry.stage === 0 &&
      REGULAR_GIT_FILE_MODES.has(entry.mode)
  );
  if (matches.length !== 1) {
    throw new Error(filename + ": selected Git index entry is not one regular stage-0 file");
  }
  return spawn(root, "git", ["cat-file", "blob", matches[0].objectId], {
    env: options.env,
  });
}

function validateSelectedLicenseAttributes(root, options = {}) {
  let output;
  try {
    output = spawn(
      root,
      "git",
      ["check-attr", "--cached", "-z", "text", "eol", "--", "LICENSE"],
      { env: options.env }
    );
  } catch (_error) {
    return [".gitattributes: cannot evaluate selected LICENSE attributes"];
  }
  const fields = output.toString("utf8").split("\0").filter(Boolean);
  const attributes = new Map();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    if (fields[index] === "LICENSE") attributes.set(fields[index + 1], fields[index + 2]);
  }
  return attributes.get("text") === "set" && attributes.get("eol") === "lf"
    ? []
    : [".gitattributes: selected LICENSE must resolve to text eol=lf"];
}

function validateLicenseBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("LICENSE bytes must be a Buffer");
  if (bytes.equals(APPROVED_LICENSE_BYTES) && sha256(bytes) === APPROVED_LICENSE_SHA256) {
    return [];
  }
  return [
    `LICENSE: bytes must match the approved MIT text (sha256:${APPROVED_LICENSE_SHA256})`,
  ];
}

function validatePackageLicenseMetadata(manifest, lockfile) {
  const violations = [];
  const manifestLicense =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest.license
      : undefined;
  const lockRoot =
    lockfile &&
    typeof lockfile === "object" &&
    !Array.isArray(lockfile) &&
    lockfile.packages &&
    typeof lockfile.packages === "object" &&
    !Array.isArray(lockfile.packages)
      ? lockfile.packages[""]
      : undefined;
  const lockLicense =
    lockRoot && typeof lockRoot === "object" && !Array.isArray(lockRoot)
      ? lockRoot.license
      : undefined;

  if (manifestLicense !== APPROVED_SPDX_LICENSE) {
    violations.push(`package.json: license must be exact SPDX identifier ${APPROVED_SPDX_LICENSE}`);
  }
  if (lockLicense !== APPROVED_SPDX_LICENSE) {
    violations.push(
      `package-lock.json: root package license must be exact SPDX identifier ${APPROVED_SPDX_LICENSE}`
    );
  }
  if (
    typeof manifestLicense === "string" &&
    typeof lockLicense === "string" &&
    manifestLicense !== lockLicense
  ) {
    violations.push("package.json and package-lock.json: root SPDX licenses must agree");
  }
  return violations;
}

function validatePackLifecycleScripts(manifest) {
  const scripts =
    manifest &&
    typeof manifest === "object" &&
    !Array.isArray(manifest) &&
    manifest.scripts &&
    typeof manifest.scripts === "object" &&
    !Array.isArray(manifest.scripts)
      ? manifest.scripts
      : {};
  return PUBLISH_LIFECYCLE_SCRIPTS
    .filter((name) => Object.prototype.hasOwnProperty.call(scripts, name))
    .map(
      (name) =>
        `package.json: ${name} lifecycle script is forbidden because publication artifacts must be script-independent`
    );
}

function validatePublicationGate(documents, options = {}) {
  if (!documents || typeof documents !== "object" || Array.isArray(documents)) {
    throw new TypeError("publication documents must be an object");
  }
  const violations = [];
  let publicRepositoryOccurrences = 0;
  let privateAdvisoryOccurrences = 0;
  const publicRepositoryPattern =
    /https:\/\/github\.com\/ruizkinio\/jumpgate-bridge(?=[\s`"')]|$)/gi;
  const privateAdvisoryPattern =
    /(?:https?:\/\/github\.com\/[^\s/]+\/[^\s/]+)?\/security\/advisories(?:\/new)?/gi;

  for (const filename of PUBLICATION_POLICY_FILES) {
    if (typeof documents[filename] !== "string") {
      violations.push(filename + ": publication policy file must be present in the selected Git index");
      continue;
    }
    const text = documents[filename];
    for (const line of text.split(/\r?\n/)) {
      const repositoryMatches = line.match(publicRepositoryPattern) || [];
      publicRepositoryOccurrences += repositoryMatches.length;
      if (
        repositoryMatches.length > 0 &&
        !(filename === "README.md" && line.trim() === PUBLIC_REPOSITORY_LINE)
      ) {
        violations.push(filename + ": canonical repository URL must appear only in the README declaration");
      }

      const advisoryMatches = line.match(privateAdvisoryPattern) || [];
      privateAdvisoryOccurrences += advisoryMatches.filter(
        (value) => value.toLowerCase() === PRIVATE_ADVISORY_URL.toLowerCase()
      ).length;
      if (
        advisoryMatches.length > 0 &&
        !(
          (filename === "SECURITY.md" && line.trim() === PRIVATE_ADVISORY_SECURITY_LINE) ||
          (filename === ".github/ISSUE_TEMPLATE/config.yml" &&
            line.trim() === `url: ${PRIVATE_ADVISORY_URL}`)
        )
      ) {
        violations.push(filename + ": private-advisory route is not the verified publication channel");
      }
    }
  }

  if (publicRepositoryOccurrences !== 1) {
    violations.push("README.md: canonical repository URL must appear exactly once");
  }
  if (privateAdvisoryOccurrences !== 2) {
    violations.push("SECURITY.md: verified private-advisory URL must appear exactly twice across publication policy");
  }

  const configure = documents["public/configure.html"];
  if (typeof configure === "string") {
    if (/https?:\/\//i.test(configure)) {
      violations.push("public/configure.html: deployment policy URLs must not be hardcoded");
    }
    for (const token of [
      "@@JUMPGATE_DEPLOYMENT_STATUS@@",
      "@@JUMPGATE_POLICY_LINKS@@",
    ]) {
      if (configure.split(token).length !== 2) {
        violations.push(`public/configure.html: ${token} must appear exactly once`);
      }
    }
  }

  const security = documents["SECURITY.md"];
  if (
    typeof security === "string" &&
    security.split(PRIVATE_ADVISORY_SECURITY_LINE).length !== 2
  ) {
    violations.push("SECURITY.md: verified private reporting channel must be stated exactly once");
  }

  for (const filename of [
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/support_request.yml",
  ]) {
    const text = documents[filename];
    if (
      typeof text === "string" &&
      text.split(PRIVATE_REPORTING_STATUS).length !== 2
    ) {
      violations.push(filename + ": private reporting status must be explicit exactly once");
    }
  }

  const issueConfiguration = documents[".github/ISSUE_TEMPLATE/config.yml"];
  if (
    typeof issueConfiguration === "string" &&
    issueConfiguration.split(/^contact_links:\s*$/m).length !== 2
  ) {
    violations.push(".github/ISSUE_TEMPLATE/config.yml: private security contact link must be present exactly once");
  }

  for (const filename of ["SUPPORT.md", "PRIVACY.md"]) {
    const text = documents[filename];
    if (
      typeof text === "string" &&
      text.split(PRIVATE_REPORTING_STATUS).length !== 2
    ) {
      violations.push(filename + ": live private reporting status must be explicit exactly once");
    }
    if (
      typeof text === "string" &&
      /future repository|no (?:private )?(?:vulnerability-)?reporting channel is published yet/i.test(text)
    ) {
      violations.push(filename + ": stale pre-publication reporting status is forbidden");
    }
  }

  const workflow = documents[".github/workflows/fly-deploy.yml"];
  if (typeof workflow === "string") {
    let metadata = null;
    try {
      metadata = parseWorkflowReleaseMetadata(workflow, {
        parserPath: options.workflowReleaseMetadataParserPath,
      });
    } catch (_error) {
      violations.push(
        ".github/workflows/fly-deploy.yml: release metadata parser failed closed"
      );
    }

    const triggerKeys = metadata ? Object.keys(metadata.triggers).sort() : [];
    const push = metadata && metadata.triggers.push;
    if (
      JSON.stringify(triggerKeys) !==
        JSON.stringify(["pull_request", "push", "workflow_dispatch"]) ||
      !push ||
      typeof push !== "object" ||
      Array.isArray(push) ||
      JSON.stringify(Object.keys(push)) !== JSON.stringify(["branches"]) ||
      JSON.stringify(push.branches) !== JSON.stringify(["main"])
    ) {
      violations.push(
        ".github/workflows/fly-deploy.yml: push CI must target only main with no tag trigger"
      );
    }

    const emittedContexts = [];
    const jobs = metadata ? metadata.jobs : {};
    const expectedJobIds = [
      "container-smoke",
      "deploy",
      "fingerprint-parity",
      "postgres-live",
      "quality",
      "redis-live",
    ];
    if (JSON.stringify(Object.keys(jobs).sort()) !== JSON.stringify(expectedJobIds)) {
      violations.push(
        ".github/workflows/fly-deploy.yml: release workflow job set must be exact"
      );
    }
    const jobNames = Object.values(jobs)
      .map((job) => (job && typeof job === "object" ? job.name : null))
      .filter((name) => typeof name === "string");
    const jobNameOccurrences = (name) =>
      jobNames.filter((candidate) => candidate === name).length;
    for (const [jobId, context] of [
      ["quality", "Quality / Node 24"],
      ["fingerprint-parity", "Bridge / Kodi fingerprint parity"],
      [
        "container-smoke",
        "Immutable production image / PostgreSQL + Redis + private S3",
      ],
    ]) {
      if (
        jobs[jobId] &&
        jobs[jobId].name === context &&
        jobNameOccurrences(context) === 1
      ) {
        emittedContexts.push(context);
      }
    }

    const redisTemplate = "Redis ${{ matrix.redis_major }} / 48 live contracts";
    const redisInclude = jobs["redis-live"]?.strategy?.matrix?.include;
    const redisMajors = Array.isArray(redisInclude)
      ? redisInclude.map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? entry.redis_major
            : null
        )
      : [];
    if (
      jobs["redis-live"]?.name === redisTemplate &&
      jobNameOccurrences(redisTemplate) === 1 &&
      JSON.stringify(redisMajors) === JSON.stringify(["7", "8"])
    ) {
      const contexts = redisMajors.map((major) => `Redis ${major} / 48 live contracts`);
      if (contexts.every((context) => jobNameOccurrences(context) === 0)) {
        emittedContexts.push(...contexts);
      }
    }

    const postgresTemplate =
      "PostgreSQL ${{ matrix.postgres_major }} / 22 live storage contracts";
    const postgresInclude = jobs["postgres-live"]?.strategy?.matrix?.include;
    const postgresMajors = Array.isArray(postgresInclude)
      ? postgresInclude.map((entry) =>
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? entry.postgres_major
            : null
        )
      : [];
    if (
      jobs["postgres-live"]?.name === postgresTemplate &&
      jobNameOccurrences(postgresTemplate) === 1 &&
      JSON.stringify(postgresMajors) === JSON.stringify(["16", "17"])
    ) {
      const contexts = postgresMajors.map(
        (major) => `PostgreSQL ${major} / 22 live storage contracts`
      );
      if (contexts.every((context) => jobNameOccurrences(context) === 0)) {
        emittedContexts.push(...contexts);
      }
    }

    if (
      JSON.stringify([...emittedContexts].sort()) !==
      JSON.stringify([...REQUIRED_CHECK_CONTEXTS].sort())
    ) {
      violations.push(
        ".github/workflows/fly-deploy.yml: emitted check contexts must exactly match release gates"
      );
    }
    if (
      !jobs.deploy ||
      jobs.deploy.name !== DEPLOY_CHECK_CONTEXT ||
      jobNameOccurrences(DEPLOY_CHECK_CONTEXT) !== 1
    ) {
      violations.push(
        ".github/workflows/fly-deploy.yml: deployment check context must appear exactly once"
      );
    }
  }

  const releaseGates = documents["scripts/ci/RELEASE_GATES.md"];
  if (typeof releaseGates === "string") {
    for (const context of REQUIRED_CHECK_CONTEXTS) {
      if (releaseGates.split(`\`${context}\``).length !== 2) {
        violations.push(
          `scripts/ci/RELEASE_GATES.md: required context must appear exactly once: ${context}`
        );
      }
    }
    if (
      releaseGates.split(`\`${DEPLOY_CHECK_CONTEXT}\``).length !== 2 ||
      !releaseGates.includes("a required pre-merge status check")
    ) {
      violations.push(
        "scripts/ci/RELEASE_GATES.md: deployment job must be explicitly excluded from pre-merge checks"
      );
    }
    if (/require every Bridge CI job/i.test(releaseGates)) {
      violations.push("scripts/ci/RELEASE_GATES.md: ambiguous all-job requirement is forbidden");
    }
  }
  return violations;
}

function validatePackageLicenseEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("package entries must be an array");
  const exact = entries.filter((entry) => entry && entry.path === "LICENSE");
  const caseVariants = entries.filter(
    (entry) => entry && isRootLicenseName(entry.path) && entry.path !== "LICENSE"
  );
  const violations = [];
  if (exact.length !== 1) {
    violations.push("LICENSE: npm package must contain exactly one root LICENSE entry");
  }
  if (caseVariants.length > 0) {
    violations.push("LICENSE: npm package root license name must use exact LICENSE casing");
  }
  if (
    exact.some((entry) => {
      const declaredType = entry.type === undefined ? entry.kind : entry.type;
      const normalizedType =
        typeof declaredType === "string" ? declaredType.toLowerCase() : null;
      return (
        (normalizedType !== null &&
          normalizedType !== "file" &&
          normalizedType !== "regular" &&
          normalizedType !== "regular-file") ||
        entry.isFile === false ||
        entry.isDirectory === true ||
        entry.isSymbolicLink === true
      );
    })
  ) {
    violations.push("LICENSE: npm package entry must be a regular non-symlink file");
  }
  if (
    exact.some(
      (entry) =>
        entry.size !== undefined &&
        (!Number.isSafeInteger(entry.size) || entry.size !== APPROVED_LICENSE_BYTES.length)
    )
  ) {
    violations.push("LICENSE: npm package entry size must match the approved LICENSE bytes");
  }
  return violations;
}

function isAllowedPackagePath(entryPath, trackedPaths) {
  const normalized = normalizePackagePath(entryPath);
  if (normalized === null || !trackedPaths.has(normalized)) return false;
  if (normalized.split("/").some((segment) => /\.(?:bak|map|secret)(?:\.|$)/i.test(segment))) {
    return false;
  }
  if (ROOT_PACKAGE_FILES.has(normalized)) return true;

  const segments = normalized.split("/");
  if (segments.length < 2) return false;
  const allowedExtensions = PACKAGE_DIRECTORY_EXTENSIONS.get(segments[0]);
  if (!allowedExtensions) return false;
  return allowedExtensions.has(path.posix.extname(normalized).toLowerCase());
}

function scanCredentialBytes(bytes) {
  const text = bytes.toString("latin1");
  const patterns = [
    ["private-key", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
    ["github-token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
    ["github-token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
    ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
    ["fly-token", /\bFlyV1[\x00-\x20]+[A-Za-z0-9_-]{20,}\b/],
    [
      "trakt-client-secret",
      /\bTRAKT_CLIENT_SECRET\b[\x00-\x20"'\x60:=,-]{1,96}[a-f0-9]{64}\b/i,
    ],
    [
      "tmdb-api-key",
      /\bTMDB_API_KEY\b[\x00-\x20"'\x60:=,-]{1,96}[a-f0-9]{32}\b/i,
    ],
  ];
  return patterns.filter((entry) => entry[1].test(text)).map((entry) => entry[0]);
}

function readMaterializedBytes(root, filename) {
  const segments = portableIndexPath(filename);
  if (segments === null) throw new Error("materialized path is unsafe");
  const absolute = path.join(root, ...segments);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("materialized entry is not a regular file");
  }
  return fs.readFileSync(absolute);
}

function snapshotMaterializedFiles(root) {
  const files = new Map();
  const pending = [{ absolute: root, relative: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current.absolute, { withFileTypes: true })) {
      const relative = current.relative ? current.relative + "/" + entry.name : entry.name;
      if (portableIndexPath(relative) === null || entry.isSymbolicLink()) {
        throw new Error("materialized index tree contains an unsafe entry");
      }
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
      } else if (entry.isFile()) {
        files.set(relative, fs.readFileSync(absolute));
      } else {
        throw new Error("materialized index tree contains a special entry");
      }
    }
  }
  return files;
}

function materializedSnapshotMatches(root, expected) {
  const actual = snapshotMaterializedFiles(root);
  if (actual.size !== expected.size) return false;
  for (const [filename, bytes] of expected) {
    const actualBytes = actual.get(filename);
    if (!actualBytes || !actualBytes.equals(bytes)) return false;
  }
  return true;
}

function readTarString(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString("utf8");
}

function readTarOctal(header, offset, length) {
  const bytes = header.subarray(offset, offset + length);
  if ((bytes[0] & 0x80) !== 0) throw new Error("npm package uses unsupported base-256 TAR fields");
  const value = bytes.toString("ascii").replace(/\0.*$/s, "").trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error("npm package contains a malformed TAR number");
  return Number.parseInt(value, 8);
}

function validateTarHeaderChecksum(header) {
  const expected = readTarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error("npm package contains a TAR header checksum mismatch");
}

function parsePaxPath(bytes) {
  let offset = 0;
  let pathname = null;
  while (offset < bytes.length) {
    const separator = bytes.indexOf(0x20, offset);
    if (separator < 0) throw new Error("npm package contains malformed PAX metadata");
    const length = Number.parseInt(bytes.subarray(offset, separator).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) {
      throw new Error("npm package contains malformed PAX metadata");
    }
    const record = bytes.subarray(separator + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") pathname = record.slice(equals + 1);
    offset += length;
  }
  return pathname;
}

function readTarEntries(tarball) {
  const archive = zlib.gunzipSync(tarball);
  const entries = [];
  let offset = 0;
  let pendingPath = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    validateTarHeaderChecksum(header);
    const size = readTarOctal(header, 124, 12);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(bodyEnd) || bodyEnd > archive.length) {
      throw new Error("npm package contains a truncated TAR entry");
    }
    const type = String.fromCharCode(header[156] || 0);
    const mode = readTarOctal(header, 100, 8);
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const headerPath = prefix ? prefix + "/" + name : name;
    const body = Buffer.from(archive.subarray(bodyStart, bodyEnd));

    if (type === "x") {
      pendingPath = parsePaxPath(body) || pendingPath;
    } else if (type === "g") {
      // npm may emit global PAX metadata, but it is not a package member.
    } else if (type === "L") {
      pendingPath = body.toString("utf8").replace(/\0.*$/s, "");
    } else {
      entries.push({ path: pendingPath || headerPath, type, mode, bytes: body });
      pendingPath = null;
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (pendingPath !== null) throw new Error("npm package contains orphaned TAR path metadata");
  return entries;
}

function packageFilesFromTar(tarball) {
  const packageFiles = [];
  const portableKeys = new Map();
  for (const entry of readTarEntries(tarball)) {
    if (typeof entry.path !== "string" || !entry.path.startsWith("package/")) {
      throw new Error("npm package contains an entry outside package/");
    }
    const packagePath = entry.path.slice("package/".length);
    if (entry.type === "5") {
      if (packagePath !== "" && portableIndexPath(packagePath) === null) {
        throw new Error("npm package contains an unsafe directory path");
      }
      continue;
    }
    if (entry.type !== "\0" && entry.type !== "0") {
      throw new Error("npm package contains a non-regular file entry");
    }
    const segments = portableIndexPath(packagePath);
    if (segments === null) throw new Error("npm package contains an unsafe file path");
    const portableKey = segments.map((segment) => segment.toLowerCase()).join("/");
    if (portableKeys.has(portableKey)) {
      throw new Error("npm package contains colliding file paths");
    }
    portableKeys.set(portableKey, packagePath);
    packageFiles.push({
      path: packagePath,
      size: entry.bytes.length,
      mode: entry.mode,
      type: "file",
      bytes: entry.bytes,
    });
  }
  return packageFiles;
}

function verifyNpmPackFileMetadata(metadataFiles, packageFiles) {
  if (!Array.isArray(metadataFiles)) {
    throw new Error("npm pack returned malformed file metadata");
  }
  const actual = new Map(packageFiles.map((entry) => [entry.path, entry]));
  const described = new Set();
  for (const entry of metadataFiles) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      described.has(entry.path)
    ) {
      throw new Error("npm pack returned malformed file metadata");
    }
    const actualEntry = actual.get(entry.path);
    if (!actualEntry || actualEntry.size !== entry.size) {
      throw new Error("npm pack file metadata does not match the real tarball");
    }
    described.add(entry.path);
  }
  if (described.size !== actual.size) {
    throw new Error("npm pack file metadata omits real tarball entries");
  }
}

function inspectMaterializedPackageArtifact(materializedRoot, options = {}) {
  const selectedFiles = snapshotMaterializedFiles(materializedRoot);
  let manifest;
  try {
    manifest = JSON.parse(selectedFiles.get("package.json").toString("utf8"));
  } catch (_error) {
    throw new Error("selected package.json is missing or malformed");
  }
  const lifecycleViolations = validatePackLifecycleScripts(manifest);
  if (lifecycleViolations.length > 0) {
    throw new Error(lifecycleViolations.join("; "));
  }

  const packDirectory = fs.mkdtempSync(path.join(os.tmpdir(), NPM_PACK_PREFIX));
  const baseEnvironment = options.env || process.env;
  const environment = { ...baseEnvironment };
  for (const name of Object.keys(environment)) {
    if (
      name.toLowerCase() === "npm_config_ignore_scripts" ||
      name.toLowerCase() === "npm_config_pack_destination"
    ) {
      delete environment[name];
    }
  }
  environment.npm_config_ignore_scripts = "true";
  environment.npm_config_pack_destination = packDirectory;
  const npmCommand =
    options.npmCommand ||
    (process.platform === "win32" ? environment.ComSpec || process.env.ComSpec || "cmd.exe" : "npm");
  const npmArguments =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "npm pack --json --ignore-scripts"]
      : ["pack", "--json", "--ignore-scripts"];
  try {
    const output = spawn(materializedRoot, npmCommand, npmArguments, {
      encoding: "utf8",
      env: environment,
      maxBuffer: 16 * 1024 * 1024,
    });
    const results = JSON.parse(output);
    if (!Array.isArray(results) || results.length !== 1 || typeof results[0] !== "object") {
      throw new Error("npm pack returned unexpected metadata");
    }
    const result = results[0];
    if (
      typeof result.filename !== "string" ||
      result.filename === "." ||
      result.filename === ".." ||
      /[\\/]/.test(result.filename) ||
      path.basename(result.filename) !== result.filename
    ) {
      throw new Error("npm pack returned an unsafe artifact filename");
    }
    const producedNames = fs.readdirSync(packDirectory);
    if (producedNames.length !== 1 || producedNames[0] !== result.filename) {
      throw new Error("npm pack did not produce exactly one artifact");
    }
    const artifactPath = path.join(packDirectory, result.filename);
    const stat = fs.lstatSync(artifactPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("npm pack did not produce one regular artifact");
    }
    const tarball = fs.readFileSync(artifactPath);
    const sha1 = crypto.createHash("sha1").update(tarball).digest("hex");
    const integrity = "sha512-" + crypto.createHash("sha512").update(tarball).digest("base64");
    if (result.size !== tarball.length || result.shasum !== sha1 || result.integrity !== integrity) {
      throw new Error("npm pack artifact metadata does not match the real tarball");
    }
    const packageFiles = packageFilesFromTar(tarball);
    verifyNpmPackFileMetadata(result.files, packageFiles);
    for (const entry of packageFiles) {
      const selectedBytes = selectedFiles.get(entry.path);
      if (!selectedBytes) {
        throw new Error(entry.path + ": npm package entry is absent from the selected Git index");
      }
      if (!entry.bytes.equals(selectedBytes)) {
        throw new Error(entry.path + ": npm package bytes differ from the selected Git index");
      }
    }
    if (!materializedSnapshotMatches(materializedRoot, selectedFiles)) {
      throw new Error("npm pack mutated the selected-index materialization");
    }
    const licenseEntries = packageFiles.filter((entry) => entry.path === "LICENSE");
    if (licenseEntries.length !== 1) {
      throw new Error("npm pack artifact must contain one regular package/LICENSE entry");
    }
    return {
      ...result,
      files: packageFiles.map(({ bytes: _bytes, ...entry }) => entry),
      artifact: Object.freeze({
        entries: packageFiles,
        integrity,
        licenseBytes: licenseEntries[0].bytes,
        sha1,
        size: tarball.length,
        verified: true,
      }),
    };
  } finally {
    fs.rmSync(packDirectory, { force: true, recursive: true });
  }
}

function inspectPackageArtifact(root, options = {}) {
  const environment = options.env || process.env;
  const entries = parseGitIndexEntries(
    spawn(root, "git", ["ls-files", "--stage", "-z"], { env: environment })
  );
  const materializedRoot = materializeSelectedIndex(root, entries, { env: environment });
  try {
    return inspectMaterializedPackageArtifact(materializedRoot, {
      env: environment,
      npmCommand: options.npmCommand,
    });
  } finally {
    fs.rmSync(materializedRoot, { force: true, recursive: true });
  }
}

function runPolicy(root = DEFAULT_ROOT, options = {}) {
  const environment = options.env || process.env;
  let trackedEntries;
  try {
    trackedEntries = parseGitIndexEntries(
      spawn(root, "git", ["ls-files", "--stage", "-z"], { env: environment })
    );
  } catch (_error) {
    return {
      trackedCount: 0,
      packageFileCount: 0,
      violations: ["Git index: selected index is not readable"],
    };
  }
  const tracked = [...new Set(trackedEntries.map((entry) => entry.path))];
  const violations = validateTrackedLicenseEntries(trackedEntries);
  let objectFormat;
  try {
    objectFormat = selectedRepositoryObjectFormat(root, environment);
  } catch (_error) {
    violations.push("Git index: repository object format is unsupported or unreadable");
  }
  const indexViolations = objectFormat
    ? validateSelectedIndexEntries(trackedEntries, objectFormat)
    : [];
  violations.push(...indexViolations);
  violations.push(...validateSelectedLicenseAttributes(root, { env: environment }));

  if (!objectFormat || indexViolations.length > 0) {
    return {
      trackedCount: tracked.length,
      packageFileCount: 0,
      violations,
    };
  }

  let materializedRoot;
  try {
    materializedRoot = materializeSelectedIndex(root, trackedEntries, {
      env: environment,
      objectFormat,
    });
  } catch (_error) {
    violations.push("Git index: selected blobs could not be safely materialized");
    return {
      trackedCount: tracked.length,
      packageFileCount: 0,
      violations,
    };
  }
  let packageFiles = [];
  try {
    try {
      violations.push(
        ...validateLicenseBytes(readMaterializedBytes(materializedRoot, "LICENSE"))
      );
    } catch (_error) {
      violations.push("LICENSE: selected Git index blob is not readable");
    }

    try {
      violations.push(
        ...validateRedisV5ScriptFixture({
          fixtureBytes: readMaterializedBytes(materializedRoot, REDIS_V5_FIXTURE_PATH),
          scriptDefinitions: loadRedisRuntimeScriptDefinitions(materializedRoot),
        })
      );
    } catch (_error) {
      violations.push("Redis V5 fixture: selected-index inputs are missing or unreadable");
    }

    const publicationDocuments = {};
    for (const filename of PUBLICATION_POLICY_FILES) {
      try {
        publicationDocuments[filename] = readMaterializedBytes(
          materializedRoot,
          filename
        ).toString("utf8");
      } catch (_error) {
        // The publication validator reports selected-index omissions uniformly.
      }
    }
    violations.push(
      ...validatePublicationGate(publicationDocuments, {
        workflowReleaseMetadataParserPath: path.join(
          materializedRoot,
          ...WORKFLOW_RELEASE_METADATA_PARSER_PATH.split("/")
        ),
      })
    );

    let manifest = null;
    let lockfile = null;
    let manifestParsed = false;
    let lockfileParsed = false;
    try {
      manifest = JSON.parse(readMaterializedBytes(materializedRoot, "package.json").toString("utf8"));
      manifestParsed = true;
    } catch (_error) {
      violations.push("package.json: missing or malformed manifest");
    }
    try {
      lockfile = JSON.parse(
        readMaterializedBytes(materializedRoot, "package-lock.json").toString("utf8")
      );
      lockfileParsed = true;
    } catch (_error) {
      violations.push("package-lock.json: missing or malformed lockfile");
    }
    if (manifestParsed && lockfileParsed) {
      violations.push(...validatePackageLicenseMetadata(manifest, lockfile));
    }
    const lifecycleViolations = manifestParsed ? validatePackLifecycleScripts(manifest) : [];
    violations.push(...lifecycleViolations);

    const forbiddenExtensions = new Set([
      ".aab",
      ".apk",
      ".db",
      ".jks",
      ".key",
      ".keystore",
      ".log",
      ".p12",
      ".pem",
      ".pfx",
      ".sqlite",
      ".sqlite3",
    ]);

    for (const filename of tracked) {
      const normalized = filename.replaceAll("\\", "/");
      const basename = path.posix.basename(normalized).toLowerCase();
      const extension = path.posix.extname(basename);
      const isEnvironmentFile =
        basename === ".env" ||
        (basename.startsWith(".env.") && !/[.](example|sample|template)$/.test(basename));
      if (isEnvironmentFile || forbiddenExtensions.has(extension)) {
        violations.push(filename + ": forbidden tracked artifact or credential file");
      }

      let bytes;
      try {
        bytes = readMaterializedBytes(materializedRoot, filename);
      } catch (_error) {
        violations.push(filename + ": selected-index entry is not a readable file");
        continue;
      }
      for (const kind of scanCredentialBytes(bytes)) {
        violations.push(filename + ": detected " + kind);
      }

      if (/^\.github\/workflows\/.*\.ya?ml$/i.test(normalized)) {
        const workflowText = bytes.toString("utf8");
        try {
          for (const reference of findActionReferences(workflowText)) {
            const problem = validateActionReference(reference);
            if (problem) violations.push(filename + ": " + problem + ": " + reference);
          }
        } catch (_error) {
          violations.push(filename + ": workflow action parser failed");
        }
      }
    }

    if (manifestParsed && lifecycleViolations.length === 0) {
      try {
        const packResult = inspectMaterializedPackageArtifact(materializedRoot, {
          env: environment,
          npmCommand: options.npmCommand,
        });
        packageFiles = Array.isArray(packResult.files) ? packResult.files : [];
        violations.push(...validatePackageLicenseEntries(packageFiles));
        if (
          !packResult.artifact ||
          !Buffer.isBuffer(packResult.artifact.licenseBytes) ||
          validateLicenseBytes(packResult.artifact.licenseBytes).length > 0
        ) {
          violations.push("LICENSE: npm package bytes must match the approved MIT text");
        }
        const trackedPaths = new Set(tracked);
        for (const entry of packageFiles) {
          if (!isAllowedPackagePath(entry.path, trackedPaths)) {
            violations.push(entry.path + ": unexpected npm package artifact");
          }
        }
        if ((packResult.size || 0) > 25 * 1024 * 1024) {
          violations.push("npm package exceeds the 25 MiB policy limit");
        }
      } catch (_error) {
        violations.push("npm package: selected-index artifact could not be built and inspected");
      }
    }

    const generatedRuntime = createContainerSmokeFiles(
      {},
      { randomBytes: (length) => Buffer.alloc(length, 0x2a) }
    ).runtime;
    try {
      violations.push(
        ...validateConfigurationDocumentation(
          {
            readme: readMaterializedBytes(materializedRoot, "README.md").toString("utf8"),
            environment: readMaterializedBytes(materializedRoot, ".env.example").toString("utf8"),
            fly: readMaterializedBytes(materializedRoot, "fly.toml").toString("utf8"),
          },
          generatedRuntime,
          {
            validateFlyRuntime(flyEnvironment) {
              const candidate = { ...generatedRuntime, ...flyEnvironment };
              loadStorageConfig(candidate);
              createPublicBaseUrlResolver(candidate);
              resolveTrustProxy(candidate);
            },
          }
        )
      );
    } catch (_error) {
      violations.push("configuration policy: selected-index inputs are missing or unreadable");
    }
  } finally {
    fs.rmSync(materializedRoot, { force: true, recursive: true });
  }

  return {
    trackedCount: tracked.length,
    packageFileCount: packageFiles.length,
    violations,
  };
}

if (require.main === module) {
  const result = runPolicy();
  if (result.violations.length > 0) {
    for (const violation of result.violations) {
      console.error("Repository policy: " + violation);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Repository policy passed: ${result.trackedCount} tracked files, ${result.packageFileCount} package files.`
    );
  }
}

module.exports = {
  APPROVED_LICENSE_SHA256,
  INDEX_TREE_PREFIX,
  NPM_PACK_PREFIX,
  PRIVATE_ADVISORY_SECURITY_LINE,
  PRIVATE_ADVISORY_URL,
  PRIVATE_REPORTING_STATUS,
  REQUIRED_CHECK_CONTEXTS,
  DEPLOY_CHECK_CONTEXT,
  PUBLIC_REPOSITORY_LINE,
  PUBLIC_REPOSITORY_URL,
  PUBLICATION_POLICY_FILES,
  WORKFLOW_RELEASE_METADATA_PARSER_PATH,
  PUBLISH_LIFECYCLE_SCRIPTS,
  REDIS_V5_FIXTURE_SHA256,
  REDIS_V5_POLICY_FILES,
  REDIS_V5_SCRIPT_LOADER_PATH,
  findActionReferences,
  inspectPackageArtifact,
  isAllowedPackagePath,
  materializeSelectedIndex,
  parseGitIndexEntries,
  parseWorkflowReleaseMetadata,
  readIndexedFileBytes,
  runPolicy,
  scanCredentialBytes,
  validateActionReference,
  validateConfigurationDocumentation,
  validateLicenseBytes,
  validatePackLifecycleScripts,
  validatePackageLicenseMetadata,
  validatePackageLicenseEntries,
  validatePublicationGate,
  validateRedisV5ScriptFixture,
  validateSelectedLicenseAttributes,
  validateSelectedIndexEntries,
  validateTrackedLicenseEntries,
};
