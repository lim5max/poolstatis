import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';
import { analysisViewInput } from './analysis-view-fixtures.js';

let env: TestEnv;
let other: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
  other = await createTestEnv();
  await activeMetric(env, {
    key: 'activation_completed',
    source: { event: 'activation.completed', filters: [] },
    purpose: 'Measures the first meaningful activation completion outcome.',
  });
  await activeMetric(other, {
    key: 'activation_completed',
    source: { event: 'activation.completed', filters: [] },
    purpose: 'Measures the other tenant activation completion outcome.',
  });
});

afterAll(async () => {
  await env.close();
  await other.close();
});

describe('saved and official analysis views', () => {
  it('persists a bounded v1 answer, supports update/read-back, and appends immutable audit rows', async () => {
    const created = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      analysisViewInput(env.projectSlug),
    );
    expect(created.status).toBe(201);
    expect(created.body.view).toMatchObject({
      title: 'Activation completion',
      env: 'prod',
      status: 'active',
      official: false,
      schema_version: 1,
      created_by: { kind: 'secret', role: null },
    });
    const id = created.body.view.id as string;

    const listed = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/analysis-views?env=prod&status=active`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.views).toContainEqual(expect.objectContaining({ id, title: 'Activation completion' }));

    const updated = await api(
      env,
      env.secretToken,
      'PATCH',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}`,
      { title: 'Activation completion · weekly review', description: null },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.view).toMatchObject({
      id,
      title: 'Activation completion · weekly review',
      description: null,
    });

    const detail = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.view.visualization_spec.source.query).toMatchObject({
      kind: 'trend', metric: 'activation_completed', env: 'prod',
    });
    expect(detail.body.audit.map((entry: { action: string }) => entry.action)).toEqual(['created', 'updated']);
    expect(JSON.stringify(detail.body.audit)).not.toContain('visualization_spec');
    expect(JSON.stringify(detail.body.audit)).not.toContain('actor');
    expect(JSON.stringify(detail.body.audit)).not.toContain('payload');

    await expect(env.pool.query(
      `UPDATE analysis_view_audit SET action = 'archived' WHERE analysis_view_id = $1`,
      [id],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(env.pool.query(
      'DELETE FROM analysis_view_audit WHERE analysis_view_id = $1',
      [id],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('allows only an owner/admin credential to change official state and clears it on archive', async () => {
    const created = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      { ...analysisViewInput(env.projectSlug), title: 'Official candidate' },
    );
    const id = created.body.view.id as string;

    const denied = await api(
      env,
      env.secretToken,
      'PUT',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}/official`,
      { official: true },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('official_answer_role_required');

    const official = await api(
      env,
      env.personalToken,
      'PUT',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}/official`,
      { official: true },
    );
    expect(official.status).toBe(200);
    expect(official.body.view).toMatchObject({ id, official: true, status: 'active' });

    const officialList = await api(
      env,
      env.personalToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/analysis-views?env=prod&official=true`,
    );
    expect(officialList.body.views.map((view: { id: string }) => view.id)).toContain(id);

    const archived = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}/archive`,
      {},
    );
    expect(archived.status).toBe(200);
    expect(archived.body.view).toMatchObject({ id, status: 'archived', official: false });

    const detail = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}`,
    );
    expect(detail.body.audit.map((entry: { action: string }) => entry.action)).toEqual([
      'created', 'official_changed', 'archived',
    ]);
    expect((await api(
      env,
      env.personalToken,
      'PUT',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}/official`,
      { official: true },
    )).status).toBe(409);
  });

  it('fails closed on cross-project/tenant scope, schema drift, and prohibited saved content', async () => {
    const created = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      { ...analysisViewInput(env.projectSlug), title: 'Isolation proof' },
    );
    const id = created.body.view.id as string;

    expect((await api(
      other,
      other.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}`,
    )).status).toBe(404);

    const secondSlug = `second-${Date.now()}`;
    expect((await api(env, env.personalToken, 'POST', '/api/v1/projects', {
      slug: secondSlug, name: 'Second project',
    })).status).toBe(201);
    const secondSecret = await api(env, env.personalToken, 'POST', `/api/v1/projects/${secondSlug}/keys`, {
      kind: 'secret',
    });
    const wrongProject = await api(
      env,
      secondSecret.body.token,
      'GET',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}`,
    );
    expect(wrongProject.status).toBe(403);
    expect(wrongProject.body.error.code).toBe('project_scope');

    const mismatched = analysisViewInput('another-project', 'prod');
    const scopeRejected = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      mismatched,
    );
    expect(scopeRejected.status).toBe(400);
    expect(scopeRejected.body.error.code).toBe('analysis_view_scope_mismatch');

    const unknownVersion = analysisViewInput(env.projectSlug) as Record<string, unknown>;
    unknownVersion.schema_version = 2;
    const versionRejected = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      unknownVersion,
    );
    expect(versionRejected.status).toBe(400);

    const unsafe = analysisViewInput(env.projectSlug) as Record<string, any>;
    unsafe.answer.raw_prompt = 'paste the private task here';
    unsafe.evidence.token = 'sk_secret';
    const privacyRejected = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      unsafe,
    );
    expect(privacyRejected.status).toBe(400);

    const rawSql = analysisViewInput(env.projectSlug) as Record<string, any>;
    rawSql.answer.takeaway = 'SELECT * FROM events';
    const sqlRejected = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      rawSql,
    );
    expect(sqlRejected.status).toBe(400);
    expect(sqlRejected.body.error.code).toBe('analysis_view_private_content');

    const crossEnvAction = analysisViewInput(env.projectSlug) as Record<string, any>;
    crossEnvAction.visualization_spec.actions.push({
      kind: 'see_actors',
      actorQuery: { kind: 'actors', env: 'dev', activityMetric: 'activation_completed' },
    });
    const actionScopeRejected = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      crossEnvAction,
    );
    expect(actionScopeRejected.status).toBe(400);

    const missingActionReference = analysisViewInput(env.projectSlug) as Record<string, any>;
    missingActionReference.visualization_spec.actions.push({ kind: 'open_metric', key: 'missing_metric' });
    const actionReferenceRejected = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      missingActionReference,
    );
    expect(actionReferenceRejected.status).toBe(400);
    expect(actionReferenceRejected.body.error.code).toBe('analysis_view_metric_unavailable');

    const inconsistentSnapshot = analysisViewInput(env.projectSlug) as Record<string, any>;
    inconsistentSnapshot.evidence.reproducible_query = {
      ...inconsistentSnapshot.evidence.reproducible_query,
      date_from: '2026-07-01T00:00:00.000Z',
    };
    const snapshotRejected = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/analysis-views`,
      inconsistentSnapshot,
    );
    expect(snapshotRejected.status).toBe(400);
    expect(snapshotRejected.body.error.code).toBe('analysis_view_snapshot_mismatch');

    await env.pool.query(
      `UPDATE analysis_views
       SET visualization_spec = jsonb_set(visualization_spec, '{schemaVersion}', '2'::jsonb)
       WHERE id = $1`,
      [id],
    );
    const readRejected = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}`,
    );
    expect(readRejected.status).toBe(409);
    expect(readRejected.body.error.code).toBe('analysis_view_schema_unsupported');
  });

  it('lets explicit project deletion cascade saved answers and their append-only audit', async () => {
    const deleted = await api(
      env,
      env.personalToken,
      'DELETE',
      `/api/v1/projects/${env.projectSlug}`,
      { confirm_slug: env.projectSlug },
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({ deleted: true, slug: env.projectSlug });
    await expect(env.pool.query(
      'SELECT count(*)::int AS count FROM analysis_views WHERE project_id = $1',
      [env.projectId],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(env.pool.query(
      'SELECT count(*)::int AS count FROM analysis_view_audit WHERE project_id = $1',
      [env.projectId],
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
