# @poolstatis/mcp

Thin stdio MCP runner for a Poolstatis API instance.

```sh
POOLSTATIS_URL=https://api.example.com \
POOLSTATIS_TOKEN=pt_your_token \
pnpm dlx @poolstatis/mcp@0.1.0
```

`POOLSTATIS_TOKEN` must be a `pt_` personal token or project-scoped `sk_` key.
`POOLSTATIS_URL` must be a clean HTTPS origin; HTTP is allowed only for a local
loopback API during controlled development. No production URL or token is
embedded in the package, and the runner never prints the token.

Node.js 22 and 24 are supported. The package is an ESM executable and speaks
MCP over stdio only; stdout is reserved for protocol messages.
