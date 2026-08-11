# Lifecycle audit P2 — shipped boundary and blocked contracts

Date: 2026-08-11

This note records the P2 audit decision. It deliberately does not add admin placeholders.
Every item below must ship as one server-backed capability across persistence, REST, MCP,
admin read-back, and tests.

## Already shipped: durable release observation

The release monitor is a real background worker, not a planned UI concept:

- deployed and observing releases are claimed in bounded batches;
- fixed contract observation windows, attempts, blockers, next evaluation time, leases,
  capped retries, and terminal failure state are persisted;
- evaluation uses the same immutable evidence and decision policy as REST/MCP;
- `list_releases` and the Platform REST list expose attempts, next evaluation time, and retry
  state;
- Ship renders that state and never turns a waiting release into a zero-value result;
- concurrency/restart behavior is covered by `test/release-monitor.test.ts` and the decision
  loop E2E tests.

This is a fixed contract-driven monitor. It is not a user-configurable monitoring product.

## Blocked: configurable monitors and safe automatic-pause proposals

Current missing contract:

1. A versioned `monitor_policy` resource scoped to project, environment, release/experiment,
   metric key, comparison rule, threshold, minimum sample, cooldown, owner, and status.
2. Persisted evaluation windows, deduplication key, lease/retry state, and immutable finding
   snapshots distinct from release evaluation attempts.
3. Explicit notification routing by destination id; credentials remain in the existing
   encrypted destination store and never enter a finding payload.
4. A proposal state machine for `observe -> propose pause -> human approve/reject -> execute`.
   The proposal must freeze the exact flag allocation and return an undo payload plus
   confirmation fingerprint. Detection alone may not mutate traffic.
5. REST CRUD/read-back, equivalent MCP tools, an admin review surface, tenant isolation,
   concurrent-worker/idempotency tests, and an end-to-end proof with a real flag evaluation.

Until this exists, the UI must describe only fixed release observation and approval-gated
prepared actions. It must not claim configurable alerts or automatic pause/rollback.

## Blocked: scheduled insight feed

`schedule_observation` schedules another attempt for one existing release. It is not a
general scheduled insight feed.

The feed needs a separate durable contract:

1. A saved semantic query/template reference, project/environment scope, timezone-aware
   cadence, recipient destination ids, owner, status, and next run time.
2. Immutable run records with resolved query window, definition revisions, result/evidence
   refs, delivery state, deduplication key, and bounded retry/lease state.
3. A privacy-safe payload schema that leads with the answer and evidence quality and excludes
   raw events, actor ids, arbitrary properties, and connector credentials.
4. Pause/resume/update semantics that cannot duplicate a delivery after restart or concurrent
   claims.
5. REST, MCP, admin, worker, timezone/DST, idempotency, tenant-isolation, and delivery tests.

Without those resources, reusing the release monitor timer or rendering a schedule control
would be a decorative and operationally unsafe shortcut.

## Blocked: versioned definition impact preview

Contracts freeze revisions on releases and decision history can mark stale context, but there
is no pre-change impact graph for editing a metric definition.

The complete feature needs:

1. An immutable metric-definition revision model and an explicit draft diff; current mutable
   metric rows are insufficient for a trustworthy preview.
2. A project-scoped dependency graph covering contracts, funnels, experiments, flags,
   releases, saved/scheduled queries, and prior decisions.
3. A bounded recomputation preview over named windows that reports old/new values, actor and
   event coverage, changed dependencies, unavailable comparisons, and cost limits. It may not
   rewrite historical evidence.
4. Optimistic apply using the previewed revision/hash, with a stale-preview conflict when any
   dependency changes.
5. REST diff/apply/read-back, equivalent MCP tools, an admin review flow, migration/backfill,
   dependency-race tests, and end-to-end proof that frozen release evidence remains unchanged.

Until that contract ships, Registry may show current usage and contracts may show revisions,
but neither should be labelled an impact preview.

## Release gate for these P2 items

No P2 item is complete from a schema or screen alone. The minimum gate is migration plus
service, REST, MCP, admin, targeted integration tests, full type/test/build gates, and
desktop/mobile verification. Any traffic-changing action additionally requires an exact
prepared payload, human approval, audit identity, idempotency, and tested undo.
