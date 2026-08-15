# Poolstatis Agent Onboarding and Growth Plan

> **Historical planning snapshot — not current product truth.** This document
> records the 2026-06-27 proposal and its then-current gaps. Browser Analytics,
> developer-labelled Browser Experience capture, interaction maps, session
> timelines, answer-first graphs, and the published SDK were implemented later.
> Use the current [README](../README.md), [gap analysis](05-gap-analysis.md),
> [Browser Analytics](13-browser-analytics.md), and SDK guide for shipped status.

> Date: 2026-06-27.
> Goal: turn Poolstatis from "agent-native analytics infrastructure" into a product that a founder or coding agent can connect, verify, and trust in one session.

## Product thesis

Poolstatis should not compete as a cheaper PostHog or a simpler Amplitude. The sharper position is:

**The coding agent designs the tracking plan, installs the client, registers semantic metrics, verifies real events, and answers whether the shipped change worked.**

The defensible part is not MCP alone. PostHog and Amplitude already expose MCP surfaces. The defensible part is the full loop from code instrumentation to verified metric semantics:

1. Every metric has a `purpose`.
2. Every funnel has a `goal`.
3. Queries use metric keys, not raw event names or SQL.
4. The admin proves that the agent actually connected, events arrived, and active metrics match the registry.
5. The first success moment is an answer, not a dashboard.

## Evidence from current product

Current repo state already supports the base loop:

- Hosted onboarding creates a workspace/project and one-time `pt_` + `pk_` tokens.
- Setup & MCP exposes client presets for common MCP hosts.
- The SDK batches, retries, flushes on page hide, and writes events/entities.
- Query DSL supports `trend`, `funnel`, `entities`, `retention`, `lifecycle`, and `stickiness`.
- The registry already supports `value` metrics with `sum`, `avg`, `min`, `max`, and `p90`, so timing/performance metrics fit the current model.

Important correction to `docs/05-gap-analysis.md`: retention, lifecycle, and stickiness are now implemented in the codebase. The strategic third bucket from that document should become the next focus: the agent-native control loop.

## External market notes

Links checked on 2026-06-27.

- PostHog MCP is already broad: hosted endpoint, setup wizard, many supported coding clients, and read/write access across analytics, flags, errors, SQL, CDP, and support workflows. Source: https://posthog.com/docs/model-context-protocol
- PostHog's free tier is aggressive: 1M analytics events, 1M feature-flag requests, 5K recordings, 100K exceptions, 1 project, 1-year retention, no credit card. Source: https://posthog.com/pricing
- PostHog user reviews are generally strong, but repeated weak spots are learning curve, complexity, advanced docs/help gaps, and occasional heavy frontend/app experience. Source: https://www.g2.com/products/posthog/reviews
- Amplitude MCP is also positioned around asking AI tools for product/user insights and can search/create dashboards, charts, notebooks, cohorts, and experiments. Source: https://amplitude.com/mcp-server
- Amplitude Starter includes 10K MTUs / up to 2M events, templates, session replay, feature flags, web experimentation, AI feedback, sources/destinations. Source: https://amplitude.com/pricing
- Amplitude reviews show a similar opening: powerful analysis, but the UI/reporting can feel overwhelming and non-analysts can be slow to become productive. Sources: https://www.g2.com/products/amplitude-analytics/reviews and https://www.trustradius.com/products/amplitude-analytics/reviews
- PostHog web analytics covers visitors, views, sessions, session duration, bounce rate, conversions, paths, and referrers. Source: https://posthog.com/docs/web-analytics
- PostHog autocapture covers interactions, navigation, clipboard, heatmap/dead-click signals, exceptions, sessions, and web vitals. Source: https://posthog.com/docs/product-analytics/autocapture
- Amplitude SDKs manage session IDs automatically; HTTP events without session IDs can be excluded from session metrics. Source: https://amplitude.com/docs/data/sources/instrument-track-sessions

