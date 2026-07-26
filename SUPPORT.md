# Jumpgate Bridge Support

## Support Status

Jumpgate Bridge is pre-release. Support is best effort, with no response-time,
compatibility, uptime, or release SLA. A development deployment or configured addon
URL is not a public release.

The repository provides bug, support, and feature issue forms. Use its bug form for
reproducible Bridge defects, support form for sanitized setup questions, and feature
form for bounded proposals.
Private vulnerability reporting is available through the verified link in SECURITY.md.

Do not use a public issue for a vulnerability or for private account data.

## Before Filing

- Reproduce on the newest coordinated versions available together. If none are
  published, identify the exact Bridge commit or version and state that it is a
  development build.
- Determine whether the failure belongs to Bridge, the Jumpgate Kodi fork, Stremio,
  a selected provider, a debrid service, Trakt, TMDB, or self-host infrastructure.
- For self-hosting, confirm Node.js version, deployment mode, HTTPS origin, and
  PostgreSQL, Redis, and subtitle-storage readiness without posting configuration
  values.
- Reduce the problem to the smallest repeatable flow. Do not test with another
  person's profile or a production account you are not authorized to use.

## Useful Sanitized Diagnostics

Include only what is needed:

- Bridge semantic version, commit/build SHA if known, and hosted or self-hosted mode.
- Jumpgate/Kodi and Stremio versions, Android device class and ABI when relevant.
- UTC timestamp or local timestamp with timezone.
- The route name without query strings, configured path segments, media identifiers,
  or tokens, for example `POST /v1/playback/claim`.
- Exact steps, expected result, actual result, HTTP status, and stable error code.
- Whether the problem reproduces with Trakt, TMDB, subtitles, and provider import
  disabled or enabled.
- A short, manually reviewed log excerpt with all capabilities and personal data
  replaced by consistent placeholders.

Do not attach an entire log, HAR capture, database export, Redis dump, environment
file, screenshot of a browser address bar, or unreviewed screen recording.

## Never Post

Issues and pull requests must not contain:

- Configured addon URLs, install URLs, or encrypted configuration blobs.
- Pairing codes, device codes, management links, or Stremio approval links.
- Device tokens, install tokens, profile tokens, session cookies, or CSRF tokens.
- Provider or debrid URLs, request headers, authorization values, or cookies.
- Stremio authentication material or account credentials.
- Trakt access or refresh tokens, authorization codes, or client secrets.
- TMDB API keys.
- Fly.io tokens, app secrets, database or Redis URLs, object-store credentials,
  encryption material, or other deployment secrets.
- Raw private logs or media/account screenshots containing private data.

Use placeholders such as `<CONFIGURED_ADDON_URL>`, `<PROFILE_ID>`,
`<PROVIDER_HOST>`, and `<REDACTED_TOKEN>`. Pairing codes are short-lived but are
still private.

## Triage Boundaries

Maintainers can investigate Bridge code and documented release compatibility. They
cannot provide support for third-party provider availability, debrid subscriptions,
Stremio accounts, Trakt accounts, TMDB accounts, Fly.io accounts, or a self-host
operator's infrastructure.

For provider-specific failures, report only generic provider capability shape,
resource type, sanitized status/error information, and whether the behavior occurs
with a synthetic or public test provider. Do not disclose the provider URL or its
credentials.

The project-hosted instance and every self-hosted instance have different operators.
A self-host operator is responsible for access, logs, backups, data requests, and
service recovery. Jumpgate maintainers cannot inspect that operator's private data.

There is no complete self-service profile deletion interface in the current Bridge
and no project-hosted privacy-request channel. The private vulnerability channel in
SECURITY.md is only for suspected security issues. Do not put a profile identifier or
capability in a public issue, and do not treat a public issue as a deletion request or
proof of identity.
