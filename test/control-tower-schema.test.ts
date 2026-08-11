import { describe, expect, it } from 'vitest';
import {
  funnelControlBlocks,
  funnelSummarySchema,
  orderAttentionItems,
  trendControlBlocks,
  type AttentionItem,
} from '../src/services/controlTower.js';

describe('control tower serialization contracts', () => {
  it('keeps a unique-actor answer ready when the latest bucket is zero but the selected window is not empty', () => {
    const result = trendControlBlocks(
      {
        id: 'metric-1',
        key: 'weekly_active',
        name: 'Weekly active',
        purpose: 'Measures whether people return and remain active across the selected window.',
        category: 'retention',
        tags: [],
        type: 'unique_actors',
        source: { event: 'app.opened', filters: [] },
        status: 'active',
        owner: null,
        deprecation_reason: null,
        deprecated_at: null,
      },
      { kind: 'trend', metric: 'weekly_active', date_from: '-2d', interval: 'day', filters: [], env: 'prod' },
      [{ value: 4 }, { value: 0 }],
      new Date('2026-08-11T12:00:00.000Z'),
      'native',
    );

    expect(result.answer).toMatchObject({
      state: 'ready',
      headline: 'Weekly active latest bucket: 0',
      takeaway: '0 unique actors matched the latest returned bucket; 1 earlier bucket has observations in the selected window.',
      primary_value: { value: 0, unit: 'count', formatted: '0' },
    });
    expect(result.evidence).toMatchObject({
      aggregation: 'latest returned bucket unique actors; bucket counts are not summed because actors can repeat',
      sample: { eligible: 2, observed: 1, coverage: 0.5 },
    });
  });

  it('serializes funnel loss step references as stable zero-based indexes', () => {
    const result = funnelControlBlocks(
      {
        kind: 'funnel',
        steps: ['started', 'activated', 'paid'],
        date_from: '-30d',
        env: 'prod',
      },
      [
        { label: 'Started', metric_key: 'started', purpose: 'Measures entry into the product journey.', actors: 100 },
        { label: 'Activated', metric_key: 'activated', purpose: 'Measures completion of the activation outcome.', actors: 70 },
        { label: 'Paid', metric_key: 'paid', purpose: 'Measures conversion to a paid customer.', actors: 20 },
      ],
      new Date('2026-08-11T12:00:00.000Z'),
      'native',
    );

    expect(result.summary.biggest_absolute_loss).toEqual({
      from_step: 1,
      to_step: 2,
      lost_actors: 50,
      drop_rate: 50 / 70,
    });
    expect(result.summary.biggest_percentage_loss).toEqual({
      from_step: 1,
      to_step: 2,
      lost_actors: 50,
      drop_rate: 50 / 70,
    });
    expect(() => funnelSummarySchema.parse(JSON.parse(JSON.stringify(result.summary)))).not.toThrow();
  });

  it('does not invent a percentage loss when the step denominator is zero', () => {
    const result = funnelControlBlocks(
      { kind: 'funnel', steps: ['started', 'paid'], date_from: '-30d', env: 'prod' },
      [
        { label: 'Started', metric_key: 'started', purpose: 'Measures entry into the product journey.', actors: 0 },
        { label: 'Paid', metric_key: 'paid', purpose: 'Measures conversion to a paid customer.', actors: 0 },
      ],
      new Date('2026-08-11T12:00:00.000Z'),
      'native',
    );

    expect(result.summary.biggest_absolute_loss).toMatchObject({ drop_rate: null });
    expect(result.summary.biggest_percentage_loss).toBeNull();
  });

  it('computes the previous conversion and percentage-point delta on the server', () => {
    const result = funnelControlBlocks(
      { kind: 'funnel', steps: ['started', 'paid'], date_from: '-30d', env: 'prod' },
      [
        { label: 'Started', metric_key: 'started', purpose: 'Measures entry into the product journey.', actors: 100 },
        { label: 'Paid', metric_key: 'paid', purpose: 'Measures conversion to a paid customer.', actors: 75 },
      ],
      new Date('2026-08-11T12:00:00.000Z'),
      'native',
      undefined,
      [
        { label: 'Started', metric_key: 'started', purpose: 'Measures entry into the product journey.', actors: 80 },
        { label: 'Paid', metric_key: 'paid', purpose: 'Measures conversion to a paid customer.', actors: 40 },
      ],
    );

    expect(result.summary).toMatchObject({
      overall_conversion: 0.75,
      previous_overall_conversion: 0.5,
      delta_percentage_points: 25,
    });
    expect(result.answer.delta).toEqual({
      value: 25,
      unit: 'percentage_point',
      direction: 'up',
      comparison_label: 'previous exact period',
    });
  });

  it('keeps stable step order on equal losses and explains every tied transition in Evidence', () => {
    const result = funnelControlBlocks(
      { kind: 'funnel', steps: ['visited', 'started', 'paid'], date_from: '-30d', env: 'prod' },
      [
        { label: 'Visited', metric_key: 'visited', purpose: 'Measures entry into the product journey.', actors: 100 },
        { label: 'Started', metric_key: 'started', purpose: 'Measures signup intent.', actors: 50 },
        { label: 'Paid', metric_key: 'paid', purpose: 'Measures conversion to a paid customer.', actors: 0 },
      ],
      new Date('2026-08-11T12:00:00.000Z'),
      'native',
    );

    expect(result.summary.biggest_absolute_loss).toMatchObject({ from_step: 0, to_step: 1, lost_actors: 50 });
    expect(result.evidence.warnings).toContainEqual({
      code: 'equal_biggest_absolute_loss',
      message: 'Equal absolute losses were measured at Visited -> Started and Started -> Paid; stable funnel step order selected Visited -> Started.',
    });
  });

  it('explains stable percentage-loss selection when transitions have the same rate', () => {
    const result = funnelControlBlocks(
      { kind: 'funnel', steps: ['visited', 'started', 'paid'], date_from: '-30d', env: 'prod' },
      [
        { label: 'Visited', metric_key: 'visited', purpose: 'Measures entry into the product journey.', actors: 100 },
        { label: 'Started', metric_key: 'started', purpose: 'Measures signup intent.', actors: 50 },
        { label: 'Paid', metric_key: 'paid', purpose: 'Measures conversion to a paid customer.', actors: 25 },
      ],
      new Date('2026-08-11T12:00:00.000Z'),
      'native',
    );

    expect(result.summary.biggest_percentage_loss).toMatchObject({ from_step: 0, to_step: 1, drop_rate: 0.5 });
    expect(result.evidence.warnings).toContainEqual({
      code: 'equal_biggest_percentage_loss',
      message: 'Equal percentage losses were measured at Visited -> Started and Started -> Paid; stable funnel step order selected Visited -> Started.',
    });
  });
});

