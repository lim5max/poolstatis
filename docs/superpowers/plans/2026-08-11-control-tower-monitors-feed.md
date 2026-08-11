# Control Tower Monitors And Insight Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship configurable metric monitors, truthful notification routing, timezone-aware scheduled insight feeds, and frozen human-reviewed pause/rollback proposals as one server-backed Core capability.

**Architecture:** Add versioned project-scoped resources and append-only audit/snapshot tables in one additive migration. Domain services own validation, versioning, tenant scope and privacy-safe serialization; bounded workers use leases, deterministic deduplication and capped retries. REST and MCP are thin adapters over those services. A route-ready admin screen consumes the typed REST contract without editing the existing application shell or lifecycle screens.

**Tech Stack:** TypeScript 5, Fastify 5, PostgreSQL 17, Zod 3, MCP SDK, React 19, shadcn/ui, Tailwind v4, Vitest.

## Global Constraints

- Branch ancestry is exactly master PRD commit `1a92166e6ca54e9a39b68587f754a433f6a0d4f3` over Core `origin/main` `47059fd17ab07e6104948ef4512d97ee7812f43b`; Hugeicons Pro commit `1c629d0` is excluded.
- Do not modify `web/src/App.tsx`, navigation, `ProductAnalytics.tsx`, `Experiments.tsx` or `Decisions.tsx`.
- All persistence is additive; no event rewrites, destructive migrations, raw SQL client API, public ingest changes or SDK request changes.
- Policies and schedules are versioned; audits, findings, result snapshots, inbox records and delivery attempts are append-only.
- Workers use `FOR UPDATE SKIP LOCKED`, expiring leases, capped exponential retry and stable idempotency keys.
- Notification payloads exclude raw events, actor IDs, arbitrary properties, prompts, URLs, credentials and token-like values.
- Built-in delivery is limited to `in_product` and durable `outbox`; external delivery reports `not_configured` and is exposed only through a typed adapter seam.
- Automation creates only frozen proposals with exact payload, undo and SHA-256 confirmation fingerprint. It never changes traffic or deploy state.
- Proposal review is explicit and audited. Any later traffic change must use the existing human-approved mutation contract.
- REST and MCP preserve identical authorization, tenant scope and structured meaning.
- All database tests use the disposable test PostgreSQL URLs supplied to the commands.

---

### Task 1: Additive persistence and immutable boundaries

**Files:**
- Create: `migrations/036_control_tower_automation.sql`
- Create: `test/control-tower-automation-schema.test.ts`

**Interfaces:**
- Produces: versioned `monitor_policies`/`monitor_policy_revisions`, `notification_destinations`, durable monitor runs/findings, `automation_proposals`, versioned insight schedules/runs/snapshots, delivery outbox/inbox and append-only audits.
- Consumes: existing `projects`, `metrics`, `releases`, `experiments`, `feature_flags` and `poolstatis_reject_immutable_mutation()`.

- [ ] **Step 1: Write the failing schema test**

