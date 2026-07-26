# Redis TTL Repositories

This directory implements the TTL repository contracts from `lib/storage/README.md`.
Every repository accepts an already-created node-redis-compatible `client`; importing
the module never imports or creates `redis`. Scripts run with `EVALSHA` and retry once
with `EVAL` only for `NOSCRIPT`. Constructors reject Redis Cluster client objects;
the adapter requires one standalone primary and does not defer topology failures to
a cross-slot script execution.

All keys use `jg:v1:<kind>:<sha256>` names. Dynamic profile IDs, tokens, pairing
codes, lease scopes, rate-limit inputs, playback fingerprints, and session IDs are
therefore absent from Redis key names. Capability values are stored only as the
purpose-separated hashes produced by `TokenService`. All authoritative timestamps
come from Redis `TIME` inside Lua.

## Playback Lua boundary

Playback uses a small versioned profile-root hash, one hash field per context or
claim, separate expiry/order indexes, a bounded tombstone index, and hashed
per-fingerprint sets. A claim stores only its context reference; the context is
materialized for the script reply and is never duplicated into claim storage.
Record updates rewrite one context field, while claim and release leave every
context field byte-for-byte unchanged. The profile root contains only hashed child
key names needed by scheduled pruning.

The storage boundary projects `source` and `request` through explicit metadata
allowlists. Raw URLs, proxy headers, authorization values, and arbitrary provider
payload fields can participate in fingerprint construction but cannot enter those
persisted objects. Canonical fingerprint bytes remain in the context response where
claim matching requires them; Redis key and set names use only purpose-separated
digests. JavaScript validates every JSON number before serialization, and Lua
revalidates context shape, integer bounds, allowlists, and internal index identity.

Equivalent lookup uses a hash of the content key and sorted fingerprint hashes, then
compares the fingerprint-to-index tuples as a set. Input order therefore matches the
in-memory repository contract without weakening the association between each
fingerprint, its index key, and its tombstone member. Equivalent refreshes retain a
bounded, first-seen union of source/request provider provenance and inline subtitles.

All mutations remain atomic Lua executions. Per-profile hashes, lists, sorted sets,
and fingerprint sets are bounded by the same configured context, claim, tombstone,
and fingerprint limits as `SourceContextStore`. `prune()` processes at most 32 due
profiles by default (configurable from 1 through 256), and repeated calls eventually
drain the due schedule without `SCAN`. Released session reservations retain their
independent TTL and are never deleted by release or stale-claim cleanup, so an old
owner cannot free a newer reuse of the ID. Replacing these scripts with non-atomic
client-side reads would weaken claim, capacity, tombstone, and TTL semantics and is
not supported.

## Pairing recovery boundary

`activate()` owns issuance of the one-time `device` token and atomically binds the
HMAC-SHA-256 retry digest while deleting the short-code lookup. The raw 32-byte browser
retry token is never stored. Same-token retries compare the stable config digest and
converge; another token receives a generic miss, while changed config conflicts.
Caller-supplied `deviceToken` and `profileId` fields are server-managed and excluded
from the stable conflict digest. Optional
`completeActivation(..., { profileId })` finalization compare-swaps a replacement
envelope and the `activated` state in one Lua execution, then returns the verified
authoritative activation. The two-argument form remains supported and may be followed
by one empty-to-profile finalization; redemption stays pending until that transition.

`management-pairing-issue.lua`, `management-pairing-recover.lua`, and
`management-pairing-revoke.lua` own the management replay transition. Redis contains
only purpose-separated hashes/index keys and a domain-bound AES-256-GCM authority
envelope; the session token, CSRF token, retry token, and private response authority
never appear in plaintext. The encrypted replay TTL is at most 10 minutes and is
capped by the original 15-minute management expiry. Exact retries return the original
credentials and absolute expiry without creating another session. Expiry, explicit
session revocation, or profile revocation strips the envelope and leaves a non-secret
denial tombstone through the remaining grace so authority cannot be resurrected.
Nothing in this replay path is written to PostgreSQL.

New pairings use the `pairing-*-v2` key kinds. Readiness runs an atomic protocol gate
against the legacy pairing global key: it converts an empty/expired legacy index to a
version marker, rejects active legacy pairings, and makes legacy writers fail closed on
the incompatible key type. Mixed-version production rollout is therefore gated before
traffic is served.

Playback claim writers use a separate fully hashed global protocol key. The guarded
production release command first runs its storage preflight: PostgreSQL is
constructed first and completes the exact bounded `SELECT 1 AS ready` before Redis or
S3 is constructed, then Redis and private, versioned S3 are validated. Only after that
gate does the command migrate PostgreSQL, activate and attest fenced provider mutations,
and perform the phase-specific atomic Redis transition.

Managed rollout probes writer state with the immutable candidate before deploying.
Missing or v5 state runs `transition` and then `v6` with the same digest; established v6
skips `transition` and deploys and attests `v6` directly. Transition initializes only
missing state to v5 and is idempotent at v5. The v6 phase advances only v5 to v6 and is
idempotent at v6. Malformed state, wrong Redis types, or an incompatible phase fail
closed, and neither phase downgrades v6 or publishes v6 as a one-step initialization.

Redemption peeks, decrypts, and validates before a second Lua script compare-consumes
the exact observed envelope. A successful consume retains only that encrypted
activation and its hashed capability lookup for the fixed tombstone TTL, allowing a
lost HTTP response to be retried without generating a different device token. The
tradeoff is that anyone holding the unguessable device code can replay the same
activation during that short window; retries do not extend it, plaintext is never
stored, and the user-code index is removed on first consume.

OAuth consumption follows the same read/decrypt/validate/CAS boundary. Missing keys,
invalid ciphertext, or malformed payloads leave the one-time state available for a
correctly configured retry, while concurrent valid consumers still produce one winner.

The scripts use multiple independently hashed keys and, for cleanup, keys stored in
bounded state. They target a single Redis primary or a compatibility service with
standalone Lua semantics. Redis Cluster requires a separately designed hash-tagged
schema; silently falling back to partial cross-slot operations is intentionally not
implemented.
