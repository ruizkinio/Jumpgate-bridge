"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const {
  APPROVED_LICENSE_SHA256,
  INDEX_TREE_PREFIX,
  NPM_PACK_PREFIX,
  PRIVATE_ADVISORY_SECURITY_LINE,
  PRIVATE_ADVISORY_URL,
  PRIVATE_REPORTING_STATUS,
  REQUIRED_CHECK_CONTEXTS,
  DEPLOY_CHECK_CONTEXT,
  PUBLICATION_POLICY_FILES,
  PUBLIC_REPOSITORY_LINE,
  PUBLIC_REPOSITORY_URL,
  PUBLISH_LIFECYCLE_SCRIPTS,
  REDIS_V5_FIXTURE_SHA256,
  REDIS_V5_POLICY_FILES,
  REDIS_V5_SCRIPT_LOADER_PATH,
  findActionReferences,
  inspectPackageArtifact,
  isAllowedPackagePath,
  materializeSelectedIndex,
  parseGitIndexEntries,
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
} = require("./repository-policy");
const { SCRIPT_DEFINITIONS } = require("../../lib/storage/redis/scripts");

const PROJECT_ROOT = path.join(__dirname, "..", "..");
const COMMIT = "0123456789abcdef".repeat(2) + "01234567";
const SHA256_OBJECT = "0123456789abcdef".repeat(4);
const DIGEST = "abcdef0123456789".repeat(4);
const REDIS_SCRIPT_DIRECTORY = path.posix.dirname(REDIS_V5_SCRIPT_LOADER_PATH);
const REDIS_V5_FIXTURE_FILES = Object.freeze([
  ...new Set([
    ...REDIS_V5_POLICY_FILES,
    ...fs
      .readdirSync(path.join(PROJECT_ROOT, ...REDIS_SCRIPT_DIRECTORY.split("/")), {
        withFileTypes: true,
      })
      .filter((entry) => entry.isFile())
      .map((entry) => path.posix.join(REDIS_SCRIPT_DIRECTORY, entry.name)),
  ]),
]);

function trackedLicense(overrides = {}) {
  return { mode: "100644", path: "LICENSE", stage: 0, ...overrides };
}

function runCommand(root, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.encoding,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : String(result.stderr || "");
    throw result.error || new Error(`${command} failed: ${stderr.trim()}`);
  }
  return result.stdout;
}

function createPolicyFixture(t, objectFormat, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `jumpgate-policy-${objectFormat}-`));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const initArguments = objectFormat === "sha1"
    ? ["init", "--quiet"]
    : ["init", "--quiet", `--object-format=${objectFormat}`];
  const initialized = spawnSync("git", initArguments, {
    cwd: root,
    encoding: "utf8",
  });
  if (initialized.error || initialized.status !== 0) {
    if (objectFormat === "sha256") {
      t.skip("installed Git does not support SHA-256 object-format repositories");
      return null;
    }
    throw initialized.error || new Error(initialized.stderr || "git init failed");
  }
  runCommand(root, "git", [
    "config",
    "core.autocrlf",
    options.autocrlf === false ? "false" : "true",
  ]);

  for (const filename of [
    "LICENSE",
    "README.md",
    ".env.example",
    ".gitattributes",
    "fly.toml",
    ...PUBLICATION_POLICY_FILES.filter((filename) => filename !== "README.md"),
    ...REDIS_V5_FIXTURE_FILES,
  ]) {
    const destination = path.join(root, filename);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(PROJECT_ROOT, filename), destination);
  }
  fs.writeFileSync(path.join(root, "index.js"), '"use strict";\n', "utf8");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: `jumpgate-policy-${objectFormat}-fixture`,
        version: "1.0.0",
        private: true,
        license: "MIT",
        main: "index.js",
        files: ["index.js", "README.md"],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    JSON.stringify(
      {
        name: `jumpgate-policy-${objectFormat}-fixture`,
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: `jumpgate-policy-${objectFormat}-fixture`,
            version: "1.0.0",
            license: "MIT",
          },
        },
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
  runCommand(root, "git", ["add", "--", "."]);
  return root;
}

function readIndexEntries(root, env = process.env) {
  return parseGitIndexEntries(
    runCommand(root, "git", ["ls-files", "--stage", "-z"], { env })
  );
}

