# @poolstatis/sdk

Tiny browser + Node client for sending events and entities to [Poolstatis](../README.md).
Zero dependencies. Batches, retries, and flushes on page unload so you don't lose events.

```bash
pnpm add @poolstatis/sdk   # or npm / yarn / bun
```

```ts
import { createClient } from '@poolstatis/sdk';

const ph = createClient({
  url: 'https://analytics.example.com', // your Poolstatis platform URL
  ingestKey: 'pk_…',                    // write-only ingest key (safe in client code)
});

// Events — distinct_id MUST be a stable user id (not a session/random id).
ph.track('signup.completed', user.id, { plan: 'pro' });
ph.track('doc.exported', user.id);

// Entities — mutable state (merge semantics; null deletes a key).
ph.identify('account', account.id, { plan: 'pro', seats: 7 });

// Feature delivery — stable per user; the first call automatically records
// a $feature_flag_called exposure for experiment measurement.
const checkoutCopy = await ph.getFeatureFlag('checkout_copy', user.id, {
  sessionId: session.id,
});
if (checkoutCopy?.key === 'test') showCheckoutCta(checkoutCopy.payload?.label as string);

// Optional: force-send (e.g. server-side, before exit).
await ph.flush();
```

## What it handles for you

- **Batching** — events queue and flush every `flushIntervalMs` (default 5s) or when the
  batch fills (`maxBatchSize`, default 100; server caps 500).
- **No lost events on navigation** — flushes on `visibilitychange`/`pagehide` via
  `fetch(keepalive:true)` (modern `sendBeacon`, but with the auth header).
- **Idempotent retries** — transient 5xx/network failures retry with backoff under the same
  `batch_id`; the server dedups, so events are never double-counted. 4xx (your bug) is
  reported via `onError` and not retried.
- **Bounded memory** — `maxQueue` drops oldest if the backend is unreachable for a long time.
- **Exposure-safe feature flags** — `getFeatureFlag()` evaluates active flags
  remotely once per `(flag, distinct_id)` client lifetime, caches the stable
  variant and lets the server record the experiment exposure exactly where it
  belongs.

## Options

| option | default | meaning |
|--------|---------|---------|
| `url` | — | platform base URL |
| `ingestKey` | — | `pk_…` ingest key |
| `flushIntervalMs` | `5000` | auto-flush cadence |
| `maxBatchSize` | `100` | events per request (≤500) |
| `maxQueue` | `10000` | in-memory cap (drop oldest) |
| `fetch` | global | inject a fetch impl (tests / old runtimes) |
| `onError` | noop | called when a flush fails after retries |

## Feature flags

`getFeatureFlag(key, distinctId, { sessionId? })` resolves to
`{ key, payload? }` or `null` when the flag has no allocation or evaluation
cannot be reached. `null` is the safe control path; failures also call
`onError`. `getFeatureFlags(keys, distinctId, options?)` evaluates several
flags through the same cache.

The `distinctId` must match the declared exposure unit. Use a stable
authenticated product id for user/account experiments. A persistent
first-party browser visitor id is valid only for an anonymous browser-surface
experiment whose outcome is measured on that same visitor identity; report the
unit as `browser_visitor`, not as a user. Never use a session id, page-view id,
or freshly generated random id. The evaluation request is an exposure event,
so do not call it in a tight loop; a single shared `Poolstatis` client handles
this automatically.

## Browser Analytics Context (optional module)

`@poolstatis/sdk/browser` adds immediate first-party visitors, 30-minute
browser-tab sessions, SPA-safe `page.viewed` events, cumulative
`page.engagement` snapshots and coarse browser context. Collection starts when
the host calls `start()`; no consent state is required and the SDK does not
inspect Global Privacy Control. It never
sends query strings, full URLs/referrers, DOM/text, full User-Agent or precise
screen dimensions. The base SDK remains browser/Node neutral.

```ts
import { createBrowserAnalytics } from '@poolstatis/sdk/browser';

const browser = createBrowserAnalytics({
  client: ph,
  captureAcquisition: true, // reuses the bounded attribution snapshot
  mapPagePath: (pathname) => publicRouteVocabulary(pathname),
  contextProperties: ['$device_class', '$browser_family', '$os_family'],
});
browser.start();

// After authentication, send this handoff to a trusted backend that calls the
// audited Poolstatis actor-link API with an sk_/pt_ token.
const actorLink = browser.identify(user.id);

// On logout/account switch, rotate visitor + session before another identify.
browser.resetIdentity();
```

The module owns exactly one `page.viewed` event per initial load or SPA route.
Each page gets one stable `$page_view_id`. While the document is visible and
focused, the SDK emits a cumulative `page.engagement` snapshot every 10 seconds
and on hide, blur, route change, pagehide, freeze and destroy. A snapshot
contains `sequence`, `foreground_ms`, `elapsed_ms`, `max_scroll_pct`,
`interaction_count` and `reason`. Core keeps only the highest sequence per
page, so retries, duplicate flushes and out-of-order arrival do not add time.
Custom `engagementHeartbeatMs` values must be integer milliseconds from one
second up to, but not including, seven days. One suspended foreground gap is
capped at 30 seconds. A long-lived page is finalized and rotated before Core's
seven-day ceiling, and foreground time is never emitted above elapsed time.
Core accepts a maximum
seven-day monotonic duration per page and rejects impossible snapshots where
foreground time exceeds elapsed time.

