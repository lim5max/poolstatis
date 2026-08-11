import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

describe('immutable release provenance', () => {
  let env: TestEnv;
  let other: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
    other = await createTestEnv();
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    const declaration = {
      version: 1,
      contracts: [{
        key: 'shorter_onboarding', name: 'Shorter onboarding',
        business_hypothesis: 'Removing one setup step should increase first activation.',
        decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
        guardrail_metric_keys: [], target_filters: [], baseline_window_days: 14,
        observation_window_days: 14, minimum_sample_size: 100,
        expected_direction: 'increase', minimum_meaningful_effect: 0.05,
        references: {}, status: 'active',
      }],
    };
    const diff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), declaration);
    const apply = await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
      declaration, expected_revision: diff.body.expected_revision,
    });
    expect(apply.status).toBe(200);
  });

  afterAll(async () => {
    await env.close();
    await other.close();
  });

  test('registers a deployed change in one call and makes retries exactly idempotent', async () => {
    const payload = {
      idempotency_key: 'deploy-activation-001',
      contract_key: 'shorter_onboarding',
      env: 'prod',
      repository: 'acme/product',
      branch: 'main',
      commit_sha: 'a'.repeat(40),
      pr_url: 'https://example.com/pull/42',
      status: 'deployed',
    };
    const created = await api(env, env.secretToken, 'POST', path(env, '/releases'), payload);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      contract_key: 'shorter_onboarding', status: 'deployed', idempotency_key: 'deploy-activation-001',
      commit_sha: 'a'.repeat(40), idempotent: false,
    });
    expect(new Date(created.body.deployed_at).toString()).not.toBe('Invalid Date');

    const retried = await api(env, env.secretToken, 'POST', path(env, '/releases'), payload);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ id: created.body.id, idempotent: true });
    expect(retried.body.deployed_at).toBe(created.body.deployed_at);

    const conflict = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
      ...payload, branch: 'hotfix',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('release_idempotency_conflict');

    const redeploy = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
      ...payload, idempotency_key: 'deploy-activation-002',
    });
    expect(redeploy.status).toBe(201);
    expect(redeploy.body.id).not.toBe(created.body.id);
    expect(redeploy.body.commit_sha).toBe(created.body.commit_sha);

    const listed = await api(env, env.secretToken, 'GET', path(env, '/releases?env=prod'));
    expect(listed.status).toBe(200);
    expect(listed.body.releases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.body.id }),
      expect.objectContaining({ id: redeploy.body.id }),
    ]));
    const detail = await api(env, env.secretToken, 'GET', path(env, `/releases/${created.body.id}`));
    expect(detail.body.revisions).toEqual([
      expect.objectContaining({ action: 'registered', from_status: null, to_status: 'deployed' }),
    ]);

    const crossProject = await api(env, env.secretToken, 'GET', path(other, `/releases/${created.body.id}`));
    expect(crossProject.status).toBe(404);
  });

  test('enforces lifecycle transitions, live contract validity and immutable history', async () => {
    const planned = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
      idempotency_key: 'planned-activation-003',
      contract_key: 'shorter_onboarding', env: 'dev', repository: 'acme/product',
      branch: 'feature/onboarding', commit_sha: 'b'.repeat(40), status: 'planned',
    });
    expect(planned.status).toBe(201);
    expect(planned.body).toMatchObject({ status: 'planned', deployed_at: null });

    const skipped = await api(env, env.secretToken, 'POST', path(env, `/releases/${planned.body.id}/transition`), {
      status: 'observing',
    });
    expect(skipped.status).toBe(409);
    expect(skipped.body.error.code).toBe('invalid_release_transition');

    const deployed = await api(env, env.secretToken, 'POST', path(env, `/releases/${planned.body.id}/transition`), {
      status: 'deployed', deployed_at: '2026-07-19T01:00:00.000Z',
    });
    expect(deployed.status).toBe(200);
    expect(deployed.body).toMatchObject({ status: 'deployed', deployed_at: '2026-07-19T01:00:00.000Z' });

    await api(env, env.secretToken, 'PATCH', path(env, '/metrics/activation_completed'), { status: 'proposed' });
    const invalidContract = await api(env, env.secretToken, 'POST', path(env, `/releases/${planned.body.id}/transition`), {
      status: 'observing',
    });
    expect(invalidContract.status).toBe(409);
    expect(invalidContract.body.error.code).toBe('release_contract_invalid');

    await api(env, env.secretToken, 'PATCH', path(env, '/metrics/activation_completed'), { status: 'active' });
    const observing = await api(env, env.secretToken, 'POST', path(env, `/releases/${planned.body.id}/transition`), {
      status: 'observing',
    });
    expect(observing.status).toBe(200);
    expect(observing.body.status).toBe('observing');

    const cancelled = await api(env, env.secretToken, 'POST', path(env, `/releases/${planned.body.id}/transition`), {
      status: 'cancelled',
    });
    expect(cancelled.status).toBe(200);
    const noResurrection = await api(env, env.secretToken, 'POST', path(env, `/releases/${planned.body.id}/transition`), {
      status: 'observing',
    });
    expect(noResurrection.status).toBe(409);

    const detail = await api(env, env.secretToken, 'GET', path(env, `/releases/${planned.body.id}`));
    expect(detail.body.release).toMatchObject({
      repository: 'acme/product', branch: 'feature/onboarding', commit_sha: 'b'.repeat(40),
      status: 'cancelled', deployed_at: '2026-07-19T01:00:00.000Z',
    });
    expect(detail.body.revisions.map((revision: { to_status: string }) => revision.to_status))
      .toEqual(['planned', 'deployed', 'observing', 'cancelled']);
    expect(detail.body.revisions.every((revision: { snapshot: { commit_sha: string } }) => revision.snapshot.commit_sha === 'b'.repeat(40))).toBe(true);
  });

  test('selects the nearest decision-eligible release on the server with deterministic tie-breakers', async () => {
    const earlierDue = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
      idempotency_key: 'decision-nearest-first',
      contract_key: 'shorter_onboarding', env: 'decision-queue', repository: 'acme/product',
      commit_sha: 'c'.repeat(40), deployed_at: '2026-07-19T00:00:00.000Z', status: 'deployed',
    });
    const laterCreatedButLaterDue = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
      idempotency_key: 'decision-nearest-second',
      contract_key: 'shorter_onboarding', env: 'decision-queue', repository: 'acme/product',
      commit_sha: 'd'.repeat(40), deployed_at: '2026-07-20T00:00:00.000Z', status: 'deployed',
    });
    expect(earlierDue.status).toBe(201);
    expect(laterCreatedButLaterDue.status).toBe(201);

    const nearest = await api(
      env,
      env.secretToken,
      'GET',
      path(env, '/releases?env=decision-queue&decision_eligible=nearest'),
    );
    expect(nearest.status).toBe(200);
    expect(nearest.body.releases).toEqual([
      expect.objectContaining({ id: earlierDue.body.id, status: 'deployed' }),
    ]);
    const crossProject = await api(
      env,
      env.secretToken,
      'GET',
      path(other, '/releases?env=decision-queue&decision_eligible=nearest'),
    );
    expect(crossProject.status).toBe(404);
  });
});

function path(env: TestEnv, suffix: string) {
  return `/api/v1/projects/${env.projectSlug}${suffix}`;
}
