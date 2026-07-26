"use strict";

const crypto = require("node:crypto");

const {
  assertIdentifier,
  assertMutationFence,
  assertRevision,
  cloneJson,
  codedError,
  compareMutationFences,
  mutationFenceOption,
  nextMutationFence,
  providerSnapshotStaleFence,
  readClock,
  revisionConflict,
  stableScope,
} = require("../repository-utils");
const { withImmediateTransaction, withReadTransaction } = require("./connection");
const {
  assertDescriptorSize,
  assertJsonValue,
  isActiveProfile,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
  normalizeRepositoryOptions,
  parseJson,
  prepareProfileStatus,
  requireActiveProfile,
  requireDatabase,
  stringifyJson,
} = require("./helpers");

class SqliteProviderRepository {
  constructor(databaseOrOptions, extraOptions) {
    const options = normalizeRepositoryOptions(databaseOrOptions, extraOptions);
    if (!options.envelopeCrypto || !options.tokenService) {
      throw new TypeError("envelopeCrypto and tokenService are required");
    }
    this._db = requireDatabase(options);
    this._crypto = options.envelopeCrypto;
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());

    this._profileStatus = prepareProfileStatus(this._db);
    this._getCollection = this._db.prepare(
      "SELECT * FROM provider_collections WHERE profile_id = ?"
    );
    this._listRows = this._db.prepare(
      "SELECT * FROM providers WHERE profile_id = ? ORDER BY ordinal"
    );
    this._otherProviderIds = this._db.prepare(
      "SELECT id FROM providers WHERE profile_id <> ?"
    );
    this._insertCollection = this._db.prepare(`
      INSERT INTO provider_collections (
        profile_id, schema_version, revision, mutation_fence, updated_at
      ) VALUES (?, 1, ?, ?, ?)
    `);
    this._updateCollection = this._db.prepare(`
      UPDATE provider_collections
      SET revision = revision + 1, mutation_fence = ?, updated_at = ?
      WHERE profile_id = ? AND revision = ?
    `);
    this._advanceFence = this._db.prepare(`
      UPDATE provider_collections
      SET mutation_fence = ?, updated_at = ?
      WHERE profile_id = ?
    `);
    this._getMutationFenceCounter = this._db.prepare(
      "SELECT mutation_fence FROM provider_mutation_fence_counter WHERE singleton_id = 1"
    );
    this._allocateMutationFence = this._db.prepare(`
      UPDATE provider_mutation_fence_counter
      SET mutation_fence = ?
      WHERE singleton_id = 1 AND mutation_fence = ?
    `);
    this._rebaseMutationFence = this._db.prepare(`
      UPDATE provider_mutation_fence_counter
      SET mutation_fence = ?
      WHERE singleton_id = 1 AND (
        length(mutation_fence) < length(?) OR
        (length(mutation_fence) = length(?) AND mutation_fence < ?)
      )
    `);
    this._deleteProviders = this._db.prepare("DELETE FROM providers WHERE profile_id = ?");
    this._insertProvider = this._db.prepare(`
      INSERT INTO providers (
        id, profile_id, schema_version, ordinal, manifest_id, transport_hash,
        descriptor_envelope, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
    `);
  }

  async allocateMutationFence(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, id);
      const current = this._mutationFenceCounter();
      const allocated = nextMutationFence(current);
      const result = this._allocateMutationFence.run(allocated, current);
      if (result.changes !== 1) {
        throw new Error("provider mutation fence counter update failed");
      }
      return allocated;
    });
  }

  async replaceAll(profileId, descriptors, expectedRevision, options) {
    const id = assertIdentifier(profileId, "profile id");
    if (!Array.isArray(descriptors) || descriptors.length > 64) {
      throw new TypeError("descriptors must be an array of at most 64 entries");
    }
    const safeDescriptors = assertJsonValue(descriptors, "provider descriptors");
    const expected = assertRevision(expectedRevision, false);
    const mutationFence = mutationFenceOption(options);

    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, id);
      const current = this._getCollection.get(id);
      const currentRevision = current ? current.revision : 0;
      const currentFence = assertMutationFence(
        current ? current.mutation_fence : "0",
        "stored provider mutation fence"
      );
      if (compareMutationFences(mutationFence, currentFence) < 0) {
        throw providerSnapshotStaleFence();
      }
      if (currentRevision !== expected) throw revisionConflict();
      if (currentRevision >= Number.MAX_SAFE_INTEGER) {
        throw codedError("revision_exhausted", "provider collection revision exhausted");
      }

      const transportHashes = new Set();
      const providerIds = new Set(this._otherProviderIds.all(id).map((row) => row.id));
      const envelopePurpose = this._providerPurpose(id);
      const records = safeDescriptors.map((descriptor, ordinal) => {
        if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
          throw new TypeError("provider descriptor is invalid");
        }
        const safeDescriptor = assertDescriptorSize(descriptor);
        const transportUrl = safeDescriptor.transportUrl;
        if (typeof transportUrl !== "string" || !transportUrl) {
          throw new TypeError("provider transportUrl is required");
        }
        const transportHash = this._tokens.hashOpaque(
          "provider-transport",
          transportUrl,
          8192
        );
        if (transportHashes.has(transportHash)) {
          throw new TypeError("duplicate provider transportUrl");
        }
        transportHashes.add(transportHash);
        const providerId = assertIdentifier(this._idFactory("provider"), "provider id");
        if (providerIds.has(providerId)) throw new Error("provider id collision");
        providerIds.add(providerId);
        const manifestId =
          safeDescriptor.manifest && typeof safeDescriptor.manifest.id === "string"
            ? safeDescriptor.manifest.id.slice(0, 256)
            : "";
        const descriptorEnvelope = this._crypto.encryptJson(safeDescriptor, envelopePurpose);
        return {
          schemaVersion: 1,
          providerId,
          profileId: id,
          ordinal,
          manifestId,
          transportHash,
          descriptorEnvelope,
          descriptorText: stringifyJson(
            descriptorEnvelope,
            "provider descriptor envelope",
            MAX_JSON_SNAPSHOT_ENVELOPE_BYTES
          ),
        };
      });
      const now = readClock(this._clock);

      this._deleteProviders.run(id);
      if (current) {
        const result = this._updateCollection.run(mutationFence, now, id, expected);
        if (result.changes !== 1) throw revisionConflict();
      } else {
        this._insertCollection.run(id, 1, mutationFence, now);
      }
      for (const record of records) {
        this._insertProvider.run(
          record.providerId,
          id,
          record.ordinal,
          record.manifestId,
          record.transportHash,
          record.descriptorText,
          now,
          now
        );
      }
      this._rebaseMutationFenceCounter(mutationFence);
      return { revision: currentRevision + 1, count: records.length };
    });
  }

  async list(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    return withReadTransaction(this._db, () => {
      if (!isActiveProfile(this._profileStatus, id)) return { revision: 0, providers: [] };
      const collection = this._getCollection.get(id);
      if (!collection) return { revision: 0, providers: [] };
      const purpose = this._providerPurpose(id);
      return {
        revision: collection.revision,
        providers: this._listRows.all(id).map((row) => ({
          providerId: row.id,
          ordinal: row.ordinal,
          descriptor: this._crypto.decryptJson(
            parseJson(row.descriptor_envelope, "provider descriptor envelope"),
            purpose
          ),
        })),
      };
    });
  }

  async removeAll(profileId, expectedRevision, options) {
    return this.replaceAll(profileId, [], expectedRevision, options);
  }

  async advanceMutationFence(profileId, mutationFence) {
    const id = assertIdentifier(profileId, "profile id");
    const nextFence = assertMutationFence(mutationFence);
    return withImmediateTransaction(this._db, () => {
      requireActiveProfile(this._profileStatus, id);
      const current = this._getCollection.get(id);
      const currentFence = assertMutationFence(
        current ? current.mutation_fence : "0",
        "stored provider mutation fence"
      );
      const comparison = compareMutationFences(nextFence, currentFence);
      if (comparison < 0) throw providerSnapshotStaleFence();
      if (!current) {
        this._insertCollection.run(id, 0, nextFence, readClock(this._clock));
        this._rebaseMutationFenceCounter(nextFence);
        return { revision: 0, mutationFence: nextFence };
      }
      if (comparison > 0) {
        const result = this._advanceFence.run(nextFence, readClock(this._clock), id);
        if (result.changes !== 1) throw new Error("provider collection row is unavailable");
      }
      this._rebaseMutationFenceCounter(nextFence);
      return { revision: current.revision, mutationFence: nextFence };
    });
  }

  storageSnapshot(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const collection = this._getCollection.get(id);
    if (!collection) return { revision: 0, records: [] };
    return cloneJson({
      mutationFence: assertMutationFence(
        collection.mutation_fence,
        "stored provider mutation fence"
      ),
      revision: collection.revision,
      updatedAt: collection.updated_at,
      records: this._listRows.all(id).map((row) => ({
        schemaVersion: row.schema_version,
        providerId: row.id,
        profileId: row.profile_id,
        ordinal: row.ordinal,
        manifestId: row.manifest_id,
        transportHash: row.transport_hash,
        descriptorEnvelope: parseJson(
          row.descriptor_envelope,
          "provider descriptor envelope"
        ),
      })),
    });
  }

  _providerPurpose(profileId) {
    return "provider-descriptor:" + stableScope("profile", profileId);
  }

  _mutationFenceCounter() {
    const row = this._getMutationFenceCounter.get();
    if (!row) throw new Error("provider mutation fence counter is unavailable");
    return assertMutationFence(row.mutation_fence, "stored provider mutation fence counter");
  }

  _rebaseMutationFenceCounter(mutationFence) {
    this._rebaseMutationFence.run(
      mutationFence,
      mutationFence,
      mutationFence,
      mutationFence
    );
  }
}

module.exports = {
  SqliteProviderRepository,
};
