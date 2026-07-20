import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as schemas from '../src/schemas.js';
import { createTestEnv, type TestEnv } from './helpers.js';

describe('measurement contract and release schemas', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await createTestEnv();
  });

  afterAll(async () => {
    await env.close();
  });

  test('installs current state plus append-only revision tables with scoped uniqueness', async () => {
    const expected = [
      'measurement_contracts',
      'measurement_contract_revisions',
      'releases',
      'release_revisions',
    ];
    const tables = await env.pool.query<{ name: string | null }>(
      'SELECT to_regclass(name)::text AS name FROM unnest($1::text[]) AS names(name)',
      [expected],
    );
    expect(tables.rows.map((row) => row.name)).toEqual(expected);

    const indexes = await env.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename IN ('measurement_contracts', 'releases')`,
    );
    const definitions = indexes.rows.map((row) => row.indexdef).join('\n');
    expect(definitions).toContain('(project_id, key)');
    expect(definitions).toContain('(project_id, env, idempotency_key)');
  });

  test('validates deterministic declarations and release provenance', () => {
    const declarationSchema = (schemas as Record<string, any>).measurementDeclarationSchema;
    const releaseSchema = (schemas as Record<string, any>).registerReleaseSchema;
    expect(declarationSchema).toBeDefined();
    expect(releaseSchema).toBeDefined();

    const valid = declarationSchema.parse({
      version: 1,
      contracts: [{
        key: 'shorter_onboarding',
        name: 'Shorter onboarding',
        business_hypothesis: 'Removing one setup step should increase first activation.',
        decision_owner: 'growth-team',
        primary_metric_key: 'activation_completed',
        guardrail_metric_keys: ['invite_completed'],
        target_filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
        baseline_window_days: 14,
        observation_window_days: 14,
        expected_direction: 'increase',
        references: { issue_url: 'https://example.com/issues/42', commit_sha: 'a'.repeat(40) },
      }],
    });
    expect(valid.contracts[0]).toMatchObject({
      minimum_sample_size: 100,
      status: 'active',
    });

    expect(declarationSchema.safeParse({
      version: 1,
      contracts: [{ ...valid.contracts[0], expected_direction: 'sideways' }],
    }).success).toBe(false);
    expect(declarationSchema.safeParse({
      version: 1,
      contracts: [{ ...valid.contracts[0], status: 'running' }],
    }).success).toBe(false);
    expect(declarationSchema.safeParse({
      version: 1,
      contracts: [{ ...valid.contracts[0], guardrail_metric_keys: ['invite_completed', 'invite_completed'] }],
    }).success).toBe(false);
    expect(declarationSchema.safeParse({
      version: 1,
      contracts: [{ ...valid.contracts[0], baseline_window_days: 0 }],
    }).success).toBe(false);
    expect(declarationSchema.safeParse({
      version: 1,
      contracts: [{ ...valid.contracts[0], observation_window_days: -1 }],
    }).success).toBe(false);
    expect(declarationSchema.safeParse({
      version: 1,
      contracts: [{ ...valid.contracts[0], references: { pr_url: 'not-a-url' } }],
    }).success).toBe(false);

    expect(releaseSchema.safeParse({
      idempotency_key: 'ci-deploy-42',
      contract_key: 'shorter_onboarding',
      env: 'prod',
      repository: 'acme/product',
      branch: 'main',
      commit_sha: 'b'.repeat(40),
      status: 'deployed',
      deployed_at: '2026-07-19T00:00:00.000Z',
    }).success).toBe(true);
    expect(releaseSchema.safeParse({
      idempotency_key: 'ci-deploy-42',
      contract_key: 'shorter_onboarding',
      env: 'prod',
      repository: 'acme/product',
      commit_sha: 'not-a-sha',
      status: 'shipped',
    }).success).toBe(false);
  });
});
