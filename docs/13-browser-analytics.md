# Browser Analytics Context

`@poolstatis/sdk/browser` is an optional policy-gated layer over the neutral
`@poolstatis/sdk` transport.

- Visitors are unique query-time resolved actors with `page.viewed` events.
- Sessions are distinct non-empty `session_id` values on those events.
- Page views are accepted stored `page.viewed` events.

These are different measures. Anonymous browser events keep a first-party
opaque `visitor:*` id. After authentication, call `identify(userId)` and send
its returned actor-link handoff to your trusted backend. That backend creates
the existing audited actor link; never expose an `sk_` or `pt_` token in a
browser.

## SDK and privacy

```ts
import { createClient } from '@poolstatis/sdk';
import { createBrowserAnalytics } from '@poolstatis/sdk/browser';

const transport = createClient({ url, ingestKey });
const browser = createBrowserAnalytics({
  client: transport,
  consentPolicy: 'external',
  hasConsent: () => consent.analytics,
  subscribeConsent(listener) { return consent.subscribe(listener); },
  captureAcquisition: true,
  mapPagePath: (pathname) => publicRouteVocabulary(pathname),
  contextProperties: ['$device_class', '$browser_family', '$os_family'],
});

browser.start();
browser.track('signup.started');
const link = browser.identify(user.id); // send link to your trusted backend
```

Consent policy belongs to the integrating product:

- `opt-in` is the backward-compatible default. Both consent callbacks are
  required, and no browser state is read before the host grants consent.
- `opt-out` is an explicit host choice. It starts immediately when callbacks
  are omitted; a host with a reversible preference supplies the same callbacks
  and returns `false` after Disable.
- `external` requires both callbacks and delegates the decision to a CMP or
  another host-owned source.

Global Privacy Control disables collection in every mode. A withdrawal
synchronously removes queued browser events, stored ids and navigation
listeners. Policy selection changes only when collection may begin; it cannot
add properties or expand the fixed capture allowlist.

When a host loads an already-disabled preference or GPC state before creating
the client, call `clearBrowserAnalyticsIdentity()` once. It removes an older
first-party visitor/session without starting capture or resolving analytics
transport.

When collection is enabled, the module stores an opaque visitor id
in first-party local storage and a 30-minute inactivity session in session
storage. It captures the initial pathname and SPA history changes. Query
strings, fragments, full URLs, DOM, page text, form values and referrer paths
are never captured.

The session is scoped to one browser tab because its id lives in session
storage. A second tab is a separate session. Activity rotates after 30 minutes
of inactivity; an SPA route change first closes the old page under its original
session and then opens the new page under the rotated session.

`captureAcquisition: true` composes the existing
`@poolstatis/sdk/attribution` bounded UTM snapshot into the same session and
the same page-view event. Do not run `createAttributionClient` beside this
browser module: both own page views and would intentionally create two
billable events. The composed mode stores only allowlisted UTM values, landing
pathname and referrer origin.

If routes can contain customer or invitation slugs, provide `mapPagePath` and
return a finite product-route vocabulary. The mapped path is used for both
`$page_path` and `landing_path`; a mapper error falls back to `/other` and never
falls back to the raw pathname.

`contextProperties` can narrow the typed coarse dimension list. It cannot add
custom fields: unknown names are ignored at runtime. The default preserves all
documented coarse dimensions for existing integrations.

Reserved context is bounded to device class, browser family, OS family, primary
language, IANA timezone, coarse viewport/screen buckets and pathname. Full user
agent, browser/OS versions, precise dimensions, hardware concurrency, canvas,
fonts and other fingerprinting inputs are not sent.

Call `resetIdentity()` on logout or before switching accounts on a shared
browser. It rotates both the visitor and session before another user is
identified, preventing cross-account actor links. The next explicit page view
for the current route is captured under the new identity. Already queued events
keep their original valid identity. If browser storage is readable but refuses
the replacement, reset rotates the in-memory identity and throws an explicit
stale-storage error so the product does not silently reload the old visitor.

## Page and session engagement

The browser module owns one `page.viewed` event for the initial document and
each distinct mapped SPA route. It assigns a stable `$page_view_id` and emits
cumulative `page.engagement` snapshots with:

| Property | Meaning |
|---|---|
| `$page_view_id` | Opaque id shared with the owning `page.viewed` event. |
| `sequence` | Monotonically increasing snapshot sequence for that page. |
| `foreground_ms` | Cumulative time while visible and focused. |
| `elapsed_ms` | Monotonic wall time since the page began; not active time. |
| `max_scroll_pct` | Maximum bounded scroll depth reached. |
| `interaction_count` | Count of coarse pointer/key interactions while active. |
| `reason` | `heartbeat`, `visibility_hidden`, `blur`, `route_change`, `pagehide`, `freeze`, or `destroy`. |

The heartbeat is 10 seconds. Lifecycle flushes are cumulative rather than
additive. Core chooses the highest sequence per `$page_view_id`, so duplicate
retries and out-of-order delivery cannot double-count time. The SDK uses a
monotonic clock and caps one suspended foreground gap at 30 seconds. Time while
hidden or unfocused is excluded. Core accepts at most seven days of monotonic
duration per page and rejects snapshots where foreground time exceeds elapsed
time.

Session classification is computed at project + environment + browser-tab
`session_id` grain:

- engaged: total measured foreground time is greater than 10 seconds, or the
  session has at least two page views, or it contains the selected active
  native key metric;
