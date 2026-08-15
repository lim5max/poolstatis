# Poolstatis — guide for Claude

**Agent-native product analytics** — a lightweight PostHog analog whose primary user is a
coding agent (via MCP). The differentiator: every metric is registered with a mandatory
`purpose` and every funnel with a `goal`, so semantics are first-class and insights are
computable. The human UI is a **review and answer-first analysis workspace**: it ships Web,
Product, Funnels, Saved, People, and Browser Experience screens with graphs, tables, session
evidence, and admin controls. It is not a blank-canvas/general dashboard builder.

## Layout

- `src/` — backend (TypeScript, Fastify, Postgres). Ingest API (`/i/v1/*`) + Platform API (`/api/v1/*`) + MCP server.
- `web/` — human review, analysis, and admin SPA (Vite + **React 19** + **shadcn/ui** + Tailwind v4).
- `sdk/` — `@poolstatis/sdk`, the browser+node client products embed.
- `docs/` — `01-data-model` … `06-instrumenting-a-product`, `05-gap-analysis` (roadmap).
- `migrations/` — plain `.sql`, applied in order by `src/db.ts` on `serve`/`migrate`.
- `.claude/skills/poolstatis-{instrument,maintain,analyze}/` — agent skills.

## Repository boundaries

- This repo (`/Users/maksimstil/Desktop/poolstatis`) is the source-available system repo:
  backend, ingest, MCP, SDK, admin SPA, migrations, technical docs, and Docker self-host.
- The marketing site, public docs UI, `/login`, `/signup`, Vercel waitlist function, and
  Resend waitlist config live in `/Users/maksimstil/Desktop/poolstatis-site`.
- Future Cloud-only code (hosted auth, billing, managed infra, Cloud ops) belongs in a
  separate private repo, not in this source-available system repo.
- Do not reintroduce `site/` here. If copy/docs changes affect the landing or public docs UI,
  switch to `/Users/maksimstil/Desktop/poolstatis-site`.

## Commands

```bash
docker compose up -d            # Postgres on :5444 (DB name is "poolsatis" — see gotchas)
pnpm bootstrap "Org" slug Name  # create org/project/keys (prints tokens once)
pnpm seed acme                  # demo project with ~12 weeks of data
pnpm serve                      # Platform + Ingest on :3300
pnpm mcp                        # stdio MCP server (env POOLSTATIS_URL, POOLSTATIS_TOKEN)
pnpm typecheck && pnpm test     # tsc + vitest (tests REQUIRE Docker Postgres running)
pnpm --dir web dev              # admin on :5273 (vite proxies /api,/i,/health → :3300)
pnpm --dir web build            # tsc -b && vite build
pnpm --dir sdk test             # SDK unit tests (mocked fetch, no DB)
docker compose -f docker-compose.selfhost.yml up -d --build  # self-host stack
```

## Architecture (keep these invariants)

- **4 primitives:** Event (immutable fact), Entity (mutable state: user/account/…), Metric
  (registry declaration with `purpose`), Funnel/Insight (semantics on top).
- **Storage seam:** all event reads/writes go through the `EventStore` interface
  (`src/stores/eventStore.ts`). `PostgresEventStore` is the only impl; every method must be
  implementable on ClickHouse too — that's why the Query DSL stays narrow. No raw SQL is
  exposed to clients.
- **Query DSL** (`POST /query`, discriminated union on `kind`): registered metric analysis
  includes trend / funnel / entities / retention / lifecycle / stickiness; bounded branches
  cover Web/session engagement and Browser Experience evidence. Branches reference registry
  metric keys where required and never expose raw SQL. Add a query type = schema branch +
  `QueryService` case + `EventStore` method + MCP tool + test.
- **Keys:** `pk_` ingest (write-only, safe in client code, encodes project+env), `sk_` secret
  (one project, read+manage), `pt_` personal (org-wide, for MCP). Auth in `src/http/auth.ts`.
- **Ingest:** unregistered events are accepted but flagged (`registered=false`), not dropped;
  per-element 207 errors and unregistered/clock-skew warnings are logged to `ingest_warnings`.

## Conventions & gotchas (learned the hard way)

- **DB name stays `poolsatis`** in `src/config.ts`, `docker-compose.yml`, `test/urls.ts` — the
  product brand is "Poolstatis" but the physical Postgres DB/creds were intentionally NOT
  renamed (renaming destroys live data + tokens). Don't "fix" it.
- **Web is React 19 on purpose.** shadcn@latest generates React-19-style components (plain
  functions, refs-as-props). On React 18 every `DropdownMenu`/`Tooltip` (asChild + Button)
  silently fails to open. Don't downgrade React.
- **Tooltips** need one `<TooltipProvider>` at the root (`web/src/main.tsx`); use the `Hint`
  wrapper from `ui.tsx`. terse badges (reg/wild, category, status) carry tooltips.
- **Typography:** STIX Two Text for headings ONLY (`.serif`); Geist for body; Geist Mono
  (`font-mono`) for ids/event-names/source/data. No ALL-CAPS eyebrow labels — sentence case.
- **No magic Tailwind values** — use scale tokens (`text-xs`, `max-w-sm`, `size-6`, `h-9`),
  not `text-[10px]`/`max-w-[360px]`. Metric-category colors are CSS vars `--cat-*` in
  `index.css`, not inline hex.
- **shadcn `Card` defaults to `py-6 gap-6`** — use the `Panel` helper (which sets `gap-0 py-0`)
  or add those classes, or you get a big empty gap. Wrap wide tables in `overflow-x-auto` (the
  Card's `overflow-hidden` otherwise clips row-action menus and makes them unclickable).
- **Shared UI helpers live in `web/src/components/ui.tsx`** (Panel, Stat, Toolbar, Confirm,
  DangerConfirm, RegBadge, Hint, fmt*). Don't re-implement them per screen.
- **Every metric needs a real `purpose`** (CHECK length ≥ 10) and funnels a `goal` — this is
  the whole product, not boilerplate. Agent-registered metrics are `proposed` until activated.
- **Ship a feature whole:** REST route + MCP tool + admin UI + vitest in the same change.
  Run `pnpm typecheck`, `pnpm test`, `pnpm --dir web build` before declaring done.

## What's next

See `docs/05-gap-analysis.md`. Current priorities are design-partner validation,
static cohorts, semantic rollups, experiment-health guidance, shared Cloud quota
coordination, per-release MCP runner proof, and decision-loop operational health.
