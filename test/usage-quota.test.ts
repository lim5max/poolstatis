import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { createApiKey, createProject } from '../src/services/projects.js';
import type { TenantRateLimitOptions } from '../src/services/rateLimiter.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false });
  await env.pool.query(
    `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit, warning_thresholds)
     SELECT org_id, 'events_stored', 3, ARRAY[2]::bigint[] FROM projects WHERE id = $1`,
    [env.projectId],
  );
});
afterAll(() => env.close());

describe('generic hard quota', () => {
  it('rejects an entire batch with 402 before inserting any event when it would exceed the organization limit', async () => {
    const first = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'quota-first', events: [{ event: 'quota.event', distinct_id: 'one' }, { event: 'quota.event', distinct_id: 'two' }],
    });
    expect(first.status).toBe(200);
    expect(first.body.warnings).toEqual([{ meter: 'events_stored', threshold: 2, quantity: 2 }]);
    const usage = await api(env, env.personalToken, 'GET', `/api/v1/me/usage?period=${new Date().toISOString().slice(0, 7)}`);
    expect(usage.body.warnings).toEqual([{ threshold: 2, quantity: 2 }]);
    const blocked = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'quota-over-limit', events: [{ event: 'quota.event', distinct_id: 'three' }, { event: 'quota.event', distinct_id: 'four' }],
    });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('billing_limit_reached');
    const stored = await env.pool.query(`SELECT count(*)::int AS count FROM events WHERE project_id = $1 AND event = 'quota.event'`, [env.projectId]);
    expect(stored.rows[0].count).toBe(2);
  });

  it('serializes parallel batches so they cannot overshoot the organization limit', async () => {
    await env.pool.query(`UPDATE organization_entitlements SET hard_limit = 4 WHERE org_id = (SELECT org_id FROM projects WHERE id = $1)`, [env.projectId]);
    const [left, right] = await Promise.all([
      api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'quota-parallel-left', events: [{ event: 'quota.event', distinct_id: 'left' }, { event: 'quota.event', distinct_id: 'left-2' }] }),
      api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'quota-parallel-right', events: [{ event: 'quota.event', distinct_id: 'right' }, { event: 'quota.event', distinct_id: 'right-2' }] }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 402]);
    const usage = await env.pool.query<{ quantity: string }>(
      `SELECT quantity FROM organization_usage WHERE org_id = (SELECT org_id FROM projects WHERE id = $1) AND meter_key = 'events_stored'`, [env.projectId],
    );
    expect(Number(usage.rows[0]?.quantity)).toBe(4);
  });

  it('serializes same-organization batches from different projects against one hard limit', async () => {
    const orgId = (await env.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [env.projectId])).rows[0]!.org_id;
    const project = await createProject(env.pool, orgId, `quota-other-${Date.now()}`, 'Other quota project');
    const token = (await createApiKey(env.pool, { orgId, projectId: project.id, kind: 'ingest' })).token;
    await env.pool.query(`UPDATE organization_entitlements SET hard_limit = 6 WHERE org_id = $1`, [orgId]);
    const [left, right] = await Promise.all([
      api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'quota-cross-project-left', events: [{ event: 'quota.event', distinct_id: 'left-a' }, { event: 'quota.event', distinct_id: 'left-b' }] }),
      api(env, token, 'POST', '/i/v1/events', { batch_id: 'quota-cross-project-right', events: [{ event: 'quota.event', distinct_id: 'right-a' }, { event: 'quota.event', distinct_id: 'right-b' }] }),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 402]);
  });

  it('keeps usage reads scoped to the authenticated organization', async () => {
    const foreign = await createTestEnv({ ingestBuffer: false });
    try {
      const result = await api(foreign, foreign.personalToken, 'GET', `/api/v1/me/usage?period=${new Date().toISOString().slice(0, 7)}&org_id=ignored`);
      expect(result.status).toBe(200);
      expect(result.body.quantity).toBe(0);
      expect(result.body.projects).toEqual([]);
    } finally {
      await foreign.close();
    }
  });

  it('rejects project-scoped secret credentials from the organization usage read', async () => {
    const secret = await api(env, env.secretToken, 'GET', `/api/v1/me/usage?period=${new Date().toISOString().slice(0, 7)}`);
    expect(secret.status).toBe(403);
  });

  it('does not meter an ingest request rejected with 429 before storage', async () => {
    const limits: TenantRateLimitOptions = {
      ingest: { key: { ratePerSecond: 0.001, burst: 1 }, project: { ratePerSecond: 0.001, burst: 1 } },
      api: { key: { ratePerSecond: 1, burst: 10 }, project: { ratePerSecond: 1, burst: 10 } },
      maxEntries: 20, maxEntriesPerTenant: 20, idleTtlMs: 60_000,
    };
    const limited = await createTestEnv({ ingestBuffer: false, rateLimit: limits });
    try {
      expect((await api(limited, limited.ingestToken, 'POST', '/i/v1/events', { events: [{ event: 'first', distinct_id: 'one' }] })).status).toBe(200);
      expect((await api(limited, limited.ingestToken, 'POST', '/i/v1/events', { events: [{ event: 'second', distinct_id: 'two' }] })).status).toBe(429);
      const usage = await api(limited, limited.personalToken, 'GET', `/api/v1/me/usage?period=${new Date().toISOString().slice(0, 7)}`);
      expect(usage.body.quantity).toBe(1);
    } finally {
      await limited.close();
    }
  });
});
