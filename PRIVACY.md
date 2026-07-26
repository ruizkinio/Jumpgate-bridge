# Jumpgate Bridge Privacy Notice

Last updated: 2026-07-25

## Status And Scope

Jumpgate Bridge is pre-release. This notice describes data handling implemented by
the Bridge source in this repository; it does not turn a development deployment into
a public release or promise behavior that the code does not implement.

The notice covers the Bridge server and its configuration page. Stremio, Kodi,
Trakt, TMDB, selected providers, debrid services, hosting platforms, and network
operators have their own practices.

## Who Is Responsible

For a project-operated hosted instance, the project operator is responsible for the
PostgreSQL, Redis, private object storage, application logs, and hosting account used
by that instance. The code does not define the operator's legal identity, storage
region, infrastructure backup period, object-versioning policy, or hosting-platform
log retention. Those facts must be published separately by the hosted operator; this
notice does not invent them.

For a self-hosted instance, the person or organization running it is the operator.
That operator selects the infrastructure, recipients, retention, backup, access,
deletion, and legal policies and must provide any notice and request channel required
for its users. The Jumpgate maintainers cannot access or delete a self-hosted
operator's data.

## Data The Bridge Processes

### Profiles And Configuration

- Generated profile identifiers, display names, status, revisions, and timestamps.
- Hashed install tokens and hashed aliases used to resolve configured addon profiles.
- Encrypted profile settings, including subtitle preferences and a profile TMDB key
  when one is supplied.
- An encrypted configuration blob carried in each configured addon URL. That URL is
  an account capability even though its payload is encrypted.

### Pairing And Devices

- Short-lived pairing and device codes, activation state, device names, and pairing
  identifiers.
- Device identifiers, hashed device tokens, creation and last-seen times, credential
  expiry, and revocation time.
- Short-lived management-session and CSRF token hashes.

### Providers And Addon Collections

- Selected Stremio addon descriptors, including manifest metadata and transport
  URLs. Transport URLs can themselves contain private provider or debrid
  capabilities.
- Encrypted provider descriptors and encrypted snapshots of addon collections made
  before provider updates. The current durable repository permits up to 64 backups
  per profile and does not age them out automatically.
- Provider responses needed to return stream and subtitle resources. Those responses
  can contain URLs, torrent identifiers, request headers, cookies, and other
  provider-specific playback data.

Stremio account approval is implemented in the configuration browser. The browser
contacts `link.stremio.com` and `api.strem.io`, uses the returned Stremio auth key to
read the addon collection once, and sends only selected descriptors and the backup
collection to Bridge management APIs. The Bridge server routes do not receive that
Stremio auth key.

### Playback And History

- Short-lived source contexts and claims bound to profile, device, session, provider
  revision, canonical identity, source fingerprints, and provider response data.
- Durable local history containing a hashed content key, canonical media identity,
  title and artwork display fields, sanitized provider and track preferences,
  position, duration, watched time, completion state, revisions, and timestamps.
- History playback snapshots reject source URLs and fields named like tokens,
  secrets, authorization values, cookies, credentials, or headers.

Bridge does not use an IP address to choose a profile, title, or playback identity.

### Trakt And TMDB

- Optional Trakt OAuth access and refresh tokens, token expiry, refresh state, and
  account display metadata. Trakt credentials are stored in an encrypted durable
  envelope and can be returned through device-authenticated and configured-profile
  capability routes. A configured addon URL must therefore remain private.
- Optional TMDB v3 API keys and canonical IMDb identifiers used for metadata lookups.
  The Bridge sends those values to TMDB when the metadata feature is used.

### Subtitles

- Private subtitle source capabilities, including source URLs and permitted request
  headers, held in encrypted short-lived state.
- Subtitle filenames, roles, media types, byte sizes, checksums, object references,
  and profile/device/session bindings.
- Integrity-checked subtitle payloads stored temporarily in the configured private
  S3-compatible object store.
- An opaque deterministic privacy-canary key and body, with a fresh signed PUT-attempt
  nonce, plus random erasure namespace and key components used to verify the configured
  private, versioned object store. Their identity does not use subtitle filenames,
  media titles, provider URLs, or client IP addresses.

### Network And Operational Data

- Client address signals used for transport-level rate limiting. Bridge normalizes
  and hashes the signal before placing it in the rate-limit repository.
- HTTP method and a redacted route, operation status, bounded error codes, provider
  scope, and shortened profile hashes written to application output. Query strings,
  configured blobs, pairing paths, history keys, media identifiers, and private
  subtitle paths are redacted by the application logger.
- A hosting edge, reverse proxy, database, Redis service, or object-store provider
  may process additional connection metadata under the operator's configuration.

The Bridge application code does not implement advertising or behavioral analytics.

## Why Data Is Used

Bridge uses the data above to pair devices, authenticate profile capabilities,
import selected providers, proxy requested resources, bind source claims, deliver
subtitles, maintain local resume/history, perform optional Trakt and TMDB functions,
prevent cross-profile access, enforce capacity and rate limits, and operate the
service.

## External Processing

Depending on enabled features, data is sent to:

- Stremio link and account APIs from the user's browser during addon import.
- User-selected provider and debrid endpoints for requested resources.
- Subtitle source endpoints for a selected subtitle.
- Trakt for OAuth, token refresh, and account validation.
- TMDB for optional metadata lookup.
- The operator's PostgreSQL, Redis, private S3-compatible storage, reverse proxy,
  logging, and hosting providers.

