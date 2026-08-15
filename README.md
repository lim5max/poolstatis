# Poolstatis

**Agent-native product analytics.** Poolstatis is a lightweight PostHog-style
analytics system whose primary user is a coding agent over MCP. Humans still
get answer-first analysis screens, graphs, tables, session evidence, and review
controls; Poolstatis does not provide a general dashboard builder.

The core idea is that metrics are created with semantics from the start. Every
metric has a required `purpose`, and every funnel has a `goal`, so
instrumentation can be inspected, maintained, and queried by agents instead of
living as unnamed event clutter.

## Source Available

Poolstatis is source-available under the
[PolyForm Shield License 1.0.0](LICENSE). You can read, run, and modify the
software for permitted use cases, but you cannot sell Poolstatis as a competing
product or offer it as a competing hosted or managed service.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the
[source-available release checklist](docs/09-source-available-release.md) for
project rules and release hygiene.

This repository contains the system itself: backend, ingest API, MCP server,
SDK, human analysis/admin SPA, migrations, technical docs, and Docker self-hosting.
The marketing site, public docs UI, waitlist, and future Cloud-only code live in
separate repositories.

## How It Works

1. A coding agent instruments a product and registers metrics in Poolstatis
   through MCP.
2. The product sends events and entities to the HTTP ingest API.
3. A versioned `poolstatis.yml` connects a product hypothesis to registered metrics.
4. CI registers the deployed commit; Poolstatis monitors the fixed evidence window and
   proposes `keep`, `fix`, `rollback`, or `inconclusive` from trusted facts.
5. A human approves or corrects the decision before any prepared action can execute.

## Documentation

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System overview, components, and principles |
| [docs/01-data-model.md](docs/01-data-model.md) | Tenancy, data types, and table schemas |
| [docs/02-storage.md](docs/02-storage.md) | Storage design and the Postgres-to-ClickHouse path |
| [docs/03-mcp-server.md](docs/03-mcp-server.md) | MCP server tools and resources |
| [docs/04-http-api.md](docs/04-http-api.md) | Ingest and Query API |
| [docs/05-gap-analysis.md](docs/05-gap-analysis.md) | Current scope versus PostHog and next priorities |
| [docs/06-instrumenting-a-product.md](docs/06-instrumenting-a-product.md) | Agent and manual instrumentation workflow |
| [docs/07-vps-deployment.md](docs/07-vps-deployment.md) | Deploying the Platform API, MCP, SDK, and skills |
| [docs/09-source-available-release.md](docs/09-source-available-release.md) | Source-available release and GitHub hygiene |
| [docs/09-product-decision-loop.md](docs/09-product-decision-loop.md) | Contracts, releases, evidence, approvals, workers, actions, outbox, and decision memory |
| [docs/10-self-host.md](docs/10-self-host.md) | Short Docker Compose self-hosting path |
| [docs/11-repository-split.md](docs/11-repository-split.md) | System, site, and Cloud repository boundaries |
| [docs/12-mcp-package-release.md](docs/12-mcp-package-release.md) | Public MCP package release and provenance gates |
| [docs/14-session-replay.md](docs/14-session-replay.md) | Consent-gated rrweb recording, storage, privacy and sandboxed playback |
| [sdk/README.md](sdk/README.md) | `@poolstatis/sdk` client usage |
| [.claude/skills/poolstatis-instrument](.claude/skills/poolstatis-instrument/SKILL.md) | Agent skill for product instrumentation |

## Local Development

```bash
docker compose up -d
pnpm install
pnpm build
pnpm migrate
pnpm bootstrap "Poolstatis" poolstatis "Local project"
pnpm serve
pnpm --dir web dev
```

Run backend and shared-logic checks before opening a PR:

```bash
pnpm typecheck && pnpm test
```

Run the admin build before shipping UI changes:

```bash
pnpm --dir web build
```

## Self-Host In 3 Commands

```bash
docker compose -f docker-compose.selfhost.yml up -d --build
curl http://localhost:3300/health
docker compose -f docker-compose.selfhost.yml run --rm poolstatis \
  node dist/cli/bootstrap.js "Acme" acme "Acme Product"
```

Then open `http://localhost:8080` and paste the printed `sk_` or `pt_` token.
See the full self-hosting guide in [docs/10-self-host.md](docs/10-self-host.md).

## Hosted Setup

1. Open the hosted admin and create the first project in onboarding.
2. Save the one-time `pt_` token for the MCP client and `pk_` token for ingest.
3. Choose an analytics job and optional product outcome; onboarding generates
   one project/environment-scoped agent request without embedding either token.
4. Add Poolstatis as an MCP server in Claude Code, Claude Desktop, Codex,
   Cursor, Warp, Windsurf, VS Code/Copilot, Cline, Zed, Continue, Replit,
   OpenCode, Hermes-style launchers, or any compatible custom MCP host.

The JSON below is the verified Claude MCP shape. **Setup & MCP** renders Codex
as `config.toml`; for other hosts it shows generic stdio command, args, and env
fields instead of pretending every client accepts Claude JSON.

