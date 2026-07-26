"use strict";

const crypto = require("node:crypto");
const {
  MAX_MUTATION_FENCE,
  assertIdentifier,
  assertMutationFence,
  assertRevision,
  codedError,
  compareMutationFences,
  mutationFenceOption,
  providerMutationFenceExhausted,
  providerSnapshotStaleFence,
  readClock,
  revisionConflict,
  stableScope,
} = require("../repository-utils");
const {
  affectedRows,
  assertDescriptorSize,
  assertEnvelopeStorageSize,
  assertJsonValue,
  dateParameter,
  firstRow,
  jsonValue,
  lockActiveProfile,
  MAX_JSON_SNAPSHOT_ENVELOPE_BYTES,
  requireDatabase,
  resultRows,
  toSafeInteger,
  uniqueConstraint,
} = require("./repository-helpers");

const PROVIDER_MUTATION_MODES = Object.freeze(["legacy", "fenced"]);
const PROVIDER_MUTATION_PROTOCOL_MARKER = "1";
const DEFAULT_PROVIDER_MUTATION_TIMEOUT_MS = 15_000;

function providerMutationTimeout(value) {
  const timeoutMs = value === undefined ? DEFAULT_PROVIDER_MUTATION_TIMEOUT_MS : value;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError("providerMutationTimeoutMs must be an integer between 1 and 300000");
  }
  return timeoutMs;
}

function normalizeProviderMutationMode(value, name = "provider mutation mode") {
  if (!PROVIDER_MUTATION_MODES.includes(value)) {
    throw new TypeError(name + " must be legacy or fenced");
  }
  return value;
}

function positiveMutationFenceOption(options) {
  const mutationFence = mutationFenceOption(options);
  if (mutationFence === "0") {
    throw new TypeError("mutationFence must be nonzero in fenced mode");
  }
  return mutationFence;
}

function requireFencedMode(mode, operation) {
  if (mode === "fenced") return;
  throw codedError(
    "provider_mutation_mode_mismatch",
    operation + " requires fenced provider mutation mode"
  );
}

async function setProviderMutationProtocol(transaction, mutationFence) {
  await transaction.query(
    `SELECT set_config('jumpgate.provider_mutation_protocol', $1, true),
            set_config('jumpgate.provider_mutation_fence', $2, true)`,
    [PROVIDER_MUTATION_PROTOCOL_MARKER, mutationFence]
  );
}

async function setProviderMutationTimeouts(transaction, timeoutMs) {
  await transaction.query(
    `SELECT set_config('lock_timeout', $1, true),
            set_config('statement_timeout', $1, true)`,
    [String(timeoutMs) + "ms"]
  );
}

class PostgresProviderRepository {
  constructor(options = {}) {
    this._db = requireDatabase(options);
    if (!options.envelopeCrypto || !options.tokenService) {
      throw new TypeError("envelopeCrypto and tokenService are required");
    }
    this._crypto = options.envelopeCrypto;
    this._tokens = options.tokenService;
    this._clock = options.clock || Date.now;
    this._idFactory = options.idFactory || (() => crypto.randomUUID());
    const configuredMode = options.mode === undefined
      ? options.providerMutationMode
      : options.mode;
    if (
      options.mode !== undefined &&
      options.providerMutationMode !== undefined &&
      options.mode !== options.providerMutationMode
    ) {
      throw new TypeError("provider mutation mode options conflict");
    }
    this._mode = normalizeProviderMutationMode(configuredMode);
    this._mutationTimeoutMs = providerMutationTimeout(options.providerMutationTimeoutMs);
  }

