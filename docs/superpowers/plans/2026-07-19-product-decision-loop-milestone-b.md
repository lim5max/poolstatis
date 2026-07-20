# Product Decision Loop Milestone B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ship repository-owned measurement contracts, immutable release provenance, evidence-backed outcome evaluation, and human-approved decision revisions.

**Architecture:** Current contract/release state is queryable, while every mutation appends an audit revision. Evaluation executes the same typed Query DSL/source adapter used by customers, snapshots facts and trust state, and never turns insufficient evidence into a directional recommendation.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Zod, YAML, Vitest, React 19, MCP SDK.

## Global Constraints

- poolstatis.yml is a deterministic declaration; Postgres is runtime source of truth.
- Existing active contracts require explicit confirmed apply after a diff.
- Release calls are idempotent by explicit idempotency_key; redeploy uses a new key/fact.
- Observation begins at deployed_at or experiment exposure, never PR creation.
- Decisions are immutable revisions and preserve rejected agent proposals.
- keep/fix/rollback is forbidden when primary or filter trust is insufficient.

---

### Task 1: Contract and provenance schema

**Files:**
- Create: migrations/018_measurement_contracts_releases.sql
- Modify: src/schemas.ts
- Test: test/contracts-releases-schema.test.ts

**Interfaces:**
- Produces measurement_contracts, measurement_contract_revisions, releases, release_revisions.
- Produces measurementDeclarationSchema and registerReleaseSchema.

- [ ] **Step 1: Write failing schema tests**

Assert unknown direction/status/reference shapes fail, duplicate guardrails fail, minimum sample defaults to 100, baseline/observation windows are positive, and migrations enforce project-scoped keys/idempotency.

- [ ] **Step 2: Run RED**

Run: pnpm test test/contracts-releases-schema.test.ts
Expected: FAIL.

- [ ] **Step 3: Add normalized current tables plus append-only revisions**

Store contract snapshot JSON in revisions and release transition snapshots in release_revisions. A release row contains contract_key, env, repository, branch, commit_sha, pr_url, deployed_at, flag/experiment/variant, status, idempotency_key, evaluation scheduling columns.

- [ ] **Step 4: Run GREEN**

Run: pnpm test test/contracts-releases-schema.test.ts
Expected: PASS.

### Task 2: Deterministic validate/diff/apply/export

**Files:**
- Create: src/services/contracts.ts
- Modify: src/http/server.ts
- Modify: package.json
- Modify: pnpm-lock.yaml
- Test: test/contracts.test.ts

**Interfaces:**
- validateDeclaration(pool, projectId, declaration): ValidationResult.
- diffDeclaration(pool, projectId, declaration): ContractDiff.
- applyDeclaration(pool, projectId, declaration, options): ApplyResult.
- exportDeclaration(pool, projectId): string.

- [ ] **Step 1: Write failing contract tests**

Cover unknown/inactive/incompatible primary and guardrail metrics, unknown filter properties, deterministic ordering, no mutation from validate/diff, new apply, active-change confirmation, optimistic expected_revision conflict, org/project isolation, and byte-stable YAML export.

- [ ] **Step 2: Run RED**

Run: pnpm test test/contracts.test.ts
Expected: FAIL.

- [ ] **Step 3: Implement canonical declarations**

Add yaml package. Canonicalize keys, guardrails, filters, references, and nulls before hashing/diff. Compatible metrics are active count/unique_actors/value; PostHog-backed value is rejected until capability exists.

- [ ] **Step 4: Add REST routes**

Add POST contracts/validate, POST contracts/diff, POST contracts/apply, GET contracts, GET contracts/:key, GET contracts/export.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/contracts.test.ts
Expected: PASS.

### Task 3: Release registration and transitions

**Files:**
- Create: src/services/releases.ts
- Modify: src/http/server.ts
- Test: test/releases.test.ts

**Interfaces:**
- registerRelease returns existing row for the same project/env/idempotency_key and rejects a different payload.
- transitionRelease enforces planned -> deployed -> observing -> decided and cancelled from non-decided states.

- [ ] **Step 1: Write failing release tests**

Cover one-call deployed registration, retry idempotency, conflict on changed payload, same commit redeploy with new key, observing blocked by inactive/invalid contract, immutable history, and authorization/env isolation.

- [ ] **Step 2: Run RED**

