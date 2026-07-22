# Poolstatis Cloud Beta Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Every task is test-first, committed separately, and reviewed before the next task starts.

**Goal:** Make the source-available core safe and complete for a hosted multi-tenant beta without embedding Poolstatis Cloud pricing, Auth0 tenant secrets, Resend credentials, or operator-only behavior.

**Architecture:** The core verifies configurable JWT claims, provisions isolated organizations, enforces API-key scopes, stores usage facts atomically with events, exposes generic quota/entitlement hooks, and ships customer-facing project/profile/usage surfaces plus a publishable MCP runner. Commercial grants and hosted operations stay in `poolstatis-cloud`.

**Tech Stack:** TypeScript 5.8, Fastify 5, PostgreSQL, Zod 3, Vitest 3, React 19, Vite, MCP SDK, Docker Compose.

## Global constraints

- Work only in `/Users/maksimstil/Desktop/poolstatis/.worktrees/cloud-beta-core` on `codex/cloud-beta-core`.
- Database name remains `poolsatis`.
- Passwords, password-reset tokens, verification tokens, Auth0 Management tokens, price tables, and Resend credentials never enter this repository.
- A user identity is keyed by JWT `sub`; email/name/picture are configurable namespaced claims.
- `sk_` is project-scoped and never authorizes organization-level project creation.
- `pt_` is organization-scoped, shown once, hashed at rest, listable in masked form, and revocable.
- The primary meter counts only accepted events durably inserted in the same transaction.
- Existing self-host behavior remains available when hosted JWT, entitlements, or quota configuration is absent.

---

### Task 1: Verified JWT identity, profile, CORS, and readiness

**Files:**
- Create: `migrations/017_cloud_identity_profile.sql`
- Modify: `src/config.ts`
- Modify: `src/http/auth.ts`
- Modify: `src/http/server.ts`
- Modify: `src/services/accounts.ts`
- Modify: `src/schemas.ts`
- Test: `test/cloud-auth-profile.test.ts`
- Test: `test/health-readiness.test.ts`

**Interfaces:**
- `JwtAuthOptions.claims` maps email, emailVerified, displayName, and picture claim names.
- `AuthContext.user` contains `emailVerified`, `displayName`, `picture`, and `connectionStrategy` without storing credentials.
- `GET /api/v1/me` returns local profile, membership, and identity read-back.
- `PATCH /api/v1/me` accepts only `display_name`.
- `GET /ready` checks the database and reports `503` until dependencies are ready.
- CORS accepts only configured origins and rejects reflective arbitrary origins.

- [ ] **Step 1: Write failing identity/profile/readiness tests**

Cover namespaced claims, missing/false verified claim returning `403 email_verification_required` before provisioning, stable `sub` reuse, concurrent first-login idempotency, profile read/update, ignored forged profile fields, allowlisted CORS, database readiness, and sanitized errors.

- [ ] **Step 2: Verify RED**

Run: `pnpm test test/cloud-auth-profile.test.ts test/health-readiness.test.ts`

- [ ] **Step 3: Add generic claim configuration and atomic provisioning**

Add environment-backed claim names with namespaced hosted defaults. Serialize first provisioning per issuer+subject with a transaction-scoped advisory lock and uniqueness constraints. Store `email_verified`, local `display_name`, picture URL, and connection strategy as profile metadata only.

- [ ] **Step 4: Add profile, CORS, and readiness routes**

Return neutral authentication failures, never token payloads. Allow PATCH of local display name only. Parse a comma-separated exact-origin allowlist, with loopback development defaults only outside production.

- [ ] **Step 5: Verify GREEN and regression safety**

Run: `pnpm test test/cloud-auth-profile.test.ts test/health-readiness.test.ts test/auth_onboarding.test.ts && pnpm typecheck`

### Task 2: Tenant-safe projects and personal-token lifecycle

**Files:**
- Create: `migrations/018_personal_token_lifecycle.sql`
- Modify: `src/http/auth.ts`
- Modify: `src/http/server.ts`
- Modify: `src/services/projects.ts`
- Modify: `src/services/accounts.ts`
- Modify: `src/schemas.ts`
- Test: `test/cloud-tenant-isolation.test.ts`
- Test: `test/personal-token-lifecycle.test.ts`

**Interfaces:**
- Hosted owner/admin JWT and `pt_` may create projects inside their organization.
- `sk_` receives `403 insufficient_scope` from organization project creation.
- `GET /api/v1/me/tokens` lists masked personal tokens with created/last-used/revoked timestamps.
- `DELETE /api/v1/me/tokens/:id` revokes a personal token; revoked credentials fail immediately.
- Auth updates `last_used_at` without exposing or re-hashing plaintext values.

- [ ] **Step 1: Write failing scope/isolation tests**

Create two organizations with identical project slugs, metric keys, actor IDs, and environments. Prove zero cross-tenant reads/writes through REST and MCP auth contexts. Cover `sk_` project-create denial, JWT/`pt_` project creation, masked listing, revocation, and concurrent onboarding/project creation.

- [ ] **Step 2: Verify RED**

Run: `pnpm test test/cloud-tenant-isolation.test.ts test/personal-token-lifecycle.test.ts`

- [ ] **Step 3: Enforce organization and project boundaries centrally**

Split organization-management authorization from project-management authorization. Resolve every project through the caller organization or exact secret-key project before service execution; never trust caller-supplied organization IDs.

- [ ] **Step 4: Implement personal-token lifecycle**

