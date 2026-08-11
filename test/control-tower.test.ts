import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, hoursAgo, type TestEnv } from './helpers.js';
import { createProject } from '../src/services/projects.js';
import { recordWarnings } from '../src/services/warnings.js';
import { controlTowerResultSchema } from '../src/services/controlTower.js';
import { usageControlResultSchema } from '../src/services/usage.js';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false });
});

afterAll(() => env.close());

describe('project control tower', () => {
  it('returns one server-owned answer/attention/evidence/action contract without raw warning samples', async () => {
    await recordWarnings(env.pool, env.projectId, 'prod', [{
      kind: 'rejected',
      event: 'Bad Event',
      detail: 'event name is invalid',
      sample: { distinct_id: 'private-actor', properties: { email: 'private@example.com' } },
      count: 2,
    }]);

    const result = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/control-tower?env=prod&range=30d`,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      schema_version: 1,
      request_id: expect.any(String),
      generated_at: expect.any(String),
      scope: {
        project_slug: env.projectSlug,
        environment: 'prod',
        window: { from: expect.any(String), to: expect.any(String), timezone: 'UTC' },
      },
      answer: { state: 'partial', primary_value: { value: expect.any(Number), unit: 'count' } },
      attention: expect.arrayContaining([
        expect.objectContaining({
          rule_id: 'ingest.rejected',
          rule_version: 1,
          severity: 'high',
          affected: [{ kind: 'project', ref: `${env.projectSlug}:prod` }],
          evidence: expect.objectContaining({
            state: 'blocked',
            source_refs: [{ kind: 'operator_rule', rule_id: 'ingest.rejected', rule_version: 1 }],
          }),
          primary_action: expect.objectContaining({ id: 'review_ingest_rejected', kind: 'navigate' }),
        }),
      ]),
      evidence: expect.objectContaining({
        source_refs: expect.arrayContaining([
          { kind: 'operator_rule', rule_id: 'onboarding.gates', rule_version: 1 },
          { kind: 'operator_rule', rule_id: 'ingest.warnings', rule_version: 1 },
          { kind: 'operator_rule', rule_id: 'data_quality.entity_status', rule_version: 1 },
        ]),
        warnings: expect.any(Array),
        unavailable_reasons: expect.any(Array),
      }),
      primary_action: expect.objectContaining({ id: expect.any(String), kind: 'navigate' }),
      secondary_actions: expect.any(Array),
    });
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain('private-actor');
    expect(serialized).not.toContain('private@example.com');
    expect(() => controlTowerResultSchema.parse(result.body)).not.toThrow();
    expect(Object.keys(result.body).sort()).toEqual([
      'answer', 'attention', 'evidence', 'generated_at', 'primary_action', 'request_id',
      'schema_version', 'scope', 'secondary_actions',
    ]);
  });

  it('preserves project scope for secret keys and validates bounded ranges', async () => {
    const orgId = (await env.pool.query<{ org_id: string }>(
      'SELECT org_id::text FROM projects WHERE id = $1',
      [env.projectId],
    )).rows[0]!.org_id;
    const other = await createProject(env.pool, orgId, `tower-other-${Date.now()}`, 'Other');
    const forbidden = await api(env, env.secretToken, 'GET', `/api/v1/projects/${other.slug}/control-tower`);
    expect(forbidden.status).toBe(403);
    const invalid = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/control-tower?range=365d`);
    expect(invalid.status).toBe(400);
  });

  it('adds the saved funnel biggest loss to the server-owned attention order', async () => {
    const funnelEnv = await createTestEnv({ ingestBuffer: false });
    try {
      await activeMetric(funnelEnv, { key: 'tower_entered', source: { event: 'tower.entered' } });
      await activeMetric(funnelEnv, { key: 'tower_completed', source: { event: 'tower.completed' } });
      const funnel = await api(funnelEnv, funnelEnv.secretToken, 'POST', `/api/v1/projects/${funnelEnv.projectSlug}/funnels`, {
        key: 'tower_activation',
        name: 'Tower activation',
        goal: 'See whether people who enter the control tower complete activation.',
        steps: [
          { metric_key: 'tower_entered', label: 'Entered' },
          { metric_key: 'tower_completed', label: 'Completed' },
        ],
        window_seconds: 86_400,
      });
      expect(funnel.status).toBe(201);
      const ingested = await api(funnelEnv, funnelEnv.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'control-tower-funnel-loss',
        events: [
          { event: 'tower.entered', distinct_id: 'tower-a', timestamp: hoursAgo(4) },
          { event: 'tower.completed', distinct_id: 'tower-a', timestamp: hoursAgo(3) },
          { event: 'tower.entered', distinct_id: 'tower-b', timestamp: hoursAgo(2) },
          { event: 'tower.entered', distinct_id: 'tower-c', timestamp: hoursAgo(1) },
        ],
      });
      expect(ingested.body.accepted).toBe(4);

      const result = await api(
        funnelEnv,
        funnelEnv.secretToken,
        'GET',
        `/api/v1/projects/${funnelEnv.projectSlug}/control-tower?env=prod&range=30d`,
      );

      expect(result.status).toBe(200);
      expect(result.body.attention).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'funnel.biggest_loss.tower_activation',
          rule_id: 'funnel.biggest_loss',
          rule_version: 1,
          title: 'Biggest loss: Entered -> Completed',
          reason: '2 actors were lost at this step (66.7%).',
          impact: 'See whether people who enter the control tower complete activation.',
          affected: [{ kind: 'funnel', ref: 'tower_activation' }],
          evidence: expect.objectContaining({
            state: 'trusted',
            source_refs: [{
              kind: 'funnel',
              key: 'tower_activation',
              goal: 'See whether people who enter the control tower complete activation.',
            }],
          }),
          primary_action: expect.objectContaining({
            id: 'investigate_funnel_step.tower_activation.0.1',
            kind: 'navigate',
            href: '/analyze/funnels?funnel=tower_activation&env=prod&from_step=0&to_step=1',
          }),
        }),
      ]));
    } finally {
      await funnelEnv.close();
    }
  });
});

