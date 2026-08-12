import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';
import { createApiKey, createProject } from '../src/services/projects.js';
import { accountModeForAuth } from '../src/services/accountMode.js';
import { requireOrganizationComparisonAccess } from '../src/services/projectComparison.js';
import { metricSemanticDefinition, metricSemanticFingerprint } from '../src/services/metricSemantics.js';

let env: TestEnv;
let secondProject: { id: string; slug: string };
let secondIngestToken: string;

const definition = {
  purpose: 'Measures completed activation moments across comparable product projects.',
  source: { event: 'activation.completed', filters: [] },
};

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  const org = await env.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [env.projectId]);
  secondProject = await createProject(
    env.pool,
    org.rows[0]!.org_id,
    `compare-${Date.now()}`,
    'Comparable project',
  );
  const secondIngest = await createApiKey(env.pool, {
    orgId: org.rows[0]!.org_id,
    projectId: secondProject.id,
    kind: 'ingest',
    env: 'prod',
  });
  secondIngestToken = secondIngest.token;

  for (const [slug, token] of [
    [env.projectSlug, env.secretToken],
    [secondProject.slug, env.personalToken],
  ] as const) {
    const registered = await api(env, token, 'POST', `/api/v1/projects/${slug}/metrics`, {
      key: 'activation_completed',
      name: 'Activation completed',
      type: 'count',
      ...definition,
    });
    expect(registered.status).toBe(201);
    const activated = await api(env, token, 'PATCH', `/api/v1/projects/${slug}/metrics/activation_completed`, {
      status: 'active',
    });
    expect(activated.status).toBe(200);
  }

  const funnel = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/funnels`, {
    key: 'activation_journey',
    name: 'Activation journey',
    goal: 'Understand whether started users complete the activation moment.',
    steps: [
      { metric_key: 'activation_completed', label: 'Activation one' },
      { metric_key: 'activation_completed', label: 'Activation two' },
    ],
  });
  expect(funnel.status).toBe(201);

  await env.pool.query(
    `INSERT INTO feature_flags (project_id, key, name, purpose, variants)
     VALUES ($1, 'activation_flag', 'Activation flag',
       'Safely tests activation behavior for the semantic impact fixture.',
       '[{"key":"control","rollout_percentage":50},{"key":"treatment","rollout_percentage":50}]')`,
    [env.projectId],
  );
  await env.pool.query(
    `INSERT INTO insights (project_id, kind, title, body, query)
     VALUES
       ($1, 'manual', 'Activation answer', 'Uses the exact semantic metric key.',
         '{"kind":"trend","metric":"activation_completed"}'),
       ($1, 'manual', 'Similar key answer', 'Must not count a substring-only metric key.',
         '{"kind":"trend","metric":"activation_completed_extra"}')`,
    [env.projectId],
  );
  await env.pool.query(
    `INSERT INTO experiments (
       project_id, key, name, hypothesis, flag_key, primary_metric_key
     ) VALUES ($1, 'activation_experiment', 'Activation experiment',
       'The treatment should improve the completed activation moment.',
       'activation_flag', 'activation_completed')`,
    [env.projectId],
  );
  const contract = await env.pool.query<{ id: string }>(
    `INSERT INTO measurement_contracts (
       project_id, key, name, business_hypothesis, decision_owner,
       primary_metric_key, baseline_window_days, observation_window_days,
       expected_direction, declaration_hash, created_by
     ) VALUES ($1, 'activation_contract', 'Activation contract',
       'The activation change should increase completed activation moments.',
       'Product owner', 'activation_completed', 7, 7, 'increase',
       'fixture-contract-hash', 'test') RETURNING id`,
    [env.projectId],
  );
  await env.pool.query(
    `INSERT INTO releases (
       project_id, contract_id, contract_key, contract_revision, contract_snapshot,
       env, repository, commit_sha, status, idempotency_key, created_by
     ) VALUES ($1, $2, 'activation_contract', 1,
       '{"primary_metric_key":"activation_completed","guardrail_metric_keys":[]}',
       'prod', 'poolstatis/example', $3, 'planned', 'semantic-impact-release', 'test')`,
    [env.projectId, contract.rows[0]!.id, 'a'.repeat(40)],
  );
});

afterAll(() => env.close());

describe('immutable semantic metric definitions', () => {
  it('canonicalizes source order and excludes cosmetic fields from the fingerprint', () => {
    const left = metricSemanticDefinition({
      id: 'metric', key: 'canonical_metric', purpose: 'Measures one canonical product outcome.',
      type: 'count', source: { filters: [{ value: 'paid', property: 'plan' }], event: 'outcome.completed' },
    });
    const right = metricSemanticDefinition({
      id: 'different-id', key: 'canonical_metric', purpose: 'Measures one canonical product outcome.',
      type: 'count', source: { event: 'outcome.completed', filters: [{ property: 'plan', value: 'paid' }] },
      owner: 'different-owner',
    });
    expect(metricSemanticFingerprint(left)).toBe(metricSemanticFingerprint(right));
  });

  it('previews dependencies, requires confirmation and rejects a stale optimistic apply', async () => {
    const history = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition`,
    );
    expect(history.status).toBe(200);
    expect(history.body.current).toMatchObject({ revision: 1, aggregation: 'count' });
    expect(history.body.current.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(history.body.revisions).toHaveLength(1);

    const proposedDefinition = {
      purpose: 'Measures the reviewed completed activation moment after onboarding.',
      source: definition.source,
    };
    const preview = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition/preview`,
      { expected_revision: 1, definition: proposedDefinition },
    );
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      state: 'ready',
      expected_revision: 1,
      changed_fields: ['purpose'],
      requires_confirmation: true,
      impact: {
        summary: { answers: 1, funnels: 1, measurement_contracts: 1, releases: 1, experiments: 1 },
      },
      primary_action: { kind: 'open_confirmation', id: 'apply_metric_definition' },
    });
    expect(preview.body.proposed.fingerprint).not.toBe(history.body.current.fingerprint);

    const unconfirmed = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition/apply`,
      {
        expected_revision: 1,
        expected_fingerprint: history.body.current.fingerprint,
        confirm_impact: false,
        definition: proposedDefinition,
      },
    );
    expect(unconfirmed.status).toBe(400);

    const applied = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition/apply`,
      {
        expected_revision: 1,
        expected_fingerprint: history.body.current.fingerprint,
        confirm_impact: true,
        definition: proposedDefinition,
      },
    );
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ applied: true, previous_revision: 1, revision: 2 });

    const stale = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition/apply`,
      {
        expected_revision: 1,
        expected_fingerprint: history.body.current.fingerprint,
        confirm_impact: true,
        definition: proposedDefinition,
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('metric_definition_revision_conflict');

    const readBack = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition`,
    );
    expect(readBack.body.current).toMatchObject({ revision: 2, definition: proposedDefinition });
    expect(readBack.body.revisions.map((revision: { revision: number }) => revision.revision)).toEqual([1, 2]);
  });

  it('keeps legacy PATCH compatible while recording semantic changes, and blocks revision mutation', async () => {
    const patched = await api(
      env,
      env.secretToken,
      'PATCH',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed`,
      { purpose: 'Measures activation completion after the reviewed product setup flow.' },
    );
    expect(patched.status).toBe(200);

    const history = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition`,
    );
    expect(history.body.current.revision).toBe(3);
    expect(history.body.revisions).toHaveLength(3);
    expect(history.body.revisions[2]).toMatchObject({ action: 'legacy_update' });

    await expect(env.pool.query(
      `UPDATE metric_definition_revisions SET actor = 'tampered'
       WHERE project_id = $1 AND metric_key = 'activation_completed' AND revision = 1`,
      [env.projectId],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('keeps one append-only key lineage when a hard-deleted metric is registered again', async () => {
    const path = `/api/v1/projects/${env.projectSlug}/metrics`;
    expect((await api(env, env.secretToken, 'POST', path, {
      key: 'recyclable_metric',
      name: 'Recyclable metric',
      purpose: 'Measures the original outcome before an explicit hard-delete cleanup.',
      type: 'count',
      source: { event: 'recyclable.original', filters: [] },
    })).status).toBe(201);
    expect((await api(
      env,
      env.secretToken,
      'DELETE',
      `${path}/recyclable_metric`,
    )).status).toBe(200);

    expect((await api(env, env.secretToken, 'POST', path, {
      key: 'recyclable_metric',
      name: 'Recreated metric',
      purpose: 'Measures the replacement outcome after an explicit hard-delete cleanup.',
      type: 'count',
      source: { event: 'recyclable.replacement', filters: [] },
    })).status).toBe(201);

    const history = await api(
      env,
      env.secretToken,
      'GET',
      `${path}/recyclable_metric/definition`,
    );
    expect(history.body.current.revision).toBe(2);
    expect(history.body.revisions.map((revision: { revision: number; action: string }) => ({
      revision: revision.revision,
      action: revision.action,
    }))).toEqual([
      { revision: 1, action: 'created' },
      { revision: 2, action: 'created' },
    ]);
  });

  it('returns exact dependency totals with one globally bounded reference sample', async () => {
    await env.pool.query(
      `INSERT INTO insights (project_id, kind, title, body, query)
       SELECT $1, 'manual', 'Bounded semantic impact ' || n,
         'Exercises the global dependency reference bound.',
         jsonb_build_object('kind', 'trend', 'metric', 'activation_completed')
       FROM generate_series(1, 30) AS n`,
      [env.projectId],
    );
    try {
      const history = await api(
        env,
        env.secretToken,
        'GET',
        `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition`,
      );
      expect(history.body.impact.summary.answers).toBe(31);
      expect(history.body.impact.references).toHaveLength(25);
      expect(history.body.impact.truncated).toBe(true);
    } finally {
      await env.pool.query(
        `DELETE FROM insights
         WHERE project_id = $1 AND title LIKE 'Bounded semantic impact %'`,
        [env.projectId],
      );
    }
  });
});

describe('semantic cross-project comparison', () => {
  it('computes only compatible projects in one explicit environment/window', async () => {
    const now = Date.now();
    const from = new Date(now - 60_000).toISOString();
    const to = new Date(now + 60_000).toISOString();
    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        { event: 'activation.completed', distinct_id: 'one', timestamp: new Date(now - 20_000).toISOString() },
        { event: 'activation.completed', distinct_id: 'two', timestamp: new Date(now - 10_000).toISOString() },
      ],
    });
    await api(env, secondIngestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'activation.completed', distinct_id: 'three', timestamp: new Date(now - 15_000).toISOString() }],
    });

    // Align the first project after the legacy-history test without bypassing revision tracking.
    const current = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition`);
    const aligned = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/metrics/activation_completed/definition/apply`,
      {
        expected_revision: current.body.current.revision,
        expected_fingerprint: current.body.current.fingerprint,
        confirm_impact: true,
        definition,
      },
    );
    expect(aligned.status).toBe(200);

    const compared = await api(env, env.personalToken, 'POST', '/api/v1/projects/compare', {
      metric_key: 'activation_completed',
      projects: [env.projectSlug, secondProject.slug],
      environment: 'prod',
      window: { from, to },
    });
    expect(compared.status).toBe(200);
    expect(compared.body).toMatchObject({
      schema_version: 1,
      state: 'ready',
      metric: { key: 'activation_completed', aggregation: 'count' },
      scope: { environment: 'prod', window: { from, to } },
      primary_action: { kind: 'navigate', id: 'open_comparison_evidence' },
    });
    expect(compared.body.projects).toEqual([
      expect.objectContaining({ slug: env.projectSlug, value: 2 }),
      expect.objectContaining({ slug: secondProject.slug, value: 1 }),
    ]);

    const denied = await api(env, env.secretToken, 'POST', '/api/v1/projects/compare', {
      metric_key: 'activation_completed',
      projects: [env.projectSlug, secondProject.slug],
      environment: 'prod',
      window: { from, to },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_scope');
  });

  it('returns an honest unavailable state and no values for a semantic mismatch', async () => {
    const changed = await api(
      env,
      env.personalToken,
      'PATCH',
      `/api/v1/projects/${secondProject.slug}/metrics/activation_completed`,
      { purpose: 'Measures an intentionally incompatible activation event for this project.' },
    );
    expect(changed.status).toBe(200);

    const compared = await api(env, env.personalToken, 'POST', '/api/v1/projects/compare', {
      metric_key: 'activation_completed',
      projects: [env.projectSlug, secondProject.slug],
      environment: 'prod',
      window: {
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(compared.status).toBe(200);
    expect(compared.body.state).toBe('unavailable');
    expect(compared.body.projects.every((project: object) => !('value' in project))).toBe(true);
    expect(compared.body.incompatibilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ project_slug: secondProject.slug, code: 'purpose_mismatch' }),
      expect.objectContaining({ project_slug: secondProject.slug, code: 'fingerprint_mismatch' }),
    ]));
    expect(compared.body.primary_action).toMatchObject({
      kind: 'navigate',
      id: 'review_metric_definitions',
      href: '/registry',
    });
  });
});

describe('server-backed account mode', () => {
  it('distinguishes project-only and organization-wide self-host sessions', async () => {
    const projectMode = await api(env, env.secretToken, 'GET', '/api/v1/account-mode');
    expect(projectMode.status).toBe(200);
    expect(projectMode.body).toMatchObject({
      schema_version: 1,
      deployment: { mode: 'self_host', hosted_account: 'not_configured' },
      session: { kind: 'secret', scope: 'project', role: null },
      capabilities: {
        portfolio: 'project_only', compare_projects: false, manage_profile: false,
        review_decisions: false, set_official_answers: false,
      },
      primary_action: { kind: 'navigate', href: '/setup' },
    });

    const organizationMode = await api(env, env.personalToken, 'GET', '/api/v1/account-mode');
    expect(organizationMode.status).toBe(200);
    expect(organizationMode.body).toMatchObject({
      deployment: { mode: 'self_host', hosted_account: 'not_configured' },
      session: { kind: 'personal', scope: 'organization' },
      capabilities: {
        portfolio: 'available', compare_projects: true, manage_profile: false,
        review_decisions: true, set_official_answers: true,
      },
    });
  });

  it('keeps hosted members out of portfolio comparison and points token sessions to hosted account sign-in', () => {
    const memberAuth = {
      keyId: null, orgId: 'org', projectId: null, kind: 'user' as const,
      env: 'prod', userRole: 'member' as const,
    };
    expect(accountModeForAuth(memberAuth, true)).toMatchObject({
      deployment: { mode: 'hosted', hosted_account: 'available' },
      session: { role: 'member' },
      capabilities: {
        portfolio: 'unavailable', compare_projects: false, manage_profile: true,
        review_decisions: false, set_official_answers: false,
      },
      primary_action: { id: 'manage_hosted_account', href: 'https://auth.poolstatis.xyz/profile' },
    });
    expect(() => requireOrganizationComparisonAccess(memberAuth)).toThrowError(expect.objectContaining({
      statusCode: 403,
      code: 'insufficient_role',
    }));
    expect(accountModeForAuth({ ...memberAuth, kind: 'personal', userRole: undefined }, true)).toMatchObject({
      capabilities: { review_decisions: false, set_official_answers: false },
      primary_action: { id: 'sign_in_to_manage_account', href: 'https://auth.poolstatis.xyz/profile' },
    });
    expect(accountModeForAuth({
      ...memberAuth, kind: 'personal', userId: 'owner-user', userRole: 'owner',
    }, true)).toMatchObject({
      capabilities: { review_decisions: false, set_official_answers: true },
    });
    expect(accountModeForAuth({ ...memberAuth, kind: 'user', userRole: 'owner', userId: 'owner-user' }, true)).toMatchObject({
      capabilities: { review_decisions: true, set_official_answers: true },
    });
  });

  it('keeps revisions immutable while allowing an explicit parent project deletion cascade', async () => {
    const temporary = await createProject(
      env.pool,
      (await env.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [env.projectId])).rows[0]!.org_id,
      `revision-delete-${Date.now()}`,
      'Revision cascade fixture',
    );
    expect((await api(env, env.personalToken, 'POST', `/api/v1/projects/${temporary.slug}/metrics`, {
      key: 'temporary_metric',
      name: 'Temporary metric',
      purpose: 'Measures a disposable metric used only to verify project deletion.',
      type: 'count',
      source: { event: 'temporary.completed', filters: [] },
    })).status).toBe(201);

    const deleted = await api(
      env,
      env.personalToken,
      'DELETE',
      `/api/v1/projects/${temporary.slug}`,
      { confirm_slug: temporary.slug },
    );
    expect(deleted.status).toBe(200);
    expect((await env.pool.query(
      'SELECT count(*)::int AS count FROM metric_definition_revisions WHERE project_id = $1',
      [temporary.id],
    )).rows[0].count).toBe(0);
  });
});
