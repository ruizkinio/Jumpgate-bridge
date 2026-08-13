"use strict";

const REPOSITORY_CONTRACTS = Object.freeze({
  profiles: Object.freeze([
    "create",
    "getById",
    "getByInstallToken",
    "update",
    "rotateInstallToken",
    "revoke",
    "beginErasure",
    "erase",
    "getErasureStatus",
    "listPendingErasures",
    "deferErasure",
  ]),
  devices: Object.freeze([
    "register",
    "authenticate",
    "list",
    "revoke",
    "revokeWithInvalidation",
    "getGeneration",
    "isActiveBinding",
    "commitDisclosure",
    "withClaimAdmission",
  ]),
  providers: Object.freeze([
    "replaceAll",
    "list",
    "removeAll",
    "allocateMutationFence",
    "advanceMutationFence",
  ]),
  pairings: Object.freeze([
    "issue",
    "activate",
    "recoverActivation",
    "completeActivation",
    "redeem",
    "cancel",
    "claimValidation",
  ]),
  oauthCredentials: Object.freeze(["put", "get", "remove"]),
  oauthStates: Object.freeze(["issue", "consume", "cancel"]),
  playbackContexts: Object.freeze([
    "getProfileGeneration",
    "getProviderSnapshotState",
    "beginProviderSnapshotMutation",
    "renewProviderSnapshotMutation",
    "fenceProviderSnapshotMutation",
    "completeProviderSnapshotMutation",
    "releaseProviderSnapshotMutation",
    "probeProviderSnapshotRecovery",
    "beginProviderSnapshotRecovery",
    "completeProviderSnapshotRecovery",
    "invalidateProfile",
    "invalidateDevice",
    "record",
    "claim",
    "getActiveClaim",
    "release",
    "prune",
  ]),
  history: Object.freeze([
    "getGeneration",
    "upsert",
    "get",
    "getForWrite",
    "list",
    "remove",
    "clear",
    "changes",
  ]),
  historyGrants: Object.freeze([
    "reserve",
    "abandon",
    "finalize",
    "commitClaimResponse",
    "applyEvent",
    "release",
    "prune",
    "clearHistory",
    "revokeProfile",
    "revokeDevice",
    "revokeHistory",
    "revokePlayback",
    "revokeSession",
    "revokeSource",
    "supersede",
  ]),
  addonCollectionBackups: Object.freeze(["create", "get", "list", "markRestored"]),
  legacyConfigAliases: Object.freeze(["getProfileId", "bind"]),
  managementSessions: Object.freeze([
    "issue",
    "issueForPairing",
    "recoverPairing",
    "revokePairing",
    "authenticate",
    "revoke",
    "revokeProfile",
  ]),
  lifecycleInvalidations: Object.freeze(["getPending", "listPending", "complete", "defer"]),
  playbackSessions: Object.freeze([
    "openSession",
    "getSession",
    "transition",
    "transitionAndEnqueue",
    "claimDispatch",
    "withDispatchAdmission",
    "retryDispatch",
    "invalidateProfile",
    "invalidateDevice",
    "invalidateSession",
    "invalidateSourceClaim",
    "listDispatches",
  ]),
  subtitleManifests: Object.freeze([
    "reserve",
    "commit",
    "requestArtifactDeletion",
    "requestProfileDeletion",
    "requestDeviceDeletion",
    "claimDeletion",
    "recordDeletionAbsence",
    "retryDeletion",
    "confirmDeletion",
    "hasProfile",
    "hasDevice",
    "listProfile",
  ]),
  leases: Object.freeze(["acquire", "renew", "release"]),
  rateLimits: Object.freeze(["consume", "reset"]),
  subtitleDeliveries: Object.freeze([
    "getAuthority",
    "transitionAuthority",
    "reconcileAuthority",
    "updateAuthority",
    "reserve",
    "cancelReservation",
    "beginFetch",
    "releaseFetch",
    "stageUpload",
    "beginUpload",
    "abortUpload",
    "commit",
    "authorize",
    "revalidate",
    "releaseLease",
    "invalidateRelease",
    "invalidateSession",
    "invalidateDevice",
    "invalidateProfile",
    "claimDeletion",
    "recordDeletionAbsence",
    "retryDeletion",
    "confirmDeletion",
    "prune",
  ]),
});

const REQUIRED_REPOSITORY_NAMES = Object.freeze(Object.keys(REPOSITORY_CONTRACTS));

function assertRepository(name, repository) {
  const methods = REPOSITORY_CONTRACTS[name];
  if (!methods) throw new TypeError("unknown repository contract: " + name);
  if (!repository || typeof repository !== "object") {
    throw new TypeError(name + " repository is required");
  }
  for (const method of methods) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(name + " repository must implement " + method + "()");
    }
  }
  return repository;
}

function assertRepositorySet(repositories, requiredNames = REQUIRED_REPOSITORY_NAMES) {
  if (!repositories || typeof repositories !== "object") {
    throw new TypeError("repository set is required");
  }
  for (const name of requiredNames) assertRepository(name, repositories[name]);
  return repositories;
}

module.exports = {
  REPOSITORY_CONTRACTS,
  REQUIRED_REPOSITORY_NAMES,
  assertRepository,
  assertRepositorySet,
};
