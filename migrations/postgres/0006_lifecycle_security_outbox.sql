ALTER TABLE profiles
  ADD COLUMN erasure_attempt_count bigint NOT NULL DEFAULT 0 CHECK (
    erasure_attempt_count BETWEEN 0 AND 9007199254740991
  ),
  ADD COLUMN erasure_next_attempt_at timestamptz;

UPDATE profiles
SET erasure_next_attempt_at = deletion_started_at
WHERE deletion_state = 'pending' AND erasure_next_attempt_at IS NULL;

CREATE INDEX profiles_pending_erasure_eligible_idx
  ON profiles (erasure_next_attempt_at, deletion_started_at, id)
  WHERE deletion_state = 'pending';

CREATE TABLE lifecycle_invalidations (
  id char(64) PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('profile', 'device')),
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_revision bigint NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id text CHECK (
    device_id IS NULL OR device_id ~ '^[A-Za-z0-9_-]{8,128}$'
  ),
  device_generation bigint CHECK (
    device_generation IS NULL OR device_generation BETWEEN 1 AND 9007199254740991
  ),
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 9007199254740991
  ),
  next_attempt_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at >= created_at),
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
  md5('jumpgate-lifecycle-existing-a:' || id || ':' || revision::text) ||
    md5('jumpgate-lifecycle-existing-b:' || id || ':' || revision::text),
  'profile', id, revision, NULL, NULL, 0, updated_at, updated_at, updated_at
FROM profiles
WHERE status = 'revoked'
ON CONFLICT (id) DO NOTHING;