The market lesson: MCP and AI answers are becoming table stakes. Poolstatis should win by making instrumentation verifiable, semantic, and repo-native.

## Onboarding design

The current onboarding form is structurally correct but too shallow. A "strong" onboarding should be a state machine with proof gates, not a token screen.

### Target promise

In 10-15 minutes, a user should reach:

> "My agent connected, instrumented my app, real events arrived, metrics are registered, and Poolstatis answered one product question from the data."

### Main flow

#### 1. Create workspace

Inputs:

- workspace name;
- first project name/slug;
- product type: `website`, `saas`, `ecommerce`, `content`, `ai_app`, `custom`;
- stack hint: `nextjs`, `react`, `node`, `python`, `custom`;
- MCP host preset.

Output:

- org;
- first project;
- `pt_` personal MCP token;
- `pk_` prod ingest key;
- selected metric pack draft.

#### 2. Connect agent

The admin shows a client-specific MCP config, but the next button is not enabled by "I copied it". It is enabled by a real check.

Required proof:

- agent calls `setup_check` or reads `poolstatis://standard/instrumentation`;
- server records `last_mcp_seen_at`;
- admin changes status to connected.

If the hosted MCP runner is still `publish_pending`, the UI must clearly say this is a template and offer the local/workspace command as fallback.

#### 3. Install client

The user chooses "let agent install it" by default.

Admin provides the exact prompt:

```text
Use the Poolstatis MCP server in this repo.
Instrument the app using @poolstatis/sdk.
Use project <slug>, environment prod, and the standard metric pack <pack>.
Register metrics as proposed, add tracking calls, run or explain the smoke path, then call sample_events to verify.
Do not invent events that are not wired in code.
```

The agent should not hand-roll browser timing, queueing, retries, or unload behavior. It should use the SDK and only write product-specific event calls.

#### 4. Register proposed metrics

Metric packs seed a small, opinionated tracking plan:

- `website`: page views, CTA clicks, signup starts/completions, docs searches, pricing views, contact/demo submits, web vital p90s.
- `saas`: activation funnel, core action, invite/share, billing intent, retention action, support/error friction.
- `ecommerce`: product view, cart add, checkout start, payment success, refund/cancel, revenue value metrics.
- `content`: article view, scroll depth milestone, subscription, share, return visit.
- `ai_app`: prompt submitted, answer completed, answer duration, user accepted/retried, generation failed, cost/value metrics.

All seeded metrics are `proposed`, with real `purpose`, category, and tags. Activation stays a human/confirmed-agent action.

#### 5. Verify real traffic

The admin should show a verification console:

- recent MCP calls;
- SDK install status if detectable;
- first event received;
- registered vs unregistered event count;
- ingest warnings;
- last sample events;
- missing required metrics for selected pack.

No fake preview. The system is either waiting, passing, or failing with a concrete reason.

#### 6. Activate registry

The review screen should group metrics by category and show:

- event name;
- metric key;
- purpose;
- observed sample count;
- registration status;
- "why this metric exists";
- activate/deprecate actions.

This turns the admin into an audit surface, not a dashboard.

#### 7. First answer

The final onboarding step should run one query and create one insight:

- `website`: "Which acquisition path reached signup intent?"
- `saas`: "Did users reach the first value action?"
- `ecommerce`: "Where does checkout drop?"
- `content`: "Which pages create return intent?"
- `ai_app`: "Are generated answers completed and accepted?"

The onboarding is complete only after a query result is shown from actual ingested events.

### UI shape

Use a compact, operational layout:

- left rail: `Workspace -> Agent -> Client -> Metrics -> Verify -> First answer`;
- center: current step with exact action;
- right: live proof panel with tokens hidden after first view, connection status, warnings, and "what is blocking completion";
- bottom: command/prompt block for the user's selected MCP host/stack.

Avoid marketing copy inside the admin. The admin should feel like a setup cockpit.

### Failure states

Must be first-class:

