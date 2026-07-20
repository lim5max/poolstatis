import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

const DAY = 86_400_000;

describe('approval-gated decision actions', () => {
  let env: TestEnv;
  let decisionId: string;
  let releaseId: string;
  let anchor: Date;

  beforeAll(async () => {
    env = await createTestEnv();
    anchor = new Date(Date.now() - 3 * DAY);
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    await api(env, env.secretToken, 'POST', path('/flags'), {
      key: 'onboarding_flow', name: 'Onboarding flow',
      purpose: 'Controls the onboarding flow while product impact is measured.',
      status: 'active', variants: [
        { key: 'control', rollout_percentage: 50 },
        { key: 'test', rollout_percentage: 50 },
      ],
    });
    const declaration = { version: 1, contracts: [{
      key: 'action_change', name: 'Action change',
      business_hypothesis: 'The new onboarding should increase first activation.',
      decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
      guardrail_metric_keys: [], target_filters: [], baseline_window_days: 1,
      observation_window_days: 1, minimum_sample_size: 2,
      expected_direction: 'increase', minimum_meaningful_effect: 0.1,
      flag_key: 'onboarding_flow', references: {}, status: 'active',
    }] };
    const diff = await api(env, env.secretToken, 'POST', path('/contracts/diff'), declaration);
    await api(env, env.secretToken, 'POST', path('/contracts/apply'), { declaration, expected_revision: diff.body.expected_revision });
    const events = [
      { event: 'activation.completed', distinct_id: 'base-1', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'base-2', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-1', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-2', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-3', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
    ];
    await api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'action-evidence', events });
    const release = await api(env, env.secretToken, 'POST', path('/releases'), {
      idempotency_key: 'action-release', contract_key: 'action_change', env: 'prod',
      repository: 'acme/product', commit_sha: 'a'.repeat(40), deployed_at: anchor.toISOString(), status: 'deployed',
    });
    releaseId = release.body.id;
    const evaluated = await api(env, env.secretToken, 'POST', path(`/releases/${releaseId}/evaluate`), {});
    decisionId = evaluated.body.decision.id;
  });

  afterAll(async () => env.close());

  test('prepare is inert and exact approval executes a reversible flag rollback once', async () => {
    const prepared = await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/actions`), {
      action_type: 'prepare_flag_rollback', idempotency_key: 'rollback-flag-1',
      target: { environment: 'prod' },
      payload: { flag_key: 'onboarding_flow', variants: [{ key: 'control', rollout_percentage: 100 }, { key: 'test', rollout_percentage: 0 }] },
      expected_effect: 'Return all actors to the stable onboarding flow while preserving the measured release record.',
    });
    expect(prepared.status).toBe(201);
    expect(prepared.body).toMatchObject({
      action: {
        status: 'prepared', action_type: 'prepare_flag_rollback',
        evidence_id: expect.any(String), decision_revision: 1,
        undo: { action: 'restore_feature_flag', flag_key: 'onboarding_flow', variants: [{ key: 'control', rollout_percentage: 50 }, { key: 'test', rollout_percentage: 50 }] },
      },
      audit: [{ event: 'prepared' }],
    });
    let flags = await api(env, env.secretToken, 'GET', path('/flags'));
    expect(flags.body.flags[0].variants[0].rollout_percentage).toBe(50);

    const beforeDecision = await api(env, env.secretToken, 'POST', path(`/actions/${prepared.body.action.id}/approve`), {
      confirmation_fingerprint: prepared.body.action.confirmation_fingerprint,
    });
    expect(beforeDecision.status).toBe(409);
    expect(beforeDecision.body.error.code).toBe('decision_approval_required');
    await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/approve`), {
      rationale: 'The trusted measured activation improvement supports keeping the release.',
    });
    const wrong = await api(env, env.secretToken, 'POST', path(`/actions/${prepared.body.action.id}/approve`), {
      confirmation_fingerprint: '0'.repeat(64),
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.code).toBe('action_confirmation_mismatch');

    const approved = await api(env, env.secretToken, 'POST', path(`/actions/${prepared.body.action.id}/approve`), {
      confirmation_fingerprint: prepared.body.action.confirmation_fingerprint,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.action).toMatchObject({
      status: 'executed', approved_by: expect.stringMatching(/^key:/),
      result: { flag_key: 'onboarding_flow', release_id: releaseId },
    });
    expect(approved.body.audit.map((entry: { event: string }) => entry.event)).toEqual(['prepared', 'approved', 'executed']);
    expect(approved.body.audit[1].snapshot.payload).toEqual(prepared.body.action.payload);
    flags = await api(env, env.secretToken, 'GET', path('/flags'));
    expect(flags.body.flags[0].variants).toEqual([{ key: 'control', rollout_percentage: 100 }, { key: 'test', rollout_percentage: 0 }]);
    const retryApproval = await api(env, env.secretToken, 'POST', path(`/actions/${prepared.body.action.id}/approve`), {
      confirmation_fingerprint: prepared.body.action.confirmation_fingerprint,
    });
    expect(retryApproval.body.audit).toHaveLength(3);
  });

  test('schedules observation idempotently, prepares prompts, and keeps unsupported GitHub work inert', async () => {
    const at = new Date(Date.now() + DAY).toISOString();
    const scheduled = await prepare('schedule-observation-1', 'schedule_observation', { at });
    const duplicate = await prepare('schedule-observation-1', 'schedule_observation', { at });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.action.id).toBe(scheduled.body.action.id);
    const executed = await approve(scheduled.body.action);
    expect(executed.body.action).toMatchObject({ status: 'executed', result: { scheduled_at: at, release_id: releaseId } });

    const prompt = await prepare('draft-prompt-1', 'draft_implementation_prompt', {
      prompt: 'Inspect the accepted evidence and draft the smallest measurable follow-up change.',
    });
    const promptResult = await approve(prompt.body.action);
    expect(promptResult.body.action.result).toMatchObject({ ready: true, release_id: releaseId });

    const stable = await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/actions`), {
      action_type: 'draft_implementation_prompt', idempotency_key: 'stable-fingerprint-1',
      target: { repository: 'acme/product', branch: 'main' },
      payload: { prompt: 'Draft the smallest measurable follow-up change.', context: { owner: 'growth', priority: 1 } },
      expected_effect: 'Keep confirmation stable when equivalent JSON object keys arrive in a different order.',
    });
    const reordered = await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/actions`), {
      action_type: 'draft_implementation_prompt', idempotency_key: 'stable-fingerprint-1',
      target: { branch: 'main', repository: 'acme/product' },
      payload: { context: { priority: 1, owner: 'growth' }, prompt: 'Draft the smallest measurable follow-up change.' },
      expected_effect: 'Keep confirmation stable when equivalent JSON object keys arrive in a different order.',
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.action.id).toBe(stable.body.action.id);
    expect(reordered.body.action.confirmation_fingerprint).toBe(stable.body.action.confirmation_fingerprint);

    const github = await prepare('github-issue-1', 'create_issue', { title: 'Follow-up from decision' });
    const unsupported = await approve(github.body.action);
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe('action_capability_unsupported');
    const read = await api(env, env.secretToken, 'GET', path(`/actions/${github.body.action.id}`));
    expect(read.body.action.status).toBe('prepared');
  });

  test('failed generic delivery remains explicit and retry appends audit without pretending success', async () => {
    const webhook = await prepare('missing-webhook-1', 'generic_webhook', { event: 'decision.approved' });
    const failed = await approve(webhook.body.action);
    expect(failed.body.action).toMatchObject({ status: 'failed', error_code: 'webhook_destination_required' });
    const retried = await api(env, env.secretToken, 'POST', path(`/actions/${webhook.body.action.id}/retry`), {});
    expect(retried.body.action.status).toBe('failed');
    expect(retried.body.audit.map((entry: { event: string }) => entry.event)).toEqual([
      'prepared', 'approved', 'failed', 'retried', 'failed',
    ]);
  });

  async function prepare(key: string, actionType: string, payload: Record<string, unknown>) {
    return api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/actions`), {
      action_type: actionType, idempotency_key: key,
      target: { repository: 'acme/product' }, payload,
      expected_effect: 'Create a bounded follow-up while preserving the approved decision and its evidence.',
    });
  }
  async function approve(action: { id: string; confirmation_fingerprint: string }) {
    return api(env, env.secretToken, 'POST', path(`/actions/${action.id}/approve`), {
      confirmation_fingerprint: action.confirmation_fingerprint,
    });
  }
  function path(suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
});