function createTemporaryIndex(t, root) {
  const indexPath = path.join(
    os.tmpdir(),
    `jumpgate-candidate-index-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
  );
  t.after(() => fs.rmSync(indexPath, { force: true }));
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  runCommand(root, "git", ["read-tree", "--empty"], { env });
  runCommand(root, "git", ["add", "--", "."], { env });
  return env;
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function writeIndexBlob(root, env, filename, bytes, mode = "100644") {
  const objectId = String(
    runCommand(root, "git", ["hash-object", "-w", "--stdin"], { env, input: bytes })
  ).trim();
  runCommand(
    root,
    "git",
    ["update-index", "--add", "--cacheinfo", mode, objectId, filename],
    { env }
  );
  return objectId;
}

function temporaryPolicyDirectories() {
  return fs
    .readdirSync(os.tmpdir())
    .filter((name) => name.startsWith(INDEX_TREE_PREFIX) || name.startsWith(NPM_PACK_PREFIX))
    .sort();
}

test("Psych action parsing handles quoted keys and block and flow mappings", () => {
  const workflow = [
    '"jobs":',
    "  block:",
    "    steps:",
    '      - "uses": "actions/checkout@' + COMMIT + '"',
    "      - { 'uses': './.github/actions/local' }",
    "  flow: { steps: [ { uses: 'docker://alpine@sha256:" + DIGEST + "' } ] }",
    "  reusable:",
    "    uses: owner/repository/.github/workflows/check.yml@" + COMMIT,
  ].join("\n");
  const references = findActionReferences(workflow);
  assert.deepEqual(references, [
    "actions/checkout@" + COMMIT,
    "./.github/actions/local",
    "docker://alpine@sha256:" + DIGEST,
    "owner/repository/.github/workflows/check.yml@" + COMMIT,
  ]);
  for (const reference of references) {
    assert.equal(validateActionReference(reference), null);
  }
});

test("Psych action parsing ignores uses-like heredoc text but finds mutable flow actions", () => {
  const workflow = [
    "jobs:",
    "  policy:",
    "    steps:",
    "      - run: |",
    "          cat <<'YAML'",
    "          - uses: attacker/ignored@main",
    "          YAML",
    "      - { name: real, uses: attacker/detected@main }",
  ].join("\n");
  const references = findActionReferences(workflow);
  assert.deepEqual(references, ["attacker/detected@main"]);
  assert.match(validateActionReference(references[0]), /full commit SHA/);
});

test("mutable and malformed remote action references are rejected", () => {
  for (const reference of [
    "actions/checkout@v4",
    "actions/checkout@main",
    "docker://alpine:3.21",
    "docker://alpine@sha256:short",
    "../outside/action",
    "owner/repository@" + COMMIT.slice(1),
  ]) {
    assert.equal(typeof validateActionReference(reference), "string");
  }
});

test("credential scanning covers YAML secrets after large binary prefixes", () => {
  const traktName = "TRAKT_" + "CLIENT_SECRET";
  const yaml = Buffer.from("\n" + traktName + ": " + "a".repeat(64) + "\n", "ascii");
  const bytes = Buffer.concat([crypto.randomBytes(3 * 1024 * 1024), yaml]);
  assert.deepEqual(scanCredentialBytes(bytes), ["trakt-client-secret"]);
});

test("package artifact policy uses exact tracked paths and rejects suffix tricks", () => {
  const tracked = new Set([
    "LICENSE",
    "README.md",
    "index.js",
    "package.json",
    "lib/source.js",
    "lib/storage/README.md",
    "migrations/postgres/0001.sql",
    "public/configure.css",
  ]);
  for (const allowed of tracked) {
    assert.equal(isAllowedPackagePath(allowed, tracked), true, allowed);
  }
  for (const rejected of [
    "package.json.bak",
    "README.md.secret",
    "index.js.map",
    "lib/source.js.bak",
    "lib/source.secret.js",
    "lib/source.js.map",
    "libfoo/source.js",
    "library/source.js",
    "public/configure.css.map",
    "public/untracked.css",
    "lib/../index.js",
    "lib\\source.js",
  ]) {
    assert.equal(isAllowedPackagePath(rejected, tracked), false, rejected);
  }
});

test("package artifact policy permits only the exact tracked root LICENSE", () => {
  assert.equal(isAllowedPackagePath("LICENSE", new Set(["LICENSE"])), true);
  assert.equal(isAllowedPackagePath("LICENSE", new Set()), false);

  for (const rejected of [
    "license",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENSE.bak",
    "LICENSE.secret",
    "LICENSE.map",
    "docs/LICENSE",
    "LICENSE/copy",
    "./LICENSE",
    "LICENSE/",
    "LICENSE//copy",
    "LICENSE\\copy",
    "/LICENSE",
  ]) {
    assert.equal(
      isAllowedPackagePath(rejected, new Set([rejected])),
      false,
      rejected
    );
  }
});

test("Git index parsing preserves duplicate LICENSE stages", () => {
  const parsed = parseGitIndexEntries(
    Buffer.from(
      [
        `100644 ${COMMIT} 1\tLICENSE\0`,
        `100644 ${COMMIT} 2\tLICENSE\0`,
      ].join("")
    )
  );
  assert.deepEqual(parsed.map(({ mode, path, stage }) => ({ mode, path, stage })), [
    { mode: "100644", path: "LICENSE", stage: 1 },
    { mode: "100644", path: "LICENSE", stage: 2 },
  ]);
  assert.notDeepEqual(validateTrackedLicenseEntries(parsed), []);
});

test("Git index parsing accepts exactly 40- or 64-hex object IDs", () => {
  for (const objectId of [COMMIT, SHA256_OBJECT]) {
    const parsed = parseGitIndexEntries(`100644 ${objectId} 0\tLICENSE\0`);
    assert.equal(parsed[0].objectId, objectId);
  }
  for (const objectId of [
    "a".repeat(39),
    "a".repeat(41),
    "a".repeat(63),
    "a".repeat(65),
    "g" + "a".repeat(39),
  ]) {
    assert.throws(
      () => parseGitIndexEntries(`100644 ${objectId} 0\tLICENSE\0`),
      /invalid entry/,
      `object ID length ${objectId.length}`
    );
  }
  assert.throws(
    () => parseGitIndexEntries(Buffer.from(`100644 ${COMMIT} 0\tbad\xffpath\0`, "latin1")),
    /invalid UTF-8 path/
  );
  assert.throws(
    () => parseGitIndexEntries(`100644 ${COMMIT} 0\tunterminated`),
    /invalid entry/
  );
});

test("selected index materialization rejects special modes, unsafe paths, and collisions", () => {
  const entry = (filename, overrides = {}) => ({
    mode: "100644",
    objectId: COMMIT,
    path: filename,
    stage: 0,
    ...overrides,
  });
  assert.deepEqual(validateSelectedIndexEntries([entry("lib/runtime.js")], "sha1"), []);
  assert.deepEqual(
    validateSelectedIndexEntries(
      [entry("lib/runtime.js", { objectId: SHA256_OBJECT })],
      "sha256"
    ),
    []
  );

  for (const candidate of [
    [entry("link.js", { mode: "120000" })],
    [entry("gitlink", { mode: "160000" })],
    [entry("conflict.js", { stage: 2 })],
    [entry("short.js", { objectId: COMMIT.slice(1) })],
    [entry("/absolute.js")],
    [entry("C:/drive.js")],
    [entry("../outside.js")],
    [entry("lib\\runtime.js")],
    [entry("lib//runtime.js")],
    [entry(".git/config")],
    [entry("NUL.txt")],
    [entry("trailing-dot.")],
    [entry("line\nbreak.js")],
    [entry("LIB/runtime.js"), entry("lib/RUNTIME.js")],
    [entry("lib"), entry("lib/runtime.js")],
  ]) {
    assert.notDeepEqual(
      validateSelectedIndexEntries(candidate, "sha1"),
      [],
      JSON.stringify(candidate)
    );
  }
  assert.notDeepEqual(validateSelectedIndexEntries([entry("valid.js")], "unknown"), []);
});

test("tracked LICENSE policy requires one exact regular stage-0 Git entry", () => {
  assert.deepEqual(validateTrackedLicenseEntries([trackedLicense()]), []);
  assert.deepEqual(validateTrackedLicenseEntries([trackedLicense({ mode: "100755" })]), []);

  for (const entries of [
    [],
    [trackedLicense({ path: "LICENSE.md" })],
    [trackedLicense({ path: "license" })],
    [trackedLicense(), trackedLicense()],
    [trackedLicense(), trackedLicense({ path: "License" })],
    [trackedLicense({ mode: "120000" })],
    [trackedLicense({ mode: "040000" })],
    [trackedLicense({ mode: "160000" })],
    [trackedLicense({ stage: 2 })],
  ]) {
    assert.notDeepEqual(validateTrackedLicenseEntries(entries), [], JSON.stringify(entries));
  }
});

test("approved LICENSE policy pins exact bytes and SHA-256 digest", () => {
  const approved = fs.readFileSync(path.join(PROJECT_ROOT, "LICENSE"));
  assert.equal(crypto.createHash("sha256").update(approved).digest("hex"), APPROVED_LICENSE_SHA256);
  assert.deepEqual(validateLicenseBytes(approved), []);

  for (const changed of [
    Buffer.concat([approved, Buffer.from("\n")]),
    Buffer.from(approved.toString("utf8").replaceAll("\n", "\r\n"), "utf8"),
    Buffer.from(approved.toString("utf8").replace("2026", "2025"), "utf8"),
  ]) {
    assert.notDeepEqual(validateLicenseBytes(changed), []);
  }
  assert.throws(() => validateLicenseBytes(approved.toString("utf8")), /must be a Buffer/);
});

test("immutable Redis V5 fixture pins the runtime loader's composed claim source", () => {
  const fixturePath = path.join(
    PROJECT_ROOT,
    "test/fixtures/redis-playback-claim-v5.json"
  );
  const input = {
    fixtureBytes: fs.readFileSync(fixturePath),
    scriptDefinitions: SCRIPT_DEFINITIONS,
  };
  assert.equal(
    crypto.createHash("sha256").update(input.fixtureBytes).digest("hex"),
    REDIS_V5_FIXTURE_SHA256
  );
  assert.deepEqual(validateRedisV5ScriptFixture(input), []);

  const changedSource = SCRIPT_DEFINITIONS.playbackClaim.source + "\n-- changed\n";
  assert.deepEqual(
    validateRedisV5ScriptFixture({
      ...input,
      scriptDefinitions: {
        ...SCRIPT_DEFINITIONS,
        playbackClaim: {
          ...SCRIPT_DEFINITIONS.playbackClaim,
          source: changedSource,
          sha: crypto.createHash("sha1").update(changedSource, "utf8").digest("hex"),
        },
      },
    }),
    [
      "Redis V5 fixture: composite Redis SHA-1 changed; add a new protocol fixture/version",
      "Redis V5 fixture: independent policy SHA-256 changed; add a new protocol fixture/version",
    ]
  );

  const changedFixture = JSON.parse(input.fixtureBytes.toString("utf8"));
  changedFixture.protocolVersion = 6;
  assert.deepEqual(
    validateRedisV5ScriptFixture({
      ...input,
      fixtureBytes: Buffer.from(JSON.stringify(changedFixture) + "\n"),
    }),
    [
      "Redis V5 fixture: immutable fixture bytes changed; add a new protocol fixture/version",
      "Redis V5 fixture: protocol metadata is invalid",
    ]
  );
});

test("Redis V5 policy rejects a selected-index loader-only composition mutation", (t) => {
  const root = createPolicyFixture(t, "sha1");
  const loaderPath = path.join(root, ...REDIS_V5_SCRIPT_LOADER_PATH.split("/"));
  const loaderBytes = fs.readFileSync(loaderPath);
  const loaderSource = loaderBytes.toString("utf8");
  const composition = '? PLAYBACK_COMMON + "\\n" + body';
  const changedComposition = '? PLAYBACK_COMMON + "\\n-- loader-only mutation\\n" + body';
  assert.equal(loaderSource.split(composition).length - 1, 1);

  writeIndexBlob(
    root,
    process.env,
    REDIS_V5_SCRIPT_LOADER_PATH,
    Buffer.from(loaderSource.replace(composition, changedComposition), "utf8")
  );
  assert.deepEqual(fs.readFileSync(loaderPath), loaderBytes);

  assert.deepEqual(
    runPolicy(root).violations.filter((value) => value.startsWith("Redis V5 fixture:")),
    [
      "Redis V5 fixture: composite Redis SHA-1 changed; add a new protocol fixture/version",
      "Redis V5 fixture: independent policy SHA-256 changed; add a new protocol fixture/version",
    ]
  );
});

test("selected index LICENSE bytes are authoritative over either worktree direction", (t) => {
  const approved = fs.readFileSync(path.join(PROJECT_ROOT, "LICENSE"));

  const canonicalIndexRoot = createPolicyFixture(t, "sha1");
  const canonicalEntries = readIndexEntries(canonicalIndexRoot);
  fs.writeFileSync(
    path.join(canonicalIndexRoot, "LICENSE"),
    Buffer.from(approved.toString("utf8").replace("2026", "2025"), "utf8")
  );
  assert.deepEqual(
    validateLicenseBytes(readIndexedFileBytes(canonicalIndexRoot, canonicalEntries, "LICENSE")),
    []
  );
  const worktreeMismatch = runPolicy(canonicalIndexRoot).violations;
  assert.deepEqual(worktreeMismatch, []);

  const changedIndexRoot = createPolicyFixture(t, "sha1");
  const changed = Buffer.from(approved.toString("utf8").replace("2026", "2025"), "utf8");
  const changedObject = String(
    runCommand(changedIndexRoot, "git", ["hash-object", "-w", "--stdin"], { input: changed })
  ).trim();
  runCommand(changedIndexRoot, "git", [
    "update-index",
    "--cacheinfo",
    "100644",
    changedObject,
    "LICENSE",
  ]);
  assert.deepEqual(fs.readFileSync(path.join(changedIndexRoot, "LICENSE")), approved);
  const changedEntries = readIndexEntries(changedIndexRoot);
  assert.notDeepEqual(
    validateLicenseBytes(readIndexedFileBytes(changedIndexRoot, changedEntries, "LICENSE")),
    []
  );
  const indexMismatch = runPolicy(changedIndexRoot).violations;
  assert.equal(indexMismatch.some((value) => value.includes(APPROVED_LICENSE_SHA256)), true);
  assert.equal(indexMismatch.some((value) => value.includes("npm package bytes")), true);
});

test("manifest and lock root metadata require matching exact MIT SPDX identifiers", () => {
  const manifest = { license: "MIT" };
  const lockfile = { packages: { "": { license: "MIT" } } };
  assert.deepEqual(validatePackageLicenseMetadata(manifest, lockfile), []);

  assert.deepEqual(validatePackageLicenseMetadata({}, lockfile), [
    "package.json: license must be exact SPDX identifier MIT",
  ]);
  assert.deepEqual(validatePackageLicenseMetadata(manifest, { packages: { "": {} } }), [
    "package-lock.json: root package license must be exact SPDX identifier MIT",
  ]);
  assert.deepEqual(
    validatePackageLicenseMetadata({ license: "ISC" }, { packages: { "": { license: "MIT" } } }),
    [
      "package.json: license must be exact SPDX identifier MIT",
      "package.json and package-lock.json: root SPDX licenses must agree",
    ]
  );
  assert.deepEqual(
    validatePackageLicenseMetadata({ license: "MIT" }, { packages: { "": { license: "mit" } } }),
    [
      "package-lock.json: root package license must be exact SPDX identifier MIT",
      "package.json and package-lock.json: root SPDX licenses must agree",
    ]
  );
});

test("npm package LICENSE policy requires one exact regular file entry", () => {
  assert.deepEqual(validatePackageLicenseEntries([{ path: "LICENSE" }]), []);
  assert.deepEqual(validatePackageLicenseEntries([{ path: "LICENSE", type: "file" }]), []);
  assert.deepEqual(validatePackageLicenseEntries([{ path: "LICENSE", size: 1078 }]), []);

  for (const entries of [
    [],
    [{ path: "LICENSE.md" }],
    [{ path: "license" }],
    [{ path: "LICENSE" }, { path: "LICENSE" }],
    [{ path: "LICENSE" }, { path: "License" }],
    [{ path: "LICENSE", type: "symlink" }],
    [{ path: "LICENSE", type: "directory" }],
    [{ path: "LICENSE", type: "other" }],
    [{ path: "LICENSE", isFile: false }],
    [{ path: "LICENSE", isDirectory: true }],
    [{ path: "LICENSE", isSymbolicLink: true }],
    [{ path: "LICENSE", size: 1077 }],
  ]) {
    assert.notDeepEqual(validatePackageLicenseEntries(entries), [], JSON.stringify(entries));
  }
});

test("every npm publication lifecycle hook is forbidden", () => {
  const expected = [
    "prepublish",
    "prepublishOnly",
    "prepack",
    "prepare",
    "postpack",
    "publish",
    "postpublish",
  ];
  assert.deepEqual(PUBLISH_LIFECYCLE_SCRIPTS, expected);
  assert.deepEqual(validatePackLifecycleScripts({ scripts: { start: "node index.js" } }), []);
  for (const name of expected) {
    const violations = validatePackLifecycleScripts({ scripts: { [name]: "node mutate-pack.js" } });
    assert.equal(violations.length, 1, name);
    assert.match(violations[0], new RegExp(`package\\.json: ${name} lifecycle script`));
  }
});

for (const objectFormat of ["sha1", "sha256"]) {
  test(`selected ${objectFormat.toUpperCase()} index controls every lifecycle hook in both worktree directions`, (t) => {
    const root = createPolicyFixture(t, objectFormat);
    if (!root) return;
    const env = createTemporaryIndex(t, root);
    const entries = readIndexEntries(root, env);
    const cleanManifestBytes = readIndexedFileBytes(root, entries, "package.json", { env });
    const cleanManifest = JSON.parse(cleanManifestBytes.toString("utf8"));
    const missingNpmCommand = path.join(root, "definitely-missing-npm-command");

    for (const hook of PUBLISH_LIFECYCLE_SCRIPTS) {
      const hookedManifest = {
        ...cleanManifest,
        scripts: {
          [hook]: "node -e \"require('node:fs').writeFileSync('candidate-script-ran','yes')\"",
        },
      };
      const hookedBytes = Buffer.from(JSON.stringify(hookedManifest, null, 2) + "\n", "utf8");

      writeIndexBlob(root, env, "package.json", hookedBytes);
      fs.writeFileSync(path.join(root, "package.json"), cleanManifestBytes);
      const selectedHookResult = runPolicy(root, {
        env,
        npmCommand: missingNpmCommand,
      });
      assert.equal(
        selectedHookResult.violations.some((value) =>
          value.includes(`package.json: ${hook} lifecycle script`)
        ),
        true,
        hook
      );
      assert.equal(
        selectedHookResult.violations.some((value) => value.startsWith("npm package:")),
        false,
        `${hook} must be rejected before npm pack`
      );

      writeIndexBlob(root, env, "package.json", cleanManifestBytes);
      fs.writeFileSync(path.join(root, "package.json"), hookedBytes);
      const worktreeHookResult = runPolicy(root, {
        env,
        npmCommand: missingNpmCommand,
      });
      assert.equal(
        worktreeHookResult.violations.some((value) => value.includes(`${hook} lifecycle script`)),
        false,
        hook
      );
      assert.equal(
        worktreeHookResult.violations.some((value) => value.startsWith("npm package:")),
        true,
        `${hook} in only the worktree must reach npm pack`
      );
      assert.equal(fs.existsSync(path.join(root, "candidate-script-ran")), false, hook);
    }
  });

  test(`real npm pack uses ${objectFormat.toUpperCase()} index allowlist and runtime bytes, never divergent worktree bytes`, (t) => {
    const root = createPolicyFixture(t, objectFormat);
    if (!root) return;

    const runtimePath = path.join(root, "lib", "indexed-runtime.js");
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(runtimePath, 'module.exports = "selected-index-runtime";\n', "utf8");
    const selectedManifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    selectedManifest.files = ["index.js", "README.md", "lib/indexed-runtime.js"];
    writeJson(path.join(root, "package.json"), selectedManifest);

    const env = createTemporaryIndex(t, root);
    const selectedEntries = readIndexEntries(root, env);
    const selectedManifestBytes = readIndexedFileBytes(root, selectedEntries, "package.json", {
      env,
    });
    const selectedRuntimeBytes = readIndexedFileBytes(
      root,
      selectedEntries,
      "lib/indexed-runtime.js",
      { env }
    );

    fs.writeFileSync(
      runtimePath,
      `const ignored = "github_pat_${"A".repeat(30)}";\n`,
      "utf8"
    );
    fs.writeFileSync(
      path.join(root, "lib", "worktree-only.js"),
      'module.exports = "worktree-only";\n',
      "utf8"
    );
    writeJson(path.join(root, "package.json"), {
      ...selectedManifest,
      license: "ISC",
      files: ["index.js", "README.md", "lib/worktree-only.js"],
    });

    const packResult = inspectPackageArtifact(root, { env });
    const packagePaths = new Set(packResult.files.map((entry) => entry.path));
    assert.equal(packagePaths.has("lib/indexed-runtime.js"), true);
    assert.equal(packagePaths.has("lib/worktree-only.js"), false);
    const artifactEntries = new Map(
      packResult.artifact.entries.map((entry) => [entry.path, entry.bytes])
    );
    assert.deepEqual(artifactEntries.get("package.json"), selectedManifestBytes);
    assert.deepEqual(artifactEntries.get("lib/indexed-runtime.js"), selectedRuntimeBytes);
    assert.equal(
      artifactEntries.get("lib/indexed-runtime.js").includes(Buffer.from("github_pat_")),
      false
    );

    assert.deepEqual(runPolicy(root, { env }).violations, []);
  });
}

test("selected-index materialization and npm pack failures clean every temporary tree", (t) => {
  const root = createPolicyFixture(t, "sha1");
  const env = createTemporaryIndex(t, root);
  const entries = readIndexEntries(root, env);
  const indexBytes = readIndexedFileBytes(root, entries, "index.js", { env });
  writeIndexBlob(root, env, "linked-runtime.js", indexBytes, "120000");

  let before = temporaryPolicyDirectories();
  assert.throws(() => inspectPackageArtifact(root, { env }), /special Git index modes/);
  assert.deepEqual(temporaryPolicyDirectories(), before);

  writeIndexBlob(root, env, "linked-runtime.js", indexBytes, "100644");
  const cleanManifestBytes = readIndexedFileBytes(root, entries, "package.json", { env });
  const cleanManifest = JSON.parse(cleanManifestBytes.toString("utf8"));
  const hookedManifest = {
    ...cleanManifest,
    scripts: { prepack: "node candidate-script.js" },
  };
  writeIndexBlob(
    root,
    env,
    "package.json",
    Buffer.from(JSON.stringify(hookedManifest, null, 2) + "\n", "utf8")
  );
  const missingCommand = path.join(root, "definitely-missing-npm-command");
  before = temporaryPolicyDirectories();
  assert.throws(
    () => inspectPackageArtifact(root, { env, npmCommand: missingCommand }),
    /prepack lifecycle script is forbidden/
  );
  assert.deepEqual(temporaryPolicyDirectories(), before);

  writeIndexBlob(root, env, "package.json", cleanManifestBytes);
  before = temporaryPolicyDirectories();
  assert.throws(() => inspectPackageArtifact(root, { env, npmCommand: missingCommand }));
  assert.deepEqual(temporaryPolicyDirectories(), before);

  const missingObjectEntries = [
    {
      mode: "100644",
      objectId: "f".repeat(40),
      path: "missing-object.js",
      stage: 0,
    },
  ];
  before = temporaryPolicyDirectories();
  assert.throws(() => materializeSelectedIndex(root, missingObjectEntries, { env }));
  assert.deepEqual(temporaryPolicyDirectories(), before);
});

test("publication gate binds the canonical repository and private advisory channel", () => {
  const documents = Object.fromEntries(
    PUBLICATION_POLICY_FILES.map((filename) => [
      filename,
      fs.readFileSync(path.join(PROJECT_ROOT, filename), "utf8"),
    ])
  );
  assert.deepEqual(validatePublicationGate(documents), []);
  assert.equal(documents["README.md"].split(PUBLIC_REPOSITORY_LINE).length, 2);
  assert.equal(documents["SECURITY.md"].split(PRIVATE_ADVISORY_SECURITY_LINE).length, 2);

  const misplacedRepository = {
    ...documents,
    "SUPPORT.md": documents["SUPPORT.md"] + `\n${PUBLIC_REPOSITORY_URL}\n`,
  };
  assert.equal(
    validatePublicationGate(misplacedRepository).some((value) =>
      value.includes("canonical repository URL")
    ),
    true
  );

  const unverifiedAdvisory = {
    ...documents,
    "SECURITY.md": documents["SECURITY.md"] +
      "\nhttps://github.com/example/project/security/advisories/new\n",
  };
  assert.equal(
    validatePublicationGate(unverifiedAdvisory).some((value) => value.includes("private-advisory")),
    true
  );

  const duplicatedAdvisory = {
    ...documents,
    "README.md": documents["README.md"] + `\n${PRIVATE_ADVISORY_URL}\n`,
  };
  assert.equal(
    validatePublicationGate(duplicatedAdvisory).some((value) => value.includes("private-advisory")),
    true
  );

  const hardcodedConfigureLink = {
    ...documents,
    "public/configure.html": documents["public/configure.html"].replace(
      "@@JUMPGATE_POLICY_LINKS@@",
      '<a href="https://policies.example/privacy">Privacy</a>'
    ),
  };
  assert.equal(
    validatePublicationGate(hardcodedConfigureLink).some((value) => value.includes("hardcoded")),
    true
  );

  const dishonestIssueForm = {
    ...documents,
    ".github/ISSUE_TEMPLATE/bug_report.yml": documents[
      ".github/ISSUE_TEMPLATE/bug_report.yml"
    ].replace(PRIVATE_REPORTING_STATUS, "Report privately."),
  };
  assert.equal(
    validatePublicationGate(dishonestIssueForm).some((value) => value.includes("status must be explicit")),
    true
  );

  const missingContactLink = {
    ...documents,
    ".github/ISSUE_TEMPLATE/config.yml": documents[
      ".github/ISSUE_TEMPLATE/config.yml"
    ].replace("contact_links:", "disabled_contact_links:"),
  };
  assert.equal(
    validatePublicationGate(missingContactLink).some((value) =>
      value.includes("private security contact link")
    ),
    true
  );

  for (const filename of ["SUPPORT.md", "PRIVACY.md"]) {
    const staleStatus = {
      ...documents,
      [filename]: documents[filename].replace(
        PRIVATE_REPORTING_STATUS,
        "No private reporting channel is published yet."
      ),
    };
    assert.equal(
      validatePublicationGate(staleStatus).some((value) =>
        value.includes("stale pre-publication reporting status")
      ),
      true
    );
  }

  const unboundedPush = {
    ...documents,
    ".github/workflows/fly-deploy.yml": documents[
      ".github/workflows/fly-deploy.yml"
    ].replace("  push:\n    branches:\n      - main\n", "  push:\n"),
  };
  assert.equal(
    validatePublicationGate(unboundedPush).some((value) =>
      value.includes("push CI must target only main")
    ),
    true
  );

  const additionalPushBranch = {
    ...documents,
    ".github/workflows/fly-deploy.yml": documents[
      ".github/workflows/fly-deploy.yml"
    ].replace("      - main\n", "      - main\n      - release/**\n"),
  };
  assert.equal(
    validatePublicationGate(additionalPushBranch).some((value) =>
      value.includes("push CI must target only main")
    ),
    true
  );

  const renamedWorkflowContext = {
    ...documents,
    ".github/workflows/fly-deploy.yml": documents[
      ".github/workflows/fly-deploy.yml"
    ].replace("    name: Quality / Node 24", "    name: Quality / Node current"),
  };
  assert.equal(
    validatePublicationGate(renamedWorkflowContext).some((value) =>
      value.includes("emitted check contexts must exactly match")
    ),
    true
  );

  for (const exactJobLine of [
    "    name: Quality / Node 24",
    "    name: Bridge / Kodi fingerprint parity",
    "    name: Immutable production image / PostgreSQL + Redis + private S3",
    "    name: Redis ${{ matrix.redis_major }} / 48 live contracts",
    "    name: PostgreSQL ${{ matrix.postgres_major }} / 22 live storage contracts",
  ]) {
    const suffixedWorkflowContext = {
      ...documents,
      ".github/workflows/fly-deploy.yml": documents[
        ".github/workflows/fly-deploy.yml"
      ].replace(exactJobLine, exactJobLine + " renamed"),
    };
    assert.equal(
      validatePublicationGate(suffixedWorkflowContext).some((value) =>
        value.includes("emitted check contexts must exactly match")
      ),
      true,
      exactJobLine
    );
  }

  const suffixedDeployContext = {
    ...documents,
    ".github/workflows/fly-deploy.yml": documents[
      ".github/workflows/fly-deploy.yml"
    ].replace(
      `    name: ${DEPLOY_CHECK_CONTEXT}`,
      `    name: ${DEPLOY_CHECK_CONTEXT} renamed`
    ),
  };
  assert.equal(
    validatePublicationGate(suffixedDeployContext).some((value) =>
      value.includes("deployment check context must appear exactly once")
    ),
    true
  );

  const missingRequiredContext = {
    ...documents,
    "scripts/ci/RELEASE_GATES.md": documents["scripts/ci/RELEASE_GATES.md"].replace(
      `\`${REQUIRED_CHECK_CONTEXTS[0]}\``,
      "`renamed check`"
    ),
  };
  assert.equal(
    validatePublicationGate(missingRequiredContext).some((value) =>
      value.includes("required context must appear exactly once")
    ),
    true
  );

  const requiredDeployment = {
    ...documents,
    "scripts/ci/RELEASE_GATES.md": documents["scripts/ci/RELEASE_GATES.md"].replace(
      "a required pre-merge status check",
      "another required pre-merge status check"
    ),
  };
  assert.equal(
    validatePublicationGate(requiredDeployment).some((value) =>
      value.includes("deployment job must be explicitly excluded")
    ),
    true
  );
  assert.equal(documents["scripts/ci/RELEASE_GATES.md"].includes(DEPLOY_CHECK_CONTEXT), true);
});