- MCP not seen: show exact config and stdio pitfalls.
- `@poolstatis/mcp` not published: show template warning and local fallback.
- No events: show SDK snippet and current ingest key/env.
- Events unregistered: show the event names and offer to register/deprecate.
- Bad `distinct_id`: explain that retention/funnels need stable actor ids until identity merge ships.
- Clock skew: show corrected timestamps and warnings.
- Token lost: route to Keys for new `pt_`/`sk_`.

## Product additions from competitors

Do not copy the whole PostHog/Amplitude surface. Copy the parts that strengthen the agent loop.

### Build

1. **Setup wizard with proof gates**
   - PostHog has a fast wizard; Poolstatis should go further and verify MCP + event + registry + first query.

2. **Metric packs**
   - Pre-built semantic packs for website/SaaS/ecommerce/content/AI app.
   - Unlike dashboards/templates, packs create `proposed` registry entries with purpose and verification requirements.

3. **Agent tracking-plan diff**
   - MCP tool returns a before/after plan: events to add, metrics to register, files touched, and verification commands.
   - This addresses the common "too many options / hard to decide what matters" complaint.

4. **Funnel correlation**
   - Signature insight. Search candidate registered metrics around a funnel drop and explain likely drivers using metric purposes.
   - This should be prioritized ahead of broad dashboard features.

5. **Feature flags + experiments**
   - Minimal deterministic flags, exposure events, and experiments bound to metric keys.
   - The agent can then ship, expose, measure, and recommend continue/rollback.

6. **Property taxonomy**
   - The agent needs to know which properties are trusted and what they mean.
   - Add registry entries for event properties and entity properties before building more query breadth.

7. **Cost and noise guardrails**
   - Show projected event volume before enabling metric packs.
   - Warn when the agent proposes high-volume events with low semantic value.
   - This is a cleaner answer than raw autocapture.

8. **Advanced-docs replacement**
   - Competitor reviews mention advanced docs/help friction.
   - Poolstatis should make errors self-teaching through API/MCP hints, examples tied to the project schema, and `explain_metric`.

### Skip for now

- Full session replay.
- Raw SQL/HogQL.
- Broad autocapture by default.
- Visual dashboard builder.
- Heavy warehouse/connectors marketplace.

These make sense for incumbents but dilute Poolstatis' lightweight agent-native thesis.

## Web/site metrics package

The user question "can we count time?" maps cleanly to the existing `value` metric type.

Example:

```json
{
  "key": "page_read_time_p90",
  "name": "Page read time p90",
  "purpose": "Measures whether visitors spend enough time on content pages to read and evaluate the offer.",
  "category": "activation",
  "tags": ["website", "performance"],
  "type": "value",
  "source": {
    "event": "page.left",
    "value_property": "duration_ms",
    "agg": "p90"
  }
}
```

### Recommended event names

Keep them semantic, small, and useful:

| Event | Required properties | Why |
|---|---|---|
| `page.viewed` | `$route_key`, `$page_view_id`, `session_id` | privacy-safe route and session analysis |
| `page.engagement` | `$route_key`, `$page_view_id`, `foreground_ms`, `elapsed_ms`, `max_scroll_pct`, `session_id` | measured foreground engagement and completion evidence |
| `session.started` | `landing_route`, `referrer_origin`, `$utm_*` | immediate session landing attribution |
| `cta.clicked` | `cta_id`, `$route_key` | conversion intent without captured text or URL |
| `form.started` | `form_id`, `$route_key` | friction before submit |
| `form.submitted` | `form_id`, `$route_key`, `success` | lead/signup intent |
| `signup.started` | `source`, `$route_key` | activation start |
| `signup.completed` | `plan`, `source` | activation completion |
| `docs.searched` | `query_length`, `$route_key` | docs demand without storing raw query or path |
| `mcp_config.copied` | `client`, `project_slug` | onboarding progress |
| `web_vital.measured` | `name`, `value`, `rating`, `$route_key` | performance quality by finite route |
| `api.request.completed` | `route`, `duration_ms`, `status_group` | server/client performance |
| `agent.answer.completed` | `duration_ms`, `accepted`, `retry_count` | AI product quality |

