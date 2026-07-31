import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { PostgresEventStore } from '../src/stores/postgresEventStore.js';

const runPerformance = process.env.ACTORS_PERF === '1';
let env: TestEnv;

describe.skipIf(!runPerformance)('actors large synthetic fixture', () => {
  beforeAll(async () => {
    env = await createTestEnv({ ingestBuffer: false, queryCache: false });
    await env.pool.query(
      `INSERT INTO events (
         project_id, env, event, "timestamp", distinct_id, session_id,
         properties, registered, is_system, event_source
       )
       SELECT $1, 'prod', 'activity.performed',
              '2026-07-30T00:00:00Z'::timestamptz
                - ((n % 30) || ' days')::interval
                - ((n % 86400) || ' seconds')::interval,
              'actor-' || (n % 10000),
              NULL,
              '{}'::jsonb,
              true,
              false,
              'ingest'
       FROM generate_series(1, 100000) AS n`,
      [env.projectId],
    );
    // A direct bulk INSERT bypasses normal autovacuum/analyze thresholds while
    // creating a brand-new project distribution. Refresh only this disposable
    // fixture's planner statistics before measuring the production query shape.
    await env.pool.query(
      `INSERT INTO actor_links (
         project_id, env, source_distinct_id, target_distinct_id, created_by
       )
       SELECT $1, 'prod', 'actor-' || n, 'canonical-' || n, 'synthetic-perf'
       FROM generate_series(0, 999) AS n`,
      [env.projectId],
    );
    await env.pool.query('ANALYZE events; ANALYZE actor_links;');
  }, 20_000);

  afterAll(async () => {
    await env.close();
  }, 30_000);

  it('measures the real bounded query and records the aggregate query plan', async () => {
    const started = performance.now();
    const result = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      {
        kind: 'actors',
        env: 'prod',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        limit: 100,
      },
    );
    const durationMs = Math.round(performance.now() - started);
    expect(result.status).toBe(200);
    expect(result.body.actors).toHaveLength(100);
    expect(result.body.meta.next_cursor).toEqual(expect.any(String));
    expect(durationMs).toBeLessThan(15_000);

    let explainedPlan: unknown;
    const explainPool = new Proxy(env.pool, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver);
        return async (sql: string, params: unknown[]) => {
          if (sql.includes('actor_chain(raw_id, current_id, path, depth, cycle, linked)')) {
            const explained = await env.pool.query(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
              params,
            );
            explainedPlan = explained.rows[0]?.['QUERY PLAN'];
            return { rows: [], rowCount: 0 };
          }
          return env.pool.query(sql, params);
        };
      },
    });
    await new PostgresEventStore(explainPool).actors({
      projectId: env.projectId,
      env: 'prod',
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-08-01T00:00:00.000Z'),
      snapshotIngestedAt: new Date(),
      limit: 100,
      order: 'last_seen_desc',
      trustedBrowserSessions: false,
    });
    const root = (explainedPlan as Array<{
      Plan?: {
        'Node Type'?: string;
        'Actual Total Time'?: number;
        'Actual Rows'?: number;
        'Shared Hit Blocks'?: number;
        Plans?: unknown[];
      };
      'Execution Time'?: number;
    }> | undefined)?.[0];
    expect(root?.Plan?.['Node Type']).toEqual(expect.any(String));
    expect(root?.['Execution Time']).toEqual(expect.any(Number));
    console.log(JSON.stringify({
      fixture: { events: 100000, raw_actors: 10000, active_links: 1000 },
      endpoint_duration_ms: durationMs,
      explain_execution_ms: root?.['Execution Time'] ?? null,
      plan_root: {
        node: root?.Plan?.['Node Type'] ?? null,
        actual_total_ms: root?.Plan?.['Actual Total Time'] ?? null,
        actual_rows: root?.Plan?.['Actual Rows'] ?? null,
        shared_hit_blocks: root?.Plan?.['Shared Hit Blocks'] ?? null,
      },
    }));
  }, 60_000);

  it('uses the exact-ID closure short path instead of scanning unrelated actor links', async () => {
    const started = performance.now();
    const result = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      {
        kind: 'actors',
        env: 'prod',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
        search: { kind: 'exact_id', value: 'actor-0' },
      },
    );
    const durationMs = Math.round(performance.now() - started);
    expect(result.status).toBe(200);
    expect(result.body.actors).toHaveLength(1);
    expect(result.body.actors[0].distinct_id).toBe('canonical-0');
    expect(durationMs).toBeLessThan(5_000);
    console.log(JSON.stringify({
      fixture: { events: 100000, raw_actors: 10000, active_links: 1000 },
      exact_actor_endpoint_duration_ms: durationMs,
    }));
  }, 30_000);

  it('resolves a canonical person population without per-event scalar link walks', async () => {
    const started = performance.now();
    const result = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/persons/actor-0`
        + '?env=prod'
        + '&from=2026-07-01T00%3A00%3A00.000Z'
        + '&to=2026-08-01T00%3A00%3A00.000Z',
    );
    const durationMs = Math.round(performance.now() - started);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      requested_distinct_id: 'actor-0',
      distinct_id: 'canonical-0',
      identity: {
        status: 'linked',
        raw_distinct_ids: ['actor-0'],
      },
    });
    expect(durationMs).toBeLessThan(15_000);
    console.log(JSON.stringify({
      fixture: { events: 100000, raw_actors: 10000, active_links: 1000 },
      person_endpoint_duration_ms: durationMs,
    }));
  }, 60_000);
});