- bounce: the complement of engaged only when every page view in the session
  has a lifecycle-boundary snapshot; heartbeat-only evidence remains
  incomplete;
- single-page: exactly one page view, independent of engagement;
- incomplete: at least one page view lacks a valid timing snapshot.

The API returns foreground time separately from wall-clock session span.
Incomplete sessions return `bounce: null`; they never become fake zeros. A
browser crash may leave a page incomplete because JavaScript cannot guarantee
an exit callback.

This is bounded engagement evidence, not video, DOM replay, eye tracking or
precise pointer replay.

## Country

Country is never inferred from locale or timezone. Core supports two mutually
exclusive trusted modes.

For a proxy that already derives a country value, Core accepts ISO alpha-2
only when the direct socket peer is in an explicit trusted proxy CIDR:

```dotenv
POOLSTATIS_COUNTRY_HEADER=cf-ipcountry
POOLSTATIS_TRUSTED_PROXY_CIDRS=10.0.0.0/8,2001:db8::/32
```

Without both settings Core records `unknown`. It ignores forwarded client IP
headers and never persists or returns the socket IP. Configure this only when
the reverse proxy derives the header from its own local GeoIP database. City
and region are unsupported. VPNs, privacy relays, corporate gateways and mobile
networks can make country inaccurate.

For a direct-VPS deployment, Core can instead read a local MaxMind-format
country database:

```dotenv
POOLSTATIS_COUNTRY_MMDB_PATH=/run/geoip/dbip-country-lite.mmdb
POOLSTATIS_CLIENT_IP_HEADER=x-poolstatis-client-ip
POOLSTATIS_TRUSTED_PROXY_CIDRS=172.30.0.0/24
```

The direct peer must still be an allowlisted proxy. The configured client-IP
header must contain exactly one public address; proxy chains, arrays, private,
reserved, loopback, link-local and malformed addresses fail closed to
`unknown` before lookup. The address exists only in request memory and is
never added to an event, response, or log. Startup requires the exact
`DBIP-Country-Lite` database type plus a valid known-address smoke lookup.
A configured missing, wrong-type, or openable-but-invalid MMDB aborts startup
so an operator cannot mistake a broken resolver for working country coverage.

DB-IP Lite Country is a no-account monthly MMDB source under CC BY 4.0. Pin
the dated download and published checksum, install it read-only out of band,
and restart Core to load the replacement. When this resolver is active,
Web analytics responses and UI include the required
`IP Geolocation by DB-IP` attribution link. Do not download the database from
the request path.

## Registry, query and billing

Call `propose_browser_analytics` or
`POST /api/v1/projects/{slug}/properties/browser-analytics`. It idempotently
creates canonical properties plus proposed `web_page_views` and `web_visitors`
metrics. The same setup request also creates the existing bounded UTM
definitions required by composed acquisition and the source breakdown.
Conflicting meanings fail with `409`; the owner reviews and activates the
bundle. Setup is idempotent but not transactional across the three registry
groups; after resolving a conflict, repeat it to complete any partial bundle.

`get_web_overview` / `query_web_analytics` (Query DSL
`kind: "web_analytics"`) references the page-view count metric and returns the
three headline counts, measured engagement coverage and count/page-view
percentage breakdowns for country, device, browser, OS, language, timezone and
source. `list_web_sessions`, `get_web_session`,
`get_session_engagement` and `get_page_engagement` expose bounded session/page
evidence. `get_click_map` and `get_scroll_map` require the exact
surface/version/route/device tuple and default to unique-session aggregation.
No-data reasons, sample size and truncation are explicit.

Reads remain project/environment isolated and use the `EventStore` seam.
Responses name any dimension truncated beyond the bounded top 50; the customer
UI shows a bounded initial result and labels that percentages still use all
page views.

Enrichment and queries emit no extra event. The SDK snapshots do: every
accepted stored `page.viewed`, `page.engagement` and key-metric event remains
one billable stored event. Deduplicating cumulative snapshots changes the
read-time aggregate, not accepted stored-event accounting.

## Rollout

No database migration is required.

1. Deploy Core/customer admin from the reviewed SHA.
2. Configure exactly one reviewed trusted-proxy country mode, or accept
   `unknown`. A shared proxy without fixed source CIDRs and an authoritative
   client-IP contract is not eligible for local-MMDB mode.
3. Propose, review and activate the canonical registry bundle.
4. Upgrade the SDK and import only `@poolstatis/sdk/browser`.
5. Choose and document the host's policy. Keep the default `opt-in`, explicitly
   select `opt-out`, or integrate an `external` CMP; wire Disable/withdrawal.
6. Verify prod/dev separately through `query_web_analytics`.

The Core source contains `query_web_analytics`, but a public MCP package must
be independently released and smoke-tested before Setup may promise that
tool. GeoIP rollout does not publish or alter the MCP package.

Older SDK/base-SDK users are unchanged. Attribution remains a separate
entrypoint for acquisition-only instrumentation; Browser Experience remains
separate. Use the browser module's composed acquisition option when one event
needs both traffic context and source.

## Official comparison

Amplitude documents browser page/session autocapture, a 30-minute web session
timeout, and server GeoIP/device enrichment:

- https://amplitude.com/docs/sdks/analytics/browser/browser-sdk-2
- https://amplitude.com/docs/data/understand-ip-address-and-location
- https://amplitude.com/docs/data/sources/instrument-track-sessions

Poolstatis intentionally excludes the broader privacy-hostile defaults: no raw
IP, full user agent, full URL/referrer, click IDs, DOM/text or precise device
details.
