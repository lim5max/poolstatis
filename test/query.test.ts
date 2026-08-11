import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMetric, api, createTestEnv, hoursAgo, type TestEnv } from './helpers.js';
import { answerBlockSchema, evidenceBlockSchema, funnelSummarySchema } from '../src/services/controlTower.js';

let env: TestEnv;
const P = () => `/api/v1/projects/${env.projectSlug}`;

beforeAll(async () => {
  env = await createTestEnv();

  await activeMetric(env, { key: 'signup', source: { event: 'signup.completed' } });
  await activeMetric(env, { key: 'export', source: { event: 'doc.exported' } });
  await activeMetric(env, {
    key: 'export_users', type: 'unique_actors', source: { event: 'doc.exported' },
  });
  await activeMetric(env, {
    key: 'revenue', type: 'value',
    source: { event: 'checkout.completed', value_property: 'amount', agg: 'sum' },
  });
  await activeMetric(env, {
    key: 'pro_exports',
    source: { event: 'doc.exported', filters: [{ property: 'plan', op: 'eq', value: 'pro' }] },
  });

  // Three users: u1 completes the whole journey quickly, u2 signs up and
  // exports a day later (outside a 2h window), u3 only signs up.
  const events = [
    { event: 'signup.completed', distinct_id: 'u1', timestamp: hoursAgo(50) },
    { event: 'doc.exported', distinct_id: 'u1', timestamp: hoursAgo(49), properties: { plan: 'pro' } },
    { event: 'checkout.completed', distinct_id: 'u1', timestamp: hoursAgo(48), properties: { amount: 49 } },
    { event: 'signup.completed', distinct_id: 'u2', timestamp: hoursAgo(40) },
    { event: 'doc.exported', distinct_id: 'u2', timestamp: hoursAgo(10), properties: { plan: 'free' } },
    { event: 'checkout.completed', distinct_id: 'u2', timestamp: hoursAgo(9), properties: { amount: 15 } },
    { event: 'signup.completed', distinct_id: 'u3', timestamp: hoursAgo(30) },
    { event: 'doc.exported', distinct_id: 'u1', timestamp: hoursAgo(8), properties: { plan: 'pro' } },
  ];
  const res = await api(env, env.ingestToken, 'POST', '/i/v1/events', { events });
  if (res.body.accepted !== events.length) throw new Error(JSON.stringify(res.body));
});
afterAll(() => env.close());

describe('trend queries', () => {
  it('counts events per day', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'export', date_from: '-7d', interval: 'day',
    });
    expect(res.status).toBe(200);
    const total = res.body.series.reduce((s: number, p: any) => s + p.value, 0);
    expect(total).toBe(3);
    expect(res.body.meta.date_range).toBeDefined();
    expect(res.body.answer).toMatchObject({
      state: 'ready',
      primary_value: { value: 3, unit: 'count' },
      why_it_matters: 'test metric for export, informs nothing real',
    });
    expect(res.body.evidence).toMatchObject({
      state: 'trusted',
      source_refs: [{ kind: 'metric', key: 'export', purpose: 'test metric for export, informs nothing real' }],
      aggregation: 'count of accepted events',
      sample: { eligible: null, observed: 3, coverage: null },
      warnings: [],
      unavailable_reasons: [],
      reproducible_query: expect.objectContaining({ kind: 'trend', metric: 'export' }),
    });
    expect(() => answerBlockSchema.parse(res.body.answer)).not.toThrow();
    expect(() => evidenceBlockSchema.parse(res.body.evidence)).not.toThrow();
  });

  it('counts unique actors', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'export_users', date_from: '-7d', interval: 'month',
    });
    const total = res.body.series.reduce((s: number, p: any) => s + p.value, 0);
    expect(total).toBe(2); // u1 and u2
  });

  it('sums a value property', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'revenue', date_from: '-7d', interval: 'month',
    });
    const total = res.body.series.reduce((s: number, p: any) => s + p.value, 0);
    expect(total).toBe(64);
  });

  it('applies metric source filters', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'pro_exports', date_from: '-7d', interval: 'month',
    });
    const total = res.body.series.reduce((s: number, p: any) => s + p.value, 0);
    expect(total).toBe(2); // only u1's pro exports
  });

  it('breaks down by a property', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'export', date_from: '-7d', interval: 'month',
      breakdown: { property: 'plan' },
    });
    const byValue: Record<string, number> = {};
    for (const p of res.body.series) {
      byValue[p.breakdown_value] = (byValue[p.breakdown_value] ?? 0) + p.value;
    }
    expect(byValue).toEqual({ pro: 2, free: 1 });
  });

  it('refuses to trend a conversion metric, with a teaching hint', async () => {
    await api(env, env.secretToken, 'POST', `${P()}/metrics`, {
      key: 'signup_to_export',
      name: 'Signup → Export',
      purpose: 'Conversion from signup to first export within an hour window.',
      type: 'conversion',
      source: { from: { event: 'signup.completed' }, to: { event: 'doc.exported' }, window_seconds: 3600 },
    });
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'signup_to_export', date_from: '-7d',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('metric_not_trendable');
    expect(res.body.error.hint).toContain('funnel');
  });

  it('rejects unknown metric keys with a hint', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'ghost', date_from: '-7d',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.hint).toContain('register_metric');
  });
});

