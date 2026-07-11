# Poolstatis Gap Analysis vs PostHog

> **Lens:** agent-native, semantics-first, deliberately lightweight (single Postgres; no ClickHouse/Kafka yet). Every recommendation is filtered through: *does it reuse the existing event store / registry / entity / DSL layers, does it serve a coding agent (not a human UI), and does it preserve the purpose/goal contract that makes insights computable?*

## Executive summary

Poolstatis already owns the hard, differentiating half of PostHog. The metadata plane — a metric registry with a mandatory `purpose`, funnels with a `goal`, entities with merge-upsert, the discriminated-union Query DSL, an MCP-first surface, and a partitioned immutable event store — is in place and is *architecturally cleaner* than PostHog's retrofitted equivalents. The Entity primitive already generalizes both PostHog "persons" and "groups"; the registry is a stronger version of PostHog's taxonomy.

The gaps fall into three buckets:

1. **Read-side query breadth.** Retention, lifecycle, and stickiness now exist in the Query DSL. The remaining high-leverage read feature is funnel-correlation: it should explain conversion movement using registered metrics and their declared purposes.
2. **The actor layer.** `distinct_id` is currently a raw external string with no actor/alias resolution (`docs/01-data-model.md` explicitly defers it). Per-user retention, anonymous→identified funnels, and cohorts are blocked on a small but foundational identity-merge + actor-link change.
3. **The agent-native control loop.** Feature flags + experiments + Bayesian significance turn Poolstatis from a read-only analytics tool into the *ship → measure → decide* loop a coding agent actually runs — reusing Event/Metric/Entity wholesale with zero new infra.

**Validating the brief's hypothesis** (new query types + cohorts + lightweight flags are the natural near-term wins): **mostly correct, but the order has changed as the codebase moved.** Two corrections:

- **Identity/actor resolution must precede cohorts and anonymous→identified analysis.** Retention/lifecycle/stickiness currently operate on raw `distinct_id`; that is acceptable for stable authenticated ids, but anonymous→identified flows still need actor-linking to avoid quiet miscounts.
- **Flags + experiments are higher strategic leverage than stickiness/lifecycle**, even though slightly more work, because they close the agent's core loop.
- **Onboarding proof gates are now a commercial prerequisite.** The product needs to prove MCP connection, SDK install, first event, registry activation, and first query result before a user trusts the agent-native loop. See [08-agent-onboarding-growth-plan.md](08-agent-onboarding-growth-plan.md).

Everything genuinely infra-heavy — session replay, autocapture, HogQL/SQL, ClickHouse/Kafka, real-time CDP fan-out — is correctly skipped or deferred. Replay and SQL are not merely expensive; they are *anti-fits* for an agent consumer and for the semantics-first thesis.

## Implementation update — 2026-07-11

**Feature delivery is now shipped as v1.** Poolstatis has project-scoped
feature flags with deterministic server evaluation, multivariate payloads and
automatic `$feature_flag_called` exposure events. Experiments bind one active
flag to active `count`/`unique_actors` metrics and return post-exposure
conversion, uplift, Beta credible intervals and chance-to-win through REST,
MCP, SDK and the headless admin. v1 intentionally requires stable
`distinct_id`, has no cohort/property targeting, and only starts with a 100%
allocated active flag.

This changes the next browser-oriented priority: do **not** bolt DOM recording
onto `events`. First ship a consent-gated Browser Experience SDK that emits
labelled page, scroll, rage-click, dead-click and error signals, then aggregate
them through a typed interaction-map query. Full Session Replay follows only
with masking, deletion, sampling and encrypted object storage.

---

## What grounds these recommendations (code reality)

Reading the source confirms the research's assumptions precisely:

- **`src/stores/eventStore.ts`** defines a deliberately narrow `EventStore` interface (`append`/`trend`/`funnel`/`sample`/`eventNames`) with a comment that every method "must be implementable efficiently on both Postgres and ClickHouse." New query types = new methods on this seam.
- **`src/services/query.ts`** dispatches on `q.kind` over a `z.discriminatedUnion('kind', …)` (`src/schemas.ts`). New query types are new union branches + new `run()` cases — non-breaking.
- **`src/stores/postgresEventStore.ts`** already implements the windowed self-join CTE pattern in `funnel()` over a monthly-partitioned `events` table. Retention/lifecycle/correlation reuse exactly this shape.
- **`src/services/entities.ts` + `src/stores/filters.ts`** give a single `compileFilters` grammar reused by entities, trends, and funnels — the substrate cohorts and flag targeting reuse, so the agent learns *one* filter language.
- **`distinct_id`** is a raw external id (`src/schemas.ts`, `src/services/ingest.ts`) with no actor/alias layer — identity merge is genuinely unbuilt.
- **`src/mcp/server.ts`** maps tools 1:1 onto REST. Every new feature ships its MCP tool in the same change.

