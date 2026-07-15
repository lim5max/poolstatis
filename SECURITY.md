# Security Policy

Poolstatis handles product analytics events, scoped API keys, and MCP access tokens.
Please treat security reports privately.

## Supported versions

The project is pre-1.0. Security fixes target the `main` branch until release
branches exist.

## Reporting a vulnerability

Do not open a public issue for vulnerabilities.

Use GitHub private vulnerability reporting for this repository when available:

https://github.com/lim5max/poolstatis/security/advisories/new

If that flow is unavailable, contact the maintainer privately before disclosing
details. Include:

- affected commit or version,
- reproduction steps,
- impact,
- whether credentials, tokens, or customer data may be exposed.

## Secret handling

Never commit:

- `pk_`, `sk_`, or `pt_` keys,
- database URLs,
- Auth0/OIDC secrets,
- webhook URLs or bearer secrets,
- production event payloads containing customer data.

Use `.env` locally and Vercel/hosting environment variables in production.