describe('organization usage control', () => {
  it('derives UTC-cycle pace, forecast, thresholds and contributors from accepted ledger facts', async () => {
    const orgId = (await env.pool.query<{ org_id: string }>(
      'SELECT org_id::text FROM projects WHERE id = $1',
      [env.projectId],
    )).rows[0]!.org_id;
    const other = await createProject(env.pool, orgId, `usage-other-${Date.now()}`, 'Other usage');
    const period = new Date().toISOString().slice(0, 7);
    await env.pool.query(
      `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit, warning_thresholds)
       VALUES ($1, 'events_stored', 100, ARRAY[50, 75, 90]::bigint[])`,
      [orgId],
    );
    await env.pool.query(
      `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity)
       VALUES ($1, 'events_stored', $2::date, 70)`,
      [orgId, `${period}-01`],
    );
    await env.pool.query(
      `INSERT INTO usage_ledger (
         org_id, project_id, env, meter_key, period_start, quantity,
         source_batch, dedupe_key, ingested_at
       ) VALUES
         ($1, $2, 'prod', 'events_stored', $4::date, 20, 'tower-main-old', 'tower-main-old', now() - interval '2 days'),
         ($1, $2, 'prod', 'events_stored', $4::date, 40, 'tower-main-now', 'tower-main-now', now()),
         ($1, $3, 'dev', 'events_stored', $4::date, 10, 'tower-other-now', 'tower-other-now', now())`,
      [orgId, env.projectId, other.id, `${period}-01`],
    );

    const result = await api(env, env.personalToken, 'GET', `/api/v1/me/usage/control?period=${period}`);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      schema_version: 1,
      meter: 'events_stored',
      scope: { organization_id: orgId, window: { timezone: 'UTC' } },
      cycle: { from: `${period}-01T00:00:00.000Z`, to: expect.any(String), timezone: 'UTC' },
      cap: { state: 'finite', value: 100, remaining: 30, consequence_at_100_percent: expect.any(String) },
      pace: { observed_days: 2, events_per_day_7d: 10, projected_cycle_end: expect.any(Number), confidence: 'sufficient' },
      threshold_forecasts: [
        expect.objectContaining({ percent: 50, state: 'reached', reached_or_projected_at: expect.any(String) }),
        expect.objectContaining({ percent: 75, state: 'projected', reached_or_projected_at: expect.any(String) }),
        expect.objectContaining({ percent: 90, state: 'projected', reached_or_projected_at: expect.any(String) }),
        expect.objectContaining({ percent: 100, state: 'projected', reached_or_projected_at: expect.any(String) }),
      ],
      contributors: expect.arrayContaining([
        expect.objectContaining({
          project_slug: env.projectSlug,
          project_name: env.projectSlug,
          environment: 'prod',
          accepted_events: 60,
          share: 60 / 70,
          change_7d: null,
          last_ingest_at: expect.any(String),
        }),
        expect.objectContaining({
          project_slug: other.slug,
          project_name: 'Other usage',
          environment: 'dev',
          accepted_events: 10,
          share: 10 / 70,
        }),
      ]),
      evidence: expect.objectContaining({
        source_refs: [{ kind: 'usage_ledger', meter: 'events_stored' }],
        aggregation: expect.stringContaining('ingest time'),
        sample: { eligible: 7, observed: 2, coverage: 2 / 7 },
      }),
    });
    expect(() => usageControlResultSchema.parse(result.body)).not.toThrow();
    expect(Object.keys(result.body).sort()).toEqual([
      'answer', 'attention', 'cap', 'contributors', 'cycle', 'evidence', 'generated_at',
      'meter', 'pace', 'primary_action', 'request_id', 'schema_version', 'scope',
      'secondary_actions', 'threshold_forecasts',
    ]);
  });

  it('does not invent a cap or a forecast and keeps usage organization-scoped', async () => {
    const foreign = await createTestEnv({ ingestBuffer: false });
    try {
      const period = new Date().toISOString().slice(0, 7);
      const result = await api(foreign, foreign.personalToken, 'GET', `/api/v1/me/usage/control?period=${period}&org_id=ignored`);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        cap: { state: 'not_configured', value: null, remaining: null, consequence_at_100_percent: null },
        pace: { observed_days: 0, events_per_day_7d: null, projected_cycle_end: null, confidence: 'insufficient' },
        threshold_forecasts: [
          { percent: 50, state: 'not_applicable', reached_or_projected_at: null },
          { percent: 75, state: 'not_applicable', reached_or_projected_at: null },
          { percent: 90, state: 'not_applicable', reached_or_projected_at: null },
          { percent: 100, state: 'not_applicable', reached_or_projected_at: null },
        ],
        contributors: [],
      });
      const secret = await api(foreign, foreign.secretToken, 'GET', `/api/v1/me/usage/control?period=${period}`);
      expect(secret.status).toBe(403);
    } finally {
      await foreign.close();
    }
  });
});