`$route_key` and `landing_route` must come from the same finite trusted
vocabulary, for example `home`, `pricing`, `docs.article`, and `other`.
`referrer_origin` is origin-only, while `$utm_*` values are bounded. Do not
capture raw paths, full URLs, titles, referrers, form
values, copied text, or DOM text. Only the normalized referrer origin is
allowed.

### Web metric pack

Seed these metrics for marketing/public sites:

- `website_visitors`: unique actors on `page.viewed`.
- `landing_views`: count of `page.viewed` where `$route_key=home`.
- `pricing_intent`: count of `page.viewed` where `$route_key=pricing`.
- `signup_intent`: count of `signup.started`.
- `signup_completion`: count of `signup.completed`.
- `cta_clicks`: count of `cta.clicked`.
- `lead_submissions`: count of `form.submitted` with `success=true`.
- `read_time_p90`: p90 `duration_ms` from `page.left`.
- `scroll_depth_avg`: avg `max_scroll_pct` from `page.left`.
- `lcp_p90`: p90 `value` from `web_vital.measured` where `name=LCP`.
- `inp_p90`: p90 `value` from `web_vital.measured` where `name=INP`.
- `activation_funnel`: `page.viewed -> cta.clicked -> signup.started -> signup.completed`.

### SDK API needed

The current SDK should remain the base. Add a web layer rather than making agents rewrite the hard parts.

Proposed API:

```ts
import { createWebClient } from "@poolstatis/sdk/web";

const ps = createWebClient({
  url: "https://api.poolstatis.xyz",
  ingestKey: "pk_...",
  distinctId: () => user?.id ?? anonymousId(),
  web: {
    sessions: true,
    pageviews: true,
    pageleaves: true,
    attribution: true,
    webVitals: true,
  },
});

ps.track("cta.clicked", { cta_id: "hero-start", $route_key: mapRoute(location.pathname) });

const timer = ps.timer("agent.answer");
timer.done({ accepted: true });

await ps.measure("api.request", { route: "/api/search" }, () => fetch("/api/search"));
```

Implementation rules:

- `createWebClient` wraps `Poolstatis`, not replaces it.
- Generate a stable anonymous id in localStorage, but prefer authenticated user id once available.
- Generate `session_id` and manage timeout client-side.
- Emit `page.left` on route change/page hide with `duration_ms`.
- Web vitals should be optional. If adding `web-vitals` dependency is undesirable, start with browser `PerformanceObserver` for LCP/CLS/INP where available and report unsupported metrics as absent, not zero.
- Timers should write `duration_ms` and optional `success`/`error` fields.
- The SDK should never auto-capture DOM text or form values.

Agent role:

- The agent selects metric packs, registers proposed metrics/funnels, and places calls in product-specific code.
- The SDK owns sessions, pageleave timing, batching, retries, keepalive, and performance observers.
- MCP owns verification and semantic registry work.

## MCP and API additions

Add these tools before polishing UI:

1. `setup_check(project?)`
   - returns authenticated org/project scope, token kind, MCP runner status, and recommended next step;
   - records `last_mcp_seen_at`.

2. `suggest_instrumentation_plan(project, { product_type, stack, repo_summary? })`
   - returns metric pack, proposed events, code insertion hints, verification plan.

3. `register_metric_pack(project, { pack, mode: "propose" })`
   - creates proposed metrics/funnels with purposes and goals.

4. `verify_instrumentation(project, { env, pack? })`
   - checks recent sample events, unregistered events, warnings, missing pack requirements, stable `distinct_id` quality, and returns pass/fail gates.

5. `create_first_insight(project, { pack })`
   - runs one query from real data and stores an `insight` if enough evidence exists.

