-- Keep bounded reservation authority and exact wire receipts without
-- rebuilding the pre-release claim-bound tables.
ALTER TABLE history_grants
  ADD COLUMN reservation_expires_at INTEGER NOT NULL DEFAULT 9007199254740991
  CHECK (reservation_expires_at >= created_at);
UPDATE history_grants
   SET reservation_expires_at = created_at + 120000;

ALTER TABLE history_grants
  ADD COLUMN claim_response_status INTEGER
  CHECK (claim_response_status IS NULL OR claim_response_status BETWEEN 100 AND 599);
ALTER TABLE history_grants
  ADD COLUMN claim_response_headers TEXT
  CHECK (
    claim_response_headers IS NULL OR
    (json_valid(claim_response_headers) AND json_type(claim_response_headers) = 'object' AND
      length(CAST(claim_response_headers AS BLOB)) <= 16384)
  );
ALTER TABLE history_grants
  ADD COLUMN claim_response_body BLOB
  CHECK (claim_response_body IS NULL OR length(claim_response_body) <= 4194304);
CREATE INDEX history_grants_reservation_expiry_idx
  ON history_grants (reservation_expires_at, created_at, grant_id)
  WHERE kind IS NULL;

ALTER TABLE history_event_receipts
  ADD COLUMN response_status INTEGER NOT NULL DEFAULT 200
  CHECK (response_status BETWEEN 100 AND 599);
ALTER TABLE history_event_receipts
  ADD COLUMN response_headers TEXT NOT NULL DEFAULT '{}'
  CHECK (
    json_valid(response_headers) AND json_type(response_headers) = 'object' AND
    length(CAST(response_headers AS BLOB)) <= 16384
  );
ALTER TABLE history_event_receipts
  ADD COLUMN response_body BLOB NOT NULL DEFAULT X''
  CHECK (length(response_body) <= 4194304);
UPDATE history_event_receipts
   SET response_body = CAST(response AS BLOB),
       response_headers = json_object(
         'cache-control', 'no-store',
         'pragma', 'no-cache',
         'content-type', 'application/json; charset=utf-8',
         'content-length', CAST(length(CAST(response AS BLOB)) AS TEXT)
       );
