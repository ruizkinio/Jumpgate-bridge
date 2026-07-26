CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64 AND checksum NOT GLOB '*[^a-f0-9]*'
  ),
  applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
);

CREATE TABLE profiles (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 8 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  install_token_hash TEXT NOT NULL UNIQUE CHECK (
    length(install_token_hash) = 64 AND install_token_hash NOT GLOB '*[^a-f0-9]*'
  ),
  display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 128),
  settings_envelope TEXT CHECK (
    settings_envelope IS NULL OR
    (json_valid(settings_envelope) AND length(CAST(settings_envelope AS BLOB)) <= 1048576)
  ),
  legacy_config_hash TEXT UNIQUE CHECK (
    legacy_config_hash IS NULL OR
    (length(legacy_config_hash) = 64 AND legacy_config_hash NOT GLOB '*[^a-f0-9]*')
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0),
  CHECK (
    (status = 'active' AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 8 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  pairing_id TEXT UNIQUE CHECK (
    pairing_id IS NULL OR
    (length(pairing_id) BETWEEN 8 AND 128 AND pairing_id NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'
  ),
  display_name TEXT NOT NULL DEFAULT '' CHECK (length(display_name) <= 128),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= 0)
);
CREATE INDEX devices_profile_active_idx
  ON devices (profile_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE provider_collections (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

-- Ciphertext uses the plaintext byte length; base64url plus 170 bytes covers
-- maximum envelope metadata and PostgreSQL jsonb text spacing across adapters.
CREATE TABLE providers (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 8 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  manifest_id TEXT NOT NULL DEFAULT '' CHECK (length(manifest_id) <= 256),
  transport_hash TEXT NOT NULL CHECK (
    length(transport_hash) = 64 AND transport_hash NOT GLOB '*[^a-f0-9]*'
  ),
  descriptor_envelope TEXT NOT NULL CHECK (
    json_valid(descriptor_envelope) AND
    length(CAST(descriptor_envelope AS BLOB)) <= 87552
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (profile_id, ordinal),
  UNIQUE (profile_id, transport_hash)
);
CREATE INDEX providers_profile_ordinal_idx ON providers (profile_id, ordinal);

CREATE TABLE oauth_credentials (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (
    length(provider) BETWEEN 1 AND 64 AND
    provider GLOB '[a-z]*' AND provider NOT GLOB '*[^a-z0-9_-]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  credential_envelope TEXT NOT NULL CHECK (
    json_valid(credential_envelope) AND
    length(CAST(credential_envelope AS BLOB)) <= 87552
  ),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (profile_id, provider)
);

CREATE TABLE addon_collection_backups (
  id TEXT PRIMARY KEY CHECK (
    length(id) BETWEEN 8 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  collection_envelope TEXT NOT NULL CHECK (
    json_valid(collection_envelope) AND
    length(CAST(collection_envelope AS BLOB)) <= 5592576
  ),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  restored_at INTEGER CHECK (restored_at IS NULL OR restored_at >= 0)
);
CREATE INDEX addon_collection_backups_profile_idx
  ON addon_collection_backups (profile_id, created_at DESC, id);
