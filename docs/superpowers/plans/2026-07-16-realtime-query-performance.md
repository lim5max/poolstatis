# Real-time Query Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep repeated MCP and custom-dashboard reads fast and bounded while preserving near-real-time freshness, then measure the current Postgres ceiling before choosing ClickHouse.

**Architecture:** Retain Postgres as the current source of truth. Add a small per-process single-flight result cache with a one-second default TTL and project invalidation after writes, add purpose-built Browser Experience indexes, and ship a repeatable HTTP load smoke that reports ingest and query latency percentiles. Treat ClickHouse as a measured migration threshold, not an unverified immediate dependency.

**Tech Stack:** TypeScript, Fastify 5, PostgreSQL 17, Vitest, Poolstatis MCP over stdio.

## Global Constraints

- Preserve `EventStore` as the storage seam; no raw SQL in clients.
- Cache keys must include tenant/project and the complete parsed query.
- Cache memory must be bounded and failures must never be cached.
- Same-process successful ingest invalidates the affected project's cached reads; cross-instance staleness is bounded by TTL.
- Browser Experience remains separate from raw DOM replay.
- No git commit or push unless the user explicitly requests it.

---

### Task 1: Bounded single-flight query cache

**Files:**
- Create: `src/services/queryCache.ts`
- Create: `test/queryCache.test.ts`
- Modify: `src/services/query.ts`
- Modify: `src/http/context.ts`
- Modify: `src/http/server.ts`
- Modify: `src/config.ts`
- Modify: `src/cli/serve.ts`

**Interfaces:**
- Produces: `QueryCache.getOrLoad<T>(projectId, key, loader)`, `QueryCache.invalidateProject(projectId)`.
- Consumes: parsed `QueryInput` and the existing `QueryService` result promise.

- [ ] **Step 1: Write failing cache tests**

```ts
it('coalesces concurrent identical reads', async () => {
  let calls = 0;
  const cache = new QueryCache({ ttlMs: 1000, maxEntries: 10 });
  const load = async () => { calls += 1; return { value: 1 }; };
  expect(await Promise.all([
    cache.getOrLoad('p1', 'trend', load),
    cache.getOrLoad('p1', 'trend', load),
  ])).toEqual([{ value: 1 }, { value: 1 }]);
  expect(calls).toBe(1);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm test test/queryCache.test.ts`

Expected: FAIL because `QueryCache` does not exist.

- [ ] **Step 3: Implement bounded cache semantics**

Implement single-flight promises, TTL expiry, oldest-entry eviction, rejection cleanup, and project invalidation. Default to `ttlMs=1000`, `maxEntries=1000`; allow `QUERY_CACHE_TTL_MS` and `QUERY_CACHE_MAX_ENTRIES` overrides.

- [ ] **Step 4: Integrate at `QueryService.run` and invalidate after writes**

Use the canonical parsed query as the key. Invalidate after accepted regular ingest, Browser Experience ingest, entity changes that affect state queries, and data purge.

- [ ] **Step 5: Verify GREEN**

Run: `pnpm test test/queryCache.test.ts test/query.test.ts test/experience.test.ts`

Expected: all selected tests pass.

### Task 2: Browser Experience read indexes

**Files:**
- Create: `migrations/013_experience_query_indexes.sql`
- Create: `test/experience-indexes.test.ts`

**Interfaces:**
- Produces: click-map index on tenant/env/surface/time and session index on tenant/env/session/surface/time.
- Consumes: existing `interactionMap` and `experienceSession` SQL predicates.

- [ ] **Step 1: Write an index-plan regression test**

Seed enough typed experience events, run `ANALYZE`, disable sequential scans only inside the test transaction, and assert `EXPLAIN (FORMAT JSON)` chooses the new expression/partial indexes for both read shapes.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm test test/experience-indexes.test.ts`

Expected: FAIL because the migration indexes do not exist.

- [ ] **Step 3: Add the migration**

```sql
CREATE INDEX events_experience_click_surface_time_idx
  ON events (project_id, env, (properties->>'surface'), "timestamp" DESC)
  WHERE event_source = 'experience' AND event = 'experience.element_clicked';

CREATE INDEX events_experience_session_surface_time_idx
  ON events (project_id, env, session_id, (properties->>'surface'), "timestamp")
  WHERE event_source = 'experience';
```

- [ ] **Step 4: Verify GREEN**

Run: `pnpm test test/experience-indexes.test.ts test/experience.test.ts`

Expected: both query shapes use the intended indexes and behavior tests pass.

### Task 3: Repeatable load smoke and scale gate

**Files:**
- Create: `src/cli/loadSmoke.ts`
- Create: `test/loadSmoke.test.ts`
- Modify: `package.json`
- Modify: `docs/02-storage.md`
- Modify: `docs/05-gap-analysis.md`

**Interfaces:**
- Produces: `pnpm load:smoke` with JSON output for accepted events, error rate, ingest p50/p95/p99, query p50/p95/p99, and achieved requests/events per second.
- Consumes: `POOLSTATIS_URL`, ingest token, platform token, project slug, concurrency and duration environment variables.

- [ ] **Step 1: Write failing percentile/config tests**

Test deterministic percentile calculation, required secret redaction, bounded concurrency, and non-zero exit when error-rate or latency SLO is exceeded.

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `pnpm test test/loadSmoke.test.ts`

Expected: FAIL because the load-smoke module does not exist.

- [ ] **Step 3: Implement the HTTP harness**

Use only Node built-ins, never print tokens, generate idempotent batch ids, warm queries before measuring, and emit machine-readable JSON.

- [ ] **Step 4: Document the decision gate**

Record measured hardware/data size alongside results. Move to durable queue/workers when process restarts or sustained backpressure violate ingest SLO; add incremental rollups when raw registered-metric reads miss query SLO; evaluate ClickHouse when representative datasets still miss SLO after those steps.

- [ ] **Step 5: Run full verification**

Run: `pnpm typecheck && pnpm test && pnpm --dir sdk test && pnpm --dir sdk build && pnpm --dir web build`.
