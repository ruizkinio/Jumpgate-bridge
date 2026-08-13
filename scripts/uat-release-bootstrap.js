"use strict";

const bootstrap = require("../lib/storage/uat-release-bootstrap");

module.exports = bootstrap;

if (require.main === module) {
  bootstrap.runUatReleaseBootstrap().catch(bootstrap.reportUatReleaseBootstrapError);
}
