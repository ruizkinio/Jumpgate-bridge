ALTER TABLE profiles
  ADD COLUMN history_generation INTEGER NOT NULL DEFAULT 1 CHECK (
    history_generation BETWEEN 1 AND 9007199254740991
  );

ALTER TABLE profiles
  ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'none' CHECK (
    deletion_state IN ('none', 'pending', 'deleted')
  );

ALTER TABLE profiles
  ADD COLUMN deletion_started_at INTEGER CHECK (
    deletion_started_at IS NULL OR deletion_started_at >= 0
  );

ALTER TABLE profiles
  ADD COLUMN durable_erased_at INTEGER CHECK (
    durable_erased_at IS NULL OR durable_erased_at >= 0
  );

ALTER TABLE devices
  ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (
    generation BETWEEN 1 AND 9007199254740991
  );

CREATE INDEX profiles_pending_erasure_idx
  ON profiles (deletion_started_at, id) WHERE deletion_state = 'pending';
