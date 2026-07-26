-- Dispatches created before this fence cannot prove which history generation
-- authorized them. Drop them rather than guessing, then rebuild without a
-- default so every future enqueue must supply an explicit generation.
DELETE FROM scrobble_dispatches;
ALTER TABLE scrobble_dispatches RENAME TO scrobble_dispatches_pre_history_generation;

CREATE TABLE scrobble_dispatches (
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (
    length(id) BETWEEN 8 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  profile_revision INTEGER NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id TEXT NOT NULL,
  device_generation INTEGER NOT NULL CHECK (
    device_generation BETWEEN 1 AND 9007199254740991
  ),
  history_generation INTEGER NOT NULL CHECK (
    history_generation BETWEEN 1 AND 9007199254740991
  ),
  session_id TEXT NOT NULL,
  context_id TEXT NOT NULL,
  playback_generation TEXT NOT NULL,
  context_revision TEXT NOT NULL,
  session_revision INTEGER NOT NULL CHECK (
    session_revision BETWEEN 1 AND 9007199254740991
  ),
  event TEXT NOT NULL CHECK (
    event IN ('start', 'resume', 'pause', 'stop', 'completion')
  ),
  progress REAL NOT NULL CHECK (progress >= 0 AND progress <= 100),
  payload TEXT NOT NULL CHECK (
    json_valid(payload) AND json_type(payload) = 'object' AND
    length(CAST(payload AS BLOB)) <= 65536
  ),
  required_state TEXT NOT NULL CHECK (
    required_state IN ('playing', 'paused', 'backgrounded', 'released')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'leased', 'delivered', 'revoked')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 9007199254740991
  ),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  lease_token_hash TEXT CHECK (
    lease_token_hash IS NULL OR
    (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^a-f0-9]*')
  ),
  lease_owner TEXT CHECK (
    lease_owner IS NULL OR
    (length(lease_owner) BETWEEN 8 AND 128 AND lease_owner NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  delivered_at INTEGER CHECK (delivered_at IS NULL OR delivered_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, session_id)
    REFERENCES playback_sessions(profile_id, session_id) ON DELETE CASCADE,
  CHECK (
    (status = 'leased' AND lease_token_hash IS NOT NULL AND
      lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status != 'leased' AND lease_token_hash IS NULL AND
      lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status = 'delivered' AND delivered_at IS NOT NULL AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND delivered_at IS NULL) OR
    (status IN ('queued', 'leased') AND delivered_at IS NULL AND revoked_at IS NULL)
  )
);

DROP TABLE scrobble_dispatches_pre_history_generation;
CREATE INDEX scrobble_dispatches_claim_idx
  ON scrobble_dispatches (next_attempt_at, created_at, id)
  WHERE status IN ('queued', 'leased');
CREATE INDEX scrobble_dispatches_session_idx
  ON scrobble_dispatches (profile_id, session_id, created_at, id);
CREATE INDEX scrobble_dispatches_history_generation_idx
  ON scrobble_dispatches (profile_id, history_generation, status);
