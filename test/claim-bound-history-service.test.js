"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const { ClaimBoundHistoryService } = require("../lib/claim-bound-history-service");
const { preparedJsonResponse } = require("../lib/prepared-http-response");

const ATTEMPT_ID = "018f47c2-7f3a-7b1c-8d2e-4f5a6b7c8d9e";
const TERMINAL_RECEIPT_ID = "123e4567-e89b-42d3-a456-426614174000";

function binding() {
  return {
    profileId: "profile_claim_service_0001",
    profileRevision: 3,
    deviceId: "device_claim_service_0001",
    deviceGeneration: 5,
    historyGeneration: 7,
    playbackGeneration: "g1:claim-service",
  };
}

function rawClaim() {
  return Buffer.from(JSON.stringify({
    attemptId: ATTEMPT_ID,
    fingerprints: ["sha256:" + "1".repeat(64)],
    intentUrlHash: "2".repeat(64),
    launchedAt: 1_725_000_000_000,
  }));
}

test("claim source receives only the reserved session authority and release forwards the receipt", async () => {
  const observed = {};
  const historyGrants = {
    async reserve(input) {
      observed.reservation = input;
      return {
        grantId: "grant_claim_service_0001",
        grantToken: "hg1_" + "a".repeat(43),
        sessionId: "session_claim_service_0001",
      };
    },
    async abandon(input) {
      observed.abandonedReservation = input;
      return true;
    },
    async finalize(input) {
      observed.finalization = input;
      return {
        grantToken: "hg1_" + "a".repeat(43),
        kind: "canonical",
        sessionRevision: 1,
      };
    },
    async commitClaimResponse(input) {
      observed.claimResponse = input;
      return input.preparedResponse;
    },
    async applyEvent() {
      throw new Error("not used");
    },
    async revokeSession() {
      return true;
    },
    async release(...args) {
      observed.release = args;
      return true;
    },
    async prune() {
      return { expiredReservations: 0, prunedReservations: 0 };
    },
  };
  const playbackContexts = {
    async claim() {
      assert.fail("the custom lifecycle claim source must own admission");
    },
    async getActiveClaim(profileId, deviceId, sessionId) {
      return {
        status: "claimed",
        sessionId,
        context: {
          contentKey: "3".repeat(64),
          canonicalIdentity: {
            provider: "imdb",
            id: "tt0133093",
            mediaType: "movie",
            provenance: "metadata-request",
            confidence: "canonical",
          },
          display: { title: "The Matrix", year: 1999 },
          traktEligible: true,
        },
        deliveryBinding: {
          profileId,
          deviceId,
          sessionId,
          generation: "g1:claim-service",
          providerRevision: "11",
          contextId: "context_claim_service_0001",
          contextRevision: "4",
        },
      };
    },
    async commitClaimDisclosure(...args) {
      observed.disclosure = args;
      return true;
    },
    async releaseOwned(...args) {
      observed.abandonment = args;
      return true;
    },
  };
  const signal = new AbortController().signal;
  const service = new ClaimBoundHistoryService({
    historyGrants,
    playbackContexts,
    async claimSource(claimBinding, request, options) {
      observed.claim = { claimBinding, request, options };
      const result = { status: "claimed", sessionId: options.sessionId };
      Object.defineProperty(
        result,
        Symbol.for("jumpgate.playbackClaimCleanupOwner"),
        { enumerable: false, value: "cleanup_owner_claim_service_0001" }
      );
      return result;
    },
  });

  const rawBody = rawClaim();
  const result = await service.claim(binding(), rawBody, { signal });
  const expectedDigest = crypto
    .createHash("sha256")
    .update("jumpgate-playback-claim-request:v1\0POST\0/v1/playback/claim\0", "utf8")
    .update(rawBody)
    .digest("hex");

  assert.equal(observed.reservation.attemptId, ATTEMPT_ID);
  assert.equal(observed.reservation.requestDigest, expectedDigest);
  assert.deepEqual(observed.claim.claimBinding, binding());
  assert.equal(observed.claim.options.signal, signal);
  assert.equal(observed.claim.options.sessionId, "session_claim_service_0001");
  assert.equal(observed.claim.options.requestDigest, expectedDigest);
  assert.equal(observed.finalization.authority.claimStatus, "claimed");
  assert.equal(result.historyGrant, "hg1_" + "a".repeat(43));
  assert.equal(result.historyGrantKind, "canonical");
  assert.equal(result.sessionRevision, 1);
  assert.equal(Object.keys(result).includes("cleanupOwner"), false);
  const prepared = preparedJsonResponse(200, { status: result.status }, {
    "cache-control": "no-store",
  });
  assert.deepEqual(await service.commitClaimResponse(result, prepared), prepared);
  assert.equal(observed.claimResponse.grantId, "grant_claim_service_0001");
  assert.equal(observed.claimResponse.requestDigest, expectedDigest);
  assert.equal(await service.commitClaimDisclosure(binding(), result), true);
  assert.deepEqual(observed.disclosure, [
    binding().profileId,
    binding().deviceId,
    result.sessionId,
    "cleanup_owner_claim_service_0001",
  ]);

  assert.equal(
    await service.release(
      binding(),
      result.sessionId,
      TERMINAL_RECEIPT_ID
    ),
    true
  );
  assert.deepEqual(observed.release, [
    {
      ...binding(),
      sessionId: result.sessionId,
      terminalReceiptId: TERMINAL_RECEIPT_ID,
    },
  ]);
});

