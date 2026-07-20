# Product Decision Loop Milestone A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ship trustworthy setup: proof-gated onboarding, reversible actor identity, property trust, and a scoped read-only PostHog path that can produce a real first query.

**Architecture:** Metadata and audit facts remain in Postgres; native event reads stay behind EventStore. Actor identity is resolved at query time from reversible link facts. PostHog is an explicitly bounded source adapter used only by QueryService and never imports or writes raw events.

**Tech Stack:** TypeScript 5.8, Fastify 5, PostgreSQL migrations, Zod 3, Vitest 3, React 19, MCP SDK.

## Global Constraints

- Repository boundary is /Users/maksimstil/Desktop/poolstatis; do not add landing code.
- Database name remains poolsatis.
- New behavior ships as REST, MCP, admin read-back, docs, and tests.
- No token or PostHog credential is returned after creation or written to logs/evidence.
- PostHog private reads use a personal API key with Query Read and schema-read permissions.
- PostHog query reads are bounded ad-hoc analytics, never bulk export.
- The repository declaration name is poolstatis.yml.
- Default evidence floor is 100 actors unless a contract explicitly requests more.

---

### Task 1: Trust and source persistence

**Files:**
- Create: migrations/017_decision_loop_trust_sources.sql
- Modify: src/schemas.ts
- Test: test/decision-loop-trust.test.ts

**Interfaces:**
- Produces ActorLink, PropertyDefinition, SourceConnection persistence.
- Produces actorLinkSchema, propertyDefinitionSchema, posthogConnectionSchema.

- [ ] **Step 1: Write the failing migration/schema test**

Create a test that migrates a fresh database and asserts the tables actor_links, actor_link_audit, property_definitions, source_connections, query_runs, onboarding_acknowledgements, and agent_observations exist. Assert Zod rejects a property purpose shorter than 10 characters and a PostHog host that is neither HTTPS nor loopback HTTP.

- [ ] **Step 2: Run the test and verify RED**

Run: pnpm test test/decision-loop-trust.test.ts
Expected: FAIL because migration 017 and the exported schemas do not exist.

- [ ] **Step 3: Add the migration and schemas**

The migration must:

~~~sql
CREATE TABLE actor_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  env text NOT NULL,
  source_distinct_id text NOT NULL,
  target_distinct_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','revoked')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_by text,
  revoked_at timestamptz,
  CHECK (source_distinct_id <> target_distinct_id)
);
CREATE UNIQUE INDEX actor_links_active_source_idx
  ON actor_links(project_id, env, source_distinct_id) WHERE status = 'active';
~~~

Add append-only actor_link_audit; project-scoped property_definitions with scope event/actor/entity, value_type string/number/boolean/datetime/enum, purpose, status proposed/trusted/untrusted, source native/posthog; encrypted source_connections with provider posthog, host, external_project_id, secret_ciphertext, secret_iv, secret_tag, verified_at, status; query_runs; onboarding_acknowledgements; agent_observations. Add project/env indexes and CHECK constraints.

- [ ] **Step 4: Run the targeted test and verify GREEN**

Run: pnpm test test/decision-loop-trust.test.ts
Expected: PASS.

### Task 2: Reversible actor resolution

**Files:**
- Create: src/services/identity.ts
- Modify: src/stores/eventStore.ts
- Modify: src/stores/postgresEventStore.ts
- Modify: src/stores/bufferedEventStore.ts
- Modify: src/http/server.ts
- Test: test/identity-links.test.ts

**Interfaces:**
- Produces createActorLink(pool, projectId, env, input, actor): Promise<ActorLink>.
- Produces revokeActorLink(pool, projectId, env, id, actor): Promise<ActorLink>.
- Produces listActorLinks(pool, projectId, env): Promise<ActorLink[]>.
- EventStore analytics resolve source ids to the final active target at query time.

- [ ] **Step 1: Write failing API and query tests**

Cover anonymous activity joining an authenticated actor in funnel and unique-actor trend results, revocation changing the next result without deleting events, active-source conflicts returning 409, cycle creation returning actor_link_cycle, project/env isolation, and audit rows surviving revocation.

- [ ] **Step 2: Run and verify RED**

Run: pnpm test test/identity-links.test.ts
Expected: FAIL with missing identity routes.

- [ ] **Step 3: Implement link validation and query-time resolution**

