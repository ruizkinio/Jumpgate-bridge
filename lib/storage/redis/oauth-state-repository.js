"use strict";

const {
  assertIdentifier,
  assertJsonSize,
  assertPlainObject,
  assertPositiveInteger,
  codedError,
} = require("../repository-utils");
const { initializeRedisOptions, jsonParse, jsonStringify } = require("./base");
const { asArray, asInteger, asString } = require("./reply");

function assertManagementGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("management generation is invalid");
  }
  return value;
}

class RedisOAuthStateRepository {
  constructor(options = {}) {
    const shared = initializeRedisOptions(options);
    if (!options.tokenService || !options.envelopeCrypto) {
      throw new TypeError("tokenService and envelopeCrypto are required");
    }
    this._keys = shared.keyspace;
    this._scripts = shared.scripts;
    this._tokens = options.tokenService;
    this._crypto = options.envelopeCrypto;
    this._ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this._maxStates = options.maxStates ?? 4096;
    assertPositiveInteger(this._ttlMs, "OAuth state ttl", 60 * 60 * 1000);
    assertPositiveInteger(this._maxStates, "maxStates", 100000);
    this._globalKey = this._keys.key("oauth-global", "states");
  }

  async issue(profileId, payload, options = {}) {
    const id = assertIdentifier(profileId, "profile id");
    const input = assertPlainObject(payload, "OAuth state payload");
    const supplied = assertPlainObject(options || {}, "OAuth state options");
    assertJsonSize(input, "OAuth state payload", 64 * 1024);
    const value = jsonParse(
      jsonStringify(input, "OAuth state payload"),
      "OAuth state payload"
    );
    let managementGeneration;
    if (supplied.managementGeneration === undefined) {
      const generationReply = asArray(
        await this._scripts.run("managementGeneration", [this._profileGenerationKey(id)]),
        "managementGeneration"
      );
      const status = asString(generationReply[0], "management generation status");
      if (status === "revoked") {
        throw codedError("profile_inactive", "profile management access is revoked");
      }
      if (status !== "generation") throw new Error("unexpected management generation status");
      managementGeneration = asInteger(generationReply[1], "management profile generation");
    } else {
      managementGeneration = assertManagementGeneration(supplied.managementGeneration);
    }
    const state = this._tokens.issue("oauth-state", 32);
    const binding = this._tokens.issue("oauth-binding", 32);
    const envelope = this._crypto.encryptJson(value, this._purpose(state.tokenHash));
    const reply = asArray(
      await this._scripts.run(
        "oauthIssue",
        [
          this._stateKey(state.tokenHash),
          this._globalKey,
          this._profileGenerationKey(id),
        ],
        [
          id,
          binding.tokenHash,
          jsonStringify(envelope, "OAuth state envelope"),
          this._ttlMs,
          this._maxStates,
          String(managementGeneration),
        ]
      ),
      "oauthIssue"
    );
    const status = asString(reply[0], "OAuth issue status");
    if (status === "collision") throw codedError("oauth_state_collision", "OAuth state collision");
    if (status === "capacity") throw codedError("oauth_state_capacity", "OAuth state capacity reached");
    if (status === "profile_changed") {
      throw codedError("profile_inactive", "management generation changed before OAuth issuance");
    }
    if (status !== "ok") throw new Error("unexpected OAuth issue status: " + status);
    return {
      stateToken: state.token,
      browserBindingToken: binding.token,
      expiresAt: asInteger(reply[1], "OAuth state expiry"),
    };
  }

  async consume(stateToken, browserBindingToken) {
    let stateHash;
    let bindingHash;
    try {
      stateHash = this._tokens.hashToken("oauth-state", stateToken);
      bindingHash = this._tokens.hashToken("oauth-binding", browserBindingToken);
    } catch (_error) {
      return null;
    }
    const peek = asArray(
      await this._scripts.run(
        "oauthConsumePeek",
        [this._stateKey(stateHash), this._globalKey],
        [bindingHash]
      ),
      "oauthConsumePeek"
    );
    const peekStatus = asString(peek[0], "OAuth consume status");
    if (peekStatus === "not_found" || peekStatus === "binding_mismatch") return null;
    if (peekStatus !== "ready") throw new Error("unexpected OAuth consume status: " + peekStatus);
    const profileId = assertIdentifier(asString(peek[1], "OAuth profile id"), "profile id");
    const serializedEnvelope = asString(peek[2], "OAuth state envelope");
    const createdAt = asInteger(peek[3], "OAuth state creation time");
    const expiresAt = asInteger(peek[4], "OAuth state expiry");
    const managementGeneration = asInteger(peek[5], "OAuth management generation");
    const payload = this._crypto.decryptJson(
      jsonParse(serializedEnvelope, "OAuth state envelope"),
      this._purpose(stateHash)
    );
    assertPlainObject(payload, "OAuth state payload");
    assertJsonSize(payload, "OAuth state payload", 64 * 1024);
    jsonStringify(payload, "OAuth state payload");

    const reply = asArray(
      await this._scripts.run(
        "oauthConsume",
        [
          this._stateKey(stateHash),
          this._globalKey,
          this._profileGenerationKey(profileId),
        ],
        [
          bindingHash,
          serializedEnvelope,
          profileId,
          createdAt,
          expiresAt,
          String(managementGeneration),
        ]
      ),
      "oauthConsume"
    );
    const status = asString(reply[0], "OAuth consume status");
    if (
      status === "not_found" ||
      status === "binding_mismatch" ||
      status === "changed" ||
      status === "profile_changed"
    ) {
      return null;
    }
    if (status !== "consumed") throw new Error("unexpected OAuth consume status: " + status);
    return {
      profileId,
      payload,
      createdAt,
      expiresAt,
    };
  }

  async cancel(stateToken) {
    let stateHash;
    try {
      stateHash = this._tokens.hashToken("oauth-state", stateToken);
    } catch (_error) {
      return false;
    }
    const reply = asArray(
      await this._scripts.run("oauthCancel", [this._stateKey(stateHash), this._globalKey]),
      "oauthCancel"
    );
    return asString(reply[0], "OAuth cancel status") === "cancelled";
  }

  _stateKey(stateHash) {
    return this._keys.key("oauth-state", stateHash);
  }

  _profileGenerationKey(profileId) {
    return this._keys.key("management-profile-generation", profileId);
  }

  _purpose(stateHash) {
    return "oauth-state:" + stateHash;
  }
}

module.exports = {
  RedisOAuthStateRepository,
};
