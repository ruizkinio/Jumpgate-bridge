-- Pre-fence dispatches have no trustworthy history generation. Fail closed by
-- dropping them before making the generation mandatory for every new row.
DELETE FROM scrobble_dispatches;
ALTER TABLE scrobble_dispatches
  ADD COLUMN history_generation bigint NOT NULL CHECK (
    history_generation BETWEEN 1 AND 9007199254740991
  );
CREATE INDEX scrobble_dispatches_history_generation_idx
  ON scrobble_dispatches (profile_id, history_generation, status);
