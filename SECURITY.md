# Security Policy

## Release Status

Jumpgate Bridge is pre-release software. Android device UAT, production deployment,
and coordinated release packaging are not complete. A development deployment, a
configured addon URL, or the current default branch is not a supported public
release.

| Version or deployment | Security support |
| --- | --- |
| Current pre-release default branch | Private GitHub security advisories; fixes are best effort |
| Older commits and development deployments | Not supported |
| Coordinated public releases | None published yet |

Security fixes normally target the current development line. No response or fix SLA
is promised during pre-release.

## Reporting Availability

Report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/ruizkinio/Jumpgate-bridge/security/advisories/new).
Do not open a public issue, discussion, pull request, or chat thread for a suspected
vulnerability. Retain the minimum sanitized evidence privately and use only the
verified advisory link above.

This project does not publish a security email address, and no operator identity,
email address, or contact method should be inferred from commit metadata or hosting
details.

Include:

- The affected Bridge version, commit, and deployment mode.
- A concise impact statement and the security boundary that is crossed.
- Reproduction steps using synthetic accounts, tokens, URLs, and fixtures.
- The minimum sanitized request and response metadata needed to reproduce the issue.
- Any known prerequisites, mitigations, or evidence that the issue is already public.

Do not include live credentials or capabilities, even in a private advisory. Revoke
or rotate exposed credentials first, then replace them with stable placeholders.

## Never Publish Or Send

Do not post or send any of the following to maintainers:

- Configured addon URLs or install URLs.
- Pairing codes, device codes, or management links.
- Device tokens, install tokens, profile tokens, session cookies, or CSRF tokens.
- Provider or debrid URLs, request headers, authorization values, or cookies.
- Stremio authentication material or account credentials.
- Trakt access tokens, refresh tokens, authorization codes, or client secrets.
- TMDB API keys.
- Fly.io tokens, application secrets, database URLs, Redis URLs, object-store
  credentials, encryption keys, or other deployment secrets.
- Raw private logs, HAR files, database exports, Redis dumps, screenshots, or videos
  containing any of the above.

Use synthetic values such as `<CONFIGURED_ADDON_URL>`, `<DEVICE_TOKEN>`, and
`<PROVIDER_AUTH_HEADER>`. Keep each placeholder consistent across the reproduction.

## Safe Research

Only test systems and accounts you own or are explicitly authorized to test. Do not
access another profile, retain another person's data, degrade the hosted service,
perform denial-of-service testing, or test provider and debrid services outside their
own authorization rules. Stop after proving the minimum impact needed for a report.

The public or project-hosted Bridge is not an authorization to perform active
security testing. Prefer a local self-hosted deployment with synthetic providers and
credentials.

## Disclosure And Scope

Allow maintainers a reasonable opportunity to reproduce and remediate the issue before
public disclosure. Lack of a response is not permission to publish private user data,
credentials, capabilities, or provider details.

This policy covers the Jumpgate Bridge component in this repository. Kodi fork,
Android packaging, Stremio, Trakt, TMDB, provider, debrid, Fly.io, database, Redis,
and object-storage vulnerabilities belong to their respective projects or operators
unless the defect is caused by Bridge code or configuration. This policy does not
create a bug bounty, safe-harbor contract, payment promise, or support SLA.
