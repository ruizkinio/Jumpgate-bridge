"use strict";

const net = require("node:net");

function normalizePublicBaseUrl(value, options = {}) {
  const raw = typeof value === "string" ? value : "";
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new TypeError("PUBLIC_BASE_URL must be a non-empty canonical URL");
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw new TypeError("PUBLIC_BASE_URL must be a valid URL");
  }

  const allowHttp = options.allowHttp === true;
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new TypeError("PUBLIC_BASE_URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("PUBLIC_BASE_URL cannot contain credentials, a query, or a fragment");
  }
  if (url.pathname !== "/") {
    throw new TypeError("PUBLIC_BASE_URL must be an origin without a path");
  }
  if (!url.hostname || url.origin === "null") {
    throw new TypeError("PUBLIC_BASE_URL must contain a host");
  }
  return url.origin;
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (net.isIP(normalized) !== 4) return false;
  const firstOctet = Number(normalized.split(".", 1)[0]);
  return firstOctet === 127;
}

function createPublicBaseUrlResolver(env = {}) {
  const environment = String(env.NODE_ENV || "development").toLowerCase();
  const configured = env.PUBLIC_BASE_URL
    ? normalizePublicBaseUrl(env.PUBLIC_BASE_URL, { allowHttp: environment !== "production" })
    : "";

  if (environment === "production" && !configured) {
    throw new TypeError("PUBLIC_BASE_URL is required in production");
  }

  return function resolvePublicBaseUrl(req) {
    if (configured) return configured;

    const protocol = req && typeof req.protocol === "string" ? req.protocol : "";
    const host = req && typeof req.get === "function" ? String(req.get("host") || "") : "";
    const derived = normalizePublicBaseUrl(protocol + "://" + host, { allowHttp: true });
    const hostname = new URL(derived).hostname;
    if (!isLoopbackHostname(hostname)) {
      throw new TypeError("PUBLIC_BASE_URL is required for non-loopback development hosts");
    }
    return derived;
  };
}

module.exports = {
  createPublicBaseUrlResolver,
  isLoopbackHostname,
  normalizePublicBaseUrl,
};
