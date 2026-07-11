import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});

afterAll(() => env.close());

describe('flags and experiments schema', () => {
  it('creates project-scoped flags and experiments tables', async () => {
    const { rows } = await env.pool.query<{ flags: string | null; experiments: string | null }>(
      "SELECT to_regclass('feature_flags') AS flags, to_regclass('experiments') AS experiments",
    );
    expect(rows[0]).toEqual({ flags: 'feature_flags', experiments: 'experiments' });
  });

  it('rejects duplicate variants and allocation above one hundred percent', async () => {
    const schemas = await import('../src/schemas.js') as Record<string, unknown>;
    const featureFlagSchema = schemas.featureFlagSchema as { safeParse: (value: unknown) => { success: boolean } } | undefined;
    expect(featureFlagSchema).toBeDefined();

    const result = featureFlagSchema!.safeParse({
      key: 'checkout_copy',
      name: 'Checkout copy',
      purpose: 'Safely roll out a new checkout call to action.',
      variants: [
        { key: 'control', rollout_percentage: 60 },
        { key: 'control', rollout_percentage: 60 },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe('feature flags', () => {
  const P = () => `/api/v1/projects/${env.projectSlug}`;

  async function createActiveFlag(
    key: string,
    variants: Array<{ key: string; rollout_percentage: number; payload?: Record<string, unknown> }>,
  ): Promise<void> {
    const created = await api(env, env.secretToken, 'POST', `${P()}/flags`, {
      key,
      name: key.replaceAll('_', ' '),
      purpose: `Safely roll out the ${key.replaceAll('_', ' ')} product change.`,
      variants,
      status: 'active',
    });
    expect(created.status).toBe(201);
  }

  it('keeps an actor on one variant and appends registered exposure events', async () => {
    await createActiveFlag('checkout_copy', [
      { key: 'control', rollout_percentage: 50 },
      { key: 'test', rollout_percentage: 50, payload: { label: 'Pay now' } },
    ]);

    const first = await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'checkout_copy', distinct_id: 'actor-42', session_id: 's-42',
    });
    const second = await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'checkout_copy', distinct_id: 'actor-42', session_id: 's-42',
    });

    expect(first.status).toBe(200);
    expect(second.body.variant).toEqual(first.body.variant);
    expect(first.body.variant.key).toMatch(/^(control|test)$/);

    const events = await api(env, env.secretToken, 'GET', `${P()}/events/sample?event=%24feature_flag_called&limit=10`);
    expect(events.body.events).toHaveLength(2);
    expect(events.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: '$feature_flag_called', distinct_id: 'actor-42', session_id: 's-42', registered: true,
        properties: expect.objectContaining({ flag_key: 'checkout_copy', variant: first.body.variant.key }),
      }),
    ]));
  });

  it('returns no variant and emits no exposure when the allocation is empty', async () => {
    await createActiveFlag('empty_rollout', [{ key: 'control', rollout_percentage: 0 }]);

    const evaluated = await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'empty_rollout', distinct_id: 'actor-empty',
    });

    expect(evaluated.status).toBe(200);
    expect(evaluated.body).toEqual({ key: 'empty_rollout', variant: null });
    const events = await api(env, env.secretToken, 'GET', `${P()}/events/sample?event=%24feature_flag_called&limit=20`);
    expect(events.body.events.some((event: { properties: { flag_key?: string } }) => event.properties.flag_key === 'empty_rollout')).toBe(false);
  });

  it('keeps flag management unavailable to ingest keys', async () => {
    const listed = await api(env, env.ingestToken, 'GET', `${P()}/flags`);
    expect(listed.status).toBe(403);
    expect(listed.body.error.code).toBe('wrong_key_kind');
  });
});

