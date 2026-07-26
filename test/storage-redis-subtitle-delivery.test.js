"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { createClient } = require("redis");

const { fingerprintExactUrl, hashOpaqueValue } = require("../lib/source-context");
const { SubtitleDeletionWorker } = require("../lib/subtitle-deletion-worker");
const { SubtitleDeliveryService } = require("../lib/subtitle-delivery-service");
const { assertRepository } = require("../lib/storage/contracts");
const { EnvelopeCrypto } = require("../lib/storage/envelope-crypto");
const { ProfileLifecycleCoordinator } = require("../lib/storage/lifecycle-invalidation");
const {
  MemorySubtitleManifestRepository,
} = require("../lib/storage/memory-subtitle-manifest-repository");
const { OpaqueObjectKeyFactory } = require("../lib/storage/object-store");
const { MemorySubtitleObjectStore } = require("../lib/storage/memory-subtitle-object-store");
const {
  DEFAULT_SUBTITLE_DELIVERY_LIMITS,
  RedisKeyspace,
  RedisPlaybackContextRepository,
  RedisSubtitleDeliveryRepository,
  SCRIPT_DEFINITIONS,
} = require("../lib/storage/redis");
const { SubtitleObjectStore } = require("../lib/storage/s3/subtitle-object-store");
const { TokenService } = require("../lib/storage/token-service");

const REDIS_URL = process.env.REDIS_URL;
const AGGREGATED_LIVE_RUN = process.env.JUMPGATE_REDIS_SUBTITLE_AGGREGATE === "1";
let prefixSequence = 0;
let activeSequence = 0;
let deliverySequence = 0;
let replacementSequence = 0;
const OBJECT_KEY_ID = "subtitle-test";
const OBJECT_KEY_SECRET = Buffer.alloc(32, 0x47);

function objectKeyFactory() {
  return new OpaqueObjectKeyFactory({
    currentKeyId: OBJECT_KEY_ID,
    keyring: [{ id: OBJECT_KEY_ID, secret: OBJECT_KEY_SECRET }],
    prefix: "subtitles/v1",
  });
}

function missingObjectError() {
  const error = new Error("missing");
  error.name = "NoSuchKey";
  return error;
}

function compatibilityObjectStore(client = {
  async send(command) {
    if (command.constructor.name === "ListObjectVersionsCommand") {
      return { DeleteMarkers: [], IsTruncated: false, Versions: [] };
    }
    if (command.constructor.name === "HeadObjectCommand") throw missingObjectError();
    if (command.constructor.name === "DeleteObjectCommand") return {};
    throw new Error("unexpected object-store command");
  },
}) {
  return new SubtitleObjectStore({
    allowInjectedClient: true,
    bucket: "jumpgate-private-subtitles",
    client,
    endpoint: "https://t3.storage.dev",
    keyHmacCurrentKeyId: OBJECT_KEY_ID,
    keyHmacKeyring: [{ id: OBJECT_KEY_ID, secret: OBJECT_KEY_SECRET }],
    maxObjectBytes: 12 * 1024 * 1024,
    region: "auto",
    requestTimeoutMs: 250,
  });
}

function mappedObjectStore(objects) {
  return compatibilityObjectStore({
    async send(command) {
      const key = command.input.Key || command.input.Prefix;
      if (command.constructor.name === "ListObjectVersionsCommand") {
        return {
          DeleteMarkers: [],
          IsTruncated: false,
          Versions: objects.has(key) ? [{ Key: key, VersionId: "null" }] : [],
        };
      }
      if (command.constructor.name === "DeleteObjectCommand") {
        objects.delete(key);
        return {};
      }
      if (command.constructor.name === "HeadObjectCommand") {
        const record = objects.get(key);
        if (!record) throw missingObjectError();
        const body = Buffer.from(record);
        const checksum = crypto.createHash("sha256").update(body).digest("hex");
        return {
          ContentLength: body.length,
          ContentType: "text/vtt; charset=utf-8",
          Metadata: {
            "jumpgate-content-length": String(body.length),
            "jumpgate-schema": "1",
            "jumpgate-sha256": checksum,
          },
          ServerSideEncryption: "AES256",
        };
      }
      throw new Error("unexpected object-store command");
    },
  });
}

async function isAbsent(store, key) {
  try {
    await store.head(key);
    return false;
  } catch (error) {
    if (error && error.code === "object_store_not_found") return true;
    throw error;
  }
}

function deterministicBytes(seed = 1) {
  let value = seed;
  return (length) => {
    const output = Buffer.alloc(length, value);
    value = value === 255 ? 1 : value + 1;
    return output;
  };
}

function tokenService(seed = 1) {
  return new TokenService({
    pepper: Buffer.alloc(32, 0x5a),
    randomBytes: deterministicBytes(seed),
  });
}

function envelopeCrypto(seed = 30) {
  return new EnvelopeCrypto({
    primaryKeyId: "subtitle-test",
    keys: { "subtitle-test": Buffer.alloc(32, 0x6b) },
    randomBytes: deterministicBytes(seed),
  });
}

function fakeClient() {
  return {
    async eval() {
      throw new Error("stateful script model should intercept eval");
    },
  };
}

function fakeBinding(overrides = {}) {
  return {
    profileId: "profile_subtitle_fake",
    deviceId: "device_subtitle_fake",
    sessionId: "session_subtitle_fake",
    generation: "g1:subtitle-fake",
    contextId: "context_subtitle_fake",
    contextRevision: "90071992547409910000000000000001",
    providerRevision: "90071992547409910000000000000002",
    ...overrides,
  };
}

function uploadReply(status, record) {
  return [
    status,
    record.id,
    record.expiresAt,
    record.uploadExpiresAt,
    String(record.objectKeys.length),
    ...record.objectKeys,
  ];
}

function storedPartReply(record) {
  return [
    String(record.schemaVersion || 2),
    record.schemaVersion === 3 && record.parts.length > 0 ? "1" : "",
    String(record.objectKeys.length),
    ...record.objectKeys.flatMap((objectKey, index) => [
      objectKey,
      record.schemaVersion === 3 ? String(index + 1) : "",
      record.parts[index] ? String(record.parts[index].sizeBytes) : "",
      record.parts[index] ? record.parts[index].checksum : "",
      record.schemaVersion === 3 && record.parts[index] ? record.parts[index].role : "",
      record.schemaVersion === 3 && record.parts[index] ? record.parts[index].extension : "",
      record.schemaVersion === 3 && record.parts[index] ? record.parts[index].mediaType : "",
    ]),
  ];
}

function stagedReply(status, record) {
  return [
    status,
    record.id,
    record.expiresAt,
    record.uploadExpiresAt,
    String(record.uploadSettlesAt),
    ...storedPartReply(record),
  ];
}

class StatefulSubtitleScriptModel {
  constructor() {
    this.calls = [];
    this.authorities = new Map();
    this.artifacts = new Map();
    this.discoveries = new Map();
    this.deletionTokens = new Map();
    this.now = 1000;
  }

  async run(name, keys, args) {
    this.calls.push({ name, keys: keys.slice(), args: args.slice() });
    const handler = this[name];
    assert.equal(typeof handler, "function", "stateful model does not implement " + name);
    return handler.call(this, keys, args);
  }

  _authorityArtifacts(profileTag) {
    return [...this.artifacts.values()].filter((record) => record.indexProfileTag === profileTag);
  }

  _preflightAuthorityArtifacts(profileTag, current, next) {
    const artifacts = this._authorityArtifacts(profileTag);
    for (const record of artifacts) {
      const authorityMatches = (authority) => Boolean(authority &&
        record.generation === authority.generation &&
        record.providerRevision === authority.providerRevision);
      const stateMatches = (record.state === "reserved" && record.uploadState === "none") ||
        (record.state === "fetching" && record.uploadState === "none") ||
        (record.state === "uploading" && record.uploadState === "active") ||
        (record.state === "committed" && record.uploadState === "complete");
      if (record.objectPresent === false || record.indexMalformed ||
        record.profileTag !== profileTag || record.globalIndexed !== true ||
        record.discoveryIndexKey !== record.key || record.deletionRequested || !stateMatches ||
        (!authorityMatches(current) && !authorityMatches(next))) {
        return null;
      }
    }
    return artifacts;
  }

  _markDeleting(record) {
    if (record.markDeletingFailure || record.objectPresent === false || record.deletionRequested ||
      !["reserved", "fetching", "uploading", "committed"].includes(record.state)) {
      return false;
    }
    const previousState = record.state;
    record.deletionRequested = true;
    record.indexProfileTag = null;
    record.globalIndexed = false;
    record.discoveryIndexKey = null;
    record.invalidationCount = (record.invalidationCount || 0) + 1;
    delete record.envelope;
    if (previousState === "reserved" || previousState === "fetching") {
      if (previousState === "fetching") {
        record.fetchFencedTokenHash = record.fetchTokenHash;
        delete record.fetchTokenHash;
        delete record.fetchExpiresAt;
      }
      record.state = "deleting";
      record.deletionPhase = "empty_pending";
      record.deletionDueAt = this.now;
    } else if (record.state !== "uploading") {
      record.state = "deleting";
      record.deletionPhase = "first_pending";
      record.deletionDueAt = record.uploadState === "complete"
        ? Math.max(this.now, record.uploadSettlesAt)
        : this.now;
    } else {
      record.deletionPhase = "waiting_upload";
    }
    return true;
  }

  _markAuthorityArtifacts(artifacts) {
    const snapshots = artifacts.map((record) => structuredClone(record));
    try {
      for (const record of artifacts) {
        if (!this._markDeleting(record)) throw new Error("subtitle authority invalidation invariant");
      }
    } catch (error) {
      for (let index = 0; index < artifacts.length; index += 1) {
        for (const key of Object.keys(artifacts[index])) delete artifacts[index][key];
        Object.assign(artifacts[index], snapshots[index]);
      }
      throw error;
    }
  }

  subtitleUpdateAuthority(_keys, args) {
    const [profileTag, expectedProvider, expectedGeneration, providerRevision, generation] = args;
    const current = this.authorities.get(profileTag);
    if (!current) {
      if (expectedProvider !== "") return ["authority_conflict"];
      const next = { providerRevision, generation, revision: "1" };
      const artifacts = this._preflightAuthorityArtifacts(profileTag, null, next);
      if (!artifacts) return ["state_collision"];
      this._markAuthorityArtifacts(artifacts);
      this.authorities.set(profileTag, next);
      return ["updated", "1", String(artifacts.length)];
    }
    if (current.providerRevision === providerRevision && current.generation === generation) {
      if (!this._preflightAuthorityArtifacts(profileTag, current, current)) {
        return ["state_collision"];
      }
      return ["unchanged", current.revision, "0"];
    }
    if (BigInt(providerRevision) < BigInt(current.providerRevision)) return ["authority_stale"];
    if (current.providerRevision !== expectedProvider || current.generation !== expectedGeneration) {
      return ["authority_conflict"];
    }
    const revision = String(BigInt(current.revision) + 1n);
    const next = { providerRevision, generation, revision };
    const artifacts = this._preflightAuthorityArtifacts(profileTag, current, next);
    if (!artifacts) return ["state_collision"];
    this._markAuthorityArtifacts(artifacts);
    this.authorities.set(profileTag, next);
    return ["updated", revision, String(artifacts.length)];
  }

  subtitleGetAuthority(_keys, args) {
    const current = this.authorities.get(args[0]);
    return current
      ? ["authority", current.providerRevision, current.generation, current.revision]
      : ["not_found"];
  }

  subtitleReconcileAuthority(_keys, args) {
    const [profileTag, providerRevision, generation] = args;
    const current = this.authorities.get(profileTag);
    if (!current) {
      const next = { providerRevision, generation, revision: "1" };
      const artifacts = this._preflightAuthorityArtifacts(profileTag, null, next);
      if (!artifacts) return ["state_collision"];
      this._markAuthorityArtifacts(artifacts);
      this.authorities.set(profileTag, next);
      return ["updated", "1", String(artifacts.length)];
    }
    if (current.providerRevision === providerRevision && current.generation === generation) {
      if (!this._preflightAuthorityArtifacts(profileTag, current, current)) {
        return ["state_collision"];
      }
      return ["unchanged", current.revision, "0"];
    }
    if (BigInt(providerRevision) < BigInt(current.providerRevision)) return ["authority_stale"];
    const revision = String(BigInt(current.revision) + 1n);
    const next = { providerRevision, generation, revision };
    const artifacts = this._preflightAuthorityArtifacts(profileTag, current, next);
    if (!artifacts) return ["state_collision"];
    this._markAuthorityArtifacts(artifacts);
    this.authorities.set(profileTag, next);
    return ["updated", revision, String(artifacts.length)];
  }

  subtitleReserve(keys, args) {
    const authority = this.authorities.get(args[0]);
    if (!authority || authority.generation !== args[7] || authority.providerRevision !== args[10]) {
      return ["not_found"];
    }
    const discovery = this.discoveries.get(args[3]);
    if (discovery && !discovery.deletionRequested &&
      discovery.profileTag === args[0] && discovery.deviceRef === args[4] &&
      discovery.sessionRef === args[6] && discovery.generation === args[7] &&
      discovery.contextRef === args[8] && discovery.contextRevision === args[9] &&
      discovery.providerRevision === args[10]) {
      if (!args[24]) {
        return [
          "duplicate_challenge", discovery.id, discovery.ref, discovery.state,
          discovery.envelope || "",
        ];
      }
      if (discovery.ref !== args[24] || (discovery.envelope || "") !== args[25] ||
        discovery.sourceCapabilityDigest !== args[14]) {
        return ["source_conflict"];
      }
      const ownsReservation = discovery.state === "reserved";
      if (ownsReservation) discovery.reservationTokenHash = args[15];
      return [
        "duplicate", discovery.id, discovery.state, discovery.expiresAt,
        ownsReservation ? "1" : "0", ...storedPartReply(discovery),
      ];
    }
    if (args[24]) return ["not_found"];
    const artifactKey = keys[12];
    if (this.artifacts.has(artifactKey)) return ["artifact_collision"];
    const record = {
      key: artifactKey,
      id: args[1],
      ref: args[2],
      discoveryRef: args[3],
      profileTag: args[0],
      deviceRef: args[4],
      sessionRef: args[6],
      generation: args[7],
      contextRef: args[8],
      contextRevision: args[9],
      providerRevision: args[10],
      envelope: args[13],
      sourceCapabilityDigest: args[14],
      reservationTokenHash: args[15],
      schemaVersion: 3,
      state: "reserved",
      uploadState: "none",
      fetchFence: 0n,
      deletionRequested: false,
      deletionPhase: "none",
      deletionDueAt: null,
      deletionAttempt: 0n,
      objectPresent: true,
      indexProfileTag: args[0],
      globalIndexed: true,
      discoveryIndexKey: artifactKey,
      quotaObjects: Number(args[12]),
      quotaBytes: Number(args[11]),
      objectKeys: [],
      parts: [],
      expiresAt: "121000",
      absoluteExpiresAt: "601000",
    };
    this.artifacts.set(artifactKey, record);
    this.discoveries.set(record.discoveryRef, record);
    return ["reserved", record.id, record.expiresAt, record.absoluteExpiresAt];
  }

  subtitleCancelReservation(keys, args) {
    const record = this.artifacts.get(keys[12]);
    const ownsReservation = record && record.state === "reserved" &&
      record.reservationTokenHash === args[10];
    const ownsFetch = record && record.state === "fetching" &&
      record.fetchTokenHash === args[11];
    const ownsFencedFetch = record && record.state === "reserved" &&
      record.fetchFencedTokenHash === args[11];
    if (!record || record.id !== args[1] || record.ref !== args[2] ||
      record.profileTag !== args[0] || record.deviceRef !== args[3] ||
      record.sessionRef !== args[5] || record.generation !== args[6] ||
      record.contextRef !== args[7] || record.contextRevision !== args[8] ||
      record.providerRevision !== args[9] || record.uploadState !== "none" ||
      (!ownsReservation && !ownsFetch && !ownsFencedFetch)) {
      return ["not_found"];
    }
    this.artifacts.delete(record.key);
    if (this.discoveries.get(record.discoveryRef) === record) {
      this.discoveries.delete(record.discoveryRef);
    }
    return ["canceled", record.id, "1", String(record.quotaObjects), String(record.quotaBytes)];
  }

  _boundRecord(keys, args, keyIndex = 9) {
    const record = this.artifacts.get(keys[keyIndex]);
    if (!record) return null;
    return record.id === args[1] && record.ref === args[2] &&
      record.profileTag === args[0] && record.deviceRef === args[3] &&
      record.sessionRef === args[5] && record.generation === args[6] &&
      record.contextRef === args[7] && record.contextRevision === args[8] &&
      record.providerRevision === args[9] ? record : null;
  }

  _authorityMatches(record) {
    const authority = this.authorities.get(record.profileTag);
    return Boolean(authority && authority.generation === record.generation &&
      authority.providerRevision === record.providerRevision);
  }

  subtitleBeginFetchPeek(keys, args) {
    const record = this._boundRecord(keys, args);
    if (!record || !this._authorityMatches(record)) return ["not_found"];
    if (record.state === "fetching" && Number(record.fetchExpiresAt) > this.now) {
      if (record.fetchTokenHash !== args[10]) return ["fetch_busy"];
      return [
        "replay", record.id, record.expiresAt, record.fetchExpiresAt,
        String(record.fetchFence), String(record.schemaVersion), record.envelope,
      ];
    }
    if (record.state === "committed") {
      return ["committed", record.id, record.expiresAt, ...storedPartReply(record)];
    }
    if (record.state === "uploading") return ["fetch_busy"];
    if (record.state !== "reserved" && record.state !== "fetching") return ["not_found"];
    return ["ready", record.id, record.expiresAt, String(record.schemaVersion), record.envelope];
  }

  subtitleBeginFetch(keys, args) {
    const record = this._boundRecord(keys, args);
    if (!record || !this._authorityMatches(record)) return ["not_found"];
    if (record.envelope !== args[13]) return ["changed"];
    const tokenHash = args[10];
    let replay = false;
    if (record.state === "fetching") {
      if (Number(record.fetchExpiresAt) > this.now) {
        if (record.fetchTokenHash !== tokenHash) return ["fetch_busy"];
        replay = true;
      } else {
        const expiredToken = record.fetchTokenHash;
        record.state = "reserved";
        record.fetchFencedTokenHash = expiredToken;
        delete record.fetchTokenHash;
        delete record.fetchExpiresAt;
        if (expiredToken === tokenHash) return ["fetch_conflict"];
      }
    }
    if (record.state !== "reserved" && !replay) return ["not_found"];
    if (record.schemaVersion === 2) {
      if (record.quotaObjects !== Number(args[14]) || record.quotaBytes !== Number(args[15]) ||
        record.objectKeys.length !== 0 || record.parts.length !== 0) return ["state_collision"];
      record.schemaVersion = 3;
    }
    if (!replay) {
      if (record.fetchFencedTokenHash === tokenHash) return ["fetch_conflict"];
      record.fetchFence += 1n;
      record.fetchTokenHash = tokenHash;
      record.state = "fetching";
    }
    record.fetchExpiresAt = String(this.now + Number(args[11]));
    return [
      replay ? "replay" : "fetching", record.id, record.expiresAt,
      record.fetchExpiresAt, String(record.fetchFence), "3",
    ];
  }

