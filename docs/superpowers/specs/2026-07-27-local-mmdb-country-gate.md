# Local MMDB country gate

## Decision

The simplest privacy-safe direct-VPS path is an in-process Core lookup against
a read-only local country MMDB. DB-IP Lite Country is usable without an owner
account and publishes a dated monthly MMDB plus checksum. No external
per-request IP service is used.

The current Poolstatis production path remains disabled. Its shared Jino
proxy does not provide a reviewed fixed-CIDR plus authoritative single
client-IP-header contract. Enabling the resolver there would trust a
spoofable value.

## Trust boundary

The resolver accepts a client address only when:

1. the direct socket peer matches an explicit trusted proxy CIDR;
2. the internal header is present exactly once and contains no proxy chain;
3. the value parses as one public unicast IP address.

Only the derived ISO alpha-2 value reaches event enrichment. Raw addresses are
not persisted, returned, or logged. Client-supplied country headers are
irrelevant to local-MMDB mode. Runtime lookup misses return `unknown`; a
configured unreadable database, a type other than `DBIP-Country-Lite`, or a
failed known-address startup smoke lookup blocks process startup.

## Database lifecycle

- Download a dated DB-IP Lite Country MMDB out of band.
- Verify its publisher checksum before installation.
- Keep the file outside images and Git, mounted read-only.
- Record the database date/checksum in release evidence.
- Replace atomically and restart Core; no request-time download or remote
  lookup is allowed.
- Surface the required DB-IP attribution in Web analytics whenever the local
  resolver is active.

## Production prerequisites

Before Cloud wiring or deployment, obtain one of:

- direct origin traffic where the local proxy sees the real client peer; or
- a written provider contract naming the authoritative client-IP header and
  stable proxy CIDRs.

Then add Cloud compose/mount/env wiring in a separate reviewed release and
prove spoof rejection plus a real known-country lookup on the target VPS.
Until then `country = unknown` is the correct fail-closed production result.

## Deliberate non-goals

- No city/region lookup.
- No client-reported country.
- No external per-request IP API.
- No Cloud deployment in this gate.
- No public MCP publication. Public `query_web_analytics` parity remains a
  separate release and registry-smoke requirement.
