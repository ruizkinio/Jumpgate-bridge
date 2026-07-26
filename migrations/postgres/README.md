# PostgreSQL Migrations

Migrations are immutable and applied in filename order inside a database transaction.
The migration runner records a SHA-256 checksum in `schema_migrations` and must fail
startup if an already-applied file changes.
Migration files must not contain transaction-control statements because the runner
owns the migration and checksum transaction.

Durable tables store only token hashes and versioned encryption envelopes. Pairing
codes, management sessions, playback contexts, and claims are TTL data owned by the
Redis-compatible adapter and are intentionally absent from PostgreSQL.
