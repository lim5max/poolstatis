# MCP 0.5 browser contract documentation release

`@poolstatis/mcp@0.5.0` synchronizes the packaged MCP documentation with the
production Core and `@poolstatis/sdk@0.3.0` browser contract.

## What agents now read

- `poolstatis://standard/browser-analytics` states that collection starts when
  the host calls `start()`. Poolstatis does not require stored consent and does
  not inspect Global Privacy Control.
- Browser routes are a product-owned finite `$route_key` / `landing_route`
  vocabulary. Raw paths, full URLs, query strings, DOM, page text, raw IP, and
  client-supplied `$country` are outside the contract.
- Country is derived server-side only when a reviewed trusted-proxy/local-MMDB
  boundary is active. Production Cloud enriches new events; historical events
  are not backfilled.
- Visitors, browser-tab sessions, page views, and engagement are distinct
  grains. Incomplete timing evidence remains unknown rather than becoming a
  false zero or bounce.

## Compatibility

Core retains a bounded compatibility normalizer for the previously published
SDK `0.1` payload. It removes legacy `$page_path`, `landing_path`, and `path`
fields instead of rejecting the whole event. SDK `0.2` and later use only the
finite route contract; the current public SDK is `0.3.0`.

Release verification must include an exact package pack/install/protocol smoke,
the previously published SDK fixture, accepted production readback, and an
unchanged rejected-warning watermark. An HTTP 2xx alone is not proof that every
event in a batch was accepted.
