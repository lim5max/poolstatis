---
name: poolstatis-maintain
description: Use when auditing Poolstatis data health, investigating unregistered or rejected events, reconciling instrumentation drift, or changing the lifecycle of existing metrics and funnels.
---

# Maintain Poolstatis measurement

Treat the current standard, project schema, event samples, and persisted warnings as evidence. Do not clean drift by hiding it or deleting definitions reflexively.

<!-- published-mcp-required: list_projects,get_onboarding_status,get_project_schema,sample_events,list_ingest_warnings -->

## Required context

1. Call `list_projects`, resolve the target project and environment, and ask only when more than one plausible target remains.
2. Call `get_onboarding_status` with the resolved `project` and explicit `env`.
3. Read `poolstatis://standard/instrumentation`.
4. For `prod`, read `poolstatis://{project}/schema`; for any other environment, call `get_project_schema` with the resolved `project` and explicit `env` because the resource form is prod-only.
5. Use the [Quickstart](https://poolstatis.xyz/docs/quickstart), [instrumentation standard](https://poolstatis.xyz/docs/standard), and [MCP reference](https://poolstatis.xyz/docs/mcp-tools) when a current contract is unclear.

## Workflow

1. Establish project, environment, audit window, and measurement grain.
2. Inspect observed event coverage, `sample_events`, `list_ingest_warnings`, and data-quality issues with the resolved `project` and explicit `env`.
3. Trace each mismatch to product code, metric source, lifecycle state, identity, property contract, or an intentionally unmeasured event.
4. Propose the smallest corrective action. Prefer fixing the emitter or updating/deprecating a definition with a reason; delete only an actual mistake after checking references.
5. Make only user-authorized changes. After activating, deprecating, or changing a metric source, allow the ingest registry cache up to 30 seconds to settle; then exercise the affected path and retry once with the explicit target `env` before diagnosing persistent drift.
6. Report coverage, affected volume, findings, actions, verification, and unresolved risks.

## Completion evidence

Do not call drift resolved until fresh server evidence shows the intended state. A metric edit alone does not prove new events are registered, and accepted unregistered events are not lost events.