6. `explain_next_setup_step(project)`
   - reads onboarding state and tells the agent exactly what to do next.

Backing state:

- `onboarding_runs`: org/project/user, selected pack, selected MCP host, selected stack, status, created/completed timestamps.
- `onboarding_checks`: run id, check key, status, evidence JSON, last error, updated timestamp.
- `metric_packs`: static definitions in code first; table later only if users customize packs.

## Revised gap-analysis priority

Because retention/lifecycle/stickiness are implemented, the next strategic order should be:

1. **Onboarding proof gates + web metric pack**
   - Commercial prerequisite. Without this, users will not reach the first trusted answer.

2. **Actor link + identity merge**
   - Correctness prerequisite for anonymous-to-authenticated website flows, retention, cohorts, and B2B account analytics.

3. **Funnel correlation**
   - Signature agent insight: "what changed around this drop/lift?" using only registered metrics.

4. **Static cohorts**
   - Needed for flags/experiments and useful for targeted insight.

5. **Feature flags + exposure events**
   - Minimal deterministic evaluator, payloads, exposure dedup, SDK support.

6. **Experiments bound to metrics**
   - Hypothesis, primary metric key, guardrail metric keys, Bayesian chance-to-win, sample ratio mismatch.

7. **Property taxonomy**
   - Makes agent-generated queries safer and reduces "what does this property mean?" ambiguity.

8. **Materialized rollups**
   - Only after real usage shows query pressure.

## Onboarding success metrics

Track Poolstatis' own onboarding with Poolstatis:

- `onboarding.started`
- `workspace.created`
- `mcp_config.copied`
- `mcp.connected`
- `sdk.install_prompt_copied`
- `metric_pack.proposed`
- `first_event.received`
- `registry.activated`
- `first_query.completed`
- `first_insight.created`
- `onboarding.completed`
- `onboarding.blocked`

Key product metrics:

- time from signup to MCP connected;
- time from signup to first event;
- time from signup to first verified answer;
- conversion `workspace.created -> mcp.connected -> first_event.received -> first_insight.created`;
- share of projects with unregistered events after 24h;
- number of agent verification failures per completed onboarding;
- p90 onboarding duration.

## Build plan

### Wave 0: Spec and copy alignment

- Add this document.
- Update `docs/05-gap-analysis.md` to mark retention/lifecycle/stickiness as done and move control-loop work up.
- Add a short docs page for the web metric pack.

### Wave 1: Onboarding backend gates

- Add onboarding run/check state.
- Add `setup_check`, `verify_instrumentation`, and `explain_next_setup_step`.
- Wire admin onboarding status to real checks.
- Tests: hosted onboarding + MCP setup check + failed/no-event verification.

### Wave 2: Metric packs

- Add static pack definitions for `website`, `saas`, and `ai_app`.
- Add `register_metric_pack`.
- Admin review screen groups proposed metrics by pack/category.
- Tests: pack registration creates proposed metrics/funnels with valid `purpose`/`goal`.

### Wave 3: Web SDK layer

- Add `@poolstatis/sdk/web` subpath.
- Implement sessions, pageviews, pageleaves, attribution, timers, measure helper, optional web vitals.
- SDK tests for route/pageleave/timer behavior with mocked fetch and fake clock.

### Wave 4: First answer

- Add `create_first_insight`.
- Onboarding completes only after real sample/query evidence.
- Admin shows the query result and saves a manual/auto insight.

### Wave 5: Agent-native control loop

- Actor link + identity merge.
- Funnel correlation.
- Static cohorts.
- Feature flags + experiments.

## Non-negotiables

- No fake green status.
- No raw SQL escape hatch.
- No broad DOM autocapture by default.
- No hidden capture of form values, copied text, or DOM text.
- No claim that a runner/client works until it has been verified.
- Metrics are not active until user/confirmed-agent activation.
- Every generated metric/funnel needs `purpose`/`goal`.
