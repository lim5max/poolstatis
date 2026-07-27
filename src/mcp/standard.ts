/**
 * The instrumentation standard, served as the MCP resource
 * `poolstatis://standard/instrumentation` and via GET /api/v1/standard.
 * This is the normative reference an agent follows when instrumenting a product.
 */
export const INSTRUMENTATION_STANDARD = `# Poolstatis Instrumentation Standard (v1)

The job is not "add tracking." The job is to make a product's behaviour
**computable**: every number must trace back to a declared reason. Two rules
hold everything together:

- **Every metric has a \`purpose\`** — one sentence naming the decision it informs.
- **Every funnel has a \`goal\`** — what journey it measures and why.

If you cannot write the purpose, do not register the metric. A metric without a
decision behind it is noise that will be trusted anyway.

---

## 1. The four primitives — pick the right one

| Primitive | Nature | Use it for | Where |
|-----------|--------|-----------|-------|
| **Event** | immutable fact, "X happened at time T" | actions: signups, exports, purchases, page views | ingest \`/i/v1/events\` |
| **Entity** | mutable object with current state | users, accounts, documents — anything with a *current* value | ingest \`/i/v1/entities\` |
| **Metric** | a declared measurement over events/entities | anything you want to chart, alert on, or put in a funnel | \`register_metric\` |
| **Funnel** | an ordered sequence of metrics with a goal | conversion journeys (signup → activate → pay) | \`define_funnel\` |

Rule of thumb: **if it changes over time and you only care about the latest
value, it is an Entity property — not an event property.** A user's plan,
an account's seat count, a document's status: entities. The act of *changing*
the plan can still be an event.

---

## 2. Event naming

- Format: \`object.action\`, lower snake_case: \`checkout.completed\`, \`doc.exported\`.
- **Past tense** for facts: \`completed\`, not \`complete\` or \`completing\`.
- One event per meaningful action. Resist \`button.clicked\` with a \`which\`
  property doing all the work — name the *intent*: \`export.requested\`.
- The \`$\` prefix is reserved for system events/properties (\`$identify\`,
  \`$session_start\`, \`$clock_skew\`). Do not emit your own \`$\` names.

Good: \`signup.completed\`, \`doc.exported\`, \`checkout.completed\`, \`invite.sent\`.
Avoid: \`Signup\`, \`user_signed_up_event\`, \`click\`, \`track\`, \`event1\`.

---

## 3. Required properties & identity

1. **\`distinct_id\` MUST be a stable user id** from the product's auth system —
   the same value every time that user acts. Never use a session id as the actor.
   The one supported anonymous exception is the consent-gated
   \`@poolstatis/sdk/browser\` first-party visitor id: after authentication,
   switch to the stable product user id and create the explicit audited actor
   link returned by the browser module. Sessions remain separate in
   \`session_id\`; query-time identity resolution preserves immutable events.
2. **Money** goes in a numeric \`amount\` property, currency in \`currency\`:
   \`{ "amount": 49.0, "currency": "USD" }\`. Never bake the number into the event name.
3. **Mutable state** (plan, role, lifecycle stage, seat count) belongs on the
   **entity**, upserted when it changes — not copied onto every event. It is fine
   to *also* stamp \`plan\` on events you will break down by plan.
4. **\`timestamp\`** is optional (defaults to receipt time); send client ISO-8601
   with offset when you have it. Far-future or pre-retention stamps are corrected
   and flagged \`$clock_skew\`.
5. Keep properties **low-cardinality where you will break down by them** (plan,
   country, source) and high-signal. Don't dump the whole object.

---

## 4. Metric types — choosing \`type\` and \`source\`

| type | answers | source shape |
|------|---------|--------------|
| \`count\` | how many times did X happen | \`{ event, filters? }\` |
| \`unique_actors\` | how many distinct users did X | \`{ event, filters? }\` |
| \`value\` | sum/avg/p90 of a numeric property | \`{ event, value_property, agg }\` |
| \`conversion\` | what share of users went A → B in a window | \`{ from:{event}, to:{event}, window_seconds }\` |
| \`state\` | how many entities are currently in state S | \`{ entity_type, filters, agg:"count" }\` |

Filters use \`{ property, op, value }\` with ops:
\`eq, ne, gt, gte, lt, lte, in, contains, is_set, is_not_set\`.

Funnel steps and the retention/lifecycle/stickiness query types require
**event-based** metrics (\`count\` / \`unique_actors\` / \`value\`) — not
\`conversion\` or \`state\`.

---

## 5. Metric taxonomy & the north star

The three taxonomy axes are independent:

- Category answers **why** the metric exists. Choose a project definition returned
  by \`get_project_schema\` or \`list_metric_categories\`.
- Prefer **namespaced tags** for where and what:
  \`surface:checkout\`, \`component:payment-form\`, \`channel:telegram\`,
  \`capability:voice\`. Existing plain tags remain valid.
- Funnels answer **which journey** is measured. Do not create journey-specific
  or per-feature categories.

The system library is grouped by purpose domain:

- **Product:** \`acquisition\`, \`activation\`, \`adoption\`, \`engagement\`,
  \`retention\`, \`referral\`, \`satisfaction\`.
- **Business:** \`revenue\`, \`cost\`, \`efficiency\`.
- **Technical:** \`quality\`, \`reliability\`, \`performance\`, \`delivery\`,
  \`security\`, \`data_quality\`.

System category semantics are locked. Create a custom category only when the
metric's purpose cannot be expressed by that library. A null category remains
readable as \`uncategorized\`, but new work should reconcile it when the purpose
is known.

Pick **one north-star metric** the whole product optimises, and make sure the
funnel from acquisition → that metric is fully instrumented.

---

## 6. Starter packs by product type

Minimal, high-signal sets. Adapt names to the product; keep the shape.

**B2B SaaS** — north star: weekly active accounts doing the core action.
- events: \`signup.completed\`, \`workspace.created\`, \`{core_object}.created\`,
  \`{core_object}.shared\`, \`invite.sent\`, \`invite.accepted\`, \`plan.upgraded\`, \`checkout.completed\`
- entities: \`user\`, \`account\` (plan, seats, mrr)
- funnel \`activation\`: signup → first core_object created → invited a teammate

**E-commerce** — north star: completed orders.
- events: \`product.viewed\`, \`cart.added\`, \`checkout.started\`, \`checkout.completed\` (amount), \`order.refunded\`
- entities: \`customer\` (ltv, orders_count)
- funnel \`purchase\`: product.viewed → cart.added → checkout.started → checkout.completed

**Content / subscription media** — north star: weekly returning readers.
- events: \`content.viewed\`, \`content.completed\`, \`subscription.started\` (amount), \`subscription.cancelled\`, \`bookmark.added\`
- entities: \`reader\` (tier, streak)
- funnel \`subscribe\`: content.viewed → paywall.hit → subscription.started

**Consumer mobile** — north star: D7 retained users doing the habit action.
- events: \`app.opened\`, \`onboarding.completed\`, \`{habit_action}.done\`, \`notification.opened\`, \`share.completed\`
- entities: \`user\` (streak, push_enabled)
- funnel \`activation\`: app.opened → onboarding.completed → first habit_action

**Developer tool / API** — north star: weekly active API keys / projects.
- events: \`account.created\`, \`api_key.created\`, \`api.called\` (endpoint, status), \`integration.connected\`, \`plan.upgraded\`
- entities: \`account\` (plan), \`api_key\` (last_used)
- funnel \`activation\`: account.created → api_key.created → first successful api.called

---

## 7. Funnels

- Steps reference **registry metric keys**, not raw event names — so the funnel
  inherits each step's purpose.
- The \`goal\` is mandatory and should read like an outcome:
  "Take a new signup to their first export and then a paid checkout."
- \`window_seconds\` is anchored at the first step. Pick a window that matches the
  journey (activation: 1–14 days; purchase: hours).

---

## 8. Lifecycle: proposed → active → deprecated

- Metrics you register start as **\`proposed\`**. They do not yet count toward the
  "registered" data-quality signal.
- The project owner (or you, on their explicit say-so) **activates** them. Only
  \`active\` metrics mark matching events as registered on ingest.
- When a metric is retired, call **\`deprecate_metric\`** with a real reason —
  never delete; historical queries must keep working and future agents need to
  know why the metric was replaced.

---

## 9. Anti-patterns

- **Vanity events** with no metric/purpose behind them. If you can't name the
  decision, don't track it.
- **Unstable \`distinct_id\`** (session ids, random uuids) — silently corrupts
  every per-user number.
- **State on events only** — you lose the ability to ask "how many accounts are
  on Pro *right now*". Upsert entities.
- **Generic names** (\`click\`, \`action\`, \`event\`) — unqueryable six months later.
- **Cardinality bombs** — free-text or id-valued properties you then break down by.
- **Tracking everything "just in case."** Coverage is not the goal; decisions are.

---

## 10. Feature delivery and experiments

Use a feature flag when the product needs to ship guarded code safely or test
alternatives. Every flag needs a decision-oriented \`purpose\`; every experiment
needs a falsifiable \`hypothesis\` and an active registered outcome metric.

1. Create the flag with deterministic variants and deploy both code paths.
2. Activate the flag only when its allocation and targeting are intentional.
3. For A/B work, create and start an experiment only after the flag allocates
   100% of traffic. The SDK evaluation automatically records
   \`$feature_flag_called\`; do not fake an exposure by manually adding a
   \`variant\` property to outcome events.
4. Read \`get_experiment_results\`, then conclude with \`ship\`, \`iterate\`, \`stop\`
   or \`inconclusive\` plus a rationale. Conclusion freezes the observation window.

Flags and experiments currently require stable authenticated \`distinct_id\`.
Do not use temporary anonymous/session ids until actor identity merge ships.

---

## 11. The agent workflow

1. **Read the schema** (\`poolstatis://{project}/schema\` or \`get_project_schema\`)
   to see what metrics, funnels, entity types and observed events already exist.
2. **Map the product** to a starter pack (section 6); decide the north star and
   the activation funnel first.
3. **Register metrics** (\`register_metric\`) — each with a real \`purpose\` and a
   category. They land as \`proposed\`.
4. **Register entity types** (\`register_entity_type\`) for mutable state.
5. **Instrument the code**: emit events to \`/i/v1/events\`, upsert entities to
   \`/i/v1/entities\`, using a stable \`distinct_id\`.
6. **Verify** with \`sample_events\` that events arrive and are \`registered\`.
   Check \`get_project_schema\` → observed events for unregistered drift.
7. **Define funnels** (\`define_funnel\`) from the registered metrics, with goals.
8. **Hand off**: ask the owner to activate the proposed metrics (or activate in
   the admin panel's Registry tab).
`;