describe('funnel queries', () => {
  it('computes one adjacent-period comparison with the same project, environment and steps', async () => {
    await activeMetric(env, { key: 'comparison_started', source: { event: 'comparison.started' } });
    await activeMetric(env, { key: 'comparison_completed', source: { event: 'comparison.completed' } });
    const timestamp = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const events = [
      { event: 'comparison.started', distinct_id: 'previous-1', timestamp: timestamp(36) },
      { event: 'comparison.completed', distinct_id: 'previous-1', timestamp: timestamp(35) },
      { event: 'comparison.started', distinct_id: 'previous-2', timestamp: timestamp(36) },
      ...['current-1', 'current-2', 'current-3', 'current-4'].map((distinct_id) => ({
        event: 'comparison.started', distinct_id, timestamp: timestamp(12),
      })),
      ...['current-1', 'current-2', 'current-3'].map((distinct_id) => ({
        event: 'comparison.completed', distinct_id, timestamp: timestamp(11),
      })),
    ];
    const ingested = await api(env, env.ingestToken, 'POST', '/i/v1/events', { events });
    expect(ingested.body.accepted).toBe(events.length);

    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'funnel',
      steps: [{ metric: 'comparison_started' }, { metric: 'comparison_completed' }],
      date_from: timestamp(20),
      date_to: new Date(Date.now() + 60_000).toISOString(),
      env: 'prod',
    });

    expect(res.status).toBe(200);
    expect(res.body.steps.map((step: { actors: number }) => step.actors)).toEqual([4, 3]);
    expect(res.body.summary).toMatchObject({
      overall_conversion: 0.75,
      previous_overall_conversion: 0.5,
      delta_percentage_points: 25,
    });
    expect(res.body.answer.delta).toMatchObject({
      value: 25,
      unit: 'percentage_point',
      direction: 'up',
    });
  });

  it('computes step conversion with inline steps', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'funnel',
      steps: [{ metric: 'signup' }, { metric: 'export' }],
      date_from: '-7d',
    });
    expect(res.status).toBe(200);
    const [s1, s2] = res.body.steps;
    expect(s1.actors).toBe(3);
    expect(s1).toMatchObject({
      label: 'signup',
      metric_key: 'signup',
      purpose: 'test metric for signup, informs nothing real',
      category: null,
    });
    expect(s2.actors).toBe(2); // u1 + u2 exported after signup within 7d window
    expect(s2.metric_key).toBe('export');
    expect(s2.conversion_from_start).toBeCloseTo(2 / 3, 3);
    expect(res.body.summary).toEqual({
      overall_conversion: 2 / 3,
      previous_overall_conversion: null,
      delta_percentage_points: null,
      biggest_absolute_loss: {
        from_step: 0,
        to_step: 1,
        lost_actors: 1,
        drop_rate: 1 / 3,
      },
      biggest_percentage_loss: {
        from_step: 0,
        to_step: 1,
        lost_actors: 1,
        drop_rate: 1 / 3,
      },
    });
    expect(res.body.answer).toMatchObject({
      state: 'ready',
      primary_value: { value: (2 / 3) * 100, unit: 'percent' },
    });
    expect(res.body.evidence).toMatchObject({
      state: 'trusted',
      denominator: { label: 'actors who reached signup', value: 3 },
      reproducible_query: expect.objectContaining({ kind: 'funnel' }),
    });
    expect(() => answerBlockSchema.parse(res.body.answer)).not.toThrow();
    expect(() => evidenceBlockSchema.parse(res.body.evidence)).not.toThrow();
    expect(() => funnelSummarySchema.parse(res.body.summary)).not.toThrow();
  });

  it('respects the conversion window of a saved funnel', async () => {
    await api(env, env.secretToken, 'POST', `${P()}/funnels`, {
      key: 'fast_activation',
      name: 'Fast activation',
      goal: 'Signup to first export within two hours of signing up.',
      steps: [
        { metric_key: 'signup', label: 'Signup' },
        { metric_key: 'export', label: 'First export' },
      ],
      window_seconds: 7200,
    });
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'funnel', funnel: 'fast_activation', date_from: '-7d',
    });
    const [s1, s2] = res.body.steps;
    expect(s1.actors).toBe(3);
    expect(s2.actors).toBe(1); // only u1 exported within 2h; u2 took 30h
    expect(s1.label).toBe('Signup');
    expect(s1).toMatchObject({
      metric_key: 'signup',
      purpose: 'test metric for signup, informs nothing real',
      category: null,
    });
  });

  it('rejects funnel and steps together', async () => {
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'funnel', funnel: 'fast_activation', steps: [{ metric: 'signup' }, { metric: 'export' }],
      date_from: '-7d',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_funnel_query');
  });
});

