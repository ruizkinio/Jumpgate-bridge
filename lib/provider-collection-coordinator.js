"use strict";

const {
  assertProviderSnapshotAuthority,
  invalidateProviderSnapshot,
  readProviderCollectionSnapshot,
  replaceProviderCollection,
} = require("./source-context");

const PROVIDER_MUTATION_MODES = new Set(["legacy", "fenced"]);

function assertMode(value) {
  if (typeof value !== "string" || !PROVIDER_MUTATION_MODES.has(value)) {
    throw new TypeError("provider collection coordinator mode is invalid");
  }
  return value;
}

function assertProviders(providers) {
  if (!providers || typeof providers.list !== "function") {
    throw new TypeError("providers repository is invalid");
  }
  return providers;
}

function assertPlaybackContexts(playbackContexts) {
  if (!playbackContexts || typeof playbackContexts.getProfileGeneration !== "function") {
    throw new TypeError("playbackContexts repository is invalid");
  }
  return playbackContexts;
}

class LegacyProviderCollectionStrategy {
  constructor(providers, playbackContexts) {
    this._providers = providers;
    this._playbackContexts = playbackContexts;
  }

  list(profileId, options) {
    return options === undefined
      ? this._providers.list(profileId)
      : this._providers.list(profileId, options);
  }

  async readSnapshot(profileId, options) {
    const collection = options === undefined
      ? await this._providers.list(profileId)
      : await this._providers.list(profileId, options);
    const generation = await this._playbackContexts.getProfileGeneration(profileId);
    return { collection, generation };
  }

  async replaceAll(profileId, descriptors, expectedRevision) {
    if (typeof this._providers.replaceAll !== "function") {
      throw new TypeError("providers repository is invalid");
    }
    if (typeof this._playbackContexts.invalidateProfile !== "function") {
      throw new TypeError("playbackContexts repository is invalid");
    }
    await this._playbackContexts.invalidateProfile(profileId);
    return this._providers.replaceAll(profileId, descriptors, expectedRevision);
  }

  invalidate(profileId) {
    if (typeof this._playbackContexts.invalidateProfile !== "function") {
      throw new TypeError("playbackContexts repository is invalid");
    }
    return this._playbackContexts.invalidateProfile(profileId);
  }
}

class FencedProviderCollectionStrategy {
  constructor(providers, playbackContexts) {
    assertProviderSnapshotAuthority(playbackContexts);
    this._providers = providers;
    this._playbackContexts = playbackContexts;
  }

  async list(profileId, options) {
    const snapshot = await readProviderCollectionSnapshot(
      this._providers,
      this._playbackContexts,
      profileId,
      options
    );
    return snapshot.collection;
  }

  readSnapshot(profileId, options) {
    return readProviderCollectionSnapshot(
      this._providers,
      this._playbackContexts,
      profileId,
      options
    );
  }

  replaceAll(profileId, descriptors, expectedRevision) {
    return replaceProviderCollection(
      this._providers,
      this._playbackContexts,
      profileId,
      descriptors,
      expectedRevision
    );
  }

  invalidate(profileId) {
    return invalidateProviderSnapshot(
      this._playbackContexts,
      this._providers,
      profileId
    );
  }
}

class ProviderCollectionCoordinator {
  constructor(options = {}) {
    const mode = assertMode(options.mode === undefined ? "fenced" : options.mode);
    const providers = assertProviders(options.providers);
    const playbackContexts = assertPlaybackContexts(options.playbackContexts);
    if (
      options.subtitleDeliveries !== undefined &&
      (!options.subtitleDeliveries || typeof options.subtitleDeliveries.invalidateProfile !== "function")
    ) {
      throw new TypeError("subtitleDeliveries repository is invalid");
    }
    this.mode = mode;
    this._subtitleDeliveries = options.subtitleDeliveries || null;
    this._strategy = mode === "legacy"
      ? new LegacyProviderCollectionStrategy(providers, playbackContexts)
      : new FencedProviderCollectionStrategy(providers, playbackContexts);
  }

  list(profileId, options) {
    return this._strategy.list(profileId, options);
  }

  readSnapshot(profileId, options) {
    return this._strategy.readSnapshot(profileId, options);
  }

  async replaceAll(profileId, descriptors, expectedRevision) {
    const result = await this._strategy.replaceAll(profileId, descriptors, expectedRevision);
    if (this._subtitleDeliveries) {
      await this._subtitleDeliveries.invalidateProfile(profileId);
    }
    return result;
  }

  async invalidate(profileId) {
    const result = await this._strategy.invalidate(profileId);
    if (this._subtitleDeliveries) {
      await this._subtitleDeliveries.invalidateProfile(profileId);
    }
    return result;
  }
}

function assertProviderCollectionCoordinator(coordinator) {
  if (
    !coordinator ||
    typeof coordinator.list !== "function" ||
    typeof coordinator.readSnapshot !== "function" ||
    typeof coordinator.replaceAll !== "function" ||
    typeof coordinator.invalidate !== "function"
  ) {
    throw new TypeError("provider collection coordinator is invalid");
  }
  return coordinator;
}

function resolveProviderCollectionCoordinator(options = {}) {
  if (options.providerCollectionCoordinator !== undefined) {
    return assertProviderCollectionCoordinator(options.providerCollectionCoordinator);
  }
  return new ProviderCollectionCoordinator({
    mode: options.providerMutationMode === undefined ? "fenced" : options.providerMutationMode,
    providers: options.providers,
    playbackContexts: options.playbackContexts,
  });
}

module.exports = {
  ProviderCollectionCoordinator,
  assertProviderCollectionCoordinator,
  resolveProviderCollectionCoordinator,
};