---

## Prioritized build plan

Ranked by **(fit × value) / effort**, excluding infra-heavy items.

### Build now

| # | Feature | Effort | Why it ranks here |
|---|---------|--------|-------------------|
| 1 | **Onboarding proof gates + metric packs** | M | Commercial prerequisite. The user should reach MCP connected → SDK installed → first real event → proposed metrics → activated registry → first answer, with no fake green states. |
| 2 | **Actor link + identity merge** | M | Foundational; unblocks anonymous→identified funnels, accurate cohorts, and better retention. Explicit, audited, reversible alias *fact* resolved at query time — a correctness win over PostHog's destructive ingest-order merge. |
| 3 | **Funnel correlation analysis** | M | Signature feature. Registry-constrained candidate space makes it cheap *and* meaningful; explains drop-off in terms of declared purpose. |
| 4 | **Static cohorts** | S | Materialized entities-query result; reuses Entity + entities query + compileFilters; purpose-tagged; composes as a query filter and flag/experiment target. |
| 5 | **Browser Experience SDK + interaction map** | M | Consent-gated, labelled interaction/friction signals give UX evidence without storing private DOM or bypassing the metric registry. |
| 6 | **Property taxonomy on the registry** | M | Extends existing registry tables; lets an agent introspect "what properties, what do they mean, are they trusted?"; surfaces via existing schema endpoint. |
| 7 | **Materialized rollups for registered metrics/funnels** | M | The registry tells you *in advance* what to precompute — a performance advantage PostHog leaves manual. Keeps single-Postgres fast; buys time before any ClickHouse migration. |

**Recommended sequencing into waves:**

- **Wave A (trust + first value):** onboarding proof gates, website/SaaS/AI metric packs, MCP verification tools, and the first real query result.
- **Wave B (foundation + flagship reads):** actor link/identity merge → funnel correlation. This wave delivers differentiated, computable insights on a correct actor model.
- **Wave C (targeting + qualitative signals):** static cohorts → Browser Experience SDK + typed interaction map. Cohorts make future UX segmentation and flag targeting correct.
- **Wave D (semantic + performance hardening, can overlap):** property taxonomy and materialized rollups. Both extend existing tables and are agent-invisible but compounding.

> **Cross-cutting rule:** every object above ships its REST CRUD **and** its MCP tool in the same change — never as a follow-on. The mandatory `purpose`/`goal` metadata is what makes the MCP responses self-describing.

---

### Build later (right idea, wrong time / blocked on a prerequisite)

