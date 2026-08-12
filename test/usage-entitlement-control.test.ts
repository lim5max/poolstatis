import { afterEach, describe, expect, it } from 'vitest';
import { accountModeForAuth } from '../src/services/accountMode.js';
import { api, createTestEnv, type TestEnv } from './helpers.js';

const open: TestEnv[] = [];

async function fresh(): Promise<TestEnv> {
  const env = await createTestEnv({ ingestBuffer: false });
  open.push(env);
  return env;
}

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((env) => env.close()));
});

async function orgId(env: TestEnv): Promise<string> {
  return (await env.pool.query<{ org_id: string }>(
    'SELECT org_id::text FROM projects WHERE id = $1',
    [env.projectId],
  )).rows[0]!.org_id;
}

describe('self-host usage entitlement control', () => {
  it('uses only an organization-wide personal token and returns exact consequences', async () => {
    const env = await fresh();
    const denied = await api(env, env.secretToken, 'GET', '/api/v1/me/usage/entitlement');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_scope');

    const initial = await api(env, env.personalToken, 'GET', '/api/v1/me/usage/entitlement');
    expect(initial).toMatchObject({
      status: 200,
      body: {
        schema_version: 1,
        meter: 'events_stored',
        revision: 0,
        hard_limit: null,
        warning_thresholds: [],
        current_usage: 0,
        changed: false,
        consequences: {
          scope: 'organization_all_projects_and_environments',
          cap_enforcement: 'accepted_events_continue_without_core_cap',
          threshold_recording: 'not_configured',
        },
        audit: { source: 'usage_entitlement_revisions', latest: null },
      },
    });

    const configured = await api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', {
      expected_revision: 0,
      hard_limit: 100,
      warning_thresholds: [50, 75, 90, 100],
      reason: 'Protect local analytics continuity during load testing.',
    });
    expect(configured).toMatchObject({
      status: 200,
      body: {
        revision: 1,
        hard_limit: 100,
        warning_thresholds: [50, 75, 90, 100],
        remaining: 100,
        changed: true,
        consequences: {
          cap_enforcement: 'accepted_batches_exceeding_cap_are_rejected',
          threshold_recording: 'crossings_recorded_in_core_without_external_delivery',
        },
        audit: {
          latest: {
            revision: 1,
            actor_kind: 'personal_token',
            reason: 'Protect local analytics continuity during load testing.',
          },
        },
      },
    });

    const readBack = await api(env, env.personalToken, 'GET', '/api/v1/me/usage/entitlement');
    expect(readBack.body).toMatchObject({ revision: 1, hard_limit: 100, changed: false });
    expect(readBack.body.audit.latest.created_at).toEqual(expect.any(String));

    const unchanged = await api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', {
      expected_revision: 1,
      hard_limit: 100,
      warning_thresholds: [50, 75, 90, 100],
      reason: 'Confirm the existing configuration without changing it.',
    });
    expect(unchanged).toMatchObject({ status: 200, body: { revision: 1, changed: false } });
    expect((await env.pool.query(
      'SELECT count(*)::int AS count FROM usage_entitlement_revisions WHERE org_id = $1',
      [await orgId(env)],
    )).rows[0].count).toBe(1);
  });

  it('keeps the current-usage invariant and immutable audit', async () => {
    const env = await fresh();
    const organizationId = await orgId(env);
    await env.pool.query(
      `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity)
       VALUES ($1, 'events_stored', date_trunc('month', now() AT TIME ZONE 'UTC')::date, 5)`,
      [organizationId],
    );
    const belowUsage = await api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', {
      expected_revision: 0,
      hard_limit: 4,
      warning_thresholds: [],
      reason: 'Try a cap below the already accepted current usage.',
    });
    expect(belowUsage).toMatchObject({
      status: 409,
      body: { error: { code: 'usage_cap_below_current_usage' } },
    });

    const valid = await api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', {
      expected_revision: 0,
      hard_limit: 10,
      warning_thresholds: [4, 8],
      reason: 'Set a safe cap above the accepted current usage.',
    });
    expect(valid.status).toBe(200);
    expect((await env.pool.query<{ threshold: string; quantity: string }>(
      `SELECT threshold::text, quantity::text FROM usage_warnings
       WHERE org_id = $1 AND meter_key = 'events_stored'
       ORDER BY threshold`,
      [organizationId],
    )).rows).toEqual([{ threshold: '4', quantity: '5' }]);
    await expect(env.pool.query(
      'UPDATE usage_entitlement_revisions SET reason = $1 WHERE org_id = $2',
      ['Rewrite immutable history for a test.', organizationId],
    )).rejects.toThrow('usage_entitlement_revisions rows are append-only');
  });

  it('serializes concurrent writes with one winning expected revision', async () => {
    const env = await fresh();
    const payload = (hardLimit: number) => ({
      expected_revision: 0,
      hard_limit: hardLimit,
      warning_thresholds: [],
      reason: `Set concurrent self-host usage cap to ${hardLimit} events.`,
    });
    const responses = await Promise.all([
      api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', payload(100)),
      api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', payload(200)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error.code)
      .toBe('usage_entitlement_revision_conflict');
    const readBack = await api(env, env.personalToken, 'GET', '/api/v1/me/usage/entitlement');
    expect(readBack.body.revision).toBe(1);
    expect([100, 200]).toContain(readBack.body.hard_limit);
  });

  it('detects a direct self-host entitlement change outside the API audit', async () => {
    const env = await fresh();
    const configured = await api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', {
      expected_revision: 0,
      hard_limit: 100,
      warning_thresholds: [50],
      reason: 'Create an audited baseline before a direct local change.',
    });
    expect(configured.body.revision).toBe(1);

    await env.pool.query(
      `UPDATE organization_entitlements SET hard_limit = 120
       WHERE org_id = $1 AND meter_key = 'events_stored'`,
      [await orgId(env)],
    );
    const readBack = await api(env, env.personalToken, 'GET', '/api/v1/me/usage/entitlement');
    expect(readBack.body).toMatchObject({ revision: 2, hard_limit: 120, audit: { latest: null } });

    const stale = await api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', {
      expected_revision: 1,
      hard_limit: 130,
      warning_thresholds: [50],
      reason: 'Attempt a stale overwrite after a direct local change.',
    });
    expect(stale).toMatchObject({
      status: 409,
      body: { error: { code: 'usage_entitlement_revision_conflict', details: { current_revision: 2 } } },
    });
  });

  it('rejects direct entitlement deletion but permits parent organization cascade', async () => {
    const env = await fresh();
    const organizationId = await orgId(env);
    const configured = await api(env, env.personalToken, 'PUT', '/api/v1/me/usage/entitlement', {
      expected_revision: 0,
      hard_limit: 100,
      warning_thresholds: [50],
      reason: 'Create a guarded entitlement before deletion checks.',
    });
    expect(configured.status).toBe(200);

    await expect(env.pool.query(
      `DELETE FROM organization_entitlements
       WHERE org_id = $1 AND meter_key = 'events_stored'`,
      [organizationId],
    )).rejects.toThrow('organization_entitlements rows cannot be deleted directly');
    expect((await env.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM organization_entitlements
       WHERE org_id = $1 AND meter_key = 'events_stored'`,
      [organizationId],
    )).rows[0]?.count).toBe(1);

    const cascadeOrganizationId = (await env.pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ('Usage cascade guard test') RETURNING id::text`,
    )).rows[0]!.id;
    await env.pool.query(
      `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit, warning_thresholds)
       VALUES ($1, 'events_stored', 10, ARRAY[5]::bigint[])`,
      [cascadeOrganizationId],
    );
    await expect(env.pool.query(
      'DELETE FROM organizations WHERE id = $1',
      [cascadeOrganizationId],
    )).resolves.toBeDefined();
    expect((await env.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM organization_entitlements WHERE org_id = $1',
      [cascadeOrganizationId],
    )).rows[0]?.count).toBe(0);
  });

  it('reports hosted plan and alert actions as unavailable in Core', () => {
    const hostedOwner = accountModeForAuth({
      keyId: null,
      orgId: 'organization-id',
      projectId: null,
      kind: 'user',
      env: 'prod',
      userId: 'user-id',
      userRole: 'owner',
    }, true);
    expect(hostedOwner.capabilities).toMatchObject({
      configure_usage_entitlement: 'unavailable_hosted',
      review_plan: 'unavailable',
      set_usage_alert: 'unavailable',
    });
  });
});
