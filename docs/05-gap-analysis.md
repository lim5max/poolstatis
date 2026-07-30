# Poolstatis gap analysis vs PostHog

> **Updated:** 2026-07-20. **Lens:** agent-native, semantics-first and deliberately
> lightweight. A feature ranks highly only when it strengthens a coding agent's
> `ship → measure → decide` loop without bypassing registered meaning or requiring PostHog's
> ClickHouse/Kafka/visual-dashboard footprint.

## Executive summary

The P0/P1 Product Decision Loop is implemented. Poolstatis now connects a repository-owned
hypothesis to trusted metrics, the exact deployed commit, immutable evidence, an explicit
human decision and a separately approved follow-up action. This closes the earlier gaps in
proof-gated onboarding, actor linking, property taxonomy, bounded PostHog reads, release
provenance, release evaluation, correlation hypotheses, generic webhook delivery and
project-scoped decision memory.

The product is no longer just a typed PostHog subset. Its differentiator is the auditable
code-to-decision chain:

```text
poolstatis.yml → deployed commit → fixed evidence window → keep/fix/rollback/inconclusive
                → human review → exact approval-gated follow-up
```

The main remaining product gaps are now:

1. **Reusable cohorts.** Actor links and trusted property definitions are present, but saved
   static cohorts and cohort filters/targets are not.
2. **Semantic performance.** Registered-metric/funnel rollups are not materialized; reads
   still execute against the Postgres event store.
3. **Production proof.** The controlled PostHog path and local end-to-end paths exist, but a
   real design-partner repository still needs to run the entire contract → deploy → decision
   loop with production data and operator feedback.
4. **Multi-instance operations.** Quotas and bounded workers are safe per process / through
   Postgres claims, but Cloud replicas still need shared quota coordination and explicit
   operational dashboards/alerts.
5. **Distribution integration.** `@poolstatis/mcp@0.4.0` is the historical data
   and audited correction candidate; each hosted deploy must keep it fail-closed
   until the exact registry artifact passes fresh initialize, 99-tool list, and
   a project-scoped semantic read.

Session Replay, DOM autocapture, caller-provided SQL/HogQL and connector marketplaces remain
intentional non-goals. They add volume or privacy/infra cost without strengthening the
semantics-first agent workflow.

## Shipped product surface

### Analytics and trust

- append-only runtime ingest behind `EventStore`, previewed/idempotent historical
  backfill, audited optimistic event corrections, entity merge-upsert and ingest warnings;
- registry metrics with mandatory `purpose`, funnels with mandatory `goal`;
- typed Query DSL: trend, funnel, entities, retention, lifecycle, stickiness and Browser
  Experience reads;
- audited, reversible actor links resolved at query time without rewriting events;
- property definitions with type, purpose and `proposed | trusted | untrusted` state;
- measurement trust reports for sample, registration, actor and target-property coverage;
- proof-gated onboarding based on server facts, including a real MCP observation and query;
- bounded encrypted read-only PostHog adapter for schema/sample/trend/funnel/retention.

### Ship, measure and decide

- deterministic feature flags, exposure events and Bayesian experiment results;
- versioned `poolstatis.yml` contracts with deterministic validate/diff/apply/export and
  optimistic revision checks;
- idempotent release registration with commit/deploy provenance, frozen contract revision
  and follow-up `originating_decision_id`;
- immutable evidence sets with exact windows, query specs, trust and blockers;
- deterministic `keep | fix | rollback | inconclusive` proposal policy;
- human approve/reject/edit with append-only revisions;
- bounded correlation explanations labelled as hypotheses, not causal conclusions;
- prepared actions with exact payload, expected effect, undo, confirmation fingerprint and
  separate approval;
- durable release monitor, evaluation attempts, encrypted webhook destinations and retrying
  outbox;
- decision inbox and project-scoped, stale-aware history/similarity search;
- admin audit surfaces: Setup & MCP, Measurement, Changes and Decisions;
- REST and MCP surfaces for the same product workflow.

The complete behavior and safety boundaries are documented in
[09-product-decision-loop.md](09-product-decision-loop.md).

## Current architectural facts

- `src/stores/eventStore.ts` is the storage seam. New event-derived query behavior must stay
  implementable on Postgres and a future ClickHouse adapter.
