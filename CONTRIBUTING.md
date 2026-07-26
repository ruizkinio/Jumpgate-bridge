# Contributing To Jumpgate Bridge

Jumpgate Bridge is pre-release. Contributions should preserve profile isolation,
source-backed playback identity, fail-closed Trakt behavior, and private capability
handling. Development artifacts are not public releases.

## Before Starting

- Use the issue forms for ordinary bugs, support, and feature proposals.
- Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
- Keep a change scoped to the Bridge component. Coordinate cross-repository protocol
  changes with the matching Jumpgate Kodi and release work.
- Search existing tests and documentation before introducing a second protocol or
  storage behavior.

## Development Setup

Use Node.js 24 and npm. Workflow policy tests also require Ruby 3.x with the
Psych standard/default gem; this is checked without downloading a gem or adding a
third-party CI action.

```console
npm ci
node scripts/ci/tooling-prerequisites.js
npm test
npm run policy
```

The default test suite uses local test storage where appropriate. Protected CI also
runs integration gates with PostgreSQL, Redis, and private S3-compatible protocol
harnesses. Do not use live user accounts, paid provider credentials, or production
services as test fixtures.

Before opening a pull request:

```console
git diff --check
node --check index.js
npm test
npm run policy
```

Run any focused integration script relevant to the change. If a required integration
service was unavailable, say exactly which test was not run and why.

## Change Requirements

- Add or update tests for observable behavior, failure paths, and cross-profile
  isolation.
- Keep production behavior fail closed when PostgreSQL, Redis, private subtitle
  storage, HTTPS origin, or stable security material is required.
- Do not add IP-based profile or content identity, filename guessing for canonical
  identity, or a global fallback that can cross profiles.
- Preserve bounded inputs, private-cache headers, origin checks, redacted logging,
  envelope encryption, token hashing, and source-claim requirements.
- Keep migrations forward-only and deterministic. Explain data migration, rollback,
  retention, and mixed-version effects in the pull request.
- Keep Redis writer transitions one-way and atomic. Production protocol cutovers must
  use one immutable image, the guarded release command, and separately attested
  transition and final fleets; never initialize directly to the newer protocol.
- Update component documentation when changing data categories, recipients, TTLs,
  revocation, deletion, deployment, or support behavior.
- Avoid unrelated formatting, generated output, and dependency churn.

## Tests And Fixtures

Use synthetic identifiers, URLs, credentials, provider responses, and subtitle
payloads. Tests must be deterministic and must not call live Stremio, provider,
debrid, Trakt, TMDB, Fly.io, or user-hosted services. Credential-shaped fixtures
should be visibly fake and limited to the test that needs them.

Do not weaken or bypass repository-policy checks to make a change pass. New npm
install scripts require explicit review. GitHub Actions must remain pinned to full
commit SHAs under the repository policy.

## Private Data And Diagnostics

Never place configured addon URLs, pairing codes, management links, device or profile
tokens, provider or debrid URLs, headers or cookies, Stremio credentials, Trakt or
TMDB credentials, Fly.io or deployment secrets, or raw private logs in an issue,
commit, fixture, pull request, screenshot, or CI output.

Use stable placeholders and the minimum sanitized diagnostic snippet. If a real
secret enters Git history, stop, rotate or revoke it, and contact maintainers through
an appropriate private channel before continuing. Removing it in a later commit is
not sufficient.

## Licensing And Upstream Material

Bridge code is licensed under the [MIT License](LICENSE). Unless a file clearly says
otherwise, a submitted contribution is offered under that license, and the
contributor confirms they have the right to submit it.

Do not copy code, tests, images, fonts, protocol text, or other assets from Kodi,
Stremio, addons, SDKs, or another upstream project without verifying compatibility
and documenting provenance. Preserve required copyright and license notices.
Third-party assets already carrying their own notice remain under that notice.

The Kodi fork is GPL-2.0-or-later, but that does not make unrelated Bridge code GPL.
Keep copied or adapted upstream material out of Bridge unless maintainers have
reviewed the license boundary. Prefer a small original interoperability adapter over
vendoring upstream source, generated bundles, binaries, or minified code.

For dependency or GitHub Action updates, document the upstream project, exact
version or commit, license, release source, and security relevance. Do not relax
install-script, action-pinning, or artifact-provenance policy without a separately
reviewable justification.

## Pull Requests

A pull request should include:

- The problem and bounded behavior change.
- Files, APIs, storage records, and trust boundaries affected.
- Tests run and their results.
- Deployment, migration, privacy, compatibility, and rollback notes where relevant.
- Sanitized reproduction evidence for a bug fix.

Maintainers coordinate release versions, production deployment, Android UAT, and
cross-repository compatibility. Merging a pull request does not publish a release.
