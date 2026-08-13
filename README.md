# Jumpgate Bridge

[Repository](https://github.com/ruizkinio/Jumpgate-bridge)

> **Pre-release hosted instance:** the hosted Bridge is still completing production
> deployment, Android device UAT, and coordinated release validation. It is not a
> supported public release.

**[Open the pre-release hosted instance](https://jumpgate-bridge.fly.dev/configure)**

[Privacy](PRIVACY.md) | [Security](SECURITY.md) | [Support](SUPPORT.md)

This audited repository and its issue forms are public. Suspected vulnerabilities must
use the verified private channel in [SECURITY.md](SECURITY.md), never a public issue.

Jumpgate Bridge is a private handoff between Stremio and Jumpgate (Kodi). A paired
profile can import its Stremio providers, proxy supported provider resources, identify
the selected title for a paired Jumpgate device, synchronize resume/history state, and
optionally connect Trakt.

## How It Works

1. Open `/configure` and generate or unlock a Bridge profile.
2. Pair Jumpgate with the short-lived code shown by Kodi.
3. Import the providers from the active Stremio profile.
4. Install the generated private addon URL in Stremio.
5. Stremio requests record bounded source context; the authenticated Jumpgate device
   claims that context when playback begins.

The root manifest is setup-only. Unpaired `/identify` and `/resume` requests fail
closed instead of sharing a global playback identity.

Current release validation targets official Stremio Android Mobile `2.3.2` and Android
TV `1.10.4`. Android Mobile `2.1.5` is unsupported because its retained player state can
hang when the same cached stream is selected after returning from an external player.
Future Stremio releases require the external-player lifecycle gate in the coordinated
Jumpgate device UAT before they become a release baseline.

### Maintainer Release Validation

Fault scenarios run only on the isolated `https://jumpgate-uat.fly.dev` deployment.
That deployment uses `NODE_ENV=uat` with `JUMPGATE_UAT_MODE=1`, production-equivalent
HTTPS and storage hardening, and separate PostgreSQL, Redis, subtitle storage, and
security material. It refuses Trakt, TMDB, and provider credentials and exposes only
health, synthetic pairing, version, and static configuration-page routes. Production
refuses UAT mode, and production release-protocol commands remain production-only.

The reviewed UAT deployment is pinned in `fly.uat.toml`. Its release command is a
separate UAT-only bootstrap that requires the exact UAT mode and origin, applies the
pinned PostgreSQL migrations, activates fenced provider mutations, and initializes
then advances the Redis playback-writer protocol to v6. It is idempotent after that
state is reached and refuses production. The UAT app must use isolated PostgreSQL,
Redis, subtitle storage, and generated security material; never attach production
resources or configure Trakt, TMDB, Stremio, debrid, or provider credentials.

## Pre-release Hosted Instance

Open:

```text
https://jumpgate-bridge.fly.dev/configure
```

This hosted target is for pre-release validation only until a coordinated release is
published. Its presence in this README does not identify an operator, create a
support or uptime commitment, or replace the policies linked above.

Configured addon URLs and management links are credentials. Do not post them in logs,
issues, screenshots, or chat. Register this callback when using Trakt OAuth on the
public instance:

```text
https://jumpgate-bridge.fly.dev/auth/trakt/callback
```

## Self-Host

### Requirements

- Node.js 24 LTS and npm for a plain local install.
- HTTPS at the public edge for Stremio clients outside localhost.
- `TRAKT_CLIENT_SECRET` is required at production startup. `TRAKT_CLIENT_ID` may use
  the intentional public fallback, but normal public deployments should configure
  their registered Trakt application pair. Development can omit both when Trakt is off.
- PostgreSQL and a standalone Redis 7 or 8 primary with `noeviction` for
  `NODE_ENV=production`.

### Local Single-Node Startup

This topology uses a persistent SQLite database and in-memory short-lived state. It is
intended for local development or a single private instance, not horizontal replicas.

```bash
git clone <PUBLISHED_BRIDGE_REPOSITORY_URL>
cd jumpgate-bridge
npm ci
cp .env.example .env
npm run secrets:generate
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`. Replace the four
`<generated-...>` entries in `.env` with the corresponding command output. The command
prints secrets but does not write them to disk; do not paste its output into logs or
commit it. Leave the commented Trakt and TMDB examples disabled unless you intend to
configure those integrations; when enabling one, remove `#` and replace its placeholder
with a secret-manager value. Then start Bridge with the env file loaded:

```bash
npm run start:local
```

Open `http://localhost:7515/configure`. Keep `PUBLIC_BASE_URL=http://localhost:7515`
for this exact local origin. If a reverse proxy exposes a different origin, configure
the proxy as described below before creating profiles or OAuth links.

### Docker Single-Node Startup

Create `.env` and generate its secrets as in the local instructions, then build and
run the image:

```bash
docker build -t jumpgate-bridge .
docker run --rm --name jumpgate-bridge --env-file .env -e HOST=0.0.0.0 -p 127.0.0.1:7515:7515 -v jumpgate-bridge-data:/app/.data jumpgate-bridge
```

The named volume is required if SQLite-backed profiles and history must survive
container replacement. `HOST=0.0.0.0` is required inside the container so Docker can
forward traffic to Bridge; `-p 127.0.0.1:7515:7515` still publishes the port only on
the host loopback interface. Put an HTTPS reverse proxy in front before exposing it
beyond the host. The image installs `better-sqlite3` as a production dependency even
though npm omits development dependencies.

### Production Topology

Production mode deliberately refuses local SQLite or in-memory TTL storage. Configure
all of the following through the host's secret/configuration system:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=7515
PUBLIC_BASE_URL=https://bridge.example.com
JUMPGATE_TRUST_PROXY=1
JUMPGATE_DURABLE_DRIVER=postgres
JUMPGATE_TTL_DRIVER=redis
JUMPGATE_PROVIDER_MUTATION_MODE=fenced
JUMPGATE_POSTGRES_MIGRATION_CEILING=0011_history_http_receipts
JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION=4
JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=v6
DATABASE_URL=postgresql://bridge:REDACTED@postgres.example.com:5432/jumpgate
REDIS_URL=rediss://:REDACTED@redis.example.com:6380/0
JUMPGATE_SUBTITLE_S3_BUCKET=private-subtitle-bucket
JUMPGATE_SUBTITLE_S3_REGION=auto
JUMPGATE_SUBTITLE_S3_ENDPOINT=https://fly.storage.tigris.dev
JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE=0
JUMPGATE_SUBTITLE_S3_PRIVACY_MODE=tigris-policy-status
JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE=tigris-version-purge-v1
JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID=REDACTED_SECRET_MANAGER_VALUE
JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY=REDACTED_SECRET_MANAGER_VALUE
JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID=subtitle-key-2026
JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING=[{"id":"subtitle-key-2026","key":"REDACTED_GENERATED_VALUE"}]
CONFIG_SECRET=REDACTED_GENERATED_VALUE
JUMPGATE_TOKEN_PEPPER=REDACTED_GENERATED_VALUE
JUMPGATE_ENVELOPE_PRIMARY_KEY_ID=primary-2026
JUMPGATE_ENVELOPE_KEYRING=[{"id":"primary-2026","key":"REDACTED_GENERATED_VALUE"}]
TRAKT_CLIENT_ID=REDACTED_TRAKT_CLIENT_ID
TRAKT_CLIENT_SECRET=REDACTED_TRAKT_CLIENT_SECRET
```

The protocol controls shown are the production target, not the stale, unaudited public
deployment. The retained private Tigris bucket must have snapshots enabled and pass
the repository's live exact-version purge proof before the checked-in Fly configuration
may enable `tigris-version-purge-v1`. Production startup rejects missing
provider-mutation, migration-ceiling, Redis playback-write, or erasure settings.
The subtitle bucket must be private and operators must dedicate it to Jumpgate.
Runtime readiness verifies privacy and integrity, but cannot prove exclusive bucket
use. Its object-key keyring must contain one to eight canonical base64/base64url
entries decoding to 32-64 bytes, and the current ID must name a retained entry.
`strict` validates bucket ownership ACLs, all public-access-block flags, and a
non-public policy. The configured Tigris mode uses policy status plus the exact
version-bound object ACL and integrity of a private per-generation canary; it does
not require Tigris's bucket ACL API, which rejects scoped runtime credentials.
Privacy verification fails closed. Set `tigris-version-purge-v1` only after the live
snapshot-enabled provider passes the exact-version purge attestation; keep the blocked
value otherwise.

Every object PUT carries a fresh SigV4-signed 256-bit attempt nonce. After an
ambiguous PUT, only a nonce-matched reconciliation may retain its provider version ID;
privacy HEAD, GET, and ACL checks then target that exact version. Erasure readiness
uses a fresh private 256-bit namespace per health instance, recovers only that
instance's prior failed canary, and never purges another replica's scope. Filename,
source, title, URL, and IP data do not establish proof identity.

`TRAKT_CLIENT_SECRET` is startup-required in production. `TRAKT_CLIENT_ID` may be
omitted to use the intentional public fallback, although the normal public deployment
should configure its registered Trakt client ID and secret together.

The redacted entries above are labels, not working credentials. Do not put real values
in an image, repository, workflow, `fly.toml`, or `render.yaml`. For Docker, pass a
local ignored env file or individual secrets at runtime. A production container does
not need an SQLite volume because PostgreSQL and Redis are external shared services.

## Network Boundary

`PUBLIC_BASE_URL` is the one canonical externally reachable origin used in generated
addon URLs, management links, assets, origin checks, and Trakt callbacks. In production
it is required and must be an HTTPS origin only, for example
`https://bridge.example.com`: no credentials, path, query, or fragment. Register
`https://bridge.example.com/auth/trakt/callback` with Trakt.

`HOST` controls only the listening interface. When omitted, development binds to
`127.0.0.1` and production binds to `0.0.0.0`. Keep development loopback-only unless a
container or trusted reverse proxy must reach Bridge. Docker port forwarding requires
an explicit container-side `HOST=0.0.0.0`; restrict host exposure separately with a
loopback publish such as `-p 127.0.0.1:7515:7515`.

`JUMPGATE_TRUST_PROXY` is explicit by design:

- Use `0`, `false`, or `off` when Bridge receives client traffic directly.
- Use `1` when exactly one trusted reverse proxy is in front of Bridge.
- Use the exact hop count, from `1` through `16`, for a longer controlled proxy chain.
- Do not increase the value merely to make forwarded headers work. An excessive trust
  boundary lets clients spoof the address used for transport-level rate limiting.

Production startup fails when this setting or `PUBLIC_BASE_URL` is absent. Forwarded
headers never replace the configured canonical public origin in production.

## Playback Identity

Bridge does **not** use a client IP address as playback identity. Profiles, install
tokens, and authenticated device tokens provide tenancy; playback claims use bounded
source fingerprints within that profile/device scope. Client addresses are used only
for transport controls such as HTTP rate limiting. Shared NAT addresses therefore do
not merge playback identities, and changing an address does not select another user's
playback context.

## Persistence And Security Material

| Mode                    | Durable records                  | Short-lived coordination | Scaling rule                                                               |
| ----------------------- | -------------------------------- | ------------------------ | -------------------------------------------------------------------------- |
| Development single-node | SQLite at `JUMPGATE_SQLITE_PATH` | Process memory           | One Bridge process; mount `.data` in Docker                                |
| Production              | PostgreSQL via `DATABASE_URL`    | Redis via `REDIS_URL`    | Every replica must share the same PostgreSQL, Redis, and security material |
| Test                    | In-memory by default             | In-memory by default     | Test-only                                                                  |

Restarting the development topology preserves SQLite-backed profiles, provider
configuration, credentials, history, and backups, but expires in-memory pairing,
management, OAuth, rate-limit, lease, and playback-context state. A Docker volume does
not make that TTL state durable and is not a substitute for Redis.

Pair activation recovery is deliberately short-lived. Before its first activation
request, `/configure` creates a 32-byte Web Crypto retry token and keeps only the token,
config, short code, version, and submission time in that tab's `sessionStorage` for up
to 10 minutes. Management session and CSRF credentials are never written to browser
storage. The retry token is request-body only: it must not appear in URLs, responses,
DOM content, logs, cookies, Redis plaintext, or PostgreSQL.

Redis stores only purpose-separated retry/index digests plus an AES-256-GCM replay
envelope. The encrypted replay lives for at most 10 minutes and never beyond the
original 15-minute management-session expiry. Exact retries replay the original token,
CSRF value, authority, and absolute cookie expiry without extending either lifetime.
Expiry or revocation removes the encrypted authority but retains a non-secret denial
tombstone through the remaining replay grace, preventing a replacement session from
being minted. Pairing replay authority is TTL state only; there is no PostgreSQL table
or migration for it. Production readiness also gates the Redis pairing protocol so a
mixed legacy/new writer deployment fails closed rather than issuing incompatible
pairings.

Back up the database and the following values separately. Restoring only one side is
not sufficient:

| Value                              | Why it must remain stable                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `CONFIG_SECRET`                    | Decrypts legacy configured URLs; changing it invalidates those URLs                  |
| `JUMPGATE_TOKEN_PEPPER`            | Protects stored token hashes; changing it invalidates existing opaque tokens         |
| `JUMPGATE_ENVELOPE_KEYRING`        | Decrypts protected records; losing a referenced key loses access to those records    |
| `JUMPGATE_ENVELOPE_PRIMARY_KEY_ID` | Selects the key used for new encrypted records; it must name an entry in the keyring |

For envelope-key rotation, add a new key, select it as primary, and retain old keys
while any stored records still reference them. Never reuse the token pepper as an
envelope key or as `CONFIG_SECRET`.

## Environment Variables

| Variable                           | Local default                                        | Production requirement                           |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| `PORT`                             | `7515`                                               | Optional; the listening port                     |
| `NODE_ENV`                         | `development`                                        | Must be `production` for the production topology |
| `HOST`                             | `127.0.0.1`                                          | Defaults to `0.0.0.0`                            |
| `PUBLIC_BASE_URL`                  | Derived only for loopback when omitted               | Required canonical HTTPS origin                  |
| `JUMPGATE_TRUST_PROXY`             | `0`                                                  | Required explicit direct/proxy hop setting       |
| `JUMPGATE_DURABLE_DRIVER`          | `sqlite`                                             | Must be `postgres`                               |
| `JUMPGATE_TTL_DRIVER`              | `memory`                                             | Must be `redis`                                  |
| `JUMPGATE_PROVIDER_MUTATION_MODE`  | `fenced`                                             | Production requires `fenced`                     |
| `JUMPGATE_POSTGRES_MIGRATION_CEILING` | Latest migration when omitted                     | Required exact migration version                 |
| `JUMPGATE_REDIS_PLAYBACK_WRITE_VERSION` | `4`                                              | Production requires `4`                          |
| `JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE` | `v6` outside a managed transition             | Final production state is `v6`; `transition` is release-command only |
| `JUMPGATE_SQLITE_PATH`             | `.data/jumpgate.sqlite3`                             | Not used                                         |
| `DATABASE_URL`                     | Not used                                             | Required PostgreSQL URL                          |
| `REDIS_URL`                        | Not used                                             | Required Redis or TLS `rediss` URL               |
| `JUMPGATE_SUBTITLE_S3_BUCKET`      | Not used                                             | Required private bucket; dedicate operationally  |
| `JUMPGATE_SUBTITLE_S3_REGION`      | Not used                                             | Required region                                  |
| `JUMPGATE_SUBTITLE_S3_ENDPOINT`    | Not used                                             | Required approved HTTPS endpoint                 |
| `JUMPGATE_SUBTITLE_S3_FORCE_PATH_STYLE` | Not used                                        | Optional; `0` or `1`                             |
| `JUMPGATE_SUBTITLE_S3_PRIVACY_MODE` | Not used                                            | Optional; `strict` default or `tigris-policy-status` |
| `JUMPGATE_SUBTITLE_PERMANENT_ERASURE_MODE` | Not used                                    | `tigris-version-purge-v1` only after live provider attestation |
| `JUMPGATE_SUBTITLE_S3_ACCESS_KEY_ID` | Not used                                           | Required secret                                  |
| `JUMPGATE_SUBTITLE_S3_SECRET_ACCESS_KEY` | Not used                                       | Required secret                                  |
| `JUMPGATE_SUBTITLE_OBJECT_KEY_CURRENT_ID` | Not used                                      | Required id present in the keyring               |
| `JUMPGATE_SUBTITLE_OBJECT_KEY_KEYRING` | Not used                                          | Required JSON; 1-8 retained 32-64 byte keys      |
| `CONFIG_SECRET`                    | Required for stable configured URLs                  | Required secret                                  |
| `JUMPGATE_TOKEN_PEPPER`            | Required generated 32-64 byte base64/base64url value | Required secret                                  |
| `JUMPGATE_ENVELOPE_PRIMARY_KEY_ID` | Required key id                                      | Required key id                                  |
| `JUMPGATE_ENVELOPE_KEYRING`        | Required JSON keyring with 32-byte keys              | Required secret JSON                             |
| `TRAKT_CLIENT_ID`                  | Intentional public fallback                          | Fallback allowed; configure the registered id    |
| `TRAKT_CLIENT_SECRET`              | Optional when Trakt is disabled                      | Required by production startup                   |
| `TMDB_API_KEY`                     | Optional                                             | Optional metadata enhancement                    |
| `JUMPGATE_DEPLOYMENT_STATUS`       | `Pre-release deployment`                             | Optional operator-supplied status, maximum 80 characters |
| `JUMPGATE_PRIVACY_POLICY_URL`      | No link published                                    | Optional HTTPS URL; configure all three policy URLs together |
| `JUMPGATE_SECURITY_POLICY_URL`     | No link published                                    | Optional HTTPS URL; configure all three policy URLs together |
| `JUMPGATE_SUPPORT_POLICY_URL`      | No link published                                    | Optional HTTPS URL; configure all three policy URLs together |

Policy URLs are an all-or-none startup contract. Bridge renders no policy anchors
when all three are absent, which is the safe self-host default. Once an operator has
actually published all three documents, configure their absolute HTTPS URLs together.
Loopback-only development may use `http://localhost` or a `127.0.0.0/8` address.

## Health And Operations

- `GET /health/live` reports whether the HTTP process is alive.
- `GET /health/ready` verifies storage readiness without returning driver details or
  credentials. Route traffic only when it returns `200`.
- `GET /configure` serves the profile, provider import, pairing, and install UI.
- `GET /version` returns the Bridge semantic version.

CI runs the full suite plus live compatibility matrices for PostgreSQL 16/17 and Redis
7/8. Each PostgreSQL leg runs every migration, repository, playback, history-grant, and
cross-store contract without skips. The immutable production-image smoke uses
PostgreSQL 17 and Redis 8.2, matching the managed production majors. The Fly deploy job
depends on those gates and runs only for a successful push to protected `main`. It
first probes writer state with the exact immutable image. Missing or v5 state selects
`transition` followed by `v6` with one digest; established v6 skips `transition` and
deploys and attests `v6` directly. Transition initializes only missing state to v5,
while the v6 phase advances only v5 to v6; neither downgrades v6.

Each selected phase first constructs PostgreSQL and runs the exact bounded
`SELECT 1 AS ready` before constructing Redis or S3. It then validates Redis and the
private, versioned S3 provider and closes all owned preflight resources before any
durable migration or protocol mutation. The immutable-image S3 harness separately
requires exactly four accepted PUTs, 18 authenticated accepted
`ListObjectVersions`/`DeleteObject` operations, and at least three independently
sequence-bound privacy replays. That isolated proof does not
replace live Tigris attestation.

The project requires Node 24 LTS. npm dependency install scripts are denied unless
explicitly approved in `package.json`; the pinned `better-sqlite3` release ships its
platform prebuilds without an install hook. Package publish lifecycle scripts are
forbidden so policy inspection and a real script-disabled `npm pack` produce the same
artifact. The package is private and its pack allowlist contains runtime files only.

## License

MIT
