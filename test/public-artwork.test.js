"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  firstPublicArtworkUrl,
  isSafePublicArtworkUrl,
  publicArtworkUrl,
} = require("../lib/public-artwork");

test("public artwork accepts only the exact public TMDB image origin", () => {
  for (const value of [
    "https://image.tmdb.org/t/p/w342/poster.jpg",
    "https://IMAGE.TMDB.ORG/t/p/w500/logo.png",
  ]) {
    assert.equal(isSafePublicArtworkUrl(value), true, value);
    assert.equal(publicArtworkUrl(value), value, value);
  }
  for (const value of [
    "http://image.tmdb.org/t/p/w342/poster.jpg",
    "https://images.example/poster.jpg",
    "https://image.tmdb.org.evil.example/poster.jpg",
    "https://image.tmdb.org./t/p/w342/poster.jpg",
    "https://127.0.0.1/t/p/w342/poster.jpg",
    "https://[::1]/t/p/w342/poster.jpg",
    "https://image.tmdb.org:443/t/p/original/backdrop.webp",
    "https://image.tmdb.org:444/t/p/w342/poster.jpg",
    "https://image.tmdb.org@127.0.0.1/t/p/w342/poster.jpg",
    "https://user:pass@image.tmdb.org/t/p/w342/poster.jpg",
    "https://image.tmdb.org/t/p/w342/poster.jpg?token=secret",
    "https://image.tmdb.org/t/p/w342/poster.jpg?",
    "https://image.tmdb.org/t/p/w342/poster.jpg#fragment",
    "https://image.tmdb.org/t/p/w342/poster.jpg#",
    "//image.tmdb.org/t/p/w342/poster.jpg",
    "https://image.tmdb.org\\t\\p\\w342\\poster.jpg",
    " https://image.tmdb.org/t/p/w342/poster.jpg",
  ]) {
    assert.equal(isSafePublicArtworkUrl(value), false, value);
    assert.equal(publicArtworkUrl(value), "", value);
  }
  assert.equal(
    isSafePublicArtworkUrl("https://image.tmdb.org/t/p/w342/poster%20name.jpg"),
    true
  );
});

test("artwork fallback skips empty and unsafe higher-priority candidates", () => {
  assert.equal(
    firstPublicArtworkUrl("", "https://image.tmdb.org/t/p/w342/poster.jpg"),
    "https://image.tmdb.org/t/p/w342/poster.jpg"
  );
  assert.equal(
    firstPublicArtworkUrl(
      "https://image.tmdb.org/t/p/w342/poster.jpg?capability=secret",
      "https://image.tmdb.org/t/p/w500/poster.jpg"
    ),
    "https://image.tmdb.org/t/p/w500/poster.jpg"
  );
  assert.equal(firstPublicArtworkUrl("", "https://provider.example/poster.jpg"), "");
});

test("backend source contains no Metahub fallback literal", () => {
  const root = path.join(__dirname, "..");
  const sources = [path.join(root, "index.js")];
  const pending = [path.join(root, "lib")];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && entry.name.endsWith(".js")) sources.push(absolute);
    }
  }
  const emitted = sources.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(emitted.toLowerCase().includes("images.metahub.space"), false);
});
