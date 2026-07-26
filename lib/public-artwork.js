"use strict";

const MAX_PUBLIC_ARTWORK_URL_LENGTH = 2048;

function isSafePublicArtworkUrl(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PUBLIC_ARTWORK_URL_LENGTH ||
    Buffer.byteLength(value, "utf8") > MAX_PUBLIC_ARTWORK_URL_LENGTH * 4 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f\s\\]/.test(value)
  ) {
    return false;
  }

  const authority = value.match(/^https:\/\/([^/?#]+)(?:[/?#]|$)/i);
  if (!authority || authority[1].toLowerCase() !== "image.tmdb.org") return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_error) {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hostname === "image.tmdb.org" &&
    parsed.port === "" &&
    !value.includes("?") &&
    !value.includes("#") &&
    parsed.search === "" &&
    parsed.hash === ""
  );
}

function publicArtworkUrl(value) {
  return isSafePublicArtworkUrl(value) ? value : "";
}

function firstPublicArtworkUrl(...candidates) {
  for (const candidate of candidates) {
    const safe = publicArtworkUrl(candidate);
    if (safe) return safe;
  }
  return "";
}

module.exports = {
  MAX_PUBLIC_ARTWORK_URL_LENGTH,
  firstPublicArtworkUrl,
  isSafePublicArtworkUrl,
  publicArtworkUrl,
};
