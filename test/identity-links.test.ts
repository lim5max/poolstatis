import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

describe('audited actor links', () => {
  let env: TestEnv;
  let other: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
    other = await createTestEnv();
    await activeMetric(env, {
      key: 'activation_started',
      type: 'unique_actors',
      source: { event: 'activation.started', filters: [] },
    });
    await activeMetric(env, {
      key: 'activation_completed',
      type: 'unique_actors',
      source: { event: 'activation.completed', filters: [] },
    });
    const now = Date.now();
    const prod = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'identity-prod',
      events: [
        {
          event: 'activation.started',
          distinct_id: 'anon-1',
          timestamp: new Date(now - 60_000).toISOString(),
        },
        {
          event: 'activation.completed',
          distinct_id: 'user-1',
          timestamp: new Date(now - 30_000).toISOString(),
        },
      ],
    });
    expect(prod.status).toBe(200);
    const dev = await api(env, env.ingestDevToken, 'POST', '/i/v1/events', {
      batch_id: 'identity-dev',
      events: [
        {
          event: 'activation.completed',
          distinct_id: 'anon-1',
          timestamp: new Date(now - 60_000).toISOString(),
        },
        {
          event: 'activation.completed',
          distinct_id: 'user-1',
          timestamp: new Date(now - 30_000).toISOString(),
        },
      ],
    });
    expect(dev.status).toBe(200);
  });

  afterAll(async () => {
    await env.close();
    await other.close();
  });

  const trend = (environment = 'prod') => api(
    env,
    env.secretToken,
    'POST',
    '/api/v1/projects/' + env.projectSlug + '/query',
    {
      kind: 'trend',
      metric: 'activation_completed',
      date_from: '-1d',
      interval: 'day',
      env: environment,
    },
  );

  const funnel = () => api(
    env,
    env.secretToken,
    'POST',
    '/api/v1/projects/' + env.projectSlug + '/query',
    {
      kind: 'funnel',
      steps: [{ metric: 'activation_started' }, { metric: 'activation_completed' }],
      date_from: '-1d',
      env: 'prod',
    },
  );

  test('joins anonymous activity at query time and reverses it with full audit history', async () => {
    const before = await funnel();
    expect(before.status).toBe(200);
    expect(before.body.steps.map((step: { actors: number }) => step.actors)).toEqual([1, 0]);

    const created = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/identity-links',
      { source_distinct_id: 'anon-1', target_distinct_id: 'user-1', env: 'prod' },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      source_distinct_id: 'anon-1',
      target_distinct_id: 'user-1',
      status: 'active',
    });

    const after = await funnel();
    expect(after.body.steps.map((step: { actors: number }) => step.actors)).toEqual([1, 1]);

    const prodTrend = await trend();
    expect(prodTrend.body.series.reduce((sum: number, point: { value: number }) => sum + point.value, 0)).toBe(1);
    const devTrend = await trend('dev');
    expect(devTrend.body.series.reduce((sum: number, point: { value: number }) => sum + point.value, 0)).toBe(2);

    const conflict = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/identity-links',
      { source_distinct_id: 'anon-1', target_distinct_id: 'user-2', env: 'prod' },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('actor_link_conflict');

    const cycle = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/identity-links',
      { source_distinct_id: 'user-1', target_distinct_id: 'anon-1', env: 'prod' },
    );
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.code).toBe('actor_link_cycle');

    const revoked = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/identity-links/' + created.body.id + '/revoke',
      {},
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe('revoked');

    const restored = await funnel();
    expect(restored.body.steps.map((step: { actors: number }) => step.actors)).toEqual([1, 0]);

    const listed = await api(
      env,
      env.secretToken,
      'GET',
      '/api/v1/projects/' + env.projectSlug + '/identity-links?env=prod',
    );
    expect(listed.status).toBe(200);
    expect(listed.body.links).toHaveLength(1);
    expect(listed.body.audit.map((row: { action: string }) => row.action)).toEqual(['revoked', 'created']);

    const crossOrg = await api(
      env,
      env.secretToken,
      'GET',
      '/api/v1/projects/' + other.projectSlug + '/identity-links?env=prod',
    );
    expect(crossOrg.status).toBe(404);
  });

  test('rejects cycles beyond a short identity chain', async () => {
    for (let index = 0; index < 35; index++) {
      const link = await api(
        env,
        env.secretToken,
        'POST',
        '/api/v1/projects/' + env.projectSlug + '/identity-links',
        { source_distinct_id: `chain-${index}`, target_distinct_id: `chain-${index + 1}`, env: 'long-chain' },
      );
      expect(link.status).toBe(201);
    }
    const resolved = await env.pool.query<{ actor: string }>(
      'SELECT poolstatis_resolve_actor($1, $2, $3) AS actor',
      [env.projectId, 'long-chain', 'chain-0'],
    );
    expect(resolved.rows[0]?.actor).toBe('chain-35');
    const cycle = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/identity-links',
      { source_distinct_id: 'chain-35', target_distinct_id: 'chain-0', env: 'long-chain' },
    );
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.code).toBe('actor_link_cycle');
  });
});