for (const objectFormat of ["sha1", "sha256"]) {
  test(`full repository policy accepts a temporary ${objectFormat.toUpperCase()} Git index and real npm pack artifact`, (t) => {
    const root = createPolicyFixture(t, objectFormat);
    if (!root) return;

    const primaryIndexBefore = runCommand(root, "git", ["ls-files", "--stage", "-z"]);
    const env = createTemporaryIndex(t, root);
    const parsed = readIndexEntries(root, env);
    const expectedLength = objectFormat === "sha1" ? 40 : 64;
    assert.equal(parsed.length, 7 + PUBLICATION_POLICY_FILES.length + REDIS_V5_FIXTURE_FILES.length);
    assert.equal(parsed.every((entry) => entry.objectId.length === expectedLength), true);
    assert.deepEqual(validateTrackedLicenseEntries(parsed), []);
    assert.deepEqual(validateSelectedLicenseAttributes(root, { env }), []);
    const indexedLicense = readIndexedFileBytes(root, parsed, "LICENSE", { env });
    assert.equal(indexedLicense.includes(Buffer.from("\r\n")), false);
    assert.deepEqual(validateLicenseBytes(indexedLicense), []);
    assert.equal(
      String(runCommand(root, "git", ["config", "--get", "core.autocrlf"])).trim(),
      "true"
    );

    const packResult = inspectPackageArtifact(root, { env });
    assert.equal(packResult.artifact.verified, true);
    assert.equal(packResult.artifact.size, packResult.size);
    assert.deepEqual(validateLicenseBytes(packResult.artifact.licenseBytes), []);
    const packagePaths = new Set(packResult.files.map((entry) => entry.path));
    for (const expected of ["LICENSE", "README.md", "index.js", "package.json"]) {
      assert.equal(packagePaths.has(expected), true, expected);
    }
    for (const excluded of [".env.example", "fly.toml", "package-lock.json"]) {
      assert.equal(packagePaths.has(excluded), false, excluded);
    }
    assert.deepEqual(validatePackageLicenseEntries(packResult.files), []);

    assert.deepEqual(runPolicy(root, { env }).violations, []);
    assert.deepEqual(
      runCommand(root, "git", ["ls-files", "--stage", "-z"]),
      primaryIndexBefore,
      "candidate policy must not mutate the primary index"
    );
  });
}

