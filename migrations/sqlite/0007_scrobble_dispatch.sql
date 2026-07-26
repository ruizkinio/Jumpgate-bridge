CREATE TABLE playback_source_revocations (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL CHECK (
    length(context_id) BETWEEN 8 AND 128 AND context_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  playback_generation TEXT NOT NULL CHECK (
    length(playback_generation) BETWEEN 4 AND 131 AND
    playback_generation GLOB 'g1:*' AND
    substr(playback_generation, 4) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  context_revision TEXT NOT NULL CHECK (
    length(context_revision) BETWEEN 1 AND 128 AND
    context_revision NOT GLOB '*[^0-9]*' AND
    (length(context_revision) = 1 OR substr(context_revision, 1, 1) != '0')
  ),
  revoked_at INTEGER NOT NULL CHECK (revoked_at >= 0),
  PRIMARY KEY (profile_id, context_id, playback_generation, context_revision)
);

CREATE TABLE playback_sessions (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK (
    length(session_id) BETWEEN 8 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  profile_revision INTEGER NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id TEXT NOT NULL,
  device_generation INTEGER NOT NULL CHECK (
    device_generation BETWEEN 1 AND 9007199254740991
  ),
  context_id TEXT NOT NULL CHECK (
    length(context_id) BETWEEN 8 AND 128 AND context_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  playback_generation TEXT NOT NULL CHECK (
    length(playback_generation) BETWEEN 4 AND 131 AND
    playback_generation GLOB 'g1:*' AND
    substr(playback_generation, 4) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  context_revision TEXT NOT NULL CHECK (
    length(context_revision) BETWEEN 1 AND 128 AND
    context_revision NOT GLOB '*[^0-9]*' AND
    (length(context_revision) = 1 OR substr(context_revision, 1, 1) != '0')
  ),
  state TEXT NOT NULL CHECK (
    state IN ('playing', 'paused', 'backgrounded', 'released')
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  invalidated_at INTEGER CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
  PRIMARY KEY (profile_id, session_id),
  FOREIGN KEY (profile_id, device_id)
    REFERENCES devices(profile_id, id) ON DELETE CASCADE,
  CHECK (
    (state = 'released' AND invalidated_at IS NOT NULL) OR
    (state != 'released' AND invalidated_at IS NULL)
  )
);
CREATE INDEX playback_sessions_device_idx
  ON playback_sessions (profile_id, device_id, device_generation, state);
CREATE INDEX playback_sessions_source_idx
  ON playback_sessions (
    profile_id, context_id, playback_generation, context_revision, state
  );

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
CREATE INDEX scrobble_dispatches_claim_idx
  ON scrobble_dispatches (next_attempt_at, created_at, id)
  WHERE status IN ('queued', 'leased');
CREATE INDEX scrobble_dispatches_session_idx
  ON scrobble_dispatches (profile_id, session_id, created_at, id);
