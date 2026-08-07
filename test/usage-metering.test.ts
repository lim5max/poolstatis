import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresEventStore } from '../src/stores/postgresEventStore.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';
import { createProject } from '../src/services/projects.js';
import { getOrganizationUsageActivity } from '../src/services/usage.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false });
  await activeMetric(env, { key: 'metered_event', source: { event: 'metered.event' } });
});
afterAll(() => env.close());

describe('accepted-event metering', () => {
  it('meters only durable native, unregistered, clock-skewed, and Browser Experience events by UTC ingest month', async () => {
    const native = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'metered-native-mixed',
      events: [
        { event: 'metered.event', distinct_id: 'registered' },
        { event: 'wild.event', distinct_id: 'unregistered' },
        { event: 'metered.event', distinct_id: 'clock-skewed', timestamp: new Date(Date.now() + 60 * 60_000).toISOString() },
        { event: 'BadName!!', distinct_id: 'rejected' },
      ],
    });
    expect(native.status).toBe(207);
    expect(native.body.accepted).toBe(3);

    const created = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/experience/surfaces`, {
      key: 'checkout', name: 'Checkout', purpose: 'Measure checkout interaction friction safely.',
    });
    expect(created.status).toBe(201);
    const experience = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
      surface: 'checkout', batch_id: 'metered-browser-experience',
      events: [{ kind: 'page_viewed', distinct_id: 'browser-user', session_id: 'browser-session', route: 'checkout', sequence: 1 }],
    });
    expect(experience.status).toBe(200);
    expect(experience.body.accepted).toBe(1);

    await new PostgresEventStore(env.pool).append([{
      projectId: env.projectId, env: 'prod', event: '$feature_flag_called', timestamp: new Date(),
      distinctId: 'system-user', sessionId: null, properties: {}, registered: true, isSystem: true,
    }, {
      projectId: env.projectId, env: 'prod', event: 'system.maintenance', timestamp: new Date(),
      distinctId: 'system-source-user', sessionId: null, properties: {}, registered: true, eventSource: 'system',
    }]);

    const month = new Date().toISOString().slice(0, 7);
    const usage = await api(env, env.personalToken, 'GET', `/api/v1/me/usage?period=${month}`);
    expect(usage.status).toBe(200);
    expect(usage.body).toEqual(expect.objectContaining({
      meter: 'events_stored', period: month, quantity: 4,
      projects: [expect.objectContaining({ slug: env.projectSlug, environments: [expect.objectContaining({ env: 'prod', quantity: 4 })] })],
    }));
    const today = new Date().toISOString().slice(0, 10);
    const activity = await api(env, env.personalToken, 'GET', `/api/v1/me/usage/activity?date_from=${today}&date_to=${today}`);
    expect(activity.status).toBe(200);
    expect(activity.body).toEqual(expect.objectContaining({
      meter: 'events_stored', date_from: today, date_to: today, quantity: '4',
      source: 'usage_ledger', timezone: 'UTC',
      projects: [expect.objectContaining({ slug: env.projectSlug, environments: [expect.objectContaining({ env: 'prod', quantity: '4' })] })],
    }));
    const reversedRange = await api(env, env.personalToken, 'GET', `/api/v1/me/usage/activity?date_from=${today}&date_to=2026-01-01`);
    expect(reversedRange.status).toBe(400);
    expect(reversedRange.body.error.code).toBe('invalid_query_param');
    const missingDate = await api(env, env.personalToken, 'GET', `/api/v1/me/usage/activity?date_from=${today}`);
    expect(missingDate.status).toBe(400);
    const impossibleDate = await api(env, env.personalToken, 'GET', '/api/v1/me/usage/activity?date_from=2026-02-30&date_to=2026-03-01');
    expect(impossibleDate.status).toBe(400);
    const yearZero = await api(env, env.personalToken, 'GET', '/api/v1/me/usage/activity?date_from=0000-01-01&date_to=0000-01-01');
    expect(yearZero.status).toBe(400);
    const day = 86_400_000;
    const todayMs = Date.parse(`${today}T00:00:00.000Z`);
    const ninetyThreeDaysAgo = new Date(todayMs - (92 * day)).toISOString().slice(0, 10);
    const ninetyFourDaysAgo = new Date(todayMs - (93 * day)).toISOString().slice(0, 10);
    expect((await api(env, env.personalToken, 'GET', `/api/v1/me/usage/activity?date_from=${ninetyThreeDaysAgo}&date_to=${today}`)).status).toBe(200);
    expect((await api(env, env.personalToken, 'GET', `/api/v1/me/usage/activity?date_from=${ninetyFourDaysAgo}&date_to=${today}`)).status).toBe(400);
    const invalidPeriod = await api(env, env.personalToken, 'GET', '/api/v1/me/usage?period=2026-7');
    expect(invalidPeriod.status).toBe(400);
    expect(invalidPeriod.body.error.code).toBe('invalid_query_param');

    const replay = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'metered-native-mixed', events: [{ event: 'metered.event', distinct_id: 'registered' }],
    });
    expect(replay.body).toEqual({ accepted: 0, unregistered: 0, duplicate: true });
    const afterReplay = await api(env, env.personalToken, 'GET', `/api/v1/me/usage?period=${month}`);
    expect(afterReplay.body.quantity).toBe(4);
  });

  it('keeps usage ledger facts immutable at the database boundary', async () => {
    const row = await env.pool.query<{ id: string }>(
      `SELECT id FROM usage_ledger WHERE project_id = $1 ORDER BY ingested_at LIMIT 1`, [env.projectId],
    );
    await expect(env.pool.query('UPDATE usage_ledger SET quantity = 99 WHERE id = $1', [row.rows[0]?.id])).rejects.toThrow();
    await expect(env.pool.query('DELETE FROM usage_ledger WHERE id = $1', [row.rows[0]?.id])).rejects.toThrow();
  });

  it('bounds activity by the existing organization-period index prefix', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await getOrganizationUsageActivity(
      { query } as never,
      '11111111-1111-4111-8111-111111111111',
      '2026-01-31',
      '2026-02-01',
    );
    expect(query.mock.calls[0]?.[0]).toContain("l.period_start >= date_trunc('month', $2::date)::date");
    expect(query.mock.calls[0]?.[0]).toContain("l.period_start <= date_trunc('month', $3::date)::date");
  });

  it('cannot write a ledger fact whose organization and project belong to different tenants', async () => {
    const foreign = await createTestEnv({ ingestBuffer: false });
    try {
      const org = (await env.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [env.projectId])).rows[0]!.org_id;
      await expect(env.pool.query(
        `INSERT INTO usage_ledger (org_id, project_id, env, meter_key, period_start, quantity, source_batch, dedupe_key)
         VALUES ($1, $2, 'prod', 'events_stored', date_trunc('month', now())::date, 1, 'bad', 'bad')`,
        [org, foreign.projectId],
      )).rejects.toThrow();
    } finally {
      await foreign.close();
    }
  });

  it('keeps raw multi-project append all-or-nothing when a later ledger write fails', async () => {
    const org = (await env.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [env.projectId])).rows[0]!.org_id;
    const other = await createProject(env.pool, org, `other-${Date.now()}`, 'Other');
    const [first, second] = [env.projectId, other.id].sort();
    await env.pool.query(`
      CREATE OR REPLACE FUNCTION fail_second_usage_ledger_insert() RETURNS trigger AS $$
      BEGIN IF NEW.project_id = '${second}'::uuid THEN RAISE EXCEPTION 'second ledger fails'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER usage_ledger_second_failure BEFORE INSERT ON usage_ledger
      FOR EACH ROW EXECUTE FUNCTION fail_second_usage_ledger_insert();
    `);
    try {
      await expect(new PostgresEventStore(env.pool).append([
        { projectId: first, env: 'prod', event: 'raw.first', timestamp: new Date(), distinctId: 'first', sessionId: null, properties: {}, registered: false },
        { projectId: second, env: 'prod', event: 'raw.second', timestamp: new Date(), distinctId: 'second', sessionId: null, properties: {}, registered: false },
      ])).rejects.toThrow('second ledger fails');
      const stored = await env.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM events WHERE project_id IN ($1, $2) AND event IN ('raw.first', 'raw.second')`, [first, second],
      );
      expect(stored.rows[0].count).toBe(0);
    } finally {
      await env.pool.query('DROP TRIGGER IF EXISTS usage_ledger_second_failure ON usage_ledger; DROP FUNCTION IF EXISTS fail_second_usage_ledger_insert();');
    }
  });

  it('keeps the projection equal to the immutable ledger sum', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const projection = await env.pool.query<{ quantity: string }>(
      `SELECT quantity FROM organization_usage WHERE org_id = (SELECT org_id FROM projects WHERE id = $1) AND meter_key = 'events_stored' AND period_start = $2::date`,
      [env.projectId, `${period}-01`],
    );
    const ledger = await env.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::bigint AS quantity FROM usage_ledger WHERE org_id = (SELECT org_id FROM projects WHERE id = $1) AND meter_key = 'events_stored' AND period_start = $2::date`,
      [env.projectId, `${period}-01`],
    );
    expect(projection.rows[0]?.quantity).toBe(ledger.rows[0]?.quantity);
  });

  it('does not meter entity writes or platform query reads', async () => {
    const period = new Date().toISOString().slice(0, 7);
    const before = await api(env, env.personalToken, 'GET', `/api/v1/me/usage?period=${period}`);
    const type = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/entity-types`, {
      name: 'account', description: 'A customer account state for metering exclusion.',
    });
    expect(type.status).toBe(201);
    const entity = await api(env, env.ingestToken, 'POST', '/i/v1/entities', {
      entities: [{ entity_type: 'account', entity_id: 'entity-only', properties: { plan: 'free' } }],
    });
    expect(entity.status).toBe(200);
    const query = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/query`, {
      kind: 'trend', metric: 'metered_event', date_from: '-1d', env: 'prod',
    });
    expect(query.status).toBe(200);
    const after = await api(env, env.personalToken, 'GET', `/api/v1/me/usage?period=${period}`);
    expect(after.body.quantity).toBe(before.body.quantity);
  });

  it('does not meter batches rejected by buffered 413 admission', async () => {
    const constrained = await createTestEnv({
      ingestBuffer: { maxEvents: 1, maxDelayMs: 10, maxPendingEvents: 1, maxConcurrentIdempotentAppends: 1 },
    });
    try {
      const rejected = await api(constrained, constrained.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'too-large-before-storage',
        events: [{ event: 'one', distinct_id: 'one' }, { event: 'two', distinct_id: 'two' }],
      });
      expect(rejected.status).toBe(413);
      const usage = await api(constrained, constrained.personalToken, 'GET', `/api/v1/me/usage?period=${new Date().toISOString().slice(0, 7)}`);
      expect(usage.body.quantity).toBe(0);
    } finally {
      await constrained.close();
    }
  });

  it('does not double-meter Browser Experience duplicates and reclaims its batch id only after 35 days', async () => {
    const payload = {
      surface: 'checkout', batch_id: 'experience-35-day-horizon',
      events: [{ kind: 'page_viewed', distinct_id: 'experience-horizon', session_id: 'experience-session', route: 'checkout', sequence: 1 }],
    };
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', payload)).body.accepted).toBe(1);
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', payload)).body.duplicate).toBe(true);
    await env.pool.query(`UPDATE experience_batches SET received_at = now() - interval '34 days' WHERE project_id = $1 AND batch_id = $2`, [env.projectId, payload.batch_id]);
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', payload)).body.duplicate).toBe(true);
    await env.pool.query(`UPDATE experience_batches SET received_at = now() - interval '36 days' WHERE project_id = $1 AND batch_id = $2`, [env.projectId, payload.batch_id]);
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', payload)).body.accepted).toBe(1);
  });

  it('does not meter a 503 backpressure rejection while another accepted batch waits on its quota row', async () => {
    const constrained = await createTestEnv({
      ingestBuffer: { maxEvents: 1, maxDelayMs: 10, maxPendingEvents: 1, maxConcurrentIdempotentAppends: 1 },
    });
    const lock = await constrained.pool.connect();
    try {
      const orgId = (await constrained.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [constrained.projectId])).rows[0]!.org_id;
      const period = `${new Date().toISOString().slice(0, 7)}-01`;
      await lock.query('BEGIN');
      await lock.query(`INSERT INTO organization_usage (org_id, meter_key, period_start, quantity) VALUES ($1, 'events_stored', $2::date, 0) ON CONFLICT DO NOTHING`, [orgId, period]);
      await lock.query(`SELECT quantity FROM organization_usage WHERE org_id = $1 AND meter_key = 'events_stored' AND period_start = $2::date FOR UPDATE`, [orgId, period]);
      const accepted = api(constrained, constrained.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'waiting-accepted', events: [{ event: 'queued', distinct_id: 'one' }],
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const rejected = await api(constrained, constrained.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'queue-rejected', events: [{ event: 'rejected', distinct_id: 'two' }],
      });
      expect(rejected.status).toBe(503);
      await lock.query('COMMIT');
      expect((await accepted).status).toBe(200);
      const usage = await api(constrained, constrained.personalToken, 'GET', `/api/v1/me/usage?period=${period.slice(0, 7)}`);
      expect(usage.body.quantity).toBe(1);
    } finally {
      await lock.query('ROLLBACK').catch(() => {});
      lock.release();
      await constrained.close();
    }
  });

  it('rolls back events and idempotency claims when the immutable ledger write fails', async () => {
    await env.pool.query(`
      CREATE OR REPLACE FUNCTION fail_usage_ledger_insert() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced ledger failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER usage_ledger_failure BEFORE INSERT ON usage_ledger
      FOR EACH ROW EXECUTE FUNCTION fail_usage_ledger_insert();
    `);
    try {
      const failed = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'ledger-rolls-back-events', events: [{ event: 'metered.event', distinct_id: 'rollback-user' }],
      });
      expect(failed.status).toBe(500);
      const events = await env.pool.query(
        `SELECT count(*)::int AS count FROM events WHERE project_id = $1 AND distinct_id = 'rollback-user'`, [env.projectId],
      );
      expect(events.rows[0].count).toBe(0);
    } finally {
      await env.pool.query('DROP TRIGGER IF EXISTS usage_ledger_failure ON usage_ledger; DROP FUNCTION IF EXISTS fail_usage_ledger_insert();');
    }

    const retry = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'ledger-rolls-back-events', events: [{ event: 'metered.event', distinct_id: 'rollback-user' }],
    });
    expect(retry.status).toBe(200);
    expect(retry.body.accepted).toBe(1);
  });

  it('keeps completed batch IDs for at least 35 days before reclaiming them', async () => {
    const payload = { batch_id: 'metered-35-day-horizon', events: [{ event: 'metered.event', distinct_id: 'horizon-user' }] };
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/events', payload)).body.accepted).toBe(1);
    await env.pool.query(`UPDATE ingest_batches SET received_at = now() - interval '34 days' WHERE project_id = $1 AND batch_id = $2`, [env.projectId, payload.batch_id]);
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/events', payload)).body.duplicate).toBe(true);
    await env.pool.query(`UPDATE ingest_batches SET received_at = now() - interval '36 days' WHERE project_id = $1 AND batch_id = $2`, [env.projectId, payload.batch_id]);
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/events', payload)).body.accepted).toBe(1);
  });
});
