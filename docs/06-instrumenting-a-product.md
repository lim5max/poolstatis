# Instrumenting a product with Poolstatis

Two ways to get metrics into Poolstatis:

- **A — Let a coding agent do it** (recommended): connect the MCP, point the agent
  at your product, it registers metrics and wires up tracking by the standard.
- **B — Do it by hand** over the HTTP API.

Both end in the same place: events flowing to the ingest API, metrics registered
with a `purpose`, and the admin panel showing green data-health.

---

## 0. Hosted prerequisites

Open the hosted admin, sign in, and run onboarding for your workspace. Onboarding
creates the first project and shows two one-time secrets:

- a `pt_` personal token for your MCP client;
- a `pk_` ingest key for your product runtime.

If you lose the `pt_`, issue a narrow project `sk_` from the Keys tab and use that
for your MCP client until personal-token rotation is exposed in account settings.

Key kinds (see [ARCHITECTURE.md](../ARCHITECTURE.md)):

| Token | Use |
|-------|-----|
| `pk_` ingest | write-only, ships in product code, encodes project + env |
| `sk_` secret | read + manage one project (server-side / CI / admin panel) |
| `pt_` personal | read + manage across the org (MCP for an agent) |

---

## A. Agent-driven (MCP)

### 1. Connect the MCP

Choose Claude Code, Claude Desktop, Codex, Cursor, Warp, Windsurf, VS Code/Copilot,
Cline, Zed, Continue, Replit, OpenCode, Hermes-style launchers, or custom MCP in
the **Setup & MCP** tab. The admin renders the same stdio command, args, and env
for the client you use; the paste location depends on the host.

```json
{
  "mcpServers": {
    "poolstatis": {
      "command": "pnpm",
      "args": ["--silent", "dlx", "@poolstatis/mcp@0.2.0"],
      "env": {
        "POOLSTATIS_URL": "https://api.poolstatis.com",
        "POOLSTATIS_TOKEN": "pt_…"
      }
    }
  }
}
```

`--silent` is required — otherwise pnpm prints a banner to stdout and corrupts the
stdio MCP protocol.

`@poolstatis/mcp@0.2.0` passed a fresh registry install, initialize, tool-list,
and project-scoped read smoke. Hosted deployments may enable this exact pin;
future versions remain fail-closed until they pass the same checks.

### 2. Run the instrumentation skill

In your **product's** repo (with the MCP connected), invoke the
[`poolstatis-instrument`](../.claude/skills/poolstatis-instrument/SKILL.md) skill, or
just ask: *"instrument this app with Poolstatis."* The agent will:

1. read `poolstatis://standard/instrumentation` and `get_project_schema`,
2. choose category definitions from the project schema, then pick a north-star
   metric + activation funnel for your product type,
3. `register_metric` each (as `proposed`) with a real `purpose`,
4. add tracking calls to your code,
5. verify with `sample_events`, and
6. hand back the list of metrics for you to activate.

### 3. Activate

Open the admin **Registry** tab → metrics arrive as `proposed` → click **activate**
on the ones you want counted. (Or `update_metric` with `{status:"active"}` via MCP.)
The **Categories** tab shows the grouped Product/Business/Technical system
library and project custom definitions. Edit metric taxonomy with a purpose
category and namespaced tags such as `surface:checkout`; represent journeys as
funnels, not feature-specific categories.
When a metric is replaced, use `deprecate_metric` with a real reason instead of
hard-deleting it; future agents need that context.

---

## B. By hand (HTTP)

### 1. Register a metric

```bash
SK=sk_…
curl -X POST "$POOLSTATIS_URL/api/v1/projects/my-app/metrics" \
  -H "Authorization: Bearer $SK" -H 'content-type: application/json' \
  -d '{
    "key": "signup",
    "name": "Signups",
    "purpose": "Counts completed signups to size top-of-funnel acquisition.",
    "category": "acquisition",
    "type": "count",
    "source": { "event": "signup.completed" }
  }'
# → { ... "status": "proposed" }

# activate it
curl -X PATCH "$POOLSTATIS_URL/api/v1/projects/my-app/metrics/signup" \
  -H "Authorization: Bearer $SK" -H 'content-type: application/json' \
  -d '{"status":"active"}'
```

### 2. Send events with the SDK (JS/TS — recommended)

Use [`@poolstatis/sdk`](../sdk/README.md) — it batches, retries, and flushes on page
unload so events aren't lost. Don't hand-roll a fetch client.

```bash
pnpm add @poolstatis/sdk
```

```ts
// tracking.ts — one shared client, ingest key only (safe in client/server code)
import { createClient } from "@poolstatis/sdk";

export const ph = createClient({
  url: process.env.POOLSTATIS_URL!,
  ingestKey: process.env.POOLSTATIS_INGEST_KEY!, // pk_…
});
```

```ts
// at the signup site — distinct_id is the STABLE user id
ph.track("signup.completed", user.id, { plan: "free" });
ph.identify("account", user.accountId, { plan: "free", seats: 1 }); // mutable state → entity
```

### 2.0 Browser landing attribution (optional)

