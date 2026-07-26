"use strict";

const protocol = require("../lib/storage/redis/playback-claim-writer-protocol");

module.exports = protocol;

if (require.main === module) {
  protocol.runCli().catch(protocol.reportCliError);
}
