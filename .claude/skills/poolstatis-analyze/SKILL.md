---
name: poolstatis-analyze
description: Use when answering a product question from Poolstatis trends, funnels, retention, lifecycle, stickiness, entities, people, browser analytics, web engagement, experience maps, releases, or saved insights.
---

# Analyze Poolstatis data

Use the declared metric purpose, query grain, and current project schema. Never substitute a raw event name or an invented metric for a registry key.

## Required context

1. Call `list_projects`, resolve the target project and environment, and ask only when more than one plausible target remains.
2. Call `get_onboarding_status` with the resolved `project` and explicit `env`; state any measurement blocker that affects the answer.
3. Read `poolstatis://standard/instrumentation`.
4. For `prod`, read `poolstatis://{project}/schema`; for any other environment, call `get_project_schema` with the resolved `project` and explicit `env` because the resource form is prod-only.
5. For browser, session, page, click-map, or scroll-map questions, also read `poolstatis://standard/browser-analytics` before choosing a query.
6. Consult the [MCP reference](https://poolstatis.xyz/docs/mcp-tools) and [instrumentation standard](https://poolstatis.xyz/docs/standard) for current query contracts and semantics.

## Workflow

1. Restate the question as a measurable outcome, population, environment, and time range.
2. Route current measurement questions to the matching typed query: trend, funnel, retention, lifecycle, stickiness, entities, or person history. Use schema metric keys only.
3. Route browser totals and privacy-safe dimension breakdowns through `query_web_analytics` or `get_web_overview`. Route bounded session/page evidence through `list_web_sessions`, `get_web_session`, `get_session_engagement`, and `get_page_engagement`. Route spatial interaction questions through `get_click_map` or `get_scroll_map` only when the exact surface, route, version, and device are resolved.
4. For web engagement, keep visitors, sessions, page views, cumulative foreground duration, completeness, bounce, and incomplete lifecycle evidence distinct. Never infer a completed bounce or duration from a missing terminal lifecycle event.
5. Route release questions through `list_releases`, `get_release`, and `evaluate_release`; route saved findings through `list_insights`. Do not replace those persisted records with an unrelated fresh query.
6. Run the selected read/evaluation with the resolved project and environment; pass explicit `env` wherever the tool supports it. Inspect data-quality or onboarding blockers before interpreting it.
7. Report the exact grain: events, unique actors, visitors, sessions, page views, complete or incomplete engagement observations, spatial buckets, entities, funnel entrants, retained cohort, release evidence, or saved-insight scope; include date range, filters, comparison basis, and incomplete data.
8. Map the result back to the metric's `purpose` and funnel `goal`. Separate observed facts from inference and recommended action.
9. Save a reproducible insight only when the user asks or when the current workflow explicitly requires persistence.

## Completion evidence

An answer must include the tool or query used, relevant metric keys, project/environment, date range or persisted evidence window, grain, result, and caveats. Browser answers must also state consent/privacy scope and whether lifecycle timing is complete; map answers must state surface, route, version, and device. Use `—` for unavailable values. A plausible narrative without a successful current read or evaluation is not analysis.