- **Stickiness refinements** (S) — the query type exists; next work is better docs, default metric-pack usage, and edge-case tests around partial intervals.
- **Session primitive** (M) — derived, purpose-taggable aggregate (no replay infra); unblocks Paths. Add after the core reads.
- **Paths / user journeys** (L) — edge list, not a Sankey; depends on the Session primitive; the first thing to strain single-Postgres at volume; lower semantic payoff.
- **Funnel enhancements** (M) — exclusion steps, time-to-convert, conversion-over-time; refinements on the working funnel CTE; do after correlation.
- **Trends advanced math** (S) — formulas across metric keys, percentile/median, smoothing; convenience polish over the trend engine.
- **Insight collections / lightweight dashboards** (S) — thin metadata over the Insight primitive as an MCP-addressable bundle; *not* a visual UI.
- **Alerts (fixed + relative thresholds)** (M) — strong on-philosophy fit (fires with semantic context; webhook → agent investigation), but introduces the first background-worker surface.
- **Subscriptions / scheduled computable results** (M) — shares the worker with alerts; "scheduled prompt → grounded summary → deliver" is on-brand.
- **Generic outbound webhook destination** (M) — outbox table + retry worker; how an agent-native system triggers downstream agents; no Hog scripting / no marketplace.
- **Group analytics via the Entity model** (M) — "account" is just another Entity type; only real work is multi-entity event refs + an aggregation-dimension DSL param. Sequence after the actor link; build when a B2B use case appears.
- **Property-only dynamic cohorts** (S/L) — saved entities predicate with a refresh policy; nearly free after static cohorts. (Behavioral/lifecycle dynamic cohorts stay deferred — they need full event scans, the workload ClickHouse exists for.)
- **On-demand event export (JSONL/CSV)** (M) — portability escape hatch; trivial windowed SELECT; no Temporal/multi-warehouse.
- **Single-source incremental external import** (L) — join Stripe plan/MRR to entities; narrow, explicitly-registered import only — never the 60-connector marketplace; strains the lightweight constraint.
- **Experiments without flags (variant property on events)** (S) — a config option on the experiment, essentially free once the experiment query exists; lets agents analyze externally-assigned experiments.
- **Experiment health: SRM + sample-size/MDE/runtime** (S) — cheap pure functions; only meaningful after the experiment + significance core.
- **Session Replay add-on** (L) — encrypted object storage, rrweb masking/block selectors, consent, retention/deletion and sampling. Replay metadata can join analytics by session id, but DOM chunks must never enter the Postgres event table.
- **Per-key rate limiting + remaining CRUD coverage** (S) — lands incrementally as features ship; rate limiting once there is load to protect.
- **Ingestion-warnings / dead-letter table** (M) — agent-inspectable "accepted-but-couldn't-process" log; extend the existing `registered`/207-error handling. (Full Kafka/ClickHouse pipeline stays deferred; keep `EventStore` as the swap seam.)

---

### Skip (anti-fit or out of scope for a lightweight analog)

| Feature | Why skip |
|---------|----------|
| **Session Replay inside `events` / single Postgres** | Still an anti-fit: DOM chunks cannot safely share the immutable analytics event table. A future Replay add-on must use consent, masking, retention/deletion and encrypted object storage; its metadata may join analytics by session id. |
| **Network & console capture (replay add-on)** | Inherits replay's fit/infra problems; the salvageable reframing (latency/error-rate as registered value metrics) needs no new primitive — already expressible. |
| **Autocapture (DOM event collection)** | Philosophical opposite of Poolstatis: high-volume, semantically-empty events whose meaning is reverse-engineered from CSS selectors. Presumes a browser UI; volume hits single-Postgres hardest. The one good idea (flag unregistered events) already exists. |
| **HogQL / raw SQL access** | Anti-fit *by design*. Raw SQL bypasses the registry that makes insights computable/attributable. The closed DSL is a feature; the correct escape hatch is richer DSL query types, not SQL. |
| **Client SDK bootstrapping (flash-of-default)** | Human-frontend-UX concern tangential to the agent-native server-side path; `/flags/evaluate` already returns enough to inline server-side. Premature without a browser SDK + UI. |
| **Advanced flag features (scheduled changes, dependencies, encrypted/remote-config payloads, persist-across-identity)** | Config complexity a single agent operator rarely needs; persist-across-identity is blocked on broader identity machinery. Revisit only on real demand. |
| **ClickHouse + Kafka + Temporal core architecture** | PostHog's single biggest cost; invisible to agents; explicitly out of scope for an intentionally single-Postgres MVP. The durable lesson is already followed: immutable append-only events, Postgres as registry source-of-truth, and a storage-agnostic `EventStore` interface so a future ClickHouse swap is a backend change, not a rewrite. A migration *trigger*, not a feature. |

---

## The strategic throughline

Poolstatis's edge is not feature parity — it is that **semantics are first-class, so insights are computable and the consumer is an agent, not a human eye.** The build-now list is chosen to compound that edge:

- Existing **retention/lifecycle/stickiness** queries already return structured JSON an agent reasons over directly; **funnel correlation** is the next flagship read-side addition. The triangular grids and Sankeys that justify PostHog's UI are secondary here.
- **Funnel correlation** constrained to the registry is the purest expression of "insights become computable": it explains *why* a goal moved in terms of declared purpose.
- **Flags + experiments** close the agent's native loop, and the mandatory hypothesis/goal forces the rigor PostHog leaves optional.
- **Property taxonomy** and **materialized rollups** turn the registry into both an introspection surface and a performance advantage — neither of which PostHog gets for free, because it never required meaning up front.

The honest skips (replay, autocapture, raw SQL, ClickHouse/Kafka) are not deficiencies; refusing them is how Poolstatis stays a lightweight, agent-native analog instead of a half-built PostHog clone.
