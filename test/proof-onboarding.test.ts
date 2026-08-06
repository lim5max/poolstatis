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
    expect(gate(initial.body, 'data_source_connected').evidence.native_key_created_at).toBeTruthy();
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

    const devOnly = await api(env, env.ingestDevToken, 'POST', '/i/v1/events', {
      batch_id: 'onboarding-dev-only',
      events: [{ event: 'dev.only_event', distinct_id: 'dev-user' }],
    });
    expect(devOnly.status).toBe(200);
    const prodAfterDev = await api(env, env.secretToken, 'GET', statusUrl());
    expect(gate(prodAfterDev.body, 'first_event_observed')).toMatchObject({
      complete: false,
      evidence: {
        event_name: null,
        env: 'prod',
        registered: null,
      },
    });
    const devStatus = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/onboarding/status?env=dev`,
    );
    expect(gate(devStatus.body, 'first_event_observed')).toMatchObject({
      complete: true,
      evidence: {
        event_name: 'dev.only_event',
        env: 'dev',
        registered: false,
      },
    });

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
    expect(gate(afterWild.body, 'first_event_observed').evidence).toMatchObject({
      observation_source: 'native',
      event_name: 'wild.event',
      env: 'prod',
      registered: false,
    });
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

    const afterRegistered = await api(env, env.secretToken, 'GET', statusUrl());
    expect(gate(afterRegistered.body, 'first_event_observed').evidence).toMatchObject({
      event_name: 'signup.completed',
      env: 'prod',
      registered: true,
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

    const completed = await api(env, env.secretToken, 'GET', statusUrl());
    expect(completed.status).toBe(200);
    expect(completed.body.complete).toBe(true);
    expect(gate(completed.body, 'agent_connected').complete).toBe(false);
    expect(completed.body.gates.filter((item: { required: boolean }) => item.required)
      .every((item: { complete: boolean }) => item.complete)).toBe(true);
    expect(completed.body.final_result).toMatchObject({
      metric_key: 'signup_completed',
      metric_purpose: 'Shows whether new users finish signup and reach the activation path.',
      next_action: 'Keep measuring the activation handoff after signup.',
    });
    expect(completed.body.final_result.query_window.from).toBeTruthy();
    expect(JSON.stringify(completed.body)).not.toContain(env.secretToken);
    expect(JSON.stringify(completed.body)).not.toContain(env.ingestToken);

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
    const afterMcpMarkedRequest = await api(env, env.secretToken, 'GET', statusUrl());
    expect(afterMcpMarkedRequest.body.gates.every((item: { complete: boolean }) => item.complete)).toBe(true);
    expect(gate(afterMcpMarkedRequest.body, 'agent_connected').evidence).toMatchObject({ client: 'codex' });
    expect(gate(afterMcpMarkedRequest.body, 'agent_connected').evidence.observed_at).toBeTruthy();

    const reloaded = await api(env, env.secretToken, 'GET', statusUrl());
    expect(reloaded.body).toEqual(afterMcpMarkedRequest.body);

    const unrelated = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/insights',
      {
        title: 'Unexecuted retention idea',
        body: 'This must not be joined to the latest successful signup query.',
        query: {
          kind: 'trend',
          metric: 'signup_completed',
          date_from: '-30d',
          interval: 'week',
          env: 'prod',
        },
        severity: 'info',
      },
    );
    expect(unrelated.status).toBe(201);

    const afterUnrelatedInsight = await api(env, env.secretToken, 'GET', statusUrl());
    expect(afterUnrelatedInsight.body.final_result).toEqual(completed.body.final_result);
    expect(gate(afterUnrelatedInsight.body, 'first_decision_saved').evidence.title).toBe('Signup completion observed');

    await env.pool.query(
      `UPDATE api_keys SET revoked_at = now()
       WHERE project_id = $1 AND kind = 'ingest' AND env = 'prod'`,
      [env.projectId],
    );
    const afterRevoke = await api(env, env.secretToken, 'GET', statusUrl());
    expect(gate(afterRevoke.body, 'data_source_connected').evidence.native).toBe(false);
    expect(gate(afterRevoke.body, 'data_source_connected').evidence.native_key_created_at).toBeNull();
  });

  test('links a saved funnel insight only to its executed funnel and uses the terminal metric', async () => {
    const funnelEnv = await createTestEnv();
    try {
      await activeMetric(funnelEnv, {
        key: 'funnel_started',
        purpose: 'Shows whether a user enters the activation journey.',
        source: { event: 'funnel.started', filters: [] },
      });
      await activeMetric(funnelEnv, {
        key: 'funnel_completed',
        purpose: 'Shows whether a user reaches the activation outcome.',
        source: { event: 'funnel.completed', filters: [] },
      });
      await api(funnelEnv, funnelEnv.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'onboarding-funnel',
        events: [
          { event: 'funnel.started', distinct_id: 'funnel-user' },
          { event: 'funnel.completed', distinct_id: 'funnel-user' },
        ],
      });
      const queryBody = {
        kind: 'funnel',
        steps: [{ metric: 'funnel_started' }, { metric: 'funnel_completed' }],
        date_from: '-1d',
        env: 'prod',
      };
      expect((await api(funnelEnv, funnelEnv.secretToken, 'POST',
        `/api/v1/projects/${funnelEnv.projectSlug}/query`, queryBody)).status).toBe(200);
      expect((await api(funnelEnv, funnelEnv.secretToken, 'POST',
        `/api/v1/projects/${funnelEnv.projectSlug}/insights`, {
          title: 'Activation funnel observed',
          body: 'Investigate the handoff before expanding instrumentation.',
          query: queryBody,
          severity: 'info',
        })).status).toBe(201);

      const status = await api(funnelEnv, funnelEnv.secretToken, 'GET',
        `/api/v1/projects/${funnelEnv.projectSlug}/onboarding/status?env=prod`);
      expect(gate(status.body, 'first_decision_saved').complete).toBe(true);
      expect(status.body.final_result).toMatchObject({
        metric_key: 'funnel_completed',
        metric_purpose: 'Shows whether a user reaches the activation outcome.',
        next_action: 'Investigate the handoff before expanding instrumentation.',
      });
    } finally {
      await funnelEnv.close();
    }
  });
});

function gate(body: any, key: string): any {
  const found = body.gates.find((item: { key: string }) => item.key === key);
  expect(found, 'missing onboarding gate ' + key).toBeTruthy();
  return found;
}
