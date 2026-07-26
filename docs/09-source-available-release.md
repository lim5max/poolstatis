# Source-available release

This is the operating checklist for making Poolstatis public without blurring the
line between the source-available system, the marketing site, and future hosted Cloud.

## Positioning

Poolstatis is source-available agent-native analytics. The repo contains the core:
Ingest API, Platform API, Postgres store, semantic registry, Query DSL, MCP server,
SDK, admin SPA, technical docs, migrations, Docker self-host files, and agent skills.

Poolstatis Cloud is the managed service around that core: hosted admin auth,
one-time onboarding tokens, managed ingest, retention, backups, upgrades, and
uptime. Cloud should not be described as required for the product to work.

The public landing/docs/waitlist surface is intentionally outside this repo in
`/Users/maksimstil/Desktop/poolstatis-site`. Cloud-only product code should live
in a future private repo.

## License

Default release license: PolyForm Shield License 1.0.0.

Why this default fits Poolstatis now:

- keeps the code inspectable and self-hostable,
- allows modification and contribution for permitted purposes,
- blocks competing products and hosted/managed services built from Poolstatis,
- avoids accidentally granting broad resale rights before Cloud exists.

This is not an OSI open-source license. Do not describe the repo as open source
in public copy while this license is active. Use "source-available" or "self-hostable
core" instead.

Before a serious public launch, have counsel review the license text and the
product-specific claim that competing hosted/managed services are not permitted.

## GitHub hygiene before making the repo public

- Keep `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` at repo root.
- Replace generic GitHub links in the technical docs with the real repo URL.
- Enable issues and discussions only if someone will triage them.
- Enable private vulnerability reporting if available in the repo settings.
- Add branch protection for the default branch.
- Require CI for `pnpm typecheck`, `pnpm test`, `pnpm --dir web build`,
  `pnpm --dir sdk test`, and Docker compose config once CI exists.
- Do not publish real `pk_`, `sk_`, `pt_`, database URLs, Auth0 secrets, or webhook URLs.

## Contribution rules

Small, complete PRs are preferred. A feature is not complete if it changes only
one surface while the product contract requires more.

For shared behavior, ship the route, MCP tool, admin UI, docs, and test together
when applicable. For query changes, keep the DSL narrow and make sure the
implementation can still map to a future ClickHouse store.

Run the lightest meaningful verification before opening a PR:

```bash
pnpm typecheck
pnpm test
pnpm --dir web build
pnpm --dir sdk test
docker compose -f docker-compose.selfhost.yml config
```

Database-backed tests require Docker Postgres on `localhost:5444`.

## Separate site repo

The Vercel landing/docs/waitlist surface lives in
`/Users/maksimstil/Desktop/poolstatis-site`. Treat it as a separate private repo
by default. Its own README covers Vercel env and waitlist settings.

Do not copy `api/waitlist.ts`, Resend env, marketing pages, or public docs UI back
into this system repo.

## Release checklist

1. Make the repo public only after secrets and local-only artifacts are checked.
2. Confirm GitHub shows the `LICENSE` file, even if it does not display a standard
   open-source license badge.
3. Confirm `site/` is not present in this repo and the split is documented in
   `docs/11-repository-split.md`.
4. Run one local end-to-end loop: bootstrap, serve, connect MCP, ingest sample
   event, activate a metric, and query it.
5. Run the Docker self-host path from `docs/10-self-host.md` on a clean machine
   or clean Docker volume.
6. Verify `/Users/maksimstil/Desktop/poolstatis-site` separately before deploying
   the landing/docs/waitlist surface.
7. Update the public README with the real Cloud status before announcing.

## Do not promise yet

- Any `@poolstatis/mcp` registry command or hosted copy-paste preset until the
  exact published version has passed a fresh registry smoke.
- Cloud availability before the waitlist intake and hosted app are live.
- Billing enforcement before limits and metering are visible to users.
- A dashboard product; Poolstatis stays headless and agent-first.