Use a bounded recursive CTE (maximum 32 hops) in the service to reject cycles before insert. Add an EventStore actor-resolution seam and use the canonical actor expression in unique_actors, funnel, retention, lifecycle, stickiness, experiment outcomes, and actorSummary. Raw sample events retain original distinct_id.

- [ ] **Step 4: Add REST routes**

Add POST/GET /api/v1/projects/:slug/identity-links and POST /api/v1/projects/:slug/identity-links/:id/revoke. Resolve project through existing org/secret-key checks and record authOwner as created_by/revoked_by.

- [ ] **Step 5: Run and verify GREEN**

Run: pnpm test test/identity-links.test.ts test/query.test.ts test/retention.test.ts test/flags-experiments.test.ts
Expected: PASS.

### Task 3: Property registry and measurement trust

**Files:**
- Create: src/services/properties.ts
- Create: src/services/measurementTrust.ts
- Modify: src/http/server.ts
- Modify: src/services/schema.ts
- Test: test/property-registry.test.ts

**Interfaces:**
- Produces upsertPropertyDefinition, listPropertyDefinitions, setPropertyTrust.
- Produces assessMetricTrust(pool, eventStore, projectId, env, metricKey, targetFilters).
- Trust result contains status, blockers, identity coverage, registered coverage, property coverage, and observed actors.

- [ ] **Step 1: Write failing trust tests**

Assert only trusted properties can make a target filter trusted; unknown/untrusted properties create explicit blockers; an active metric with no real registered event is untrusted; coverage counts exclude system events; project/env authorization is enforced.

- [ ] **Step 2: Run and verify RED**

Run: pnpm test test/property-registry.test.ts
Expected: FAIL because property routes and trust assessment are missing.

- [ ] **Step 3: Implement registry and coverage assessment**

Add POST/GET/PATCH property routes. Compute coverage using EventStore aggregate methods, never direct client-exposed SQL. Include properties and identity status in project schema read-back.

- [ ] **Step 4: Run and verify GREEN**

Run: pnpm test test/property-registry.test.ts test/registry.test.ts
Expected: PASS.

### Task 4: Read-only PostHog adapter

**Files:**
- Create: src/crypto.ts
- Create: src/services/posthog.ts
- Modify: src/config.ts
- Modify: src/http/context.ts
- Modify: src/http/server.ts
- Modify: src/schemas.ts
- Modify: src/services/query.ts
- Test: test/posthog-adapter.test.ts

**Interfaces:**
- Produces PostHogAdapter.configure, verify, discoverSchema, trend, funnel, retention, sample.
- QueryService routes metrics whose source.data_source is posthog to PostHogAdapter.
- API never returns secret_ciphertext, secret_iv, secret_tag, personal_api_key, or generated HogQL.

- [ ] **Step 1: Write a failing controlled-PostHog E2E test**

Start a loopback HTTP fixture implementing GET event_definitions, GET property_definitions, GET events, and POST query. Assert configure encrypts phx_test at rest, verify uses Authorization: Bearer, schema is mapped, trend/funnel/retention produce Poolstatis Query DSL result shapes, sample is capped, no write method is called, and unsupported value/conversion definitions fail with posthog_capability_unsupported.

- [ ] **Step 2: Run and verify RED**

Run: pnpm test test/posthog-adapter.test.ts
Expected: FAIL because adapter routes do not exist.

- [ ] **Step 3: Implement encryption and bounded HTTP client**

Use AES-256-GCM with a key derived from POOLSTATIS_CONNECTOR_ENCRYPTION_KEY. Require the key only when configuring/using an external connection. Apply AbortSignal timeout, a maximum response size, loopback-only HTTP, HTTPS otherwise, and sanitized upstream errors.

- [ ] **Step 4: Implement supported query translation**

Use POST /api/projects/:project_id/query/ with named, bounded, server-generated queries; never accept HogQL from callers. Support count/unique_actors trend, event funnels, basic retention, and sample/schema reads. Use project ID plus personal API key; do not accept a project token as private auth.

- [ ] **Step 5: Add REST routes and QueryService routing**

Add configure, verify, schema, and connection status routes. Extend metric event sources with data_source native/posthog and optional source_connection_id while preserving native defaults.

- [ ] **Step 6: Run and verify GREEN**

