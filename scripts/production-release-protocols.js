"use strict";

const release = require("../lib/storage/production-release-protocols");

module.exports = release;

if (require.main === module) {
  release.runProductionReleaseProtocols().catch(release.reportProductionReleaseProtocolError);
}