Run: pnpm test test/releases.test.ts
Expected: FAIL.

- [ ] **Step 3: Implement registration/read/transition routes**

Add POST/GET releases, GET releases/:id, POST releases/:id/transition. Use deployed_at as evaluation anchor and append every transition revision.

- [ ] **Step 4: Run GREEN**

Run: pnpm test test/releases.test.ts
Expected: PASS.

### Task 4: Evidence and decision revisions

**Files:**
- Create: migrations/019_decision_evidence.sql
- Create: src/services/evaluation.ts
- Create: src/services/decisions.ts
- Modify: src/http/server.ts
- Test: test/decisions.test.ts

**Interfaces:**
- evaluateRelease(projectId, releaseId, now): EvidenceSet and proposed Decision.
- reviseDecision(projectId, decisionId, command, actor): DecisionRevision.
- Evidence includes baseline/observed values, sample, windows, metric purpose, guardrails, trust, Query DSL, source, facts, interpretation.

- [ ] **Step 1: Write failing evaluation tests**

Cover increase/decrease/stay-within-range, minimum effect, insufficient sample, untrusted property/metric, guardrail override, PostHog source, rejected proposal plus human correction, and immutable evidence.

- [ ] **Step 2: Run RED**

Run: pnpm test test/decisions.test.ts
Expected: FAIL.

- [ ] **Step 3: Implement evaluation policy**

Compute fixed baseline and observed windows from deployed_at. Facts are server-produced; interpretation is stored separately. Use keep when expected movement clears threshold and guardrails hold, rollback when meaningful primary regression is trusted, fix for trusted guardrail regression/no meaningful result, and inconclusive for any trust/sample/window blocker.

- [ ] **Step 4: Implement decision approval workflow**

Add evaluate route; list/get decision routes; approve/edit/reject routes. Record actor identity and exact prior/proposed/accepted content in decision_revisions.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/decisions.test.ts
Expected: PASS.

### Task 5: MCP and admin decision loop

**Files:**
- Modify: src/mcp/server.ts
- Modify: web/src/api/types.ts
- Modify: web/src/api/client.ts
- Create: web/src/screens/Changes.tsx
- Create: web/src/screens/Decisions.tsx
- Modify: web/src/screens/Measurement.tsx
- Modify: web/src/App.tsx
- Test: test/mcp-decision-loop-b.test.ts

**Interfaces:**
- MCP tools: validate/diff/apply/export_measurement_contracts, register/list/get_release, evaluate_release, list/get/approve/reject_decision.
- Admin shows expected outcome, observed result, trust, requested decision, and post-approval effect in that order.

- [ ] **Step 1: Write failing MCP tests**

Exercise the full contract -> release -> evaluation -> approval loop and compare MCP read-back to REST.

- [ ] **Step 2: Run RED**

Run: pnpm test test/mcp-decision-loop-b.test.ts
Expected: FAIL.

- [ ] **Step 3: Register MCP tools**

Apply accepts confirm_existing_changes and expected_revision; approval tools require an explicit rationale and never execute actions.

- [ ] **Step 4: Build Measurement, Changes, Decisions screens**

Use audit cards/tables, plain product language, reproducible Query DSL disclosure, and revision history. Do not build a dashboard/chart editor.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/mcp-decision-loop-b.test.ts && pnpm --dir web build
Expected: PASS and build exit 0.

### Task 6: Milestone B native/PostHog E2E

**Files:**
- Create: test/e2e/decision-loop-b.test.ts
- Modify: docs/09-product-decision-loop.md
- Modify: docs/04-http-api.md

- [ ] **Step 1: Write two full-source scenarios**

Each scenario must read back contract, release, source evidence, reproducible query, decision, human approval, and onboarding completion. The PostHog scenario asserts zero imported raw events.

- [ ] **Step 2: Run E2E**

Run: pnpm test test/e2e/decision-loop-b.test.ts
Expected: PASS for native and controlled PostHog.

- [ ] **Step 3: Update docs**

Add poolstatis.yml example, CI release call, evaluation policy, trust blockers, and approval semantics.

- [ ] **Step 4: Run Milestone B gate**

Run: pnpm typecheck && pnpm test && pnpm --dir sdk test && pnpm --dir sdk build && pnpm --dir web build
Expected: all commands exit 0.
