CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum char(64) NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE profiles (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{8,128}$'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  install_token_hash char(64) NOT NULL UNIQUE CHECK (install_token_hash ~ '^[a-f0-9]{64}$'),
  display_name text NOT NULL DEFAULT '' CHECK (octet_length(display_name) <= 512),
  settings_envelope jsonb CHECK (settings_envelope IS NULL OR jsonb_typeof(settings_envelope) = 'object'),
  legacy_config_hash char(64) UNIQUE CHECK (legacy_config_hash IS NULL OR legacy_config_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (updated_at >= created_at),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE TABLE devices (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{8,128}$'),
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  display_name text NOT NULL DEFAULT '' CHECK (octet_length(display_name) <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX devices_profile_active_idx ON devices (profile_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE provider_collections (
  profile_id text PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE providers (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{8,128}$'),
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  manifest_id text NOT NULL DEFAULT '' CHECK (octet_length(manifest_id) <= 1024),
  transport_hash char(64) NOT NULL CHECK (transport_hash ~ '^[a-f0-9]{64}$'),
  descriptor_envelope jsonb NOT NULL CHECK (jsonb_typeof(descriptor_envelope) = 'object'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, ordinal),
  UNIQUE (profile_id, transport_hash)
);
CREATE INDEX providers_profile_enabled_idx ON providers (profile_id, ordinal) WHERE enabled;

CREATE TABLE oauth_credentials (
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  credential_envelope jsonb NOT NULL CHECK (jsonb_typeof(credential_envelope) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, provider)
);

CREATE TABLE addon_collection_backups (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{8,128}$'),
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  collection_envelope jsonb NOT NULL CHECK (jsonb_typeof(collection_envelope) = 'object'),
  reason text NOT NULL CHECK (octet_length(reason) <= 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz
);
CREATE INDEX addon_collection_backups_profile_idx ON addon_collection_backups (profile_id, created_at DESC);

CREATE TABLE cloud_history (
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content_key char(64) NOT NULL CHECK (content_key ~ '^[a-f0-9]{64}$'),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  canonical_identity jsonb CHECK (canonical_identity IS NULL OR jsonb_typeof(canonical_identity) = 'object'),
  display_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(display_snapshot) = 'object'),
  position_ms bigint NOT NULL DEFAULT 0 CHECK (position_ms >= 0),
  duration_ms bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  watched_ms bigint NOT NULL DEFAULT 0 CHECK (watched_ms >= 0),
  completed boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL CHECK (revision > 0),
  last_played_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, content_key)
);
CREATE INDEX cloud_history_profile_recent_idx ON cloud_history (profile_id, last_played_at DESC);
