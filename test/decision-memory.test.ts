import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

const DAY = 86_400_000;

describe('project-scoped decision memory', () => {
  let env: TestEnv;
  let other: TestEnv;
  let decisionId: string;
  let declaration: ReturnType<typeof makeDeclaration>;

  beforeAll(async () => {
    env = await createTestEnv();
    other = await createTestEnv();
    const anchor = new Date(Date.now() - 3 * DAY);
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    await api(env, env.secretToken, 'PATCH', path(env, '/metrics/activation_completed'), { tags: ['onboarding', 'activation'], category: 'activation' });
    declaration = makeDeclaration('Original activation hypothesis.');
    await apply(env, declaration);
    await api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'memory-evidence', events: [
      { event: 'activation.completed', distinct_id: 'base-1', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'base-2', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-1', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-2', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-3', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
    ] });
    const release = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
      idempotency_key: 'memory-release', contract_key: 'memory_change', env: 'prod',
      repository: 'acme/product', commit_sha: 'b'.repeat(40), deployed_at: anchor.toISOString(), status: 'deployed',
    });
    const evaluated = await api(env, env.secretToken, 'POST', path(env, `/releases/${release.body.id}/evaluate`), {});
    expect(evaluated.body.decision.proposed_outcome).toBe('keep');
    decisionId = evaluated.body.decision.id;
    const corrected = await api(env, env.secretToken, 'POST', path(env, `/decisions/${decisionId}/edit`), {
      outcome: 'rollback',
      rationale: 'A known rollout confounder makes rollback safer despite the positive measured association.',
    });
    expect(corrected.body.decision.accepted_outcome).toBe('rollback');
  });

  afterAll(async () => { await env.close(); await other.close(); });

  test('searches bounded history by metric, tag, owner, status and time while preserving disagreement', async () => {
    for (const query of [
      'metric=activation_completed', 'tag=onboarding', 'owner=growth-team', 'status=approved', 'contract=memory_change',
    ]) {
      const result = await api(env, env.secretToken, 'GET', path(env, `/decisions/search?${query}`));
      expect(result.status).toBe(200);
      expect(result.body.items).toEqual([expect.objectContaining({ decision_id: decisionId })]);
    }
    const item = (await api(env, env.secretToken, 'GET', path(env, '/decisions/search?limit=1'))).body.items[0];
    expect(item).toMatchObject({
      proposed_outcome: 'keep', accepted_outcome: 'rollback', proposal_disagreed: true,
      evidence_quality: { ready: true, trust: 'trusted', sample_size: 3, blockers: 0 },
    });
    const future = await api(env, env.secretToken, 'GET', path(env, `/decisions/search?from=${encodeURIComponent(new Date(Date.now() + DAY).toISOString())}`));
    expect(future.body.items).toEqual([]);
    const crossProject = await api(other, other.secretToken, 'GET', path(other, '/decisions/search?metric=activation_completed'));
    expect(crossProject.body.items).toEqual([]);
  });

  test('ranks similar project-local changes and labels stale semantic context', async () => {
    const similar = await api(env, env.secretToken, 'POST', path(env, '/contracts/similar'), declaration);
    expect(similar.status).toBe(200);
    expect(similar.body.changes[0]).toMatchObject({
      decision_id: decisionId,
      similarity_score: expect.any(Number),
      shared: expect.arrayContaining(['primary_metric', 'decision_owner']),
    });

    await api(env, env.secretToken, 'PATCH', path(env, '/metrics/activation_completed'), {
      purpose: 'Updated activation meaning after the historical evidence was collected.',
    });
    const changed = makeDeclaration('A materially updated activation hypothesis.');
    const diff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), changed);
    await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
      declaration: changed, expected_revision: diff.body.expected_revision, confirm_existing_changes: true,
    });
    const stale = (await api(env, env.secretToken, 'GET', path(env, '/decisions/search'))).body.items[0];
    expect(stale.stale).toBe(true);
    expect(stale.stale_reasons).toEqual(expect.arrayContaining([
      'metric_definition_changed_after_evidence', 'contract_fingerprint_changed',
    ]));
  });

  test('rejects malformed history bounds and ambiguous similarity input', async () => {
    for (const query of ['limit=NaN', 'limit=101', 'from=not-a-date', 'cursor=not-a-cursor']) {
      const result = await api(env, env.secretToken, 'GET', path(env, `/decisions/search?${query}`));
      expect(result.status).toBe(400);
    }
    const ambiguous = await api(env, env.secretToken, 'POST', path(env, '/contracts/similar'), {
      version: 1,
      contracts: [declaration.contracts[0], { ...declaration.contracts[0], key: 'another_change' }],
    });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.code).toBe('similar_contract_count_invalid');
  });

  function makeDeclaration(hypothesis: string) {
    return { version: 1 as const, contracts: [{
      key: 'memory_change', name: 'Memory change', business_hypothesis: hypothesis,
      decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
      guardrail_metric_keys: [], target_filters: [], baseline_window_days: 1,
      observation_window_days: 1, minimum_sample_size: 2,
      expected_direction: 'increase' as const, minimum_meaningful_effect: 0.1,
      references: {}, status: 'active' as const,
    }] };
  }
  async function apply(target: TestEnv, input: ReturnType<typeof makeDeclaration>) {
    const diff = await api(target, target.secretToken, 'POST', path(target, '/contracts/diff'), input);
    const result = await api(target, target.secretToken, 'POST', path(target, '/contracts/apply'), { declaration: input, expected_revision: diff.body.expected_revision });
    expect(result.status).toBe(200);
  }
  function path(target: TestEnv, suffix: string) { return `/api/v1/projects/${target.projectSlug}${suffix}`; }
});
