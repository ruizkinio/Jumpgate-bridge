# Bridge Storage Contracts

All repository methods are asynchronous even when the in-memory adapter completes
synchronously. Identifiers are opaque `[A-Za-z0-9_-]` strings, timestamps are Unix
milliseconds, and revisions use compare-and-swap semantics starting at zero for an
insert and one for the first stored row.

## Durable Repositories

- `profiles.create(input)`, `getById(id)`, `getByInstallToken(token)`,
  `update(id, patch, expectedRevision)`, `revoke(id, expectedRevision)`.
  `rotateInstallToken(id, expectedRevision)` returns a replacement capability once.
- `devices.register(profileId, input)`, `authenticate(token)`,
  `revoke(profileId, deviceId)`. Registration returns the device token once; only
  its purpose-separated hash is stored.
- `providers.replaceAll(profileId, descriptors, expectedRevision, options?)`,
  `list(profileId)`, `removeAll(profileId, expectedRevision, options?)`, and
  `allocateMutationFence(profileId)`,
  `advanceMutationFence(profileId, mutationFence)`. Replacement is one transaction
  and preserves descriptor order and unknown JSON fields. `options.mutationFence`
  defaults to `"0"` and is a canonical nonnegative decimal string of at most 128
  digits. A mutation below the durable fence fails with
  `provider_snapshot_stale_fence`; an equal fence is allowed so revision CAS remains
  authoritative for retries. Advancing the fence is atomic, does not change provider
  rows or their revision, and creates a revision-zero collection when needed. Fence
  allocation uses a separate durable global counter, so abandoned allocations never
  advance a collection's accepted-write high-water mark. Accepted replacement and
  recovery fences rebase that allocator for legacy data and Redis-loss recovery.
- `oauthCredentials.put(profileId, provider, value, expectedRevision)`,
  `get(profileId, provider)`, `remove(profileId, provider, expectedRevision)`.
- `history.upsert(profileId, entry, expectedRevision)`, `get(profileId, key)`,
  `list(profileId, options)`, `remove(profileId, key, expectedRevision)`,
  `changes(profileId, options)`. Removal writes a sanitized tombstone so another
  device cannot miss the deletion.
- `addonCollectionBackups.create(profileId, collection, reason)`,
  `get(profileId, backupId)`, `list(profileId, options)`, and
  `markRestored(profileId, backupId)` preserve encrypted recovery snapshots.
- `legacyConfigAliases.getProfileId(hash)` and `bind(profileId, hash)` allow many
  old encrypted install URLs to converge on one durable profile without collisions.

## TTL Repositories

- `pairings.issue(input)`, `activate(userCode, payload, { activationRetryToken })`,
  `recoverActivation(activationRetryToken, payload)`,
  `completeActivation(pairingId, activationDigest)`, `redeem(deviceCode)`, and
  `cancel(deviceCode)`. First activation atomically binds the purpose-separated retry
  HMAC and consumes the short-code browser authority. Activation first enters
  `activating`; after idempotent durable device registration, completion makes it
  redeemable exactly once.
- `oauthStates.issue(profileId, payload)`, `consume(stateToken, browserBindingToken)`,
  `cancel(token)`. Issue returns independent state and HttpOnly-cookie binding
  capabilities; consume verifies both atomically and returns the bound profile.
- `playbackContexts.record(profileId, context)`,
  `claim(profileId, deviceId, request)`,
  `release(profileId, deviceId, sessionId)`, `prune()`.
- `managementSessions.issue(profileId)`, `authenticate(session, csrf)`,
  `revoke(session)`. Both independent capabilities are required.
- `leases.acquire(scope, key, owner, ttlMs)`, `renew(scope, key, token, ttlMs)`,
  `release(scope, key, token)`. Renewal and release compare the token hash and never
  extend or delete another owner's lease.
- `rateLimits.consume(scope, key, limit, windowMs, cost)`, `reset(scope, key)`.
- `managementSessions.issueForPairing(input)`, `recoverPairing(input)`, and
  `revokePairing(input)` atomically issue, replay, or deny the management authority
  linked to one pairing retry digest. Exact replay returns the original session token,
  CSRF token, expiry, and response authority without adding a session.

## Security Invariants

- Install, device, session, CSRF, OAuth-state, pairing, and lease tokens are never
  stored in plaintext.
- Provider descriptors, OAuth credentials, pairing activation, and OAuth state use
  versioned AES-256-GCM envelopes whose AAD binds the record to its purpose/scope.
- Pairing management replay uses a separate domain-bound AES-256-GCM envelope in
  memory or Redis. Its encrypted authority is retained for at most 10 minutes, capped
  by the original 15-minute management expiry; a non-secret denial tombstone prevents
  reminting after replay expiry or revocation. Retry tokens and replay envelopes are
  never persisted in PostgreSQL and require no durable migration.
- Provider URLs may contain credentials and must not appear in logs, browser URLs,
  history, metrics, or unencrypted database columns.
- Cloud playback snapshots contain only sanitized provider/source IDs and user
  preferences. Raw source URLs, headers, cookies, and tokens are rejected.
- Production write/consume operations must be transactional or atomic and preserve
  the same externally observable behavior as the in-memory adapters.

## Runtime Configuration

`loadStorageConfig()` selects only the following supported topology:

- Tests: in-memory durable and TTL repositories with fresh ephemeral key material.
- Local persistent development: SQLite durable repositories and in-memory TTL state.
- Production: PostgreSQL durable repositories and one standalone writable Redis 7 or
  8 primary with `noeviction` and Redis Cluster disabled (`INFO cluster` must report
  `cluster_enabled:0`). Startup also requires exactly one well-formed `redis_version`
  from `INFO server` and rejects every major outside 7/8. Production cannot opt down to
  process-local storage.

