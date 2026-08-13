"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT_FILES = Object.freeze({
  time: "time.lua",
  pairingProtocolGate: "pairing-protocol-gate.lua",
  pairingIssue: "pairing-issue.lua",
  pairingActivate: "pairing-activate.lua",
  pairingRecover: "pairing-recover.lua",
  pairingCompletePeek: "pairing-complete-peek.lua",
  pairingComplete: "pairing-complete.lua",
  pairingRedeemPeek: "pairing-redeem-peek.lua",
  pairingRedeem: "pairing-redeem.lua",
  pairingCancel: "pairing-cancel.lua",
  pairingValidation: "pairing-validation.lua",
  oauthIssue: "oauth-issue.lua",
  oauthConsumePeek: "oauth-consume-peek.lua",
  oauthConsume: "oauth-consume.lua",
  oauthCancel: "oauth-cancel.lua",
  managementIssue: "management-issue.lua",
  managementPairingIssue: "management-pairing-issue.lua",
  managementPairingRecover: "management-pairing-recover.lua",
  managementPairingRevoke: "management-pairing-revoke.lua",
  managementAuthenticate: "management-authenticate.lua",
  managementRevoke: "management-revoke.lua",
  managementRevokeProfile: "management-revoke-profile.lua",
  managementGeneration: "management-generation.lua",
  leaseAcquire: "lease-acquire.lua",
  leaseRenew: "lease-renew.lua",
  leaseRelease: "lease-release.lua",
  rateLimitConsume: "rate-limit-consume.lua",
  rateLimitReset: "rate-limit-reset.lua",
  playbackGetOrInitializeGeneration: "playback-get-or-initialize-generation.lua",
  playbackRecord: "playback-record.lua",
  playbackAttemptBegin: "playback-attempt-begin.lua",
  playbackAttemptDisclose: "playback-attempt-disclose.lua",
  playbackAttemptAbandon: "playback-attempt-abandon.lua",
  playbackAttemptReconcile: "playback-attempt-reconcile.lua",
  playbackClaim: "playback-claim.lua",
  playbackClaimV5Fenced: "playback-claim.lua",
  playbackClaimV6: "playback-claim-v6.lua",
  playbackGetActiveClaim: "playback-get-active-claim.lua",
  playbackRelease: "playback-release.lua",
  playbackPrune: "playback-prune.lua",
  playbackInvalidate: "playback-invalidate.lua",
  playbackInvalidateDevice: "playback-invalidate-device.lua",
  subtitleGetAuthority: "subtitle-get-authority.lua",
  subtitleReconcileAuthority: "subtitle-reconcile-authority.lua",
  subtitleUpdateAuthority: "subtitle-update-authority.lua",
  subtitleReserve: "subtitle-reserve.lua",
  subtitleCancelReservation: "subtitle-cancel-reservation.lua",
  subtitleBeginFetchPeek: "subtitle-begin-fetch-peek.lua",
  subtitleBeginFetch: "subtitle-begin-fetch.lua",
  subtitleReleaseFetch: "subtitle-release-fetch.lua",
  subtitleStageUpload: "subtitle-stage-upload.lua",
  subtitleBeginUploadPeek: "subtitle-begin-upload-peek.lua",
  subtitleBeginUpload: "subtitle-begin-upload.lua",
  subtitleAbortUpload: "subtitle-abort-upload.lua",
  subtitleCommit: "subtitle-commit.lua",
  subtitleAuthorize: "subtitle-authorize.lua",
  subtitleRevalidate: "subtitle-revalidate.lua",
  subtitleReleaseLease: "subtitle-release-lease.lua",
  subtitleInvalidate: "subtitle-invalidate.lua",
  subtitleClaimDeletion: "subtitle-claim-deletion.lua",
  subtitleRecordDeletionAbsence: "subtitle-record-deletion-absence.lua",
  subtitleRetryDeletion: "subtitle-retry-deletion.lua",
  subtitleConfirmDeletion: "subtitle-confirm-deletion.lua",
  subtitlePrune: "subtitle-prune.lua",
});

const PLAYBACK_COMMON = fs.readFileSync(path.join(__dirname, "playback-common.lua"), "utf8");
const SUBTITLE_COMMON = fs.readFileSync(path.join(__dirname, "subtitle-common.lua"), "utf8");
const PLAYBACK_V5_WRITER_FENCE = [
  "-- jg-script:playback-claim-v5-writer-fence-v1",
  "local playbackWriterProtocolKey = KEYS[#KEYS]",
  'local playbackWriterProtocolTypeReply = redis.call("TYPE", playbackWriterProtocolKey)',
  "local playbackWriterProtocolType = playbackWriterProtocolTypeReply",
  'if type(playbackWriterProtocolTypeReply) == "table" then',
  "  playbackWriterProtocolType = playbackWriterProtocolTypeReply.ok",
  "end",
  'if playbackWriterProtocolType ~= "string" then',
  '  if playbackWriterProtocolType == "none" then return { "writer_protocol_changed" } end',
  '  return { "profile_collision" }',
  "end",
  'if redis.call("GET", playbackWriterProtocolKey) ~= "5" then',
  '  return { "writer_protocol_changed" }',
  "end",
].join("\n");

function wrapPlaybackClaimV5(body) {
  return [
    PLAYBACK_V5_WRITER_FENCE,
    "local playbackClaimV5Keys = {}",
    "for index = 1, #KEYS - 1 do",
    "  playbackClaimV5Keys[index] = KEYS[index]",
    "end",
    "local function jumpgate_playback_claim_v5(KEYS, ARGV)",
    PLAYBACK_COMMON,
    body,
    "end",
    "return jumpgate_playback_claim_v5(playbackClaimV5Keys, ARGV)",
  ].join("\n");
}

const SCRIPT_DEFINITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(SCRIPT_FILES).map(([name, filename]) => {
      const body = fs.readFileSync(path.join(__dirname, filename), "utf8");
      const source = name === "playbackClaimV5Fenced"
        ? wrapPlaybackClaimV5(body)
        : name.startsWith("playback")
          ? PLAYBACK_COMMON + "\n" + body
        : name.startsWith("subtitle")
          ? PLAYBACK_COMMON + "\n" + SUBTITLE_COMMON + "\n" + body
          : body;
      return [
        name,
        Object.freeze({
          name,
          filename,
          source,
          sha: crypto.createHash("sha1").update(source, "utf8").digest("hex"),
        }),
      ];
    })
  )
);

module.exports = {
  SCRIPT_DEFINITIONS,
  SCRIPT_FILES,
};
