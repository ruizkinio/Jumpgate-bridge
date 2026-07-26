"use strict";

const { ProfileLifecycleCoordinator } = require("../lifecycle-invalidation");
const { SqliteAddonCollectionBackupRepository } = require("./backups");
const {
  DEFAULT_MIGRATION_BUSY_TIMEOUT_MS,
  DEFAULT_MIGRATION_DIRECTORY,
  DEFAULT_MIGRATIONS_PATH,
  SqliteMigrationRunner,
  applySqliteMigrations,
  configureSqliteDatabase,
  openSqliteDatabase,
  readSqliteMigrations,
  runSqliteMigrations,
  withImmediateTransaction,
  withReadTransaction,
} = require("./connection");
const { SqliteDeviceRepository } = require("./devices");
const { SqliteHistoryGrantRepository } = require("./history-grants");
const { SqliteHistoryRepository } = require("./history");
const { SqliteLegacyConfigAliasRepository } = require("./legacy-aliases");
const { SqliteLifecycleInvalidationRepository } = require("./lifecycle-invalidations");
const { SqliteOAuthCredentialRepository } = require("./oauth-credentials");
const { SqlitePlaybackSessionRepository } = require("./playback-sessions");
const { SqliteProfileRepository } = require("./profiles");
const { SqliteProviderRepository } = require("./providers");
const { SqliteSubtitleManifestRepository } = require("./subtitle-manifests");

function isDatabaseHandle(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.prepare === "function" &&
      typeof value.exec === "function"
  );
}

function normalizeFactoryOptions(databaseOrOptions, extraOptions = {}) {
  if (isDatabaseHandle(databaseOrOptions)) {
    return { ...extraOptions, database: databaseOrOptions };
  }
  if (typeof databaseOrOptions === "string") {
    return { ...extraOptions, filename: databaseOrOptions };
  }
  if (databaseOrOptions === undefined) return { ...extraOptions };
  if (!databaseOrOptions || typeof databaseOrOptions !== "object" || Array.isArray(databaseOrOptions)) {
    throw new TypeError("SQLite factory options are invalid");
  }
  return { ...databaseOrOptions, ...extraOptions };
}

