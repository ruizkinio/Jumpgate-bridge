# SQLite Migrations

Migration files are immutable and applied in filename order under `BEGIN IMMEDIATE`.
The runner records each file's SHA-256 checksum and integer-millisecond application
time in `schema_migrations`; startup fails if an applied file's bytes change.

Migration files must not contain transaction-control statements because the runner
owns transaction boundaries. Secret-bearing values are stored only as token hashes
or versioned encrypted-envelope JSON text.