Tokens are returned once, stored only as hashes, and later shown as prefix plus suffix. Revoke by token ID owned by the authenticated subject and organization.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test test/cloud-tenant-isolation.test.ts test/personal-token-lifecycle.test.ts test/auth_onboarding.test.ts test/api.test.ts && pnpm typecheck`

### Task 3: Atomic accepted-event metering and generic quotas

**Files:**
- Create: `migrations/019_usage_ledger_entitlements.sql`
- Modify: `src/stores/eventStore.ts`
- Modify: `src/stores/postgresEventStore.ts`
- Modify: `src/stores/bufferedEventStore.ts`
- Modify: `src/services/ingest.ts`
- Modify: `src/services/experienceIngest.ts`
- Modify: `src/http/server.ts`
- Modify: `src/schemas.ts`
- Test: `test/usage-metering.test.ts`
- Test: `test/usage-quota.test.ts`

**Interfaces:**
- Immutable `usage_ledger` facts use meter `events_stored`, organization/project/environment, UTC `period_start`, quantity, source batch, and dedupe key.
- `organization_usage` is a transactional projection, rebuildable from the ledger.
- EventStore append returns actual inserted count and records usage in the same database transaction.
- A generic organization entitlement contains optional hard limit and warning thresholds; no commercial prices.
- Cap rejection returns whole-batch `402 billing_limit_reached`; reads remain available.

- [ ] **Step 1: Write failing atomicity and classification tests**

Count valid native, experience, unregistered, and clock-skewed stored events. Exclude validation failures, duplicates, entities, system events, 413/429/503, and rolled-back inserts. Prove retry dedupe for at least 35 days, parallel batches cannot overshoot a hard limit, and a forced ledger failure rolls back event insertion.

- [ ] **Step 2: Verify RED**

Run: `pnpm test test/usage-metering.test.ts test/usage-quota.test.ts`

- [ ] **Step 3: Add ledger, projection, and atomic append result**

Lock the organization usage row in the event-insert transaction, evaluate the generic hard limit, insert events, append one idempotent ledger fact, update the projection by the actual inserted count, and commit together. Keep warning persistence best-effort after the primary transaction.

- [ ] **Step 4: Extend idempotency horizon and expose usage**

Preserve ingest batch records for 35 days before a batch ID can be reclaimed. Add `GET /api/v1/me/usage?period=YYYY-MM` and organization/project breakdowns without prices.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test test/usage-metering.test.ts test/usage-quota.test.ts test/ingest.test.ts test/experience-ingest.test.ts && pnpm typecheck`

### Task 4: Customer projects, profile, tokens, and usage UI

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/auth0.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/screens/Projects.tsx`
- Create: `web/src/screens/Profile.tsx`
- Create: `web/src/screens/Usage.tsx`
- Modify: `web/src/components/ui.tsx`
- Test: `web/src/cloud-ui.test.tsx`

**Interfaces:**
- Hosted JWT users can create and switch among their projects.
- Secret-key sessions cannot see organization project creation controls.
- Profile shows verified email, local display name, avatar, role, and logout.
- Personal tokens are generated once, copied explicitly, listed masked, and revocable.
- Usage shows stored events by UTC month, project, environment, warnings, and the configured generic limit.

- [ ] **Step 1: Write failing component tests**

Cover role/scope visibility, profile edit, token one-time display/revoke, usage states, empty/error/loading behavior, and mobile-safe tables.

- [ ] **Step 2: Verify RED**

Run: `pnpm --dir web test --run cloud-ui.test.tsx`

- [ ] **Step 3: Implement screens with existing shadcn helpers**

Use `Panel`, `Toolbar`, `Hint`, `Confirm`, and existing typography. Do not create a per-project analytics dashboard; this remains a headless customer/platform admin.

- [ ] **Step 4: Verify GREEN and production build**

Run: `pnpm --dir web test --run cloud-ui.test.tsx && pnpm --dir web build`

### Task 5: Publishable MCP runner and Cloud security E2E

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/src/cli.ts`
- Create: `packages/mcp/README.md`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/mcp/server.ts`
- Create: `test/cloud-mcp-e2e.test.ts`
- Create: `test/ssrf-security.test.ts`
- Modify: `docker-compose.selfhost.yml`
- Modify: `README.md`

**Interfaces:**
- `pnpm dlx @poolstatis/mcp` runs a stdio MCP client using `POOLSTATIS_URL` and `POOLSTATIS_TOKEN`.
- Standard MCP tools do not create an independent usage meter.
- Two-tenant MCP E2E proves discovery, registry, ingest read-back, trend/funnel query, and isolation.
- All outbound connector URLs pass centralized HTTPS/loopback validation and DNS/IP checks against private/link-local/metadata targets.

- [ ] **Step 1: Write failing package and security E2E tests**

Cover CLI startup/config errors, `pt_` organization discovery, `sk_` exact-project scope, revoked token denial, malicious URL forms, redirects, DNS rebinding-sensitive resolution, and two tenants using identical identifiers.

- [ ] **Step 2: Verify RED**

Run: `pnpm test test/cloud-mcp-e2e.test.ts test/ssrf-security.test.ts`

- [ ] **Step 3: Add the thin published runner and hardened URL policy**

Reuse the existing MCP implementation; do not fork tool behavior into the package. Reject credentials in URLs, non-HTTPS production targets, loopback/private/link-local/reserved resolved addresses, and unsafe redirects.

- [ ] **Step 4: Run the full completion gate**

Run: `pnpm typecheck && pnpm test && pnpm --dir web build && pnpm --dir sdk test && docker compose -f docker-compose.selfhost.yml config >/dev/null`

- [ ] **Step 5: Request final code and security review**

Review tenant authorization, token leakage, usage atomicity, SSRF, migration reversibility, backward compatibility, and production defaults. Resolve all P0/P1 findings before the core branch is declared ready.
