# Hosted database roles

Hosted Poolstatis separates three PostgreSQL credentials:

- a short-lived deploy migrator (`MIGRATION_DATABASE_URL`);
- the API/worker runtime (`DATABASE_URL`);
- the private Cloud runtime, which can only activate a prepared organization.

The API process must not receive `MIGRATION_DATABASE_URL`. Self-host installs
may continue to use one database owner with `HOSTED_POLICY_REQUIRED=false`.
The deploy migrator is a fully trusted offline credential and must never be
used to run the API.

## Privileged bootstrap

Run this once as the PostgreSQL role administrator, substituting the actual
login role names:

```sql
CREATE ROLE poolstatis_policy_owner NOLOGIN NOINHERIT;
CREATE ROLE poolstatis_core_runtime NOLOGIN NOINHERIT;
CREATE ROLE poolstatis_policy_activator NOLOGIN NOINHERIT;

GRANT poolstatis_policy_owner TO core_deploy WITH ADMIN TRUE;
GRANT poolstatis_policy_owner TO core_deploy WITH SET TRUE;
GRANT poolstatis_core_runtime TO core_deploy WITH ADMIN TRUE;
GRANT poolstatis_core_runtime TO core_deploy WITH INHERIT FALSE;
GRANT poolstatis_policy_activator TO core_deploy WITH ADMIN TRUE;
GRANT poolstatis_policy_activator TO core_deploy WITH INHERIT FALSE;
```

Migration 027 is deliberately schema-only. It never creates, validates, or
grants cluster roles, even when the database owner has `CREATEROLE`; ordinary
self-host and shared-cluster installs therefore cannot collide with hosted
role names. It creates the policy table/functions/triggers with `PUBLIC`
execution revoked.

Run the compiled privileged preparation job with both URLs:

```bash
HOSTED_POLICY_REQUIRED=true \
DATABASE_URL='postgres://core_runtime:…@db/poolstatis' \
MIGRATION_DATABASE_URL='postgres://core_deploy:…@db/poolstatis' \
node dist/cli/prepareHosted.js
```

`prepareHosted` is the only operation that applies hosted role hardening. It
fails with an actionable bootstrap error until the three stable roles and the
deploy role memberships above exist. The hardening step is idempotent, so a
self-host database can later become hosted without deleting or replaying
migration 027. The job also fails closed until the restricted runtime grants
are exact, rolling event partitions exist for the next 12 months, and
operational indexes are ready. Run it during deploys and on a daily schedule
so the next UTC-month boundary is prepared well before traffic reaches it.

## Runtime memberships

The deploy migrator grants membership without role switching or delegation:

```sql
GRANT poolstatis_core_runtime TO core_runtime WITH INHERIT TRUE;
GRANT poolstatis_core_runtime TO core_runtime WITH SET FALSE;

GRANT poolstatis_policy_activator TO cloud_runtime WITH INHERIT TRUE;
GRANT poolstatis_policy_activator TO cloud_runtime WITH SET FALSE;
```

`core_runtime` receives a curated list of ordinary application tables plus
the require/backfill/write-readiness functions. It cannot read or mutate
`organization_policy_state`, cannot execute activation, cannot access
`schema_migrations`, and cannot create partitions or indexes.

`cloud_runtime` receives only
`poolstatis_activate_organization_policy(uuid)`. Private Cloud provisions all
trial/entitlement rows and calls activation last in the same transaction,
asserting that it returned `true`.

Finally start the API with only `DATABASE_URL` and
`HOSTED_POLICY_REQUIRED=true`. Startup is read-only: it verifies the runtime
role, operational indexes, and pending-policy backfill before listening.
While an organization marker is pending, the shared HTTP boundary blocks all
customer product mutations for JWT, `pt_`, `sk_`, and `pk_` credentials with
the neutral `organization_write_disabled` response. GET reads, analytics
queries, profile updates, own-token revocation, and explicitly classified
read-only POST operations remain available. MCP uses the same HTTP boundary.
With `HOSTED_POLICY_REQUIRED=false`, the policy lookup is not installed and
self-host behavior remains unchanged.
