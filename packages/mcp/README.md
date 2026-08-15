# @poolstatis/mcp

Thin stdio MCP runner for a Poolstatis API instance.

```sh
POOLSTATIS_URL=https://api.example.com \
POOLSTATIS_TOKEN=pt_your_token \
pnpm dlx @poolstatis/mcp@0.7.0
```

`POOLSTATIS_TOKEN` must be a `pt_` personal token or project-scoped `sk_` key.
`POOLSTATIS_URL` must be a clean HTTPS origin; HTTP is allowed only for a local
loopback API during controlled development. No production URL or token is
embedded in the package, and the runner never prints the token.

Node.js 22 and 24 are supported. The package is an ESM executable and speaks
MCP over stdio only; stdout is reserved for protocol messages.

The root programmatic export is pinned to the same published `0.7.0` profile as
the CLI. Its `McpConfig` intentionally has no distribution override, so local
source-only tools cannot be enabled through the public package API.

## Browser analytics contract

Read `poolstatis://standard/browser-analytics` before instrumenting or
diagnosing browser traffic. In `0.7.0` the embedded standard matches the
production SDK/Core contract:

- `@poolstatis/sdk/browser` starts collection immediately when the host calls
  `start()`; Poolstatis does not require stored consent and does not inspect
  Global Privacy Control;
- the browser sends a finite `$route_key` and `landing_route`, never raw
  `$page_path`, `landing_path`, a full URL, query string, DOM, page text, or raw
  IP;
- `$country` is derived server-side only from a reviewed trusted-proxy/local
  MMDB boundary. Client-supplied country is ignored;
- visitors, browser-tab sessions, page views, and engagement remain separate
  grains. Missing terminal timing evidence is `unknown`, not zero.

Existing `hasConsent` and `subscribeConsent` callbacks remain optional
host-owned pause controls for older integrations. They are not required by the
Poolstatis runtime.

## Session Replay metadata

Version `0.7.0` adds `list_session_replays` and `get_session_replay`. They
return bounded, project-scoped manifest metadata and an admin viewer path.
They never return rrweb events, reconstructed DOM, text, cursor samples,
upload tokens or object-store keys. Recording and playback remain governed by
the separate consent, host-policy, masking, retention and sandbox contract in
Core.

## Compatibility

Core keeps a bounded `/i/v1/events` compatibility path for the previously
published SDK `0.1` payload. It removes legacy raw path fields instead of
rejecting the whole event. New integrations must use SDK `0.3.0` and the finite
route contract. A successful HTTP response is not enough during migration:
verify accepted event readback and `list_ingest_warnings`.
