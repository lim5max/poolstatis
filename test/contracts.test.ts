import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

describe('deterministic measurement contract declarations', () => {
  let env: TestEnv;
  let other: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
    other = await createTestEnv();
    await activeMetric(env, {
      key: 'activation_completed',
      type: 'unique_actors',
      source: { event: 'activation.completed', filters: [] },
      purpose: 'Measures whether signed-up actors reach their first product value moment.',
    });
    await activeMetric(env, {
      key: 'invite_completed',
      type: 'unique_actors',
      source: { event: 'invite.completed', filters: [] },
      purpose: 'Protects the collaborative invite outcome while onboarding changes ship.',
    });
    await api(env, env.secretToken, 'POST', path(env, '/properties'), {
      key: 'plan', scope: 'event', value_type: 'string', status: 'trusted',
      purpose: 'Segments decision evidence by the commercial plan selected by an actor.',
    });
  });

  afterAll(async () => {
    await env.close();
    await other.close();
  });

  test('validates semantics and computes a canonical diff without mutating runtime state', async () => {
    const declaration = validDeclaration();
    declaration.contracts.push({
      ...declaration.contracts[0]!,
      key: 'activation_all_users',
      name: 'Activation for all users',
      guardrail_metric_keys: [],
      target_filters: [],
    });
    // Intentionally reverse input order; canonical output must sort by stable key.
    declaration.contracts.reverse();

    const validated = await api(env, env.secretToken, 'POST', path(env, '/contracts/validate'), declaration);
    expect(validated.status).toBe(200);
    expect(validated.body).toMatchObject({ valid: true, issues: [] });
    expect(validated.body.declaration.contracts.map((contract: { key: string }) => contract.key))
      .toEqual(['activation_all_users', 'shorter_onboarding']);
    expect(validated.body.declaration.contracts[1].guardrail_metric_keys).toEqual(['invite_completed']);

    const diff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), declaration);
    expect(diff.status).toBe(200);
    expect(diff.body.changes).toEqual([
      expect.objectContaining({ key: 'activation_all_users', operation: 'create', before: null }),
      expect.objectContaining({ key: 'shorter_onboarding', operation: 'create', before: null }),
    ]);
    expect(diff.body.expected_revision).toMatch(/^[a-f0-9]{64}$/);
    const untouched = await env.pool.query(
      `SELECT count(*)::int AS count FROM measurement_contracts
       WHERE project_id = (SELECT id FROM projects WHERE slug = $1)`,
      [env.projectSlug],
    );
    expect(untouched.rows[0].count).toBe(0);

    const unknownMetric = await api(env, env.secretToken, 'POST', path(env, '/contracts/validate'), {
      version: 1,
      contracts: [{ ...validDeclaration().contracts[0], primary_metric_key: 'not_registered' }],
    });
    expect(unknownMetric.status).toBe(200);
    expect(unknownMetric.body.valid).toBe(false);
    expect(unknownMetric.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown_primary_metric', contract_key: 'shorter_onboarding' }),
    ]));

    const unknownProperty = await api(env, env.secretToken, 'POST', path(env, '/contracts/validate'), {
      version: 1,
      contracts: [{
        ...validDeclaration().contracts[0],
        target_filters: [{ property: 'unknown_dimension', op: 'eq', value: 'pro' }],
      }],
    });
    expect(unknownProperty.body.valid).toBe(false);
    expect(unknownProperty.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unknown_target_property' }),
    ]));

    const incompatible = await api(env, env.secretToken, 'POST', path(env, '/metrics'), {
      key: 'activation_state', name: 'Activation state',
      purpose: 'Represents a current state and cannot be evaluated as a release outcome.',
      type: 'state', source: { entity_type: 'account', filters: [] },
    });
    // Unknown entity type prevents registration; create a conversion metric instead.
    expect(incompatible.status).toBe(400);
    const conversion = await api(env, env.secretToken, 'POST', path(env, '/metrics'), {
      key: 'activation_conversion', name: 'Activation conversion',
      purpose: 'Represents a derived conversion and cannot be a direct contract outcome.',
      type: 'conversion',
      source: {
        from: { event: 'signup.completed', filters: [] },
        to: { event: 'activation.completed', filters: [] },
        window_seconds: 604800,
      },
    });
    expect(conversion.status).toBe(201);
    await api(env, env.secretToken, 'PATCH', path(env, '/metrics/activation_conversion'), { status: 'active' });
    const invalidType = await api(env, env.secretToken, 'POST', path(env, '/contracts/validate'), {
      version: 1,
      contracts: [{ ...validDeclaration().contracts[0], primary_metric_key: 'activation_conversion' }],
    });
    expect(invalidType.body.valid).toBe(false);
    expect(invalidType.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'incompatible_primary_metric' }),
    ]));
  });

  test('applies revisions with confirmation and optimistic concurrency, then exports byte-stable YAML', async () => {
    const declaration = validDeclaration();
    const firstDiff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), declaration);
    const applied = await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
      declaration,
      expected_revision: firstDiff.body.expected_revision,
    });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({
      applied: true,
      changes: [expect.objectContaining({ key: 'shorter_onboarding', operation: 'create' })],
    });
    expect(applied.body.contracts[0]).toMatchObject({ key: 'shorter_onboarding', revision: 1, status: 'active' });

    const yaml1 = await api(env, env.secretToken, 'GET', path(env, '/contracts/export'));
    const yaml2 = await api(env, env.secretToken, 'GET', path(env, '/contracts/export'));
    expect(yaml1.status).toBe(200);
    expect(yaml1.body.yaml).toBe(yaml2.body.yaml);
    expect(yaml1.body.filename).toBe('poolstatis.yml');
    const parsed = parseYaml(yaml1.body.yaml);
    expect(parsed).toMatchObject({
      version: 1,
      contracts: [expect.objectContaining({ key: 'shorter_onboarding', minimum_sample_size: 100 })],
    });

    const changed = validDeclaration();
    changed.contracts[0]!.business_hypothesis = 'A substantially shorter setup should improve verified activation completion.';
    const changedDiff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), changed);
    expect(changedDiff.body.changes).toEqual([
      expect.objectContaining({ key: 'shorter_onboarding', operation: 'update' }),
    ]);
    const unconfirmed = await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
      declaration: changed,
      expected_revision: changedDiff.body.expected_revision,
    });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.error.code).toBe('contract_confirmation_required');

    const stale = await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
      declaration: changed,
      confirm_existing_changes: true,
      expected_revision: '0'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('contract_revision_conflict');

    const confirmed = await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
      declaration: changed,
      confirm_existing_changes: true,
      expected_revision: changedDiff.body.expected_revision,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.contracts[0].revision).toBe(2);
    const revisions = await env.pool.query(
      `SELECT revision, snapshot->>'business_hypothesis' AS hypothesis
       FROM measurement_contract_revisions
       WHERE project_id = (SELECT id FROM projects WHERE slug = $1)
       ORDER BY revision`,
      [env.projectSlug],
    );
    expect(revisions.rows).toEqual([
      { revision: 1, hypothesis: declaration.contracts[0]!.business_hypothesis },
      { revision: 2, hypothesis: changed.contracts[0]!.business_hypothesis },
    ]);

    const crossProject = await api(env, env.secretToken, 'GET', path(other, '/contracts/shorter_onboarding'));
    expect(crossProject.status).toBe(404);
  });
});

function validDeclaration() {
  return {
    version: 1 as const,
    contracts: [{
      key: 'shorter_onboarding',
      name: 'Shorter onboarding',
      business_hypothesis: 'Removing one setup step should increase first activation.',
      decision_owner: 'growth-team',
      primary_metric_key: 'activation_completed',
      guardrail_metric_keys: ['invite_completed'],
      target_filters: [{ property: 'plan', op: 'eq' as const, value: 'pro' }],
      baseline_window_days: 14,
      observation_window_days: 14,
      minimum_sample_size: 100,
      expected_direction: 'increase' as const,
      minimum_meaningful_effect: 0.05,
      references: { issue_url: 'https://example.com/issues/42' },
      status: 'active' as const,
    }],
  };
}

function path(env: TestEnv, suffix: string) {
  return `/api/v1/projects/${env.projectSlug}${suffix}`;
}
