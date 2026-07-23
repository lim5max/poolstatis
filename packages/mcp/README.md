# @poolstatis/mcp

Thin stdio MCP runner for a Poolstatis API instance.

```sh
POOLSTATIS_URL=https://api.example.com \
POOLSTATIS_TOKEN=pt_your_token \
pnpm dlx @poolstatis/mcp
```

`POOLSTATIS_TOKEN` must be a `pt_` personal token or project-scoped `sk_` key.
`POOLSTATIS_URL` must be a clean HTTPS origin; HTTP is allowed only for a local
loopback API during controlled development. The runner never prints the token.
