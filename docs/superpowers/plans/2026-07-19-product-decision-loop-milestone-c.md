# Product Decision Loop Milestone C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ship continuous monitoring, bounded root-cause hypotheses, approval-gated actions, a decision inbox/webhook outbox, and project-scoped decision memory.

**Architecture:** Bounded workers claim rows with database locks and persist idempotency keys before external work. Explanations compare only registered metrics and trusted properties. Actions are prepared records; external writes and flag rollback require a separately authenticated approval.

**Tech Stack:** TypeScript, Fastify, PostgreSQL workers, Zod, Vitest, React 19, MCP SDK.

## Global Constraints

- No automatic code change, merge, production rollout, or rollback.
- Correlation is labelled hypothesis and never causality.
- Workers are bounded, restart-safe, retryable, and deduplicated.
- Notifications contain product impact and sanitized evidence, never secrets/raw personal events.
- History is project-scoped and stale definitions are labelled.

---

### Task 1: Monitoring and evaluation attempts

**Files:**
- Create: migrations/020_decision_workers.sql
- Create: src/services/releaseMonitor.ts
- Modify: src/config.ts
- Modify: src/cli/serve.ts
- Test: test/release-monitor.test.ts

**Interfaces:**
- ReleaseMonitor.runOnce(now): MonitorRunResult.
- evaluation_attempts records ready/waiting/failed/succeeded, evidence window, next attempt, error code.

- [ ] **Step 1: Write failing worker tests**

Cover ready release once, waiting reason, time/sample readiness, fixed and relative thresholds, guardrail override, restart dedupe, SKIP LOCKED concurrency, bounded batch, and exponential capped retry.

- [ ] **Step 2: Run RED**

Run: pnpm test test/release-monitor.test.ts
Expected: FAIL.

- [ ] **Step 3: Implement bounded monitor**

Claim due deployed/observing releases in a transaction, evaluate outside the claim transaction using a durable attempt id, persist result idempotently by release/evidence-window hash, and schedule the next evaluation.

- [ ] **Step 4: Wire serve configuration**

Add enabled, intervalMs, batchSize, maxAttempts, baseRetryMs, maxRetryMs. Shutdown clears timer and waits for the current bounded run.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/release-monitor.test.ts
Expected: PASS.

### Task 2: Root-cause candidates

**Files:**
- Create: src/services/explanations.ts
- Modify: src/http/server.ts
- Test: test/explanations.test.ts

**Interfaces:**
- explainDecision(projectId, decisionId): Explanation.
- Candidate contains metric/property key, measured movement, score, strength, why_considered, supporting Query DSL, and interpretation label hypothesis.

- [ ] **Step 1: Write failing explanation tests**

Assert only active registered metrics/trusted properties are considered; purpose/category/tags/time/sample constrain candidates; low evidence is weak/omitted; reruns are deterministic; supporting queries are executable; raw unregistered event names never appear.

- [ ] **Step 2: Run RED**

Run: pnpm test test/explanations.test.ts
Expected: FAIL.

- [ ] **Step 3: Implement deterministic ranking**

Compare candidate baseline/observed movement with the primary movement. Score shared tags/category, temporal availability, sample, and normalized movement similarity. Sort by score then stable key. For trusted target properties, use bounded breakdown queries.

- [ ] **Step 4: Add explain route and persisted explanation snapshot**

Add POST decisions/:id/explain and GET decisions/:id/explanations. Persist exact candidates and supporting queries so historical ranking is auditable.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/explanations.test.ts
Expected: PASS.

### Task 3: Prepared and approved actions

**Files:**
- Create: src/services/actions.ts
- Modify: src/http/server.ts
- Test: test/decision-actions.test.ts

**Interfaces:**
- prepareAction creates status prepared with evidence, target, expected_effect, undo.
- approveAction records approver and exact payload, then executes only supported action types idempotently.

- [ ] **Step 1: Write failing approval-boundary tests**

Cover no execution from analysis/prepare, exact actor/payload approval audit, feature-flag rollback only after approval, schedule-observation idempotency, draft prompt readiness, unsupported GitHub action capability error, failed retry, and follow-up release backlink.

- [ ] **Step 2: Run RED**

Run: pnpm test test/decision-actions.test.ts
Expected: FAIL.

- [ ] **Step 3: Implement action records and executors**

Support draft_implementation_prompt, prepare_flag_rollback, schedule_observation, request_more_data, generic_webhook. Represent create_issue/open_draft_pr as prepared but capability_unsupported until an integration is configured. Use a unique idempotency key and append action audit entries.

- [ ] **Step 4: Add REST routes**

Add list/get/prepare/approve/reject/retry. Approve requires an explicit confirmation fingerprint returned by prepare so payload drift cannot execute.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/decision-actions.test.ts test/flags-experiments.test.ts
Expected: PASS.

### Task 4: Webhook outbox and decision inbox

**Files:**
- Create: src/services/webhooks.ts
- Modify: src/config.ts
- Modify: src/cli/serve.ts
- Modify: src/http/server.ts
- Test: test/webhook-outbox.test.ts

