-- Pre-release history and playback identity was caller-selectable. It is not
-- safe to backfill into the claim-bound protocol.
DELETE FROM scrobble_dispatches;
DELETE FROM playback_sessions;
DELETE FROM playback_source_revocations;
DELETE FROM cloud_history;

CREATE TABLE history_grant_revocations (
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (
    kind IN ('profile', 'device', 'history', 'playback', 'session', 'source', 'supersession')
  ),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  replacement_session_id text CHECK (
    replacement_session_id IS NULL OR
    replacement_session_id ~ '^[A-Za-z0-9_-]{8,128}$'
  ),
  revoked_at timestamptz NOT NULL,
  PRIMARY KEY (profile_id, kind, scope_hash),
  CHECK (
    (kind = 'supersession' AND replacement_session_id IS NOT NULL) OR
    (kind != 'supersession' AND replacement_session_id IS NULL)
  )
);

CREATE TABLE history_grants (
  grant_id text PRIMARY KEY CHECK (grant_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  attempt_id uuid NOT NULL CHECK (
    attempt_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  profile_id text NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  profile_revision bigint NOT NULL CHECK (
    profile_revision BETWEEN 1 AND 9007199254740991
  ),
  device_id text NOT NULL,
  device_generation bigint NOT NULL CHECK (
    device_generation BETWEEN 1 AND 9007199254740991
  ),
  history_generation bigint NOT NULL CHECK (
    history_generation BETWEEN 1 AND 9007199254740991
  ),
  playback_generation text NOT NULL CHECK (
    playback_generation ~ '^g1:[A-Za-z0-9_-]{1,128}$'
  ),
  session_id text NOT NULL CHECK (session_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_envelope jsonb NOT NULL CHECK (
    jsonb_typeof(token_envelope) = 'object' AND
    octet_length(token_envelope::text) <= 4096
  ),
  status text NOT NULL CHECK (
    status IN ('reserved', 'active', 'released', 'revoked', 'superseded')
  ),
  kind text CHECK (kind IS NULL OR kind IN ('canonical', 'local', 'negative')),
  claim_status text CHECK (
    claim_status IS NULL OR claim_status IN ('claimed', 'ambiguous', 'expired', 'not_found')
  ),
  provider_revision text CHECK (
    provider_revision IS NULL OR provider_revision ~ '^(0|[1-9][0-9]{0,127})$'
  ),
  context_id text CHECK (
    context_id IS NULL OR context_id ~ '^[A-Za-z0-9_-]{8,128}$'
  ),
  context_revision text CHECK (
    context_revision IS NULL OR context_revision ~ '^(0|[1-9][0-9]{0,127})$'
  ),
  content_key char(64) CHECK (
    content_key IS NULL OR content_key ~ '^[a-f0-9]{64}$'
  ),
  canonical_identity jsonb CHECK (
    canonical_identity IS NULL OR
    (jsonb_typeof(canonical_identity) = 'object' AND
      octet_length(canonical_identity::text) <= 4194304)
  ),
  display_snapshot jsonb CHECK (
    display_snapshot IS NULL OR
    (jsonb_typeof(display_snapshot) = 'object' AND
      octet_length(display_snapshot::text) <= 4194304)
  ),
  trakt_eligible boolean,
  superseded_session_id text CHECK (
    superseded_session_id IS NULL OR
    superseded_session_id ~ '^[A-Za-z0-9_-]{8,128}$'
  ),
  session_state text CHECK (
    session_state IS NULL OR session_state IN ('playing', 'paused', 'backgrounded', 'released')
  ),
  session_revision bigint CHECK (
    session_revision IS NULL OR session_revision BETWEEN 1 AND 9007199254740991
  ),
  terminal_receipt_id uuid CHECK (
    terminal_receipt_id IS NULL OR
    terminal_receipt_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  created_at timestamptz NOT NULL,
  finalized_at timestamptz,
  released_at timestamptz,
  revoked_at timestamptz,
  superseded_at timestamptz,
  revocation_reason text CHECK (
    revocation_reason IS NULL OR
    revocation_reason IN ('profile', 'device', 'history', 'playback', 'session', 'source', 'supersession')
  ),
  UNIQUE (profile_id, device_id, attempt_id),
  UNIQUE (profile_id, session_id),
  FOREIGN KEY (profile_id, device_id)
    REFERENCES devices(profile_id, id) ON DELETE CASCADE,
  CHECK (
    (kind IS NULL AND claim_status IS NULL AND provider_revision IS NULL AND
      context_id IS NULL AND context_revision IS NULL AND content_key IS NULL AND
      canonical_identity IS NULL AND display_snapshot IS NULL AND trakt_eligible IS NULL AND
      superseded_session_id IS NULL AND session_state IS NULL AND session_revision IS NULL AND
      finalized_at IS NULL) OR
    (kind = 'canonical' AND claim_status = 'claimed' AND provider_revision IS NOT NULL AND
      context_id IS NOT NULL AND context_revision IS NOT NULL AND content_key IS NOT NULL AND
      canonical_identity IS NOT NULL AND display_snapshot IS NOT NULL AND trakt_eligible = true AND
      session_state IS NOT NULL AND session_revision IS NOT NULL AND finalized_at IS NOT NULL) OR
    (kind = 'local' AND claim_status = 'claimed' AND provider_revision IS NOT NULL AND
      context_id IS NOT NULL AND context_revision IS NOT NULL AND display_snapshot IS NOT NULL AND
      trakt_eligible = false AND session_state IS NOT NULL AND
      session_revision IS NOT NULL AND finalized_at IS NOT NULL) OR
    (kind = 'negative' AND claim_status IN ('ambiguous', 'expired', 'not_found') AND
      provider_revision IS NULL AND context_id IS NULL AND context_revision IS NULL AND
      content_key IS NULL AND canonical_identity IS NULL AND display_snapshot = '{}'::jsonb AND
      trakt_eligible = false AND superseded_session_id IS NULL AND session_state IS NOT NULL AND
      session_revision IS NOT NULL AND finalized_at IS NOT NULL)
  ),
  CHECK (status != 'reserved' OR kind IS NULL),
  CHECK (status NOT IN ('active', 'released') OR kind IS NOT NULL),
  CHECK (status != 'released' OR (
    session_state = 'released' AND terminal_receipt_id IS NOT NULL AND released_at IS NOT NULL
  )),
  CHECK (status != 'revoked' OR revoked_at IS NOT NULL),
  CHECK (status != 'superseded' OR superseded_at IS NOT NULL),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK (superseded_at IS NULL OR superseded_at >= created_at)
);
CREATE INDEX history_grants_profile_state_idx
  ON history_grants (profile_id, status, created_at, grant_id);
CREATE INDEX history_grants_device_generation_idx
  ON history_grants (profile_id, device_id, device_generation, status);
CREATE INDEX history_grants_history_generation_idx
  ON history_grants (profile_id, history_generation, status);
CREATE INDEX history_grants_playback_generation_idx
  ON history_grants (profile_id, playback_generation, status);
CREATE INDEX history_grants_source_idx
  ON history_grants (
    profile_id, context_id, playback_generation, provider_revision, context_revision, status
  );

CREATE TABLE history_event_receipts (
  grant_id text NOT NULL REFERENCES history_grants(grant_id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL CHECK (
    idempotency_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  event text NOT NULL CHECK (
    event IN ('start', 'progress', 'pause', 'resume', 'background', 'stop', 'completion')
  ),
  terminal boolean NOT NULL,
  response jsonb NOT NULL CHECK (
    jsonb_typeof(response) = 'object' AND octet_length(response::text) <= 4194304
  ),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (grant_id, idempotency_key),
  CHECK (terminal = (event IN ('stop', 'completion')))
);

ALTER TABLE history_grants
  ADD CONSTRAINT history_grants_terminal_receipt_fkey
  FOREIGN KEY (grant_id, terminal_receipt_id)
  REFERENCES history_event_receipts(grant_id, idempotency_key)
  DEFERRABLE INITIALLY DEFERRED;
