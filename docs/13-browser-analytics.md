# Browser Analytics Context

`@poolstatis/sdk/browser` is an optional consent-gated layer over the neutral
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
  hasConsent: () => consent.analytics,
  subscribeConsent(listener) { return consent.subscribe(listener); },
  captureAcquisition: true,
});

browser.start();
browser.track('signup.started');
const link = browser.identify(user.id); // send link to your trusted backend
```

No browser state is read before consent. The module stores an opaque visitor id
in first-party local storage and a 30-minute inactivity session in session
storage. It captures the initial pathname and SPA history changes. Query
strings, fragments, full URLs, DOM, page text, form values and referrer paths
are never captured.

`captureAcquisition: true` composes the existing
`@poolstatis/sdk/attribution` bounded UTM snapshot into the same session and
the same page-view event. Do not run `createAttributionClient` beside this
browser module: both own page views and would intentionally create two
billable events. The composed mode stores only allowlisted UTM values, landing
pathname and referrer origin.

Reserved context is bounded to device class, browser family, OS family, primary
language, IANA timezone, coarse viewport/screen buckets and pathname. Full user
agent, browser/OS versions, precise dimensions, hardware concurrency, canvas,
fonts and other fingerprinting inputs are not sent. Consent revocation removes
queued browser events, stored ids and navigation listeners.

Call `resetIdentity()` on logout or before switching accounts on a shared
browser. It rotates both the visitor and session before another user is
identified, preventing cross-account actor links. The next explicit page view
or SPA navigation is captured under the new identity. Already queued events
keep their original valid identity. If browser storage is readable but refuses
the replacement, reset rotates the in-memory identity and throws an explicit
stale-storage error so the product does not silently reload the old visitor.

## Country

Country is never inferred from locale or timezone. Core accepts ISO alpha-2
country only from a configured header when the direct socket peer is in an
explicit trusted proxy CIDR:

```dotenv
POOLSTATIS_COUNTRY_HEADER=cf-ipcountry
POOLSTATIS_TRUSTED_PROXY_CIDRS=10.0.0.0/8,2001:db8::/32
```

Without both settings Core records `unknown`. It ignores forwarded client IP
headers and never persists or returns the socket IP. Configure this only when
the reverse proxy derives the header from its own local GeoIP database. City
and region are unsupported. VPNs, privacy relays, corporate gateways and mobile
networks can make country inaccurate.

## Registry, query and billing

Call `propose_browser_analytics` or
`POST /api/v1/projects/{slug}/properties/browser-analytics`. It idempotently
creates canonical properties plus proposed `web_page_views` and `web_visitors`
metrics. The same atomic setup also creates the existing bounded UTM
definitions required by composed acquisition and the source breakdown.
Conflicting meanings fail with `409`; the owner reviews and activates the
bundle.

`query_web_analytics` (Query DSL `kind: "web_analytics"`) references the
page-view count metric and returns the three headline counts plus count and
page-view percentage breakdowns for country, device, browser, OS, language,
timezone and source. Reads remain project/environment isolated and use the
`EventStore` seam. Responses name any dimension truncated beyond the bounded
top 50; the customer UI shows the top 8 and labels that percentages still use
all page views.

Enrichment changes only properties of an accepted event. It emits no extra
event, so `events_stored` billing remains the count of accepted non-system
events.

## Rollout

No database migration is required.

1. Deploy Core/customer admin from the reviewed SHA.
2. Configure trusted proxy country settings, or accept `unknown`.
3. Propose, review and activate the canonical registry bundle.
4. Upgrade the SDK and import only `@poolstatis/sdk/browser`.
5. Gate `start()` on consent and wire the authenticated actor-link handoff.
6. Verify prod/dev separately through `query_web_analytics`.

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