Run: pnpm test test/posthog-adapter.test.ts test/query.test.ts
Expected: PASS.

### Task 5: Evidence-backed onboarding gates

**Files:**
- Create: src/services/onboarding.ts
- Modify: src/http/server.ts
- Modify: src/services/query.ts
- Test: test/proof-onboarding.test.ts

**Interfaces:**
- Produces getOnboardingStatus(pool, eventStore, projectId, env): Promise<OnboardingStatus>.
- Gate keys: workspace_created, agent_connected, data_source_connected, first_event_observed, metrics_activated, data_quality_accepted, first_query_produced, first_decision_saved.
- Every incomplete gate has blocker and next_action.

- [ ] **Step 1: Write failing gate-state tests**

Assert reload persistence, copied config/no MCP call incomplete, key/no event incomplete, unregistered event not verified, first real query persisted in query_runs, acknowledgement persisted, and final gate includes metric purpose/window/next action from a real decision.

- [ ] **Step 2: Run and verify RED**

Run: pnpm test test/proof-onboarding.test.ts
Expected: FAIL because onboarding status is not implemented.

- [ ] **Step 3: Persist agent and query evidence**

Add POST /onboarding/observe-agent requiring x-poolstatis-client: mcp, GET /onboarding/status, and POST /onboarding/acknowledgements. Record query_runs after successful platform queries with sanitized Query DSL and result summary.

- [ ] **Step 4: Compute gates from server evidence**

Derive every gate from projects, API keys/source connection, non-system events, active registered metrics, measurement trust/acknowledgements, query_runs, and saved decisions. Never accept a client-supplied completed flag.

- [ ] **Step 5: Run and verify GREEN**

Run: pnpm test test/proof-onboarding.test.ts test/auth_onboarding.test.ts
Expected: PASS.

### Task 6: MCP and admin audit surfaces

**Files:**
- Modify: src/mcp/server.ts
- Modify: web/src/api/types.ts
- Modify: web/src/api/client.ts
- Create: web/src/screens/Measurement.tsx
- Modify: web/src/screens/Setup.tsx
- Modify: web/src/App.tsx
- Test: test/mcp-decision-loop-a.test.ts

**Interfaces:**
- MCP tools: get_onboarding_status, create/list/revoke_actor_link, register/list/update_property, configure/verify/get_posthog_schema.
- Admin Setup renders gates and blockers; Measurement renders metric trust, properties, identity links, and source status.

- [ ] **Step 1: Write failing MCP contract tests**

Invoke every new tool through InMemoryTransport and assert REST-equivalent response shapes and project scoping.

- [ ] **Step 2: Run and verify RED**

Run: pnpm test test/mcp-decision-loop-a.test.ts
Expected: FAIL with unknown tools.

- [ ] **Step 3: Register MCP tools and build typed admin clients**

The onboarding status tool first records an observed MCP connection, then reads status. Secret input fields are write-only and cleared after configure.

- [ ] **Step 4: Build Setup and Measurement screens**

Use Panel/Toolbar/Hint and existing typography. Show product language, exact blockers, trust state, actor-link audit, and source capability limits; do not add charts.

- [ ] **Step 5: Run targeted verification**

Run: pnpm test test/mcp-decision-loop-a.test.ts && pnpm --dir web build
Expected: PASS and build exit 0.

### Task 7: Milestone A end-to-end proof

**Files:**
- Create: test/e2e/decision-loop-a.test.ts
- Create: docs/09-product-decision-loop.md
- Modify: docs/04-http-api.md

- [ ] **Step 1: Write native and controlled-PostHog E2E scenarios**

Native: create project/key, ingest real event, register/activate metric, trust property, create identity link, query and read gates. PostHog: configure fixture, discover schema, register PostHog metric, query without importing events, and read gates.

- [ ] **Step 2: Run E2E and milestone regression**

Run: pnpm test test/e2e/decision-loop-a.test.ts
Expected: PASS with both source paths.

- [ ] **Step 3: Document exact capabilities and limits**

Document poolstatis.yml choice, identity semantics, encryption env, PostHog read-only capability matrix, and setup blockers.

- [ ] **Step 4: Run Milestone A gate**

Run: pnpm typecheck && pnpm test && pnpm --dir sdk test && pnpm --dir sdk build && pnpm --dir web build
Expected: all commands exit 0.
