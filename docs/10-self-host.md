# Self-host Poolstatis with Docker

Docker Compose is the recommended self-host path. It runs:

- Postgres with a persistent volume,
- the Poolstatis Platform + Ingest API,
- the static admin console with `/api`, `/i`, and `/health` proxied to the API.

## Quick start

```bash
git clone https://github.com/lim5max/poolstatis.git
cd poolstatis

docker compose -f docker-compose.selfhost.yml up -d --build
curl http://localhost:3300/health
```

Create the first organization, project, and keys:

```bash
docker compose -f docker-compose.selfhost.yml run --rm poolstatis \
  node dist/cli/bootstrap.js "Acme" acme "Acme Product"
```

Save the printed tokens immediately. Poolstatis stores only token hashes.

Open the admin console:

```text
http://localhost:8080
```

Paste the printed `secret` (`sk_...`) or `personal` (`pt_...`) token. For product
ingest, use the printed `ingest prod` (`pk_...`) token.

## Product ingest

```bash
curl -X POST http://localhost:3300/i/v1/events \
  -H 'Authorization: Bearer pk_...' \
  -H 'content-type: application/json' \
  -d '{"events":[{"event":"signup.completed","distinct_id":"u1"}]}'
```

## MCP setup

Run the version-pinned public MCP package:

```bash
POOLSTATIS_URL=http://localhost:3300 \
POOLSTATIS_TOKEN=pt_... \
pnpm dlx @poolstatis/mcp@0.6.0
```

To execute the exact server from a local Core checkout instead, use:

```json
{
  "mcpServers": {
    "poolstatis": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/poolstatis", "mcp"],
      "env": {
        "POOLSTATIS_URL": "http://localhost:3300",
        "POOLSTATIS_TOKEN": "pt_..."
      }
    }
  }
}
```

## Production checklist

For a real VPS, create an env file first:

```bash
cp .env.selfhost.example .env.selfhost
$EDITOR .env.selfhost
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --build
```

Set at minimum:

- `POSTGRES_PASSWORD` to a strong value,
- `POOLSTATIS_CURSOR_SIGNING_SECRET` to an independent server-only random
  secret of at least 32 characters (do not reuse `pk_`/`sk_`/`pt_` tokens),
- `POOLSTATIS_PUBLIC_URL` to the public HTTPS URL,
- `POOLSTATIS_ADMIN_PORT` and `POOLSTATIS_API_PORT` only if the defaults conflict.

Generate the cursor secret before starting Compose:

```bash
openssl rand -base64 48
```

The example leaves this value empty intentionally; Compose fails closed until
you set it.

Tailored setup tasks are optional. By default, Poolstatis uses the bounded
deterministic compiler and needs no model provider. To enable the
OpenRouter-compatible composer, set `OPENROUTER_API_KEY` only in the server
environment or production secret store. Never use a `VITE_*` variable or place
the provider secret in a generated task. `OPENROUTER_API_URL` must be HTTPS;
timeout, invalid output, or a missing key falls back to the deterministic plan.

Protection defaults are enabled without extra setup: per-key/project token
buckets and a retention sweep every 15 minutes. Tune `RATE_LIMIT_*` only from
measured traffic; tune `RETENTION_BATCH_SIZE` and
`RETENTION_MAX_BATCHES`/`RETENTION_MAX_ROWS_PER_RUN` if maintenance I/O competes
with reads. Existing event partitions receive their operational indexes online
in the background; the API is already available, while retention waits for a
successful index read-back. Indexing and cleanup use a dedicated one-connection
maintenance pool, independent of `DATABASE_POOL_MAX`. To run a
bounded sweep explicitly:

```bash
docker compose -f docker-compose.selfhost.yml run --rm poolstatis \
  node dist/cli/retention.js
```

Put the admin/API behind a reverse proxy such as Caddy, Nginx, or Traefik for TLS.
Keep Postgres private to the Docker network. Back up the `poolstatis_pgdata` volume.

Recommended small VPS baseline: 2 vCPU, 4 GB RAM, and 50+ GB SSD. A 1 GB VPS can
work for demos, but it is tight once Postgres, Node, the proxy, and the OS are all
running.

## Operations

```bash
docker compose -f docker-compose.selfhost.yml ps
docker compose -f docker-compose.selfhost.yml logs -f poolstatis
docker compose -f docker-compose.selfhost.yml pull
docker compose -f docker-compose.selfhost.yml up -d --build
docker compose -f docker-compose.selfhost.yml run --rm poolstatis node dist/cli/retention.js
```

Dangerous: this removes all local data.

```bash
docker compose -f docker-compose.selfhost.yml down -v
```
