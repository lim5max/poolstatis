---
name: poolstatis-analyze
description: Use when answering a product question from Poolstatis trends, funnels, retention, lifecycle, stickiness, entities, people, releases, or saved insights.
---

# Analyze Poolstatis data

Use the declared metric purpose, query grain, and current project schema. Never substitute a raw event name or an invented metric for a registry key.

## Required context

1. Call `list_projects`, resolve the target project and environment, and ask only when more than one plausible target remains.
2. Call `get_onboarding_status` with the resolved `project` and explicit `env`; state any measurement blocker that affects the answer.
3. Read `poolstatis://standard/instrumentation`.
4. For `prod`, read `poolstatis://{project}/schema`; for any other environment, call `get_project_schema` with the resolved `project` and explicit `env` because the resource form is prod-only.
5. Consult the [MCP reference](https://poolstatis.xyz/docs/mcp-tools) and [instrumentation standard](https://poolstatis.xyz/docs/standard) for current query contracts and semantics.

## Workflow

1. Restate the question as a measurable outcome, population, environment, and time range.
2. Route current measurement questions to the matching typed query: trend, funnel, retention, lifecycle, stickiness, entities, or person history. Use schema metric keys only.
3. Route release questions through `list_releases`, `get_release`, and `evaluate_release`; route saved findings through `list_insights`. Do not replace those persisted records with an unrelated fresh query.
4. Run the selected read/evaluation with the resolved project and environment; pass explicit `env` wherever the tool supports it. Inspect data-quality or onboarding blockers before interpreting it.
5. Report the exact grain: events, unique actors, entities, funnel entrants, retained cohort, release evidence, or saved-insight scope; include date range, filters, comparison basis, and incomplete data.
6. Map the result back to the metric's `purpose` and funnel `goal`. Separate observed facts from inference and recommended action.
7. Save a reproducible insight only when the user asks or when the current workflow explicitly requires persistence.

## Completion evidence

An answer must include the tool or query used, relevant metric keys, project/environment, date range or persisted evidence window, grain, result, and caveats. Use `—` for unavailable values. A plausible narrative without a successful current read or evaluation is not analysis.
