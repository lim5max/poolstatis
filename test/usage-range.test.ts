import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../src/services/projects.js';
import { api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false });
});

afterAll(() => env.close());

async function waitForRangeLedgerRead(pool: TestEnv['pool']): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND query LIKE '%sum(l.quantity)::bigint::text AS quantity%'
           AND query LIKE '%FROM usage_ledger l%'
       ) AS waiting`,
    );
    if (waiting.rows[0]?.waiting) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('usage range did not wait for the retained ledger read');
}

describe('organization usage month ranges', () => {
  it('keeps the legacy single-month contract unchanged', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const response = await api(env, env.personalToken, 'GET', `/api/v1/me/usage?period=${period}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      meter: 'events_stored',
      period,
      quantity: expect.any(Number),
      projects: expect.any(Array),
    }));
    expect(response.body).not.toHaveProperty('periods');
  });

  it('returns an inclusive bounded UTC-month series with retained breakdown and unattributed totals', async () => {
    const orgId = (await env.pool.query<{ org_id: string }>(
      'SELECT org_id::text FROM projects WHERE id = $1',
      [env.projectId],
    )).rows[0]!.org_id;
    const deleted = await createProject(env.pool, orgId, `deleted-usage-${Date.now()}`, 'Deleted usage project');

    await env.pool.query(
      `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity) VALUES
         ($1, 'events_stored', '2024-01-01', 10),
         ($1, 'events_stored', '2024-03-01', 7)`,
      [orgId],
    );
    await env.pool.query(
      `INSERT INTO usage_ledger (
         org_id, project_id, env, meter_key, period_start, quantity, source_batch, dedupe_key
       ) VALUES
         ($1, $2, 'prod', 'events_stored', '2024-01-01', 6, 'range-jan-prod', 'range-jan-prod'),
         ($1, $2, 'staging', 'events_stored', '2024-01-01', 4, 'range-jan-staging', 'range-jan-staging'),
         ($1, $2, 'prod', 'events_stored', '2024-03-01', 5, 'range-mar-prod', 'range-mar-prod'),
         ($1, $3, 'prod', 'events_stored', '2024-03-01', 2, 'range-mar-deleted', 'range-mar-deleted')`,
      [orgId, env.projectId, deleted.id],
    );
    await env.pool.query(
      `INSERT INTO usage_warnings (org_id, meter_key, period_start, threshold, quantity)
       VALUES ($1, 'events_stored', '2024-01-01', 5, 10)`,
      [orgId],
    );
    await env.pool.query(
      `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit, warning_thresholds)
       VALUES ($1, 'events_stored', 500, ARRAY[100, 400]::bigint[])`,
      [orgId],
    );
    await env.pool.query('DELETE FROM projects WHERE id = $1', [deleted.id]);

    const response = await api(env, env.personalToken, 'GET', '/api/v1/me/usage/range?from=2024-01&to=2024-03');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      meter: 'events_stored',
      from: '2024-01',
      to: '2024-03',
      timezone: 'UTC',
      granularity: 'month',
      usage_basis: 'ingest_time',
      quantity: '17',
      current_entitlement: {
        period: new Date().toISOString().slice(0, 7),
        hard_limit: 500,
        warning_thresholds: [100, 400],
        basis: 'current_configuration',
      },
      periods: [
        {
          period: '2024-01', quantity: '10', unattributed_quantity: '0',
          warnings: [{ threshold: 5, quantity: 10 }],
          projects: [{
            id: env.projectId, slug: env.projectSlug, name: env.projectSlug, quantity: '10',
            environments: [{ env: 'prod', quantity: '6' }, { env: 'staging', quantity: '4' }],
          }],
        },
        { period: '2024-02', quantity: '0', unattributed_quantity: '0', warnings: [], projects: [] },
        {
          period: '2024-03', quantity: '7', unattributed_quantity: '2', warnings: [],
          projects: [{
            id: env.projectId, slug: env.projectSlug, name: env.projectSlug, quantity: '5',
            environments: [{ env: 'prod', quantity: '5' }],
          }],
        },
      ],
    });
  });

  it.each([
    ['/api/v1/me/usage/range', 'both range bounds are required'],
    ['/api/v1/me/usage/range?from=2024-1&to=2024-02', 'strict month format'],
    ['/api/v1/me/usage/range?from=0000-01&to=0000-02', 'unsupported year zero'],
    ['/api/v1/me/usage/range?from=2024-03&to=2024-02', 'reversed range'],
    ['/api/v1/me/usage/range?from=2024-01&to=2025-01', 'more than twelve months'],
  ])('rejects invalid month range: %s (%s)', async (url) => {
    const response = await api(env, env.personalToken, 'GET', url);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_query_param');
  });

  it('keeps a multi-month total exact beyond JavaScript safe integer precision', async () => {
    const isolated = await createTestEnv({ ingestBuffer: false });
    try {
      const orgId = (await isolated.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM projects WHERE id = $1',
        [isolated.projectId],
      )).rows[0]!.org_id;
      await isolated.pool.query(
        `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity) VALUES
           ($1, 'events_stored', '2023-01-01', 9007199254740991),
           ($1, 'events_stored', '2023-02-01', 9007199254740991)`,
        [orgId],
      );

      const response = await api(
        isolated,
        isolated.personalToken,
        'GET',
        '/api/v1/me/usage/range?from=2023-01&to=2023-02',
      );

      expect(response.status).toBe(200);
      expect(response.body.quantity).toBe('18014398509481982');
      expect(response.body.periods.map((period: { quantity: string }) => period.quantity)).toEqual([
        '9007199254740991', '9007199254740991',
      ]);
    } finally {
      await isolated.close();
    }
  });

  it('reads projection and ledger from one repeatable snapshot during concurrent ingest', async () => {
    const isolated = await createTestEnv({ ingestBuffer: false });
    const blocker = await isolated.pool.connect();
    const writer = await isolated.pool.connect();
    try {
      const orgId = (await isolated.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM projects WHERE id = $1',
        [isolated.projectId],
      )).rows[0]!.org_id;

      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE usage_ledger IN ACCESS EXCLUSIVE MODE');

      await writer.query('BEGIN');
      await writer.query(
        `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity)
         VALUES ($1, 'events_stored', '2022-09-01', 1)`,
        [orgId],
      );
      const writerLock = writer.query('LOCK TABLE usage_ledger IN ACCESS EXCLUSIVE MODE');
      await new Promise<void>((resolve) => setImmediate(resolve));

      const responsePromise = api(
        isolated,
        isolated.personalToken,
        'GET',
        '/api/v1/me/usage/range?from=2022-09&to=2022-09',
      );
      await waitForRangeLedgerRead(isolated.pool);

      await blocker.query('COMMIT');
      await writerLock;
      await writer.query(
        `INSERT INTO usage_ledger (
           org_id, project_id, env, meter_key, period_start, quantity, source_batch, dedupe_key
         ) VALUES ($1, $2, 'prod', 'events_stored', '2022-09-01', 1, 'range-snapshot', 'range-snapshot')`,
        [orgId, isolated.projectId],
      );
      await writer.query('COMMIT');

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(response.body.quantity).toBe('0');
      expect(response.body.periods).toEqual([{
        period: '2022-09', quantity: '0', unattributed_quantity: '0', warnings: [], projects: [],
      }]);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {});
      await writer.query('ROLLBACK').catch(() => {});
      blocker.release();
      writer.release();
      await isolated.close();
    }
  });

  it('keeps month-range reads organization-scoped and rejects project secret keys', async () => {
    const foreign = await createTestEnv({ ingestBuffer: false });
    try {
      const scoped = await api(
        foreign,
        foreign.personalToken,
        'GET',
        '/api/v1/me/usage/range?from=2024-01&to=2024-03&org_id=ignored',
      );
      expect(scoped.status).toBe(200);
      expect(scoped.body.quantity).toBe('0');
      expect(scoped.body.periods.every((period: { projects: unknown[] }) => period.projects.length === 0)).toBe(true);

      const forbidden = await api(env, env.secretToken, 'GET', '/api/v1/me/usage/range?from=2024-01&to=2024-03');
      expect(forbidden.status).toBe(403);
    } finally {
      await foreign.close();
    }
  });
});