Foreground time is not wall-clock time and Poolstatis does not record video or
DOM session replay. A session is engaged when it has at least 10 seconds of
measured foreground time, at least two page views, or an explicitly selected
key-metric event. Bounce is reported only for fully measured sessions; missing
terminal timing remains incomplete instead of becoming a false zero/bounce.
Every accepted `page.viewed` and `page.engagement` remains one stored,
billable event.

Legacy `hasConsent` and `subscribeConsent` callbacks remain compatible as an
optional host-owned pause control. New integrations omit them.
`mapPagePath` is required. Its finite lowercase result is used for both
`$route_key` and `landing_route`, so raw public paths are never sent.
Mapper exceptions fall back to the trusted `other` key; an unsafe returned key
fails closed instead of sending the raw path.
`contextProperties` can only narrow the SDK's typed coarse context list.
Unknown property names are ignored at runtime and cannot expand capture.

Before attribution-only capture, run browser analytics setup with the finite
route vocabulary and mark `$route_key` as trusted. `landing_route` is validated
against that same vocabulary even when `createAttributionClient` is used
without the full browser module.

Composed acquisition uses the same session and page-view event. Do not also
start `createAttributionClient`, which is the acquisition-only alternative and
owns its own page views.

See [Browser Analytics Context](../docs/13-browser-analytics.md) for reserved
properties, finite route-vocabulary setup, definitions and rollout. Existing
0.1 integrations must also follow the [0.2 migration guide](./MIGRATION.md).

## Browser Experience (optional module)

The `@poolstatis/sdk/experience` entrypoint is deliberately separate from the
core client. It records an immediate session timeline of developer-provided
route keys,
**labelled** clicks, scroll milestones and a coarse client-error type. It does
not collect DOM snapshots, text/input values, CSS selectors, URL query/hash,
stacks or error messages.

First create an active, purpose-tagged surface through MCP or the Platform API,
then mark only meaningful product controls:

```ts
import { createClient } from '@poolstatis/sdk';
import { BrowserExperience } from '@poolstatis/sdk/experience';

const analytics = createClient({ url: 'https://analytics.example.com', ingestKey: 'pk_…' });
const experience = new BrowserExperience({
  client: analytics,
  surface: 'checkout',
  distinctId: () => currentUser.id,
  route: () => 'checkout', // stable key; never pass window.location.pathname
  version: import.meta.env.VITE_RELEASE_SHA,
});

await experience.start();
// <button data-poolstatis-label="pay_now">Pay now</button>
// Call `experience.stop()` when the app unmounts.
```

For visual maps the module also sends desktop/mobile, viewport/document
dimensions and normalized document click coordinates. Mark real blocks with
`data-poolstatis-section="pricing"` and clickable targets with
`data-poolstatis-label="pricing.choose_pro"`.

The module does not collect the section's text or DOM. It sends one safe named
exposure per section, batches at most 25 signals per request, and defaults to a
120-signals/minute browser guard.

The agent can use `query_interaction_map` for normalised click cells and
`get_experience_session` for a known session id plus actor id. A reused
session id across actors fails with typed ambiguity instead of combining
people; the read response includes canonical actor/link provenance. These are
interaction maps, not gaze or full session replay.

## Browser acquisition attribution (optional module)

`@poolstatis/sdk/attribution` is a separate immediate browser entrypoint.
The base client never reads `location`, referrer or URL parameters. First use a
Platform API credential or MCP `propose_acquisition_properties` to add the five
canonical `$utm_*` event definitions as `proposed`; an owner must trust one
before using it in a measurement contract or decision target.

```ts
import { createClient } from '@poolstatis/sdk';
import { createAttributionClient } from '@poolstatis/sdk/attribution';

const client = createClient({ url: 'https://analytics.example.com', ingestKey: 'pk_…' });
const analytics = createAttributionClient({
  client,
  distinctId: () => currentActorId(), // can change from anonymous to authenticated
  route: () => mapRoute(router.currentPathname()), // finite key from the trusted route vocabulary
});

await analytics.start(); // exactly one session.started + initial page.viewed
analytics.track('signup.completed', { plan: 'pro' });
// On SPA navigation: analytics.pageViewed();  It preserves the original landing snapshot.
```

The helper owns and exposes `analytics.sessionId`; it snapshots only the
product-owned finite `landing_route`, referrer **origin**, and first valid `utm_source`, `utm_medium`, `utm_campaign`,
`utm_term`, `utm_content` (trimmed, NFC, max 256). It discards unknown query
parameters, raw path/query/hash values, full referrer URLs, click IDs and all
previous-session values. It does not link anonymous and authenticated actors:
use Poolstatis's audited actor-link API/MCP flow for that query-time resolution.

SDK `0.2.0` intentionally removed the raw `landing_path` contract. See
[`MIGRATION.md`](./MIGRATION.md) before
upgrading an attribution integration.

UTM trends are labelled **session landing attribution**. They are associations,
not causal campaign credit or an ad-attribution model.

## Notes

- Runs anywhere `fetch` exists (Node ≥18, modern browsers). Inject `fetch` otherwise.
- On a server, call `await ph.shutdown()` on graceful exit to flush + stop the timer.
- The ingest key only writes events/entities — it cannot read data or touch the registry,
  so it is safe to embed in client-side code.