test("copied environment example keeps optional credentials disabled and production fails closed", () => {
  const removedNames = new Set(["NODE_ENV", "TRAKT_CLIENT_SECRET", "TMDB_API_KEY"]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !removedNames.has(name.toUpperCase()))
  );

  const optionalProbe = spawnSync(
    process.execPath,
    [
      "--env-file=.env.example",
      "-e",
      "process.stdout.write(JSON.stringify({trakt:Object.hasOwn(process.env,'TRAKT_CLIENT_SECRET'),tmdb:Object.hasOwn(process.env,'TMDB_API_KEY')}))",
    ],
    { cwd: PROJECT_ROOT, encoding: "utf8", env: environment }
  );
  assert.equal(optionalProbe.error, undefined);
  assert.equal(optionalProbe.status, 0, optionalProbe.stderr);
  assert.deepEqual(JSON.parse(optionalProbe.stdout), { trakt: false, tmdb: false });

  const productionProbe = spawnSync(
    process.execPath,
    [
      "--env-file=.env.example",
      "-e",
      'process.env.NODE_ENV="production";require("./index.js")',
    ],
    { cwd: PROJECT_ROOT, encoding: "utf8", env: environment }
  );
  assert.equal(productionProbe.error, undefined);
  assert.equal(productionProbe.status, 1, productionProbe.stderr);
  assert.match(
    productionProbe.stderr,
    /FATAL: TRAKT_CLIENT_SECRET environment variable is required in production/
  );
});

