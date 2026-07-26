"use strict";

const {
  reportProviderMutationProtocolCliError,
  runProviderMutationProtocolCli,
} = require("../lib/storage/postgres/provider-mutation-activation");

runProviderMutationProtocolCli().catch(reportProviderMutationProtocolCliError);