Bridge does not choose or control the privacy practices of a user-selected provider
or a self-host operator.

## Retention Implemented In Code

Unless an operator configures and documents stricter infrastructure behavior, the
current code implements these application-level periods:

| Data | Implemented behavior |
| --- | --- |
| Pairing records | Expire after 10 minutes; terminal or expired replay tombstones can remain for another 10 minutes |
| Trakt OAuth prefill and state | Expire after 10 minutes |
| Management sessions | Expire after 15 minutes; the logout endpoint revokes the current session sooner |
| HTTP rate-limit entries | Current routes use one-minute windows |
| Playback source contexts | Default two-minute lifetime; expired context fingerprints can remain as tombstones for another two minutes |
| Subtitle artifacts | Two-minute logical lifetime, never more than ten minutes absolute; release, invalidation, or expiry schedules asynchronous object deletion |
| Provider response cache | Ten-second logical TTL, capped at 256 entries and 32 MiB; expired entries are not returned, and their cache entries and references are removed on access or by each 30-second cleanup pass |
| TMDB metadata cache | 24-hour logical TTL, capped at 2,000 entries; expired cache entries and references are removed by each 30-second cleanup pass |
| Device authentication | Default sliding expiry of 180 days, refreshed after qualifying authenticated use |
| Continue-watching view | Shows recent unfinished history from the last seven days; this is a display window, not deletion |

Expiration is not the same as erasure. Expired or revoked device rows remain in the
durable database. Subtitle deletion is performed by a worker and may be retried, so
the expiry timestamp is not a promise of deletion at an exact instant. Operator
backups or object versions are outside the deletion worker's control.

The production readiness canary proves only that the current provider credentials can
privately access and exact-delete the canary version under the configured provider's
semantics. It does not delete user subtitle artifacts, expose a user-facing deletion
workflow, or prove hard deletion of profiles, history, provider data, logs, backups,
provider recovery copies, or physical media. Operators must document and enforce those
separate retention and deletion boundaries.

Cache cleanup promises only entry and reference removal. JavaScript garbage
collection and the process allocator determine when unreachable memory is reclaimed
or returned to the operating system; Bridge does not promise a physical-memory
retention deadline.

Profiles, profile settings, provider collections, provider backups, Trakt credential
records, device rows, history rows, and alias hashes have no automatic time-based
hard-deletion schedule in the current application. They are instead governed by the
authenticated lifecycle controls below. Application-log and infrastructure-backup
retention are not set by this repository.

## Revocation And Deletion Boundaries

The authenticated profile-management surface provides management-session logout,
device revocation, history clearing, Trakt disconnect, and profile erasure. Playback
release and profile/provider generation changes also invalidate related short-lived
playback and subtitle authority. Device credentials stop authenticating after expiry.

- Device revocation denies that device further authentication and invalidates its
  associated runtime authority.
- History clearing removes content-bearing history while retaining sanitized
  synchronization tombstones needed to propagate deletion.
- Trakt disconnect removes usable Trakt tokens while retaining a token-free state
  marker that prevents stale credential writes from restoring the connection.
- Profile erasure fences authentication first, schedules private subtitle artifacts
  for asynchronous deletion, removes durable profile children, and retains a
  sanitized revoked-profile tombstone so the identity cannot be reprovisioned. The
  endpoint acknowledges the request as accepted and pending even when its first
  cleanup pass completes; failed cleanup is retried.

These controls do not erase application logs, infrastructure backups, provider
recovery copies, or physical media, and they do not promise deletion at an exact
instant. Logging out, uninstalling an addon, deleting a configured URL locally, or
revoking Trakt at Trakt does not itself invoke profile erasure.

No separate private hosted privacy-request channel is published yet. Do not put a
profile identifier, configured URL, token, provider detail, or other private value in
a public issue or message. Until an operator publishes a verified private channel, no
manual identity-verification or operator-assisted deletion workflow is represented as
available beyond the authenticated self-service controls above.

Self-host operators must implement and document their own verified request process
and, when appropriate, remove durable database rows, Redis state, subtitle objects,
backups, object versions, and logs under their control.

## Your Choices

- Do not enable Trakt or TMDB if those features are not wanted.
- Import only providers whose operators and data practices you accept.
- Treat configured addon URLs, pairing material, management links, and device tokens
  as private capabilities. Re-pair or rotate affected credentials after exposure.
- Revoke Jumpgate access in Trakt if a Trakt credential may be compromised.
- For self-hosting, select storage, backup, logging, and retention settings suitable
  for your users before exposing Bridge to a network.

## Never Put Private Data In GitHub

Do not post configured addon URLs, pairing codes, management links, device or profile
tokens, provider or debrid URLs, headers or cookies, Stremio credentials, Trakt or
TMDB credentials, Fly.io secrets, deployment secrets, or raw private logs in an
issue, pull request, discussion, screenshot, or chat. Report vulnerabilities through
the private process in [SECURITY.md](SECURITY.md). Use sanitized placeholders for
ordinary support.

## Changes And Questions

Material code changes should update this notice. Use the privacy-safe process in
[SUPPORT.md](SUPPORT.md) for a non-sensitive policy question. For suspected
vulnerabilities, follow [SECURITY.md](SECURITY.md).
Private vulnerability reporting is available through the verified link in SECURITY.md.
Do not substitute public disclosure.