```json
{
  "mcpServers": {
    "poolstatis": {
      "command": "pnpm",
      "args": ["--silent", "dlx", "@poolstatis/mcp@0.6.0"],
      "env": {
        "POOLSTATIS_URL": "https://api.poolstatis.xyz",
        "POOLSTATIS_TOKEN": "pt_..."
      }
    }
  }
}
```

`--silent` is required because `pnpm` can print a banner to stdout, which breaks
the stdio MCP protocol.

The public runner is version-pinned so a hosted deploy cannot silently change
its MCP runtime. `@poolstatis/mcp@0.6.0` includes the production browser
analytics standard: immediate collection, finite route keys, server-derived
country, bounded legacy SDK compatibility, and the existing historical-data
and audited-correction tools. Each release remains fail-closed until its exact
registry artifact passes fresh install, initialize, tool-list, and scoped-read
smoke checks.

Verify MCP from the configured client by calling `get_onboarding_status` with
the target project and environment, then refresh **Setup & MCP**. A copied
config is not server evidence.

Install the three Poolstatis workflow skills in the product repo. MCP supplies
live tools and project data; skills tell Codex, Claude, and other compatible
agents to read the standard, project schema, and current documentation before
they instrument, analyze, or maintain measurement:

```bash
pnpm dlx skills@1.5.22 add https://github.com/lim5max/poolstatis/archive/45af081344dc910933a0d274892e53cf417fa5fb.tar.gz \
  --skill poolstatis-instrument poolstatis-analyze poolstatis-maintain \
  --agent '*' -y
pnpm dlx skills@1.5.22 list --json
```

Use `--agent codex` or `--agent claude-code` instead of `'*'` to target one
runtime. An absolute local Core checkout path can replace the GitHub URL.
The archive URL and CLI version pin the reviewed workflow release. Verify the
installed names and resolved source before using a different release.
See the public [quickstart](https://poolstatis.xyz/docs/quickstart),
[instrumentation standard](https://poolstatis.xyz/docs/standard), and
[MCP reference](https://poolstatis.xyz/docs/mcp-tools).

Send product events through the ingest API:

```bash
curl -X POST https://api.poolstatis.xyz/i/v1/events \
  -H 'Authorization: Bearer pk_...' \
  -H 'content-type: application/json' \
  -d '{"events":[{"event":"signup.completed","distinct_id":"u1"}]}'
```

## Human Analysis And Admin

`web/` is a review, answer-first analysis, and platform-admin workspace. It ships
Web analytics, Product, Funnels, Saved answers, People, and Browser Experience
screens with real graphs, tables, interaction maps, and session evidence. It is
not a blank-canvas dashboard builder with arbitrary tiles, layouts, and sharing;
the primary programmable decision surface remains MCP, SDK, and REST.

The workspace also includes projects, metric registry management, data health,
events, entities, measurement trust, release changes, decision inbox/review/action history,
API keys, onboarding, historical imports and corrections, webhook delivery, and Setup & MCP
presets. In hosted mode, human login is handled through Auth0/OIDC, while scoped Poolstatis
keys remain the runtime access model:

- `pk_` ingest keys are write-only and safe for product clients.
- `sk_` secret keys provide project-level platform access.
- `pt_` personal tokens provide organization-wide MCP access.

## Status

Implemented:

- HTTP ingest API
- Semantic metric registry
- Funnels
- Entities
- Query DSL for `trend`, `funnel`, `entities`, `retention`, `lifecycle`, and
  `stickiness`
- Browser and Web session analytics for visitors, sessions, page views, foreground
  engagement, bounce, routes, bounded acquisition dimensions, and session/page detail
- Developer-labelled click autocapture with normalized coordinates, scroll milestones,
  registered section exposures, and coarse client error types
- Bounded click/scroll interaction maps, screenshot overlays, and a per-session interaction
  timeline; these are not DOM, video, or cursor replay
- Separate consent- and exact-host-gated rrweb Session Replay with masked DOM/CSS,
  mutations, navigation/viewport, click, scroll and cursor playback; payloads use a
  retention-bound object-store seam and are never analytics events
- Answer-first Web, Product, Funnel, Retention, Lifecycle, Stickiness, Entity, Saved, People,
  and Browser Experience graphs/tables; no general dashboard builder
- Previewed idempotent historical imports and audited optimistic event revisions
- Deterministic feature flags, automatic exposure events, and Bayesian A/B
  experiment results over registered metrics
- Repository-owned measurement contracts, immutable release provenance, evidence snapshots,
  human decision revisions, bounded release monitoring, correlation hypotheses,
  approval-gated actions, encrypted webhook outbox, and project-scoped decision memory
- MCP server with typed tools and resources
- Human analysis and admin SPA
- Instrumentation standard
- Agent instrumentation skill
- Docker Compose self-hosting path

Next priorities are tracked in [docs/05-gap-analysis.md](docs/05-gap-analysis.md).

Current deliberate limits: Session Replay is explicit opt-in rather than broad
arbitrary-DOM autocapture; it does not capture screen video, gaze, audio,
canvas pixels, console/network payloads or cross-origin iframe contents. There
is also no full issue-oriented error tracking, caller-provided raw SQL or
general dashboard builder. See [docs/05-gap-analysis.md](docs/05-gap-analysis.md)
for the exact boundary and rationale.
