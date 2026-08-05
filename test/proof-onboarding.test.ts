import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

describe('proof-gated onboarding', () => {
  let env: TestEnv;
  const statusUrl = () => '/api/v1/projects/' + env.projectSlug + '/onboarding/status?env=prod';

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.close();
  });

  test('derives every gate from persisted server evidence', async () => {
    const initial = await api(env, env.secretToken, 'GET', statusUrl());
    expect(initial.status).toBe(200);
    expect(gate(initial.body, 'workspace_created').complete).toBe(true);
    expect(gate(initial.body, 'data_source_connected').complete).toBe(true);
    expect(gate(initial.body, 'agent_connected').complete).toBe(false);
    expect(gate(initial.body, 'agent_connected').required).toBe(false);
    expect(initial.body.next_blocker.key).toBe('first_event_observed');
    expect(gate(initial.body, 'first_event_observed').complete).toBe(false);
    expect(gate(initial.body, 'metrics_activated').complete).toBe(false);
    expect(gate(initial.body, 'first_query_produced').complete).toBe(false);
    expect(gate(initial.body, 'first_decision_saved').complete).toBe(false);
    expect(gate(initial.body, 'agent_connected').blocker).toContain('MCP');

    const copiedOnly = await api(env, env.secretToken, 'GET', statusUrl());
    expect(gate(copiedOnly.body, 'agent_connected').complete).toBe(false);

    const unproved = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/onboarding/observe-agent',
      { client: 'codex' },
    );
    expect(unproved.status).toBe(400);
    expect(unproved.body.error.code).toBe('mcp_observation_required');

    const wild = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'onboarding-wild',
      events: [{ event: 'wild.event', distinct_id: 'u1' }],
    });
    expect(wild.status).toBe(200);
    const afterWild = await api(env, env.secretToken, 'GET', statusUrl());
    expect(gate(afterWild.body, 'first_event_observed').complete).toBe(true);
    expect(gate(afterWild.body, 'metrics_activated').complete).toBe(false);

    await activeMetric(env, {
      key: 'signup_completed',
      type: 'unique_actors',
      purpose: 'Shows whether new users finish signup and reach the activation path.',
      source: { event: 'signup.completed', filters: [] },
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'onboarding-registered',
      events: [{ event: 'signup.completed', distinct_id: 'u1' }],
    });

    const queryBody = {
      kind: 'trend',
      metric: 'signup_completed',
      date_from: '-1d',
      interval: 'day',
      env: 'prod',
    };
    const query = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/query',
      queryBody,
    );
    expect(query.status).toBe(200);

    const insight = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/insights',
      {
        title: 'Signup completion observed',
        body: 'Keep measuring the activation handoff after signup.',
        query: queryBody,
        severity: 'info',
      },
    );
    expect(insight.status).toBe(201);

    const completedWithoutMcp = await api(env, env.secretToken, 'GET', statusUrl());
    expect(completedWithoutMcp.status).toBe(200);
    expect(completedWithoutMcp.body.complete).toBe(true);
    expect(gate(completedWithoutMcp.body, 'agent_connected').complete).toBe(false);
    expect(completedWithoutMcp.body.gates.filter((item: { required: boolean }) => item.required)
      .every((item: { complete: boolean }) => item.complete)).toBe(true);
    expect(completedWithoutMcp.body.final_result).toMatchObject({
      metric_key: 'signup_completed',
      metric_purpose: 'Shows whether new users finish signup and reach the activation path.',
      next_action: 'Keep measuring the activation handoff after signup.',
    });
    expect(completedWithoutMcp.body.final_result.query_window.from).toBeTruthy();
    expect(JSON.stringify(completedWithoutMcp.body)).not.toContain(env.secretToken);
    expect(JSON.stringify(completedWithoutMcp.body)).not.toContain(env.ingestToken);

    const observed = await env.app.inject({
      method: 'POST',
      url: '/api/v1/projects/' + env.projectSlug + '/onboarding/observe-agent',
      headers: {
        authorization: 'Bearer ' + env.secretToken,
        'x-poolstatis-client': 'mcp',
      },
      payload: { client: 'codex' },
    });
    expect(observed.statusCode).toBe(200);

    const completed = await api(env, env.secretToken, 'GET', statusUrl());
    expect(completed.body.complete).toBe(true);
    expect(completed.body.gates.every((item: { complete: boolean }) => item.complete)).toBe(true);

    const reloaded = await api(env, env.secretToken, 'GET', statusUrl());
    expect(reloaded.body).toEqual(completed.body);
  });
});

function gate(body: any, key: string): any {
  const found = body.gates.find((item: { key: string }) => item.key === key);
  expect(found, 'missing onboarding gate ' + key).toBeTruthy();
  return found;
}
