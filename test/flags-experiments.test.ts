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

  it('rejects duplicate variants, allocation above one hundred percent, and imprecise traffic shares', async () => {
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

    const imprecise = featureFlagSchema!.safeParse({
      key: 'checkout_copy_precise',
      name: 'Checkout copy precision',
      purpose: 'Keep rollout allocation exactly representable as basis points.',
      variants: [
        { key: 'control', rollout_percentage: 33.333 },
        { key: 'test_a', rollout_percentage: 33.333 },
        { key: 'test_b', rollout_percentage: 33.334 },
      ],
    });

    expect(imprecise.success).toBe(false);

    const validTwoDecimal = featureFlagSchema!.safeParse({
      key: 'small_precise_shares',
      name: 'Small precise shares',
      purpose: 'Accept normal two-decimal allocations despite binary floating point.',
      variants: [
        { key: 'a', rollout_percentage: 0.07 },
        { key: 'b', rollout_percentage: 0.29 },
        { key: 'c', rollout_percentage: 1.13 },
      ],
    });

    expect(validTwoDecimal.success).toBe(true);
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

  function preparedSetup(
    key: string,
    metricKey: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      env: 'prod',
      control_variant_key: 'control',
      flag: {
        key: `${key}_flag`,
        name: `${key} flag`,
        purpose: `Safely deliver the ${key.replaceAll('_', ' ')} experiment variants.`,
        variants: [
          { key: 'control', rollout_percentage: 50 },
          { key: 'test', rollout_percentage: 50, payload: { label: 'New' } },
        ],
      },
      experiment: {
        key,
        name: key.replaceAll('_', ' '),
        hypothesis: `The ${key.replaceAll('_', ' ')} treatment should improve its declared outcome.`,
        primary_metric_key: metricKey,
      },
      ...overrides,
    };
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

  it('counts only server-emitted flag exposures, even if a client sends a registered lookalike event', async () => {
    await activeMetric(env, { key: 'system_exposure_outcome', source: { event: 'system.exposure.outcome' } });
    // An active metric can make this direct ingest event registered. That must
    // still never let a caller manufacture an experiment assignment.
    await activeMetric(env, { key: 'lookalike_exposure_event', source: { event: '$feature_flag_called' } });
    await createActiveFlag('system_exposure_flag');
    await createAndStartExperiment('system_exposure_experiment', 'system_exposure_flag', 'system_exposure_outcome');

    const forged = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{
        event: '$feature_flag_called',
        distinct_id: 'forged-actor',
        properties: { flag_key: 'system_exposure_flag', variant: 'control' },
      }],
    });
    expect(forged.status).toBe(200);

    const evaluated = await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'system_exposure_flag', distinct_id: 'real-actor',
    });
    expect(evaluated.status).toBe(200);

    const result = await api(env, env.secretToken, 'GET', `${P()}/experiments/system_exposure_experiment/results?env=prod`);
    expect(result.status).toBe(200);
    expect(result.body.variants.reduce((total: number, variant: { exposed: number }) => total + variant.exposed, 0)).toBe(1);
  });

  it('allows only one concurrent start transition', async () => {
    await activeMetric(env, { key: 'concurrent_start_outcome', source: { event: 'concurrent.start.outcome' } });
    await createActiveFlag('concurrent_start_flag');
    const created = await api(env, env.secretToken, 'POST', `${P()}/experiments`, {
      key: 'concurrent_start_experiment',
      name: 'Concurrent start experiment',
      hypothesis: 'Concurrent start requests must produce exactly one state transition.',
      flag_key: 'concurrent_start_flag',
      primary_metric_key: 'concurrent_start_outcome',
    });
    expect(created.status).toBe(201);

    const attempts = await Promise.all([
      api(env, env.secretToken, 'POST', `${P()}/experiments/concurrent_start_experiment/start`),
      api(env, env.secretToken, 'POST', `${P()}/experiments/concurrent_start_experiment/start`),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 409]);
  });

  it('does not let a draft patch overtake a concurrent start', async () => {
    await activeMetric(env, { key: 'locked_patch_outcome', source: { event: 'locked.patch.outcome' } });
    await createActiveFlag('locked_patch_flag');
    const created = await api(env, env.secretToken, 'POST', `${P()}/experiments`, {
      key: 'locked_patch_experiment',
      name: 'Locked patch experiment',
      hypothesis: 'A draft patch must not rewrite an experiment being started.',
      flag_key: 'locked_patch_flag',
      primary_metric_key: 'locked_patch_outcome',
    });
    expect(created.status).toBe(201);

    const connection = await env.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        'SELECT id FROM experiments WHERE project_id = (SELECT id FROM projects WHERE slug = $1) AND key = $2 FOR UPDATE',
        [env.projectSlug, 'locked_patch_experiment'],
      );
      const start = api(env, env.secretToken, 'POST', `${P()}/experiments/locked_patch_experiment/start`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const patch = api(env, env.secretToken, 'PATCH', `${P()}/experiments/locked_patch_experiment`, {
        hypothesis: 'This patch must lose the race to the start transition.',
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await connection.query('COMMIT');

      const attempts = await Promise.all([start, patch]);
      expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 409]);
    } finally {
      await connection.query('ROLLBACK').catch(() => {});
      connection.release();
    }
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

  it('prepares a draft flag and experiment atomically and rolls both back on a later conflict', async () => {
    await activeMetric(env, { key: 'prepared_atomic_outcome', source: { event: 'prepared.atomic.outcome' } });
    const prepared = await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`,
      preparedSetup('prepared_atomic', 'prepared_atomic_outcome'));
    expect(prepared.status).toBe(201);
    expect(prepared.body).toMatchObject({
      flag: { key: 'prepared_atomic_flag', status: 'draft', env: 'prod' },
      experiment: { key: 'prepared_atomic', status: 'draft', env: 'prod', control_variant_key: 'control' },
      readiness: { ready: true, env: 'prod' },
    });

    const conflict = await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`, {
      ...preparedSetup('prepared_atomic_conflict', 'prepared_atomic_outcome'),
      flag: {
        ...(preparedSetup('prepared_atomic_conflict', 'prepared_atomic_outcome').flag),
        key: 'must_rollback_flag',
      },
      experiment: {
        ...(preparedSetup('prepared_atomic_conflict', 'prepared_atomic_outcome').experiment),
        key: 'prepared_atomic',
      },
    });
    expect(conflict.status).toBe(409);
    const flags = await api(env, env.secretToken, 'GET', `${P()}/flags`);
    expect(flags.body.flags.some((flag: { key: string }) => flag.key === 'must_rollback_flag')).toBe(false);
  });

  it('reports launch guard failures without activating a partial setup', async () => {
    await activeMetric(env, { key: 'guarded_launch_outcome', source: { event: 'guarded.launch.outcome' } });
    const singleVariant = preparedSetup('guarded_launch', 'guarded_launch_outcome', {
      flag: {
        key: 'guarded_launch_flag',
        name: 'Guarded launch flag',
        purpose: 'Keep an invalid one-variant experiment safely inactive.',
        variants: [{ key: 'control', rollout_percentage: 100 }],
      },
    });
    const prepared = await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`, singleVariant);
    expect(prepared.status).toBe(201);
    expect(prepared.body.readiness).toMatchObject({ ready: false });
    expect(prepared.body.readiness.checks).toContainEqual(expect.objectContaining({ key: 'variant_count', ready: false }));

    const launched = await api(env, env.secretToken, 'POST', `${P()}/experiments/guarded_launch/launch`, {});
    expect(launched.status).toBe(409);
    expect(launched.body.error.code).toBe('experiment_not_ready');
    const listed = await api(env, env.secretToken, 'GET', `${P()}/flags`);
    expect(listed.body.flags.find((flag: { key: string }) => flag.key === 'guarded_launch_flag').status).toBe('draft');
  });

  it('rejects PostHog outcome metrics instead of reporting native zeroes', async () => {
    await env.pool.query(
      `INSERT INTO metrics (project_id, key, name, purpose, type, source, status)
       VALUES ($1, 'posthog_experiment_outcome', 'PostHog experiment outcome',
         'Measures an external outcome that the native experiment evaluator cannot read.',
         'count', $2::jsonb, 'active')`,
      [env.projectId, JSON.stringify({
        event: 'external.completed',
        data_source: 'posthog',
        source_connection_id: '00000000-0000-4000-8000-000000000001',
      })],
    );

    const prepared = await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`,
      preparedSetup('posthog_outcome_guard', 'posthog_experiment_outcome'));
    expect(prepared.status).toBe(201);
    expect(prepared.body.readiness.ready).toBe(false);
    expect(prepared.body.readiness.checks).toContainEqual(expect.objectContaining({
      key: 'metrics_active',
      ready: false,
      message: expect.stringContaining('native'),
    }));

    const launch = await api(env, env.secretToken, 'POST', `${P()}/experiments/posthog_outcome_guard/launch`);
    expect(launch.status).toBe(409);
    expect(launch.body.error.code).toBe('experiment_not_ready');
  });

  it('blocks inactive metrics and a second running experiment on the same flag', async () => {
    const proposed = await api(env, env.secretToken, 'POST', `${P()}/metrics`, {
      key: 'proposed_launch_outcome',
      name: 'Proposed launch outcome',
      purpose: 'Measure whether the proposed launch produces its intended outcome.',
      type: 'count',
      source: { event: 'proposed.launch.outcome' },
    });
    expect(proposed.status).toBe(201);
    const notReady = await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`,
      preparedSetup('proposed_metric_launch', 'proposed_launch_outcome'));
    expect(notReady.body.readiness.checks).toContainEqual(expect.objectContaining({ key: 'metrics_active', ready: false }));
    expect((await api(env, env.secretToken, 'POST', `${P()}/experiments/proposed_metric_launch/launch`, {})).status).toBe(409);

    await activeMetric(env, { key: 'shared_flag_outcome', source: { event: 'shared.flag.outcome' } });
    await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`,
      preparedSetup('shared_flag_first', 'shared_flag_outcome'));
    const second = await api(env, env.secretToken, 'POST', `${P()}/experiments`, {
      key: 'shared_flag_second',
      name: 'Shared flag second',
      hypothesis: 'A second experiment must not launch while the first owns this flag.',
      flag_key: 'shared_flag_first_flag',
      primary_metric_key: 'shared_flag_outcome',
      env: 'prod',
      control_variant_key: 'control',
    });
    expect(second.status).toBe(201);
    expect((await api(env, env.secretToken, 'POST', `${P()}/experiments/shared_flag_first/launch`, {})).status).toBe(200);
    const readiness = await api(env, env.secretToken, 'GET', `${P()}/experiments/shared_flag_second/readiness?env=prod`);
    expect(readiness.body.checks).toContainEqual(expect.objectContaining({ key: 'no_running_experiment', ready: false }));
    expect((await api(env, env.secretToken, 'POST', `${P()}/experiments/shared_flag_second/launch`, {})).status).toBe(409);
  });

  it('rejects invalid controls and repeated primary metrics before creating either draft', async () => {
    await activeMetric(env, { key: 'invalid_prepare_outcome', source: { event: 'invalid.prepare.outcome' } });
    const unknownControl = await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`, {
      ...preparedSetup('unknown_control_prepare', 'invalid_prepare_outcome'),
      control_variant_key: 'missing',
    });
    expect(unknownControl.status).toBe(400);
    expect(unknownControl.body.error.code).toBe('experiment_control_variant_unknown');

    const repeatedMetric = await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`, {
      ...preparedSetup('repeated_metric_prepare', 'invalid_prepare_outcome'),
      experiment: {
        ...preparedSetup('repeated_metric_prepare', 'invalid_prepare_outcome').experiment,
        secondary_metric_keys: ['invalid_prepare_outcome'],
      },
    });
    expect(repeatedMetric.status).toBe(400);
    expect(repeatedMetric.body.error.code).toBe('experiment_primary_metric_repeated');

    const flags = await api(env, env.secretToken, 'GET', `${P()}/flags`);
    expect(flags.body.flags.some((flag: { key: string }) => flag.key === 'unknown_control_prepare_flag')).toBe(false);
    expect(flags.body.flags.some((flag: { key: string }) => flag.key === 'repeated_metric_prepare_flag')).toBe(false);
  });

  it('launches atomically once under concurrency and freezes definitions', async () => {
    await activeMetric(env, { key: 'atomic_launch_outcome', source: { event: 'atomic.launch.outcome' } });
    expect((await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`,
      preparedSetup('atomic_launch', 'atomic_launch_outcome'))).status).toBe(201);

    const attempts = await Promise.all([
      api(env, env.secretToken, 'POST', `${P()}/experiments/atomic_launch/launch`, {}),
      api(env, env.secretToken, 'POST', `${P()}/experiments/atomic_launch/launch`, {}),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 409]);
    const success = attempts.find((attempt) => attempt.status === 200)!;
    expect(success.body).toMatchObject({
      flag: { status: 'active' },
      experiment: { status: 'running', snapshot_integrity: 'frozen_at_start' },
    });
  });

  it('keeps frozen results stable after the concluded flag and metric mutate', async () => {
    await activeMetric(env, { key: 'frozen_result_outcome', source: { event: 'frozen.result.outcome' } });
    await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`,
      preparedSetup('frozen_result', 'frozen_result_outcome'));
    await api(env, env.secretToken, 'POST', `${P()}/experiments/frozen_result/launch`, {});
    await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'frozen_result_flag', distinct_id: 'frozen-actor',
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'frozen.result.outcome', distinct_id: 'frozen-actor' }],
    });
    const before = await api(env, env.secretToken, 'GET', `${P()}/experiments/frozen_result/results?env=prod`);
    expect(before.status).toBe(200);
    expect(before.body.snapshot_integrity).toBe('frozen_at_start');

    const concluded = await api(env, env.secretToken, 'POST', `${P()}/experiments/frozen_result/apply-decision`, {
      decision: { outcome: 'inconclusive', rationale: 'Freeze this measured window before definitions change.' },
    });
    expect(concluded.status).toBe(200);
    expect((await api(env, env.secretToken, 'PATCH', `${P()}/flags/frozen_result_flag`, {
      variants: [{ key: 'replacement', rollout_percentage: 100 }],
    })).status).toBe(200);
    expect((await api(env, env.secretToken, 'PATCH', `${P()}/metrics/frozen_result_outcome`, {
      source: { event: 'different.outcome' },
    })).status).toBe(200);
    expect((await api(env, env.secretToken, 'POST', `${P()}/metrics/frozen_result_outcome/deprecate`, {
      reason: 'Changed after the experiment to prove snapshots remain readable.',
    })).status).toBe(200);

    const after = await api(env, env.secretToken, 'GET', `${P()}/experiments/frozen_result/results?env=prod`);
    expect(after.status).toBe(200);
    expect(after.body.primary_metric).toEqual(before.body.primary_metric);
    expect(after.body.variants).toEqual(before.body.variants);
    expect(after.body.snapshot_integrity).toBe('frozen_at_start');
  });

  it('keeps a failed ship decision atomic and can explicitly roll a winner to one hundred percent', async () => {
    await activeMetric(env, { key: 'ship_atomic_outcome', source: { event: 'ship.atomic.outcome' } });
    await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`,
      preparedSetup('ship_atomic', 'ship_atomic_outcome'));
    await api(env, env.secretToken, 'POST', `${P()}/experiments/ship_atomic/launch`, {});

    const invalid = await api(env, env.secretToken, 'POST', `${P()}/experiments/ship_atomic/apply-decision`, {
      decision: { outcome: 'ship', rationale: 'This invalid choice must roll the whole transaction back.' },
      ship_variant_key: 'missing',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('experiment_ship_variant_unknown');
    const stillRunning = await api(env, env.secretToken, 'GET', `${P()}/experiments`);
    expect(stillRunning.body.experiments.find((experiment: { key: string }) => experiment.key === 'ship_atomic').status).toBe('running');

    const applied = await api(env, env.secretToken, 'POST', `${P()}/experiments/ship_atomic/apply-decision`, {
      decision: { outcome: 'ship', rationale: 'Ship the explicit treatment and stop splitting new traffic.' },
      ship_variant_key: 'test',
    });
    expect(applied.status).toBe(200);
    expect(applied.body.experiment).toMatchObject({ status: 'concluded', decision: { outcome: 'ship', ship_variant_key: 'test' } });
    expect(applied.body.flag.variants).toEqual([
      { key: 'control', rollout_percentage: 0 },
      { key: 'test', rollout_percentage: 100, payload: { label: 'New' } },
    ]);
  });

  it('isolates new flags and experiment results by env while legacy flags remain project-wide', async () => {
    await activeMetric(env, { key: 'env_scoped_outcome', source: { event: 'env.scoped.outcome' } });
    await api(env, env.secretToken, 'POST', `${P()}/experiments/prepare`,
      preparedSetup('env_scoped', 'env_scoped_outcome'));
    await api(env, env.secretToken, 'POST', `${P()}/experiments/env_scoped/launch`, {});

    const dev = await api(env, env.ingestDevToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'env_scoped_flag', distinct_id: 'env-actor',
    });
    expect(dev.status).toBe(200);
    expect(dev.body).toEqual({ key: 'env_scoped_flag', variant: null });
    const prod = await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'env_scoped_flag', distinct_id: 'env-actor',
    });
    expect(prod.status).toBe(200);
    expect(prod.body.variant).not.toBeNull();
    const wrongResults = await api(env, env.secretToken, 'GET', `${P()}/experiments/env_scoped/results?env=dev`);
    expect(wrongResults.status).toBe(409);
    expect(wrongResults.body.error.code).toBe('experiment_environment_mismatch');

    await createActiveFlag('legacy_all_env_flag');
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'legacy_all_env_flag', distinct_id: 'legacy-prod',
    })).body.variant).not.toBeNull();
    expect((await api(env, env.ingestDevToken, 'POST', '/i/v1/flags/evaluate', {
      key: 'legacy_all_env_flag', distinct_id: 'legacy-dev',
    })).body.variant).not.toBeNull();
  });

  it('freezes snapshots for the legacy start endpoint without changing its request shape', async () => {
    await activeMetric(env, { key: 'legacy_start_outcome', source: { event: 'legacy.start.outcome' } });
    await createActiveFlag('legacy_start_flag');
    await createAndStartExperiment('legacy_start_experiment', 'legacy_start_flag', 'legacy_start_outcome');
    const listed = await api(env, env.secretToken, 'GET', `${P()}/experiments`);
    expect(listed.body.experiments.find((experiment: { key: string }) => experiment.key === 'legacy_start_experiment')).toMatchObject({
      env: null,
      control_variant_key: 'control',
      snapshot_integrity: 'frozen_at_start',
    });
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