describe('server-owned attention ordering', () => {
  const item = (input: {
    id: string;
    severity: AttentionItem['severity'];
    blocking?: boolean;
    forecastedAt?: string | null;
    affected?: number;
    freshness?: AttentionItem['evidence']['freshness'];
  }): AttentionItem => ({
    id: input.id,
    rule_id: input.id,
    rule_version: 1,
    severity: input.severity,
    state: 'open',
    title: input.id,
    reason: `${input.id} reason`,
    impact: `${input.id} impact`,
    affected: Array.from({ length: input.affected ?? 1 }, (_, index) => ({ kind: 'answer' as const, ref: `${input.id}:${index}` })),
    evidence: {
      state: input.blocking ? 'blocked' : 'partial',
      as_of: '2026-08-11T12:00:00.000Z',
      freshness: input.freshness ?? 'fresh',
      source_refs: [],
      warnings: [],
      unavailable_reasons: [],
    },
    priority: {
      blocking_now: input.blocking ?? false,
      forecasted_at: input.forecastedAt ?? null,
    },
    primary_action: { id: `open-${input.id}`, kind: 'navigate', label: 'Open', href: '/' },
  });

  it('orders blocking consequences before forecast time, severity, affected scope and freshness', () => {
    const ordered = orderAttentionItems([
      item({ id: 'stale', severity: 'high', freshness: 'stale' }),
      item({ id: 'wide', severity: 'high', affected: 3 }),
      item({ id: 'later', severity: 'high', forecastedAt: '2026-08-13T12:00:00.000Z' }),
      item({ id: 'sooner', severity: 'low', forecastedAt: '2026-08-12T12:00:00.000Z' }),
      item({ id: 'blocking', severity: 'low', blocking: true }),
      item({ id: 'narrow', severity: 'high', affected: 1 }),
    ]);

    expect(ordered.map((candidate) => candidate.id)).toEqual([
      'blocking',
      'sooner',
      'later',
      'wide',
      'narrow',
      'stale',
    ]);
  });

  it('uses stable rule and item identifiers when every semantic priority is equal', () => {
    expect(orderAttentionItems([
      item({ id: 'rule-b', severity: 'medium' }),
      item({ id: 'rule-a', severity: 'medium' }),
    ]).map((candidate) => candidate.id)).toEqual(['rule-a', 'rule-b']);
  });
});
