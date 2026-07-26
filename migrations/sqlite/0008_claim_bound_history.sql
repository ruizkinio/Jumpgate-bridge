-- Pre-release history and playback identity was caller-selectable. It is not
-- safe to backfill into the claim-bound protocol.
DELETE FROM scrobble_dispatches;
DELETE FROM playback_sessions;
DELETE FROM playback_source_revocations;
DELETE FROM cloud_history;

CREATE TABLE history_grant_revocations (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('profile', 'device', 'history', 'playback', 'session', 'source', 'supersession')
  ),
  scope_hash TEXT NOT NULL CHECK (
    length(scope_hash) = 64 AND scope_hash NOT GLOB '*[^a-f0-9]*'
  ),
  replacement_session_id TEXT CHECK (
    replacement_session_id IS NULL OR
    (length(replacement_session_id) BETWEEN 8 AND 128 AND
      replacement_session_id NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  revoked_at INTEGER NOT NULL CHECK (revoked_at >= 0),
  PRIMARY KEY (profile_id, kind, scope_hash),
  CHECK (
    (kind = 'supersession' AND replacement_session_id IS NOT NULL) OR
    (kind != 'supersession' AND replacement_session_id IS NULL)
  )
);

CREATE TABLE history_grants (
  grant_id TEXT PRIMARY KEY CHECK (
    length(grant_id) BETWEEN 8 AND 128 AND grant_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  attempt_id TEXT NOT NULL CHECK (
    length(attempt_id) = 36 AND attempt_id = lower(attempt_id) AND
    attempt_id GLOB '????????-????-[1-8]???-[89ab]???-????????????' AND
    attempt_id NOT GLOB '*[^0-9a-f-]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'
  ),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
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
  playback_generation TEXT NOT NULL CHECK (
    length(playback_generation) BETWEEN 4 AND 131 AND
    playback_generation GLOB 'g1:*' AND
    substr(playback_generation, 4) NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  session_id TEXT NOT NULL CHECK (
    length(session_id) BETWEEN 8 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'
  ),
  token_envelope TEXT NOT NULL CHECK (
    json_valid(token_envelope) AND json_type(token_envelope) = 'object' AND
    length(CAST(token_envelope AS BLOB)) <= 4096
  ),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'active', 'released', 'revoked', 'superseded')
  ),
  kind TEXT CHECK (kind IS NULL OR kind IN ('canonical', 'local', 'negative')),
  claim_status TEXT CHECK (
    claim_status IS NULL OR claim_status IN ('claimed', 'ambiguous', 'expired', 'not_found')
  ),
  provider_revision TEXT CHECK (
    provider_revision IS NULL OR
    (length(provider_revision) BETWEEN 1 AND 128 AND
      provider_revision NOT GLOB '*[^0-9]*' AND
      (length(provider_revision) = 1 OR substr(provider_revision, 1, 1) != '0'))
  ),
  context_id TEXT CHECK (
    context_id IS NULL OR
    (length(context_id) BETWEEN 8 AND 128 AND context_id NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  context_revision TEXT CHECK (
    context_revision IS NULL OR
    (length(context_revision) BETWEEN 1 AND 128 AND
      context_revision NOT GLOB '*[^0-9]*' AND
      (length(context_revision) = 1 OR substr(context_revision, 1, 1) != '0'))
  ),
  content_key TEXT CHECK (
    content_key IS NULL OR
    (length(content_key) = 64 AND content_key NOT GLOB '*[^a-f0-9]*')
  ),
  canonical_identity TEXT CHECK (
    canonical_identity IS NULL OR
    (json_valid(canonical_identity) AND json_type(canonical_identity) = 'object' AND
      length(CAST(canonical_identity AS BLOB)) <= 65536)
  ),
  display_snapshot TEXT CHECK (
    display_snapshot IS NULL OR
    (json_valid(display_snapshot) AND json_type(display_snapshot) = 'object' AND
      length(CAST(display_snapshot AS BLOB)) <= 65536)
  ),
  trakt_eligible INTEGER CHECK (trakt_eligible IS NULL OR trakt_eligible IN (0, 1)),
  superseded_session_id TEXT CHECK (
    superseded_session_id IS NULL OR
    (length(superseded_session_id) BETWEEN 8 AND 128 AND
      superseded_session_id NOT GLOB '*[^A-Za-z0-9_-]*')
  ),
  session_state TEXT CHECK (
    session_state IS NULL OR session_state IN ('playing', 'paused', 'backgrounded', 'released')
  ),
  session_revision INTEGER CHECK (
    session_revision IS NULL OR session_revision BETWEEN 1 AND 9007199254740991
  ),
  terminal_receipt_id TEXT CHECK (
    terminal_receipt_id IS NULL OR
    (length(terminal_receipt_id) = 36 AND terminal_receipt_id = lower(terminal_receipt_id) AND
      terminal_receipt_id GLOB '????????-????-[1-8]???-[89ab]???-????????????' AND
      terminal_receipt_id NOT GLOB '*[^0-9a-f-]*')
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  finalized_at INTEGER CHECK (finalized_at IS NULL OR finalized_at >= created_at),
  released_at INTEGER CHECK (released_at IS NULL OR released_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  superseded_at INTEGER CHECK (superseded_at IS NULL OR superseded_at >= created_at),
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL OR
    revocation_reason IN ('profile', 'device', 'history', 'playback', 'session', 'source', 'supersession')
  ),
  UNIQUE (profile_id, device_id, attempt_id),
  UNIQUE (profile_id, session_id),
  FOREIGN KEY (profile_id, device_id)
    REFERENCES devices(profile_id, id) ON DELETE CASCADE,
  FOREIGN KEY (grant_id, terminal_receipt_id)
    REFERENCES history_event_receipts(grant_id, idempotency_key)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (kind IS NULL AND claim_status IS NULL AND provider_revision IS NULL AND
      context_id IS NULL AND context_revision IS NULL AND content_key IS NULL AND
      canonical_identity IS NULL AND display_snapshot IS NULL AND trakt_eligible IS NULL AND
      superseded_session_id IS NULL AND session_state IS NULL AND session_revision IS NULL AND
      finalized_at IS NULL) OR
    (kind = 'canonical' AND claim_status = 'claimed' AND provider_revision IS NOT NULL AND
      context_id IS NOT NULL AND context_revision IS NOT NULL AND content_key IS NOT NULL AND
      canonical_identity IS NOT NULL AND display_snapshot IS NOT NULL AND trakt_eligible = 1 AND
      session_state IS NOT NULL AND session_revision IS NOT NULL AND finalized_at IS NOT NULL) OR
    (kind = 'local' AND claim_status = 'claimed' AND provider_revision IS NOT NULL AND
      context_id IS NOT NULL AND context_revision IS NOT NULL AND display_snapshot IS NOT NULL AND
      trakt_eligible = 0 AND session_state IS NOT NULL AND
      session_revision IS NOT NULL AND finalized_at IS NOT NULL) OR
    (kind = 'negative' AND claim_status IN ('ambiguous', 'expired', 'not_found') AND
      provider_revision IS NULL AND context_id IS NULL AND context_revision IS NULL AND
      content_key IS NULL AND canonical_identity IS NULL AND display_snapshot = '{}' AND
      trakt_eligible = 0 AND superseded_session_id IS NULL AND session_state IS NOT NULL AND
      session_revision IS NOT NULL AND finalized_at IS NOT NULL)
  ),
  CHECK (status != 'reserved' OR kind IS NULL),
  CHECK (status NOT IN ('active', 'released') OR kind IS NOT NULL),
  CHECK (status != 'released' OR (
    session_state = 'released' AND terminal_receipt_id IS NOT NULL AND released_at IS NOT NULL
  )),
  CHECK (status != 'revoked' OR revoked_at IS NOT NULL),
  CHECK (status != 'superseded' OR superseded_at IS NOT NULL)
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
  grant_id TEXT NOT NULL REFERENCES history_grants(grant_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) = 36 AND idempotency_key = lower(idempotency_key) AND
    idempotency_key GLOB '????????-????-[1-8]???-[89ab]???-????????????' AND
    idempotency_key NOT GLOB '*[^0-9a-f-]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^a-f0-9]*'
  ),
  event TEXT NOT NULL CHECK (
    event IN ('start', 'progress', 'pause', 'resume', 'background', 'stop', 'completion')
  ),
  terminal INTEGER NOT NULL CHECK (terminal IN (0, 1)),
  response TEXT NOT NULL CHECK (
    json_valid(response) AND json_type(response) = 'object' AND
    length(CAST(response AS BLOB)) <= 262144
  ),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (grant_id, idempotency_key),
  CHECK (terminal = (event IN ('stop', 'completion')))
);
