ALTER TABLE devices
  ADD CONSTRAINT devices_profile_id_id_key UNIQUE (profile_id, id);

CREATE TABLE subtitle_object_manifests (
  artifact_id text PRIMARY KEY CHECK (artifact_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  profile_id text NOT NULL,
  profile_revision bigint NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id text NOT NULL,
  device_generation bigint NOT NULL CHECK (
    device_generation BETWEEN 1 AND 9007199254740991
  ),
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  playback_generation text NOT NULL CHECK (
    octet_length(playback_generation) BETWEEN 1 AND 256
  ),
  context_revision numeric(128, 0) NOT NULL CHECK (context_revision >= 0),
  provider_revision numeric(128, 0) NOT NULL CHECK (provider_revision >= 0),
  expires_at timestamptz NOT NULL,
  upload_settlement_deadline timestamptz NOT NULL,
  state text NOT NULL CHECK (
    state IN ('uploading', 'active', 'deletion_requested', 'first_absent')
  ),
  deletion_reason text CHECK (
    deletion_reason IS NULL OR octet_length(deletion_reason) BETWEEN 1 AND 64
  ),
  next_attempt_at timestamptz NOT NULL,
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 9007199254740991
  ),
  first_absent_at timestamptz,
  lease_token_hash char(64) CHECK (
    lease_token_hash IS NULL OR lease_token_hash ~ '^[a-f0-9]{64}$'
  ),
  lease_owner text CHECK (
    lease_owner IS NULL OR octet_length(lease_owner) BETWEEN 1 AND 256
  ),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE RESTRICT,
  FOREIGN KEY (profile_id, device_id)
    REFERENCES devices(profile_id, id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
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
  artifact_id text NOT NULL REFERENCES subtitle_object_manifests(artifact_id) ON DELETE CASCADE,
  part_number smallint NOT NULL CHECK (part_number BETWEEN 1 AND 2),
  object_key text NOT NULL UNIQUE CHECK (octet_length(object_key) BETWEEN 1 AND 1024),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 67108864),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL CHECK (octet_length(media_type) BETWEEN 1 AND 128),
  PRIMARY KEY (artifact_id, part_number)
);

CREATE INDEX subtitle_object_manifests_profile_idx
  ON subtitle_object_manifests (profile_id, created_at, artifact_id);
CREATE INDEX subtitle_object_manifests_device_idx
  ON subtitle_object_manifests (profile_id, device_id, created_at, artifact_id);
CREATE INDEX subtitle_object_manifests_eligible_idx
  ON subtitle_object_manifests (next_attempt_at, created_at, artifact_id)
  WHERE state IN ('deletion_requested', 'first_absent');
