"use strict";

function isProductionLikeEnvironment(environment) {
  return environment === "production" || environment === "uat";
}

module.exports = { isProductionLikeEnvironment };