export const BROWSER_ANALYTICS_STANDARD = `# Poolstatis Browser Analytics Context (v1)

Browser Analytics is an optional browser-only SDK entrypoint. It does nothing before
explicit consent. The base SDK remains browser and Node neutral.

Definitions:
- Visitors: unique query-time resolved actors with page-view events. Audited actor links
  can join an opaque first-party visitor to a stable authenticated product user.
- Sessions: distinct non-empty session_id values on page-view events. The default browser
  inactivity timeout is 30 minutes.
- Page views: accepted stored page.viewed events. Country/device enrichment never creates
  another event and therefore does not change accepted stored-event billing semantics.
- Canonical web queries include only events marked $browser_context = "1"; legacy/manual
  page.viewed events are not silently mixed into the consented browser population.

Privacy boundary:
- Captures pathname only, never query strings, fragments, full URLs, DOM, text or inputs.
- Sends coarse device/browser/OS families, primary language, timezone, and coarse
  viewport/screen buckets. It never sends full User-Agent, versions, precise dimensions,
  canvas/fonts/hardware concurrency or other fingerprinting material.
- Country is never inferred from locale. Core accepts a coarse ISO country only from a
  configured directly trusted reverse proxy and otherwise records unknown. Raw IP is
  neither stored nor returned. GeoIP can be wrong for VPNs, relays and mobile networks;
  city and region are intentionally not collected.
- Use resetIdentity on logout/account switch. For combined UTM + browser context, enable
  the browser entrypoint's composed acquisition option; do not also run the attribution
  page-view owner or each navigation would intentionally emit two billable events.

Use propose_browser_analytics before activation. Canonical browser and bounded UTM
properties plus the web_page_views and web_visitors metrics start proposed. The owner
reviews and activates them. Query with
query_web_analytics using the page-view count metric; responses keep visitors, sessions and
page views separate and return counts plus page-view percentages for requested dimensions.
`;
