import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject } from '../src/services/projects.js';
import { api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false });
});

afterAll(() => env.close());

describe('environment-scoped project portfolio', () => {
  it('separates accepted current-cycle usage from event-time health and from other environments', async () => {
    const orgId = (await env.pool.query<{ org_id: string }>(
      'SELECT org_id::text FROM projects WHERE id = $1',
      [env.projectId],
    )).rows[0]!.org_id;
    const other = await createProject(env.pool, orgId, `portfolio-other-${Date.now()}`, 'Portfolio other');
    await env.pool.query(
      `INSERT INTO usage_ledger (
         org_id, project_id, env, meter_key, period_start, quantity, source_batch, dedupe_key, ingested_at
       ) VALUES
         ($1, $2, 'prod', 'events_stored', date_trunc('month', now())::date, 5, 'portfolio-main-prod', 'portfolio-main-prod', now() - interval '1 hour'),
         ($1, $2, 'dev', 'events_stored', date_trunc('month', now())::date, 9, 'portfolio-main-dev', 'portfolio-main-dev', now()),
         ($1, $3, 'prod', 'events_stored', date_trunc('month', now())::date, 3, 'portfolio-other-prod', 'portfolio-other-prod', now())`,
      [orgId, env.projectId, other.id],
    );
    await env.pool.query(
      `INSERT INTO events (project_id, env, event, "timestamp", distinct_id, properties, registered) VALUES
         ($1, 'prod', 'portfolio.prod', now(), 'prod-actor', '{}'::jsonb, true),
         ($1, 'dev', 'portfolio.dev', now(), 'dev-actor-1', '{}'::jsonb, false),
         ($1, 'dev', 'portfolio.dev', now(), 'dev-actor-2', '{}'::jsonb, false)`,
      [env.projectId],
    );

    const prod = await api(env, env.personalToken, 'GET', '/api/v1/projects/portfolio?env=prod');

    expect(prod.status).toBe(200);
    expect(prod.body).toMatchObject({
      schema_version: 1,
      generated_at: expect.any(String),
      scope: {
        credential: 'organization',
        environment: 'prod',
        usage_cycle: {
          from: expect.stringMatching(/T00:00:00\.000Z$/),
          to: expect.stringMatching(/T00:00:00\.000Z$/),
          timezone: 'UTC',
          basis: 'ingest_time',
        },
      },
    });
    expect(prod.body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: env.projectSlug,
        environment: 'prod',
        events_30d: 1,
        registered_coverage_30d: 1,
        last_event_at: expect.any(String),
        current_usage: expect.objectContaining({
          accepted_events: 5,
          source: 'usage_ledger',
          basis: 'ingest_time',
          last_ingest_at: expect.any(String),
        }),
      }),
      expect.objectContaining({
        slug: other.slug,
        environment: 'prod',
        events_30d: 0,
        current_usage: expect.objectContaining({ accepted_events: 3 }),
      }),
    ]));

    const dev = await api(env, env.personalToken, 'GET', '/api/v1/projects/portfolio?env=dev');
    expect(dev.status).toBe(200);
    expect(dev.body.scope.environment).toBe('dev');
    const devMain = dev.body.projects.find((project: { slug: string }) => project.slug === env.projectSlug);
    expect(devMain).toMatchObject({ events_30d: 2, registered_coverage_30d: 0 });
    expect(devMain.current_usage.accepted_events).toBe(9);
    expect(dev.body.projects.find((project: { slug: string }) => project.slug === other.slug).current_usage.accepted_events).toBe(0);
  });

  it('keeps organization and project credentials bounded and rejects invalid callers or environments', async () => {
    const secret = await api(env, env.secretToken, 'GET', '/api/v1/projects/portfolio?env=prod');
    expect(secret.status).toBe(200);
    expect(secret.body.scope).toMatchObject({ credential: 'project', environment: 'prod' });
    expect(secret.body.projects.map((project: { slug: string }) => project.slug)).toEqual([env.projectSlug]);

    const ingestDenied = await api(env, env.ingestToken, 'GET', '/api/v1/projects/portfolio?env=prod');
    expect(ingestDenied.status).toBe(403);
    expect(ingestDenied.body.error.code).toBe('wrong_key_kind');

    const invalidEnv = await api(env, env.personalToken, 'GET', '/api/v1/projects/portfolio?env=prod%2Eall');
    expect(invalidEnv.status).toBe(400);
    expect(invalidEnv.body.error.code).toBe('invalid_query_param');
  });

  it('never widens the authenticated organization', async () => {
    const foreign = await createTestEnv({ ingestBuffer: false });
    try {
      const response = await api(foreign, foreign.personalToken, 'GET', '/api/v1/projects/portfolio?env=prod');
      expect(response.status).toBe(200);
      expect(response.body.projects.map((project: { slug: string }) => project.slug)).toEqual([foreign.projectSlug]);
      expect(response.body.projects.map((project: { slug: string }) => project.slug)).not.toContain(env.projectSlug);
    } finally {
      await foreign.close();
    }
  });
});