test("production configuration documentation stays aligned with the runtime fixture", () => {
  const runtime = {
    JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE: "tigris-version-purge-v1",
    NODE_ENV: "production",
    PORT: "7515",
    TRAKT_CLIENT_SECRET: "secret-manager-value",
    NODE_EXTRA_CA_CERTS: "/run/jumpgate-ca/ca.crt",
  };
  const complete = {
    readme: [
      "### Production Topology",
      "```dotenv",
      "NODE_ENV=production",
      "PORT=7515",
      "JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE=tigris-version-purge-v1",
      "TRAKT_CLIENT_SECRET=REDACTED",
      "```",
      "## Environment Variables",
      "| Variable | Local default | Production requirement |",
      "| --- | --- | --- |",
      "| `NODE_ENV` | local | production |",
      "| `PORT` | local | production |",
      "| `JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE` | local | production |",
      "| `TRAKT_CLIENT_SECRET` | local | production |",
    ].join("\n"),
    environment: [
      "NODE_ENV=development",
      "PORT=7515",
      "# JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE=blocked-tigris-provider-confirmation-required",
      "# TRAKT_CLIENT_SECRET=secret-manager-value",
    ].join("\n"),
    fly: [
      "[env]",
      "  NODE_ENV = 'production'",
      "  JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE = 'tigris-version-purge-v1'",
      "[http_service]",
      "  internal_port = 7515",
    ].join("\n"),
  };
  assert.deepEqual(validateConfigurationDocumentation(complete, runtime), []);

  const incomplete = {
    ...complete,
    readme: complete.readme.replace("| `TRAKT_CLIENT_SECRET` | local | production |", ""),
    environment: complete.environment.replace("# TRAKT_CLIENT_SECRET=secret-manager-value", ""),
    fly: complete.fly.replace("  NODE_ENV = 'production'", "  # NODE_ENV = 'production'"),
  };
  assert.deepEqual(validateConfigurationDocumentation(incomplete, runtime), [
    "fly.toml: deployment configuration omits NODE_ENV",
    "README.md: environment table omits TRAKT_CLIENT_SECRET",
    ".env.example: production configuration omits TRAKT_CLIENT_SECRET",
  ]);

  const movedOutsideSection = {
    ...complete,
    readme: complete.readme.replace(
      "### Production Topology\n```dotenv\nNODE_ENV=production\n",
      "NODE_ENV=production\n### Production Topology\n```dotenv\n"
    ),
  };
  assert.deepEqual(validateConfigurationDocumentation(movedOutsideSection, runtime), [
    "README.md: production topology example omits NODE_ENV",
  ]);

  const wrongFlyTable = {
    ...complete,
    fly: [
      "[env]",
      "  # NODE_ENV = 'production'",
      "[[vm]]",
      "  NODE_ENV = 'production'",
      "[http_service]",
      "  internal_port = 7515",
    ].join("\n"),
  };
  assert.deepEqual(validateConfigurationDocumentation(wrongFlyTable, runtime), [
    "fly.toml: deployment configuration omits JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE",
    "fly.toml: deployment configuration omits NODE_ENV",
  ]);

  const arrayEnvDecoy = {
    ...complete,
    fly: ["[[env]]", "  NODE_ENV = 'production'"].join("\n"),
  };
  assert.deepEqual(validateConfigurationDocumentation(arrayEnvDecoy, runtime), [
    "fly.toml: unsupported or malformed configuration",
  ]);

  const multilineTomlDecoy = {
    ...complete,
    fly: [
      "notes = '''",
      "[env]",
      "NODE_ENV = 'production'",
      "'''",
      "[http_service]",
      "internal_port = 7515",
    ].join("\n"),
  };
  assert.deepEqual(validateConfigurationDocumentation(multilineTomlDecoy, runtime), [
    "fly.toml: deployment configuration omits JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE",
    "fly.toml: deployment configuration omits NODE_ENV",
  ]);

  const invalidTomlAssignment = {
    ...complete,
    fly: ["[env]", "NODE_ENV ="].join("\n"),
  };
  assert.deepEqual(validateConfigurationDocumentation(invalidTomlAssignment, runtime), [
    "fly.toml: unsupported or malformed configuration",
  ]);

  const movedTableRow = {
    ...complete,
    readme: complete.readme
      .replace(
        "## Environment Variables\n",
        [
          "## Environment Variables",
          "| Variable | Local default | Production requirement |",
          "| --- | --- | --- |",
          "| `NODE_ENV` | decoy | decoy |",
          "",
          "",
        ].join("\n")
      )
      .replace("| `NODE_ENV` | local | production |\n", ""),
  };
  assert.deepEqual(validateConfigurationDocumentation(movedTableRow, runtime), [
    "README.md: unsupported or malformed documentation structure",
  ]);

  const wrongTableHeader = {
    ...complete,
    readme: complete.readme.replace(
      "| Variable | Local default | Production requirement |",
      "| Setting | Local default | Production requirement |"
    ),
  };
  assert.deepEqual(validateConfigurationDocumentation(wrongTableHeader, runtime), [
    "README.md: unsupported or malformed documentation structure",
  ]);

  const unsafeFlyValue = {
    ...complete,
    fly: complete.fly.replace("NODE_ENV = 'production'", "NODE_ENV = 'development'"),
  };
  assert.deepEqual(validateConfigurationDocumentation(unsafeFlyValue, runtime), [
    "fly.toml: deployment value for NODE_ENV does not match runtime fixture",
  ]);

  const unsafeReadmeValue = {
    ...complete,
    readme: complete.readme.replace("NODE_ENV=production", "NODE_ENV=development"),
  };
  assert.deepEqual(validateConfigurationDocumentation(unsafeReadmeValue, runtime), [
    "README.md: production value for NODE_ENV does not match runtime fixture",
  ]);

  const wrongInternalPort = {
    ...complete,
    fly: complete.fly.replace("internal_port = 7515", "internal_port = 7000"),
  };
  assert.deepEqual(validateConfigurationDocumentation(wrongInternalPort, runtime), [
    "fly.toml: http_service.internal_port does not match runtime PORT",
  ]);

  const nonScalarFlyValue = {
    ...complete,
    fly: complete.fly.replace("NODE_ENV = 'production'", "NODE_ENV = ['production']"),
  };
  assert.deepEqual(validateConfigurationDocumentation(nonScalarFlyValue, runtime), [
    "fly.toml: unsupported or malformed configuration",
  ]);

  const nestedFlyValue = {
    ...complete,
    fly: ["[env.NODE_ENV]", "value = 'production'"].join("\n"),
  };
  assert.deepEqual(validateConfigurationDocumentation(nestedFlyValue, runtime), [
    "fly.toml: unsupported or malformed configuration",
  ]);

  const committedSecret = {
    ...complete,
    fly: complete.fly.replace(
      "[http_service]",
      "TRAKT_CLIENT_SECRET = 'committed-value'\n[http_service]"
    ),
  };
  assert.deepEqual(validateConfigurationDocumentation(committedSecret, runtime), [
    "fly.toml: TRAKT_CLIENT_SECRET must be supplied outside committed [env]",
  ]);

  const unexpectedFlyValue = {
    ...complete,
    fly: complete.fly.replace(
      "[http_service]",
      "UNEXPECTED_RUNTIME_VALUE = 'decoy'\n[http_service]"
    ),
  };
  assert.deepEqual(validateConfigurationDocumentation(unexpectedFlyValue, runtime), [
    "fly.toml: deployment configuration includes unexpected UNEXPECTED_RUNTIME_VALUE",
  ]);

  const permanentErasureAttestation = {
    ...complete,
    fly: complete.fly.replace(
      "JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE = 'tigris-version-purge-v1'",
      "JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE = " +
        "'blocked-tigris-provider-confirmation-required'"
    ),
  };
  assert.deepEqual(
    validateConfigurationDocumentation(permanentErasureAttestation, runtime),
    []
  );

  assert.deepEqual(
    validateConfigurationDocumentation(complete, runtime, {
      validateFlyRuntime() {
        throw new Error("unsafe production value");
      },
    }),
    ["fly.toml: deployment values violate the production runtime contract"]
  );

  const dotenvComment = {
    ...complete,
    readme: complete.readme.replace(
      "NODE_ENV=production",
      "# Values below are deployed through Fly.\nNODE_ENV=production"
    ),
  };
  assert.deepEqual(validateConfigurationDocumentation(dotenvComment, runtime), []);

  const hiddenProductionFence = {
    ...complete,
    readme: complete.readme.replace(
      "```dotenv\nNODE_ENV=production\n",
      [
        "<!--",
        "```dotenv",
        "NODE_ENV=production",
        "```",
        "-->",
        "```dotenv",
      ].join("\n") + "\n"
    ),
  };
  assert.deepEqual(validateConfigurationDocumentation(hiddenProductionFence, runtime), [
    "README.md: production topology example omits NODE_ENV",
  ]);

  const fencedTableRow = {
    ...complete,
    readme: complete.readme
      .replace(
        "## Environment Variables\n",
        [
          "## Environment Variables",
          "```markdown",
          "| `NODE_ENV` | hidden | hidden |",
          "```",
        ].join("\n") + "\n"
      )
      .replace("| `NODE_ENV` | local | production |\n", ""),
  };
  assert.deepEqual(validateConfigurationDocumentation(fencedTableRow, runtime), [
    "README.md: environment table omits NODE_ENV",
  ]);

  const windowsLineEndings = Object.fromEntries(
    Object.entries(complete).map(([name, value]) => [name, value.replaceAll("\n", "\r\n")])
  );
  assert.deepEqual(validateConfigurationDocumentation(windowsLineEndings, runtime), []);
});
