# Flags and Experiments v1 — Design

> **Historical design record.** The “Next modules” section below is not a
> current status list. Browser Experience later shipped as immediate,
> developer-labelled click/scroll/section/error capture with bounded maps and a
> session timeline. A separate consent-gated rrweb Session Replay module later
> shipped; it is not part of Browser Experience or this flags release.

## Decision

Poolstatis will first add a server-evaluated feature-flag and experiment module
for products with stable `distinct_id` values. It closes the agent-native loop
of **ship → expose → measure → decide** without introducing a browser-replay
storage system into the event store.

The separate Browser Experience SDK and Session Replay add-on are documented as
the next modules. They are deliberately not disguised as part of this release:
interaction maps can be privacy-safe event analytics, while visual DOM replay
needs consent, masking, encrypted object storage and deletion workflows.

## Goals

- Create, activate, archive and inspect project-scoped feature flags.
- Deterministically assign a stable actor to one of a flag's variants.
- Capture one exposure event per SDK client/flag/actor tuple automatically.
- Run a draft/running/concluded experiment against an active multi-variant flag.
- Measure a registered event-based primary metric after first exposure and
  report variant sizes, conversion, uplift, credible intervals and chance to
  win.
- Expose every operation through REST, MCP, SDK and the human analysis/admin UI.
- Preserve the project invariants: metric references instead of raw outcome
  event names; every flag has a real `purpose`; every experiment a real
  `hypothesis`; event reads/writes stay behind `EventStore`.

## Non-goals

- Anonymous-to-identified stitching, cohorts, property targeting, holdouts,
  scheduled rollouts and local SDK evaluation.
- Revenue/ratio/funnel experiment objectives. v1 accepts active `count` and
  `unique_actors` metrics whose source is one event.
- Client-side visual editing or no-code experiments.
- DOM capture, replay playback, console/network capture, heatmap screenshots
  or object storage. Those belong to the later Replay module.

## Data model

Migration `009_flags_experiments.sql` introduces two project-scoped metadata
tables.

`feature_flags` stores `id`, `project_id`, a unique snake-case `key`, `name`,
mandatory `purpose`, `status` (`draft`, `active`, `archived`), a stable random
`salt`, and a `variants` JSON array. Every variant has a unique snake-case
`key`, optional JSON `payload`, and `rollout_percentage` in `[0, 100]` with
at most two decimal places. The total allocation must be at most 100%. A gap
means no variant is assigned.

`experiments` stores `id`, `project_id`, a unique snake-case `key`, `name`,
mandatory `hypothesis`, `flag_key`, `primary_metric_key`, optional unique
secondary metric keys, status (`draft`, `running`, `concluded`), `started_at`,
`concluded_at` and a JSON `decision`. The service rejects an experiment whose
flag is not active and exactly 100% allocated, or whose outcome metric is not
an active event-based metric.

An exposure remains an immutable normal event, not a parallel analytics store:
`$feature_flag_called` with properties `{flag_key, variant, payload}`. The
server appends it with `registered=true` and a private `is_system=true` marker
using `EventStore`; this prevents a valid system event from becoming an
unregistered-instrumentation warning and prevents public-ingest lookalikes from
creating experiment assignments.

## APIs and data flow

```text
Admin/MCP --(manage metadata)--> FlagsService / ExperimentsService --> Postgres
SDK --POST /i/v1/flags/evaluate--> FlagsService --append exposure--> EventStore
Agent/MCP --get_experiment_results--> QueryService/EventStore --> structured result
```

### Flag lifecycle

Secret/personal platform tokens use these project endpoints:

- `POST /api/v1/projects/:slug/flags`
- `GET /api/v1/projects/:slug/flags`
- `PATCH /api/v1/projects/:slug/flags/:key`
- `POST /api/v1/projects/:slug/flags/:key/archive`

An ingest key may call `POST /i/v1/flags/evaluate` with `{key, distinct_id,
session_id?}`. The endpoint returns `{key, variant: {key, payload} | null}`.
It rejects draft/archived flags, allocates by a SHA-256 hash of the flag salt
and `distinct_id`, and writes the system exposure event only when a variant is
returned. Allocation uses 10,000 buckets so percentages are precise to 0.01%.

The SDK adds `getFeatureFlag()` and `getFeatureFlags()` methods. Results are
cached by `(key, distinct_id)` for the lifetime of a client, so repeated renders
do not create repeated exposure events. The existing `track`/`capture` methods
remain unchanged.

### Experiment lifecycle and results

Secret/personal platform tokens use CRUD endpoints for experiments plus explicit
start and conclusion operations. An experiment must reference an active flag
with no traffic gap and active registered outcome metrics. Start timestamps are
written once; conclusion freezes its end timestamp and optional agent decision.

`get_experiment_results` evaluates each actor's first exposure to the linked
flag in the experiment window. It counts an actor as converted if they perform
the primary metric's source event after that exposure and before conclusion (or
now). `EventStore.experimentResults()` owns this event read so a future
ClickHouse backend can implement the same narrow request/response shape.

For every allocated variant the response includes `exposed`, `converted`,
`conversion_rate`, `uplift_vs_control`, a 95% equal-tailed Beta posterior
interval and `probability_best`. The control is the first flag variant. The
posterior uses a uniform Beta(1,1) prior and a deterministic seeded Monte Carlo
sampler, making results reproducible in tests and legible to agents.

## MCP and admin

MCP adds `create_feature_flag`, `list_feature_flags`, `update_feature_flag`,
`archive_feature_flag`, `evaluate_feature_flag` (without an exposure side
effect), `create_experiment`, `list_experiments`, `start_experiment`,
`conclude_experiment` and `get_experiment_results`. Tool descriptions explain
the stable-identity requirement and surface `purpose`/`hypothesis` in output.

The existing human analysis/admin workspace gains an `Experiments` screen with Flags and
Experiments tabs. It manages metadata and shows result numbers; it does not
become a dashboard or a replay viewer.

## Errors and safety

- No flag key, malformed variants, duplicate variant keys or total allocation
  above 100% fail at schema validation.
- Evaluation does not reveal draft/archived flags.
- `distinct_id` is mandatory; `session_id` remains optional.
- Experiment starts fail until allocation is exactly 100% and all referenced
  metrics are active event metrics.
- Archiving a flag referenced by a running experiment fails; conclude the
  experiment first.
- Conclusions are append-safe state changes and never delete historical
  exposure events or results.

## Verification

Tests begin red and cover variant stability, independent salts, allocation
edges, no exposure for unallocated traffic, experiment lifecycle guards,
post-exposure conversions, environment isolation and result math. API tests use
the real Fastify server and Docker Postgres. SDK tests use a transport fake only
at the HTTP boundary. A browser E2E smoke verifies the new admin screen can
create a flag and an experiment against a running local backend. Before handoff,
run root typecheck/tests, SDK tests, web build and the E2E smoke; then request a
read-only code review and fix every critical/important finding.

## Next modules

1. **Identity + cohorts + funnel correlation** make experiment targeting and
   anonymous-to-identified measurement reliable.
2. **Browser Experience SDK** emits consent-gated, labelled page, scroll,
   interaction, dead-click and rage-click events. A typed interaction-map query
   aggregates normalized coordinates; it never collects text or CSS selectors.
3. **Session Replay add-on** records DOM only after an explicit consent and
   masking policy, encrypts chunks in S3-compatible object storage, and keeps
   only replay metadata in Poolstatis. It is released only with retention,
   deletion and quota controls.
