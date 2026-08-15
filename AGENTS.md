# Poolstatis — guide for Codex

**Agent-native product analytics** — a lightweight PostHog analog whose primary user is a
coding agent (via MCP), not a human in a UI. The differentiator: every metric is registered
with a mandatory `purpose` and every funnel with a `goal`, so semantics are first-class and
insights are computable. The human UI is a **review and answer-first analysis workspace**:
it ships Web, Product, Funnels, Saved, People, and Browser Experience screens with graphs,
tables, session evidence, and admin controls. It is NOT a blank-canvas/general dashboard
builder; the primary decision loop remains the agent-facing MCP/SDK/API contract.

## Layout

- `src/` — backend (TypeScript, Fastify, Postgres). Ingest API (`/i/v1/*`) + Platform API (`/api/v1/*`) + MCP server.
- `web/` — human review, analysis, and admin SPA (Vite + **React 19** + **shadcn/ui** + Tailwind v4).
- `sdk/` — `@poolstatis/sdk`, the browser+node client products embed.
- `docs/` — `01-data-model` … `06-instrumenting-a-product`, `05-gap-analysis` (roadmap).
- `migrations/` — plain `.sql`, applied in order by `src/db.ts` on `serve`/`migrate`.
- `.Codex/skills/poolstatis-{instrument,maintain,analyze}/` — agent skills.

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
  includes trend / funnel / entities / retention / lifecycle / stickiness; additional bounded
  branches cover Web/session engagement and Browser Experience evidence. Branches reference
  **registry metric keys** where the analysis contract requires a metric and never expose raw
  SQL. Add a new query type = new schema branch + `QueryService` case + `EventStore` method +
  MCP tool + test.
- **Keys:** `pk_` ingest (write-only, safe in client code, encodes project+env), `sk_` secret
  (one project, read+manage), `pt_` personal (org-wide, for MCP). Auth in `src/http/auth.ts`.
- **Ingest:** unregistered events are accepted but flagged (`registered=false`), not dropped;
  per-element 207 errors and unregistered/clock-skew warnings are logged to `ingest_warnings`.
- **Public ingest compatibility:** `/i/v1/*` and the published SDK are one customer contract.
  Never deploy stricter validation that makes the currently published SDK or any known live
  consumer start returning `207`. Maintain a versioned consumer inventory; a breaking privacy or
  schema change is blocked until the replacement SDK is published and registry-verified, every
  known production consumer (including `poolstatis.xyz`) is migrated and live-verified, and the
  previous published SDK contract fixture still passes CI. If that sequence is impossible, use a
  new API version or a bounded server compatibility path instead of dropping customer events.

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
- **Release order for contract migrations:** compatible Core first, verified SDK publication
  second, consumer migrations third, strict legacy rejection only in a new API version or after
  an explicitly measured deprecation window. A version written in `package.json` is not published
  until `npm view` confirms that exact version; a site change is not deployed until fresh live
  events are accepted with HTTP 200 and `ingest_warnings` shows no new rejection watermark.

## Continuous integration and completion

- A pushed feature branch is not a completed delivery. Before declaring work
  complete, fetch `origin`, re-read the current `origin/main`, and assemble all
  approved workstreams into one named integration candidate based on that exact
  revision.
- Do not merge every old branch blindly. Inventory remote branches and open PRs,
  identify patch-equivalent or superseded work, and preserve every unique
  approved change. Resolve shared-file conflicts semantically so both contracts
  survive; never finish a conflict by choosing a whole side without review.
- Run the complete gates from the integrated tree: `pnpm typecheck`,
  `pnpm test`, `pnpm --dir web test`, `pnpm --dir web build`,
  `pnpm --dir sdk test`, SDK/MCP build and pack checks, and self-host
  Compose config/build when those surfaces changed. Use an isolated disposable
  PostgreSQL instance for database tests, never a live or shared customer
  database. Revoke synthetic keys and remove the disposable database afterward.