**Interfaces:**
- WebhookOutbox.runOnce(now): DeliveryRunResult.
- Inbox states: needs_attention, waiting_for_data, approved, rejected, resolved.

- [ ] **Step 1: Write failing outbox tests**

Cover encrypted destination, sanitized payload, impact-first content, idempotency header, bounded retries/backoff, restart dedupe, visible delivery state, no token/raw event properties, and inbox state transitions.

- [ ] **Step 2: Run RED**

Run: pnpm test test/webhook-outbox.test.ts
Expected: FAIL.

- [ ] **Step 3: Implement destination/outbox/delivery**

Persist outbox before HTTP. Claim with SKIP LOCKED, enforce HTTPS/loopback HTTP, cap payload/response, and mark success before allowing another delivery. Store masked destination and sanitized error only.

- [ ] **Step 4: Add inbox and webhook routes**

Add configure/status/test destination, GET decision-inbox, GET webhook deliveries. Test delivery is explicit and uses a distinct idempotency key.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/webhook-outbox.test.ts
Expected: PASS.

### Task 5: Decision memory

**Files:**
- Create: src/services/decisionMemory.ts
- Modify: src/http/server.ts
- Test: test/decision-memory.test.ts

**Interfaces:**
- searchDecisionHistory(projectId, filters): DecisionHistoryResult.
- similarPastChanges(projectId, declaration): SimilarChange[].

- [ ] **Step 1: Write failing memory tests**

Search by metric, feature tag, owner, status, and time; enforce project scope; preserve proposal/human disagreement; rank shared primary/guardrail/tags; label stale when metric revision or contract fingerprint differs.

- [ ] **Step 2: Run RED**

Run: pnpm test test/decision-memory.test.ts
Expected: FAIL.

- [ ] **Step 3: Implement bounded indexed search**

Use contract/release/decision/evidence joins with explicit filters and limit/cursor. Similarity is deterministic project-local metadata matching; no cross-customer inference.

- [ ] **Step 4: Add search and similar routes**

Add GET decisions/search and POST contracts/similar. Return evidence quality and stale-context reasons.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/decision-memory.test.ts
Expected: PASS.

### Task 6: MCP/admin continuous loop

**Files:**
- Modify: src/mcp/server.ts
- Modify: web/src/api/types.ts
- Modify: web/src/api/client.ts
- Modify: web/src/screens/Changes.tsx
- Modify: web/src/screens/Decisions.tsx
- Modify: web/src/App.tsx
- Test: test/mcp-decision-loop-c.test.ts

**Interfaces:**
- MCP tools: explain_outcome, prepare/approve_action, get_decision_inbox, configure/verify_webhook, search_decision_history, find_similar_changes.

- [ ] **Step 1: Write failing MCP parity tests**

Assert tool reads equal REST, read-only explain does not create/execute actions, approvals identify token/user, and search stays project-scoped.

- [ ] **Step 2: Run RED**

Run: pnpm test test/mcp-decision-loop-c.test.ts
Expected: FAIL.

- [ ] **Step 3: Add tools and typed API client**

Tool descriptions lead with product outcome and explicitly distinguish measured facts, correlation, and interpretation.

- [ ] **Step 4: Build inbox/action/history UI**

Decision cards lead with impact and requested choice. Show waiting blockers, delivery retries, explanation strength, action undo, and proposal-vs-human history.

- [ ] **Step 5: Run GREEN**

Run: pnpm test test/mcp-decision-loop-c.test.ts && pnpm --dir web build
Expected: PASS and build exit 0.

### Task 7: Full P0/P1 E2E, browser proof, and operations docs

**Files:**
- Create: test/e2e/decision-loop-c.test.ts
- Modify: docs/09-product-decision-loop.md
- Modify: docs/04-http-api.md
- Modify: README.md

- [ ] **Step 1: Write continuous-loop E2E**

Register a ready release, run monitor twice, assert one evidence/decision, explain it, prepare/approve an action, deliver one webhook, and find the result through history. Repeat a PostHog-backed observation without importing raw events.

- [ ] **Step 2: Run E2E**

Run: pnpm test test/e2e/decision-loop-c.test.ts
Expected: PASS.

- [ ] **Step 3: Verify browser admin**

Run API and web locally, open Setup/Measurement/Changes/Decisions at desktop and mobile widths, and verify contract/release/evidence/approval are visible with no console errors, clipping, or fake states.

- [ ] **Step 4: Document workers and safety**

Document configuration, retries, encryption, PostHog limits, approval boundaries, rollback behavior, and recovery commands.

- [ ] **Step 5: Run full release gate**

Run: pnpm typecheck && pnpm test && pnpm --dir sdk test && pnpm --dir sdk build && pnpm --dir web build
Expected: all commands exit 0.

- [ ] **Step 6: Perform independent read-only review**

Review each milestone diff against the PRD, resolve all Critical/Important findings, rerun the full release gate, and record remaining non-blocking risks.
