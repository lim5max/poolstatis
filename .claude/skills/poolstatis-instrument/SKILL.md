---
name: poolstatis-instrument
description: Use when adding Poolstatis analytics, choosing what a product should measure, registering metrics or funnels, wiring event and entity capture, or verifying that new product observations reach the intended project.
---

# Instrument a product with Poolstatis

Use this skill as a workflow router. Poolstatis standards and the target project's schema are the source of truth; do not restate or guess them from this file.

## Required context

1. Call `list_projects`, resolve the target project and environment, and ask the user only if more than one plausible target remains.
2. Confirm the Poolstatis MCP path by calling `get_onboarding_status` with the resolved `project` and explicit `env`.
3. Read `poolstatis://standard/instrumentation`.
4. For `prod`, read `poolstatis://{project}/schema`; for any other environment, call `get_project_schema` with the resolved `project` and explicit `env` because the resource form is prod-only.
5. Use the current guides when implementation detail is needed:
   - [Quickstart](https://poolstatis.xyz/docs/quickstart)
   - [Instrumentation standard](https://poolstatis.xyz/docs/standard)
   - [MCP reference](https://poolstatis.xyz/docs/mcp-tools)

If a resource or tool is unavailable, report that boundary. Do not invent the missing standard, schema, tool output, metric, or credential.

## Workflow

1. Inspect the product repo and existing analytics. Identify the core value moment, user identity boundary, and decisions the owner needs to make.
2. Reuse the project's category definitions and existing metric keys. Propose a small purpose-backed measurement plan and activation funnel before editing code.
3. Register agreed metrics and funnels through MCP. Treat new definitions as `proposed` until the owner explicitly approves activation.
4. Implement capture in one shared integration module. Use only a `pk_` ingest key in product runtime code; never print or embed `sk_` or `pt_` credentials.
5. Trigger real product paths, then verify with `sample_events`, `get_project_schema`, `list_ingest_warnings`, and `get_onboarding_status`. Pass the resolved `project` and explicit `env` to every environment-aware call.
6. Hand off changed files, observed evidence, proposed metrics awaiting activation, and any blocker.

## SDK availability

Do not assume `@poolstatis/sdk` is published. Before suggesting a registry install, verify it with `npm view @poolstatis/sdk version`.

- If the registry lookup succeeds, follow the versioned SDK guide supplied with that release.
- If it returns 404, use the documented HTTP ingest API or an explicitly approved local/git SDK source. Do not emit `npm add @poolstatis/sdk`.
- If the target repo already has an approved SDK dependency, follow that installed version instead of replacing it.

## Completion evidence

Instrumentation is complete only when the code path was exercised and the server observed the intended event/entity. Report the project, environment, event grain, stable `distinct_id` strategy, sample result, registered/off-standard state, and warnings. A copied config, created metric, HTTP 2xx alone, or unexecuted code change is not completion.