  subtitleReleaseFetch(keys, args) {
    const record = this.artifacts.get(keys[9]);
    if (!record || record.schemaVersion !== 3 || record.id !== args[0] ||
      record.ref !== args[1] || record.state !== "fetching" ||
      record.fetchTokenHash !== args[2]) return ["not_found"];
    record.state = "reserved";
    record.fetchFencedTokenHash = record.fetchTokenHash;
    delete record.fetchTokenHash;
    delete record.fetchExpiresAt;
    return ["released", record.id, String(record.fetchFence)];
  }

  subtitleStageUpload(keys, args) {
    const record = this._boundRecord(keys, args, 12);
    if (!record || record.schemaVersion !== 3) return ["not_found"];
    const count = Number(args[13]);
    const parts = Array.from({ length: count }, (_value, index) => {
      const offset = 15 + index * 6;
      return {
        objectKey: args[offset],
        sizeBytes: Number(args[offset + 1]),
        checksum: args[offset + 2],
        role: args[offset + 3],
        extension: args[offset + 4],
        mediaType: args[offset + 5],
      };
    });
    if (record.state === "uploading") {
      if (record.fetchTokenHash !== args[10] || record.uploadTokenHash !== args[11] ||
        record.uploadAttemptRef !== args[12] || JSON.stringify(record.parts) !== JSON.stringify(parts)) {
        return ["stage_conflict"];
      }
      if (record.deletionRequested) return stagedReply("aborting", record);
      record.uploadExpiresAt = String(this.now + Number(args[27]));
      record.uploadSettlesAt = Math.max(
        record.uploadSettlesAt,
        Number(record.uploadExpiresAt) + Number(args[28]) + Number(args[29])
      );
      return stagedReply("replay", record);
    }
    if (record.state !== "fetching" || record.fetchTokenHash !== args[10] ||
      Number(record.fetchExpiresAt) <= this.now) return ["stage_conflict"];
    if (!this._authorityMatches(record)) return ["not_found"];
    const total = parts.reduce((sum, part) => sum + part.sizeBytes, 0);
    if (count > record.quotaObjects || total > record.quotaBytes) return ["stage_conflict"];
    record.state = "uploading";
    record.uploadState = "active";
    record.uploadTokenHash = args[11];
    record.uploadAttemptRef = args[12];
    record.objectKeys = parts.map((part) => part.objectKey);
    record.parts = parts;
    record.quotaObjects = count;
    record.quotaBytes = total;
    record.uploadExpiresAt = String(this.now + Number(args[27]));
    record.uploadSettlesAt = Number(record.uploadExpiresAt) + Number(args[28]) + Number(args[29]);
    delete record.reservationTokenHash;
    delete record.fetchExpiresAt;
    return stagedReply("uploading", record);
  }

  subtitleBeginUploadPeek(keys, args) {
    const record = this._boundRecord(keys, args);
    if (!record || record.schemaVersion !== 2) return ["not_found"];
    if (record.state === "uploading") {
      if (record.uploadTokenHash !== args[10]) return ["upload_busy"];
      if (record.deletionRequested) {
        return ["aborting", record.id, record.uploadExpiresAt, String(record.objectKeys.length), ...record.objectKeys];
      }
    }
    if (!this._authorityMatches(record)) return ["not_found"];
    if (record.state === "reserved") return ["ready", record.id, record.expiresAt, record.envelope];
    if (record.state === "uploading") {
      return [
        "replay", record.id, record.expiresAt, record.uploadExpiresAt, record.envelope,
        String(record.objectKeys.length), ...record.objectKeys,
      ];
    }
    if (record.state === "committed") {
      return ["committed", record.id, record.expiresAt, ...storedPartReply(record)];
    }
    return ["not_found"];
  }

  subtitleBeginUpload(keys, args) {
    const record = this._boundRecord(keys, args);
    if (!record || record.schemaVersion !== 2 || !this._authorityMatches(record)) return ["not_found"];
    if (record.state === "uploading") {
      if (record.uploadTokenHash !== args[11]) return ["upload_busy"];
      if (record.deletionRequested) {
        return ["aborting", record.id, record.uploadExpiresAt, String(record.objectKeys.length), ...record.objectKeys];
      }
      if (record.envelope !== args[17]) return ["changed"];
      record.uploadSettlesAt = Math.max(
        record.uploadSettlesAt,
        Number(record.uploadExpiresAt) + Number(args[14]) + Number(args[15])
      );
      return uploadReply("replay", record);
    }
    if (record.state !== "reserved" || record.envelope !== args[17]) return ["changed"];
    record.state = "uploading";
    record.uploadState = "active";
    record.uploadTokenHash = args[11];
    record.uploadAttemptRef = args[12];
    delete record.reservationTokenHash;
    record.uploadExpiresAt = String(this.now + Number(args[13]));
    record.uploadSettlesAt = Number(record.uploadExpiresAt) + Number(args[14]) + Number(args[15]);
    record.objectKeys = args.slice(18, 18 + Number(args[10]));
    return uploadReply("uploading", record);
  }

  subtitleAbortUpload(keys, args) {
    const record = this.artifacts.get(keys[9]);
    if (!record || record.id !== args[0] || record.ref !== args[1] || record.uploadTokenHash !== args[2]) {
      return ["not_found"];
    }
    if (record.uploadState === "complete") return ["complete"];
    if (record.uploadState !== "active" && record.uploadState !== "aborted") return ["not_found"];
    record.state = "deleting";
    record.uploadState = "aborted";
    record.deletionRequested = true;
    record.deletionPhase = "first_pending";
    record.deletionDueAt = Math.max(this.now, record.uploadSettlesAt);
    delete record.envelope;
    return ["aborted", record.id, ...storedPartReply(record)];
  }

  subtitleCommit(keys, args) {
    const record = this._boundRecord(keys, args);
    if (!record || record.uploadTokenHash !== args[10]) return ["not_found"];
    const mode = args[11];
    if ((record.schemaVersion === 3 && mode !== "receipt") ||
      (record.schemaVersion === 2 && mode !== "legacy")) return ["commit_conflict"];
    const count = Number(args[12]);
    const receipts = Array.from({ length: count }, (_value, index) => {
      const offset = 13 + index * 4;
      return {
        objectKey: args[offset],
        sizeBytes: Number(args[offset + 1]),
        checksum: args[offset + 2],
        mediaType: args[offset + 3],
      };
    });
    const expected = record.schemaVersion === 3
      ? record.parts.map((part) => ({
          objectKey: part.objectKey,
          sizeBytes: part.sizeBytes,
          checksum: part.checksum,
          mediaType: part.mediaType,
        }))
      : record.parts.map((part) => ({
          objectKey: "",
          sizeBytes: part.sizeBytes,
          checksum: part.checksum,
          mediaType: "",
        }));
    if (record.state === "committed") {
      if (JSON.stringify(receipts) !== JSON.stringify(expected)) return ["commit_conflict"];
      return ["replay", record.id, record.expiresAt, String(record.quotaBytes), ...storedPartReply(record)];
    }
    if (record.state !== "uploading" || record.uploadState !== "active") return ["not_found"];
    if (record.deletionRequested || !this._authorityMatches(record)) {
      record.state = "deleting";
      record.uploadState = "aborted";
      record.deletionRequested = true;
      record.deletionPhase = "first_pending";
      record.deletionDueAt = Math.max(this.now, record.uploadSettlesAt);
      delete record.envelope;
      return [record.deletionRequested ? "aborted" : "not_found"];
    }
    if (record.schemaVersion === 3 && JSON.stringify(receipts) !== JSON.stringify(expected)) {
      return ["commit_conflict"];
    }
    record.state = "committed";
    record.uploadState = "complete";
    if (record.schemaVersion === 2) {
      record.parts = receipts.map((part) => ({
        sizeBytes: part.sizeBytes,
        checksum: part.checksum,
      }));
      record.quotaObjects = count;
      record.quotaBytes = receipts.reduce((sum, part) => sum + part.sizeBytes, 0);
    }
    delete record.envelope;
    return ["committed", record.id, record.expiresAt, String(record.quotaBytes), ...storedPartReply(record)];
  }

  subtitleInvalidate(_keys, args) {
    let invalidated = 0;
    for (const record of this.artifacts.values()) {
      const matches = record.profileTag === args[0] &&
        (args[1] === "profile" ||
          (args[1] === "session" && record.sessionRef === args[3]) ||
          (args[1] === "release" && record.deviceRef === args[2] && record.sessionRef === args[3]));
      if (!matches || record.deletionRequested) continue;
      if (this._markDeleting(record)) invalidated += 1;
    }
    return ["invalidated", String(invalidated)];
  }

  subtitleClaimDeletion(_keys, args) {
    if (this.deletionTokens.has(args[0])) return ["token_collision"];
    const record = [...this.artifacts.values()].find((candidate) =>
      candidate.state === "deleting" &&
      ["empty_pending", "first_pending", "second_pending"].includes(candidate.deletionPhase) &&
      candidate.deletionDueAt <= this.now
    );
    if (!record) return ["empty"];
    const phase = record.deletionPhase.replace("_pending", "");
    record.state = "deletion_claimed";
    record.deletionPhase = phase + "_claimed";
    record.deletionClaimPhase = phase;
    record.deletionAttempt += 1n;
    record.deletionTokenHash = args[0];
    this.deletionTokens.set(args[0], record);
    return [
      "claimed", record.id, record.ref, String(record.deletionAttempt), "61000", phase,
      ...storedPartReply(record),
    ];
  }

  subtitleRecordDeletionAbsence(keys, args) {
    const record = this.artifacts.get(keys[9]);
    if (!record || record.id !== args[0] || record.ref !== args[1] ||
      record.deletionTokenHash !== args[2] || this.deletionTokens.get(args[2]) !== record) {
      return ["not_found"];
    }
    if (record.deletionPhase !== "first_claimed") return ["deletion_barrier"];
    if (record.uploadState === "active" || record.uploadSettlesAt > this.now) {
      return ["upload_barrier"];
    }
    this.deletionTokens.delete(args[2]);
    delete record.deletionTokenHash;
    record.state = "deleting";
    record.deletionPhase = "second_pending";
    record.deletionDueAt = this.now + Number(args[3]);
    return ["awaiting_second_pass", String(record.deletionDueAt)];
  }

  subtitleConfirmDeletion(keys, args) {
    const record = this.artifacts.get(keys[9]);
    if (!record || record.id !== args[0] || record.ref !== args[1] ||
      record.deletionTokenHash !== args[2] || this.deletionTokens.get(args[2]) !== record) {
      return ["not_found"];
    }
    if (record.uploadState === "active") return ["upload_barrier"];
    if (record.deletionPhase !== "second_claimed" && record.deletionPhase !== "empty_claimed") {
      return ["deletion_barrier"];
    }
    this.deletionTokens.delete(args[2]);
    this.artifacts.delete(record.key);
    return ["confirmed", "1", String(record.quotaObjects), String(record.quotaBytes)];
  }

  subtitlePrune() {
    let uploads = 0;
    for (const record of this.artifacts.values()) {
      if (record.state === "fetching" && Number(record.fetchExpiresAt) <= this.now) {
        record.state = "reserved";
        record.fetchFencedTokenHash = record.fetchTokenHash;
        delete record.fetchTokenHash;
        delete record.fetchExpiresAt;
        uploads += 1;
      } else if (record.uploadState === "active" && Number(record.uploadExpiresAt) <= this.now) {
        record.state = "deleting";
        record.uploadState = "aborted";
        record.deletionRequested = true;
        record.deletionPhase = "first_pending";
        record.deletionDueAt = Math.max(this.now, record.uploadSettlesAt);
        uploads += 1;
      }
    }
    const hasMore = [...this.artifacts.values()].some((record) =>
      (record.state === "fetching" && Number(record.fetchExpiresAt) <= this.now) ||
      (record.uploadState === "active" && Number(record.uploadExpiresAt) <= this.now) ||
      (record.state === "deleting" && record.deletionDueAt <= this.now)
    );
    return ["pruned", "0", "0", "0", String(uploads), hasMore ? "1" : "0"];
  }
}

function modelRepository(model, options = {}) {
  let sequence = 0;
  return new RedisSubtitleDeliveryRepository({
    client: fakeClient(),
    scriptRunner: model,
    keyspace: new RedisKeyspace("jg:v91"),
    tokenService: tokenService(1),
    envelopeCrypto: envelopeCrypto(40),
    objectKeyFactory: objectKeyFactory(),
    idFactory: () => "artifact_subtitle_fake_" + String(++sequence).padStart(8, "0"),
    ...options,
  });
}

function sourceCapability(name = "model") {
  return {
    url: "https://provider.example/private/" + name + ".vtt?token=provider-secret-" + name,
    headers: { Authorization: "Bearer provider-secret-" + name, "X-Source": name },
  };
}

function textPart(seed = "a", sizeBytes = 100, overrides = {}) {
  return {
    partNumber: 1,
    sizeBytes,
    checksum: seed.repeat(64).slice(0, 64),
    role: "subtitle",
    extension: ".vtt",
    mediaType: "text/vtt",
    ...overrides,
  };
}

function vobSubParts(indexSize = 100, subSize = 200) {
  return [
    {
      partNumber: 1,
      sizeBytes: indexSize,
      checksum: "a".repeat(64),
      role: "index",
      extension: ".idx",
      mediaType: "application/x-vobsub",
    },
    {
      partNumber: 2,
      sizeBytes: subSize,
      checksum: "b".repeat(64),
      role: "sub",
      extension: ".sub",
      mediaType: "application/octet-stream",
    },
  ];
}

function uploadReceipts(staged) {
  return staged.parts.map((part) => ({
    key: part.objectKey,
    contentLength: part.sizeBytes,
    checksumSha256: part.checksum,
    contentType: part.mediaType,
  }));
}

function mutateCiphertext(serialized) {
  const envelope = JSON.parse(serialized);
  const ciphertext = Buffer.from(envelope.ct, "base64url");
  assert.ok(ciphertext.length > 0);
  ciphertext[0] ^= 1;
  envelope.ct = ciphertext.toString("base64url");
  return JSON.stringify(envelope);
}

