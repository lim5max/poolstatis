# Instrumenting a product with Poolstatis

> Optional Web analytics requires the SDK browser helper and a finite safe
> route mapper. Never send a raw pathname that may contain customer,
> invitation, document or token identifiers. Custom product events use the
> neutral base SDK path; `$browser_context` is reserved for canonical
> `page.viewed`/`page.engagement`. Run atomic browser registry setup with the
> complete finite route vocabulary first, then explicitly review/trust the
> enum `$route_key` and activate `web_page_views`.
> See [Browser analytics](13-browser-analytics.md).

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
      "args": ["--silent", "dlx", "@poolstatis/mcp@0.4.0"],
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

`@poolstatis/mcp@0.4.0` is the historical data and audited correction release
candidate. Hosted deployments keep this pin fail-closed until its exact registry
artifact passes fresh install, initialize, 99-tool list, and project-scoped read.

Verify the connection from the MCP client itself: ask it to call
`get_onboarding_status` with the target `project` and explicit `env`, then
refresh **Setup & MCP**.
The server records that MCP-marked request and its time. Copying config is not
connection proof, and the recorded request is last-use evidence rather than a
heartbeat or transport attestation.

### 2. Install the agent skills

MCP supplies live tools and project data. Skills supply the standards and
documentation workflow for using them. Install all three in the **product repo**:

```bash
# Portable: every agent supported by the skills CLI
pnpm dlx skills add https://github.com/lim5max/poolstatis \
  --skill poolstatis-instrument poolstatis-analyze poolstatis-maintain \
  --agent '*' -y

# Or target one runtime
pnpm dlx skills add https://github.com/lim5max/poolstatis \
  --skill poolstatis-instrument poolstatis-analyze poolstatis-maintain \
  --agent codex -y
pnpm dlx skills add https://github.com/lim5max/poolstatis \
  --skill poolstatis-instrument poolstatis-analyze poolstatis-maintain \
  --agent claude-code -y
```

For an approved local Core checkout, replace the GitHub URL with its absolute
path. Verify project-scope installation:

```bash
pnpm dlx skills list --json
```

The list must include `poolstatis-instrument`, `poolstatis-analyze`, and
`poolstatis-maintain`. The canonical copies are under `.agents/skills`; the
`.claude/skills` copies are kept byte-identical for direct Claude discovery.

### 3. Run the instrumentation skill

With MCP connected, invoke `poolstatis-instrument` or ask:
*"instrument this app with Poolstatis."* The skill routes the agent to:

1. read `poolstatis://standard/instrumentation` and `get_project_schema`,
2. choose category definitions from the project schema, then pick a north-star
   metric + activation funnel for your product type,
3. `register_metric` each (as `proposed`) with a real `purpose`,
4. add tracking calls to your code,
5. verify with `sample_events`, and
6. hand back the list of metrics for you to activate.

