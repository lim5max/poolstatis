# Browser analytics

Poolstatis Browser Analytics is an optional, consent-gated capture and typed
analysis contract. It is not session replay and it does not make arbitrary
browser data queryable.

## Atomic registry setup

Call `POST /api/v1/projects/:slug/properties/browser-analytics` with
`{"route_keys":["home","docs","pricing","account","invite","other"]}`, or MCP
`propose_browser_analytics(project, route_keys)`. The route list is the exact
finite vocabulary that capture may store; setup is idempotent only for the same
canonical sorted vocabulary.

Setup takes a project advisory lock, runs one `SERIALIZABLE` transaction,
preflights the entire reserved property/metric bundle before writes, and
commits all definitions together. SQLSTATE `40001` and `40P01` retry at most
three times; exhaustion returns `503 browser_setup_retryable` with
`retryable: true`. Registry and query caches invalidate only after commit.

Definitions remain `proposed`. An owner must review and trust the enum
`$route_key`, then activate `web_page_views`, before canonical browser capture
or route analysis is available.

## Browser SDK and consent

The root SDK exports `createBrowserAnalytics`. The host must provide a finite
route mapper:

```ts
import { createBrowserAnalytics, createClient } from '@poolstatis/sdk';

const client = createClient({ url, ingestKey });
const browser = createBrowserAnalytics({
  client,
  neutralClient: client,
  hasConsent: () => consent.analytics,
  subscribeConsent: onAnalyticsConsentChange,
  mapPagePath(pathname) {
    if (pathname === '/') return 'home';
    if (pathname.startsWith('/docs/')) return 'docs';
    if (pathname === '/pricing') return 'pricing';
    return 'other';
  },
});

browser.start();
```

`mapPagePath` returns one key declared in atomic setup, not a pathname. Dynamic customer,
invitation, document or token identifiers must map to a finite key such as
`account`, `invite` or `other`.

Supported policies are explicit `opt-in`, `opt-out` and `external`. Global
Privacy Control disables every mode. No browser storage is read before
collection is allowed. Withdrawal clears browser-owned queued events,
listeners and identifiers. `resetIdentity()` rotates visitor/session state on
logout or account switch.

Custom product events called through `browser.track()` use the neutral client
path and never receive `$browser_context`. Canonical browser context is limited
to `page.viewed` and `page.engagement`.

## Canonical events and engagement

`page.viewed` requires `$browser_context = "1"`, a host-mapped `$route_key`
from the trusted enum, an opaque identifier-shaped `$page_view_id` and
non-empty `session_id`.

`page.engagement` additionally carries cumulative `sequence`,
`foreground_ms`, `elapsed_ms`, `max_scroll_pct`, `interaction_count` and a
supported lifecycle `reason`.

The server keeps the highest sequence per
`(project, env, resolved actor, session_id, page_view_id)`. Exact
`foreground_ms >= 10000`, two page views, or an active selected key metric is
positive engagement evidence. A complete 9,999 ms single-page session is a
known negative. An incomplete negative remains `null`.

`visibilitychange:hidden`, `pagehide` and `freeze` produce terminal snapshots
and request keepalive flush. Canonical events carry capture timestamps, while
session duration uses the monotonic `elapsed_ms` evidence anchored to the page
view. Hidden/frozen time does not accrue foreground duration. Legacy/manual
`page.viewed` events without the marker remain accepted and stored but stay
outside canonical Web analytics.

## Typed queries

The shared `POST /api/v1/projects/:slug/query` route supports:

- `kind: "web_analytics"` — visitors, sessions, page views, measured coverage,
  rates, lifecycle-complete average duration and bounded breakdowns;
- `kind: "web_sessions"` — deterministic bounded session list;
- `kind: "web_session"` — one actor-scoped session and bounded pages;
- `kind: "page_engagement"` — one actor-scoped page result.

Sessions are distinct `(resolved actor, non-empty session_id)` pairs. Session
ordering is `started_at DESC, session_id, actor_id`. Detail calls without
`actor_id` fail closed when an identifier belongs to multiple resolved actors.
Rates and duration are `null` when their evidence denominator is absent.
Source is consented session landing attribution, not causal campaign credit.
It is opt-in at query time: `source` is not a default dimension and requires a
separately trusted canonical `$utm_source` definition.
Breakdowns return at most 50 rows and report truncation.

MCP parity:

- `get_web_overview` / `query_web_analytics`;
- `list_web_sessions`;
- `get_web_session` / `get_session_engagement`;
- `get_page_engagement`;
- resource `poolstatis://standard/browser-analytics`.

There is no raw SQL or raw event-name escape hatch.

## Privacy boundary

The contract never stores or returns raw IP (including IP-literal referrer
origins), full URL/query/hash, full user
agent or versions, DOM/selectors/text/replay, or secret-bearing dynamic path
data.

Country is unavailable. Core includes no MMDB, proxy trust or country UI.
Only coarse device/browser/OS/language/timezone/size buckets and explicitly
consented bounded UTM landing labels are accepted; URL-, path- and query-shaped
attribution values are dropped/rejected. Key-name heuristics are not used as
privacy control: canonical event fields are exact allowlists, and custom
browser-marked events are rejected.