Create a DB integration test that asserts every table, unique dedupe constraint, project-scoped foreign key/index, enum check and immutable trigger exists. It must attempt and reject updates/deletes against audit, finding, snapshot, inbox and delivery-attempt rows.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/control-tower-automation-schema.test.ts`

Expected: FAIL because migration `036_control_tower_automation.sql` and its tables do not exist.

- [ ] **Step 3: Write the additive migration**

Use stable resource heads plus immutable revisions. Job-state tables may update lease/status/retry fields; their completed semantic results live in immutable finding/snapshot rows. Add unique keys for `(project_id, policy_key)`, `(policy_id, version)`, monitor window dedupe, schedule local-run dedupe and delivery idempotency.

- [ ] **Step 4: Verify GREEN**

Run the same targeted test against a freshly recreated disposable test database. Expected: PASS.

### Task 2: Typed schemas, timezone/DST and versioned CRUD

**Files:**
- Create: `src/services/automationSchemas.ts`
- Create: `src/services/timezoneSchedule.ts`
- Create: `src/services/monitorPolicies.ts`
- Create: `src/services/insightFeeds.ts`
- Create: `test/timezone-schedule.test.ts`
- Create: `test/control-tower-automation-services.test.ts`

**Interfaces:**
- Produces: strict Zod inputs; `nextZonedOccurrence(cadence, after)`; monitor/schedule create, update, pause/resume/archive, list and detail reads.
- Consumes: PostgreSQL pool and registry/flag/release/experiment rows for validation.

- [ ] **Step 1: Write failing timezone tests**

Cover UTC daily/weekly schedules, `America/New_York` spring-forward `02:30` shifting to the first valid minute after the gap, fall-back `01:30` selecting the first occurrence, and one local-run key per scheduled local date.

- [ ] **Step 2: Verify timezone RED**

Run: `pnpm vitest run test/timezone-schedule.test.ts`. Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement the bounded timezone resolver**

Use `Intl.DateTimeFormat` with validated IANA timezones and a bounded minute scan. Return `{ scheduledAt, localRunKey, resolution: 'exact' | 'dst_shifted' }`; do not depend on host timezone.

- [ ] **Step 4: Verify timezone GREEN**

Run the timezone test and confirm every literal UTC expectation passes.

- [ ] **Step 5: Write failing service tests**

Assert strict validation, active metric and matching target scope, revision increments, stale-version conflicts, immutable revision history, explicit destination IDs, owner/admin-compatible audit identity, project isolation and archived-resource immutability.

- [ ] **Step 6: Verify service RED**

Run: `pnpm vitest run test/control-tower-automation-services.test.ts`. Expected: FAIL because services are absent.

- [ ] **Step 7: Implement minimal versioned services**

Create resource heads under a project advisory lock, append exact revisions, update only head lifecycle/scheduling fields, and append audit snapshots. Schedule schemas support `daily` or `weekly`, IANA timezone, local `HH:mm`, optional weekday, metric-trend template, bounded window days and destination IDs.

- [ ] **Step 8: Verify service GREEN**

Run both targeted tests and confirm PASS.

### Task 3: Notifications, monitor evaluation and frozen proposals

**Files:**
- Create: `src/services/notifications.ts`
- Create: `src/services/monitorWorker.ts`
- Create: `src/services/automationProposals.ts`
- Create: `test/control-tower-monitor-worker.test.ts`
- Create: `test/control-tower-notifications.test.ts`
- Create: `test/control-tower-proposals.test.ts`

**Interfaces:**
- Produces: `NotificationDeliveryAdapter`, built-in in-product/outbox adapters, `MonitorWorker.runOnce(now)`, proposal list/detail/approve/reject.
- Consumes: `QueryService.run`, monitor revisions, current feature-flag allocation and existing mutation identifiers.

- [ ] **Step 1: Write failing notification tests**

Assert in-product delivery creates one immutable inbox item, outbox delivery becomes extension-ready without claiming external send, duplicate calls do not duplicate delivery, missing routes report `not_configured`, failures retry with capped backoff/lease recovery, and payload serialization rejects prohibited keys/values.

- [ ] **Step 2: Verify notification RED**

Run: `pnpm vitest run test/control-tower-notifications.test.ts`. Expected: FAIL because service is absent.

- [ ] **Step 3: Implement truthful notification routing**

Expose capabilities `{ in_product: 'configured', outbox: 'configured', external: 'not_configured' }`. The adapter input is a bounded `NotificationEnvelope` containing answer, evidence state, stable policy/schedule code and timestamps only.

- [ ] **Step 4: Verify notification GREEN**

Run the targeted test and confirm PASS.

- [ ] **Step 5: Write failing monitor-worker tests**

Cover above/below and relative-change rules, minimum sample, no-breach runs, deterministic windows, one finding per policy revision/window, cooldown, concurrent workers, stale lease recovery, retry/dead state, tenant isolation and notification routing.

- [ ] **Step 6: Verify monitor RED**

Run: `pnpm vitest run test/control-tower-monitor-worker.test.ts`. Expected: FAIL because worker is absent.

- [ ] **Step 7: Implement monitor worker**

Seed due runs, claim bounded runs with `SKIP LOCKED`, query only the registered metric through `QueryService`, aggregate literal current/previous windows, persist a frozen finding on breach, enqueue destinations idempotently and finalize lease/retry state.

- [ ] **Step 8: Write failing proposal tests**

Assert a breached policy freezes exact flag allocation target, desired payload, current allocation undo and SHA-256 fingerprint; duplicate evaluation returns the same proposal; approve/reject append audit; stale/wrong fingerprint fails; no worker/review endpoint calls `updateFeatureFlag`, experiment decisions or deploy code.

- [ ] **Step 9: Verify proposal RED**

Run: `pnpm vitest run test/control-tower-proposals.test.ts`. Expected: FAIL before proposal service exists.

- [ ] **Step 10: Implement proposal state machine**

Worker inserts `proposed` only. Review transitions to `approved` or `rejected`, returning `execution.state='requires_existing_mutation'` plus the existing mutation kind. Keep the frozen proposal immutable after insertion and append every state snapshot to audit.

- [ ] **Step 11: Verify monitor/proposal GREEN**

Run all three Task 3 suites and confirm PASS.

### Task 4: Scheduled semantic insight feed worker

**Files:**
- Create: `src/services/insightFeedWorker.ts`
- Create: `test/control-tower-insight-feed-worker.test.ts`

**Interfaces:**
- Produces: `InsightFeedWorker.runOnce(now)` with deterministic schedule seeding, claim, query, snapshot and delivery.
- Consumes: versioned schedules, `nextZonedOccurrence`, `QueryService`, registry metric semantic fingerprint and notification service.

- [ ] **Step 1: Write failing feed-worker tests**

Cover resolved UTC query windows, metric definition fingerprint, answer-first privacy-safe snapshot, ready/empty/error evidence states, DST local-run dedupe, pause/resume, concurrent workers, stale lease recovery, retry/dead state, restart idempotency and destination delivery.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/control-tower-insight-feed-worker.test.ts`. Expected: FAIL because worker is absent.

