# Poolstatis Browser Acquisition Attribution — PRD

> **Historical PRD — not the current integration reference.** The final shipped
> contract starts on the host's `start()` call, uses finite `landing_route`
> rather than raw/path-shaped landing values, and keeps legacy consent callbacks
> only as optional host-owned pause controls. Use
> [Browser Analytics](../../13-browser-analytics.md) and the SDK guide for the
> current property names and behavior; the proposal details below are archival.

Date: 2026-07-24
Status: implemented
Owner: Poolstatis

## 1. Product decision

Poolstatis needs a small, privacy-bounded way for a browser product to connect a tagged
landing to the meaningful event that follows it. The product should collect a canonical
session acquisition snapshot automatically, so teams do not reimplement UTM parsing and
silently lose attribution after navigation.

This is an attribution input for product analysis, not an ad-tech system and not proof
that a campaign caused a conversion.

## 2. User outcome

A growth or product lead can ask: “Which tagged source brought users who completed
signup, activation or checkout?” A coding agent can add the browser integration once and
query registered metrics by a trusted UTM property through MCP/API.

## 3. Scope

### In scope

- A separate browser-only attribution entrypoint in `@poolstatis/sdk`; the base SDK
  remains browser- and Node-compatible without reading browser globals.
- Consent-gated parsing of an initial browser landing URL.
- A per-session acquisition snapshot on browser-originated product events.
- Canonical UTM properties, property-registry definitions, data-trust coverage and typed
  trend filters/breakdowns.
- Documentation, SDK tests, server/API/MCP coverage and admin read-back.

### Not in scope

- Raw URL or arbitrary query-parameter collection.
- Google/Facebook click IDs, ad spend, ad-platform conversion APIs or server-side ad
  attribution.
- First-touch persistence across sessions, last-touch models, multi-touch models or
  attribution weighting.
- A new dashboard or a dedicated marketing-attribution query type.
- Changing the privacy contract of Browser Experience: its typed interaction endpoint does
  not receive UTM properties or raw URL data.

## 4. Canonical data contract

The helper accepts only the standard UTM query keys below and writes their corresponding
reserved Poolstatis event properties.

| Landing query key | Event property | Meaning |
| --- | --- | --- |
| `utm_source` | `$utm_source` | Publisher, platform or referring source |
| `utm_medium` | `$utm_medium` | Channel or medium |
| `utm_campaign` | `$utm_campaign` | Campaign name or identifier |
| `utm_term` | `$utm_term` | Paid-search term when intentionally supplied |
| `utm_content` | `$utm_content` | Creative or placement variant |

For every accepted value, the helper URL-decodes through `URLSearchParams`, trims
whitespace, normalizes Unicode to NFC and rejects an empty value or one longer than 256
characters. It preserves case. If a key occurs more than once, the first non-empty value
is used. Unknown query parameters are discarded.

The snapshot also contains:

- `landing_path`: pathname only, with no query string or hash;
- `referrer_origin`: origin only, when a referrer exists and is parseable;
- `session_id`: an opaque per-browser-session id.

Neither raw URL nor full referrer URL may enter the generic ingest payload, logs or Browser
Experience endpoint.

## 5. Required behavior

### 5.1 Browser integration and consent

Expose the integration from a separate SDK entrypoint, for example
`@poolstatis/sdk/attribution`. It receives the configured Poolstatis client, a current
`distinct_id` provider, a consent predicate and a safe route/path provider. It must not
attach a listener or read `location` until the predicate permits product analytics.

On `start()`, the helper creates one immutable session snapshot from the current landing.
It sends `session.started` and the initial `page.viewed` through generic ingest and adds
the snapshot to later events sent through the attribution-aware client/wrapper. Navigation
does not change the snapshot. A new browser session always starts with a fresh snapshot.

If no allowlisted UTM value exists, the session is unattributed: no `$utm_*` property is
sent. The helper must not infer a campaign from `referrer_origin` or reuse values from a
previous session.

When consent is withdrawn, the helper stops immediately, clears the in-memory/session
attribution state and drops unsent events queued through the attribution-aware boundary.
It must never read or persist the landing values after withdrawal until a new explicit
start under valid consent.

### 5.2 Identity and event propagation

The session snapshot is attached to events before and after login as long as the product
uses the attribution-aware client. The helper does not invent identity linking: products
must use Poolstatis's explicit actor-link flow where anonymous and authenticated actor IDs
need to resolve as one person. Query-time actor resolution then makes the session's
signup/conversion evidence available under the linked actor without rewriting events.

The wrapper merges system attribution properties last. A caller cannot overwrite
`$utm_*`, `landing_path`, `referrer_origin` or the helper's `session_id` for a managed
event; non-reserved custom event properties remain unchanged.

