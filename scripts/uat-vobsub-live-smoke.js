"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { fingerprintStream, hashOpaqueValue } = require("../lib/source-context");

const ORIGIN = "https://jumpgate-uat.fly.dev";
const CONTENT_ID = "jumpgate-uat-vobsub-v1";
const MEDIA_SHA256 = "f976676998f0bd96fbec35daf20aaa128ff3fc82c68af5177867841b79b4060b";
const PARTS = Object.freeze([
  Object.freeze({
    extension: ".idx",
    size: 1874,
    sha256: "b53142fdfd9bafed6ada88752081b08d59f34f0504597784619df2f038f0a5d9",
  }),
  Object.freeze({
    extension: ".sub",
    size: 12288,
    sha256: "1ba391e3399b837f217f2f117be44a3b3f00f7286778567a5da23e70954a13b4",
  }),
]);

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function expectedBuildSha(argv) {
  const values = argv.filter((value) => value.startsWith("--expected-sha="));
  if (values.length !== 1 || argv.length !== 1) {
    throw Object.assign(new Error("expected exactly --expected-sha=<40-hex-commit>"), {
      code: "invalid_arguments",
    });
  }
  const value = values[0].slice("--expected-sha=".length);
  if (!/^[a-f0-9]{40}$/.test(value)) {
    throw Object.assign(new Error("expected build SHA is invalid"), {
      code: "invalid_arguments",
    });
  }
  return value;
}

async function response(path, options = {}) {
  const result = await fetch(ORIGIN + path, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    ...options,
  });
  if (!result.ok) {
    const error = new Error("UAT endpoint rejected the request");
    error.code = "http_" + result.status;
    throw error;
  }
  return result;
}

async function json(path, options = {}) {
  const result = await response(path, options);
  const contentType = result.headers.get("content-type") || "";
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    throw Object.assign(new Error("UAT endpoint returned a non-JSON response"), {
      code: "invalid_content_type",
    });
  }
  return result.json();
}

function post(path, body, headers = {}) {
  return json(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function configFromPage(html) {
  const match = html.match(/<script id="jumpgate-uat-bootstrap"[^>]*>([^<]+)<\/script>/);
  if (!match) {
    throw Object.assign(new Error("UAT bootstrap is missing"), { code: "bootstrap_missing" });
  }
  const parsed = JSON.parse(match[1]);
  if (!parsed || typeof parsed.config !== "string" || !/^[A-Za-z0-9_-]+$/.test(parsed.config)) {
    throw Object.assign(new Error("UAT bootstrap config is invalid"), {
      code: "bootstrap_invalid",
    });
  }
  return parsed.config;
}

function managementFromActivation(response, body) {
  const cookie = (response.headers.get("set-cookie") || "").split(";", 1)[0];
  const csrf = body && typeof body.managementCsrf === "string" ? body.managementCsrf : "";
  if (!/^jg_management_session=[A-Za-z0-9_-]{24,}$/.test(cookie)) return null;
  if (!/^[A-Za-z0-9_-]{24,}$/.test(csrf)) return null;
  return Object.freeze({ cookie, csrf });
}

function failureCode(error) {
  return error && typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
    ? error.code
    : "assertion_failed";
}

async function run() {
  let phase = "arguments";
  let management = null;
  try {
    const expectedSha = expectedBuildSha(process.argv.slice(2));
    phase = "version";
    const version = await json("/version");
    assert.equal(version.version, "3.0.0");
    assert.equal(version.buildSha, expectedSha);

    phase = "bootstrap";
    const config = configFromPage(await (await response("/configure")).text());

    phase = "pair_issue";
    const issued = await post("/pair/device/code", { validationScenario: "normal" });
    assert.match(issued.userCode, /^[A-Z0-9-]+$/);
    assert.match(issued.deviceCode, /^[A-Za-z0-9_-]{32,128}$/);

    phase = "pair_activate";
    const activationResponse = await response("/pair/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userCode: issued.userCode,
        config,
        activationRetryToken: crypto.randomBytes(32).toString("base64url"),
      }),
    });
    const activated = await activationResponse.json();
    management = managementFromActivation(activationResponse, activated);
    assert.equal(activated.paired, true);
    assert.ok(management);
    assert.match(activated.managementCsrf, /^[A-Za-z0-9_-]{24,}$/);

    phase = "pair_redeem";
    const redeemed = await post("/pair/device/token", { deviceCode: issued.deviceCode });
    assert.equal(redeemed.paired, true);
    assert.match(redeemed.deviceToken, /^[A-Za-z0-9_-]{32,128}$/);
    const authorization = { authorization: "Bearer " + redeemed.deviceToken };

    phase = "provider_self_fetch";
    const observed = await json(`/_c/${config}/stream/movie/${CONTENT_ID}.json`);
    assert.equal(observed.streams.length, 1);
    const playable = observed.streams[0];
    assert.equal(new URL(playable.url).origin, ORIGIN);

    phase = "media";
    const media = Buffer.from(await (await response(new URL(playable.url).pathname)).arrayBuffer());
    assert.equal(media.length, 3722302);
    assert.equal(sha256(media), MEDIA_SHA256);

    phase = "claim";
    const claimed = await post("/v1/playback/claim", {
      attemptId: crypto.randomUUID(),
      fingerprints: fingerprintStream(playable),
      intentUrlHash: hashOpaqueValue(playable.url),
      launchedAt: new Date().toISOString(),
    }, authorization);
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.context.traktEligible, false);

    phase = "subtitle_self_fetch";
    const discovered = await post(
      "/v1/subtitles/discover",
      { sessionId: claimed.sessionId },
      authorization
    );
    assert.equal(discovered.subtitles.length, 1);
    assert.equal(discovered.subtitles[0].format, "archive");
    const resolved = await post("/v1/subtitles/resolve", {
      sessionId: claimed.sessionId,
      selector: discovered.subtitles[0].selector,
      responseSchemaVersion: 2,
    }, authorization);
    assert.equal(resolved.status, "ready");
    assert.equal(resolved.parts.length, PARTS.length);

    phase = "subtitle_delivery";
    for (let index = 0; index < PARTS.length; index += 1) {
      const expected = PARTS[index];
      const part = resolved.parts[index];
      assert.ok(part.fileName.endsWith(expected.extension));
      assert.equal(part.sha256, expected.sha256);
      const delivered = await response(part.path, { headers: authorization });
      const bytes = Buffer.from(await delivered.arrayBuffer());
      assert.equal(bytes.length, expected.size);
      assert.equal(sha256(bytes), expected.sha256);
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      origin: ORIGIN,
      buildSha: expectedSha,
      mediaSha256: MEDIA_SHA256,
      subtitlePartSha256: PARTS.map((part) => part.sha256),
    }) + "\n");
  } catch (error) {
    process.stderr.write(`UAT VobSub live smoke failed [${phase}:${failureCode(error)}]\n`);
    process.exitCode = 1;
  } finally {
    if (management) {
      try {
        const result = await response("/api/profile", {
          method: "DELETE",
          headers: {
            cookie: management.cookie,
            origin: ORIGIN,
            "x-jumpgate-csrf": management.csrf,
          },
        });
        const body = await result.json();
        if (body.status !== "pending") throw new Error("profile cleanup was not accepted");
      } catch (_cleanupError) {
        process.stderr.write("UAT VobSub live smoke cleanup failed [profile_erasure]\n");
        process.exitCode = 1;
      }
    }
  }
}

if (require.main === module) run();

module.exports = {
  expectedBuildSha,
  failureCode,
  managementFromActivation,
};
