"use strict";

const postgres = require("./postgres");
const redis = require("./redis");
const s3 = require("./s3/subtitle-object-store");
const sqlite = require("./sqlite");

module.exports = {
  ...require("./config"),
  ...require("./contracts"),
  ...require("./envelope-crypto"),
  ...require("./factory"),
  ...require("./history-grant"),
  ...require("./lifecycle-invalidation"),
  ...require("./memory-durable-repositories"),
  ...require("./memory-history-grant-repository"),
  ...require("./memory-playback-session-repository"),
  ...require("./memory-repositories"),
  ...require("./memory-subtitle-delivery-repository"),
  ...require("./memory-subtitle-manifest-repository"),
  ...require("./memory-subtitle-object-store"),
  ...require("./memory-ttl-repositories"),
  ...require("./object-store"),
  ...require("./playback-session"),
  ...require("./repository-utils"),
  ...require("./token-service"),
  ...s3,
  postgres,
  redis,
  s3,
  sqlite,
};
