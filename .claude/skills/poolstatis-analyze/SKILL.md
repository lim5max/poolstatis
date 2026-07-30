---
name: poolstatis-analyze
description: Use when answering a product question from Poolstatis trends, funnels, retention, lifecycle, stickiness, entities, people, browser analytics, web engagement, experience maps, releases, or saved insights.
---

# Analyze Poolstatis data

Use the declared metric purpose, query grain, and current project schema. Never substitute a raw event name or an invented metric for a registry key.

<!-- published-mcp-required: list_projects,get_onboarding_status,get_project_schema,query_trend,query_funnel,query_retention,query_lifecycle,query_stickiness,query_entities,get_person,list_releases,get_release,evaluate_release,list_insights,list_visual_experience_versions,get_visual_experience_map,compare_visual_experience,query_interaction_map -->

## Required context

1. Call `list_projects`, resolve the target project and environment, and ask only when more than one plausible target remains.
2. Call `get_onboarding_status` with the resolved `project` and explicit `env`; state any measurement blocker that affects the answer.
3. Read `poolstatis://standard/instrumentation`.
4. For `prod`, read `poolstatis://{project}/schema`; for any other environment, call `get_project_schema` with the resolved `project` and explicit `env` because the resource form is prod-only.
5. Consult the [MCP reference](https://poolstatis.xyz/docs/mcp-tools) and [instrumentation standard](https://poolstatis.xyz/docs/standard) for current query contracts and semantics.

## Workflow

1. Restate the question as a measurable outcome, population, environment, and time range.
2. Route current measurement questions to the matching typed query: trend, funnel, retention, lifecycle, stickiness, entities, or person history. Use schema metric keys only.
3. The pinned public MCP runner does not yet expose specialized browser aggregates, session/page engagement, or click/scroll map reads. Do not substitute a generic trend for visitors, sessions, bounce, duration, or completeness. A trend over a page-view metric can answer event counts only, and must be labelled as that narrower grain.
4. Route captured visual experience questions through `list_visual_experience_versions`, `get_visual_experience_map`, or `compare_visual_experience`; resolve the exact surface, route, version, and device for those snapshot reads. Use `query_interaction_map` only at its aggregate surface, environment, period, and grid grain, and state that it does not isolate route, version, or device.
5. Route release questions through `list_releases`, `get_release`, and `evaluate_release`; route saved findings through `list_insights`. Do not replace those persisted records with an unrelated fresh query.
6. Run the selected read/evaluation with the resolved project and environment; pass explicit `env` wherever the tool supports it. Inspect data-quality or onboarding blockers before interpreting it.
7. Report the exact grain: events, unique actors, entities, funnel entrants, retained cohort, visual snapshot or interaction-map evidence, release evidence, or saved-insight scope; include date range, filters, comparison basis, and incomplete data.
8. Map the result back to the metric's `purpose` and funnel `goal`. Separate observed facts from inference and recommended action.
9. Save a reproducible insight only when the user asks or when the current workflow explicitly requires persistence.

## Completion evidence

An answer must include the tool or query used, relevant metric keys, project/environment, date range or persisted evidence window, grain, result, and caveats. For browser questions outside the pinned runner's published capability, state the unsupported grain and use `—` instead of inventing visitors, sessions, bounce, duration, or completeness. Visual snapshot answers must state surface, route, version, and device; aggregate interaction-map answers must state surface, environment, period, grid, and the lack of route/version/device isolation. A plausible narrative without a successful current read or evaluation is not analysis.
