-- AES-GCM ciphertext has the plaintext byte length. Base64url expansion plus
-- 170 bytes covers maximum envelope metadata and jsonb text separators.
ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_descriptor_envelope_size;
ALTER TABLE providers
  ADD CONSTRAINT providers_descriptor_envelope_size
    CHECK (octet_length(descriptor_envelope::text) <= 87552);

ALTER TABLE oauth_credentials
  DROP CONSTRAINT IF EXISTS oauth_credentials_envelope_size;
ALTER TABLE oauth_credentials
  ADD CONSTRAINT oauth_credentials_envelope_size
    CHECK (octet_length(credential_envelope::text) <= 87552);

ALTER TABLE addon_collection_backups
  DROP CONSTRAINT IF EXISTS addon_collection_backups_envelope_size;
ALTER TABLE addon_collection_backups
  ADD CONSTRAINT addon_collection_backups_envelope_size
    CHECK (octet_length(collection_envelope::text) <= 5592576);

-- Application JSON snapshots remain capped at 64 KiB of compact JSON. A 4 MiB
-- jsonb text bound covers separator overhead and PostgreSQL numeric expansion
-- while retaining a hard defense-in-depth database limit.
ALTER TABLE cloud_history
  DROP CONSTRAINT IF EXISTS cloud_history_canonical_identity_size,
  DROP CONSTRAINT IF EXISTS cloud_history_display_snapshot_size,
  DROP CONSTRAINT IF EXISTS cloud_history_playback_snapshot_size;
-- Legacy schemas did not bound canonical_identity. NOT VALID preserves a safe
-- upgrade while PostgreSQL still enforces the constraint for new writes.
ALTER TABLE cloud_history
  ADD CONSTRAINT cloud_history_canonical_identity_size
    CHECK (
      canonical_identity IS NULL OR
      octet_length(canonical_identity::text) <= 4194304
    ) NOT VALID,
  ADD CONSTRAINT cloud_history_display_snapshot_size
    CHECK (octet_length(display_snapshot::text) <= 4194304),
  ADD CONSTRAINT cloud_history_playback_snapshot_size
    CHECK (octet_length(playback_snapshot::text) <= 4194304);
