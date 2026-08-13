"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const CONTENT_ID = "jumpgate-uat-vobsub-v1";
const PROVIDER_ID = "com.jumpgate.uat.vobsub-fixture";
const CATALOG_ID = "jumpgate-uat-vobsub";
const MEDIA_FILE = CONTENT_ID + ".mp4";
const SUBTITLE_FILE = CONTENT_ID + ".zip";
const ASSET_DIRECTORY = path.join(__dirname, "..", "uat-fixtures", "vobsub");
const ASSET_SPECS = Object.freeze({
  media: Object.freeze({
    fileName: MEDIA_FILE,
    mediaType: "video/mp4",
    sha256: "f976676998f0bd96fbec35daf20aaa128ff3fc82c68af5177867841b79b4060b",
    size: 3722302,
  }),
  subtitles: Object.freeze({
    fileName: SUBTITLE_FILE,
    mediaType: "application/zip",
    sha256: "34bb52f40bf4d26c949b4690ca82e126ef2b53cf9c91b84cd400e48ed258ebd1",
    size: 2249,
  }),
});

function manifest() {
  return {
    id: PROVIDER_ID,
    version: "1.0.0",
    name: "Jumpgate UAT VobSub",
    types: ["movie"],
    idPrefixes: ["jumpgate-uat-vobsub"],
    resources: [
      { name: "stream", types: ["movie"], idPrefixes: ["jumpgate-uat-vobsub"] },
      { name: "subtitles", types: ["movie"], idPrefixes: ["jumpgate-uat-vobsub"] },
    ],
  };
}

function descriptor(publicBaseUrl, configBlob) {
  return {
    transportUrl:
      publicBaseUrl + "/_c/" + encodeURIComponent(configBlob) + "/uat-vobsub/manifest.json",
    manifest: manifest(),
  };
}

function isExactDescriptor(value, publicBaseUrl, configBlob) {
  return isDeepStrictEqual(value, descriptor(publicBaseUrl, configBlob));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function loadAsset(spec) {
  if (!spec || !/^[a-f0-9]{64}$/.test(spec.sha256) || !Number.isSafeInteger(spec.size) || spec.size < 1) {
    throw new Error("UAT VobSub fixture asset specification is incomplete");
  }
  const data = fs.readFileSync(path.join(ASSET_DIRECTORY, spec.fileName));
  if (data.length !== spec.size || sha256(data) !== spec.sha256) {
    throw new Error("UAT VobSub fixture asset integrity check failed");
  }
  return Object.freeze({ data, ...spec });
}

function loadAssets() {
  return Object.freeze({
    media: loadAsset(ASSET_SPECS.media),
    subtitles: loadAsset(ASSET_SPECS.subtitles),
  });
}

function setPrivateFixtureHeaders(res, contentType, contentLength) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(contentLength));
}

function parseSingleByteRange(value, size) {
  if (typeof value !== "string" || !/^bytes=\d*-\d*$/.test(value)) return null;
  const [rawStart, rawEnd] = value.slice(6).split("-");
  if (!rawStart && !rawEnd) return null;
  let start;
  let end;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return null;
    }
    end = Math.min(end, size - 1);
  }
  if (start >= size) return null;
  return { start, end };
}

function sendAsset(req, res, asset, options = {}) {
  const allowRange = options.allowRange === true;
  if (allowRange) res.setHeader("Accept-Ranges", "bytes");
  else res.setHeader("Accept-Ranges", "none");
  const rangeHeader = req.headers.range;
  if (rangeHeader && allowRange) {
    const range = parseSingleByteRange(rangeHeader, asset.data.length);
    if (!range) {
      res.setHeader("Content-Range", "bytes */" + asset.data.length);
      return res.status(416).end();
    }
    const body = asset.data.subarray(range.start, range.end + 1);
    setPrivateFixtureHeaders(res, asset.mediaType, body.length);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${asset.data.length}`);
    return req.method === "HEAD" ? res.end() : res.end(body);
  }
  setPrivateFixtureHeaders(res, asset.mediaType, asset.data.length);
  return req.method === "HEAD" ? res.end() : res.end(asset.data);
}

function fixturePaths(configBlob) {
  const root = "/_c/" + encodeURIComponent(configBlob) + "/uat-vobsub";
  return {
    media: root + "/media/" + MEDIA_FILE,
    subtitles: root + "/subtitles/" + SUBTITLE_FILE,
  };
}

function streamResponse(publicBaseUrl, configBlob) {
  const paths = fixturePaths(configBlob);
  return {
    streams: [{
      name: "Jumpgate UAT",
      title: "Silent 18-second VobSub rendering fixture",
      url: publicBaseUrl + paths.media,
      behaviorHints: { notWebReady: true, filename: MEDIA_FILE },
    }],
  };
}

function subtitlesResponse(publicBaseUrl, configBlob) {
  const paths = fixturePaths(configBlob);
  return {
    subtitles: [{
      id: "jumpgate-uat-vobsub-en",
      lang: "en",
      url: publicBaseUrl + paths.subtitles,
    }],
  };
}

function catalogResponse(publicBaseUrl) {
  return {
    metas: [{
      id: CONTENT_ID,
      type: "movie",
      name: "Jumpgate VobSub Pipeline Test",
      description: "Silent maintainer-only media with three bitmap subtitle cues.",
      posterShape: "poster",
      poster: publicBaseUrl + "/assets/jumpgate-mark.png",
      background: publicBaseUrl + "/assets/jumpgate-backdrop.jpg",
    }],
  };
}

function exactFixtureRequest(req) {
  const expected = {
    manifest: "/uat-vobsub/manifest.json",
    stream: "/uat-vobsub/stream/movie/" + CONTENT_ID + ".json",
    subtitles: "/uat-vobsub/subtitles/movie/" + CONTENT_ID + ".json",
    media: "/uat-vobsub/media/" + MEDIA_FILE,
    archive: "/uat-vobsub/subtitles/" + SUBTITLE_FILE,
  };
  const prefix = "/_c/" + encodeURIComponent(req.params.config);
  const pathName = req.path;
  for (const [kind, suffix] of Object.entries(expected)) {
    if (pathName === prefix + suffix) return kind;
  }
  return null;
}

module.exports = {
  ASSET_SPECS,
  CATALOG_ID,
  CONTENT_ID,
  PROVIDER_ID,
  catalogResponse,
  descriptor,
  exactFixtureRequest,
  isExactDescriptor,
  loadAssets,
  manifest,
  sendAsset,
  streamResponse,
  subtitlesResponse,
};
