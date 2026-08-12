import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/errors.js';
import {
  createProject,
  evaluateKeyOutcomeReadiness,
  KEY_OUTCOME_CONTRACT_LIMIT,
  listProjectsWithStats,
  PORTFOLIO_PROJECT_CONCURRENCY,
  unscopedKeyOutcomeReadiness,
} from '../src/services/projects.js';
import { PostgresEventStore } from '../src/stores/postgresEventStore.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

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
        key_outcome_available: false,
        key_outcome_readiness: expect.objectContaining({
          state: 'unavailable',
          guardrail: expect.objectContaining({
            state: 'fail',
            reason_code: 'no_active_contract',
          }),
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

  it('marks a key outcome available only after its active contract passes the typed query guardrail', async () => {
    const register = await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/metrics`, {
      key: 'portfolio_outcome',
      name: 'Portfolio outcome',
      type: 'count',
      source: { event: 'portfolio.outcome', filters: [] },
      purpose: 'Measures the portfolio key outcome through the typed query contract.',
    });
    expect(register.status).toBe(201);
    expect((await api(
      env,
      env.secretToken,
      'PATCH',
      `/api/v1/projects/${env.projectSlug}/metrics/portfolio_outcome`,
      { status: 'active' },
    )).status).toBe(200);
    await env.pool.query(
      `INSERT INTO measurement_contracts (
         project_id, key, name, business_hypothesis, decision_owner,
         primary_metric_key, guardrail_metric_keys, target_filters,
         baseline_window_days, observation_window_days, minimum_sample_size,
         expected_direction, external_references, status, declaration_hash, created_by
       ) VALUES (
         $1, 'portfolio_key_outcome', 'Portfolio key outcome',
         'A queryable primary outcome keeps project portfolio status actionable.', 'Product owner',
         'portfolio_outcome', '[]'::jsonb, '[]'::jsonb,
         30, 30, 1, 'increase', '{}'::jsonb, 'active', 'portfolio-test-hash', 'test'
       )`,
      [env.projectId],
    );

    const ready = await api(env, env.personalToken, 'GET', '/api/v1/projects/portfolio?env=prod');
    const readyProject = ready.body.projects.find((project: { slug: string }) => project.slug === env.projectSlug);
    expect(readyProject).toMatchObject({
      key_outcome_available: true,
      key_outcome_readiness: {
        state: 'ready',
        contract_key: 'portfolio_key_outcome',
        metric_key: 'portfolio_outcome',
        guardrail: {
          id: 'key_outcome_queryable',
          state: 'pass',
          reason_code: 'query_succeeded',
          observed_events: 0,
        },
      },
    });

    expect((await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/metrics/portfolio_outcome/deprecate`,
      { reason: 'The source contract is intentionally retired for readiness verification.' },
    )).status).toBe(200);
    const unavailable = await api(env, env.personalToken, 'GET', '/api/v1/projects/portfolio?env=prod');
    const unavailableProject = unavailable.body.projects.find((project: { slug: string }) => project.slug === env.projectSlug);
    expect(unavailableProject).toMatchObject({
      key_outcome_available: false,
      key_outcome_readiness: {
        state: 'unavailable',
        contract_key: null,
        metric_key: null,
        guardrail: {
          id: 'key_outcome_queryable',
          state: 'fail',
          reason_code: 'no_queryable_outcome',
          observed_events: null,
        },
      },
    });
    expect(unavailableProject.key_outcome_readiness.guardrail.reason).toContain('typed outcome query');
  });

  it('does not present a PostHog outcome as scoped to an unverified Poolstatis environment', async () => {
    const scoped = await createTestEnv({ ingestBuffer: false });
    try {
      await scoped.pool.query(
        `INSERT INTO metrics (project_id, key, name, purpose, type, source, status)
         VALUES ($1, 'external_outcome', 'External outcome',
           'Measures an external outcome whose environment mapping is intentionally absent.',
           'count', $2::jsonb, 'active')`,
        [scoped.projectId, JSON.stringify({
          event: 'external.completed',
          filters: [],
          data_source: 'posthog',
          source_connection_id: '00000000-0000-0000-0000-000000000001',
        })],
      );
      await insertOutcomeContract(scoped, 'external_contract', 'external_outcome');
      const aggregateMetricWindow = vi.fn();

      const readiness = await evaluateKeyOutcomeReadiness(
        scoped.pool,
        { aggregateMetricWindow } as never,
        scoped.projectId,
        'prod',
      );

      expect(readiness).toMatchObject({
        state: 'unavailable',
        contract_key: null,
        metric_key: null,
        guardrail: {
          state: 'fail',
          reason_code: 'external_environment_scope_unverified',
          observed_events: null,
        },
      });
      expect(readiness.guardrail.reason).toContain('prod');
      expect(aggregateMetricWindow).not.toHaveBeenCalled();
    } finally {
      await scoped.close();
    }
  });

  it('caps deterministic contract evaluation and fails closed when active contracts exceed the cap', async () => {
    const bounded = await createTestEnv({ ingestBuffer: false });
    try {
      await activeMetric(bounded, {
        key: 'bounded_outcome',
        source: { event: 'bounded.completed', filters: [] },
        purpose: 'Measures the bounded contract selection behavior for portfolio readiness.',
      });
      for (let index = 0; index < KEY_OUTCOME_CONTRACT_LIMIT + 2; index += 1) {
        await insertOutcomeContract(bounded, `bounded_${String(index).padStart(2, '0')}`, 'bounded_outcome');
      }
      const aggregateMetricWindow = vi.fn().mockRejectedValue(
        new ApiError(400, 'contract_metric_incompatible', 'test query is intentionally unavailable'),
      );

      const readiness = await evaluateKeyOutcomeReadiness(
        bounded.pool,
        { aggregateMetricWindow } as never,
        bounded.projectId,
        'prod',
      );

      expect(aggregateMetricWindow).toHaveBeenCalledTimes(KEY_OUTCOME_CONTRACT_LIMIT);
      expect(readiness.guardrail).toMatchObject({
        state: 'fail',
        reason_code: 'contract_selection_bounded',
        observed_events: null,
      });
      expect(readiness.guardrail.reason).toContain(`first ${KEY_OUTCOME_CONTRACT_LIMIT}`);
    } finally {
      await bounded.close();
    }
  });

  it('bounds concurrent project readiness evaluation while preserving row order', async () => {
    const bounded = await createTestEnv({ ingestBuffer: false });
    try {
      const orgId = (await bounded.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM projects WHERE id = $1',
        [bounded.projectId],
      )).rows[0]!.org_id;
      for (let index = 0; index < PORTFOLIO_PROJECT_CONCURRENCY * 2; index += 1) {
        await createProject(bounded.pool, orgId, `bounded-project-${index}`, `Bounded project ${index}`);
      }
      let inFlight = 0;
      let maximumInFlight = 0;
      const evaluator = vi.fn(async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return unscopedKeyOutcomeReadiness();
      });

      const projects = await listProjectsWithStats(
        bounded.pool,
        new PostgresEventStore(bounded.pool),
        orgId,
        { env: 'prod', outcomeReadinessEvaluator: evaluator },
      );

      expect(evaluator).toHaveBeenCalledTimes(PORTFOLIO_PROJECT_CONCURRENCY * 2 + 1);
      expect(maximumInFlight).toBe(PORTFOLIO_PROJECT_CONCURRENCY);
      expect(projects.map((project) => project.name)).toEqual([
        bounded.projectSlug,
        ...Array.from({ length: PORTFOLIO_PROJECT_CONCURRENCY * 2 }, (_, index) => `Bounded project ${index}`),
      ]);
    } finally {
      await bounded.close();
    }
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

async function insertOutcomeContract(target: TestEnv, key: string, metricKey: string): Promise<void> {
  await target.pool.query(
    `INSERT INTO measurement_contracts (
       project_id, key, name, business_hypothesis, decision_owner,
       primary_metric_key, guardrail_metric_keys, target_filters,
       baseline_window_days, observation_window_days, minimum_sample_size,
       expected_direction, external_references, status, declaration_hash, created_by
     ) VALUES (
       $1, $2, $2,
       'A bounded query guardrail keeps portfolio readiness safe and deterministic.', 'Product owner',
       $3, '[]'::jsonb, '[]'::jsonb,
       30, 30, 1, 'increase', '{}'::jsonb, 'active', $2, 'test'
     )`,
    [target.projectId, key, metricKey],
  );
}