  async allocateMutationFence(profileId) {
    requireFencedMode(this._mode, "provider mutation fence allocation");
    const id = assertIdentifier(profileId, "profile id");
    return this._db.transaction(async (transaction) => {
      await setProviderMutationTimeouts(transaction, this._mutationTimeoutMs);
      await lockActiveProfile(transaction, id);
      const protocol = firstRow(
        await transaction.query(
          `SELECT enforcement_active, mutations_paused
             FROM provider_mutation_protocol
            WHERE singleton_id = 1
            FOR SHARE`
        )
      );
      if (
        !protocol ||
        typeof protocol.enforcement_active !== "boolean" ||
        typeof protocol.mutations_paused !== "boolean"
      ) {
        throw codedError(
          "provider_mutation_protocol_unavailable",
          "provider mutation protocol state is unavailable"
        );
      }
      if (protocol.mutations_paused) {
        throw codedError("provider_mutations_paused", "provider mutations are paused");
      }
      let result;
      try {
        result = await transaction.query(
          `UPDATE provider_mutation_fence_counter
              SET mutation_fence = mutation_fence + 1
            WHERE singleton_id = 1 AND mutation_fence < $1::numeric
            RETURNING mutation_fence::text AS mutation_fence`,
          [MAX_MUTATION_FENCE]
        );
      } catch (error) {
        if (error && (error.code === "22003" || error.code === "23514")) {
          throw providerMutationFenceExhausted();
        }
        throw error;
      }
      if (affectedRows(result) !== 1) throw providerMutationFenceExhausted();
      return assertMutationFence(
        firstRow(result).mutation_fence,
        "allocated provider mutation fence"
      );
    });
  }

  async replaceAll(profileId, descriptors, expectedRevision, options) {
    const id = assertIdentifier(profileId, "profile id");
    if (!Array.isArray(descriptors) || descriptors.length > 64) {
      throw new TypeError("descriptors must be an array of at most 64 entries");
    }
    const safeDescriptors = assertJsonValue(descriptors, "provider descriptors");
    const expected = assertRevision(expectedRevision, false);
    let mutationFence = null;
    if (this._mode === "legacy") {
      if (options !== undefined) {
        throw new TypeError("options are not supported in legacy provider mutation mode");
      }
    } else {
      mutationFence = positiveMutationFenceOption(options);
    }
    const transportHashes = new Set();
    const providerIds = new Set();
    const purpose = this._providerPurpose(id);
    const records = safeDescriptors.map((descriptor, ordinal) => {
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        throw new TypeError("provider descriptor is invalid");
      }
      const safeDescriptor = assertDescriptorSize(descriptor);
      const transportUrl = safeDescriptor.transportUrl;
      if (typeof transportUrl !== "string" || !transportUrl) {
        throw new TypeError("provider transportUrl is required");
      }
      const transportHash = this._tokens.hashOpaque("provider-transport", transportUrl, 8192);
      if (transportHashes.has(transportHash)) throw new TypeError("duplicate provider transportUrl");
      transportHashes.add(transportHash);
      const providerId = assertIdentifier(this._idFactory("provider"), "provider id");
      if (providerIds.has(providerId)) throw new Error("provider id collision");
      providerIds.add(providerId);
      const manifestId = safeDescriptor.manifest && typeof safeDescriptor.manifest.id === "string"
        ? safeDescriptor.manifest.id.slice(0, 256)
        : "";
      const descriptorEnvelope = this._crypto.encryptJson(safeDescriptor, purpose);
      assertEnvelopeStorageSize(
        descriptorEnvelope,
        "provider descriptor envelope",
        MAX_JSON_SNAPSHOT_ENVELOPE_BYTES
      );
      return {
        descriptorEnvelope,
        manifestId,
        ordinal,
        providerId,
        transportHash,
      };
    });

