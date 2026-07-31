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

That persistent visitor id may be the exposure unit for an anonymous
browser-surface feature flag or experiment when its outcome is measured on the
same visitor identity. Name the unit `browser_visitor`; it is not a deduplicated
user and cannot join browsers or devices. Never substitute a session or page
view id. Authenticated outcomes such as signup or payment require the audited
actor link described above.

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
storage. It maps the initial pathname and SPA history changes to a
product-owned finite route key. Raw paths, query strings, fragments, full
URLs, DOM, page text, form values and referrer paths are never captured.

The session is scoped to one browser tab because its id lives in session
storage. A second tab is a separate session. Activity rotates after 30 minutes
of inactivity; an SPA route change first closes the old page under its original
session and then opens the new page under the rotated session.

`captureAcquisition: true` composes the existing
`@poolstatis/sdk/attribution` bounded UTM snapshot into the same session and
the same page-view event. Do not run `createAttributionClient` beside this
browser module: both own page views and would intentionally create two
billable events. The composed mode stores only allowlisted UTM values, the
trusted `landing_route` key and referrer origin.

Provide `mapPagePath` and return a key from the exact finite vocabulary passed
to setup. The mapped key is used for both `$route_key` and `landing_route`.
Mapper exceptions fall back to `other`; unsafe returned values fail closed and
never fall back to the raw pathname.

Attribution-only capture uses the same contract: run browser analytics setup
with its finite `route_keys` first and mark `$route_key` as trusted.
`landing_route` is rejected unless it belongs to that vocabulary, even when
`createAttributionClient` is used without the full browser module.

`contextProperties` can narrow the typed coarse dimension list. It cannot add
custom fields: unknown names are ignored at runtime. The default preserves all
documented coarse dimensions for existing integrations.

Reserved context is bounded to device class, browser family, OS family, primary
language, IANA timezone, coarse viewport/screen buckets and a finite route key. Full user
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
| `reason` | `heartbeat`, `visibility_hidden`, `blur`, `route_change`, `pagehide`, `freeze`, `duration_rollover`, or `destroy`. |

The heartbeat is 10 seconds. A custom heartbeat must be an integer from one
second up to, but not including, seven days. Lifecycle flushes are cumulative
rather than additive. Core chooses the highest sequence per actor and
`$page_view_id`, so duplicate
retries and out-of-order delivery cannot double-count time. The SDK uses a
monotonic clock and caps one suspended foreground gap at 30 seconds. Time while
hidden or unfocused is excluded. Before a page reaches Core's seven-day
monotonic duration ceiling, the SDK finalizes it with `duration_rollover` and
starts a new page view for the same route. Core rejects snapshots where
foreground time exceeds elapsed time.

Session classification is computed at project + environment + resolved actor +
browser-tab `session_id` grain:

- engaged: total measured foreground time is at least 10 seconds, or the
  session has at least two page views, or it contains the selected active
  native key metric;
- bounce: a complete session with no positive engagement evidence;
- single-page: exactly one page view, independent of engagement;
- incomplete: at least one page view lacks a valid timing snapshot.

Positive evidence returns `engaged: true` even when a later page is incomplete.
A complete negative returns `engaged: false` and `bounce: true`. All other
sessions return `engaged: null` and `bounce: null`; they never become fake
zeros. `measured_sessions` counts only non-null classifications,
`unknown_sessions` counts unresolved sessions, `measured_session_coverage` is
measured divided by total, and engagement/bounce rates are divided by measured
sessions. Zero denominators return `null`. The API returns foreground time
separately from wall-clock session span. A browser crash may leave a page
incomplete because JavaScript cannot guarantee an exit callback.

This is bounded engagement evidence, not video, DOM replay, eye tracking or
precise pointer replay.

## Country

Country is unavailable in the E1 Web Analytics contract. It is never inferred
from locale or timezone, and canonical browser events do not persist an IP or
country property. The source tree retains fail-closed proxy/MMDB resolver
primitives for a separately reviewed future lifecycle, but configuring them
does not activate geography in E1 ingest or queries.

## Registry, query and billing

Call `propose_browser_analytics(project, route_keys)` or
`POST /api/v1/projects/{slug}/properties/browser-analytics` with the complete
finite `route_keys` vocabulary. It idempotently
creates canonical properties plus proposed `web_page_views` and `web_visitors`
metrics. The same setup request also creates the existing bounded UTM
definitions required by composed acquisition and the source breakdown.
Conflicting meanings fail with `409`; the owner reviews and activates the
bundle. Setup is one serialized `SERIALIZABLE` transaction with full preflight
and bounded retry, so a conflict cannot leave a partial bundle.

`get_web_overview` / `query_web_analytics` (Query DSL
`kind: "web_analytics"`) references the page-view count metric and returns the
three headline counts, measured engagement coverage and count/page-view
percentage breakdowns for route, device, browser, OS, language, timezone,
source, medium and campaign. Availability is evaluated per requested
dimension: missing trusted route, acquisition or country contracts are omitted
from `breakdowns` and reported in `meta.unavailable_dimensions` without hiding
headline traffic, engagement or other available dimensions. Filters remain
fail-closed because they change the population being counted.

`list_web_sessions` does not require route setup and keeps actor-safe session
summaries available. `get_web_session` remains route-dependent because it
returns an ordered route sequence. `get_session_engagement` and
`get_page_engagement` expose bounded session/page evidence. `get_click_map` and
`get_scroll_map` require the exact
surface/version/route/device tuple and default to unique-session aggregation.
No-data reasons, sample size and truncation are explicit.
If a session/page id is shared by multiple actors, detail tools fail closed
unless the caller supplies the `actor_id` returned by `list_web_sessions`.

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
2. Define the complete finite non-sensitive route vocabulary.
3. Propose it atomically, then review and activate the canonical registry bundle.
4. Upgrade the SDK and import only `@poolstatis/sdk/browser`.
5. Choose and document the host's policy. Keep the default `opt-in`, explicitly
   select `opt-out`, or integrate an `external` CMP; wire Disable/withdrawal.
6. Verify prod/dev separately through `query_web_analytics`.

The Core source contains `query_web_analytics`, but a public MCP package must
be independently released and smoke-tested before Setup may promise that
tool.

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