- UI changes additionally require desktop and mobile browser checks for
  overflow, console errors, typography, interaction states, and rendered charts
  or media. Keep STIX Two Text, Geist, and Geist Mono in their documented roles.
- After the gates are green, obtain an independent review, prove
  `git merge-tree` against the freshly fetched `origin/main`, push the
  integration candidate, and merge it through a PR unless the user explicitly
  requires another reviewed merge mechanism.
- Completion requires read-back evidence: `origin/main` contains the integrated
  commit, the local `main` is fast-forwarded and clean, required checks are
  green, and no approved branch retains unique commits. Close or clearly label
  superseded PRs and branches; do not silently leave finished work only on a
  feature branch.
- Merge and production release are separate gates. Before deployment, verify
  live lineage and immutable artifacts, create and restore-test the required
  backup, compare protected data counts, retain a tested rollback, switch
  atomically, and run repeated live probes. Never run destructive migration or
  restore commands against the production `poolsatis` database during tests.

## Release execution guardrails

- Before the first mutating command in each repository, record `pwd`,
  `git rev-parse --show-toplevel`, `git status --short --branch`, the exact HEAD,
  and `git worktree list --porcelain`. Agent work must use its assigned isolated
  worktree. Shared checkouts under `/Users/maksimstil/Desktop` are read-only
  unless the user explicitly names that checkout as the mutation target.
- Start every multi-repository release with one ledger that freezes the exact
  Core, Cloud and site SHAs, package versions, current production lineage,
  rollback target, and ordered phases. Treat implementation, package
  publication, production mutation and public-truth updates as explicit states;
  never use evidence from a later state before it exists. Use
  `docs/releases/RELEASE_LEDGER_TEMPLATE.md` rather than an ad-hoc checklist.
- When the user expands a release from source to packages, production or site,
  update the ledger and report `completed / current / remaining` immediately.
  Do not describe the release as nearly done while an authorized terminal phase
  is still unstarted, and do not make the user infer progress from raw command
  failures.
- Discover production topology before writing commands: list the actual release
  paths and Compose files, render the active Compose config, and inspect
  `information_schema` before querying a table or column. Do not guess host
  paths, service names or schema identifiers from an older release.
- Build deployable assets only from the final merged SHA in a clean worktree.
  Pass the release SHA explicitly to the build, prove it is embedded in the
  output, and reject an existing or stale `dist` directory. Package publication
  must use a non-hidden artifact directory and an absolute tarball path.
- Treat source merge, registry publication, production deployment and public
  documentation as separate truth states. Copy that claims a feature is live is
  changed only after production read-back; consolidate those truth changes into
  one post-deploy PR when possible.
- Run desktop and mobile browser checks before the first site deployment and
  repeat them against live production. A long hash, URL, table or code block is
  an explicit mobile-overflow test case.
- A newly opened PR with “no checks reported” is pending registration for a
  bounded polling window, not immediately failed. A failed command must be
  recorded once with command, exit code and stderr, then classified as
  read-only probe, fail-closed gate or production mutation. Never blindly
  repeat a deterministic or mutating failure. A read-only eventual-consistency
  probe may use the same command only with a recorded backoff, attempt limit and
  stop condition.
- Keep a cleanup manifest for disposable databases, containers, directories and
  worktrees. Stop resources before removing them, use exact targets, and never
  replace manifest cleanup with a broad `rm`, `docker prune`, reset or clean.
- After any release spanning packages plus production or more than one repo,
  write a short postmortem and turn every preventable failure into either an
  automated check or an enforceable rule. The 2026-08-15 replay release example
  is in `docs/releases/2026-08-16-session-replay-release-postmortem.md`.

## What's next

See `docs/05-gap-analysis.md`. Current priorities are design-partner validation,
static cohorts, semantic rollups, experiment-health guidance, shared Cloud quota
coordination, per-release MCP runner proof, and decision-loop operational health.