    try {
      return await this._db.transaction(async (transaction) => {
        await setProviderMutationTimeouts(transaction, this._mutationTimeoutMs);
        await lockActiveProfile(transaction, id);
        if (this._mode === "legacy") {
          await transaction.query("LOCK TABLE provider_collections IN ROW EXCLUSIVE MODE");
        } else {
          await setProviderMutationProtocol(transaction, mutationFence);
        }
        const now = readClock(this._clock);
        if (this._mode === "legacy") {
          await transaction.query(
            `INSERT INTO provider_collections (profile_id, schema_version, revision, updated_at)
           VALUES ($1, 1, 0, $2)
           ON CONFLICT (profile_id) DO NOTHING`,
            [id, dateParameter(now, "provider collection updatedAt")]
          );
        } else {
          await transaction.query(
            `INSERT INTO provider_collections (
               profile_id, schema_version, revision, mutation_fence, updated_at
             ) VALUES ($1, 1, 0, $2, $3)
             ON CONFLICT (profile_id) DO NOTHING`,
            [id, mutationFence, dateParameter(now, "provider collection updatedAt")]
          );
        }
        const collection = firstRow(
          await transaction.query(
            "SELECT * FROM provider_collections WHERE profile_id = $1 FOR UPDATE",
            [id]
          )
        );
        if (!collection) throw new Error("provider collection row is unavailable");
        const currentRevision = toSafeInteger(
          collection.revision,
          "provider collection revision"
        );
        if (this._mode === "fenced") {
          const currentFence = assertMutationFence(
            collection.mutation_fence,
            "stored provider mutation fence"
          );
          if (compareMutationFences(mutationFence, currentFence) < 0) {
            throw providerSnapshotStaleFence();
          }
        }
        if (currentRevision !== expected) throw revisionConflict();
        if (currentRevision >= Number.MAX_SAFE_INTEGER) {
          throw codedError("revision_exhausted", "provider collection revision exhausted");
        }

        await transaction.query("DELETE FROM providers WHERE profile_id = $1", [id]);
        for (const record of records) {
          await transaction.query(
            `INSERT INTO providers (
               id, profile_id, schema_version, ordinal, manifest_id, transport_hash,
               descriptor_envelope, enabled, created_at, updated_at
             ) VALUES ($1, $2, 1, $3, $4, $5, $6, true, $7, $7)`,
            [
              record.providerId,
              id,
              record.ordinal,
              record.manifestId,
              record.transportHash,
              record.descriptorEnvelope,
              dateParameter(now, "provider createdAt"),
            ]
          );
        }
        const result = this._mode === "legacy"
          ? await transaction.query(
            `UPDATE provider_collections
              SET revision = revision + 1, updated_at = $3
            WHERE profile_id = $1 AND revision = $2
            RETURNING revision`,
            [id, expected, dateParameter(now, "provider collection updatedAt")]
          )
          : await transaction.query(
            `UPDATE provider_collections
                SET revision = revision + 1, mutation_fence = $3, updated_at = $4
              WHERE profile_id = $1 AND revision = $2
              RETURNING revision`,
            [id, expected, mutationFence, dateParameter(now, "provider collection updatedAt")]
          );
        if (affectedRows(result) !== 1) throw revisionConflict();
        if (this._mode === "fenced") {
          await this._rebaseMutationFenceCounter(transaction, mutationFence);
        }
        return {
          revision: toSafeInteger(firstRow(result).revision, "provider collection revision", 1),
          count: records.length,
        };
      });
    } catch (error) {
      if (uniqueConstraint(error, "providers_pkey")) throw new Error("provider id collision");
      throw error;
    }
  }

  async list(profileId) {
    const id = assertIdentifier(profileId, "profile id");
    const snapshot = await this._db.transaction(async (transaction) => {
      const profile = firstRow(
        await transaction.query(
          "SELECT id, status FROM profiles WHERE id = $1 FOR SHARE",
          [id]
        )
      );
      if (!profile || profile.status !== "active") return { revision: 0, rows: [] };
      const collection = firstRow(
        await transaction.query(
          "SELECT revision FROM provider_collections WHERE profile_id = $1 FOR SHARE",
          [id]
        )
      );
      const revision = collection
        ? toSafeInteger(collection.revision, "provider collection revision")
        : 0;
      const rows = resultRows(
        await transaction.query(
          `SELECT id, ordinal, descriptor_envelope
             FROM providers
            WHERE profile_id = $1 AND enabled = true
            ORDER BY ordinal ASC`,
          [id]
        )
      );
      return { revision, rows };
    });
    const purpose = this._providerPurpose(id);
    return {
      revision: snapshot.revision,
      providers: snapshot.rows.map((row) => ({
        providerId: row.id,
        ordinal: toSafeInteger(row.ordinal, "provider ordinal"),
        descriptor: this._crypto.decryptJson(
          jsonValue(row.descriptor_envelope, "provider descriptorEnvelope"),
          purpose
        ),
      })),
    };
  }

  async removeAll(profileId, expectedRevision, options) {
    return this.replaceAll(profileId, [], expectedRevision, options);
  }

  async advanceMutationFence(profileId, mutationFence) {
    requireFencedMode(this._mode, "provider mutation fence advance");
    const id = assertIdentifier(profileId, "profile id");
    const nextFence = assertMutationFence(mutationFence);
    if (nextFence === "0") {
      throw new TypeError("mutationFence must be nonzero in fenced mode");
    }
    return this._db.transaction(async (transaction) => {
      await setProviderMutationTimeouts(transaction, this._mutationTimeoutMs);
      await lockActiveProfile(transaction, id);
      await setProviderMutationProtocol(transaction, nextFence);
      const now = readClock(this._clock);
      await transaction.query(
        `INSERT INTO provider_collections (
           profile_id, schema_version, revision, mutation_fence, updated_at
         ) VALUES ($1, 1, 0, $2, $3)
         ON CONFLICT (profile_id) DO NOTHING`,
        [id, nextFence, dateParameter(now, "provider collection updatedAt")]
      );
      const collection = firstRow(
        await transaction.query(
          "SELECT * FROM provider_collections WHERE profile_id = $1 FOR UPDATE",
          [id]
        )
      );
      if (!collection) throw new Error("provider collection row is unavailable");
      const revision = toSafeInteger(
        collection.revision,
        "provider collection revision"
      );
      const currentFence = assertMutationFence(
        collection.mutation_fence,
        "stored provider mutation fence"
      );
      const comparison = compareMutationFences(nextFence, currentFence);
      if (comparison < 0) throw providerSnapshotStaleFence();
      let updated = collection;
      if (comparison > 0) {
        const result = await transaction.query(
          `UPDATE provider_collections
              SET mutation_fence = $2, updated_at = $3
            WHERE profile_id = $1
            RETURNING revision, mutation_fence`,
          [id, nextFence, dateParameter(now, "provider collection updatedAt")]
        );
        if (affectedRows(result) !== 1) throw new Error("provider collection row is unavailable");
        updated = firstRow(result);
      }
      await this._rebaseMutationFenceCounter(transaction, nextFence);
      return {
        revision: toSafeInteger(updated.revision, "provider collection revision"),
        mutationFence: assertMutationFence(
          updated.mutation_fence,
          "stored provider mutation fence"
        ),
      };
    });
  }

  _providerPurpose(profileId) {
    return "provider-descriptor:" + stableScope("profile", profileId);
  }

  async _rebaseMutationFenceCounter(transaction, mutationFence) {
    const result = await transaction.query(
      `UPDATE provider_mutation_fence_counter
          SET mutation_fence = GREATEST(mutation_fence, $1::numeric)
        WHERE singleton_id = 1`,
      [mutationFence]
    );
    if (affectedRows(result) !== 1) {
      throw new Error("provider mutation fence counter is unavailable");
    }
  }
}

module.exports = {
  DEFAULT_PROVIDER_MUTATION_TIMEOUT_MS,
  normalizeProviderMutationMode,
  PROVIDER_MUTATION_MODES,
  PostgresProviderRepository,
};
