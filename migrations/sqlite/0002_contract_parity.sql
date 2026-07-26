CREATE TABLE history_sequence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 9007199254740991)
);
INSERT INTO history_sequence (singleton, value) VALUES (1, 0);

CREATE TABLE cloud_history (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  content_key TEXT NOT NULL CHECK (
    length(content_key) = 64 AND content_key NOT GLOB '*[^a-f0-9]*'
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  canonical_identity TEXT CHECK (
    canonical_identity IS NULL OR
    (json_valid(canonical_identity) AND length(CAST(canonical_identity AS BLOB)) <= 65536)
  ),
  display_snapshot TEXT NOT NULL CHECK (
    json_valid(display_snapshot) AND length(CAST(display_snapshot AS BLOB)) <= 65536
  ),
  playback_snapshot TEXT NOT NULL CHECK (
    json_valid(playback_snapshot) AND length(CAST(playback_snapshot AS BLOB)) <= 65536
  ),
  position_ms INTEGER NOT NULL CHECK (position_ms BETWEEN 0 AND 9007199254740991),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 9007199254740991),
  watched_ms INTEGER NOT NULL CHECK (watched_ms BETWEEN 0 AND 9007199254740991),
  completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  change_sequence INTEGER NOT NULL UNIQUE CHECK (
    change_sequence BETWEEN 1 AND 9007199254740991
  ),
  last_played_at INTEGER NOT NULL CHECK (last_played_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  deleted_at INTEGER CHECK (deleted_at IS NULL OR deleted_at >= last_played_at),
  PRIMARY KEY (profile_id, content_key)
);
CREATE INDEX cloud_history_profile_recent_idx
  ON cloud_history (profile_id, last_played_at DESC, revision DESC, content_key);
CREATE INDEX cloud_history_profile_changes_idx
  ON cloud_history (profile_id, change_sequence);

CREATE TABLE legacy_config_aliases (
  legacy_config_hash TEXT PRIMARY KEY CHECK (
    length(legacy_config_hash) = 64 AND legacy_config_hash NOT GLOB '*[^a-f0-9]*'
  ),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
);
CREATE INDEX legacy_config_aliases_profile_idx ON legacy_config_aliases (profile_id);
INSERT INTO legacy_config_aliases (legacy_config_hash, profile_id, created_at)
  SELECT legacy_config_hash, id, created_at
  FROM profiles
  WHERE legacy_config_hash IS NOT NULL
  ON CONFLICT (legacy_config_hash) DO NOTHING;
