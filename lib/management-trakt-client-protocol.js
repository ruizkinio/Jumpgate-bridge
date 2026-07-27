"use strict";

const MANAGEMENT_TRAKT_AJAX_PROTOCOL = "ajax-v1";
const MANAGEMENT_TRAKT_FORM_PROTOCOL = "form-v2";
const MANAGEMENT_TRAKT_EXPANSION_CAPABILITY = "m1-m2-v1";

function resolveManagementTraktClientProtocol(environment) {
  const env = environment || {};
  if (
    env.NODE_ENV === "test" &&
    env.JUMPGATE_TEST_MANAGEMENT_TRAKT_CLIENT_PROTOCOL === MANAGEMENT_TRAKT_FORM_PROTOCOL
  ) {
    return MANAGEMENT_TRAKT_FORM_PROTOCOL;
  }
  return MANAGEMENT_TRAKT_AJAX_PROTOCOL;
}

module.exports = {
  MANAGEMENT_TRAKT_AJAX_PROTOCOL,
  MANAGEMENT_TRAKT_EXPANSION_CAPABILITY,
  MANAGEMENT_TRAKT_FORM_PROTOCOL,
  resolveManagementTraktClientProtocol,
};