The public references are the [quickstart](https://poolstatis.xyz/docs/quickstart),
[instrumentation standard](https://poolstatis.xyz/docs/standard), and
[MCP tool reference](https://poolstatis.xyz/docs/mcp-tools).

### 4. Activate

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

### 2. Send events

The public ingest API is the available install-free path. The source tree also
contains an [`sdk/`](../sdk/README.md) package for workspace/local integration,
but `@poolstatis/sdk` is not currently published in npm. Do not run or recommend
`npm add @poolstatis/sdk` until `npm view @poolstatis/sdk version` succeeds.

Use the HTTP examples below from one shared product integration module. Keep only
the write-only `pk_` ingest key in product runtime code; never ship `sk_` or `pt_`.
If the target already consumes an explicitly approved local/git SDK source,
follow that installed version's guide instead.

### 2.0 Browser landing attribution (optional)

Для consented browser-продукта сначала вызови MCP
`propose_acquisition_properties` (или `POST /properties/acquisition-attribution`)
с platform credential. Это создаст пять `$utm_*` definitions как `proposed`;
ингест-ключ в браузере не может и не должен менять реестр. Затем подключи
локальный/одобренный `@poolstatis/sdk/attribution`, как показано в
[SDK guide](../sdk/README.md#browser-acquisition-attribution-optional-module).
Не обещайте npm-установку, пока registry lookup пакета не проходит.

Модуль пишет только обязательный finite `landing_route`, origin referrer и
стандартные UTM; raw path/URL, full referrer, click ids и unknown query params
не отправляются. Для SPA вызывай
`pageViewed()` после навигации. Передай обязательный `subscribeConsent` callback,
который синхронно вызывает listener при отзыве product-analytics consent: модуль сам
вызовет `stop()` и удалит unsent/retrying attribution events.
До attribution-only capture запусти browser analytics setup с конечным
`route_keys` vocabulary и переведи `$route_key` в `trusted`: `landing_route`
валидируется по тому же словарю даже без полного browser-модуля.
Связь anonymous→authenticated делается отдельно через audited actor link: история
immutable events не переписывается. UTM trend — только session landing association,
не доказательство причинного эффекта кампании.

### 2.1 Roll out and measure a product change

Create an active flag and an experiment in **Experiments** admin (or with the
matching MCP tools). The experiment needs a 100%-allocated flag and an active
`count`/`unique_actors` metric as outcome.

```ts
// Resolve @poolstatis/sdk from the approved local/git dependency described above.
import { createClient } from "@poolstatis/sdk";

const ph = createClient({
  url: "https://api.poolstatis.com",
  ingestKey: "pk_…",
});

const variant = await ph.getFeatureFlag("checkout_copy", user.id, {
  sessionId: session.id,
});

if (variant?.key === "test") {
  showCheckoutCta(variant.payload?.label as string);
} else {
  showCheckoutCta("Checkout");
}
```

Здесь единица эксперимента - authenticated user. Для анонимного теста только
на browser surface можно передать persistent first-party `visitorId` из
browser-модуля, если outcome остаётся на том же visitor. Не называйте такую
единицу пользователем и не используйте session/page-view/random id. Для
атрибуции signup или payment сначала создайте audited actor link к durable user.

### 2.1a 1C-Bitrix browser integration

Poolstatis does not need a Bitrix plugin. Build one browser asset in the
product repository, then include the compiled file from the Bitrix site
template. The source asset imports the same package as any other site:

```ts
import { createClient } from '@poolstatis/sdk';
import { createBrowserAnalytics } from '@poolstatis/sdk/browser';

const hostWindow = window as Window & {
  productConsent?: { analytics: boolean };
};

const client = createClient({
  url: 'https://api.example.com',
  ingestKey: 'pk_…', // write-only project key; never place sk_ or pt_ here
});

const analytics = createBrowserAnalytics({
  client,
  consentPolicy: 'external',
  hasConsent: () => hostWindow.productConsent?.analytics === true,
  subscribeConsent: (listener) => {
    const handler = () => listener();
    window.addEventListener('product-consent', handler);
    return () => window.removeEventListener('product-consent', handler);
  },
  captureAcquisition: true,
});
analytics.start();
```

Do not paste this TypeScript or a bare npm import directly into a production
template. Bundle it first with the product's normal JS build. In a D7 template,
Bitrix documents loading that built asset with:

```php
<?php
use Bitrix\Main\Page\Asset;
Asset::getInstance()->addJs(SITE_TEMPLATE_PATH . '/js/poolstatis-browser.js');
```

Official reference:
https://dev.1c-bitrix.ru/api_d7/bitrix/main/page/asset/addjs.php

Server-side Bitrix/PHP code can send trusted backend events through the same
HTTP ingest API, keeping `sk_`/`pt_` out of browser output. MCP is separate:
install the version-pinned Poolstatis MCP runner in Codex, Claude, Cursor or
another developer agent. The agent registers semantics and queries evidence;
MCP does not run inside the visitor's Bitrix request.

This is the integration contract, not a claim that the npm release is already
available. Run `npm view @poolstatis/sdk version` and the package consumer smoke
before recommending npm installation. Until that passes, use only an explicitly
reviewed local/git package source.

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
локальный/одобренный `@poolstatis/sdk/browser` entrypoint и только после consent;
base SDK не меняет поведение. Публичную npm-доступность перед инструкцией по
установке нужно проверять отдельно.
