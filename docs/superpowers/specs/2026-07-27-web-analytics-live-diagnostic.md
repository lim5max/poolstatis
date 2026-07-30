# Web analytics live diagnostic and country rollout

**Status:** diagnostic evidence and reviewed design only; no production rollout

**Date:** 2026-07-27

**Scope:** `poolstatis-xyz`, `prod`, trailing 30 days

## Sanitized live evidence

The authenticated project-scoped MCP query and the owner UI returned the same
fresh traffic summary:

- visitors: 1;
- sessions: 1;
- page views: 1;
- country: one `unknown` row;
- eligible event-time range: one event at `2026-07-27T15:52:11.063Z`;
- active actor links: 0;
- `dev` summary: 0 / 0 / 0.

The project schema reported 208 accepted, registered `page.viewed` events in
`prod`. A bounded latest-100 sample contained one event with
`$browser_context = "1"` and 99 legacy page views without that marker. The
canonical `web_page_views` metric intentionally filters on that marker so
legacy/manual page views cannot silently acquire browser semantics they did
not capture.

This rules out visitor deduplication as the cause of the 1 / 1 / 1 result.
With no active actor links, distinct anonymous actor ids remain distinct.
Sessions are counted independently from non-empty `session_id` values.

The customer UI does not schedule or cache a report. It sends a fresh query
only after **Run traffic summary** is pressed. Core has a one-second
process-local read cache; accepted ingest invalidates that project's cache in
the serving process, and cross-instance staleness is bounded by the TTL.
The live token can access one project and the requested project/environment
matched, so this was not a project or environment mismatch.

`sample_events` returns the immutable event timestamp and orders its bounded
result by server `ingested_at`, but does not expose `ingested_at`. Therefore
the evidence proves accepted stored events and their event-time range, not an
API-level acceptance timestamp.

## Country root cause

Production Core has neither `POOLSTATIS_COUNTRY_HEADER` nor
`POOLSTATIS_TRUSTED_PROXY_CIDRS`. The running stock Caddy image has no GeoIP
module and its adapted configuration contains no country-header derivation.
Core therefore uses the fail-closed resolver and stores `unknown`.

Sending `CF-IPCountry`, `X-Edge-Country`, `X-Forwarded-For`, locale, or timezone
from the browser must not change this result. Country may be accepted only
when an explicitly configured direct proxy peer supplies a validated ISO
3166-1 alpha-2 value. Raw IP remains outside event properties and query
responses.

The current Jino shared HTTP(S) proxy documentation describes forwarded
protocol/IP headers but does not publish a country header or a stable,
allowlistable proxy CIDR contract. Treating an arbitrary forwarded IP as
trusted would make country spoofable.

## Privacy-safe infrastructure design

Use local edge GeoIP, not client-reported country:

1. Obtain a dedicated origin path where Caddy can identify the real client
   peer, or obtain a written Jino contract for the exact forwarded client-IP
   header and fixed proxy CIDRs.
2. Run an audited, immutable Caddy GeoIP build or a minimal local sidecar with
   a read-only pinned GeoLite2 Country database. The lookup may hold the
   request IP transiently in memory but must emit only an ISO alpha-2 country.
3. Strip any incoming `X-Poolstatis-Country` before lookup. Set that header
   only from the local lookup, then proxy to Core over the private app network.
4. Configure Core with:

   ```dotenv
   POOLSTATIS_COUNTRY_HEADER=x-poolstatis-country
   POOLSTATIS_TRUSTED_PROXY_CIDRS=172.30.0.0/24
   ```

   The CIDR is the fixed private Caddy-to-Core network, not a public client or
   forwarded address. Core remains unreachable directly from the internet.
5. Pin the database checksum/version, update it out of band, and fail closed
   to `unknown` when it is missing, stale, unreadable, or returns an invalid
   code. Country availability must be shown as degraded, never fabricated.
6. Verify spoof rejection, trusted/untrusted peer boundaries, known lookup,
   missing-database fallback, no raw IP in event/sample/query/log output, and
   tenant/environment isolation before production review.

A CDN-derived country header is an alternative only when the origin accepts
traffic exclusively from the CDN's maintained CIDRs (or authenticated origin
transport) and direct-origin requests cannot inject the header. That boundary
does not exist on the current shared-proxy path, so enabling `cf-ipcountry`
today is explicitly unsafe.

## Release boundary

This branch adds regression coverage for anonymous identity grain and the
default untrusted-header fallback. It does not enable country enrichment,
change landing capture, alter accepted-event billing, or deploy anything.
Production may enable country only after the edge trust prerequisites above
have independent review and runtime proof.