Persistent modes require `JUMPGATE_TOKEN_PEPPER`,
`JUMPGATE_ENVELOPE_PRIMARY_KEY_ID`, and `JUMPGATE_ENVELOPE_KEYRING`. Keyring entries
are an ordered JSON array of `{ "id", "key" }` records so duplicate IDs can be
rejected. Keep old keys in the ring while rotating the primary key. `CONFIG_SECRET`
is accepted only as legacy configured-URL migration input and never derives bearer
token hashes or storage encryption keys.

See `.env.example` for placeholder-only local and production variables. Never commit
real connection URLs or key material.

Production subtitle storage defaults to
`JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE=blocked-tigris-provider-confirmation-required`.
The only enabled mode is `tigris-version-purge-v1`. It is admitted only after live
readiness proves all of the following with the configured provider credentials:

- bucket privacy checks pass;
- a private canary PUT yields a real provider version ID and that exact version is
  visible through paginated `ListObjectVersions`;
- `DeleteObject(VersionId)` targets only that locally observed canary version; and
- two complete paginated scans of the exact key confirm that locally observed version
  ID is absent, each paired with an authenticated exact-version `HeadObject` canonical
  404 proof.

Unsupported or malformed pagination, an observed target version that remains visible,
and partial deletion failures block readiness. Historical or concurrently created
replacement versions are not confused with the locally observed version and are
outside this exact-version proof. A generic or current-object `HeadObject` 404 is never
treated as permanent-erasure proof. This contract proves the isolated canary protocol
under Tigris's documented version-delete semantics; it does not claim user-data hard
deletion, backup deletion, or physical media sanitization.

`X-Tigris-Enable-Snapshot` is a documented `CreateBucket` request header, not a
`HeadBucket` response attestation. Readiness therefore neither requires nor trusts it.
Operators must enable snapshots before attestation so Tigris returns provider version
IDs; an unversioned bucket fails the exact-delete proof and must remain blocked.

Tigris represents a private object's organization administrators with the exact
`https://groups.tigris.dev/org/admins` ACL group. Scoped Tigris runtime credentials
cannot call the bucket ACL API, so Tigris readiness instead binds this ACL proof to the
exact canary version it just wrote. It accepts only that provider-native group with
`FULL_CONTROL`, alongside the required canonical owner grant. Public,
authenticated-user, unknown-group, duplicate, and malformed object grants still fail
closed. Non-Tigris `strict` mode retains its separate bucket ACL validation.

Object writes still request `AES256` server-side encryption and carry a fresh
SigV4-signed 256-bit attempt nonce. Tigris does not echo the AWS-specific SSE response
field, so only the pinned Tigris privacy mode permits that field to be absent. Wrong
encryption values, private-state failures, metadata or checksum mismatches, and missing
response confirmation from other S3 providers remain fatal. After an ambiguous PUT,
only a HEAD with the matching attempt nonce may retain its provider version ID. Privacy
HEAD, GET, and ACL checks bind to that exact PUT version.

Each subtitle-storage health instance creates a fresh private 256-bit erasure namespace
scope, and every uncached run adds a fresh 256-bit canary component. A run purges only
its own scope before writing, so it can recover only that health instance's prior failed
canary and cannot purge another process or replica's scope. It exact-deletes the locally
observed version and requires two complete scans proving that version absent plus the
authenticated exact-version 404 proofs above. Calls through one health instance share
one in-flight proof and reuse a successful proof for at most 60 seconds; the next run
performs a fresh provider round trip. Failed cleanup keeps readiness closed. Filenames,
source URLs, media metadata, and client IPs are irrelevant to this opaque proof identity.

On the PostgreSQL path, `await createStorageRuntime(config)` constructs PostgreSQL first
and runs the exact bounded `SELECT 1 AS ready` before constructing Redis or S3. It then
applies pending durable migrations, composes all 18 repositories, verifies their
contracts, and completes aggregate readiness before resolving. The returned runtime
exposes `ready()` (also `healthCheck()`), `state`, and idempotent `close()`.

The separate production release preflight follows the same PostgreSQL-first probe,
then constructs the S3 client, constructs and validates Redis, and validates private,
versioned S3 before any durable migration or writer-protocol mutation. Tigris privacy
uses non-public policy status plus the exact written canary version's object ACL; it
does not depend on the bucket ACL operation denied to scoped runtime credentials.
Preflight always closes its owned resources; runtime startup failure closes every
owned resource opened earlier in the sequence.

The runtime owns clients it creates and closes them in reverse startup order. An
injected PostgreSQL pool/database or already-open Redis client remains caller-owned
unless `closeInjectedResources: true` is explicit. If the runtime has to connect an
injected closed Redis client, it also closes that connection. Applications should
provide `onStorageError(kind, error)` so idle pool/client errors enter structured,
redacted logs; secrets and connection URLs must never be logged.

Migration, Redis connect, aggregate readiness, and per-resource shutdown waits are
bounded. Tests and constrained deployments may override the defaults with
`lifecycleTimeouts: { startupMs, migrationMs, connectMs, readinessMs, shutdownMs }`;
timeouts fail with `code === "storage_timeout"`, force owned resources closed, and
detach runtime-installed listeners. Profile provisioning keeps incomplete creations
in a purpose-bound encrypted pending state so an exact retry can rotate the lost
install capability. If commit or compensation cannot be proven through the current
repository contracts, it fails closed with `profile_transaction_required` rather
than returning an indeterminate capability.