- [ ] **Step 3: Implement feed worker**

Seed one run per local key, claim with lease, execute a strict trend query for the frozen metric/template/window, derive current total and bounded takeaway, store immutable result/evidence refs and enqueue notifications. Advance `next_run_at` using the persisted schedule revision and DST resolver only after the run row exists.

- [ ] **Step 4: Verify GREEN**

Run the targeted suite and confirm PASS.

### Task 5: REST, MCP and runtime worker wiring

**Files:**
- Create: `src/http/automationRoutes.ts`
- Modify: `src/http/server.ts` with one import and one route-registration call inside existing project authorization helpers
- Modify: `src/mcp/server.ts` with thin 1:1 REST tools only
- Modify: `src/config.ts`
- Modify: `src/cli/serve.ts`
- Modify: `test/config.test.ts`
- Create: `test/control-tower-automation-api.test.ts`
- Create: `test/mcp-control-tower-automation.test.ts`

**Interfaces:**
- Produces: project-scoped REST CRUD/read-back and equivalent MCP structured content; one runtime automation worker loop.
- Consumes: domain services only; no business logic in route or MCP files.

- [ ] **Step 1: Write failing REST authorization/contract tests**

Exercise capabilities, destinations, monitors, findings, schedules, runs, proposals and inbox. Test `pk_` denial, correct `sk_`, wrong-project `sk_`, organization `pt_`, member denial where hosted role data exists, strict body validation, tenant isolation and prohibited-field serialization.

- [ ] **Step 2: Verify REST RED**

Run: `pnpm vitest run test/control-tower-automation-api.test.ts`. Expected: route 404 failures.

- [ ] **Step 3: Implement and register REST routes**

Pass existing `platform`, `resolveProject` and `authOwner` callbacks from `registerPlatformRoutes`; keep the shared server patch minimal. Return 201 for new revisions, 200 for idempotent replays and 409 for stale version/fingerprint conflicts.

- [ ] **Step 4: Verify REST GREEN**

Run the REST suite and confirm PASS.

- [ ] **Step 5: Write failing MCP parity tests**

Assert tools exist, map exactly to REST paths/bodies, return structured content and preserve error codes for cross-tenant/validation failures.

- [ ] **Step 6: Verify MCP RED**

Run: `pnpm vitest run test/mcp-control-tower-automation.test.ts`. Expected: missing tools.