Для consented browser-продукта сначала вызови MCP
`propose_acquisition_properties` (или `POST /properties/acquisition-attribution`)
с platform credential. Это создаст пять `$utm_*` definitions как `proposed`;
ингест-ключ в браузере не может и не должен менять реестр. Затем подключи
`@poolstatis/sdk/attribution`, как показано в [SDK guide](../sdk/README.md#browser-acquisition-attribution-optional-module).

Модуль пишет только pathname landing, origin referrer и стандартные UTM; raw URL,
full referrer, click ids и unknown query params не отправляются. Для SPA вызывай
`pageViewed()` после навигации. Передай обязательный `subscribeConsent` callback,
который синхронно вызывает listener при отзыве product-analytics consent: модуль сам
вызовет `stop()` и удалит unsent/retrying attribution events.
Связь anonymous→authenticated делается отдельно через audited actor link: история
immutable events не переписывается. UTM trend — только session landing association,
не доказательство причинного эффекта кампании.

### 2.1 Roll out and measure a product change

Create an active flag and an experiment in **Experiments** admin (or with the
matching MCP tools). The experiment needs a 100%-allocated flag and an active
`count`/`unique_actors` metric as outcome.

```ts
const variant = await ph.getFeatureFlag("checkout_copy", user.id, {
  sessionId: session.id,
});

if (variant?.key === "test") {
  showCheckoutCta(variant.payload?.label as string);
} else {
  showCheckoutCta("Checkout");
}
```

Do not add `variant` manually to your outcome events: Poolstatis records the
first `$feature_flag_called` exposure itself and only counts outcomes that occur
after it. Use the experiment result before concluding it; conclusion freezes the
measurement window and records the decision rationale.

### 2.2 Connect the change to a decision

For a repository-owned change, keep the hypothesis in `poolstatis.yml`: contract key,
decision owner, primary/guardrail metrics, target filters, baseline/observation windows and
minimum meaningful effect. The safe flow is:

1. run `validate_measurement_contracts` and `diff_measurement_contracts` in the product repo;
2. review the diff, then apply with its `expected_revision`;
3. after the real deploy, let CI call `register_release` with repository, commit SHA,
   deploy time and an idempotency key;
4. wait for the fixed window or call `evaluate_release`; inspect facts, trust and blockers;
5. approve, reject or edit the proposal with a human rationale;
6. prepare a follow-up action and approve its exact fingerprint separately if delivery is
   actually desired.

No onboarding checkbox, evaluation call or decision approval deploys code implicitly.
The full lifecycle is documented in
[09-product-decision-loop.md](09-product-decision-loop.md).

**Other languages / no SDK** — POST directly (the same shape the SDK sends). Batch up to 500
events and send a `batch_id` for idempotent retries:

```bash
# events
curl -X POST "$POOLSTATIS_URL/i/v1/events" \
  -H 'Authorization: Bearer pk_…' -H 'content-type: application/json' \
  -d '{"batch_id":"<uuid>","events":[{"event":"signup.completed","distinct_id":"u1","properties":{"plan":"free"}}]}'

# entities (mutable state — note entity_type/entity_id, not event shape)
curl -X POST "$POOLSTATIS_URL/i/v1/entities" \
  -H 'Authorization: Bearer pk_…' -H 'content-type: application/json' \
  -d '{"entities":[{"entity_type":"account","entity_id":"acc1","properties":{"plan":"free","seats":1}}]}'
```

### 3. Verify

```bash
# did it arrive? is it registered (matches an active metric)?
curl "$POOLSTATIS_URL/api/v1/projects/my-app/events/sample?limit=10" \
  -H "Authorization: Bearer $SK"
```

Or watch the admin **Data → Event stream** (filter to *unregistered*) and
**Data → Data health** for off-standard drift.

### 4. Query (this is what your own dashboards call)

Poolstatis is headless: you build dashboards on your side and pull via the Query API
(or the `query_*` MCP tools). The DSL accepts registry metric **keys**, never raw SQL.

```bash
curl -X POST "$POOLSTATIS_URL/api/v1/projects/my-app/query" \
  -H "Authorization: Bearer $SK" -H 'content-type: application/json' \
  -d '{"kind":"trend","metric":"signup","date_from":"-30d","interval":"day"}'
```

Query kinds: `trend`, `funnel`, `entities`, `retention`, `lifecycle`, `stickiness`
(see [04-http-api.md](04-http-api.md)).

---

## See also

- [The instrumentation standard](../src/mcp/standard.ts) — the normative rules (also
  served at `poolstatis://standard/instrumentation` and `GET /api/v1/standard`).
- [03-mcp-server.md](03-mcp-server.md) — every MCP tool.
- [04-http-api.md](04-http-api.md) — ingest + query API reference.
- [05-gap-analysis.md](05-gap-analysis.md) — what's built vs PostHog, and what's next.
Для web analytics сначала прочитайте также
`poolstatis://standard/browser-analytics`, затем вызовите
`propose_browser_analytics`. Browser capture подключается только через отдельный
`@poolstatis/sdk/browser` entrypoint и только после consent; base SDK не меняет
поведение.
