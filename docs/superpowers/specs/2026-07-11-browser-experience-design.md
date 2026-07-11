# Browser Experience — Design

## Decision

Poolstatis will ship a **Browser Experience** module instead of an rrweb DOM
replay clone. It records a consent-gated, labelled session timeline and builds
interaction maps from real click coordinates and scroll depth. It is a
first-class analytics module: every collected signal is tied to a registered
surface with a mandatory `purpose`.

This delivers the useful product question — *where do people interact and
where does a session get stuck?* — without silently collecting page text,
inputs, DOM selectors, clipboard contents or network traffic.

## Approaches considered

1. **Full DOM replay (rrweb in the event store): rejected.** It would put
   personal data and high-volume mutation payloads into immutable Postgres
   events, cannot support masking/deletion/retention correctly, and needs
   encrypted object storage before it is safe.
2. **Consent-gated interaction timeline and map: selected.** Stable labels,
   normalized click coordinates, scroll milestones and a coarse error signal
   are compact, queryable, and meaningful to an agent.
3. **Generic autocapture of selectors: rejected.** CSS selectors are unstable,
   semantically empty and create data volume without a declared purpose.

## Public model

`experience_surfaces` is project-scoped metadata:

- `key`: a snake-case surface identifier such as `checkout`;
- `name` and mandatory `purpose`;
- `status`: `active` or `archived`.

The new `@poolstatis/sdk/experience` subpath exports `BrowserExperience`.
It is an optional module, not enabled by the core SDK. Its constructor requires
a `Poolstatis` client, `surface`, stable `distinctId` (string or provider), and
`hasConsent()`. It creates one opaque session id per instance and captures:

- `page_viewed` (a developer-provided stable route key, never a URL/path);
- labelled `element_clicked` events (only `[data-poolsatis-label]`);
- `scroll_depth` milestones (25/50/75/100%);
- a coarse `client_error` type (`error` or `unhandled_rejection`), without
  message/stack data.

Each interaction is sent as a small typed batch to `/i/v1/experience/events`.
The ingest route rejects unknown/archived surfaces, labels over 120 characters,
invalid route keys, invalid normalized coordinates, batches over 100,
and any capture for which the caller did not use an active surface. It stores
the normalized event names `experience.page_viewed`,
`experience.element_clicked`, `experience.scroll_depth`, and
`experience.client_error`; event properties are strictly whitelisted.

## Query model

Two narrow Query DSL branches expose the collected data:

- `interaction_map`: requires a registered surface and date window, returns
  grid cells (`x`, `y`, `count`, `actors`) plus labelled click totals. It maps
  clicks, not gaze or cursor hover.
- `experience_session`: requires a session id and surface and returns the
  ordered, whitelisted timeline plus summary (`page_views`, `clicks`, maximum
  scroll depth, `client_errors`). It does not return DOM/text/URL query data.

Both methods live on `EventStore`, keeping the ClickHouse seam intact.

## Product surfaces

Platform REST supports creating/listing/archiving surfaces; MCP mirrors that
CRUD and adds `query_interaction_map` and `get_experience_session`. The admin
gets an **Experience** page to create surfaces and display a compact grid and
session trace. The SDK docs include explicit consent integration and the exact
data boundary.

## Safety and lifecycle

- Capture is opt-in and is a no-op until `hasConsent()` returns true.
- `stop()` detaches all browser listeners; `start()` is idempotent.
- No text values, DOM snapshots, selectors, URLs/paths, error
  messages/stacks, or raw pointer paths are transmitted.
- Archiving a surface immediately rejects new capture; old events remain
  available for analysis and standard project retention/purge rules apply.

## Verification

Backend tests cover schema, surface lifecycle, rejected payloads, map bins and
timeline ordering. SDK tests use a minimal fake browser to prove consent,
label filtering, route-key isolation, scroll milestones, and listener teardown.
An MCP stdio E2E test creates a surface and queries captured data through the
real server. Admin production build and code review are required before handoff.
