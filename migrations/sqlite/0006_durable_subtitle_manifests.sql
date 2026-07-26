CREATE UNIQUE INDEX devices_profile_id_id_key ON devices (profile_id, id);

CREATE TABLE subtitle_object_manifests (
  artifact_id TEXT PRIMARY KEY CHECK (
    length(artifact_id) BETWEEN 8 AND 128 AND artifact_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  profile_id TEXT NOT NULL,
  profile_revision INTEGER NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id TEXT NOT NULL,
  device_generation INTEGER NOT NULL CHECK (
    device_generation BETWEEN 1 AND 9007199254740991
  ),
  session_id TEXT NOT NULL CHECK (
    length(session_id) BETWEEN 8 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  playback_generation TEXT NOT NULL CHECK (
    length(CAST(playback_generation AS BLOB)) BETWEEN 1 AND 256
  ),
  context_revision TEXT NOT NULL CHECK (
    length(context_revision) BETWEEN 1 AND 128 AND
    context_revision NOT GLOB '*[^0-9]*' AND
    (length(context_revision) = 1 OR substr(context_revision, 1, 1) != '0')
  ),
  provider_revision TEXT NOT NULL CHECK (
    length(provider_revision) BETWEEN 1 AND 128 AND
    provider_revision NOT GLOB '*[^0-9]*' AND
    (length(provider_revision) = 1 OR substr(provider_revision, 1, 1) != '0')
  ),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  upload_settlement_deadline INTEGER NOT NULL CHECK (upload_settlement_deadline >= 0),
  state TEXT NOT NULL CHECK (
    state IN ('uploading', 'active', 'deletion_requested', 'first_absent')
  ),
  deletion_reason TEXT CHECK (
    deletion_reason IS NULL OR length(CAST(deletion_reason AS BLOB)) BETWEEN 1 AND 64
  ),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 9007199254740991
  ),
  first_absent_at INTEGER CHECK (first_absent_at IS NULL OR first_absent_at >= 0),
  lease_token_hash TEXT CHECK (
    lease_token_hash IS NULL OR
    (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^a-f0-9]*')
  ),
  lease_owner TEXT CHECK (
    lease_owner IS NULL OR length(CAST(lease_owner AS BLOB)) BETWEEN 1 AND 256
  ),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id, device_id)
    REFERENCES devices(profile_id, id) ON DELETE RESTRICT,
  CHECK (
    (lease_token_hash IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (lease_token_hash IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state = 'uploading' AND deletion_reason IS NULL AND first_absent_at IS NULL) OR
    (state = 'active' AND deletion_reason IS NULL AND first_absent_at IS NULL) OR
    (state = 'deletion_requested' AND deletion_reason IS NOT NULL AND first_absent_at IS NULL) OR
    (state = 'first_absent' AND deletion_reason IS NOT NULL AND first_absent_at IS NOT NULL)
  )
);

CREATE TABLE subtitle_object_manifest_parts (
  artifact_id TEXT NOT NULL REFERENCES subtitle_object_manifests(artifact_id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 2),
  object_key TEXT NOT NULL UNIQUE CHECK (
    length(CAST(object_key AS BLOB)) BETWEEN 1 AND 1024
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  checksum TEXT NOT NULL CHECK (
    length(checksum) = 64 AND checksum NOT GLOB '*[^a-f0-9]*'
  ),
  media_type TEXT NOT NULL CHECK (
    length(CAST(media_type AS BLOB)) BETWEEN 1 AND 128
  ),
  PRIMARY KEY (artifact_id, part_number)
);

CREATE INDEX subtitle_object_manifests_profile_idx
  ON subtitle_object_manifests (profile_id, created_at, artifact_id);
CREATE INDEX subtitle_object_manifests_device_idx
  ON subtitle_object_manifests (profile_id, device_id, created_at, artifact_id);
CREATE INDEX subtitle_object_manifests_eligible_idx
  ON subtitle_object_manifests (next_attempt_at, created_at, artifact_id)
  WHERE state IN ('deletion_requested', 'first_absent');
