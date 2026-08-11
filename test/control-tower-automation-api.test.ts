import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

describe('control tower automation REST contract', () => {
  let env: TestEnv;
  let other: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
    other = await createTestEnv();
    await activeMetric(env, {
      key: 'activation_completed',
      purpose: 'Measures whether a product actor reaches the activation outcome.',
      source: { event: 'activation.completed', filters: [] },
    });
  });
  afterAll(async () => { await Promise.all([env.close(), other.close()]); });

  test('exposes truthful provider capability and explicit project destinations', async () => {
    const capabilities = await api(env, env.secretToken, 'GET', path('/automation/capabilities'));
    expect(capabilities).toEqual({
      status: 200,
      body: {
        in_product: 'configured',
        outbox: 'configured',
        external: 'not_configured',
      },
    });
    const destination = await api(env, env.secretToken, 'POST', path('/automation/destinations'), {
      key: 'owner_inbox', name: 'Owner inbox', kind: 'in_product',
    });
    expect(destination.status).toBe(201);
    expect(destination.body).toMatchObject({ key: 'owner_inbox', kind: 'in_product', status: 'active' });
    expect(JSON.stringify(destination.body)).not.toMatch(/url|authorization|credential|token/i);
    const disabled = await api(env, env.secretToken, 'PATCH', path(`/automation/destinations/${destination.body.id}`), { status: 'disabled' });
    expect(disabled.body.status).toBe('disabled');
    const audit = await env.pool.query(
      'SELECT event FROM notification_destination_audit WHERE project_id = $1 AND destination_id = $2 ORDER BY created_at, id',
      [env.projectId, destination.body.id],
    );
    expect(audit.rows.map((row) => row.event)).toEqual(['created', 'disabled']);
  });

  test('versions monitor policies and rejects stale revisions', async () => {
    const destination = await api(env, env.secretToken, 'POST', path('/automation/destinations'), {
      key: 'monitor_outbox', name: 'Monitor outbox', kind: 'outbox',
    });
    const created = await api(env, env.secretToken, 'POST', path('/monitors'), monitorInput([destination.body.id]));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      policy_key: 'activation_drop', current_version: 1, status: 'active',
      revision: { metric_key: 'activation_completed', threshold: 20, destination_ids: [destination.body.id] },
    });

    const revised = await api(env, env.secretToken, 'PATCH', path(`/monitors/${created.body.id}`), {
      expected_version: 1,
      revision: { ...monitorInput([destination.body.id]), threshold: 25 },
    });
    expect(revised.status).toBe(200);
    expect(revised.body).toMatchObject({ current_version: 2, revision: { threshold: 25 } });

    const stale = await api(env, env.secretToken, 'PATCH', path(`/monitors/${created.body.id}`), {
      expected_version: 1,
      revision: { ...monitorInput([destination.body.id]), threshold: 30 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('monitor_version_conflict');

    const paused = await api(env, env.secretToken, 'POST', path(`/monitors/${created.body.id}/lifecycle`), {
      expected_version: 2, status: 'paused',
    });
    expect(paused.body).toMatchObject({ status: 'paused', current_version: 2 });
    const read = await api(env, env.secretToken, 'GET', path(`/monitors/${created.body.id}`));
    expect(read.body).toMatchObject({ id: created.body.id, status: 'paused' });
  });

  test('rejects monitor targets and frozen proposal flags from another environment', async () => {
    const prodFlag = await api(env, env.secretToken, 'POST', path('/flags'), {
      key: 'prod_activation_rollout', name: 'Prod activation rollout',
      purpose: 'Controls the production activation rollout for monitor safety.',
      status: 'active', env: 'prod',
      variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }],
    });
    expect(prodFlag.status).toBe(201);
    const flagMismatch = await api(env, env.secretToken, 'POST', path('/monitors'), {
      ...monitorInput([]), policy_key: 'dev_policy_prod_flag', env: 'dev', proposal_kind: 'pause',
      proposal_target: {
        flag_key: 'prod_activation_rollout',
        variants: [{ key: 'control', rollout_percentage: 100 }, { key: 'test', rollout_percentage: 0 }],
      },
    });
    expect(flagMismatch.status).toBe(409);
    expect(flagMismatch.body.error.code).toBe('monitor_environment_mismatch');

    const devFlag = await api(env, env.secretToken, 'POST', path('/flags'), {
      key: 'dev_activation_rollout', name: 'Dev activation rollout',
      purpose: 'Controls the development activation rollout for monitor safety.',
      status: 'active', env: 'dev',
      variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }],
    });
    expect(devFlag.status).toBe(201);
    const experiment = await api(env, env.secretToken, 'POST', path('/experiments'), {
      key: 'dev_activation_experiment', name: 'Dev activation experiment',
      hypothesis: 'The development rollout should improve the activation outcome.',
      flag_key: 'dev_activation_rollout', primary_metric_key: 'activation_completed',
      secondary_metric_keys: [], env: 'dev', control_variant_key: 'control',
    });
    expect(experiment.status).toBe(201);
    const experimentMismatch = await api(env, env.secretToken, 'POST', path('/monitors'), {
      ...monitorInput([]), policy_key: 'prod_policy_dev_experiment', env: 'prod',
      target_kind: 'experiment', target_id: experiment.body.id,
    });
    expect(experimentMismatch.status).toBe(409);
    expect(experimentMismatch.body.error.code).toBe('monitor_environment_mismatch');

    const declaration = { version: 1, contracts: [{
      key: 'environment_safe_release', name: 'Environment-safe release',
      business_hypothesis: 'The monitored release should improve product activation.',
      decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
      guardrail_metric_keys: [], target_filters: [], baseline_window_days: 1,
      observation_window_days: 1, minimum_sample_size: 10,
      expected_direction: 'increase', minimum_meaningful_effect: 0.1,
      references: {}, status: 'active',
    }] };
    const diff = await api(env, env.secretToken, 'POST', path('/contracts/diff'), declaration);
    expect(diff.status).toBe(200);
    const applied = await api(env, env.secretToken, 'POST', path('/contracts/apply'), {
      declaration, expected_revision: diff.body.expected_revision,
    });
    expect(applied.status).toBe(200);
    const release = await api(env, env.secretToken, 'POST', path('/releases'), {
      idempotency_key: 'dev-environment-safe-release', contract_key: 'environment_safe_release',
      env: 'dev', repository: 'acme/product', commit_sha: 'd'.repeat(40),
      flag_key: 'dev_activation_rollout', status: 'planned',
    });
    expect(release.status).toBe(201);
    const releaseMismatch = await api(env, env.secretToken, 'POST', path('/monitors'), {
      ...monitorInput([]), policy_key: 'prod_policy_dev_release', env: 'prod',
      target_kind: 'release', target_id: release.body.id,
    });
    expect(releaseMismatch.status).toBe(409);
    expect(releaseMismatch.body.error.code).toBe('monitor_environment_mismatch');

    const otherDevFlag = await api(env, env.secretToken, 'POST', path('/flags'), {
      key: 'dev_other_rollout', name: 'Other dev rollout',
      purpose: 'Controls another development rollout that is not linked to the experiment.',
      status: 'active', env: 'dev',
      variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }],
    });
    expect(otherDevFlag.status).toBe(201);
    const linkedFlagMismatch = await api(env, env.secretToken, 'POST', path('/monitors'), {
      ...monitorInput([]), policy_key: 'dev_experiment_wrong_flag', env: 'dev',
      target_kind: 'experiment', target_id: experiment.body.id, proposal_kind: 'pause',
      proposal_target: {
        flag_key: 'dev_other_rollout',
        variants: [{ key: 'control', rollout_percentage: 100 }, { key: 'test', rollout_percentage: 0 }],
      },
    });
    expect(linkedFlagMismatch.status).toBe(409);
    expect(linkedFlagMismatch.body.error.code).toBe('monitor_proposal_target_mismatch');

    const valid = await api(env, env.secretToken, 'POST', path('/monitors'), {
      ...monitorInput([]), policy_key: 'dev_experiment_safe_flag', env: 'dev',
      target_kind: 'experiment', target_id: experiment.body.id, proposal_kind: 'pause',
      proposal_target: {
        flag_key: 'dev_activation_rollout',
        variants: [{ key: 'control', rollout_percentage: 100 }, { key: 'test', rollout_percentage: 0 }],
      },
    });
    expect(valid.status).toBe(201);
  });

  test('creates a timezone-aware scheduled semantic feed and preserves tenant isolation', async () => {
    const destination = await api(env, env.secretToken, 'POST', path('/automation/destinations'), {
      key: 'daily_inbox', name: 'Daily inbox', kind: 'in_product',
    });
    const created = await api(env, env.secretToken, 'POST', path('/insight-feed/schedules'), {
      schedule_key: 'daily_activation', name: 'Daily activation', env: 'prod',
      metric_key: 'activation_completed', template_kind: 'metric_trend', window_days: 7,
      timezone: 'America/New_York', frequency: 'daily', local_time: '09:15', weekday: null,
      destination_ids: [destination.body.id], owner: 'growth-team',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      schedule_key: 'daily_activation', current_version: 1, status: 'active',
      revision: { timezone: 'America/New_York', local_time: '09:15:00' },
    });
    expect(new Date(created.body.next_run_at).toString()).not.toBe('Invalid Date');

    const revised = await api(env, env.secretToken, 'PATCH', path(`/insight-feed/schedules/${created.body.id}`), {
      expected_version: 1,
      revision: {
        schedule_key: 'daily_activation', name: 'Weekday activation', env: 'prod',
        metric_key: 'activation_completed', template_kind: 'metric_trend', window_days: 14,
        timezone: 'America/New_York', frequency: 'weekly', local_time: '09:15', weekday: 1,
        destination_ids: [destination.body.id], owner: 'growth-team',
      },
    });
    expect(revised.body).toMatchObject({ current_version: 2, revision: { frequency: 'weekly', weekday: 1, window_days: 14 } });
    const paused = await api(env, env.secretToken, 'POST', path(`/insight-feed/schedules/${created.body.id}/lifecycle`), {
      expected_version: 2, status: 'paused',
    });
    expect(paused.body.status).toBe('paused');

    const denied = await api(other, other.secretToken, 'GET',
      `/api/v1/projects/${env.projectSlug}/monitors`);
    expect(denied.status).toBe(404);
    const ingestDenied = await api(env, env.ingestToken, 'GET', path('/monitors'));
    expect(ingestDenied.status).toBe(403);
  });

  function path(suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
  function monitorInput(destinationIds: string[]) {
    return {
      policy_key: 'activation_drop', name: 'Activation drop', env: 'prod',
      target_kind: 'project', target_id: null, metric_key: 'activation_completed',
      comparison_rule: 'change_down_percent', threshold: 20, minimum_sample: 10,
      window_minutes: 1440, cadence_minutes: 60, cooldown_seconds: 3600,
      owner: 'growth-team', destination_ids: destinationIds,
      proposal_kind: null, proposal_target: null,
    };
  }
});
