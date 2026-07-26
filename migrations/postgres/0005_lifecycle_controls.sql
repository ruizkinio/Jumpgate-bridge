ALTER TABLE profiles
  ADD COLUMN history_generation bigint NOT NULL DEFAULT 1
    CHECK (history_generation BETWEEN 1 AND 9007199254740991),
  ADD COLUMN deletion_state text NOT NULL DEFAULT 'none'
    CHECK (deletion_state IN ('none', 'pending', 'deleted')),
  ADD COLUMN deletion_started_at timestamptz,
  ADD COLUMN durable_erased_at timestamptz;

ALTER TABLE devices
  ADD COLUMN generation bigint NOT NULL DEFAULT 1
    CHECK (generation BETWEEN 1 AND 9007199254740991);

CREATE INDEX profiles_pending_erasure_idx
  ON profiles (deletion_started_at, id) WHERE deletion_state = 'pending';
