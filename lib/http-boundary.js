"use strict";

const { isProductionLikeEnvironment } = require("./runtime-environment");

const PUBLIC_RESOURCES = new Set(["catalog", "stream", "subtitles"]);

function resolveTrustProxy(environment) {
  const env = environment || {};
  const raw = String(env.JUMPGATE_TRUST_PROXY || "").trim();
  if (!raw) {
    if (isProductionLikeEnvironment(env.NODE_ENV)) {
      throw new Error("JUMPGATE_TRUST_PROXY is required in production");
    }
    return false;
  }
  if (raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "off") {
    return false;
  }
  if (!/^[1-9]\d?$/.test(raw)) {
    throw new Error("JUMPGATE_TRUST_PROXY must be false, off, 0, or a hop count from 1 to 16");
  }
  const hops = Number(raw);
  if (hops > 16) {
    throw new Error("JUMPGATE_TRUST_PROXY must be false, off, 0, or a hop count from 1 to 16");
  }
  return hops;
}

function isPublicAddonPath(rawPath) {
  const path = String(rawPath || "").split("?", 1)[0];
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] === "manifest.json") return true;
  if (segments.length >= 1 && PUBLIC_RESOURCES.has(segments[0])) return true;
  if (segments[0] === "_c") {
    if (segments.length < 3) return false;
    return segments[2] === "manifest.json" || PUBLIC_RESOURCES.has(segments[2]);
  }
  if (segments.length < 2) return false;
  return segments[1] === "manifest.json" || PUBLIC_RESOURCES.has(segments[1]);
}

function setBaselineSecurityHeaders(response, environment) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (isProductionLikeEnvironment(environment)) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function setPublicAddonCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Accept, Content-Type");
  response.setHeader("Access-Control-Max-Age", "600");
}

module.exports = {
  isPublicAddonPath,
  resolveTrustProxy,
  setBaselineSecurityHeaders,
  setPublicAddonCors,
};
