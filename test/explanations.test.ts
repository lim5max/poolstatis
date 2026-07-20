import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

const DAY = 86_400_000;

describe('bounded root-cause hypotheses', () => {
  let env: TestEnv;
  let decisionId: string;
  let anchor: Date;

  beforeAll(async () => {
    env = await createTestEnv();
    anchor = new Date(Date.now() - 3 * DAY);
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    await api(env, env.secretToken, 'PATCH', path('/metrics/activation_completed'), { tags: ['onboarding'], category: 'activation' });
    await activeMetric(env, {
      key: 'setup_completed', type: 'unique_actors',
      purpose: 'Measures whether actors complete setup during onboarding.',
      source: { event: 'setup.completed', filters: [] },
    });
    await api(env, env.secretToken, 'PATCH', path('/metrics/setup_completed'), { tags: ['onboarding'], category: 'activation' });
    await activeMetric(env, {
      key: 'raw_noise_metric', type: 'unique_actors',
      purpose: 'A low-evidence candidate that must not appear as an explanation.',
      source: { event: 'totally.unregistered.noise', filters: [] },
    });
    await api(env, env.secretToken, 'POST', path('/properties'), {
      key: 'plan', scope: 'event', value_type: 'string', status: 'trusted',
      purpose: 'Segments activation evidence by the commercial plan selected by an actor.',
    });
    await api(env, env.secretToken, 'POST', path('/properties'), {
      key: 'channel', scope: 'event', value_type: 'string', status: 'trusted',
      purpose: 'Segments activation evidence by the registered acquisition channel.',
    });
    await api(env, env.secretToken, 'POST', path('/properties'), {
      key: 'private_note', scope: 'event', value_type: 'string', status: 'untrusted',
      purpose: 'A known unsafe property that explanations must never inspect.',
    });
    const declaration = { version: 1, contracts: [{
      key: 'explain_onboarding', name: 'Explain onboarding',
      business_hypothesis: 'A shorter setup should increase first activation.',
      decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
      guardrail_metric_keys: [], target_filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
      baseline_window_days: 1, observation_window_days: 1, minimum_sample_size: 3,
      expected_direction: 'increase', minimum_meaningful_effect: 0.1,
      references: {}, status: 'active',
    }] };
    const diff = await api(env, env.secretToken, 'POST', path('/contracts/diff'), declaration);
    await api(env, env.secretToken, 'POST', path('/contracts/apply'), { declaration, expected_revision: diff.body.expected_revision });
    await ingest();
    const release = await api(env, env.secretToken, 'POST', path('/releases'), {
      idempotency_key: 'explain-release', contract_key: 'explain_onboarding', env: 'prod',
      repository: 'acme/product', commit_sha: 'e'.repeat(40), deployed_at: anchor.toISOString(), status: 'deployed',
    });
    const evaluated = await api(env, env.secretToken, 'POST', path(`/releases/${release.body.id}/evaluate`), {});
    expect(evaluated.body.evidence.ready).toBe(true);
    decisionId = evaluated.body.decision.id;
  });

  afterAll(async () => env.close());

  test('ranks only registered metrics and trusted properties with executable supporting Query DSL', async () => {
    const explained = await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/explain`), {});
    expect(explained.status).toBe(201);
    expect(explained.body).toMatchObject({ label: 'hypothesis', algorithm_version: 'v1' });
    expect(explained.body.candidates[0]).toMatchObject({
      kind: 'metric', key: 'setup_completed', interpretation: 'hypothesis',
      strength: expect.stringMatching(/strong|medium|weak/),
      supporting_query: { baseline: { kind: 'trend', metric: 'setup_completed' }, observed: { kind: 'trend', metric: 'setup_completed' } },
    });
    expect(explained.body.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'property', key: 'plan', interpretation: 'hypothesis' }),
      expect.objectContaining({ kind: 'property', key: 'channel', interpretation: 'hypothesis' }),
    ]));
    const serialized = JSON.stringify(explained.body);
    expect(serialized).not.toContain('totally.unregistered.noise');
    expect(serialized).not.toContain('private_note');
    expect(serialized).not.toContain('caused');

    for (const query of [
      explained.body.candidates[0].supporting_query.baseline,
      explained.body.candidates[0].supporting_query.observed,
    ]) {
      const run = await api(env, env.secretToken, 'POST', path('/query'), query);
      expect(run.status).toBe(200);
    }
  });

  test('is deterministic and persists the exact historical ranking once', async () => {
    const first = await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/explain`), {});
    const second = await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/explain`), {});
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const listed = await api(env, env.secretToken, 'GET', path(`/decisions/${decisionId}/explanations`));
    expect(listed.body.explanations).toEqual([first.body]);
  });

  async function ingest() {
    const events: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 5; index++) {
      events.push({ event: 'activation.completed', distinct_id: `base-a-${index}`, timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: { plan: 'pro', channel: 'organic' } });
      events.push({ event: 'setup.completed', distinct_id: `base-s-${index}`, timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: { plan: 'pro' } });
    }
    for (let index = 0; index < 8; index++) {
      events.push({ event: 'activation.completed', distinct_id: `obs-a-${index}`, timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: { plan: 'pro', channel: 'organic' } });
      events.push({ event: 'setup.completed', distinct_id: `obs-s-${index}`, timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: { plan: 'pro' } });
    }
    const response = await api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'explanation-events', events });
    expect(response.status).toBe(200);
  }
  function path(suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
});
