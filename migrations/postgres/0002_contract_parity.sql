ALTER TABLE provider_collections
  ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0);

ALTER TABLE devices
  ADD COLUMN pairing_id text UNIQUE CHECK (
    pairing_id IS NULL OR pairing_id ~ '^[A-Za-z0-9_-]{8,128}$'
  );

ALTER TABLE cloud_history
  ADD COLUMN playback_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(playback_snapshot) = 'object'),
  ADD COLUMN deleted_at timestamptz;

COMMENT ON COLUMN cloud_history.playback_snapshot IS
  'Sanitized IDs and preferences only; never raw source URLs or credentials';

CREATE SEQUENCE cloud_history_change_seq AS bigint;
ALTER TABLE cloud_history ADD COLUMN change_seq bigint;
UPDATE cloud_history SET change_seq = nextval('cloud_history_change_seq') WHERE change_seq IS NULL;
ALTER TABLE cloud_history
  ALTER COLUMN change_seq SET DEFAULT nextval('cloud_history_change_seq'),
  ALTER COLUMN change_seq SET NOT NULL;
ALTER SEQUENCE cloud_history_change_seq OWNED BY cloud_history.change_seq;

CREATE UNIQUE INDEX cloud_history_change_seq_idx ON cloud_history (change_seq);
CREATE INDEX cloud_history_profile_changes_idx ON cloud_history (profile_id, change_seq);
CREATE INDEX cloud_history_profile_page_idx
  ON cloud_history (profile_id, last_played_at DESC, revision DESC, content_key);

CREATE TABLE legacy_config_aliases (
  legacy_config_hash char(64) PRIMARY KEY CHECK (legacy_config_hash ~ '^[a-f0-9]{64}$'),
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX legacy_config_aliases_profile_idx ON legacy_config_aliases (profile_id);
INSERT INTO legacy_config_aliases (legacy_config_hash, profile_id)
  SELECT legacy_config_hash, id FROM profiles WHERE legacy_config_hash IS NOT NULL
  ON CONFLICT (legacy_config_hash) DO NOTHING;

ALTER TABLE profiles
  ADD CONSTRAINT profiles_revision_js_safe CHECK (revision <= 9007199254740991),
  ADD CONSTRAINT profiles_settings_envelope_size
    CHECK (settings_envelope IS NULL OR octet_length(settings_envelope::text) <= 1048576);
ALTER TABLE provider_collections
  ADD CONSTRAINT provider_collections_revision_js_safe CHECK (revision <= 9007199254740991);
ALTER TABLE providers
  ADD CONSTRAINT providers_descriptor_envelope_size
    CHECK (octet_length(descriptor_envelope::text) <= 65536);
ALTER TABLE oauth_credentials
  ADD CONSTRAINT oauth_credentials_revision_js_safe CHECK (revision <= 9007199254740991),
  ADD CONSTRAINT oauth_credentials_envelope_size
    CHECK (octet_length(credential_envelope::text) <= 65536);
ALTER TABLE addon_collection_backups
  ADD CONSTRAINT addon_collection_backups_envelope_size
    CHECK (octet_length(collection_envelope::text) <= 4194304);
ALTER TABLE cloud_history
  ADD CONSTRAINT cloud_history_position_js_safe CHECK (position_ms <= 9007199254740991),
  ADD CONSTRAINT cloud_history_duration_js_safe CHECK (duration_ms <= 9007199254740991),
  ADD CONSTRAINT cloud_history_watched_js_safe CHECK (watched_ms <= 9007199254740991),
  ADD CONSTRAINT cloud_history_revision_js_safe CHECK (revision <= 9007199254740991),
  ADD CONSTRAINT cloud_history_change_seq_js_safe CHECK (change_seq <= 9007199254740991),
  ADD CONSTRAINT cloud_history_deleted_at_valid
    CHECK (deleted_at IS NULL OR deleted_at >= last_played_at),
  ADD CONSTRAINT cloud_history_display_snapshot_size
    CHECK (octet_length(display_snapshot::text) <= 65536),
  ADD CONSTRAINT cloud_history_playback_snapshot_size
    CHECK (octet_length(playback_snapshot::text) <= 65536);