test("claim options cannot replace reserved authority", async () => {
  const service = new ClaimBoundHistoryService({
    historyGrants: {
      async reserve() { assert.fail("invalid options must fail before reservation"); },
      async abandon() {},
      async finalize() {},
      async commitClaimResponse() {},
      async applyEvent() {},
      async release() {},
      async prune() {},
      async revokeSession() {},
    },
    playbackContexts: {
      async claim() {},
      async getActiveClaim() {},
    },
  });

  await assert.rejects(
    () => service.claim(binding(), rawClaim(), { sessionId: "attacker_session" }),
    /unknown field/
  );
});

test("invalid claim bytes create no reservation and source failures abandon exact authority", async () => {
  let reservations = 0;
  let abandoned = null;
  const historyGrants = {
    async reserve(input) {
      reservations += 1;
      return {
        grantId: "grant_claim_service_failure_0001",
        grantToken: "hg1_" + "b".repeat(43),
        sessionId: "session_claim_service_failure_0001",
        input,
      };
    },
    async abandon(input) {
      abandoned = input;
      return true;
    },
    async finalize() {},
    async commitClaimResponse() {},
    async applyEvent() {},
    async release() {},
    async prune() {},
    async revokeSession() {},
  };
  const service = new ClaimBoundHistoryService({
    historyGrants,
    playbackContexts: {
      async claim() {
        const error = new Error("source claim failed");
        error.code = "source_claim_failed";
        throw error;
      },
      async getActiveClaim() {},
    },
  });

  await assert.rejects(
    () => service.claim(binding(), Buffer.from("{}")),
    (error) => error.code === "invalid_playback_claim"
  );
  assert.equal(reservations, 0);

  const body = rawClaim();
  await assert.rejects(
    () => service.claim(binding(), body),
    (error) => error.code === "source_claim_failed"
  );
  assert.equal(reservations, 1);
  assert.deepEqual(abandoned, {
    grantId: "grant_claim_service_failure_0001",
    attemptId: ATTEMPT_ID,
    requestDigest: crypto
      .createHash("sha256")
      .update("jumpgate-playback-claim-request:v1\0POST\0/v1/playback/claim\0", "utf8")
      .update(body)
      .digest("hex"),
    ...binding(),
  });
});
