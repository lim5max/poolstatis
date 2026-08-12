import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';
import { MonitorWorker } from '../src/services/monitorWorker.js';
import { NotificationWorker } from '../src/services/notificationWorker.js';

describe('control tower project ownership', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
    await activeMetric(env, { key: 'owned_metric', source: { event: 'owned.metric', filters: [] } });
  });
  afterAll(async () => env.close());

  test('cascades immutable automation history only with its owning project', async () => {
    const destination = await api(env, env.secretToken, 'POST', path('/automation/destinations'), {
      key: 'owned_inbox', name: 'Owned inbox', kind: 'in_product',
    });
    const policy = await api(env, env.secretToken, 'POST', path('/monitors'), {
      policy_key: 'owned_monitor', name: 'Owned monitor', env: 'prod', target_kind: 'project', target_id: null,
      metric_key: 'owned_metric', comparison_rule: 'above', threshold: 1, minimum_sample: 0,
      window_minutes: 60, cadence_minutes: 60, cooldown_seconds: 0, owner: 'project-owner',
      destination_ids: [destination.body.id], proposal_kind: null, proposal_target: null,
    });
    const now = new Date('2026-08-11T12:00:00.000Z');
    await env.pool.query('UPDATE monitor_policies SET next_evaluation_at = $2 WHERE project_id = $1', [env.projectId, now]);
    const options = { batchSize: 10, maxAttempts: 3, baseRetryMs: 10, maxRetryMs: 100,
      leaseMs: 10_000, actor: 'worker:ownership-test', projectId: env.projectId };
    await new MonitorWorker(env.pool, {} as never, options, async () => ({
      current: { value: 2, events: 2 }, previous: { value: 0, events: 0 }, definitionFingerprint: 'owned-v1',
    })).runOnce(now);
    const deliveryDue = new Date('2026-08-12T00:00:00.000Z');
    await env.pool.query(
      `UPDATE notification_deliveries SET next_attempt_at = $2
       WHERE project_id = $1 AND status IN ('pending', 'failed')`,
      [env.projectId, deliveryDue],
    );
    await new NotificationWorker(env.pool, options).runOnce(deliveryDue);
    expect((await env.pool.query('SELECT count(*)::int AS count FROM notification_inbox WHERE project_id = $1', [env.projectId])).rows[0].count).toBe(1);

    const deleted = await api(env, env.personalToken, 'DELETE', `/api/v1/projects/${env.projectSlug}`, { confirm_slug: env.projectSlug });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    const counts = await env.pool.query(`SELECT
      (SELECT count(*)::int FROM monitor_policies WHERE project_id = $1) AS policies,
      (SELECT count(*)::int FROM monitor_findings WHERE project_id = $1) AS findings,
      (SELECT count(*)::int FROM notification_inbox WHERE project_id = $1) AS inbox`, [env.projectId]);
    expect(counts.rows[0]).toEqual({ policies: 0, findings: 0, inbox: 0 });
    expect(policy.status).toBe(201);
  });

  function path(suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
});
