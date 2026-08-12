import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, hoursAgo, type TestEnv } from './helpers.js';

let env: TestEnv;
let foreign: TestEnv;
const P = (target: TestEnv) => `/api/v1/projects/${target.projectSlug}`;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  foreign = await createTestEnv({ ingestBuffer: false, queryCache: false });
  for (const target of [env, foreign]) {
    await activeMetric(target, {
      key: 'journey_started',
      type: 'unique_actors',
      source: { event: 'journey.started', filters: [] },
      purpose: 'Measure actors who enter the saved product journey.',
    });
    await activeMetric(target, {
      key: 'journey_completed',
      type: 'unique_actors',
      source: { event: 'journey.completed', filters: [] },
      purpose: 'Measure actors who complete the saved product journey.',
    });
    expect((await api(target, target.secretToken, 'POST', `${P(target)}/funnels`, {
      key: 'activation_journey',
      name: 'Activation journey',
      goal: 'Measure whether actors complete the first meaningful product journey.',
      steps: [
        { metric_key: 'journey_started', label: 'Started' },
        { metric_key: 'journey_completed', label: 'Completed' },
      ],
      window_seconds: 86_400,
    })).status).toBe(201);
  }
  const startedAt = hoursAgo(2);
  const completedAt = hoursAgo(1);
  expect((await api(env, env.ingestToken, 'POST', '/i/v1/events', {
    batch_id: 'funnel-investigation-events',
    events: [
      { event: 'journey.started', distinct_id: 'completed', timestamp: startedAt },
      { event: 'journey.completed', distinct_id: 'completed', timestamp: completedAt },
      { event: 'journey.started', distinct_id: 'lost', timestamp: startedAt },
    ],
  })).status).toBe(200);
});

afterAll(async () => {
  await env.close();
  await foreign.close();
});

describe('immutable funnel investigation evidence', () => {
  it('reproduces a saved funnel server-side and persists exact lineage idempotently', async () => {
    const dateTo = new Date().toISOString();
    const dateFrom = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const body = {
      idempotency_key: 'activation-journey-investigation-1',
      funnel: 'activation_journey', env: 'prod',
      date_from: dateFrom, date_to: dateTo,
      from_step: 0, to_step: 1,
    };
    const created = await api(env, env.secretToken, 'POST', `${P(env)}/funnel-investigations`, body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      idempotent: false,
      investigation: {
        env: 'prod',
        saved_funnel: { key: 'activation_journey', goal: expect.stringContaining('meaningful product journey') },
        transition: {
          from_step: 0, to_step: 1,
          from_metric: 'journey_started', to_metric: 'journey_completed',
        },
        query_spec: {
          kind: 'funnel', funnel: 'activation_journey', env: 'prod',
          date_from: new Date(dateFrom).toISOString(), date_to: new Date(dateTo).toISOString(),
        },
        query_result: {
          kind: 'funnel',
          steps: [{ actors: 2 }, { actors: 1 }],
          summary: { biggest_absolute_loss: { from_step: 0, to_step: 1, lost_actors: 1 } },
        },
        evidence: {
          source_refs: [{ kind: 'funnel', key: 'activation_journey' }],
          reproducible_query: { kind: 'funnel', funnel: 'activation_journey', env: 'prod' },
        },
        lineage: {
          query_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          result_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        created_by: expect.stringMatching(/^key:/),
        created_at: expect.any(String),
      },
    });

    const repeated = await api(env, env.secretToken, 'POST', `${P(env)}/funnel-investigations`, body);
    expect(repeated.status).toBe(200);
    expect(repeated.body.idempotent).toBe(true);
    expect(repeated.body.investigation.id).toBe(created.body.investigation.id);

    const listed = await api(env, env.secretToken, 'GET', `${P(env)}/funnel-investigations?env=prod&funnel=activation_journey&limit=10`);
    expect(listed.status).toBe(200);
    expect(listed.body.investigations).toHaveLength(1);
    expect(listed.body.investigations[0]).toEqual(created.body.investigation);

    const read = await api(env, env.secretToken, 'GET', `${P(env)}/funnel-investigations/${created.body.investigation.id}`);
    expect(read.body.investigation).toEqual(created.body.investigation);

    const raw = await env.pool.query('SELECT count(*)::int AS count FROM funnel_investigations WHERE project_id = $1', [env.projectId]);
    expect(raw.rows[0].count).toBe(1);
    await expect(env.pool.query(
      'UPDATE funnel_investigations SET created_by = $1 WHERE id = $2',
      ['tampered', created.body.investigation.id],
    )).rejects.toMatchObject({ code: '55000' });

    const retained = await api(env, env.secretToken, 'DELETE', `${P(env)}/funnels/activation_journey`);
    expect(retained.status).toBe(409);
    expect(retained.body.error.code).toBe('funnel_in_use');
  });

  it('rejects forged results, non-adjacent transitions, reused keys and cross-tenant reads', async () => {
    const dateTo = new Date().toISOString();
    const dateFrom = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const invalid = await api(env, env.secretToken, 'POST', `${P(env)}/funnel-investigations`, {
      idempotency_key: 'invalid-non-adjacent-transition', funnel: 'activation_journey', env: 'prod',
      date_from: dateFrom, date_to: dateTo, from_step: 0, to_step: 2,
      query_result: { steps: [{ actors: 999999 }] }, evidence: { state: 'trusted' },
    });
    expect(invalid.status).toBe(400);

    const created = await api(env, env.secretToken, 'POST', `${P(env)}/funnel-investigations`, {
      idempotency_key: 'reused-investigation-key', funnel: 'activation_journey', env: 'prod',
      date_from: dateFrom, date_to: dateTo, from_step: 0, to_step: 1,
    });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain('999999');

    const reused = await api(env, env.secretToken, 'POST', `${P(env)}/funnel-investigations`, {
      idempotency_key: 'reused-investigation-key', funnel: 'activation_journey', env: 'dev',
      date_from: dateFrom, date_to: dateTo, from_step: 0, to_step: 1,
    });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reused');

    const foreignRead = await api(foreign, foreign.secretToken, 'GET', `${P(foreign)}/funnel-investigations/${created.body.investigation.id}`);
    expect(foreignRead.status).toBe(404);
    const crossSlug = await api(foreign, foreign.secretToken, 'GET', `${P(env)}/funnel-investigations/${created.body.investigation.id}`);
    expect(crossSlug.status).toBe(404);
  });

  it('allows an explicitly confirmed project deletion to remove the retained artifact', async () => {
    const deleted = await api(env, env.personalToken, 'DELETE', P(env), {
      confirm_slug: env.projectSlug,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true, slug: env.projectSlug });
    const retained = await env.pool.query(
      'SELECT count(*)::int AS count FROM funnel_investigations WHERE project_id = $1',
      [env.projectId],
    );
    expect(retained.rows[0].count).toBe(0);
  });
});
