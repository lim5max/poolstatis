import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';
import { analysisViewInput } from './analysis-view-fixtures.js';

let env: TestEnv;
let affectedAnswerId: string;

beforeAll(async () => {
  env = await createTestEnv();
  await activeMetric(env, {
    key: 'activation_completed',
    type: 'unique_actors',
    source: { event: 'activation.completed', filters: [] },
    purpose: 'Measures the first meaningful activation completion outcome.',
  });
  expect((await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/properties`, {
    key: 'plan_tier', scope: 'event', value_type: 'string',
    purpose: 'Segments activation outcomes by the trusted product plan tier.',
    status: 'trusted', source: 'native',
  })).status).toBe(201);
  const created = await api(
    env,
    env.secretToken,
    'POST',
    `/api/v1/projects/${env.projectSlug}/analysis-views`,
    analysisViewInput(env.projectSlug, 'prod', 'activation_completed', 'plan_tier'),
  );
  expect(created.status).toBe(201);
  affectedAnswerId = created.body.view.id;
  expect((await api(
    env,
    env.secretToken,
    'POST',
    `/api/v1/projects/${env.projectSlug}/funnels`,
    {
      key: 'activation_path',
      name: 'Activation path',
      goal: 'Measures whether the first meaningful activation outcome is reached.',
      steps: [
        { metric_key: 'activation_completed', label: 'Activated' },
        { metric_key: 'activation_completed', label: 'Activated again' },
      ],
      window_seconds: 86_400,
    },
  )).status).toBe(201);
  expect((await api(
    env,
    env.secretToken,
    'POST',
    `/api/v1/projects/${env.projectSlug}/metrics`,
    {
      key: 'web_page_views',
      name: 'Canonical page views',
      type: 'count',
      source: { event: 'page.viewed', filters: [] },
      purpose: 'Measures accepted canonical browser page views for Web answers.',
      tags: ['surface:web'],
    },
  )).status).toBe(201);
});

afterAll(async () => {
  await env.close();
});

describe('server-owned measurement readiness', () => {
  it('returns four definition groups with server-ranked gaps and affected saved-answer ids', async () => {
    expect((await api(
      env,
      env.secretToken,
      'PATCH',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed`,
      { status: 'proposed' },
    )).status).toBe(200);
    expect((await api(
      env,
      env.secretToken,
      'PATCH',
      `/api/v1/projects/${env.projectSlug}/properties/event/plan_tier`,
      { status: 'untrusted' },
    )).status).toBe(200);

    const readiness = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/readiness?env=prod`,
    );
    expect(readiness.status).toBe(200);
    expect(readiness.body).toMatchObject({
      schema_version: 1,
      project: env.projectSlug,
      env: 'prod',
    });
    expect(readiness.body.groups.map((group: { key: string }) => group.key)).toEqual([
      'tracking_plan', 'properties', 'identity', 'data_sources',
    ]);

    const tracking = readiness.body.groups.find((group: { key: string }) => group.key === 'tracking_plan');
    expect(tracking).toMatchObject({ highest_severity: 'high' });
    expect(tracking.incomplete_count).toBeGreaterThan(0);
    expect(tracking.gaps).toContainEqual(expect.objectContaining({
      code: 'metric_inactive',
      affected_answer_ids: expect.arrayContaining([
        affectedAnswerId,
        'funnel:activation_path',
        'home',
      ]),
      repair_action: expect.objectContaining({ action_code: 'activate_metric' }),
    }));
    expect(tracking.gaps).toContainEqual(expect.objectContaining({
      code: 'metric_inactive',
      definition_ref: 'web_page_views',
      affected_answer_ids: expect.arrayContaining(['web']),
    }));
    expect(readiness.body.answer_dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ answer_id: 'home', surface: 'home', href: '/' }),
      expect.objectContaining({ answer_id: 'web', surface: 'web', href: '/analyze/web' }),
      expect.objectContaining({
        answer_id: 'funnel:activation_path',
        surface: 'funnel',
        funnel_key: 'activation_path',
        metric_keys: ['activation_completed'],
      }),
      expect.objectContaining({ answer_id: affectedAnswerId, surface: 'saved' }),
    ]));

    const properties = readiness.body.groups.find((group: { key: string }) => group.key === 'properties');
    expect(properties.gaps).toContainEqual(expect.objectContaining({
      code: 'property_untrusted',
      affected_answer_ids: [affectedAnswerId],
      repair_action: expect.objectContaining({ action_code: 'review_property' }),
    }));
    expect(readiness.body.fix_next).toMatchObject({
      group: 'tracking_plan',
      action_code: 'activate_metric',
      href: '/registry?metric=activation_completed',
    });
    expect(JSON.stringify(readiness.body)).not.toContain('Measures the first');
    expect(JSON.stringify(readiness.body)).not.toContain('plan tier');
  });

  it('ranks an environment data-source blocker above definition repairs without leaking another environment', async () => {
    await env.pool.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE project_id = $1 AND kind = 'ingest' AND env = 'prod'`,
      [env.projectId],
    );
    const readiness = await api(
      env,
      env.personalToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/readiness?env=prod`,
    );
    expect(readiness.status).toBe(200);
    const sources = readiness.body.groups.find((group: { key: string }) => group.key === 'data_sources');
    expect(sources).toMatchObject({ highest_severity: 'critical' });
    expect(sources.gaps).toContainEqual(expect.objectContaining({
      code: 'data_source_missing',
      affected_answer_ids: expect.arrayContaining([
        affectedAnswerId,
        'funnel:activation_path',
        'home',
        'web',
      ]),
    }));
    expect(readiness.body.fix_next).toMatchObject({
      group: 'data_sources',
      action_code: 'connect_data_source',
      href: '/setup?env=prod',
    });

    const dev = await api(
      env,
      env.personalToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/readiness?env=dev`,
    );
    expect(dev.status).toBe(200);
    expect(dev.body.groups.flatMap((group: { gaps: Array<{ affected_answer_ids: string[] }> }) =>
      group.gaps.flatMap((gap) => gap.affected_answer_ids))).not.toContain(affectedAnswerId);
  });

  it('assesses every active actor-dependent metric even when no saved answer references it', async () => {
    await activeMetric(env, {
      key: 'retained_actor',
      type: 'unique_actors',
      source: { event: 'retention.observed', filters: [] },
      purpose: 'Measures whether a known actor returned in the current window.',
    });
    const readiness = await api(
      env,
      env.personalToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/readiness?env=dev`,
    );
    expect(readiness.status).toBe(200);
    const identity = readiness.body.groups.find((group: { key: string }) => group.key === 'identity');
    expect(identity.gaps).toContainEqual(expect.objectContaining({
      code: 'identity_evidence_unavailable',
      definition_ref: 'retained_actor',
      affected_answer_ids: expect.arrayContaining(['home', 'product:retained_actor']),
    }));
    expect(readiness.body.answer_dependencies).toContainEqual(expect.objectContaining({
      answer_id: 'product:retained_actor',
      href: '/analyze/product?metric=retained_actor',
    }));
  });

  it('reports missing required metrics and an unqueryable answer when the registry is empty', async () => {
    const empty = await createTestEnv({ ingestBuffer: false });
    try {
      const intent = await api(empty, empty.secretToken, 'PUT', `/api/v1/projects/${empty.projectSlug}/intent`, {
        project_mode: 'website',
        website_domain: 'example.com',
        goal_ids: ['website_traffic'],
        custom_goal: null,
        primary_goal_id: 'website_traffic',
      });
      expect(intent.status).toBe(200);

      const readiness = await api(
        empty,
        empty.secretToken,
        'GET',
        `/api/v1/projects/${empty.projectSlug}/readiness?env=prod`,
      );
      expect(readiness.status).toBe(200);
      const tracking = readiness.body.groups.find((item: { key: string }) => item.key === 'tracking_plan');
      expect(tracking.gaps).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'metric_missing',
          definition_ref: 'web_page_views',
          affected_answer_ids: expect.arrayContaining(['home', 'web']),
          repair_action: expect.objectContaining({ action_code: 'register_metric' }),
        }),
        expect.objectContaining({
          code: 'answer_not_queryable',
          definition_ref: 'home',
          affected_answer_ids: ['home'],
          repair_action: expect.objectContaining({ action_code: 'configure_answer' }),
        }),
      ]));
      expect(readiness.body.fix_next).toMatchObject({
        gap_code: 'metric_missing',
        action_code: 'register_metric',
      });
    } finally {
      await empty.close();
    }
  });
});
