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

The `distinctId` must be a stable authenticated product id, never a generated
session id. The evaluation request is an exposure event, so do not call it in a
tight loop; a single shared `Poolstatis` client handles this automatically.

## Browser Experience (optional module)

The `@poolstatis/sdk/experience` entrypoint is deliberately separate from the
core client. It records a consent-gated session timeline of developer-provided
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
  hasConsent: () => consent.has('product_analytics'),
});

await experience.start();
// <button data-poolstatis-label="pay_now">Pay now</button>
// Call `experience.stop()` if consent is withdrawn or the app unmounts.
```

The agent can use `query_interaction_map` for normalised click cells and
`get_experience_session` for a known session id. These are interaction maps,
not gaze or full session replay.

## Browser acquisition attribution (optional module)

`@poolstatis/sdk/attribution` is a separate, consent-gated browser entrypoint.
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
  hasConsent: () => consent.has('product_analytics'),
  subscribeConsent: (listener) => consent.onChange(listener), // must synchronously call on withdrawal
  route: () => router.currentPathname(), // safe product route/path provider
});

await analytics.start(); // exactly one session.started + initial page.viewed
analytics.track('signup.completed', { plan: 'pro' });
// On SPA navigation: analytics.pageViewed();  It preserves the original landing snapshot.
// `subscribeConsent` calls stop automatically on withdrawal and drops unsent/retrying attribution events.
```

The helper owns and exposes `analytics.sessionId`; it snapshots only `pathname`,
referrer **origin**, and first valid `utm_source`, `utm_medium`, `utm_campaign`,
`utm_term`, `utm_content` (trimmed, NFC, max 256). It discards unknown query
parameters, query/hash from the path, full referrer URLs, click IDs and all
previous-session values. It does not link anonymous and authenticated actors:
use Poolstatis's audited actor-link API/MCP flow for that query-time resolution.

UTM trends are labelled **session landing attribution**. They are associations,
not causal campaign credit or an ad-attribution model.

## Notes

- Runs anywhere `fetch` exists (Node ≥18, modern browsers). Inject `fetch` otherwise.
- On a server, call `await ph.shutdown()` on graceful exit to flush + stop the timer.
- The ingest key only writes events/entities — it cannot read data or touch the registry,
  so it is safe to embed in client-side code.
