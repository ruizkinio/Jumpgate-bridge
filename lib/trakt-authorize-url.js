"use strict";

const DEFAULT_TRAKT_AUTHORIZE_URL = "https://trakt.tv/oauth/authorize";

function resolveTraktAuthorizeUrl(environment) {
  const env = environment || {};
  if (env.NODE_ENV !== "test") return DEFAULT_TRAKT_AUTHORIZE_URL;

  const testUrl = String(env.JUMPGATE_TEST_TRAKT_AUTHORIZE_URL || "").trim();
  if (!testUrl) return DEFAULT_TRAKT_AUTHORIZE_URL;

  let parsed;
  try {
    parsed = new URL(testUrl);
  } catch (_error) {
    throw new Error("JUMPGATE_TEST_TRAKT_AUTHORIZE_URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/oauth/authorize" ||
    parsed.username ||
    parsed.password ||
    parsed.href !== parsed.origin + "/oauth/authorize"
  ) {
    throw new Error("JUMPGATE_TEST_TRAKT_AUTHORIZE_URL must be the loopback HTTPS authorize URL");
  }
  return parsed.href;
}

function buildTraktAuthorizeUrl(authorizeUrl, parameters) {
  const target = new URL(authorizeUrl);
  target.search = new URLSearchParams(parameters).toString();
  target.hash = "";
  return target.href;
}

module.exports = {
  buildTraktAuthorizeUrl,
  DEFAULT_TRAKT_AUTHORIZE_URL,
  resolveTraktAuthorizeUrl,
};
