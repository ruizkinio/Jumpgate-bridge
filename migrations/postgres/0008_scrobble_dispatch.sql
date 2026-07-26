CREATE TABLE playback_source_revocations (
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  context_id text NOT NULL CHECK (context_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  playback_generation text NOT NULL CHECK (
    playback_generation ~ '^g1:[A-Za-z0-9_-]{1,128}$'
  ),
  context_revision text NOT NULL CHECK (
    context_revision ~ '^(0|[1-9][0-9]{0,127})$'
  ),
  revoked_at timestamptz NOT NULL,
  PRIMARY KEY (profile_id, context_id, playback_generation, context_revision)
);

CREATE TABLE playback_sessions (
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  profile_revision bigint NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id text NOT NULL,
  device_generation bigint NOT NULL CHECK (
    device_generation BETWEEN 1 AND 9007199254740991
  ),
  context_id text NOT NULL CHECK (context_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  playback_generation text NOT NULL CHECK (
    playback_generation ~ '^g1:[A-Za-z0-9_-]{1,128}$'
  ),
  context_revision text NOT NULL CHECK (
    context_revision ~ '^(0|[1-9][0-9]{0,127})$'
  ),
  state text NOT NULL CHECK (
    state IN ('playing', 'paused', 'backgrounded', 'released')
  ),
  revision bigint NOT NULL DEFAULT 1 CHECK (
    revision BETWEEN 1 AND 9007199254740991
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  PRIMARY KEY (profile_id, session_id),
  FOREIGN KEY (profile_id, device_id)
    REFERENCES devices(profile_id, id) ON DELETE CASCADE,
  CHECK (updated_at >= created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
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
  profile_id text NOT NULL,
  id text NOT NULL CHECK (id ~ '^[A-Za-z0-9_-]{8,128}$'),
  profile_revision bigint NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id text NOT NULL,
  device_generation bigint NOT NULL CHECK (
    device_generation BETWEEN 1 AND 9007199254740991
  ),
  session_id text NOT NULL,
  context_id text NOT NULL,
  playback_generation text NOT NULL,
  context_revision text NOT NULL,
  session_revision bigint NOT NULL CHECK (
    session_revision BETWEEN 1 AND 9007199254740991
  ),
  event text NOT NULL CHECK (
    event IN ('start', 'resume', 'pause', 'stop', 'completion')
  ),
  progress double precision NOT NULL CHECK (progress >= 0 AND progress <= 100),
  payload jsonb NOT NULL CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4194304
  ),
  required_state text NOT NULL CHECK (
    required_state IN ('playing', 'paused', 'backgrounded', 'released')
  ),
  status text NOT NULL CHECK (
    status IN ('queued', 'leased', 'delivered', 'revoked')
  ),
  attempt_count bigint NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 9007199254740991
  ),
  next_attempt_at timestamptz NOT NULL,
  lease_token_hash char(64) CHECK (
    lease_token_hash IS NULL OR lease_token_hash ~ '^[a-f0-9]{64}$'
  ),
  lease_owner text CHECK (
    lease_owner IS NULL OR lease_owner ~ '^[A-Za-z0-9_-]{8,128}$'
  ),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  delivered_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (profile_id, id),
  FOREIGN KEY (profile_id, session_id)
    REFERENCES playback_sessions(profile_id, session_id) ON DELETE CASCADE,
  CHECK (updated_at >= created_at),
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