function createSqliteRepositories(databaseOrOptions, extraOptions) {
  const options = normalizeFactoryOptions(databaseOrOptions, extraOptions);
  const injected = options.database || options.db || options.handle;
  const ownsDatabase = !injected;
  const database = injected || openSqliteDatabase(options);

  try {
    configureSqliteDatabase(database, options);
    const migrationResult =
      options.migrate === false
        ? { applied: [], alreadyApplied: [], verified: [] }
        : runSqliteMigrations(database, options);
    const common = {
      database,
      clock: options.clock,
    };
    const lifecycleCoordinator =
      options.lifecycleCoordinator || new ProfileLifecycleCoordinator();
    const lifecycleInvalidations = new SqliteLifecycleInvalidationRepository(common);
    const history = new SqliteHistoryRepository(common);
    const historyGrants = new SqliteHistoryGrantRepository({
      ...common,
      tokenService: options.tokenService,
      envelopeCrypto: options.envelopeCrypto,
      grantIdFactory: options.historyGrantIdFactory,
      sessionIdFactory: options.historySessionIdFactory,
      lifecycleCoordinator,
    });
    const playbackSessions = new SqlitePlaybackSessionRepository({
      ...common,
      tokenService: options.tokenService,
      lifecycleCoordinator,
    });
    const subtitleManifests = new SqliteSubtitleManifestRepository({
      ...common,
      tokenService: options.tokenService,
      lifecycleCoordinator,
    });
    const repositories = {
      profiles: new SqliteProfileRepository({
        ...common,
        tokenService: options.tokenService,
        idFactory: options.profileIdFactory || options.idFactory,
        lifecycleCoordinator,
        lifecycleInvalidations,
        playbackSessions,
        subtitleManifests,
      }),
      devices: new SqliteDeviceRepository({
        ...common,
        tokenService: options.tokenService,
        idFactory: options.deviceIdFactory || options.idFactory,
        ttlMs: options.deviceTtlMs ?? options.ttlMs,
        touchIntervalMs: options.deviceTouchIntervalMs ?? options.touchIntervalMs,
        maxDevicesPerProfile: options.maxDevicesPerProfile,
        lifecycleCoordinator,
        lifecycleInvalidations,
        playbackSessions,
        subtitleManifests,
      }),
      providers: new SqliteProviderRepository({
        ...common,
        tokenService: options.tokenService,
        envelopeCrypto: options.envelopeCrypto,
        idFactory: options.providerIdFactory || options.idFactory,
      }),
      oauthCredentials: new SqliteOAuthCredentialRepository({
        ...common,
        envelopeCrypto: options.envelopeCrypto,
      }),
      history,
      historyGrants,
      addonCollectionBackups: new SqliteAddonCollectionBackupRepository({
        ...common,
        envelopeCrypto: options.envelopeCrypto,
        idFactory: options.backupIdFactory || options.idFactory,
        maxBackupsPerProfile: options.maxBackupsPerProfile,
      }),
      legacyConfigAliases: new SqliteLegacyConfigAliasRepository(common),
      lifecycleInvalidations,
      playbackSessions,
      subtitleManifests,
    };

    Object.defineProperties(repositories, {
      database: { value: database, enumerable: false },
      migrationResult: { value: migrationResult, enumerable: false },
      ownsDatabase: { value: ownsDatabase, enumerable: false },
      repositories: { value: repositories, enumerable: false },
      close: {
        enumerable: false,
        value() {
          if (typeof database.close === "function" && database.open !== false) database.close();
        },
      },
    });
    return repositories;
  } catch (error) {
    if (ownsDatabase && typeof database.close === "function" && database.open !== false) {
      database.close();
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_MIGRATION_BUSY_TIMEOUT_MS,
  DEFAULT_MIGRATION_DIRECTORY,
  DEFAULT_MIGRATIONS_PATH,
  SQLiteAddonCollectionBackupRepository: SqliteAddonCollectionBackupRepository,
  SQLiteDeviceRepository: SqliteDeviceRepository,
  SQLiteHistoryGrantRepository: SqliteHistoryGrantRepository,
  SQLiteHistoryRepository: SqliteHistoryRepository,
  SQLiteLegacyConfigAliasRepository: SqliteLegacyConfigAliasRepository,
  SQLiteLifecycleInvalidationRepository: SqliteLifecycleInvalidationRepository,
  SQLiteMigrationRunner: SqliteMigrationRunner,
  SQLiteOAuthCredentialRepository: SqliteOAuthCredentialRepository,
  SQLitePlaybackSessionRepository: SqlitePlaybackSessionRepository,
  SQLiteProfileRepository: SqliteProfileRepository,
  SQLiteProviderRepository: SqliteProviderRepository,
  SQLiteSubtitleManifestRepository: SqliteSubtitleManifestRepository,
  SqliteAddonCollectionBackupRepository,
  SqliteDeviceRepository,
  SqliteHistoryGrantRepository,
  SqliteHistoryRepository,
  SqliteLegacyConfigAliasRepository,
  SqliteLifecycleInvalidationRepository,
  SqliteMigrationRunner,
  SqliteOAuthCredentialRepository,
  SqlitePlaybackSessionRepository,
  SqliteProfileRepository,
  SqliteProviderRepository,
  SqliteSubtitleManifestRepository,
  applySqliteMigrations,
  configureSqliteDatabase,
  createSQLiteRepositories: createSqliteRepositories,
  createSqliteDurableRepositories: createSqliteRepositories,
  createSqliteRepositories,
  createSqliteRepositorySet: createSqliteRepositories,
  createSqliteStorage: createSqliteRepositories,
  openSqliteDatabase,
  readSqliteMigrations,
  runSqliteMigrations,
  withImmediateTransaction,
  withReadTransaction,
};