- [ ] **Step 7: Add thin MCP tools and worker config**

Add list/create/update monitor, findings, destinations/inbox, list/create/update schedules, runs, proposal list/approve/reject. Add bounded automation worker configuration with explicit environment variables and start/stop it beside existing maintenance workers.

- [ ] **Step 8: Verify MCP/config GREEN**

Run the MCP, REST and config tests and confirm PASS.

### Task 6: Route-ready admin UI without shell ownership

**Files:**
- Create: `web/src/automation/types.ts`
- Create: `web/src/screens/Automation.tsx`
- Create: `web/src/screens/Automation.test.tsx`
- Modify: `web/src/api/types.ts` only to export automation types
- Modify: `web/src/api/client.ts` only to add typed REST methods

**Interfaces:**
- Produces: `<Automation />` route-ready screen with Monitors, Insight feed, Proposals and Notifications sections.
- Consumes: existing store/client, `Panel`, `Loading`, `RecoverableError`, shadcn controls.

- [ ] **Step 1: Write failing UI tests**

Assert real server data renders, `not_configured` external provider copy is explicit, monitor/schedule forms submit typed inputs, proposal review shows frozen payload/undo/fingerprint and never offers direct traffic execution, empty/loading/error states differ, and narrow layout has no fixed-width overflow classes.

- [ ] **Step 2: Verify UI RED**

Run: `pnpm --dir web test -- Automation.test.tsx`. Expected: missing screen.

- [ ] **Step 3: Implement the route-ready screen and typed client**

Do not edit application navigation or existing lifecycle screens. Render one primary action per section, progressive audit details, environment context, delivery/provider limitations and existing-mutation handoff after proposal approval.

- [ ] **Step 4: Verify UI GREEN**

Run the targeted UI test, web typecheck/build and inspect 1440/390 standalone harness if the route can be mounted without shell edits.

### Task 7: Full verification, compatibility and delivery

**Files:**
- Modify: `docs/09-product-decision-loop.md` with shipped capability and environment variables
- Review: all changed files and master PRD/lifecycle acceptance checklist

**Interfaces:**
- Produces: exact gate record, practical cherry-pick proof and pushed feature commit.

- [ ] **Step 1: Re-read requirements and run privacy mutation check**

Confirm persistence + REST + MCP + UI + workers + DST + tenant/privacy + human-control requirements each have evidence. Search changed payload serializers for actor/payload/property/credential/token leakage.

- [ ] **Step 2: Run targeted suites on a fresh disposable database**

Run all new backend tests and the relevant existing action/flag/release/webhook suites.

- [ ] **Step 3: Run full Core gates**

Run `pnpm typecheck`, `pnpm test`, `pnpm --dir web test`, `pnpm --dir web build`, SDK test/typecheck/build/pack, MCP pack contract and self-host Compose config. Record baseline-only topology failures separately if still reproducible on the untouched base.

- [ ] **Step 4: Verify diff and ancestry**

Run `git diff --check`, confirm forbidden files are unchanged, fetch `origin`, prove the feature commit can be cherry-picked onto `47059fd` in a disposable worktree or via `git merge-tree`, and confirm Hugeicons Pro ancestry is absent.

- [ ] **Step 5: Commit and push only**

Commit scoped files with a short Russian message, push `codex/control-tower-monitors-feed-20260811`, read back remote SHA, and do not create/merge/deploy.

## Plan self-review

- Spec coverage: persistence, CRUD/read-back, REST, MCP, admin, workers, lease/retry/idempotency, timezone/DST, privacy/tenant isolation, notifications and frozen proposals all map to tasks.
- Provider boundary: only built-in in-product/outbox behavior is claimed; external delivery remains `not_configured`.
- Human-control boundary: no worker or proposal review endpoint calls an existing traffic/deploy mutation.
- Shared hotspot boundary: only minimal route/MCP/client/type integration patches are planned; forbidden screens/navigation remain untouched.
- Placeholder scan: no TBD/TODO or unspecified provider exists.
- Type consistency: policy/schedule resources use stable heads plus revisions; jobs use mutable operational rows and immutable semantic snapshots.
