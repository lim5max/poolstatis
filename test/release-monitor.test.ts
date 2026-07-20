import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ReleaseMonitor } from '../src/services/releaseMonitor.js';
import { QueryService } from '../src/services/query.js';
import { PostgresEventStore } from '../src/stores/postgresEventStore.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

const DAY = 86_400_000;

describe('durable release monitor', () => {
  let env: TestEnv;
  let projectId: string;
  let query: QueryService;

  beforeAll(async () => {
    env = await createTestEnv();
    projectId = (await env.pool.query('SELECT id FROM projects WHERE slug = $1', [env.projectSlug])).rows[0].id;
    query = new QueryService(env.pool, new PostgresEventStore(env.pool));
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    const declaration = { version: 1, contracts: [{
      key: 'monitored_change', name: 'Monitored change',
      business_hypothesis: 'The deployed change should improve first activation.',
      decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
      guardrail_metric_keys: [], target_filters: [], baseline_window_days: 1,
      observation_window_days: 1, minimum_sample_size: 2,
      expected_direction: 'increase', minimum_meaningful_effect: 0.1,
      references: {}, status: 'active',
    }] };
    const diff = await api(env, env.secretToken, 'POST', path('/contracts/diff'), declaration);
    await api(env, env.secretToken, 'POST', path('/contracts/apply'), { declaration, expected_revision: diff.body.expected_revision });
  });

  afterAll(async () => env.close());

  test('records a waiting attempt until the fixed observation window is complete', async () => {
    const deployedAt = new Date();
    const release = await register('monitor-waiting', deployedAt);
    const monitor = new ReleaseMonitor(env.pool, query, options());
    const result = await monitor.runOnce(new Date(deployedAt.getTime() + 12 * 3600_000));
    expect(result).toMatchObject({ claimed: 1, waiting: 1, succeeded: 0, failed: 0 });
    const attempt = await env.pool.query('SELECT * FROM evaluation_attempts WHERE release_id = $1', [release.id]);
    expect(attempt.rows[0]).toMatchObject({ status: 'waiting', reason: 'observation_window_incomplete', attempt_count: 1 });
    expect(new Date(attempt.rows[0].scheduled_at).getTime()).toBe(deployedAt.getTime() + DAY);
  });

  test('evaluates one ready window once across concurrent workers and restart', async () => {
    const deployedAt = new Date(Date.now() - 2 * DAY);
    const release = await register('monitor-ready', deployedAt);
    await ingest(deployedAt);
    const first = new ReleaseMonitor(env.pool, query, options());
    const second = new ReleaseMonitor(env.pool, query, options());
    const results = await Promise.all([first.runOnce(new Date()), second.runOnce(new Date())]);
    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.succeeded, 0)).toBe(1);
    const counts = await env.pool.query(
      `SELECT
         (SELECT count(*)::int FROM evaluation_attempts WHERE release_id = $1) AS attempts,
         (SELECT count(*)::int FROM evidence_sets WHERE release_id = $1) AS evidence,
         (SELECT count(*)::int FROM decisions WHERE release_id = $1) AS decisions`,
      [release.id],
    );
    expect(counts.rows[0]).toEqual({ attempts: 1, evidence: 1, decisions: 1 });
    const restart = new ReleaseMonitor(env.pool, query, options());
    expect(await restart.runOnce(new Date())).toMatchObject({ claimed: 0 });
  });

  test('bounds a batch and uses capped exponential retry for failures', async () => {
    const deployedAt = new Date(Date.now() - 2 * DAY);
    const one = await register('monitor-failure-one', deployedAt);
    await register('monitor-failure-two', deployedAt);
    const broken = async () => { throw Object.assign(new Error('controlled upstream failure'), { code: 'controlled_failure' }); };
    const monitor = new ReleaseMonitor(env.pool, query, options({ batchSize: 1, baseRetryMs: 1_000, maxRetryMs: 2_000 }), broken);
    const now = new Date();
    expect(await monitor.runOnce(now)).toMatchObject({ claimed: 1, failed: 1 });
    let attempt = (await env.pool.query('SELECT * FROM evaluation_attempts WHERE release_id = $1', [one.id])).rows[0];
    expect(attempt).toMatchObject({ status: 'failed', attempt_count: 1, error_code: 'controlled_failure' });
    expect(new Date(attempt.scheduled_at).getTime()).toBe(now.getTime() + 1_000);
    const retryMonitor = new ReleaseMonitor(env.pool, query, options({ batchSize: 2, baseRetryMs: 1_000, maxRetryMs: 2_000 }), broken);
    expect(await retryMonitor.runOnce(new Date(now.getTime() + 1_000))).toMatchObject({ claimed: 2, failed: 2 });
    attempt = (await env.pool.query('SELECT * FROM evaluation_attempts WHERE release_id = $1', [one.id])).rows[0];
    expect(attempt.attempt_count).toBe(2);
    expect(new Date(attempt.scheduled_at).getTime()).toBe(now.getTime() + 3_000);
  });

  async function register(key: string, deployedAt: Date) {
    const response = await api(env, env.secretToken, 'POST', path('/releases'), {
      idempotency_key: key, contract_key: 'monitored_change', env: 'prod',
      repository: 'acme/product', commit_sha: key.replace(/[^a-f0-9]/g, 'a').padEnd(40, 'a').slice(0, 40),
      deployed_at: deployedAt.toISOString(), status: 'deployed',
    });
    expect(response.status).toBe(201);
    return response.body;
  }

  async function ingest(anchor: Date) {
    const response = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: `monitor-${anchor.getTime()}`, events: [
        { event: 'activation.completed', distinct_id: 'base-1', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
        { event: 'activation.completed', distinct_id: 'base-2', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
        { event: 'activation.completed', distinct_id: 'observed-1', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
        { event: 'activation.completed', distinct_id: 'observed-2', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
        { event: 'activation.completed', distinct_id: 'observed-3', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      ],
    });
    expect(response.status).toBe(200);
  }

  function path(suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
  function options(patch: Partial<{ batchSize: number; maxAttempts: number; baseRetryMs: number; maxRetryMs: number; leaseMs: number; actor: string }> = {}) {
    return { batchSize: 10, maxAttempts: 5, baseRetryMs: 1_000, maxRetryMs: 8_000, leaseMs: 60_000, actor: 'worker:test', projectId, ...patch };
  }
});
