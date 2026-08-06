import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';

let alpha: TestEnv;
let beta: TestEnv;

beforeAll(async () => {
  alpha = await createTestEnv({ ingestBuffer: false, queryCache: false });
  beta = await createTestEnv({ ingestBuffer: false, queryCache: false });
});

afterAll(async () => {
  await alpha.close();
  await beta.close();
});

describe('project intent API', () => {
  it('keeps a legacy project usable without fabricating intent', async () => {
    const response = await api(
      alpha,
      alpha.secretToken,
      'GET',
      `/api/v1/projects/${alpha.projectSlug}/intent`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ intent: null });
  });

  it('validates and persists one to three unique goals with a selected primary goal', async () => {
    const response = await api(
      alpha,
      alpha.secretToken,
      'PUT',
      `/api/v1/projects/${alpha.projectSlug}/intent`,
      {
        project_mode: 'both',
        website_domain: 'Docs.Example.com',
        goal_ids: ['website_conversion', 'activation', 'custom'],
        custom_goal: 'Understand whether docs visitors become active users.',
        primary_goal_id: 'activation',
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.intent).toMatchObject({
      schema_version: 1,
      project_mode: 'both',
      website_domain: 'docs.example.com',
      goal_ids: ['website_conversion', 'activation', 'custom'],
      custom_goal: 'Understand whether docs visitors become active users.',
      primary_goal_id: 'activation',
      generated_plan: null,
      generated_plan_source: 'deterministic',
    });
    expect(response.body.intent.created_at).toMatch(/Z$/);

    const read = await api(
      alpha,
      alpha.personalToken,
      'GET',
      `/api/v1/projects/${alpha.projectSlug}/intent`,
    );
    expect(read.body.intent).toMatchObject(response.body.intent);
  });

  it.each([
    [{ project_mode: 'website', website_domain: null, goal_ids: [], custom_goal: null, primary_goal_id: 'website_traffic' }],
    [{ project_mode: 'website', website_domain: null, goal_ids: ['website_traffic', 'website_traffic'], custom_goal: null, primary_goal_id: 'website_traffic' }],
    [{ project_mode: 'website', website_domain: null, goal_ids: ['website_traffic'], custom_goal: null, primary_goal_id: 'activation' }],
    [{ project_mode: 'product', website_domain: null, goal_ids: ['custom'], custom_goal: null, primary_goal_id: 'custom' }],
    [{ project_mode: 'product', website_domain: null, goal_ids: ['activation'], custom_goal: 'Unexpected custom text', primary_goal_id: 'activation' }],
    [{ project_mode: 'website', website_domain: 'https://example.com/path', goal_ids: ['website_traffic'], custom_goal: null, primary_goal_id: 'website_traffic' }],
  ])('rejects invalid intent %#', async (payload) => {
    const response = await api(
      beta,
      beta.secretToken,
      'PUT',
      `/api/v1/projects/${beta.projectSlug}/intent`,
      payload,
    );
    expect(response.status).toBe(400);
  });

  it('does not allow a project-scoped secret to read or update another tenant', async () => {
    const deniedRead = await api(
      alpha,
      alpha.secretToken,
      'GET',
      `/api/v1/projects/${beta.projectSlug}/intent`,
    );
    const deniedWrite = await api(
      alpha,
      alpha.secretToken,
      'PUT',
      `/api/v1/projects/${beta.projectSlug}/intent`,
      {
        project_mode: 'website',
        website_domain: null,
        goal_ids: ['website_traffic'],
        custom_goal: null,
        primary_goal_id: 'website_traffic',
      },
    );

    expect(deniedRead.status).toBe(404);
    expect(deniedWrite.status).toBe(404);
    expect((await api(
      beta,
      beta.secretToken,
      'GET',
      `/api/v1/projects/${beta.projectSlug}/intent`,
    )).body).toEqual({ intent: null });
  });
});