function registerModelTests() {
  test("subtitle stateful model encrypts capabilities and fences fetch and stage ownership", async () => {
    const model = new StatefulSubtitleScriptModel();
    const repository = modelRepository(model);
    assert.equal(assertRepository("subtitleDeliveries", repository), repository);
    const binding = fakeBinding();
    await repository.updateAuthority({
      profileId: binding.profileId,
      expectedProviderRevision: null,
      expectedGeneration: null,
      providerRevision: binding.providerRevision,
      generation: binding.generation,
    });
    const request = {
      ...binding,
      discoveryKey: "model-discovery",
      sourceCapability: sourceCapability(),
    };
    const [first, duplicate] = await Promise.all([repository.reserve(request), repository.reserve(request)]);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(first.artifactId, duplicate.artifactId);
    assert.equal(DEFAULT_SUBTITLE_DELIVERY_LIMITS.profileArtifacts, 64);
    assert.equal(DEFAULT_SUBTITLE_DELIVERY_LIMITS.globalBytes, 8 * 1024 * 1024 * 1024);

    const persisted = JSON.stringify(
      [...model.artifacts.values()],
      (_key, value) => typeof value === "bigint" ? value.toString() : value
    );
    assert.equal(persisted.includes("provider.example"), false);
    assert.equal(persisted.includes("provider-secret"), false);
    assert.equal(JSON.stringify(model.calls).includes("provider-secret"), false);
    const reservedRecord = [...model.artifacts.values()].find(
      (record) => record.id === first.artifactId
    );
    assert.match(reservedRecord.sourceCapabilityDigest, /^[a-f0-9]{64}$/);
    for (const call of model.calls) {
      for (const key of call.keys) {
        assert.match(key, /^jg:v91:[a-z0-9-]+:[a-f0-9]{64}$/);
        assert.equal(key.includes(binding.profileId), false);
      }
    }

    const attempts = await Promise.allSettled([
      repository.beginFetch({ artifactId: first.artifactId, ...binding }),
      repository.beginFetch({ artifactId: first.artifactId, ...binding }),
    ]);
    const fetch = attempts.find((result) => result.status === "fulfilled").value;
    const loser = attempts.find((result) => result.status === "rejected").reason;
    assert.equal(loser.code, "subtitle_fetch_busy");
    assert.match(fetch.fetchToken, /^[A-Za-z0-9_-]+$/);
    assert.equal(fetch.schemaVersion, 3);
    assert.equal(fetch.partMetadataVersion, null);
    assert.deepEqual(fetch.parts, []);
    const fetchReplay = await repository.beginFetch({
      artifactId: first.artifactId,
      ...binding,
      fetchToken: fetch.fetchToken,
    });
    assert.equal(fetchReplay.replay, true);
    assert.equal(fetchReplay.fetchFence, fetch.fetchFence);
    assert.deepEqual(fetchReplay.sourceCapability, {
      v: 1,
      url: sourceCapability().url,
      headers: { authorization: "Bearer provider-secret-model", "x-source": "model" },
    });

    const staged = await repository.stageUpload({
      artifactId: first.artifactId,
      ...binding,
      fetchToken: fetch.fetchToken,
      parts: vobSubParts(),
    });
    assert.match(staged.uploadToken, /^[A-Za-z0-9_-]+$/);
    assert.equal(staged.schemaVersion, 3);
    assert.equal(staged.partMetadataVersion, 1);
    assert.equal(staged.sizeBytes, 300);
    assert.equal(new Set(staged.parts.map((part) => part.objectKey)).size, 2);
    assert.deepEqual(
      staged.parts.map(({ partNumber, sizeBytes, checksum, role, extension, mediaType }) => ({
        partNumber, sizeBytes, checksum, role, extension, mediaType,
      })),
      vobSubParts()
    );
    for (const part of staged.parts) {
      assert.equal(objectKeyFactory().assert(part.objectKey), part.objectKey);
    }
    const compatibleStore = compatibilityObjectStore();
    await Promise.all(staged.parts.map((part) => compatibleStore.delete(part.objectKey)));
    const replay = await repository.stageUpload({
      artifactId: first.artifactId,
      ...binding,
      fetchToken: fetch.fetchToken,
      uploadToken: staged.uploadToken,
      parts: vobSubParts(),
    });
    assert.equal(replay.replay, true);
    assert.deepEqual(replay.parts, staged.parts);
    assert.deepEqual(
      {
        objects: reservedRecord.quotaObjects,
        bytes: reservedRecord.quotaBytes,
      },
      { objects: 2, bytes: 300 }
    );
    await assert.rejects(
      repository.stageUpload({
        artifactId: first.artifactId,
        ...binding,
        fetchToken: fetch.fetchToken,
        uploadToken: staged.uploadToken,
        parts: vobSubParts(101, 200),
      }),
      (error) => error.code === "subtitle_stage_conflict"
    );

    const receipts = uploadReceipts(staged);
    const commits = await Promise.all([
      repository.commit({ artifactId: first.artifactId, ...binding, uploadToken: staged.uploadToken, receipts }),
      repository.commit({ artifactId: first.artifactId, ...binding, uploadToken: staged.uploadToken, receipts }),
    ]);
    assert.deepEqual(commits.map((result) => result.sizeBytes), [300, 300]);
    assert.equal(commits.filter((result) => result.replay).length, 1);
    await assert.rejects(
      repository.commit({
        artifactId: first.artifactId,
        ...binding,
        uploadToken: staged.uploadToken,
        receipts: receipts.map((receipt, index) => index === 0
          ? { ...receipt, checksumSha256: "c".repeat(64) }
          : receipt),
      }),
      (error) => error.code === "subtitle_commit_conflict"
    );
    assert.equal(await repository.commit({
      artifactId: first.artifactId,
      ...binding,
      uploadToken: tokenService(90).issue("subtitle-upload", 32).token,
      receipts,
    }), null);

    await assert.rejects(
      repository.reserve({ ...request, discoveryKey: "raw-envelope", sourceCapability: undefined, sourceEnvelope: Buffer.alloc(32) }),
      /sourceEnvelope is not accepted/
    );
    await repository.invalidateProfile(binding.profileId);
    assert.equal(await repository.claimDeletion("worker_model_complete_put_inflight"), null);
    const committedRecord = [...model.artifacts.values()].find((record) => record.id === first.artifactId);
    model.now = committedRecord.uploadSettlesAt + 1;
    assert.equal((await repository.claimDeletion("worker_model_complete_settled")).phase, "first");
  });

  test("subtitle stateful model rejects envelope tamper before upload mutation", async () => {
    const model = new StatefulSubtitleScriptModel();
    const repository = modelRepository(model);
    const binding = fakeBinding();
    await repository.updateAuthority({
      profileId: binding.profileId,
      expectedProviderRevision: null,
      expectedGeneration: null,
      providerRevision: binding.providerRevision,
      generation: binding.generation,
    });
    const reserved = await repository.reserve({
      ...binding,
      discoveryKey: "tamper-model",
      sourceCapability: sourceCapability("tamper"),
    });
    const record = [...model.artifacts.values()].find((candidate) => candidate.id === reserved.artifactId);
    record.envelope = mutateCiphertext(record.envelope);
    const beginCalls = model.calls.filter((call) => call.name === "subtitleBeginFetch").length;
    await assert.rejects(
      repository.beginFetch({ artifactId: reserved.artifactId, ...binding }),
      /envelope authentication failed/
    );
    assert.equal(model.calls.filter((call) => call.name === "subtitleBeginFetch").length, beginCalls);
    assert.equal(record.state, "reserved");
    assert.equal(record.uploadState, "none");
  });

  test("subtitle duplicate reservation authenticates exact capability and artifact binding", async () => {
    const model = new StatefulSubtitleScriptModel();
    const repository = modelRepository(model);
    const binding = fakeBinding({ providerRevision: "19" });
    await repository.reconcileAuthority({
      profileId: binding.profileId,
      providerRevision: binding.providerRevision,
      generation: binding.generation,
    });
    const request = {
      ...binding,
      discoveryKey: "authenticated-duplicate-model",
      sourceCapability: sourceCapability("authenticated-duplicate-model"),
    };
    const original = await repository.reserve(request);
    const record = [...model.artifacts.values()].find(
      (candidate) => candidate.id === original.artifactId
    );
    const originalTokenHash = record.reservationTokenHash;

    assert.equal(await repository.reserve({
      ...request,
      sourceCapability: {
        ...request.sourceCapability,
        url: "https://provider.example/changed-url?token=changed",
      },
    }), null);
    assert.equal(record.reservationTokenHash, originalTokenHash);
    assert.equal(await repository.reserve({
      ...request,
      sourceCapability: {
        ...request.sourceCapability,
        headers: { ...request.sourceCapability.headers, "X-Source": "changed-header" },
      },
    }), null);
    assert.equal(record.reservationTokenHash, originalTokenHash);
    assert.equal(
      await repository.cancelReservation(
        original.artifactId,
        { ...binding, sessionId: "session_subtitle_wrong" },
        original.reservationToken
      ),
      null
    );
    assert.equal(record.reservationTokenHash, originalTokenHash);

    const sameSource = await repository.reserve(request);
    assert.equal(sameSource.duplicate, true);
    assert.notEqual(record.reservationTokenHash, originalTokenHash);
    assert.equal(
      await repository.cancelReservation(original.artifactId, binding, original.reservationToken),
      null
    );
    assert.ok(await repository.cancelReservation(
      original.artifactId,
      binding,
      sameSource.reservationToken
    ));

    const transplantSource = sourceCapability("digest-transplant-model");
    const transplantARequest = {
      ...binding,
      discoveryKey: "digest-transplant-a-model",
      sourceCapability: transplantSource,
    };
    const transplantBRequest = {
      ...binding,
      discoveryKey: "digest-transplant-b-model",
      sourceCapability: transplantSource,
    };
    const transplantA = await repository.reserve(transplantARequest);
    const transplantB = await repository.reserve(transplantBRequest);
    const transplantARecord = [...model.artifacts.values()].find(
      (candidate) => candidate.id === transplantA.artifactId
    );
    const transplantBRecord = [...model.artifacts.values()].find(
      (candidate) => candidate.id === transplantB.artifactId
    );
    assert.notEqual(
      transplantARecord.sourceCapabilityDigest,
      transplantBRecord.sourceCapabilityDigest,
      "the authenticated digest was not bound to the exact artifact"
    );
    const transplantBTokenHash = transplantBRecord.reservationTokenHash;
    transplantBRecord.sourceCapabilityDigest = transplantARecord.sourceCapabilityDigest;
    assert.equal(await repository.reserve(transplantBRequest), null);
    assert.equal(transplantBRecord.reservationTokenHash, transplantBTokenHash);
    assert.ok(await repository.cancelReservation(
      transplantB.artifactId,
      binding,
      transplantB.reservationToken
    ));

    const tamperRequest = {
      ...binding,
      discoveryKey: "authenticated-envelope-tamper-model",
      sourceCapability: sourceCapability("authenticated-envelope-tamper-model"),
    };
    const tampered = await repository.reserve(tamperRequest);
    const tamperedRecord = [...model.artifacts.values()].find(
      (candidate) => candidate.id === tampered.artifactId
    );
    const tamperedTokenHash = tamperedRecord.reservationTokenHash;
    tamperedRecord.envelope = mutateCiphertext(tamperedRecord.envelope);
    await assert.rejects(repository.reserve(tamperRequest), /envelope authentication failed/);
    assert.equal(tamperedRecord.reservationTokenHash, tamperedTokenHash);
    assert.ok(await repository.cancelReservation(
      tampered.artifactId,
      binding,
      tampered.reservationToken
    ));
  });

  test("subtitle stateful model closes authority invalidation and deletion receipt races", async () => {
    const model = new StatefulSubtitleScriptModel();
    const repository = modelRepository(model, {
      uploadLeaseTtlMs: 20,
      maxPutLifetimeMs: 20,
      uploadSettlementGraceMs: 10,
    });
    const binding = fakeBinding({ providerRevision: "7" });
    await repository.updateAuthority({
      profileId: binding.profileId,
      expectedProviderRevision: null,
      expectedGeneration: null,
      providerRevision: "7",
      generation: binding.generation,
    });
    const reserved = await repository.reserve({
      ...binding,
      discoveryKey: "authority-model",
      sourceCapability: sourceCapability("authority"),
    });
    const fetch = await repository.beginFetch({ artifactId: reserved.artifactId, ...binding });
    const upload = await repository.stageUpload({
      artifactId: reserved.artifactId,
      ...binding,
      fetchToken: fetch.fetchToken,
      parts: [textPart("c", 9)],
    });
    const updated = await repository.updateAuthority({
      profileId: binding.profileId,
      expectedProviderRevision: "7",
      expectedGeneration: binding.generation,
      providerRevision: "8",
      generation: binding.generation,
    });
    assert.equal(updated.invalidated, 1);
    assert.equal(await repository.claimDeletion("worker_model_before_barrier"), null);
    assert.equal(await repository.commit({
      artifactId: reserved.artifactId,
      ...binding,
      uploadToken: upload.uploadToken,
      receipts: uploadReceipts(upload),
    }), null);
    model.now += 51;
    const firstClaim = await repository.claimDeletion("worker_model_after_barrier");
    assert.equal(firstClaim.artifactId, reserved.artifactId);
    assert.equal(firstClaim.phase, "first");
    assert.equal(await repository.recordDeletionAbsence({
      artifactId: reserved.artifactId,
      deletionToken: tokenService(70).issue("subtitle-deletion", 24).token,
      verifiedAbsent: true,
    }), null);
    await assert.rejects(
      repository.confirmDeletion(reserved.artifactId, firstClaim.deletionToken, true),
      (error) => error.code === "subtitle_deletion_barrier"
    );
    const waiting = await repository.recordDeletionAbsence(
      reserved.artifactId,
      firstClaim.deletionToken,
      true
    );
    assert.equal(waiting.status, "awaiting_second_pass");
    assert.equal(await repository.claimDeletion("worker_model_before_second"), null);
    model.now += 11;
    const secondClaim = await repository.claimDeletion("worker_model_second");
    assert.equal(secondClaim.phase, "second");
    assert.deepEqual(
      (await repository.confirmDeletion(reserved.artifactId, secondClaim.deletionToken, true)).released,
      { artifacts: 1, objects: 1, bytes: 9 }
    );

    const emptyModel = new StatefulSubtitleScriptModel();
    const emptyRepository = modelRepository(emptyModel);
    const emptyBinding = fakeBinding({ providerRevision: "9" });
    await emptyRepository.reconcileAuthority({
      profileId: emptyBinding.profileId,
      providerRevision: emptyBinding.providerRevision,
      generation: emptyBinding.generation,
    });
    const emptyArtifact = await emptyRepository.reserve({
      ...emptyBinding,
      discoveryKey: "authority-model-empty",
      sourceCapability: sourceCapability("authority-model-empty"),
    });
    await emptyRepository.invalidateProfile(emptyBinding.profileId);
    let emptyObjectStoreCalls = 0;
    const emptyWorker = new SubtitleDeletionWorker({
      repository: emptyRepository,
      objectStore: compatibilityObjectStore({
        async send() {
          emptyObjectStoreCalls += 1;
          throw new Error("empty deletion must not call object storage");
        },
      }),
      workerId: "worker_model_empty",
    });
    assert.deepEqual(await emptyWorker.runOnce(), {
      status: "confirmed",
      artifactId: emptyArtifact.artifactId,
      phase: "empty",
      released: {
        artifacts: 1,
        objects: DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactParts,
        bytes: DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactBytes,
      },
    });
    assert.equal(await emptyWorker.runOnce(), null);
    assert.equal(emptyObjectStoreCalls, 0);
    assert.equal(emptyModel.artifacts.size, 0);

    await assert.rejects(
      repository.updateAuthority({
        profileId: binding.profileId,
        expectedProviderRevision: "7",
        expectedGeneration: binding.generation,
        providerRevision: "9",
        generation: binding.generation,
      }),
      (error) => error.code === "subtitle_authority_conflict" && error.status === 409
    );
  });

  test("subtitle stateful model persists a two-pass late-PUT settlement barrier", async () => {
    const model = new StatefulSubtitleScriptModel();
    const repository = modelRepository(model, {
      uploadLeaseTtlMs: 20,
      maxPutLifetimeMs: 30,
      uploadSettlementGraceMs: 10,
    });
    const binding = fakeBinding({ providerRevision: "11" });
    await repository.updateAuthority({
      profileId: binding.profileId,
      expectedProviderRevision: null,
      expectedGeneration: null,
      providerRevision: binding.providerRevision,
      generation: binding.generation,
    });
    const reserved = await repository.reserve({
      ...binding,
      discoveryKey: "settlement-model",
      sourceCapability: sourceCapability("settlement-model"),
    });
    const fetch = await repository.beginFetch({
      artifactId: reserved.artifactId,
      ...binding,
    });
    const upload = await repository.stageUpload({
      artifactId: reserved.artifactId,
      ...binding,
      fetchToken: fetch.fetchToken,
      parts: [textPart("d", 17)],
    });
    const key = upload.parts[0].objectKey;
    const objects = new Map();
    const store = mappedObjectStore(objects);

    await repository.invalidateProfile(binding.profileId);
    objects.set(key, "after-invalidation");
    assert.equal((await repository.prune()).hasMore, false);
    model.now += 21;
    const expired = await repository.prune();
    assert.equal(expired.uploads, 1);
    assert.equal(expired.hasMore, false);
    objects.set(key, "after-expiry");
    assert.equal(await repository.claimDeletion("worker_model_put_still_settling"), null);

    model.now += 40;
    const first = await repository.claimDeletion("worker_model_first_delete");
    assert.equal(first.phase, "first");
    await store.delete(key);
    objects.set(key, "after-first-delete");
    assert.equal(await isAbsent(store, key), false);
    await store.delete(key);
    assert.equal(await isAbsent(store, key), true);
    await repository.recordDeletionAbsence(first.artifactId, first.deletionToken, true);

    objects.set(key, "after-first-absence");
    const restarted = modelRepository(model, {
      uploadLeaseTtlMs: 20,
      maxPutLifetimeMs: 30,
      uploadSettlementGraceMs: 10,
    });
    assert.equal(await restarted.claimDeletion("worker_model_second_too_early"), null);
    model.now += 11;
    const second = await restarted.claimDeletion("worker_model_second_delete");
    assert.equal(second.phase, "second");
    await store.delete(key);
    assert.equal(await isAbsent(store, key), true);
    assert.ok(await restarted.confirmDeletion(second.artifactId, second.deletionToken, true));
    assert.equal(objects.has(key), false);
  });

  test("subtitle stateful model cancels only the current pre-upload reservation owner", async () => {
    const model = new StatefulSubtitleScriptModel();
    const repository = modelRepository(model);
    const binding = fakeBinding({ providerRevision: "21" });
    await repository.reconcileAuthority({
      profileId: binding.profileId,
      providerRevision: binding.providerRevision,
      generation: binding.generation,
    });
    assert.equal(
      await repository.cancelReservation("artifact_subtitle_fake_missing", binding, "missing"),
      null
    );

    const request = {
      ...binding,
      discoveryKey: "cancel-owner-model",
      sourceCapability: sourceCapability("cancel-owner-model"),
    };
    const first = await repository.reserve(request);
    const replacementOwner = await repository.reserve(request);
    assert.equal(replacementOwner.duplicate, true);
    assert.notEqual(first.reservationToken, replacementOwner.reservationToken);
    assert.equal(
      await repository.cancelReservation(first.artifactId, binding, first.reservationToken),
      null,
      "a replaced reservation owner canceled the current owner"
    );
    assert.equal(
      await repository.cancelReservation(
        first.artifactId,
        { ...binding, sessionId: "session_subtitle_wrong" },
        replacementOwner.reservationToken
      ),
      null
    );
    assert.deepEqual(
      await repository.cancelReservation(
        first.artifactId,
        binding,
        replacementOwner.reservationToken
      ),
      {
        status: "canceled",
        artifactId: first.artifactId,
        released: {
          artifacts: 1,
          objects: DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactParts,
          bytes: DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactBytes,
        },
      }
    );
    assert.equal(model.artifacts.size, 0);
    assert.equal(model.discoveries.size, 0);
    assert.equal(
      await repository.cancelReservation(
        first.artifactId,
        binding,
        replacementOwner.reservationToken
      ),
      null,
      "a cancellation replay released quota twice"
    );

    const fetching = await repository.reserve({
      ...request,
      discoveryKey: "cancel-after-begin-model",
    });
    const activeFetch = await repository.beginFetch({ artifactId: fetching.artifactId, ...binding });
    assert.equal(
      await repository.cancelReservation(fetching.artifactId, binding, fetching.reservationToken),
      null,
      "a reservation token canceled an active fetch"
    );
    assert.ok(await repository.cancelReservation({
      artifactId: fetching.artifactId,
      ...binding,
      reservationToken: fetching.reservationToken,
      fetchToken: activeFetch.fetchToken,
    }));

    const invalidated = await repository.reserve({
      ...request,
      discoveryKey: "cancel-after-invalidate-model",
    });
    await repository.invalidateSession(binding.profileId, binding.sessionId);
    assert.equal(
      await repository.cancelReservation(invalidated.artifactId, binding, invalidated.reservationToken),
      null,
      "an invalidated reservation was canceled outside deletion"
    );
  });

  test("subtitle stateful model reconciles crash recovery forward and fences concurrent CAS", async () => {
    const model = new StatefulSubtitleScriptModel();
    const repository = modelRepository(model);
    const binding = fakeBinding({ providerRevision: "31" });
    assert.equal(await repository.getAuthority(binding.profileId), null);
    assert.deepEqual(
      await repository.reconcileAuthority({
        profileId: binding.profileId,
        providerRevision: binding.providerRevision,
        generation: binding.generation,
      }),
      {
        status: "updated",
        revision: "1",
        invalidated: 0,
        providerRevision: "31",
        generation: binding.generation,
      }
    );
    assert.deepEqual(await repository.getAuthority(binding.profileId), {
      profileId: binding.profileId,
      providerRevision: "31",
      generation: binding.generation,
      revision: "1",
    });

    const cas = await Promise.allSettled([
      repository.transitionAuthority({
        profileId: binding.profileId,
        expectedProviderRevision: "31",
        expectedGeneration: binding.generation,
        providerRevision: "32",
        generation: binding.generation,
      }),
      repository.transitionAuthority({
        profileId: binding.profileId,
        expectedProviderRevision: "31",
        expectedGeneration: binding.generation,
        providerRevision: "33",
        generation: binding.generation,
      }),
    ]);
    assert.equal(cas.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(cas.filter((result) => result.status === "rejected").length, 1);
    assert.equal(cas.find((result) => result.status === "rejected").reason.code, "subtitle_authority_conflict");

    const durableSnapshot = {
      profileId: binding.profileId,
      providerRevision: "40",
      generation: "g1:subtitle-fake-next",
    };
    const reconciled = await repository.reconcileAuthority(durableSnapshot);
    assert.equal(reconciled.status, "updated");
    const restarted = modelRepository(model);
    assert.equal((await restarted.reconcileAuthority(durableSnapshot)).status, "unchanged");
    assert.deepEqual(await restarted.getAuthority(binding.profileId), {
      ...durableSnapshot,
      revision: reconciled.revision,
    });
    await assert.rejects(
      restarted.reconcileAuthority({
        profileId: binding.profileId,
        providerRevision: "39",
        generation: durableSnapshot.generation,
      }),
      (error) => error.code === "subtitle_authority_stale" && error.status === 409
    );

    const other = fakeBinding({
      profileId: "profile_subtitle_fake_other",
      providerRevision: "9".repeat(128),
    });
    await restarted.reconcileAuthority({
      profileId: other.profileId,
      providerRevision: other.providerRevision,
      generation: other.generation,
    });
    await restarted.reconcileAuthority({
      profileId: binding.profileId,
      providerRevision: "41",
      generation: durableSnapshot.generation,
    });
    assert.equal((await restarted.getAuthority(other.profileId)).providerRevision, other.providerRevision);
    await assert.rejects(
      restarted.reconcileAuthority({
        profileId: other.profileId,
        providerRevision: "1".repeat(129),
        generation: other.generation,
      }),
      /provider revision is invalid/
    );

    const collisionCases = [
      {
        name: "cross-profile artifact ID",
        operation: "reconcile",
        mutate: async ({ model: collisionModel, repository: collisionRepository, binding: collisionBinding }) => {
          const otherBinding = fakeBinding({
            profileId: collisionBinding.profileId + "_other",
            deviceId: collisionBinding.deviceId + "_other",
            sessionId: collisionBinding.sessionId + "_other",
            contextId: collisionBinding.contextId + "_other",
            generation: collisionBinding.generation,
            providerRevision: collisionBinding.providerRevision,
          });
          await collisionRepository.reconcileAuthority({
            profileId: otherBinding.profileId,
            providerRevision: otherBinding.providerRevision,
            generation: otherBinding.generation,
          });
          const artifact = await collisionRepository.reserve({
            ...otherBinding,
            discoveryKey: "authority-cross-profile",
            sourceCapability: sourceCapability("authority-cross-profile"),
          });
          const record = [...collisionModel.artifacts.values()].find(
            (candidate) => candidate.id === artifact.artifactId
          );
          record.indexProfileTag = collisionRepository._keys.member(
            "playback-profile",
            collisionBinding.profileId
          );
        },
      },
      {
        name: "malformed artifact index",
        operation: "update",
        mutate: async ({ records }) => { records[0].indexMalformed = true; },
      },
      {
        name: "missing global index",
        operation: "reconcile",
        mutate: async ({ records }) => { records[0].globalIndexed = false; },
      },
      {
        name: "missing artifact object state",
        operation: "update",
        mutate: async ({ records }) => { records[0].objectPresent = false; },
      },
      {
        name: "invalid state transition",
        operation: "reconcile",
        mutate: async ({ records }) => { records[0].state = "deleting"; },
      },
      {
        name: "colliding discovery index",
        operation: "update",
        mutate: async ({ records }) => { records[1].discoveryIndexKey = records[0].key; },
      },
      {
        name: "late invalid multi-artifact member",
        operation: "reconcile",
        mutate: async ({ records }) => { records[2].uploadState = "complete"; },
      },
    ];

    for (let caseIndex = 0; caseIndex < collisionCases.length; caseIndex += 1) {
      const collisionCase = collisionCases[caseIndex];
      const collisionModel = new StatefulSubtitleScriptModel();
      const collisionRepository = modelRepository(collisionModel);
      const collisionBinding = fakeBinding({
        profileId: "profile_subtitle_authority_collision_" + String(caseIndex),
        deviceId: "device_subtitle_authority_collision_" + String(caseIndex),
        sessionId: "session_subtitle_authority_collision_" + String(caseIndex),
        contextId: "context_subtitle_authority_collision_" + String(caseIndex),
        generation: "g1:subtitle-authority-collision-" + String(caseIndex),
        providerRevision: "70",
      });
      await collisionRepository.reconcileAuthority({
        profileId: collisionBinding.profileId,
        providerRevision: collisionBinding.providerRevision,
        generation: collisionBinding.generation,
      });
      const artifacts = [];
      for (let artifactIndex = 0; artifactIndex < 3; artifactIndex += 1) {
        artifacts.push(await collisionRepository.reserve({
          ...collisionBinding,
          discoveryKey: collisionCase.name + "-" + String(artifactIndex),
          sourceCapability: sourceCapability(collisionCase.name + "-" + String(artifactIndex)),
        }));
      }
      const records = artifacts.map((artifact) => [...collisionModel.artifacts.values()].find(
        (candidate) => candidate.id === artifact.artifactId
      ));
      await collisionCase.mutate({
        model: collisionModel,
        repository: collisionRepository,
        binding: collisionBinding,
        records,
      });
      const authoritiesBefore = structuredClone(collisionModel.authorities);
      const artifactsBefore = structuredClone(collisionModel.artifacts);
      const unchangedRequest = collisionCase.operation === "update"
        ? collisionRepository.transitionAuthority({
            profileId: collisionBinding.profileId,
            expectedProviderRevision: collisionBinding.providerRevision,
            expectedGeneration: collisionBinding.generation,
            providerRevision: collisionBinding.providerRevision,
            generation: collisionBinding.generation,
          })
        : collisionRepository.reconcileAuthority({
            profileId: collisionBinding.profileId,
            providerRevision: collisionBinding.providerRevision,
            generation: collisionBinding.generation,
          });
      await assert.rejects(
        unchangedRequest,
        (error) => error.code === "subtitle_state_collision",
        collisionCase.name + " unchanged preflight"
      );
      assert.deepEqual(collisionModel.authorities, authoritiesBefore, collisionCase.name);
      assert.deepEqual(collisionModel.artifacts, artifactsBefore, collisionCase.name);
      const request = collisionCase.operation === "update"
        ? collisionRepository.transitionAuthority({
            profileId: collisionBinding.profileId,
            expectedProviderRevision: collisionBinding.providerRevision,
            expectedGeneration: collisionBinding.generation,
            providerRevision: "71",
            generation: collisionBinding.generation,
          })
        : collisionRepository.reconcileAuthority({
            profileId: collisionBinding.profileId,
            providerRevision: "71",
            generation: collisionBinding.generation,
          });
      await assert.rejects(
        request,
        (error) => error.code === "subtitle_state_collision",
        collisionCase.name
      );
      assert.deepEqual(collisionModel.authorities, authoritiesBefore, collisionCase.name);
      assert.deepEqual(collisionModel.artifacts, artifactsBefore, collisionCase.name);
    }

    const rollbackModel = new StatefulSubtitleScriptModel();
    const rollbackRepository = modelRepository(rollbackModel);
    const rollbackBinding = fakeBinding({
      profileId: "profile_subtitle_authority_rollback",
      deviceId: "device_subtitle_authority_rollback",
      sessionId: "session_subtitle_authority_rollback",
      contextId: "context_subtitle_authority_rollback",
      generation: "g1:subtitle-authority-rollback",
      providerRevision: "75",
    });
    await rollbackRepository.reconcileAuthority({
      profileId: rollbackBinding.profileId,
      providerRevision: rollbackBinding.providerRevision,
      generation: rollbackBinding.generation,
    });
    const rollbackArtifacts = [];
    for (let index = 0; index < 3; index += 1) {
      rollbackArtifacts.push(await rollbackRepository.reserve({
        ...rollbackBinding,
        discoveryKey: "authority-rollback-" + String(index),
        sourceCapability: sourceCapability("authority-rollback-" + String(index)),
      }));
    }
    const rollbackRecords = rollbackArtifacts.map((artifact) => [...rollbackModel.artifacts.values()].find(
      (candidate) => candidate.id === artifact.artifactId
    ));
    rollbackRecords[2].markDeletingFailure = true;
    const rollbackAuthoritiesBefore = structuredClone(rollbackModel.authorities);
    const rollbackArtifactsBefore = structuredClone(rollbackModel.artifacts);
    await assert.rejects(
      rollbackRepository.reconcileAuthority({
        profileId: rollbackBinding.profileId,
        providerRevision: "76",
        generation: rollbackBinding.generation,
      }),
      /subtitle authority invalidation invariant/
    );
    assert.deepEqual(rollbackModel.authorities, rollbackAuthoritiesBefore);
    assert.deepEqual(rollbackModel.artifacts, rollbackArtifactsBefore);
    delete rollbackRecords[2].markDeletingFailure;
    assert.equal((await rollbackRepository.reconcileAuthority({
      profileId: rollbackBinding.profileId,
      providerRevision: "76",
      generation: rollbackBinding.generation,
    })).invalidated, rollbackArtifacts.length);

    const validModel = new StatefulSubtitleScriptModel();
    const validRepository = modelRepository(validModel);
    const validBinding = fakeBinding({
      profileId: "profile_subtitle_authority_valid",
      deviceId: "device_subtitle_authority_valid",
      sessionId: "session_subtitle_authority_valid",
      contextId: "context_subtitle_authority_valid",
      generation: "g1:subtitle-authority-valid",
      providerRevision: "80",
    });
    await validRepository.reconcileAuthority({
      profileId: validBinding.profileId,
      providerRevision: validBinding.providerRevision,
      generation: validBinding.generation,
    });
    const validArtifacts = await Promise.all([0, 1].map((index) => validRepository.reserve({
      ...validBinding,
      discoveryKey: "authority-valid-reconcile-" + String(index),
      sourceCapability: sourceCapability("authority-valid-reconcile-" + String(index)),
    })));
    const validReconcile = await validRepository.reconcileAuthority({
      profileId: validBinding.profileId,
      providerRevision: "81",
      generation: validBinding.generation,
    });
    assert.equal(validReconcile.invalidated, 2);
    assert.equal((await validRepository.reconcileAuthority({
      profileId: validBinding.profileId,
      providerRevision: "81",
      generation: validBinding.generation,
    })).invalidated, 0);
    for (const artifact of validArtifacts) {
      const record = [...validModel.artifacts.values()].find(
        (candidate) => candidate.id === artifact.artifactId
      );
      assert.equal(record.invalidationCount, 1);
      assert.equal(record.state, "deleting");
    }

    const updateBinding = { ...validBinding, providerRevision: "81" };
    const updateArtifact = await validRepository.reserve({
      ...updateBinding,
      discoveryKey: "authority-valid-update",
      sourceCapability: sourceCapability("authority-valid-update"),
    });
    assert.equal((await validRepository.reconcileAuthority({
      profileId: validBinding.profileId,
      providerRevision: "81",
      generation: validBinding.generation,
    })).status, "unchanged");
    assert.equal(
      [...validModel.artifacts.values()].find(
        (candidate) => candidate.id === updateArtifact.artifactId
      ).state,
      "reserved"
    );
    assert.equal((await validRepository.transitionAuthority({
      profileId: validBinding.profileId,
      expectedProviderRevision: "81",
      expectedGeneration: validBinding.generation,
      providerRevision: "82",
      generation: validBinding.generation,
    })).invalidated, 1);
    assert.equal((await validRepository.transitionAuthority({
      profileId: validBinding.profileId,
      expectedProviderRevision: "81",
      expectedGeneration: validBinding.generation,
      providerRevision: "82",
      generation: validBinding.generation,
    })).invalidated, 0);
    assert.equal(
      [...validModel.artifacts.values()].find(
        (candidate) => candidate.id === updateArtifact.artifactId
      ).invalidationCount,
      1
    );
  });

  test("subtitle Lua registry is bounded, decimal-safe, private, and ARGV-complete", () => {
    const names = Object.keys(SCRIPT_DEFINITIONS).filter((name) => name.startsWith("subtitle"));
    assert.deepEqual(names.sort(), [
      "subtitleAbortUpload", "subtitleAuthorize", "subtitleBeginFetch",
      "subtitleBeginFetchPeek", "subtitleBeginUpload", "subtitleBeginUploadPeek",
      "subtitleCancelReservation", "subtitleClaimDeletion",
      "subtitleCommit", "subtitleConfirmDeletion", "subtitleGetAuthority",
      "subtitleInvalidate", "subtitlePrune", "subtitleReconcileAuthority",
      "subtitleRecordDeletionAbsence", "subtitleReleaseFetch", "subtitleReleaseLease",
      "subtitleReserve", "subtitleRetryDeletion", "subtitleRevalidate",
      "subtitleStageUpload", "subtitleUpdateAuthority",
    ].sort());
    const expectedArgv = {
      subtitleUpdateAuthority: 7,
      subtitleGetAuthority: 1,
      subtitleReconcileAuthority: 5,
      subtitleReserve: 26,
      subtitleCancelReservation: 12,
      subtitleBeginFetchPeek: 11,
      subtitleBeginFetch: 16,
      subtitleReleaseFetch: 3,
      subtitleStageUpload: 31,
      subtitleBeginUploadPeek: 11,
      subtitleBeginUpload: 20,
      subtitleAbortUpload: 3,
      subtitleCommit: 23,
      subtitleAuthorize: 18,
      subtitleRevalidate: 13,
      subtitleReleaseLease: 4,
      subtitleInvalidate: 5,
      subtitleClaimDeletion: 5,
      subtitleRecordDeletionAbsence: 4,
      subtitleRetryDeletion: 4,
      subtitleConfirmDeletion: 4,
      subtitlePrune: 4,
    };
    for (const name of names) {
      const source = SCRIPT_DEFINITIONS[name].source;
      assert.match(source, /redis\.call\("TIME"\)/, name);
      assert.match(source, /subtitle_decimal_(?:add|subtract)/, name);
      assert.doesNotMatch(source, /redis\.call\(["']SCAN["']/i, name);
      assert.doesNotMatch(source, /SMEMBERS|ZPOP|EVICT|providerUrl|requestHeaders/i, name);
      const references = [...source.matchAll(/ARGV\[(\d+)\]/g)].map((match) => Number(match[1]));
      assert.equal(Math.max(...references), expectedArgv[name], name + " ARGV contract");
    }
    assert.match(SCRIPT_DEFINITIONS.subtitleBeginUpload.source, /uploadTokenHash/);
    assert.match(SCRIPT_DEFINITIONS.subtitleBeginFetch.source, /fetchTokenHash/);
    assert.match(SCRIPT_DEFINITIONS.subtitleReleaseFetch.source, /fetchFencedTokenHash/);
    assert.match(SCRIPT_DEFINITIONS.subtitleStageUpload.source, /partMetadataVersion/);
    assert.match(SCRIPT_DEFINITIONS.subtitleStageUpload.source, /uploadExpiries/);
    assert.match(SCRIPT_DEFINITIONS.subtitleReserve.source, /sourceCapabilityDigest/);
    assert.match(SCRIPT_DEFINITIONS.subtitleReserve.source, /duplicate_challenge/);
    assert.match(SCRIPT_DEFINITIONS.subtitleCommit.source, /uploadTokenHash/);
    assert.match(SCRIPT_DEFINITIONS.subtitlePrune.source, /deletionClaims/);
    assert.match(SCRIPT_DEFINITIONS.subtitlePrune.source, /uploadExpiries/);
    assert.match(SCRIPT_DEFINITIONS.subtitlePrune.source, /leaseExpiries/);
    assert.doesNotMatch(SCRIPT_DEFINITIONS.subtitlePrune.source, /ZCARD.*, globalKeys\.uploadExpiries/);
    assert.match(SCRIPT_DEFINITIONS.subtitlePrune.source, /ZCOUNT.*, globalKeys\.uploadExpiries/);
    assert.match(SCRIPT_DEFINITIONS.subtitleBeginUpload.source, /uploadSettlesAtMs/);
    assert.match(SCRIPT_DEFINITIONS.subtitleConfirmDeletion.source, /second_claimed/);
    assert.match(SCRIPT_DEFINITIONS.subtitleRecordDeletionAbsence.source, /second_pending/);
    assert.match(SCRIPT_DEFINITIONS.subtitleReserve.source, /if #result > 128 then return nil end/);
    for (const name of ["subtitleReconcileAuthority", "subtitleUpdateAuthority"]) {
      const source = SCRIPT_DEFINITIONS[name].source;
      const body = source.slice(source.lastIndexOf("-- jg-script:"));
      assert.match(body, /subtitle_authority_artifacts_preflight\(/, name);
      assert.match(body, /subtitle_restore_authority_artifact\(/, name);
      assert.match(body, /error\("subtitle authority invalidation invariant"\)/, name);
      assert.ok(
        body.indexOf("subtitle_authority_artifacts_preflight(") <
          body.indexOf('redis.call("HSET", globalKeys.authorities'),
        name + " must preflight before authority publication"
      );
      assert.doesNotMatch(body, /if subtitle_mark_deleting\([^\n]+then invalidated/);
    }
  });
}

function nextPrefix() {
  prefixSequence += 1;
  const random = BigInt("0x" + crypto.randomBytes(16).toString("hex"));
  return "jg:v" + String(random + BigInt(prefixSequence) + 1n);
}

async function cleanPrefix(client, prefix) {
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, { MATCH: prefix + ":*", COUNT: 100 });
    cursor = String(reply.cursor);
    if (reply.keys.length > 0) await client.del(reply.keys);
  } while (cursor !== "0");
}

async function withRedis(t, callback) {
  const prefix = nextPrefix();
  const client = createClient({ url: REDIS_URL });
  client.on("error", () => {});
  await client.connect();
  t.after(async () => {
    try {
      await cleanPrefix(client, prefix);
    } finally {
      if (client.isOpen) await client.quit();
    }
  });
  return callback({ client, keyspace: new RedisKeyspace(prefix), prefix });
}

function playbackContext(url, mediaId) {
  return {
    contentKey: hashOpaqueValue("movie:" + mediaId),
    canonicalIdentity: {
      provider: "imdb",
      id: mediaId,
      mediaType: "movie",
      season: null,
      episode: null,
      provenance: "metadata-request",
      confidence: "canonical",
    },
    traktEligible: true,
    request: { type: "movie", metaId: mediaId, videoId: mediaId },
    source: { type: "url", provider: "subtitle-integration" },
    fingerprints: [fingerprintExactUrl(url)],
  };
}

function playbackClaimAuthority(profileId, deviceId, request) {
  const requestDigest = crypto.createHash("sha256")
    .update(JSON.stringify(request), "utf8")
    .digest("hex");
  const sessionId = "session_" + crypto.createHash("sha256")
    .update(profileId + "\0" + deviceId + "\0" + requestDigest, "utf8")
    .digest("hex")
    .slice(0, 32);
  return { requestDigest, sessionId };
}

async function activeBinding(client, keyspace, options = {}) {
  let sequence = 0;
  activeSequence += 1;
  const scope = String(activeSequence).padStart(4, "0");
  const playback = new RedisPlaybackContextRepository({
    client,
    keyspace,
    envelopeCrypto: envelopeCrypto(100 + activeSequence),
    writeVersion: "4",
    idFactory: (kind) => kind + "_subtitle_" + scope + "_" + String(++sequence).padStart(8, "0"),
    ttlMs: options.playbackTtlMs ?? 5 * 60 * 1000,
  });
  const profileId = options.profileId || "profile_subtitle_real_" + scope;
  const deviceId = options.deviceId || "device_subtitle_real_" + scope;
  const mediaId = options.mediaId || "tt" + String(1000000 + activeSequence);
  const url = options.url || "https://media.example/" + scope + ".mkv?token=playback-secret";
  const providerRevision = options.providerRevision || "7";
  const context = await playback.record(
    profileId,
    playbackContext(url, mediaId),
    { providerRevision }
  );
  const launchedAt = await playback._scripts.timeMs();
  const request = {
    attemptId: crypto.randomUUID(),
    fingerprints: context.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt,
  };
  const claim = await playback.claim(
    profileId,
    deviceId,
    request,
    playbackClaimAuthority(profileId, deviceId, request)
  );
  assert.equal(claim.status, "claimed");
  const active = await playback.getActiveClaim(profileId, deviceId, claim.sessionId);
  assert.ok(active);
  assert.deepEqual(active.deliveryBinding, {
    profileId,
    deviceId,
    sessionId: claim.sessionId,
    generation: await playback.getProfileGeneration(profileId),
    contextId: context.contextId,
    contextRevision: "1",
    providerRevision,
  });
  return {
    playback,
    binding: active.deliveryBinding,
  };
}

async function replaceActiveBinding(playback, binding, providerRevision) {
  replacementSequence += 1;
  const suffix = String(replacementSequence).padStart(4, "0");
  const previous = await playback.getActiveClaim(
    binding.profileId,
    binding.deviceId,
    binding.sessionId
  );
  assert.ok(previous);
  const url = "https://media.example/replacement-" + suffix + ".mkv?token=private";
  const context = await playback.record(
    binding.profileId,
    playbackContext(url, "tt" + String(3000000 + replacementSequence)),
    {
      generation: binding.generation,
      providerRevision,
    }
  );
  const request = {
    attemptId: crypto.randomUUID(),
    fingerprints: context.fingerprints,
    intentUrlHash: hashOpaqueValue(url),
    launchedAt: Math.max(
      await playback._scripts.timeMs(),
      Date.parse(previous.claimedAt) + 1
    ),
  };
  const claim = await playback.claim(
    binding.profileId,
    binding.deviceId,
    request,
    playbackClaimAuthority(binding.profileId, binding.deviceId, request)
  );
  const active = await playback.getActiveClaim(binding.profileId, binding.deviceId, claim.sessionId);
  assert.ok(active);
  assert.equal(active.deliveryBinding.providerRevision, providerRevision);
  return active.deliveryBinding;
}

function deliveryRepository(client, keyspace, options = {}) {
  let sequence = 0;
  deliverySequence += 1;
  const scope = String(deliverySequence).padStart(4, "0");
  return new RedisSubtitleDeliveryRepository({
    client,
    keyspace,
    tokenService: tokenService(options.tokenSeed || 20),
    envelopeCrypto: envelopeCrypto(options.envelopeSeed || 60),
    objectKeyFactory: options.objectKeyFactory || objectKeyFactory(),
    uploadLeaseTtlMs: options.uploadLeaseTtlMs ?? 30 * 1000,
    maxPutLifetimeMs: options.maxPutLifetimeMs ?? 30 * 1000,
    uploadSettlementGraceMs: options.uploadSettlementGraceMs ?? 10 * 1000,
    idFactory: () =>
      "artifact_subtitle_real_" + scope + "_" + String(++sequence).padStart(8, "0"),
    ...options,
  });
}

async function initializeAuthority(repository, binding) {
  return repository.updateAuthority({
    profileId: binding.profileId,
    expectedProviderRevision: null,
    expectedGeneration: null,
    providerRevision: binding.providerRevision,
    generation: binding.generation,
  });
}

async function beginAndStage(repository, binding, artifactId, parts, options = {}) {
  const fetch = await repository.beginFetch({
    artifactId,
    ...binding,
    ...(options.fetchToken === undefined ? {} : { fetchToken: options.fetchToken }),
  });
  assert.ok(fetch);
  const upload = await repository.stageUpload({
    artifactId,
    ...binding,
    fetchToken: fetch.fetchToken,
    parts,
    ...(options.uploadToken === undefined ? {} : { uploadToken: options.uploadToken }),
  });
  assert.ok(upload);
  return { ...upload, fetch };
}

async function rawPrefixText(client, prefix) {
  const values = [];
  let cursor = "0";
  do {
    const reply = await client.scan(cursor, { MATCH: prefix + ":*", COUNT: 100 });
    cursor = String(reply.cursor);
    for (const key of reply.keys) {
      const type = await client.type(key);
      if (type === "string") values.push(await client.get(key));
      if (type === "hash") values.push(await client.hGetAll(key));
      if (type === "zset") values.push(await client.zRangeWithScores(key, 0, -1));
    }
  } while (cursor !== "0");
  return JSON.stringify(values);
}

async function redisNowMs(repository) {
  return Number(await repository._scripts.timeMs());
}

async function forceArtifactExpiry(client, repository, artifactId) {
  const due = (await redisNowMs(repository)) - 1;
  const key = repository._artifact(artifactId).keys[0];
  await client.hSet(key, "expiresAtMs", String(due));
  await client.zAdd(repository._global[1], { score: due, value: key });
}

async function forceUploadExpiry(client, repository, artifactId) {
  const due = (await redisNowMs(repository)) - 1;
  const key = repository._artifact(artifactId).keys[0];
  await client.hSet(key, "uploadExpiresAtMs", String(due));
  await client.zAdd(repository._global[6], { score: due, value: key });
}

async function forceFetchExpiry(client, repository, artifactId) {
  const due = (await redisNowMs(repository)) - 1;
  const key = repository._artifact(artifactId).keys[0];
  await client.hSet(key, "fetchExpiresAtMs", String(due));
  await client.zAdd(repository._global[6], { score: due, value: key });
}

async function forceDeletionDue(client, repository, artifactId) {
  const due = (await redisNowMs(repository)) - 1;
  const key = repository._artifact(artifactId).keys[0];
  const state = await client.hGetAll(key);
  const updates = { deletionDueAtMs: String(due) };
  if (state.uploadState === "aborted" || state.uploadState === "complete") {
    updates.uploadSettlesAtMs = String(due);
  }
  await client.hSet(key, updates);
  await client.zAdd(repository._global[2], { score: due, value: key });
}

async function forceDeletionClaimExpiry(client, repository, artifactId) {
  const due = (await redisNowMs(repository)) - 1;
  const key = repository._artifact(artifactId).keys[0];
  await client.hSet(key, "deletionLeaseExpiresAtMs", String(due));
  await client.zAdd(repository._global[3], { score: due, value: key });
}

async function forceArtifactLeaseExpiry(client, repository, artifactId) {
  const due = (await redisNowMs(repository)) - 1;
  const artifact = repository._artifact(artifactId);
  const directories = await client.hGetAll(artifact.keys[1]);
  for (const [tokenHash, raw] of Object.entries(directories)) {
    const directory = JSON.parse(raw);
    directory.expiresAtMs = String(due);
    const expired = JSON.stringify(directory);
    await client.hSet(artifact.keys[1], tokenHash, expired);
    await client.zAdd(artifact.keys[2], { score: due, value: tokenHash });
    await client.hSet(repository._global[5], directory.member, expired);
    await client.zAdd(repository._global[4], { score: due, value: directory.member });
  }
}

async function drainDeletions(client, repository, workerPrefix, maximum = 128) {
  const jobs = [];
  for (let index = 0; index < maximum; index += 1) {
    const job = await repository.claimDeletion(workerPrefix + "_" + String(index).padStart(4, "0"));
    if (!job) break;
    jobs.push(job);
    if (job.phase === "empty") {
      const confirmed = await repository.confirmDeletion(job.artifactId, job.deletionToken, true);
      assert.ok(confirmed);
      continue;
    }
    if (job.phase === "first") {
      const waiting = await repository.recordDeletionAbsence(
        job.artifactId,
        job.deletionToken,
        true
      );
      assert.ok(waiting);
      await forceDeletionDue(client, repository, job.artifactId);
      continue;
    }
    assert.equal(job.phase, "second");
    const confirmed = await repository.confirmDeletion(job.artifactId, job.deletionToken, true);
    assert.ok(confirmed);
  }
  return jobs;
}

async function snapshotRedisKeys(client, keys) {
  const snapshot = {};
  for (const key of [...new Set(keys)].sort()) {
    const type = await client.type(key);
    if (type === "none") snapshot[key] = { type };
    else if (type === "string") snapshot[key] = { type, value: await client.get(key) };
    else if (type === "hash") snapshot[key] = { type, value: await client.hGetAll(key) };
    else if (type === "zset") {
      snapshot[key] = { type, value: await client.zRangeWithScores(key, 0, -1) };
    } else {
      throw new Error("unsupported Redis snapshot key type: " + type);
    }
  }
  return snapshot;
}

async function runRedisSubtitleLiveContracts({ client, keyspace, prefix }) {
  const serverInfo = await client.info("server");
  const version = /^redis_version:([^\r\n]+)/m.exec(serverInfo);
  assert.ok(version, "Redis server version is available");
  assert.ok(
    [7, 8].includes(Number(version[1].split(".")[0])),
    "subtitle live races require Redis 7 or 8"
  );

  const serviceLive = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_service",
    deviceId: "device_subtitle_live_service",
    providerRevision: "1",
  });
  const serviceTokens = tokenService(219);
  const serviceKeys = objectKeyFactory();
  const serviceRepository = deliveryRepository(client, keyspace, {
    tokenService: serviceTokens,
    objectKeyFactory: serviceKeys,
  });
  await initializeAuthority(serviceRepository, serviceLive.binding);
  const serviceObjectStore = new MemorySubtitleObjectStore({ objectKeyFactory: serviceKeys });
  let serviceManifestNow = Date.now();
  const serviceManifests = new MemorySubtitleManifestRepository({
    tokenService: serviceTokens,
    clock: () => serviceManifestNow,
    getProfileBinding: async () => ({ status: "active", revision: 1 }),
    isDeviceBindingActive: () => true,
    lifecycleCoordinator: new ProfileLifecycleCoordinator(),
  });
  const serviceBinding = {
    ...serviceLive.binding,
    profileRevision: 1,
    deviceGeneration: 1,
  };
  let serviceFetches = 0;
  const service = new SubtitleDeliveryService({
    repository: serviceRepository,
    manifests: serviceManifests,
    objectStore: serviceObjectStore,
    source: {
      async fetch() {
        serviceFetches += 1;
        return {
          normalized: {
            type: "text",
            format: "vtt",
            extension: ".vtt",
            mediaType: "text/vtt",
            data: Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nRedis service contract\n"),
          },
        };
      },
    },
    tokenService: serviceTokens,
  });
  const serviceReady = await service.resolve(serviceBinding, {
    discoveryKey: "live-service-contract",
    sourceCapability: sourceCapability("live-service-contract"),
  });
  assert.equal(serviceReady.status, "ready");
  const serviceReplay = await service.resolve(serviceBinding, {
    discoveryKey: "live-service-contract",
    sourceCapability: sourceCapability("live-service-contract"),
  });
  assert.equal(serviceFetches, 1);
  assert.equal(serviceReplay.artifactId, serviceReady.artifactId);
  assert.deepEqual(serviceReplay.parts, serviceReady.parts);
  assert.match(
    (await service.read(serviceBinding, serviceReady.artifactId, 1)).body.toString("utf8"),
    /Redis service contract/
  );
  await service.invalidate(serviceBinding, serviceReady.artifactId, "live_service_cleanup");
  const manifest = (await serviceManifests.listProfile(serviceBinding.profileId))[0];
  serviceManifestNow = manifest.uploadSettlementDeadline;
  const durableDeletion = new SubtitleDeletionWorker({
    repository: serviceManifests,
    objectStore: serviceObjectStore,
    workerId: "worker_live_service_durable",
    retryDelayMs: 1,
    leaseMs: 1000,
    secondPassDelayMs: 1,
  });
  assert.equal((await durableDeletion.runOnce()).status, "awaiting_second_pass");
  serviceManifestNow += 1;
  assert.equal((await durableDeletion.runOnce()).status, "confirmed");
  await forceDeletionDue(client, serviceRepository, serviceReady.artifactId);
  const serviceDeletion = new SubtitleDeletionWorker({
    repository: serviceRepository,
    objectStore: serviceObjectStore,
    workerId: "worker_live_service",
    retryDelayMs: 1,
  });
  assert.equal((await serviceDeletion.runOnce()).status, "awaiting_second_pass");
  await forceDeletionDue(client, serviceRepository, serviceReady.artifactId);
  assert.equal((await serviceDeletion.runOnce()).status, "confirmed");

  const emptyReservation = await serviceRepository.reserve({
    ...serviceLive.binding,
    discoveryKey: "live-service-empty-deletion",
    sourceCapability: sourceCapability("live-service-empty-deletion"),
  });
  const emptyQuotaBefore = await client.hGetAll(serviceRepository._global[0]);
  assert.equal(emptyQuotaBefore.artifacts, "1");
  assert.equal(
    emptyQuotaBefore.objects,
    String(DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactParts)
  );
  assert.equal(
    emptyQuotaBefore.bytes,
    String(DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactBytes)
  );
  await serviceRepository.invalidateProfile(serviceLive.binding.profileId);
  await forceDeletionDue(client, serviceRepository, emptyReservation.artifactId);
  let emptyObjectStoreCalls = 0;
  const emptyDeletion = new SubtitleDeletionWorker({
    repository: serviceRepository,
    objectStore: compatibilityObjectStore({
      async send() {
        emptyObjectStoreCalls += 1;
        throw new Error("empty deletion must not call object storage");
      },
    }),
    workerId: "worker_live_service_empty",
    retryDelayMs: 1,
  });
  assert.deepEqual(await emptyDeletion.runOnce(), {
    status: "confirmed",
    artifactId: emptyReservation.artifactId,
    phase: "empty",
    released: {
      artifacts: 1,
      objects: DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactParts,
      bytes: DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactBytes,
    },
  });
  assert.equal(await emptyDeletion.runOnce(), null);
  assert.equal(emptyObjectStoreCalls, 0);
  assert.equal(
    await client.exists(serviceRepository._artifact(emptyReservation.artifactId).keys[0]),
    0
  );
  const emptyQuotaAfter = await client.hGetAll(serviceRepository._global[0]);
  assert.equal(emptyQuotaAfter.artifacts, "0");
  assert.equal(emptyQuotaAfter.objects, "0");
  assert.equal(emptyQuotaAfter.bytes, "0");

  const authorityCollisionCases = [
    {
      name: "cross-profile artifact ID",
      operation: "reconcile",
      mutate: async ({ artifactKeys, states, wrongProfileTag }) => {
        await client.hSet(artifactKeys[0], "profileTag", wrongProfileTag);
        return async () => client.hSet(artifactKeys[0], "profileTag", states[0].profileTag);
      },
    },
    {
      name: "malformed artifact index",
      operation: "update",
      mutate: async ({ artifactKeys, profileKeys, states }) => {
        await client.hSet(artifactKeys[0], "profileArtifactsKey", profileKeys[0]);
        return async () => client.hSet(
          artifactKeys[0],
          "profileArtifactsKey",
          states[0].profileArtifactsKey
        );
      },
    },
    {
      name: "missing global index",
      operation: "reconcile",
      mutate: async ({ artifactKeys, repository: collisionRepository }) => {
        const score = await client.zScore(collisionRepository._global[1], artifactKeys[0]);
        assert.notEqual(score, null);
        await client.zRem(collisionRepository._global[1], artifactKeys[0]);
        return async () => client.zAdd(collisionRepository._global[1], {
          score: Number(score),
          value: artifactKeys[0],
        });
      },
    },
    {
      name: "missing artifact object state",
      operation: "update",
      mutate: async ({ artifactKeys, states }) => {
        await client.del(artifactKeys[0]);
        return async () => client.hSet(artifactKeys[0], states[0]);
      },
    },
    {
      name: "invalid state transition",
      operation: "reconcile",
      mutate: async ({ artifactKeys, states }) => {
        await client.hSet(artifactKeys[0], "state", "deletion_claimed");
        return async () => client.hSet(artifactKeys[0], "state", states[0].state);
      },
    },
    {
      name: "colliding discovery index",
      operation: "update",
      mutate: async ({ artifactKeys, profileKeys, states }) => {
        await client.hSet(profileKeys[2], states[1].discoveryRef, artifactKeys[0]);
        return async () => client.hSet(profileKeys[2], states[1].discoveryRef, artifactKeys[1]);
      },
    },
    {
      name: "late invalid multi-artifact member",
      operation: "reconcile",
      mutate: async ({ artifactKeys, states }) => {
        await client.hSet(artifactKeys[2], "uploadState", "complete");
        return async () => client.hSet(artifactKeys[2], "uploadState", states[2].uploadState);
      },
    },
  ];

  for (let caseIndex = 0; caseIndex < authorityCollisionCases.length; caseIndex += 1) {
    const collisionCase = authorityCollisionCases[caseIndex];
    const live = await activeBinding(client, keyspace, {
      profileId: "profile_subtitle_live_authority_collision_" + String(caseIndex),
      deviceId: "device_subtitle_live_authority_collision_" + String(caseIndex),
      providerRevision: String(100 + caseIndex * 10),
    });
    const collisionRepository = deliveryRepository(client, keyspace, {
      tokenSeed: 230 + caseIndex,
      envelopeSeed: 230 + caseIndex,
    });
    await initializeAuthority(collisionRepository, live.binding);
    const artifacts = [];
    for (let artifactIndex = 0; artifactIndex < 3; artifactIndex += 1) {
      artifacts.push(await collisionRepository.reserve({
        ...live.binding,
        discoveryKey: "authority-collision-" + String(caseIndex) + "-" + String(artifactIndex),
        sourceCapability: sourceCapability(
          "authority-collision-" + String(caseIndex) + "-" + String(artifactIndex)
        ),
      }));
    }
    const profileKeys = collisionRepository._profileKeys(live.binding.profileId);
    const artifactKeys = artifacts.map(
      (artifact) => collisionRepository._artifact(artifact.artifactId).keys[0]
    );
    const initialStates = await Promise.all(artifactKeys.map((key) => client.hGetAll(key)));
    const orderedBase = Math.min(...initialStates.map((state) => Number(state.expiresAtMs))) - 10;
    for (let artifactIndex = 0; artifactIndex < artifactKeys.length; artifactIndex += 1) {
      const score = orderedBase + artifactIndex;
      await client.hSet(artifactKeys[artifactIndex], "expiresAtMs", String(score));
      await client.zAdd(profileKeys[1], { score, value: artifactKeys[artifactIndex] });
      await client.zAdd(collisionRepository._global[1], {
        score,
        value: artifactKeys[artifactIndex],
      });
    }
    assert.deepEqual(await client.zRange(profileKeys[1], 0, -1), artifactKeys);
    const states = await Promise.all(artifactKeys.map((key) => client.hGetAll(key)));
    const profileTag = keyspace.member("playback-profile", live.binding.profileId);
    const restore = await collisionCase.mutate({
      artifactKeys,
      profileKeys,
      states,
      profileTag,
      wrongProfileTag: keyspace.member("playback-profile", live.binding.profileId + "_wrong"),
      repository: collisionRepository,
    });
    const snapshotKeys = [...collisionRepository._global, ...profileKeys, ...artifactKeys];
    const before = await snapshotRedisKeys(client, snapshotKeys);
    const nextProviderRevision = String(Number(live.binding.providerRevision) + 1);
    const corruptUnchangedRequest = collisionCase.operation === "update"
      ? collisionRepository.transitionAuthority({
          profileId: live.binding.profileId,
          expectedProviderRevision: live.binding.providerRevision,
          expectedGeneration: live.binding.generation,
          providerRevision: live.binding.providerRevision,
          generation: live.binding.generation,
        })
      : collisionRepository.reconcileAuthority({
          profileId: live.binding.profileId,
          providerRevision: live.binding.providerRevision,
          generation: live.binding.generation,
        });
    await assert.rejects(
      corruptUnchangedRequest,
      (error) => error.code === "subtitle_state_collision",
      collisionCase.name + " unchanged preflight"
    );
    assert.deepEqual(
      await snapshotRedisKeys(client, snapshotKeys),
      before,
      collisionCase.name + " unchanged request mutated Redis state"
    );
    const authorityRequest = collisionCase.operation === "update"
      ? collisionRepository.transitionAuthority({
          profileId: live.binding.profileId,
          expectedProviderRevision: live.binding.providerRevision,
          expectedGeneration: live.binding.generation,
          providerRevision: nextProviderRevision,
          generation: live.binding.generation,
        })
      : collisionRepository.reconcileAuthority({
          profileId: live.binding.profileId,
          providerRevision: nextProviderRevision,
          generation: live.binding.generation,
        });
    await assert.rejects(
      authorityRequest,
      (error) => error.code === "subtitle_state_collision",
      collisionCase.name
    );
    assert.deepEqual(
      await snapshotRedisKeys(client, snapshotKeys),
      before,
      collisionCase.name + " mutated Redis state"
    );
    assert.equal(
      (await collisionRepository.getAuthority(live.binding.profileId)).providerRevision,
      live.binding.providerRevision
    );

    await restore();
    const validUnchanged = collisionCase.operation === "update"
      ? await collisionRepository.transitionAuthority({
          profileId: live.binding.profileId,
          expectedProviderRevision: live.binding.providerRevision,
          expectedGeneration: live.binding.generation,
          providerRevision: live.binding.providerRevision,
          generation: live.binding.generation,
        })
      : await collisionRepository.reconcileAuthority({
          profileId: live.binding.profileId,
          providerRevision: live.binding.providerRevision,
          generation: live.binding.generation,
        });
    assert.equal(validUnchanged.status, "unchanged", collisionCase.name);
    assert.equal(validUnchanged.invalidated, 0, collisionCase.name);
    for (const key of artifactKeys) assert.equal((await client.hGetAll(key)).state, "reserved");
    let waitingUpload = null;
    if (caseIndex === 0) {
      waitingUpload = await beginAndStage(
        collisionRepository,
        live.binding,
        artifacts[1].artifactId,
        [textPart("d", 31)]
      );
      const committedUpload = await beginAndStage(
        collisionRepository,
        live.binding,
        artifacts[2].artifactId,
        [textPart("e", 41)]
      );
      await collisionRepository.commit({
        artifactId: artifacts[2].artifactId,
        ...live.binding,
        uploadToken: committedUpload.uploadToken,
        receipts: uploadReceipts(committedUpload),
      });
    }
    const valid = collisionCase.operation === "update"
      ? await collisionRepository.transitionAuthority({
          profileId: live.binding.profileId,
          expectedProviderRevision: live.binding.providerRevision,
          expectedGeneration: live.binding.generation,
          providerRevision: nextProviderRevision,
          generation: live.binding.generation,
        })
      : await collisionRepository.reconcileAuthority({
          profileId: live.binding.profileId,
          providerRevision: nextProviderRevision,
          generation: live.binding.generation,
        });
    assert.equal(valid.invalidated, artifactKeys.length, collisionCase.name);
    const unchanged = collisionCase.operation === "update"
      ? await collisionRepository.transitionAuthority({
          profileId: live.binding.profileId,
          expectedProviderRevision: live.binding.providerRevision,
          expectedGeneration: live.binding.generation,
          providerRevision: nextProviderRevision,
          generation: live.binding.generation,
        })
      : await collisionRepository.reconcileAuthority({
          profileId: live.binding.profileId,
          providerRevision: nextProviderRevision,
          generation: live.binding.generation,
        });
    assert.equal(unchanged.status, "unchanged", collisionCase.name);
    assert.equal(unchanged.invalidated, 0, collisionCase.name);
    for (let artifactIndex = 0; artifactIndex < artifactKeys.length; artifactIndex += 1) {
      const key = artifactKeys[artifactIndex];
      const state = await client.hGetAll(key);
      const waitingForUpload = caseIndex === 0 && artifactIndex === 1;
      assert.equal(state.state, waitingForUpload ? "uploading" : "deleting", collisionCase.name);
      assert.equal(
        state.deletionPhase,
        waitingForUpload
          ? "waiting_upload"
          : (caseIndex === 0 && artifactIndex === 2 ? "first_pending" : "empty_pending"),
        collisionCase.name
      );
      assert.equal(state.deletionRequested, "1", collisionCase.name);
      assert.equal(await client.zScore(profileKeys[1], key), null, collisionCase.name);
      assert.equal(await client.zScore(collisionRepository._global[1], key), null, collisionCase.name);
      if (waitingForUpload) {
        assert.equal(await client.zScore(collisionRepository._global[2], key), null);
        assert.notEqual(await client.zScore(collisionRepository._global[6], key), null);
      } else {
        assert.notEqual(await client.zScore(collisionRepository._global[2], key), null);
      }
      assert.equal(await client.hGet(profileKeys[2], states[artifactIndex].discoveryRef), null);
    }
    if (waitingUpload) {
      const aborted = await collisionRepository.abortUpload(
        artifacts[1].artifactId,
        waitingUpload.uploadToken
      );
      assert.deepEqual(
        aborted.parts.map((part) => part.objectKey),
        waitingUpload.parts.map((part) => part.objectKey)
      );
    }
    await Promise.all(artifacts.map((artifact) =>
      forceDeletionDue(client, collisionRepository, artifact.artifactId)
    ));
    const jobs = await drainDeletions(
      client,
      collisionRepository,
      "worker_authority_collision_" + String(caseIndex)
    );
    assert.equal(
      jobs.filter((job) => job.phase === "second").length,
      caseIndex === 0 ? artifactKeys.length - 1 : 0
    );
    for (const key of artifactKeys) assert.equal(await client.exists(key), 0);
  }

  const lifecycle = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_lifecycle",
    deviceId: "device_subtitle_live_lifecycle",
  });
  const repository = deliveryRepository(client, keyspace, { tokenSeed: 30, envelopeSeed: 70 });
  await initializeAuthority(repository, lifecycle.binding);
  const reservation = {
    ...lifecycle.binding,
    discoveryKey: "live-duplicate-discovery",
    sourceCapability: sourceCapability("live-race"),
  };
  const discovered = await Promise.all(Array.from({ length: 12 }, () => repository.reserve(reservation)));
  assert.equal(discovered.filter((result) => !result.duplicate).length, 1);
  assert.equal(new Set(discovered.map((result) => result.artifactId)).size, 1);
  const artifactId = discovered[0].artifactId;
  const redisText = await rawPrefixText(client, prefix);
  assert.equal(redisText.includes("provider.example"), false);
  assert.equal(redisText.includes("provider-secret"), false);
  const discoveredState = await client.hGetAll(repository._artifact(artifactId).keys[0]);
  assert.match(discoveredState.sourceCapabilityDigest, /^[a-f0-9]{64}$/);

  const authenticatedRequest = {
    ...lifecycle.binding,
    discoveryKey: "live-authenticated-duplicate",
    sourceCapability: sourceCapability("live-authenticated-duplicate"),
  };
  const authenticatedOriginal = await repository.reserve(authenticatedRequest);
  const authenticatedKey = repository._artifact(authenticatedOriginal.artifactId).keys[0];
  const authenticatedTokenHash = await client.hGet(authenticatedKey, "reservationTokenHash");
  assert.equal(await repository.reserve({
    ...authenticatedRequest,
    sourceCapability: {
      ...authenticatedRequest.sourceCapability,
      url: "https://provider.example/live-changed-url?token=changed",
    },
  }), null);
  assert.equal(await client.hGet(authenticatedKey, "reservationTokenHash"), authenticatedTokenHash);
  assert.equal(await repository.reserve({
    ...authenticatedRequest,
    sourceCapability: {
      ...authenticatedRequest.sourceCapability,
      headers: {
        ...authenticatedRequest.sourceCapability.headers,
        "X-Source": "live-changed-header",
      },
    },
  }), null);
  assert.equal(await client.hGet(authenticatedKey, "reservationTokenHash"), authenticatedTokenHash);
  assert.equal(await repository.reserve({
    ...authenticatedRequest,
    sessionId: "session_subtitle_live_wrong_owner",
  }), null);
  assert.equal(await repository.cancelReservation(
    authenticatedOriginal.artifactId,
    { ...lifecycle.binding, sessionId: "session_subtitle_live_wrong_owner" },
    authenticatedOriginal.reservationToken
  ), null);
  assert.equal(await client.hGet(authenticatedKey, "reservationTokenHash"), authenticatedTokenHash);
  const authenticatedReplacement = await repository.reserve(authenticatedRequest);
  assert.equal(authenticatedReplacement.duplicate, true);
  assert.equal(await repository.cancelReservation(
    authenticatedOriginal.artifactId,
    lifecycle.binding,
    authenticatedOriginal.reservationToken
  ), null);
  assert.ok(await repository.cancelReservation(
    authenticatedOriginal.artifactId,
    lifecycle.binding,
    authenticatedReplacement.reservationToken
  ));

  const transplantSource = sourceCapability("live-digest-transplant");
  const transplantARequest = {
    ...lifecycle.binding,
    discoveryKey: "live-digest-transplant-a",
    sourceCapability: transplantSource,
  };
  const transplantBRequest = {
    ...lifecycle.binding,
    discoveryKey: "live-digest-transplant-b",
    sourceCapability: transplantSource,
  };
  const transplantA = await repository.reserve(transplantARequest);
  const transplantB = await repository.reserve(transplantBRequest);
  const transplantAKey = repository._artifact(transplantA.artifactId).keys[0];
  const transplantBKey = repository._artifact(transplantB.artifactId).keys[0];
  const transplantADigest = await client.hGet(transplantAKey, "sourceCapabilityDigest");
  const transplantBDigest = await client.hGet(transplantBKey, "sourceCapabilityDigest");
  assert.notEqual(transplantADigest, transplantBDigest);
  const transplantBTokenHash = await client.hGet(transplantBKey, "reservationTokenHash");
  await client.hSet(transplantBKey, "sourceCapabilityDigest", transplantADigest);
  assert.equal(await repository.reserve(transplantBRequest), null);
  assert.equal(await client.hGet(transplantBKey, "reservationTokenHash"), transplantBTokenHash);
  assert.ok(await repository.cancelReservation(
    transplantB.artifactId,
    lifecycle.binding,
    transplantB.reservationToken
  ));
  assert.ok(await repository.cancelReservation(
    transplantA.artifactId,
    lifecycle.binding,
    transplantA.reservationToken
  ));

  const duplicateTamperRequest = {
    ...lifecycle.binding,
    discoveryKey: "live-duplicate-envelope-tamper",
    sourceCapability: sourceCapability("live-duplicate-envelope-tamper"),
  };
  const duplicateTamper = await repository.reserve(duplicateTamperRequest);
  const duplicateTamperKey = repository._artifact(duplicateTamper.artifactId).keys[0];
  const duplicateTamperTokenHash = await client.hGet(
    duplicateTamperKey,
    "reservationTokenHash"
  );
  await client.hSet(
    duplicateTamperKey,
    "sourceEnvelope",
    mutateCiphertext(await client.hGet(duplicateTamperKey, "sourceEnvelope"))
  );
  await assert.rejects(
    repository.reserve(duplicateTamperRequest),
    /envelope authentication failed/
  );
  assert.equal(
    await client.hGet(duplicateTamperKey, "reservationTokenHash"),
    duplicateTamperTokenHash
  );
  assert.ok(await repository.cancelReservation(
    duplicateTamper.artifactId,
    lifecycle.binding,
    duplicateTamper.reservationToken
  ));

  const fetchAttempts = await Promise.allSettled(
    Array.from({ length: 6 }, () => repository.beginFetch({
      artifactId,
      ...lifecycle.binding,
    }))
  );
  const winners = fetchAttempts.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  for (const result of fetchAttempts.filter((candidate) => candidate.status === "rejected")) {
    assert.equal(result.reason.code, "subtitle_fetch_busy");
  }
  const fetch = winners[0].value;
  assert.equal(fetch.schemaVersion, 3);
  assert.deepEqual(fetch.sourceCapability, {
    v: 1,
    url: reservation.sourceCapability.url,
    headers: { authorization: "Bearer provider-secret-live-race", "x-source": "live-race" },
  });
  const fetchReplay = await repository.beginFetch({
    artifactId,
    ...lifecycle.binding,
    fetchToken: fetch.fetchToken,
  });
  assert.equal(fetchReplay.replay, true);
  assert.equal(fetchReplay.fetchFence, fetch.fetchFence);
  await assert.rejects(
    repository.stageUpload({
      artifactId,
      ...lifecycle.binding,
      fetchToken: fetch.fetchToken,
      parts: [{ ...textPart("a", 111), unexpected: true }],
    }),
    /unsupported field/
  );
  const stagedParts = vobSubParts(111, 222);
  const upload = await repository.stageUpload({
    artifactId,
    ...lifecycle.binding,
    fetchToken: fetch.fetchToken,
    parts: stagedParts,
  });
  assert.equal(new Set(upload.parts.map((part) => part.objectKey)).size, 2);
  assert.ok(upload.parts.every((part) => objectKeyFactory().assert(part.objectKey) === part.objectKey));
  assert.equal(upload.schemaVersion, 3);
  assert.equal(upload.partMetadataVersion, 1);
  assert.deepEqual(
    upload.parts.map(({ objectKey: _objectKey, ...part }) => part),
    stagedParts
  );
  const stagedState = await client.hGetAll(repository._artifact(artifactId).keys[0]);
  assert.equal(stagedState.quotaObjects, "2");
  assert.equal(stagedState.quotaBytes, "333");
  const compatibleStore = compatibilityObjectStore();
  await Promise.all(upload.parts.map((part) => compatibleStore.delete(part.objectKey)));
  const replay = await repository.stageUpload({
    artifactId,
    ...lifecycle.binding,
    fetchToken: fetch.fetchToken,
    uploadToken: upload.uploadToken,
    parts: stagedParts,
  });
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.parts, upload.parts);
  await assert.rejects(
    repository.stageUpload({
      artifactId,
      ...lifecycle.binding,
      fetchToken: fetch.fetchToken,
      uploadToken: upload.uploadToken,
      parts: vobSubParts(112, 222),
    }),
    (error) => error.code === "subtitle_stage_conflict"
  );
  assert.equal((await client.hGetAll(repository._artifact(artifactId).keys[0])).quotaBytes, "333");

  const receipts = uploadReceipts(upload);
  const commits = await Promise.all(Array.from({ length: 4 }, () => repository.commit({
    artifactId,
    ...lifecycle.binding,
    uploadToken: upload.uploadToken,
    receipts,
  })));
  assert.ok(commits.every((result) => result.sizeBytes === 333));
  assert.equal(commits.filter((result) => result.replay).length, 3);
  await assert.rejects(
    repository.commit({
      artifactId,
      ...lifecycle.binding,
      uploadToken: upload.uploadToken,
      receipts: receipts.map((receipt, index) => index === 1
        ? { ...receipt, contentType: "application/x-invalid" }
        : receipt),
    }),
    (error) => error.code === "subtitle_commit_conflict"
  );
  assert.equal(await client.hGet(repository._artifact(artifactId).keys[0], "sourceEnvelope"), null);
  assert.match(
    await client.hGet(repository._artifact(artifactId).keys[0], "sourceCapabilityDigest"),
    /^[a-f0-9]{64}$/
  );
  assert.equal(await repository.reserve({
    ...reservation,
    sourceCapability: {
      ...reservation.sourceCapability,
      url: "https://provider.example/live-committed-change?token=changed",
    },
  }), null);
  const committedDuplicate = await repository.reserve(reservation);
  assert.equal(committedDuplicate.duplicate, true);
  assert.equal(committedDuplicate.state, "committed");
  assert.equal(committedDuplicate.reservationToken, null);
  const committedFetch = await repository.beginFetch({
    artifactId,
    ...lifecycle.binding,
  });
  assert.equal(committedFetch.status, "committed");
  assert.equal(committedFetch.artifactId, artifactId);
  assert.deepEqual(committedFetch.parts, committedDuplicate.parts);
  assert.equal(await repository.beginUpload({
    artifactId,
    ...lifecycle.binding,
    partCount: 2,
  }), null);
  assert.deepEqual(
    committedDuplicate.parts.map((part) => part.objectKey),
    upload.parts.map((part) => part.objectKey)
  );
  assert.equal(await repository.abortUpload(artifactId, upload.uploadToken), null);
  const postCommitText = await rawPrefixText(client, prefix);
  assert.equal(postCommitText.includes(upload.uploadToken), false);
  assert.equal(postCommitText.includes("provider-secret-live-race"), false);
  const lease = await repository.authorize({ artifactId, ...lifecycle.binding, method: "GET" });
  assert.ok(lease);
  assert.equal((await repository.revalidate({
    artifactId,
    ...lifecycle.binding,
    leaseToken: lease.leaseToken,
  })).method, "GET");

  const tampered = await repository.reserve({
    ...lifecycle.binding,
    discoveryKey: "live-envelope-tamper",
    sourceCapability: sourceCapability("live-tamper"),
  });
  const tamperedKey = repository._artifact(tampered.artifactId).keys[0];
  const envelope = await client.hGet(tamperedKey, "sourceEnvelope");
  await client.hSet(tamperedKey, "sourceEnvelope", mutateCiphertext(envelope));
  await assert.rejects(
    repository.beginFetch({ artifactId: tampered.artifactId, ...lifecycle.binding }),
    /envelope authentication failed/
  );
  assert.equal((await client.hGetAll(tamperedKey)).state, "reserved");
  assert.equal(await client.zScore(repository._global[6], tamperedKey), null);
  const copied = await repository.reserve({
    ...lifecycle.binding,
    discoveryKey: "live-envelope-binding",
    sourceCapability: sourceCapability("live-binding"),
  });
  const copiedKey = repository._artifact(copied.artifactId).keys[0];
  await client.hSet(copiedKey, "sourceEnvelope", envelope);
  await assert.rejects(
    repository.beginFetch({ artifactId: copied.artifactId, ...lifecycle.binding }),
    /envelope authentication failed/
  );
  assert.equal((await client.hGetAll(copiedKey)).state, "reserved");

  const fencedArtifact = await repository.reserve({
    ...lifecycle.binding,
    discoveryKey: "live-fetch-fencing",
    sourceCapability: sourceCapability("live-fetch-fencing"),
  });
  const releasedFetch = await repository.beginFetch({
    artifactId: fencedArtifact.artifactId,
    ...lifecycle.binding,
  });
  assert.equal(await repository.releaseFetch(
    fencedArtifact.artifactId,
    tokenService(211).issue("subtitle-fetch", 32).token
  ), null);
  assert.equal((await repository.releaseFetch(
    fencedArtifact.artifactId,
    releasedFetch.fetchToken
  )).state, "reserved");
  assert.equal(await repository.releaseFetch(fencedArtifact.artifactId, releasedFetch.fetchToken), null);
  await assert.rejects(
    repository.stageUpload({
      artifactId: fencedArtifact.artifactId,
      ...lifecycle.binding,
      fetchToken: releasedFetch.fetchToken,
      parts: [textPart("f", 19)],
    }),
    (error) => error.code === "subtitle_stage_conflict"
  );
  const expiringFetch = await repository.beginFetch({
    artifactId: fencedArtifact.artifactId,
    ...lifecycle.binding,
  });
  await forceFetchExpiry(client, repository, fencedArtifact.artifactId);
  assert.equal((await repository.prune()).uploads, 1);
  const fencedKey = repository._artifact(fencedArtifact.artifactId).keys[0];
  assert.equal((await client.hGetAll(fencedKey)).state, "reserved");
  assert.equal(await client.zScore(repository._global[6], fencedKey), null);
  await assert.rejects(
    repository.stageUpload({
      artifactId: fencedArtifact.artifactId,
      ...lifecycle.binding,
      fetchToken: expiringFetch.fetchToken,
      parts: [textPart("f", 19)],
    }),
    (error) => error.code === "subtitle_stage_conflict"
  );
  await assert.rejects(
    repository.beginFetch({
      artifactId: fencedArtifact.artifactId,
      ...lifecycle.binding,
      fetchToken: expiringFetch.fetchToken,
    }),
    (error) => error.code === "subtitle_fetch_conflict"
  );
  const recoveredFetch = await repository.beginFetch({
    artifactId: fencedArtifact.artifactId,
    ...lifecycle.binding,
  });
  await repository.releaseFetch(fencedArtifact.artifactId, recoveredFetch.fetchToken);
  assert.ok(await repository.cancelReservation(
    fencedArtifact.artifactId,
    lifecycle.binding,
    fencedArtifact.reservationToken
  ));

  const barrier = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_barrier",
    deviceId: "device_subtitle_live_barrier",
  });
  const barrierRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 50,
    envelopeSeed: 90,
    uploadLeaseTtlMs: 30 * 1000,
    maxPutLifetimeMs: 30 * 1000,
    uploadSettlementGraceMs: 10 * 1000,
  });
  await initializeAuthority(barrierRepository, barrier.binding);
  const barrierArtifact = await barrierRepository.reserve({
    ...barrier.binding,
    discoveryKey: "live-put-barrier",
    sourceCapability: sourceCapability("live-barrier"),
  });
  const barrierUpload = await beginAndStage(
    barrierRepository,
    barrier.binding,
    barrierArtifact.artifactId,
    [textPart("b", 23)]
  );
  const barrierKey = barrierUpload.parts[0].objectKey;
  const barrierObjects = new Map();
  const barrierStore = mappedObjectStore(barrierObjects);
  const authorityUpdate = await barrierRepository.updateAuthority({
    profileId: barrier.binding.profileId,
    expectedProviderRevision: "7",
    expectedGeneration: barrier.binding.generation,
    providerRevision: "8",
    generation: barrier.binding.generation,
  });
  assert.equal(authorityUpdate.invalidated, 1);
  barrierObjects.set(barrierKey, "after-invalidation");
  assert.deepEqual(await barrierRepository.prune(), {
    artifacts: 0,
    deletionClaims: 0,
    leases: 0,
    uploads: 0,
    hasMore: false,
  });
  assert.equal(await barrierRepository.claimDeletion("worker_live_barrier_before_put"), null);
  await forceUploadExpiry(client, barrierRepository, barrierArtifact.artifactId);
  const expiredBarrier = await barrierRepository.prune();
  assert.equal(expiredBarrier.uploads, 1);
  assert.equal(expiredBarrier.hasMore, false);
  barrierObjects.set(barrierKey, "after-expiry");
  assert.equal(await barrierRepository.claimDeletion("worker_live_barrier_still_settling"), null);
  await forceDeletionDue(client, barrierRepository, barrierArtifact.artifactId);
  const barrierJob = await barrierRepository.claimDeletion("worker_live_barrier_first_delete");
  assert.equal(barrierJob.phase, "first");
  assert.deepEqual(
    barrierJob.parts.map((part) => part.objectKey),
    barrierUpload.parts.map((part) => part.objectKey)
  );
  assert.equal(await barrierRepository.recordDeletionAbsence(
    barrierArtifact.artifactId,
    tokenService(200).issue("subtitle-deletion", 24).token,
    true
  ), null);
  await barrierStore.delete(barrierKey);
  barrierObjects.set(barrierKey, "after-first-delete");
  assert.equal(await isAbsent(barrierStore, barrierKey), false);
  await barrierStore.delete(barrierKey);
  assert.equal(await isAbsent(barrierStore, barrierKey), true);
  const secondBarrier = await barrierRepository.recordDeletionAbsence(
    barrierArtifact.artifactId,
    barrierJob.deletionToken,
    true
  );
  barrierObjects.set(barrierKey, "after-first-absence");
  const restartedBarrierRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 51,
    envelopeSeed: 91,
    uploadLeaseTtlMs: 30 * 1000,
    maxPutLifetimeMs: 30 * 1000,
    uploadSettlementGraceMs: 10 * 1000,
  });
  assert.equal(await restartedBarrierRepository.claimDeletion("worker_live_barrier_second_early"), null);
  await forceDeletionDue(client, restartedBarrierRepository, barrierArtifact.artifactId);
  const secondBarrierJob = await restartedBarrierRepository.claimDeletion(
    "worker_live_barrier_second_delete"
  );
  assert.equal(secondBarrierJob.phase, "second");
  await barrierStore.delete(barrierKey);
  assert.equal(await isAbsent(barrierStore, barrierKey), true);
  assert.ok(await restartedBarrierRepository.confirmDeletion(
    barrierArtifact.artifactId,
    secondBarrierJob.deletionToken,
    true
  ));
  assert.equal(barrierObjects.has(barrierKey), false);
  assert.equal(await barrierRepository.beginFetch({
    artifactId: barrierArtifact.artifactId,
    ...barrier.binding,
  }), null);
  const barrierCurrent = await replaceActiveBinding(barrier.playback, barrier.binding, "8");
  const explicitAbortArtifact = await barrierRepository.reserve({
    ...barrierCurrent,
    discoveryKey: "live-explicit-abort",
    sourceCapability: sourceCapability("live-explicit-abort"),
  });
  const explicitAbortUpload = await beginAndStage(
    barrierRepository,
    barrierCurrent,
    explicitAbortArtifact.artifactId,
    [textPart("a", 29)]
  );
  await barrierRepository.invalidateRelease(
    barrierCurrent.profileId,
    barrierCurrent.deviceId,
    barrierCurrent.sessionId
  );
  assert.equal(await barrierRepository.claimDeletion("worker_explicit_abort_blocked"), null);
  assert.equal(await barrierRepository.abortUpload(
    explicitAbortArtifact.artifactId,
    tokenService(210).issue("subtitle-upload", 32).token
  ), null);
  const aborted = await barrierRepository.abortUpload(
    explicitAbortArtifact.artifactId,
    explicitAbortUpload.uploadToken
  );
  assert.deepEqual(
    aborted.parts.map((part) => part.objectKey),
    explicitAbortUpload.parts.map((part) => part.objectKey)
  );
  assert.equal(await barrierRepository.claimDeletion("worker_explicit_abort_terminal_early"), null);
  await forceDeletionDue(client, barrierRepository, explicitAbortArtifact.artifactId);
  const abortedJobs = await drainDeletions(client, barrierRepository, "worker_explicit_abort_terminal");
  assert.ok(abortedJobs.some((job) => job.artifactId === explicitAbortArtifact.artifactId));

  const lost = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_lost",
    deviceId: "device_subtitle_live_lost",
  });
  const lostRepository = deliveryRepository(client, keyspace, { tokenSeed: 80, envelopeSeed: 110 });
  await initializeAuthority(lostRepository, lost.binding);
  const staleRequest = (index) => ({
    ...lost.binding,
    discoveryKey: "lost-invalidation-" + String(index),
    sourceCapability: sourceCapability("lost-" + String(index)),
  });
  const raced = await Promise.all([
    ...Array.from({ length: 8 }, (_value, index) => lostRepository.reserve(staleRequest(index))),
    lostRepository.updateAuthority({
      profileId: lost.binding.profileId,
      expectedProviderRevision: "7",
      expectedGeneration: lost.binding.generation,
      providerRevision: "8",
      generation: lost.binding.generation,
    }),
  ]);
  for (const result of raced.slice(0, -1).filter(Boolean)) {
    const state = await client.hGetAll(lostRepository._artifact(result.artifactId).keys[0]);
    assert.ok(state.state === "deleting" || state.deletionRequested === "1");
    assert.equal(await lostRepository.beginFetch({
      artifactId: result.artifactId,
      ...lost.binding,
    }), null);
  }
  await assert.rejects(
    lostRepository.updateAuthority({
      profileId: lost.binding.profileId,
      expectedProviderRevision: "7",
      expectedGeneration: lost.binding.generation,
      providerRevision: "9",
      generation: lost.binding.generation,
    }),
    (error) => error.code === "subtitle_authority_conflict"
  );
  const currentBinding = await replaceActiveBinding(lost.playback, lost.binding, "8");
  assert.ok(await lostRepository.reserve({
    ...currentBinding,
    discoveryKey: "lost-current",
    sourceCapability: sourceCapability("lost-current"),
  }));
  await drainDeletions(client, lostRepository, "worker_live_lost_stale");
  const nextLostGeneration = await lost.playback.invalidateProfile(lost.binding.profileId);
  const generationUpdate = await lostRepository.updateAuthority({
    profileId: lost.binding.profileId,
    expectedProviderRevision: "8",
    expectedGeneration: lost.binding.generation,
    providerRevision: "8",
    generation: nextLostGeneration,
  });
  assert.equal(generationUpdate.invalidated, 1);
  assert.equal(await lostRepository.reserve({
    ...currentBinding,
    discoveryKey: "lost-stale-generation",
    sourceCapability: sourceCapability("lost-stale-generation"),
  }), null);
  await drainDeletions(client, lostRepository, "worker_live_lost_generation");

  const reconciliation = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_reconciliation",
    deviceId: "device_subtitle_live_reconciliation",
    providerRevision: "50",
  });
  const reconciliationRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 101,
    envelopeSeed: 101,
  });
  assert.equal(await reconciliationRepository.getAuthority(reconciliation.binding.profileId), null);
  assert.equal((await reconciliationRepository.reconcileAuthority({
    profileId: reconciliation.binding.profileId,
    providerRevision: reconciliation.binding.providerRevision,
    generation: reconciliation.binding.generation,
  })).status, "updated");
  const reconciliationArtifact = await reconciliationRepository.reserve({
    ...reconciliation.binding,
    discoveryKey: "reconciliation-crash-artifact",
    sourceCapability: sourceCapability("reconciliation-crash-artifact"),
  });

  const maximumRevision = "9".repeat(128);
  const reconciliationOther = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_reconciliation_other",
    deviceId: "device_subtitle_live_reconciliation_other",
    providerRevision: maximumRevision,
  });
  await reconciliationRepository.reconcileAuthority({
    profileId: reconciliationOther.binding.profileId,
    providerRevision: reconciliationOther.binding.providerRevision,
    generation: reconciliationOther.binding.generation,
  });
  const reconciliationOtherArtifact = await reconciliationRepository.reserve({
    ...reconciliationOther.binding,
    discoveryKey: "reconciliation-other-artifact",
    sourceCapability: sourceCapability("reconciliation-other-artifact"),
  });

  const generationBeforeCrash = await reconciliationRepository.getAuthority(
    reconciliation.binding.profileId
  );
  const reconciledGeneration = await reconciliation.playback.invalidateProfile(
    reconciliation.binding.profileId
  );
  assert.deepEqual(
    await reconciliationRepository.getAuthority(reconciliation.binding.profileId),
    generationBeforeCrash,
    "playback generation advance silently changed subtitle authority"
  );

  const restartedReconciliationRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 102,
    envelopeSeed: 101,
  });
  const reconciliationRace = await Promise.allSettled([
    restartedReconciliationRepository.reconcileAuthority({
      profileId: reconciliation.binding.profileId,
      providerRevision: "52",
      generation: reconciledGeneration,
    }),
    restartedReconciliationRepository.reconcileAuthority({
      profileId: reconciliation.binding.profileId,
      providerRevision: "51",
      generation: reconciledGeneration,
    }),
  ]);
  for (const result of reconciliationRace.filter((entry) => entry.status === "rejected")) {
    assert.equal(result.reason.code, "subtitle_authority_stale");
  }
  assert.ok(reconciliationRace.some((entry) => entry.status === "fulfilled"));
  const recovered = await restartedReconciliationRepository.getAuthority(
    reconciliation.binding.profileId
  );
  assert.equal(recovered.providerRevision, "52");
  assert.equal(recovered.generation, reconciledGeneration);
  assert.equal((await restartedReconciliationRepository.reconcileAuthority({
    profileId: reconciliation.binding.profileId,
    providerRevision: "52",
    generation: reconciledGeneration,
  })).status, "unchanged");
  assert.equal(
    (await client.hGetAll(
      restartedReconciliationRepository._artifact(reconciliationArtifact.artifactId).keys[0]
    )).state,
    "deleting"
  );
  assert.equal(
    (await client.hGetAll(
      restartedReconciliationRepository._artifact(reconciliationOtherArtifact.artifactId).keys[0]
    )).state,
    "reserved",
    "authority reconciliation crossed profile scope"
  );
  assert.equal(
    (await restartedReconciliationRepository.getAuthority(reconciliationOther.binding.profileId))
      .providerRevision,
    maximumRevision
  );

  await assert.rejects(
    restartedReconciliationRepository.reconcileAuthority({
      profileId: reconciliation.binding.profileId,
      providerRevision: "51",
      generation: reconciledGeneration,
    }),
    (error) => error.code === "subtitle_authority_stale" && error.status === 409
  );
  await assert.rejects(
    restartedReconciliationRepository.reconcileAuthority({
      profileId: reconciliation.binding.profileId,
      providerRevision: "53",
      generation: reconciliation.binding.generation,
    }),
    (error) => error.code === "subtitle_authority_stale"
  );
  await assert.rejects(
    restartedReconciliationRepository.reconcileAuthority({
      profileId: reconciliation.binding.profileId,
      providerRevision: "1".repeat(129),
      generation: reconciledGeneration,
    }),
    /provider revision is invalid/
  );

  const authorityCasRace = await Promise.allSettled([
    restartedReconciliationRepository.transitionAuthority({
      profileId: reconciliation.binding.profileId,
      expectedProviderRevision: "52",
      expectedGeneration: reconciledGeneration,
      providerRevision: "53",
      generation: reconciledGeneration,
    }),
    restartedReconciliationRepository.transitionAuthority({
      profileId: reconciliation.binding.profileId,
      expectedProviderRevision: "52",
      expectedGeneration: reconciledGeneration,
      providerRevision: "54",
      generation: reconciledGeneration,
    }),
  ]);
  assert.equal(authorityCasRace.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(authorityCasRace.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(
    authorityCasRace.find((entry) => entry.status === "rejected").reason.code,
    "subtitle_authority_conflict"
  );
  const casWinner = await restartedReconciliationRepository.getAuthority(
    reconciliation.binding.profileId
  );
  assert.ok(casWinner.providerRevision === "53" || casWinner.providerRevision === "54");
  await assert.rejects(
    restartedReconciliationRepository.transitionAuthority({
      profileId: reconciliation.binding.profileId,
      expectedProviderRevision: casWinner.providerRevision,
      expectedGeneration: reconciledGeneration,
      providerRevision: "1",
      generation: reconciledGeneration,
    }),
    (error) => error.code === "subtitle_authority_stale"
  );
  await restartedReconciliationRepository.invalidateProfile(
    reconciliationOther.binding.profileId
  );
  await drainDeletions(client, restartedReconciliationRepository, "worker_live_reconciliation");

  const supersession = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_supersession",
    deviceId: "device_subtitle_live_supersession",
    providerRevision: "61",
  });
  const supersessionRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 103,
    envelopeSeed: 103,
  });
  await supersessionRepository.reconcileAuthority({
    profileId: supersession.binding.profileId,
    providerRevision: supersession.binding.providerRevision,
    generation: supersession.binding.generation,
  });
  const oldSessionArtifact = await supersessionRepository.reserve({
    ...supersession.binding,
    discoveryKey: "superseded-session-artifact",
    sourceCapability: sourceCapability("superseded-session-artifact"),
  });
  const oldActive = await supersession.playback.getActiveClaim(
    supersession.binding.profileId,
    supersession.binding.deviceId,
    supersession.binding.sessionId
  );
  const replacementUrl = "https://media.example/supersession-new.mkv?token=private";
  const replacementContext = await supersession.playback.record(
    supersession.binding.profileId,
    playbackContext(replacementUrl, "tt2999999"),
    {
      generation: supersession.binding.generation,
      providerRevision: supersession.binding.providerRevision,
    }
  );
  const replacementRequest = {
    attemptId: crypto.randomUUID(),
    fingerprints: replacementContext.fingerprints,
    intentUrlHash: hashOpaqueValue(replacementUrl),
    launchedAt: Math.max(
      await supersession.playback._scripts.timeMs(),
      Date.parse(oldActive.claimedAt) + 1
    ),
  };
  const replacementClaim = await supersession.playback.claim(
    supersession.binding.profileId,
    supersession.binding.deviceId,
    replacementRequest,
    playbackClaimAuthority(
      supersession.binding.profileId,
      supersession.binding.deviceId,
      replacementRequest
    )
  );
  const replacementActive = await supersession.playback.getActiveClaim(
    supersession.binding.profileId,
    supersession.binding.deviceId,
    replacementClaim.sessionId
  );
  assert.equal(replacementActive.deliveryBinding.contextId, replacementContext.contextId);
  assert.equal(replacementActive.deliveryBinding.providerRevision, "61");
  assert.equal(
    await supersession.playback.getActiveClaim(
      supersession.binding.profileId,
      supersession.binding.deviceId,
      supersession.binding.sessionId
    ),
    null
  );
  assert.equal(
    await supersessionRepository.invalidateSession(
      supersession.binding.profileId,
      supersession.binding.sessionId
    ),
    1
  );
  assert.equal(
    (await client.hGetAll(
      supersessionRepository._artifact(oldSessionArtifact.artifactId).keys[0]
    )).state,
    "deleting"
  );
  assert.ok(await supersession.playback.getActiveClaim(
    supersession.binding.profileId,
    supersession.binding.deviceId,
    replacementClaim.sessionId
  ));
  assert.equal(await supersessionRepository.beginFetch({
    artifactId: oldSessionArtifact.artifactId,
    ...supersession.binding,
  }), null);
  await drainDeletions(client, supersessionRepository, "worker_live_supersession");

  const receipt = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_receipt",
    deviceId: "device_subtitle_live_receipt",
  });
  const receiptRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 120,
    envelopeSeed: 130,
    deletionLeaseTtlMs: 30 * 1000,
    deletionScanBatchSize: 1,
  });
  await initializeAuthority(receiptRepository, receipt.binding);
  const receiptArtifact = await receiptRepository.reserve({
    ...receipt.binding,
    discoveryKey: "receipt-owner",
    sourceCapability: sourceCapability("receipt"),
  });
  await receiptRepository.invalidateProfile(receipt.binding.profileId);
  const firstReceipt = await receiptRepository.claimDeletion({
    workerId: "worker_receipt_first",
    leaseTtlMs: 30 * 1000,
  });
  assert.equal(firstReceipt.artifactId, receiptArtifact.artifactId);
  assert.equal(firstReceipt.phase, "empty");
  await forceDeletionClaimExpiry(client, receiptRepository, receiptArtifact.artifactId);
  const receiptPrune = await receiptRepository.prune();
  assert.equal(receiptPrune.deletionClaims, 1);
  const secondReceipt = await receiptRepository.claimDeletion("worker_receipt_second");
  assert.equal(secondReceipt.phase, "empty");
  assert.equal(await receiptRepository.confirmDeletion(
    receiptArtifact.artifactId,
    firstReceipt.deletionToken,
    true
  ), null);
  assert.equal(await receiptRepository.retryDeletion({
    artifactId: receiptArtifact.artifactId,
    deletionToken: firstReceipt.deletionToken,
    retryDelayMs: 10,
  }), null);
  const delayedReceipt = await receiptRepository.retryDeletion({
    artifactId: receiptArtifact.artifactId,
    deletionToken: secondReceipt.deletionToken,
    retryDelayMs: 20,
  });
  assert.equal(delayedReceipt.attempt, "3");
  await forceDeletionDue(client, receiptRepository, receiptArtifact.artifactId);
  assert.equal((await receiptRepository.prune()).hasMore, true);
  const finalReceipt = await receiptRepository.claimDeletion("worker_receipt_final");
  assert.equal(finalReceipt.artifactId, receiptArtifact.artifactId);
  assert.equal(finalReceipt.phase, "empty");
  assert.equal(await receiptRepository.confirmDeletion(
    receiptArtifact.artifactId,
    secondReceipt.deletionToken,
    true
  ), null);
  await assert.rejects(
    receiptRepository.recordDeletionAbsence(
      receiptArtifact.artifactId,
      finalReceipt.deletionToken,
      true
    ),
    (error) => error.code === "subtitle_deletion_barrier"
  );
  assert.deepEqual((await receiptRepository.confirmDeletion(
    receiptArtifact.artifactId,
    finalReceipt.deletionToken,
    true
  )).released, {
    artifacts: 1,
    objects: DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactParts,
    bytes: DEFAULT_SUBTITLE_DELIVERY_LIMITS.artifactBytes,
  });

  const crash = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_crash",
    deviceId: "device_subtitle_live_crash",
    playbackTtlMs: 5 * 60 * 1000,
  });
  const crashRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 150,
    envelopeSeed: 150,
    logicalTtlMs: 30 * 1000,
    absoluteTtlMs: 2 * 60 * 1000,
    uploadLeaseTtlMs: 30 * 1000,
    ioLeaseTtlMs: 30 * 1000,
    deletionLeaseTtlMs: 30 * 1000,
    pruneBatchSize: 1,
    deletionScanBatchSize: 1,
    leaseCleanupBatchSize: 1,
    uploadCleanupBatchSize: 1,
  });
  await initializeAuthority(crashRepository, crash.binding);
  const reserveMany = async (prefixName, count) => Promise.all(
    Array.from({ length: count }, (_value, index) => crashRepository.reserve({
      ...crash.binding,
      discoveryKey: prefixName + "-" + String(index),
      sourceCapability: sourceCapability(prefixName + "-" + String(index)),
    }))
  );
  const crashedReservations = await reserveMany("crash-reserve", 5);
  await Promise.all(crashedReservations.map((artifact) =>
    forceArtifactExpiry(client, crashRepository, artifact.artifactId)
  ));
  let prunedArtifacts = 0;
  for (let index = 0; index < 8; index += 1) {
    const result = await crashRepository.prune();
    prunedArtifacts += result.artifacts;
    if (index === 0) assert.equal(result.hasMore, true);
  }
  assert.equal(prunedArtifacts, crashedReservations.length);
  await drainDeletions(client, crashRepository, "worker_crash_reservations");

  const crashedUploads = await reserveMany("crash-upload", 3);
  for (let index = 0; index < crashedUploads.length; index += 1) {
    await beginAndStage(
      crashRepository,
      crash.binding,
      crashedUploads[index].artifactId,
      [textPart(["a", "b", "c"][index], 10 + index)]
    );
  }
  assert.equal((await crashRepository.prune()).hasMore, false);
  await Promise.all(crashedUploads.map((artifact) =>
    forceUploadExpiry(client, crashRepository, artifact.artifactId)
  ));
  let prunedUploads = 0;
  for (let index = 0; index < 5; index += 1) prunedUploads += (await crashRepository.prune()).uploads;
  assert.equal(prunedUploads, crashedUploads.length);

  const committedCrash = await crashRepository.reserve({
    ...crash.binding,
    discoveryKey: "crash-commit",
    sourceCapability: sourceCapability("crash-commit"),
  });
  const committedUpload = await beginAndStage(
    crashRepository,
    crash.binding,
    committedCrash.artifactId,
    [textPart("d", 20)]
  );
  await crashRepository.commit({
    artifactId: committedCrash.artifactId,
    ...crash.binding,
    uploadToken: committedUpload.uploadToken,
    receipts: uploadReceipts(committedUpload),
  });
  await forceArtifactExpiry(client, crashRepository, committedCrash.artifactId);
  assert.equal((await crashRepository.prune()).artifacts, 1);
  await forceDeletionDue(client, crashRepository, committedCrash.artifactId);
  await drainDeletions(client, crashRepository, "worker_crash_boundaries");

  const leaseCrashes = await reserveMany("crash-lease", 2);
  for (let index = 0; index < leaseCrashes.length; index += 1) {
    const artifact = leaseCrashes[index];
    const started = await beginAndStage(
      crashRepository,
      crash.binding,
      artifact.artifactId,
      [textPart(["d", "e"][index], 30)]
    );
    await crashRepository.commit({
      artifactId: artifact.artifactId,
      ...crash.binding,
      uploadToken: started.uploadToken,
      receipts: uploadReceipts(started),
    });
    await crashRepository.authorize({ artifactId: artifact.artifactId, ...crash.binding, method: "HEAD" });
  }
  await crashRepository.invalidateProfile(crash.binding.profileId);
  assert.equal(await crashRepository.claimDeletion("worker_lease_blocked"), null);
  await Promise.all(leaseCrashes.map((artifact) =>
    forceArtifactLeaseExpiry(client, crashRepository, artifact.artifactId)
  ));
  let expiredLeases = 0;
  for (let index = 0; index < 4; index += 1) expiredLeases += (await crashRepository.prune()).leases;
  assert.equal(expiredLeases, leaseCrashes.length);
  await Promise.all(leaseCrashes.map((artifact) =>
    forceDeletionDue(client, crashRepository, artifact.artifactId)
  ));

  const claimedCrashes = [];
  for (let index = 0; index < 3; index += 1) {
    const job = await crashRepository.claimDeletion({
      workerId: "worker_claim_crash_" + String(index),
      leaseTtlMs: 30 * 1000,
    });
    if (job) claimedCrashes.push(job);
  }
  await Promise.all(claimedCrashes.map((job) =>
    forceDeletionClaimExpiry(client, crashRepository, job.artifactId)
  ));
  let resetClaims = 0;
  for (let index = 0; index < claimedCrashes.length + 2; index += 1) {
    resetClaims += (await crashRepository.prune()).deletionClaims;
  }
  assert.equal(resetClaims, claimedCrashes.length);
  for (const oldClaim of claimedCrashes) {
    assert.equal(await crashRepository.confirmDeletion(
      oldClaim.artifactId,
      oldClaim.deletionToken,
      true
    ), null);
  }

  await repository.releaseLease(artifactId, lease.leaseToken);
  await repository.invalidateProfile(lifecycle.binding.profileId);
  await lostRepository.invalidateProfile(lost.binding.profileId);
  await forceDeletionDue(client, repository, artifactId);
  await Promise.all(crashedUploads.map((artifact) =>
    forceDeletionDue(client, crashRepository, artifact.artifactId)
  ));
  await drainDeletions(client, repository, "worker_live_lifecycle");
  await drainDeletions(client, lostRepository, "worker_live_lost");
  await drainDeletions(client, crashRepository, "worker_live_crash");
  const emptyGlobal = await client.hGetAll(repository._global[0]);
  assert.equal(emptyGlobal.artifacts, "0");
  assert.equal(emptyGlobal.objects, "0");
  assert.equal(emptyGlobal.bytes, "0");

  const overflow = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_decimal_overflow",
    deviceId: "device_subtitle_live_decimal_overflow",
  });
  const overflowRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 170,
    envelopeSeed: 170,
  });
  await initializeAuthority(overflowRepository, overflow.binding);
  const overflowArtifact = await overflowRepository.reserve({
    ...overflow.binding,
    discoveryKey: "decimal-overflow",
    sourceCapability: sourceCapability("decimal-overflow"),
  });
  const overflowProfileTag = keyspace.member("playback-profile", overflow.binding.profileId);
  const authorityBeforeOverflow = await client.hGet(overflowRepository._global[8], overflowProfileTag);
  const overflowAuthority = JSON.parse(authorityBeforeOverflow);
  overflowAuthority.revision = "9".repeat(128);
  const overflowAuthorityRaw = JSON.stringify(overflowAuthority);
  await client.hSet(overflowRepository._global[8], overflowProfileTag, overflowAuthorityRaw);
  await assert.rejects(
    overflowRepository.updateAuthority({
      profileId: overflow.binding.profileId,
      expectedProviderRevision: overflow.binding.providerRevision,
      expectedGeneration: overflow.binding.generation,
      providerRevision: "8",
      generation: overflow.binding.generation,
    }),
    (error) => error.code === "subtitle_state_collision"
  );
  assert.equal(await client.hGet(overflowRepository._global[8], overflowProfileTag), overflowAuthorityRaw);
  assert.equal(
    (await client.hGetAll(overflowRepository._artifact(overflowArtifact.artifactId).keys[0])).state,
    "reserved"
  );
  await client.hSet(overflowRepository._global[8], overflowProfileTag, authorityBeforeOverflow);
  const recoveredAuthority = await overflowRepository.updateAuthority({
    profileId: overflow.binding.profileId,
    expectedProviderRevision: overflow.binding.providerRevision,
    expectedGeneration: overflow.binding.generation,
    providerRevision: "8",
    generation: overflow.binding.generation,
  });
  assert.equal(recoveredAuthority.invalidated, 1);
  await drainDeletions(client, overflowRepository, "worker_decimal_overflow");

  const authorityCountBeforeOverflow = await client.hGet(overflowRepository._global[0], "authorities");
  const counterOverflowProfile = "profile_subtitle_live_counter_overflow";
  const counterOverflowTag = keyspace.member("playback-profile", counterOverflowProfile);
  const counterOverflowGeneration = "g1:counter_overflow";
  await client.set(
    keyspace.key("playback-profile-generation", counterOverflowProfile),
    counterOverflowGeneration
  );
  await client.hSet(overflowRepository._global[0], "authorities", "9".repeat(128));
  await assert.rejects(
    overflowRepository.updateAuthority({
      profileId: counterOverflowProfile,
      expectedProviderRevision: null,
      expectedGeneration: null,
      providerRevision: "1",
      generation: counterOverflowGeneration,
    }),
    (error) => error.code === "subtitle_state_collision"
  );
  assert.equal(await client.hGet(overflowRepository._global[8], counterOverflowTag), null);
  assert.equal(await client.hGet(overflowRepository._global[0], "authorities"), "9".repeat(128));
  await client.hSet(overflowRepository._global[0], "authorities", authorityCountBeforeOverflow);
  assert.equal((await overflowRepository.updateAuthority({
    profileId: counterOverflowProfile,
    expectedProviderRevision: null,
    expectedGeneration: null,
    providerRevision: "1",
    generation: counterOverflowGeneration,
  })).status, "updated");

  const quotaA = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_quota_a",
    deviceId: "device_subtitle_live_quota_a",
  });
  const quotaB = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_quota_b",
    deviceId: "device_subtitle_live_quota_b",
  });
  const quotaC = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_quota_c",
    deviceId: "device_subtitle_live_quota_c",
  });
  const quotaRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 180,
    envelopeSeed: 180,
    maxProfileArtifacts: 1,
    maxProfileObjects: 2,
    maxProfileBytes: 12 * 1024 * 1024,
    maxGlobalArtifacts: 2,
    maxGlobalObjects: 4,
    maxGlobalBytes: 24 * 1024 * 1024,
  });
  await initializeAuthority(quotaRepository, quotaA.binding);
  await initializeAuthority(quotaRepository, quotaB.binding);
  await initializeAuthority(quotaRepository, quotaC.binding);
  const quotaReserve = (binding, name) => quotaRepository.reserve({
    ...binding,
    discoveryKey: name,
    sourceCapability: sourceCapability(name),
  });
  const quotaArtifactA = await quotaReserve(quotaA.binding, "quota-a-1");
  const quotaArtifactAOwner = await quotaReserve(quotaA.binding, "quota-a-1");
  assert.equal(quotaArtifactAOwner.duplicate, true);
  assert.notEqual(quotaArtifactA.reservationToken, quotaArtifactAOwner.reservationToken);
  await assert.rejects(
    quotaReserve(quotaA.binding, "quota-a-2"),
    (error) => error.code === "subtitle_profile_capacity" && error.status === 429
  );
  assert.equal(
    await quotaRepository.cancelReservation(
      quotaArtifactA.artifactId,
      quotaA.binding,
      quotaArtifactA.reservationToken
    ),
    null
  );
  assert.equal(
    await quotaRepository.cancelReservation(
      quotaArtifactA.artifactId,
      quotaB.binding,
      quotaArtifactAOwner.reservationToken
    ),
    null
  );
  const quotaArtifactAKey = quotaRepository._artifact(quotaArtifactA.artifactId).keys[0];
  await client.hSet(quotaArtifactAKey, "objectKey1", "impossible-pre-upload-object");
  await assert.rejects(
    quotaRepository.cancelReservation(
      quotaArtifactA.artifactId,
      quotaA.binding,
      quotaArtifactAOwner.reservationToken
    ),
    (error) => error.code === "subtitle_state_collision"
  );
  await client.hDel(quotaArtifactAKey, "objectKey1");
  assert.deepEqual(
    await quotaRepository.cancelReservation(
      quotaArtifactA.artifactId,
      quotaA.binding,
      quotaArtifactAOwner.reservationToken
    ),
    {
      status: "canceled",
      artifactId: quotaArtifactA.artifactId,
      released: { artifacts: 1, objects: 2, bytes: 12 * 1024 * 1024 },
    }
  );
  assert.equal(await client.exists(quotaArtifactAKey), 0);
  assert.equal(
    await quotaRepository.cancelReservation(
      quotaArtifactA.artifactId,
      quotaA.binding,
      quotaArtifactAOwner.reservationToken
    ),
    null
  );
  const fetchOwnedOriginal = await quotaReserve(quotaA.binding, "quota-fetch-owner");
  const fetchOwnedReplacement = await quotaReserve(quotaA.binding, "quota-fetch-owner");
  const fetchOwned = await quotaRepository.beginFetch({
    artifactId: fetchOwnedOriginal.artifactId,
    ...quotaA.binding,
  });
  assert.equal(await quotaRepository.cancelReservation(
    fetchOwnedOriginal.artifactId,
    quotaA.binding,
    fetchOwnedOriginal.reservationToken
  ), null);
  assert.ok(await quotaRepository.cancelReservation({
    artifactId: fetchOwnedOriginal.artifactId,
    ...quotaA.binding,
    reservationToken: fetchOwnedReplacement.reservationToken,
    fetchToken: fetchOwned.fetchToken,
  }));
  const quotaArtifactA2 = await quotaReserve(quotaA.binding, "quota-a-2");
  const quotaArtifactB = await quotaReserve(quotaB.binding, "quota-b-1");
  await assert.rejects(
    quotaReserve(quotaC.binding, "quota-c-1"),
    (error) => error.code === "subtitle_global_capacity" && error.status === 503
  );
  const quotaUploadA2 = await beginAndStage(
    quotaRepository,
    quotaA.binding,
    quotaArtifactA2.artifactId,
    [textPart("f", 37)]
  );
  assert.equal(
    await quotaRepository.cancelReservation(
      quotaArtifactA2.artifactId,
      quotaA.binding,
      quotaArtifactA2.reservationToken
    ),
    null
  );
  await quotaRepository.abortUpload(quotaArtifactA2.artifactId, quotaUploadA2.uploadToken);
  assert.equal(
    await quotaRepository.cancelReservation(
      quotaArtifactA2.artifactId,
      quotaA.binding,
      quotaArtifactA2.reservationToken
    ),
    null
  );
  assert.equal(
    (await client.hGetAll(quotaRepository._artifact(quotaArtifactA2.artifactId).keys[0])).state,
    "deleting"
  );
  assert.equal(
    (await client.hGetAll(quotaRepository._artifact(quotaArtifactB.artifactId).keys[0])).state,
    "reserved"
  );
  await quotaRepository.invalidateProfile(quotaA.binding.profileId);
  await quotaRepository.invalidateProfile(quotaB.binding.profileId);
  assert.equal(
    await quotaRepository.cancelReservation(
      quotaArtifactB.artifactId,
      quotaB.binding,
      quotaArtifactB.reservationToken
    ),
    null
  );
  await forceDeletionDue(client, quotaRepository, quotaArtifactA2.artifactId);
  await drainDeletions(client, quotaRepository, "worker_live_quota");
  const quotaGlobal = await client.hGetAll(quotaRepository._global[0]);
  assert.equal(quotaGlobal.artifacts, "0");
  assert.equal(quotaGlobal.objects, "0");
  assert.equal(quotaGlobal.bytes, "0");

  const pruneBatch = await activeBinding(client, keyspace, {
    profileId: "profile_subtitle_live_prune_batch",
    deviceId: "device_subtitle_live_prune_batch",
  });
  const pruneBatchRepository = deliveryRepository(client, keyspace, {
    tokenSeed: 220,
    envelopeSeed: 220,
    uploadLeaseTtlMs: 30 * 1000,
    maxPutLifetimeMs: 30 * 1000,
    uploadSettlementGraceMs: 10 * 1000,
    uploadCleanupBatchSize: 1,
    pruneBatchSize: 1,
    deletionScanBatchSize: 1,
    leaseCleanupBatchSize: 1,
  });
  await initializeAuthority(pruneBatchRepository, pruneBatch.binding);
  const batchArtifacts = await Promise.all(Array.from({ length: 3 }, (_value, index) =>
    pruneBatchRepository.reserve({
      ...pruneBatch.binding,
      discoveryKey: "due-batch-" + String(index),
      sourceCapability: sourceCapability("due-batch-" + String(index)),
    })
  ));
  await Promise.all(batchArtifacts.map((artifact, index) => beginAndStage(
    pruneBatchRepository,
    pruneBatch.binding,
    artifact.artifactId,
    [textPart(["a", "b", "c"][index], 40 + index)]
  )));
  const futureAt = (await redisNowMs(pruneBatchRepository)) + 60 * 1000;
  const futureZsetIndexes = [1, 2, 3, 4, 6];
  const futureMembers = futureZsetIndexes.map((_index, index) =>
    keyspace.key("subtitle-prune-future", String(index))
  );
  for (let index = 0; index < futureMembers.length; index += 1) {
    await client.zAdd(pruneBatchRepository._global[futureZsetIndexes[index]], {
      score: futureAt,
      value: futureMembers[index],
    });
  }
  assert.deepEqual(await pruneBatchRepository.prune(), {
    artifacts: 0,
    deletionClaims: 0,
    leases: 0,
    uploads: 0,
    hasMore: false,
  });
  for (let index = 0; index < futureMembers.length; index += 1) {
    await client.zRem(pruneBatchRepository._global[futureZsetIndexes[index]], futureMembers[index]);
  }
  await Promise.all(batchArtifacts.map((artifact) =>
    forceUploadExpiry(client, pruneBatchRepository, artifact.artifactId)
  ));
  for (const expectedMore of [true, true, false]) {
    const batch = await pruneBatchRepository.prune();
    assert.equal(batch.uploads, 1);
    assert.equal(batch.hasMore, expectedMore);
  }
  await Promise.all(batchArtifacts.map((artifact) =>
    forceDeletionDue(client, pruneBatchRepository, artifact.artifactId)
  ));
  await drainDeletions(client, pruneBatchRepository, "worker_prune_due_batch");
  const finalGlobal = await client.hGetAll(pruneBatchRepository._global[0]);
  assert.equal(finalGlobal.artifacts, "0");
  assert.equal(finalGlobal.objects, "0");
  assert.equal(finalGlobal.bytes, "0");
}

if (!AGGREGATED_LIVE_RUN) {
  registerModelTests();
  const redisTest = REDIS_URL ? test : test.skip;
  redisTest("REDIS_URL Redis 7/8 subtitle delivery races and crash boundaries", async (t) => {
    await withRedis(t, runRedisSubtitleLiveContracts);
  });
}

module.exports = {
  runRedisSubtitleLiveContracts,
};
