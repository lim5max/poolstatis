# Repository split

Poolstatis is split by responsibility so the public system repo stays clean and
self-hostable, while marketing and hosted Cloud work can move independently.

## Repositories

| Repo | Path | Visibility | Owns |
|------|------|------------|------|
| `poolstatis` | `/Users/maksimstil/Desktop/poolstatis` | public/source-available | Platform API, Ingest API, MCP server, SDK, migrations, admin SPA, technical docs, Docker self-host |
| `poolstatis-site` | `/Users/maksimstil/Desktop/poolstatis-site` | private by default | Landing, public docs UI, `/login`, `/signup`, Vercel config, waitlist function, Resend waitlist env |
| `poolstatis-cloud` | future repo | private | Hosted auth, billing, managed infra, Cloud ops, Cloud-only product code |

## Rules

- Do not add marketing landing code, waitlist handlers, or Vercel site config back
  into the system repo.
- Do not put hosted billing/auth/Cloud ops code into the source-available system repo.
- Keep product-facing public docs in `poolstatis-site`.
- Keep technical protocol/runtime/self-host docs in this repo under `docs/`.
- Keep `.env` and Resend keys local to `poolstatis-site`; never commit them.
- If a change crosses repo boundaries, make separate commits in each repo and verify each
  repo with its own commands.

## Commands

System repo:

```bash
pnpm typecheck
pnpm test
pnpm --dir web build
docker compose -f docker-compose.selfhost.yml config
```

Site repo:

```bash
cd /Users/maksimstil/Desktop/poolstatis-site
pnpm build
```
