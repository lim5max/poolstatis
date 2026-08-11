import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, hoursAgo, type TestEnv } from './helpers.js';
import { createProject } from '../src/services/projects.js';
import { recordWarnings } from '../src/services/warnings.js';
import { controlTowerResultSchema } from '../src/services/controlTower.js';
import { getOrganizationUsageControl, usageControlResultSchema } from '../src/services/usage.js';

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
          primary_action: {
            id: 'review_ingest_rejected',
            kind: 'navigate',
            label: 'Review ingest warnings',
            href: '/data?tab=warnings&env=prod&warning=rejected',
          },
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
      'answer', 'attention', 'evidence', 'generated_at', 'home_funnel_key', 'primary_action', 'request_id',
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

  it('counts only warning occurrences inside the selected control-tower window', async () => {
    const warningEnv = await createTestEnv({ ingestBuffer: false });
    try {
      await recordWarnings(warningEnv.pool, warningEnv.projectId, 'prod', [{
        kind: 'rejected',
        event: 'windowed.warning',
        detail: 'windowed warning count regression',
        count: 1,
      }]);
      const signature = (await warningEnv.pool.query<{ signature_id: string }>(
        `UPDATE ingest_warnings
         SET count = count + 100,
             first_seen = now() - interval '31 days'
         WHERE project_id = $1 AND env = 'prod' AND kind = 'rejected' AND event = 'windowed.warning'
         RETURNING signature_id::text`,
        [warningEnv.projectId],
      )).rows[0]!.signature_id;
      await warningEnv.pool.query(
        `INSERT INTO ingest_warning_occurrences (signature_id, bucket, count)
         VALUES ($1, date_trunc('hour', now() - interval '31 days'), 100)`,
        [signature],
      );

      const result = await api(
        warningEnv,
        warningEnv.secretToken,
        'GET',
        `/api/v1/projects/${warningEnv.projectSlug}/control-tower?env=prod&range=30d`,
      );

      expect(result.status).toBe(200);
      const warning = result.body.attention.find((item: { rule_id: string }) => item.rule_id === 'ingest.rejected');
      expect(warning).toMatchObject({
        reason: '1 observations across 1 event names are recorded in this warning class.',
        evidence: {
          aggregation: 'ingest warning occurrences in the selected control-tower window by warning class and event name; raw samples are excluded',
          sample: { eligible: null, observed: 1, coverage: null },
        },
      });
    } finally {
      await warningEnv.close();
    }
  });

  it('deep-links entity conflicts to the existing Data health tab', async () => {
    const qualityEnv = await createTestEnv({ ingestBuffer: false });
    try {
      const entityType = await api(
        qualityEnv,
        qualityEnv.secretToken,
        'POST',
        `/api/v1/projects/${qualityEnv.projectSlug}/entity-types`,
        { name: 'order', description: 'Orders used to verify control-tower entity status conflicts.' },
      );
      expect(entityType.status).toBe(201);
      await activeMetric(qualityEnv, {
        key: 'tower_order_completed',
        type: 'count',
        source: { event: 'order.completed' },
        purpose: 'Detect completed orders whose mutable entity state still disagrees with event evidence.',
      });
      const entity = await api(qualityEnv, qualityEnv.ingestToken, 'POST', '/i/v1/entities', {
        entities: [{ entity_type: 'order', entity_id: 'order-1', properties: { status: 'pending' } }],
      });
      expect(entity.status).toBe(200);
      const ingested = await api(qualityEnv, qualityEnv.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'control-tower-quality-conflict',
        events: [{
          event: 'order.completed',
          distinct_id: 'quality-actor',
          properties: { entity_id: 'order-1' },
        }],
      });
      expect(ingested.status).toBe(200);

      const result = await api(
        qualityEnv,
        qualityEnv.secretToken,
        'GET',
        `/api/v1/projects/${qualityEnv.projectSlug}/control-tower?env=prod&range=30d`,
      );

      expect(result.status).toBe(200);
      expect(result.body.attention).toEqual(expect.arrayContaining([
        expect.objectContaining({
          rule_id: 'data_quality.entity_status',
          primary_action: {
            id: 'review_data_quality',
            kind: 'navigate',
            label: 'Review data quality',
            href: '/data?tab=health&env=prod&quality=conflict',
          },
        }),
      ]));
    } finally {
      await qualityEnv.close();
    }
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

  it('selects one goal-matched Home funnel for both the snapshot and attention contract', async () => {
    const funnelEnv = await createTestEnv({ ingestBuffer: false });
    try {
      await activeMetric(funnelEnv, { key: 'retention_started', source: { event: 'retention.started' } });
      await activeMetric(funnelEnv, { key: 'retention_completed', source: { event: 'retention.completed' } });
      await activeMetric(funnelEnv, { key: 'activation_started', source: { event: 'activation.started' } });
      await activeMetric(funnelEnv, { key: 'activation_completed', source: { event: 'activation.completed' } });
      await api(funnelEnv, funnelEnv.secretToken, 'POST', `/api/v1/projects/${funnelEnv.projectSlug}/funnels`, {
        key: 'a_retention_path',
        name: 'Retention path',
        goal: 'See whether retained accounts return after their first outcome.',
        steps: [
          { metric_key: 'retention_started', label: 'Started retention window' },
          { metric_key: 'retention_completed', label: 'Returned' },
        ],
        window_seconds: 86_400,
      });
      await api(funnelEnv, funnelEnv.secretToken, 'POST', `/api/v1/projects/${funnelEnv.projectSlug}/funnels`, {
        key: 'z_activation_path',
        name: 'Activation path',
        goal: 'See whether new accounts complete activation.',
        steps: [
          { metric_key: 'activation_started', label: 'Started activation' },
          { metric_key: 'activation_completed', label: 'Activated' },
        ],
        window_seconds: 86_400,
      });
      const intent = await api(funnelEnv, funnelEnv.secretToken, 'PUT', `/api/v1/projects/${funnelEnv.projectSlug}/intent`, {
        project_mode: 'product',
        website_domain: null,
        goal_ids: ['activation'],
        custom_goal: null,
        primary_goal_id: 'activation',
      });
      expect(intent.status).toBe(200);
      const ingested = await api(funnelEnv, funnelEnv.ingestToken, 'POST', '/i/v1/events', {
        batch_id: 'control-tower-goal-funnel',
        events: [
          { event: 'activation.started', distinct_id: 'activation-a', timestamp: hoursAgo(3) },
          { event: 'activation.completed', distinct_id: 'activation-a', timestamp: hoursAgo(2) },
          { event: 'activation.started', distinct_id: 'activation-b', timestamp: hoursAgo(1) },
        ],
      });
      expect(ingested.body.accepted).toBe(3);

      const result = await api(
        funnelEnv,
        funnelEnv.secretToken,
        'GET',
        `/api/v1/projects/${funnelEnv.projectSlug}/control-tower?env=prod&range=30d`,
      );

      expect(result.status).toBe(200);
      expect(result.body.home_funnel_key).toBe('z_activation_path');
      expect(result.body.attention).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'funnel.biggest_loss.z_activation_path',
          affected: [{ kind: 'funnel', ref: 'z_activation_path' }],
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
        expect.objectContaining({ percent: 50, state: 'reached', reached_or_projected_at: expect.any(String), notification_state: 'not_configured', audit_source: 'usage_ledger' }),
        expect.objectContaining({ percent: 75, state: 'projected', reached_or_projected_at: expect.any(String), notification_state: 'not_configured', audit_source: 'usage_ledger' }),
        expect.objectContaining({ percent: 90, state: 'projected', reached_or_projected_at: expect.any(String), notification_state: 'not_configured', audit_source: 'usage_ledger' }),
        expect.objectContaining({ percent: 100, state: 'projected', reached_or_projected_at: expect.any(String), notification_state: 'not_configured', audit_source: 'usage_ledger' }),
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
      reconciliation: {
        metered_quantity: 70,
        attributed_quantity: 70,
        difference: 0,
        unattributed_quantity: 0,
        overattributed_quantity: 0,
        state: 'reconciled',
      },
      evidence: expect.objectContaining({
        source_refs: [{ kind: 'usage_ledger', meter: 'events_stored' }],
        aggregation: expect.stringContaining('ingest time'),
        sample: { eligible: 7, observed: 2, coverage: 2 / 7 },
      }),
      attention: [
        expect.objectContaining({
          id: 'usage.threshold.75',
          priority: { blocking_now: false, forecasted_at: expect.any(String) },
        }),
        expect.objectContaining({
          id: 'usage.threshold.90',
          priority: { blocking_now: false, forecasted_at: expect.any(String) },
        }),
        expect.objectContaining({
          id: 'usage.threshold.100',
          priority: { blocking_now: false, forecasted_at: expect.any(String) },
        }),
      ],
    });
    expect(() => usageControlResultSchema.parse(result.body)).not.toThrow();
    expect(Object.keys(result.body).sort()).toEqual([
      'answer', 'attention', 'cap', 'contributors', 'cycle', 'evidence', 'generated_at',
      'meter', 'pace', 'primary_action', 'reconciliation', 'request_id', 'schema_version', 'scope',
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
          { percent: 50, state: 'not_applicable', reached_or_projected_at: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
          { percent: 75, state: 'not_applicable', reached_or_projected_at: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
          { percent: 90, state: 'not_applicable', reached_or_projected_at: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
          { percent: 100, state: 'not_applicable', reached_or_projected_at: null, notification_state: 'not_configured', audit_source: 'usage_ledger' },
        ],
        contributors: [],
        reconciliation: {
          metered_quantity: 0,
          attributed_quantity: 0,
          difference: 0,
          unattributed_quantity: 0,
          overattributed_quantity: 0,
          state: 'reconciled',
        },
      });
      const secret = await api(foreign, foreign.secretToken, 'GET', `/api/v1/me/usage/control?period=${period}`);
      expect(secret.status).toBe(403);
    } finally {
      await foreign.close();
    }
  });

  it('keeps the previous seven-day contributor window across a UTC month boundary', async () => {
    const boundary = await createTestEnv({ ingestBuffer: false });
    try {
      const orgId = (await boundary.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM projects WHERE id = $1',
        [boundary.projectId],
      )).rows[0]!.org_id;
      await boundary.pool.query(
        `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity)
         VALUES ($1, 'events_stored', '2026-08-01', 30)`,
        [orgId],
      );
      await boundary.pool.query(
        `INSERT INTO usage_ledger (
           org_id, project_id, env, meter_key, period_start, quantity,
           source_batch, dedupe_key, ingested_at
         ) VALUES
           ($1, $2, 'prod', 'events_stored', '2026-07-01', 10, 'boundary-previous', 'boundary-previous', '2026-07-30T12:00:00.000Z'),
           ($1, $2, 'prod', 'events_stored', '2026-08-01', 10, 'boundary-current-1', 'boundary-current-1', '2026-08-01T12:00:00.000Z'),
           ($1, $2, 'prod', 'events_stored', '2026-08-01', 10, 'boundary-current-2', 'boundary-current-2', '2026-08-02T12:00:00.000Z'),
           ($1, $2, 'prod', 'events_stored', '2026-08-01', 10, 'boundary-current-3', 'boundary-current-3', '2026-08-03T12:00:00.000Z')`,
        [orgId, boundary.projectId],
      );

      const result = await getOrganizationUsageControl(
        boundary.pool,
        orgId,
        '2026-08',
        new Date('2026-08-03T18:00:00.000Z'),
      );

      expect(result.contributors).toEqual([
        expect.objectContaining({
          project_slug: boundary.projectSlug,
          environment: 'prod',
          accepted_events: 30,
          change_7d: 2,
        }),
      ]);
    } finally {
      await boundary.close();
    }
  });

  it('orders a reached hard limit before other reached thresholds', async () => {
    const reached = await createTestEnv({ ingestBuffer: false });
    try {
      const orgId = (await reached.pool.query<{ org_id: string }>(
        'SELECT org_id::text FROM projects WHERE id = $1',
        [reached.projectId],
      )).rows[0]!.org_id;
      const period = new Date().toISOString().slice(0, 7);
      await reached.pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit, warning_thresholds)
         VALUES ($1, 'events_stored', 100, ARRAY[50, 75, 90]::bigint[])`,
        [orgId],
      );
      await reached.pool.query(
        `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity)
         VALUES ($1, 'events_stored', $2::date, 100)`,
        [orgId, `${period}-01`],
      );
      await reached.pool.query(
        `INSERT INTO usage_ledger (
           org_id, project_id, env, meter_key, period_start, quantity,
           source_batch, dedupe_key, ingested_at
         ) VALUES ($1, $2, 'prod', 'events_stored', $3::date, 100, 'hard-limit', 'hard-limit', now())`,
        [orgId, reached.projectId, `${period}-01`],
      );

      const result = await api(reached, reached.personalToken, 'GET', `/api/v1/me/usage/control?period=${period}`);

      expect(result.status).toBe(200);
      expect(result.body.attention.map((item: { id: string }) => item.id)).toEqual([
        'usage.threshold.100',
        'usage.threshold.90',
        'usage.threshold.75',
      ]);
      expect(result.body.attention[0].priority).toEqual({ blocking_now: true, forecasted_at: null });
    } finally {
      await reached.close();
    }
  });
});
