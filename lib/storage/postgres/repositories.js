"use strict";

const { PostgresDatabase } = require("./database");
const { PostgresAddonCollectionBackupRepository } = require("./backup-repository");
const { PostgresDeviceRepository } = require("./device-repository");
const { PostgresHistoryGrantRepository } = require("./history-grant-repository");
const { PostgresHistoryRepository } = require("./history-repository");
const { PostgresLegacyConfigAliasRepository } = require("./legacy-alias-repository");
const {
  PostgresLifecycleInvalidationRepository,
} = require("./lifecycle-invalidation-repository");
const { PostgresOAuthCredentialRepository } = require("./oauth-credential-repository");
const {
  PostgresPlaybackSessionRepository,
} = require("./playback-session-repository");
const { PostgresProfileRepository } = require("./profile-repository");
const { PostgresProviderRepository } = require("./provider-repository");
const {
  PostgresSubtitleManifestRepository,
} = require("./subtitle-manifest-repository");

function normalizeFactoryOptions(databaseOrOptions, extraOptions = {}) {
  if (
    databaseOrOptions &&
    typeof databaseOrOptions.query === "function" &&
    typeof databaseOrOptions.transaction === "function"
  ) {
    return { ...extraOptions, database: databaseOrOptions };
  }
  if (
    databaseOrOptions &&
    typeof databaseOrOptions.query === "function" &&
    typeof databaseOrOptions.connect === "function"
  ) {
    return { ...extraOptions, pool: databaseOrOptions };
  }
  if (databaseOrOptions === undefined) return { ...extraOptions };
  if (!databaseOrOptions || typeof databaseOrOptions !== "object" || Array.isArray(databaseOrOptions)) {
    throw new TypeError("PostgreSQL factory options are invalid");
  }
  return { ...databaseOrOptions, ...extraOptions };
}

function createPostgresDurableRepositories(databaseOrOptions, extraOptions) {
  const options = normalizeFactoryOptions(databaseOrOptions, extraOptions);
  const database = options.database || options.db || (options.pool
    ? new PostgresDatabase({ pool: options.pool })
    : null);
  if (!database) throw new TypeError("database is required");
  const common = { database, clock: options.clock };
  const providerMutationMode = options.providerMutationMode === undefined
    ? "legacy"
    : options.providerMutationMode;
  const lifecycleInvalidations = new PostgresLifecycleInvalidationRepository(common);
  const history = new PostgresHistoryRepository(common);
  const historyGrants = new PostgresHistoryGrantRepository({
    ...common,
    tokenService: options.tokenService,
    envelopeCrypto: options.envelopeCrypto,
    grantIdFactory: options.historyGrantIdFactory,
    sessionIdFactory: options.historySessionIdFactory,
  });
  const playbackSessions = new PostgresPlaybackSessionRepository({
    ...common,
    tokenService: options.tokenService,
  });
  const subtitleManifests = new PostgresSubtitleManifestRepository({
    ...common,
    tokenService: options.tokenService,
  });
  const repositories = {
    profiles: new PostgresProfileRepository({
      ...common,
      tokenService: options.tokenService,
      idFactory: options.profileIdFactory || options.idFactory,
      lifecycleInvalidations,
      playbackSessions,
      subtitleManifests,
    }),
    devices: new PostgresDeviceRepository({
      ...common,
      tokenService: options.tokenService,
      idFactory: options.deviceIdFactory || options.idFactory,
      ttlMs: options.deviceTtlMs ?? options.ttlMs,
      touchIntervalMs: options.deviceTouchIntervalMs ?? options.touchIntervalMs,
      maxDevicesPerProfile: options.maxDevicesPerProfile,
      lifecycleInvalidations,
      playbackSessions,
      subtitleManifests,
    }),
    providers: new PostgresProviderRepository({
      ...common,
      mode: providerMutationMode,
      providerMutationTimeoutMs: options.providerMutationTimeoutMs,
      tokenService: options.tokenService,
      envelopeCrypto: options.envelopeCrypto,
      idFactory: options.providerIdFactory || options.idFactory,
    }),
    oauthCredentials: new PostgresOAuthCredentialRepository({
      ...common,
      envelopeCrypto: options.envelopeCrypto,
    }),
    history,
    historyGrants,
    addonCollectionBackups: new PostgresAddonCollectionBackupRepository({
      ...common,
      envelopeCrypto: options.envelopeCrypto,
      idFactory: options.backupIdFactory || options.idFactory,
      maxBackupsPerProfile: options.maxBackupsPerProfile,
    }),
    legacyConfigAliases: new PostgresLegacyConfigAliasRepository(common),
    lifecycleInvalidations,
    playbackSessions,
    subtitleManifests,
  };

  Object.defineProperties(repositories, {
    database: { value: database, enumerable: false },
    repositories: { value: repositories, enumerable: false },
  });
  return repositories;
}

const createPostgresRepositories = createPostgresDurableRepositories;

module.exports = {
  PostgreSQLAddonCollectionBackupRepository: PostgresAddonCollectionBackupRepository,
  PostgreSQLDeviceRepository: PostgresDeviceRepository,
  PostgreSQLHistoryGrantRepository: PostgresHistoryGrantRepository,
  PostgreSQLHistoryRepository: PostgresHistoryRepository,
  PostgreSQLLegacyConfigAliasRepository: PostgresLegacyConfigAliasRepository,
  PostgreSQLLifecycleInvalidationRepository: PostgresLifecycleInvalidationRepository,
  PostgreSQLOAuthCredentialRepository: PostgresOAuthCredentialRepository,
  PostgreSQLPlaybackSessionRepository: PostgresPlaybackSessionRepository,
  PostgreSQLProfileRepository: PostgresProfileRepository,
  PostgreSQLProviderRepository: PostgresProviderRepository,
  PostgreSQLSubtitleManifestRepository: PostgresSubtitleManifestRepository,
  PostgresAddonCollectionBackupRepository,
  PostgresDeviceRepository,
  PostgresHistoryGrantRepository,
  PostgresHistoryRepository,
  PostgresLegacyConfigAliasRepository,
  PostgresLifecycleInvalidationRepository,
  PostgresOAuthCredentialRepository,
  PostgresPlaybackSessionRepository,
  PostgresProfileRepository,
  PostgresProviderRepository,
  PostgresSubtitleManifestRepository,
  createPostgresDurableRepositories,
  createPostgresRepositories,
  createPostgresRepositorySet: createPostgresRepositories,
  createPostgresStorage: createPostgresRepositories,
  createPostgreSQLRepositories: createPostgresRepositories,
};