describe('state metrics and entities', () => {
  it('answers a state metric as a snapshot', async () => {
    await api(env, env.secretToken, 'POST', `${P()}/entity-types`, {
      name: 'account',
      description: 'Customer accounts used to test state metric snapshots.',
    });
    await api(env, env.ingestToken, 'POST', '/i/v1/entities', {
      entities: [
        { entity_type: 'account', entity_id: 'a1', properties: { plan: 'pro' } },
        { entity_type: 'account', entity_id: 'a2', properties: { plan: 'free' } },
        { entity_type: 'account', entity_id: 'a3', properties: { plan: 'pro' } },
      ],
    });
    await activeMetric(env, {
      key: 'paying_accounts', type: 'state',
      source: { entity_type: 'account', filters: [{ property: 'plan', op: 'ne', value: 'free' }] },
    });
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'trend', metric: 'paying_accounts', date_from: '-1d',
    });
    expect(res.body.series).toHaveLength(1);
    expect(res.body.series[0].value).toBe(2);
    expect(res.body.meta.note).toContain('snapshot');
  });

  it('orders entities numerically by a property', async () => {
    await api(env, env.ingestToken, 'POST', '/i/v1/entities', {
      entities: [
        { entity_type: 'account', entity_id: 'a1', properties: { seats: 30 } },
        { entity_type: 'account', entity_id: 'a2', properties: { seats: 4 } },
        { entity_type: 'account', entity_id: 'a3', properties: { seats: 250 } },
      ],
    });
    const res = await api(env, env.secretToken, 'POST', `${P()}/query`, {
      kind: 'entities', entity_type: 'account',
      order_by: { property: 'seats', dir: 'desc' },
    });
    expect(res.body.entities.map((e: any) => e.entity_id)).toEqual(['a3', 'a1', 'a2']);
  });
});

describe('query cache invalidation', () => {
  it('makes a successful ingest visible to the next identical query', async () => {
    const query = { kind: 'trend', metric: 'export', date_from: '-7d', interval: 'month' };
    const before = await api(env, env.secretToken, 'POST', `${P()}/query`, query);
    const beforeTotal = before.body.series.reduce((sum: number, point: { value: number }) => sum + point.value, 0);

    const ingested = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'doc.exported', distinct_id: 'cache-invalidation-user' }],
    });
    expect(ingested.body.accepted).toBe(1);

    const after = await api(env, env.secretToken, 'POST', `${P()}/query`, query);
    const afterTotal = after.body.series.reduce((sum: number, point: { value: number }) => sum + point.value, 0);
    expect(afterTotal).toBe(beforeTotal + 1);
  });
});
