ALTER TABLE profiles
  ADD COLUMN erasure_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    erasure_attempt_count BETWEEN 0 AND 9007199254740991
  );

ALTER TABLE profiles
  ADD COLUMN erasure_next_attempt_at INTEGER CHECK (
    erasure_next_attempt_at IS NULL OR erasure_next_attempt_at >= 0
  );

UPDATE profiles
SET erasure_next_attempt_at = deletion_started_at
WHERE deletion_state = 'pending' AND erasure_next_attempt_at IS NULL;

CREATE INDEX profiles_pending_erasure_eligible_idx
  ON profiles (erasure_next_attempt_at, deletion_started_at, id)
  WHERE deletion_state = 'pending';

CREATE TABLE lifecycle_invalidations (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 64 AND id NOT GLOB '*[^a-f0-9]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('profile', 'device')),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_revision INTEGER NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id TEXT CHECK (
    device_id IS NULL OR (
      length(device_id) BETWEEN 8 AND 128 AND device_id NOT GLOB '*[^A-Za-z0-9_-]*'
    )
  ),
  device_generation INTEGER CHECK (
    device_generation IS NULL OR device_generation BETWEEN 1 AND 9007199254740991
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 9007199254740991
  ),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK (
    (kind = 'profile' AND device_id IS NULL AND device_generation IS NULL) OR
    (kind = 'device' AND device_id IS NOT NULL AND device_generation IS NOT NULL)
  )
);

CREATE INDEX lifecycle_invalidations_eligible_idx
  ON lifecycle_invalidations (next_attempt_at, created_at, id);
CREATE INDEX lifecycle_invalidations_scope_idx
  ON lifecycle_invalidations (kind, profile_id, device_id, created_at DESC, id DESC);

INSERT INTO lifecycle_invalidations (
  id, kind, profile_id, profile_revision, device_id, device_generation,
  attempt_count, next_attempt_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(32))), 'profile', id, revision, NULL, NULL,
  0, updated_at, updated_at, updated_at
FROM profiles
WHERE status = 'revoked';
