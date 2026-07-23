# Contributing to Poolstatis

Poolstatis is agent-native product analytics. The repo is source-available under
the PolyForm Shield License 1.0.0, and the architecture is intentionally narrow:
semantic registry first, typed Query DSL, MCP tools for agents, and a headless
admin for humans.

## Local setup

```bash
docker compose up -d
pnpm install
pnpm build
pnpm migrate
pnpm bootstrap "Poolstatis" poolstatis "Local project"
pnpm serve
```

Admin SPA:

```bash
pnpm --dir web dev
```

Public site and docs:

```bash
pnpm --dir site dev
```

## Before opening a PR

Run the checks that match your change:

```bash
pnpm typecheck
pnpm test
pnpm --dir sdk test
pnpm --dir web build
pnpm --dir site build
```

`pnpm test` requires Docker Postgres on `localhost:5444`.

## What a complete change means

- Backend behavior needs a focused test.
- Query DSL changes need schema, service, `EventStore`, MCP, and docs updates.
- Registry changes must preserve metric `purpose` and funnel `goal`.
- UI changes should use existing shared components and match the current design system.
- Public copy must keep human admin auth separate from runtime keys (`pk_`, `sk_`, `pt_`).
- MCP setup copy must not claim `@poolstatis/mcp` is published until it is.

## Architecture boundaries

- Event reads and writes go through `EventStore`.
- Clients never receive raw SQL access.
- Query branches reference registry metric keys, not raw event names.
- Unregistered events are accepted and flagged, not dropped.
- The admin UI is a platform console, not a customer analytics dashboard.

## Pull request style

Keep PRs small and complete. Explain:

- what changed,
- why it matters,
- how it was verified,
- any behavior that remains unverified.

Do not include secrets, tokens, production database URLs, webhook URLs, or copied customer data.
