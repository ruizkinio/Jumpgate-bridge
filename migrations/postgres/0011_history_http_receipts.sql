-- Claim reservations are short-lived, while successful HTTP responses are
-- replayed from durable exact bytes rather than reconstructed JSONB.
ALTER TABLE history_grants
  ADD COLUMN reservation_expires_at timestamptz;
UPDATE history_grants
   SET reservation_expires_at = created_at + interval '2 minutes';
ALTER TABLE history_grants
  ALTER COLUMN reservation_expires_at SET NOT NULL;

ALTER TABLE history_grants
  ADD COLUMN claim_response_status integer,
  ADD COLUMN claim_response_headers jsonb,
  ADD COLUMN claim_response_body bytea;
ALTER TABLE history_grants
  ADD CONSTRAINT history_grants_claim_response_shape CHECK (
    (claim_response_status IS NULL AND claim_response_headers IS NULL AND
      claim_response_body IS NULL) OR
    (claim_response_status BETWEEN 100 AND 599 AND
      jsonb_typeof(claim_response_headers) = 'object' AND
      octet_length(claim_response_headers::text) <= 16384 AND
      octet_length(claim_response_body) <= 4194304)
  );
CREATE INDEX history_grants_reservation_expiry_idx
  ON history_grants (reservation_expires_at, created_at, grant_id)
  WHERE kind IS NULL;

ALTER TABLE history_event_receipts
  ADD COLUMN response_status integer,
  ADD COLUMN response_headers jsonb,
  ADD COLUMN response_body bytea;
UPDATE history_event_receipts
   SET response_status = 200,
       response_body = convert_to(response::text, 'UTF8'),
       response_headers = jsonb_build_object(
         'cache-control', 'no-store',
         'pragma', 'no-cache',
         'content-type', 'application/json; charset=utf-8',
         'content-length', octet_length(convert_to(response::text, 'UTF8'))::text
       );
ALTER TABLE history_event_receipts
  ALTER COLUMN response_status SET NOT NULL,
  ALTER COLUMN response_headers SET NOT NULL,
  ALTER COLUMN response_body SET NOT NULL;
ALTER TABLE history_event_receipts
  ADD CONSTRAINT history_event_receipts_http_shape CHECK (
    response_status BETWEEN 100 AND 599 AND
    jsonb_typeof(response_headers) = 'object' AND
    octet_length(response_headers::text) <= 16384 AND
    octet_length(response_body) <= 4194304
  );