### 5.3 Semantic layer and analysis

On setup, the integration guide registers the five `$utm_*` properties with event scope,
string type and a concrete acquisition-attribution purpose. They begin as `proposed` and
must be explicitly trusted by the owner before a contract/decision uses one as a target
filter.

Existing typed trend queries must support filtering and breakdown by these registered
properties. Results label the view as **session landing attribution** and never state or
imply causal marketing credit. Funnel steps may filter by the fields where the existing
typed funnel semantics allow it; a campaign-by-funnel breakdown is not part of this
release.

Admin read-back, API and MCP must show the same property name, definition, coverage and
trust state. The admin remains an audit surface, not a marketing dashboard.

## 6. SDK experience

The public API must make the safe path easier than manual parsing. The exact export name
can follow local SDK conventions, but it must provide:

```ts
const analytics = createAttributionClient({
  client: createClient({ url, ingestKey }),
  distinctId: () => currentActorId(),
  hasConsent: () => consent.has('product_analytics'),
  subscribeConsent: (listener) => consent.onChange(listener),
  route: () => router.currentPathname(),
});

await analytics.start();
analytics.track('signup.completed', { plan: 'pro' });
```

The implementation must document how to use the wrapper for SPA route changes and for a
login that changes `distinct_id`. Existing `Poolstatis.track(event, distinctId,
properties)` remains unchanged and never begins collecting UTM parameters implicitly.

## 7. Acceptance criteria

1. A tagged landing produces exactly one `session.started` and initial `page.viewed` with
   the canonical allowed `$utm_*` fields, pathname-only `landing_path`, origin-only
   referrer and one opaque `session_id`.
2. A later `signup.completed` or `checkout.completed` sent through the wrapper retains
   that snapshot after navigation removes the query string.
3. An untagged landing sends no `$utm_*` fields and never inherits a prior session's
   campaign. Unknown query parameters, raw URLs and full referrer URLs are absent.
4. Consent absent or revoked prevents reads and persistence; queued wrapper events with
   attribution are dropped and the next permitted start creates a new session.
5. Anonymous-before-login and authenticated events remain attributable after a valid
   actor link, while immutable stored events keep their original `distinct_id`.
6. API, MCP and admin show the same UTM property definitions and a trend filtered or
   broken down by `$utm_source` returns the expected registered-metric rows.
7. A result carries the session-attribution caveat; no generated explanation calls it
   causal campaign impact.

## 8. Delivery plan

### Milestone 1 — SDK and privacy boundary

- Attribution entrypoint, opaque session lifecycle and property allowlist.
- Consent start/stop, queue clearing and no-browser-global base SDK test.
- Unit tests for normalization, duplicates, unknown parameters, no-tag isolation and
  navigation persistence.

### Milestone 2 — semantic and query read-back

- Property-definition guidance/API/MCP/admin support for the canonical fields.
- Native ingest, metric filter/breakdown and trust-coverage tests.
- Documentation for product instrumentation and limits of the attribution model.

### Milestone 3 — end-to-end proof

- A browser fixture: tagged landing → signup after navigation → actor link → registered
  metric trend broken down by `$utm_source`.
- Browser/admin verification under both consent-granted and consent-revoked paths.

## 9. Release gates

Before calling the feature shipped, run:

```bash
pnpm typecheck
pnpm test
pnpm --dir sdk test
pnpm --dir sdk build
pnpm --dir web build
```

The end-to-end evidence must include the exact ingest payloads, property definitions,
registered metric, query response and admin/MCP read-back. A test with manually injected
`$utm_*` properties alone is insufficient: the browser helper must be exercised.

## 10. Open decisions

1. **Resolved — helper-owned session id, exposed read-only.** The attribution entrypoint
   generates the opaque id on each consented `start()` and exposes `sessionId`; callers
   cannot replace it on managed events. This keeps browser-session lifecycle inside the
   privacy boundary while allowing integrations such as feature exposure to use the id.
   The required `subscribeConsent` callback synchronously stops and clears unsent/retrying
   session data on withdrawal.
2. **Resolved — `referrer_origin` is on by default under product-analytics consent.** It is
   bounded to `URL.origin`, never a full referrer, and no browser value is read before that
   consent. A second consent would add product complexity without reducing the data already
   permitted by the same product-analytics decision.
3. **Resolved — explicit idempotent setup proposes definitions through Platform API/MCP.**
   `propose_acquisition_properties` / `POST .../properties/acquisition-attribution` creates
   the five native string definitions as `proposed`; the SDK's `pk_` cannot mutate registry
   semantics. The owner still explicitly trusts a property before a contract/decision uses it.
