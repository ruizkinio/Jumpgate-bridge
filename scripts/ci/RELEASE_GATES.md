# Production release gates

GitHub repository settings remain external to this workflow. Before enabling releases:

- Protect `main` and require these strict, up-to-date pre-merge status checks:
  - `Quality / Node 24`
  - `Redis 7 / 48 live contracts`
  - `Redis 8 / 48 live contracts`
  - `PostgreSQL 16 / 22 live storage contracts`
  - `PostgreSQL 17 / 22 live storage contracts`
  - `Bridge / Kodi fingerprint parity`
  - `Immutable production image / PostgreSQL + Redis + private S3`
- Do not make `Fly production / exact tested digest` a required pre-merge status check;
  it is the post-validation deployment job.
- Create and protect the `production` environment, restrict it to protected `main`,
  and add independent reviewers when the repository has eligible maintainers.
- Store `FLY_API_TOKEN` only as a secret in that `production` environment.

The workflow checks protected-main context and targets `environment: production`; it does not provision or validate those repository settings.

The managed deployment uses the checksum-pinned Fly CLI and checked-in `fly.toml`; it
does not clone legacy Machine configuration or call the retired custom Machines helper.
CI pushes the exact container-smoke image, resolves its registry digest, and uses that
same immutable reference for every selected rollout phase.
The live compatibility matrix covers Redis 7/8 and PostgreSQL 16/17; the immutable
production-image gate specifically uses Redis 8.2 and PostgreSQL 17 to match the
managed production service majors. Every PostgreSQL matrix leg includes the migration,
history-grant, playback, repository, and PostgreSQL/Redis cross-store contracts.

The immutable-image gate uses a SigV4-authenticated isolated S3 harness to run the
private canary lifecycle and exact-version purge protocol. The accepted proof contains
exactly 4 accepted PUTs and 18 authenticated accepted
`ListObjectVersions`/`DeleteObject` operations, with at least 3 independently
sequence-bound privacy replays. It includes version-bound HEAD, GET, and ACL checks
plus exact-version deletion followed by two complete scans proving the locally observed
version absent and authenticated exact-version HEAD 404 proofs. This proves the image's
isolated wire contract; it does not replace the separate live Tigris provider
attestation required for Fly. The retained private bucket must have snapshots enabled
before that live proof so canary writes receive provider version IDs.

Before deploying, a bounded non-serving candidate probe reads writer protocol state
with the exact immutable image. Missing or v5 state selects `transition` followed by
`v6`; established v6 selects `v6` only. Unsafe or ambiguous state blocks rollout.

Each selected phase's guarded release command constructs PostgreSQL first and runs the
exact bounded `SELECT 1 AS ready` before constructing Redis or S3. It then validates
Redis 7/8, standalone writable-primary topology, `noeviction`, the read-only
phase-specific writer boundary, private bucket ownership, version-bound privacy, and
the exact-version erasure canary. All owned preflight resources close on success or
failure. Only after that gate does the command migrate PostgreSQL, activate
and attest fenced provider mutations, and apply the phase-specific Redis mutation.

Transition initializes missing state to v5 and confirms v5 without changing it. The v6
phase advances only v5 to v6 and confirms v6 without changing it; neither can downgrade
v6. CI deploys every selected phase with the same digest and attests at least two
started, uncordoned, healthy Machines with the exact image, service topology, VM shape,
phase environment, and writer boundary across repeated intervals. Therefore a missing
or v5 rollout is transition then v6, while an established v6 rollout skips transition
and deploys and attests v6 directly.

Deployment and the release command remain blocked before durable migration or protocol
mutation while the provider's exact-version canary deletion contract is unverifiable
or required PostgreSQL, Redis, private object storage, stable secrets, and two-Machine
topology are absent. Secret values and Fly API response bodies are never logged.