describe('experiments', () => {
  const P = () => `/api/v1/projects/${env.projectSlug}`;

  async function createActiveFlag(key: string): Promise<void> {
    const created = await api(env, env.secretToken, 'POST', `${P()}/flags`, {
      key,
      name: key.replaceAll('_', ' '),
      purpose: `Safely measure the effect of ${key.replaceAll('_', ' ')} in production.`,
      variants: [
        { key: 'control', rollout_percentage: 50 },
        { key: 'test', rollout_percentage: 50, payload: { label: 'Pay now' } },
      ],
      status: 'active',
    });
    expect(created.status).toBe(201);
  }

  async function createAndStartExperiment(key: string, flagKey: string, metricKey: string): Promise<void> {
    const created = await api(env, env.secretToken, 'POST', `${P()}/experiments`, {
      key,
      name: key.replaceAll('_', ' '),
      hypothesis: `Changing ${flagKey.replaceAll('_', ' ')} will improve ${metricKey.replaceAll('_', ' ')}.`,
      flag_key: flagKey,
      primary_metric_key: metricKey,
    });
    expect(created.status).toBe(201);
    const started = await api(env, env.secretToken, 'POST', `${P()}/experiments/${key}/start`);
    expect(started.status).toBe(200);
  }

  it('counts only registered outcomes after an actor first sees the running experiment', async () => {
    await activeMetric(env, { key: 'checkout_completed', source: { event: 'checkout.completed' } });
    await createActiveFlag('checkout_experiment_flag');
    await createAndStartExperiment('checkout_copy_test', 'checkout_experiment_flag', 'checkout_completed');

    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'checkout.completed', distinct_id: 'before-exposure' }],
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'checkout_experiment_flag', distinct_id: 'before-exposure',
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'checkout_experiment_flag', distinct_id: 'converted-after-exposure',
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'checkout.completed', distinct_id: 'converted-after-exposure' }],
    });

    const result = await api(env, env.secretToken, 'GET', `${P()}/experiments/checkout_copy_test/results?env=prod`);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('running');
    expect(result.body.variants.reduce((total: number, variant: { exposed: number }) => total + variant.exposed, 0)).toBe(2);
    expect(result.body.variants.reduce((total: number, variant: { converted: number }) => total + variant.converted, 0)).toBe(1);
    expect(result.body.variants.reduce((total: number, variant: { probability_best: number }) => total + variant.probability_best, 0)).toBeCloseTo(1, 5);
  });

  it('does not start an experiment before its flag allocates all traffic', async () => {
    await activeMetric(env, { key: 'incomplete_delivery_completed', source: { event: 'delivery.completed' } });
    const flag = await api(env, env.secretToken, 'POST', `${P()}/flags`, {
      key: 'incomplete_delivery_flag',
      name: 'Incomplete delivery flag',
      purpose: 'Hold back a portion of traffic while the delivery is being prepared.',
      variants: [{ key: 'control', rollout_percentage: 50 }],
      status: 'active',
    });
    expect(flag.status).toBe(201);
    const experiment = await api(env, env.secretToken, 'POST', `${P()}/experiments`, {
      key: 'incomplete_delivery_test',
      name: 'Incomplete delivery test',
      hypothesis: 'The incomplete delivery should not be measured before full assignment exists.',
      flag_key: 'incomplete_delivery_flag',
      primary_metric_key: 'incomplete_delivery_completed',
    });
    expect(experiment.status).toBe(201);

    const started = await api(env, env.secretToken, 'POST', `${P()}/experiments/incomplete_delivery_test/start`);
    expect(started.status).toBe(409);
    expect(started.body.error.code).toBe('experiment_flag_allocation_incomplete');
  });

  it('locks a running experiment flag so allocations cannot rewrite its historical variants', async () => {
    await activeMetric(env, { key: 'locked_flag_completed', source: { event: 'locked.completed' } });
    await createActiveFlag('locked_experiment_flag');
    await createAndStartExperiment('locked_experiment', 'locked_experiment_flag', 'locked_flag_completed');

    const patched = await api(env, env.secretToken, 'PATCH', `${P()}/flags/locked_experiment_flag`, {
      variants: [{ key: 'control', rollout_percentage: 100 }],
    });

    expect(patched.status).toBe(409);
    expect(patched.body.error.code).toBe('feature_flag_in_running_experiment');
  });

  it('returns declared secondary metric outcomes alongside the primary result', async () => {
    await activeMetric(env, { key: 'secondary_primary_completed', source: { event: 'primary.completed' } });
    await activeMetric(env, { key: 'secondary_guardrail_failed', source: { event: 'guardrail.failed' } });
    await createActiveFlag('secondary_metric_flag');
    const created = await api(env, env.secretToken, 'POST', `${P()}/experiments`, {
      key: 'secondary_metric_experiment',
      name: 'Secondary metric experiment',
      hypothesis: 'The treatment should increase completion without increasing the guardrail failure rate.',
      flag_key: 'secondary_metric_flag',
      primary_metric_key: 'secondary_primary_completed',
      secondary_metric_keys: ['secondary_guardrail_failed'],
    });
    expect(created.status).toBe(201);
    expect((await api(env, env.secretToken, 'POST', `${P()}/experiments/secondary_metric_experiment/start`)).status).toBe(200);
    await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', { key: 'secondary_metric_flag', distinct_id: 'secondary-actor' });
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        { event: 'primary.completed', distinct_id: 'secondary-actor' },
        { event: 'guardrail.failed', distinct_id: 'secondary-actor' },
      ],
    });

    const result = await api(env, env.secretToken, 'GET', `${P()}/experiments/secondary_metric_experiment/results?env=prod`);
    expect(result.body.secondary_metrics).toEqual([
      expect.objectContaining({ metric: expect.objectContaining({ key: 'secondary_guardrail_failed' }) }),
    ]);
    expect(result.body.secondary_metrics[0].variants.reduce((total: number, variant: { converted: number }) => total + variant.converted, 0)).toBe(1);
  });
});

describe('feature delivery documentation', () => {
  it('documents the REST, MCP and SDK workflow', async () => {
    const [httpApi, mcp, sdk] = await Promise.all([
      readFile(resolve('docs/04-http-api.md'), 'utf8'),
      readFile(resolve('docs/03-mcp-server.md'), 'utf8'),
      readFile(resolve('sdk/README.md'), 'utf8'),
    ]);
    expect(httpApi).toContain('/i/v1/flags/evaluate');
    expect(mcp).toContain('get_experiment_results');
    expect(sdk).toContain('getFeatureFlag');
  });
});