- `src/schemas.ts` and `src/services/query.ts` keep query inputs typed and registry-key based;
  clients never supply raw SQL.
- Identity resolution is an explicit project+env link fact. It is cycle-checked, audited and
  reversible; immutable events retain their original `distinct_id`.
- Measurement contracts, releases, evidence, decision revisions and action audit make product
  intent/provenance first-class rather than reconstructing them from dashboards later.
- Release monitor and webhook outbox use bounded batches, Postgres claims, idempotency keys and
  capped retries. This is durable for restarts; horizontal quota coordination is still a
  separate Cloud concern.
- The headless admin is an operator/audit surface, not a customer analytics dashboard.

## Next priorities

Ranked by **(agent-native fit × decision value) / effort**.

| # | Feature | Effort | Why next |
|---|---------|--------|----------|
| 1 | **Design-partner loop validation** | M | Exercise a real repo, deploy and production dataset; measure time-to-first-decision, trust blockers and human corrections before broadening the product. |
| 2 | **Static cohorts** | M | Reuses trusted properties, entities and actor links; gives contracts, queries and flags a durable audience primitive. |
| 3 | **Semantic metric/funnel rollups** | M | Registry tells the system exactly what to precompute; extends the Postgres ceiling without exposing a second query model. |
| 4 | **Experiment health** | S | Add SRM, sample-size/MDE/runtime guidance and guardrail health as pure, explainable computations. |
| 5 | **Shared Cloud quota coordination** | S/M | Keep existing local limiter as fail-safe, add Redis/edge counters only for multi-replica hosted deployments. |
| 6 | **MCP package/hosted runner proof** | S/M | Publish and exercise the real artifact before Setup presents its command as verified. |
| 7 | **Decision-loop operational health** | M | Surface worker lag, terminal attempts, outbox dead rows and contract/release drift as agent-readable health, not hidden logs. |

Recommended sequencing:

- **Wave A — prove:** design partner, production PostHog/native data, operator interviews and
  explicit completion metrics.
- **Wave B — segment:** static cohorts, cohort query filters and then cohort flag targets.
- **Wave C — scale safely:** semantic rollups, shared quota coordination and worker health.
- **Wave D — refine decisions:** experiment health and additional bounded action destinations
  only when a real workflow needs them.

## Build later

- **Property-only dynamic cohorts** — refreshable saved entity predicates after static cohorts;
  behavioral cohorts wait until event-scan cost is measured.
- **Group analytics** — multi-entity event references and aggregation dimension for concrete B2B
  needs; the Entity primitive already exists.
- **Funnel refinements** — exclusions, time-to-convert and conversion-over-time.
- **Session primitive and paths** — derived edge lists, not a Sankey-first dashboard; likely to
  stress Postgres earlier than semantic reads.
- **Advanced trend math** — formulas, percentiles and smoothing after core decision evidence is
  proven with users.
- **On-demand JSONL/CSV export** — bounded portability escape hatch, not a warehouse platform.
- **Experiments without Poolstatis flags** — variant-property analysis for externally assigned
  experiments.
- **Additional outbound destinations** — issue/draft-PR integrations only when credentials,
  permissions, undo and audit semantics are implemented; current unsupported actions stay inert.
- **Session Replay add-on** — only as a separate encrypted object-storage system with consent,
  masking, sampling, deletion and retention. DOM chunks never enter the events table.

## Intentional skips

| Feature | Why skip |
|---------|----------|
| DOM autocapture | Produces high-volume, semantically empty selector events and undermines mandatory purpose. |
| Raw SQL / HogQL | Bypasses registry meaning, safety and storage portability. Add typed DSL branches instead. |
| Broad CDP/connector marketplace | Integration maintenance does not compound the code-to-decision moat. Keep adapters narrow and evidence-driven. |
| Dashboard-builder parity | The customer/agent consumes structured results; admin remains setup and audit. |
| ClickHouse/Kafka/Temporal by default | Add only after measured Postgres/worker limits, preserving `EventStore` and durable audit seams. |

## Strategic throughline

Poolstatis should win by making every AI-shipped change prove whether it worked. The closed
loop is now present; the next job is not feature accumulation but production validation,
reusable audience semantics and reliable scaling of the evidence path. New work should be
rejected when it cannot point to a clearer, faster or more trustworthy product decision.
