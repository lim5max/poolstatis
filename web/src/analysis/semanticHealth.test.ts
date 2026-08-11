import { describe, expect, it } from 'vitest';
import { buildDataHealth, buildRegistryHealth, credentialHealth, previousPeriodQuery, summarizeAnswer } from './semanticHealth';

describe('semantic health helpers', () => {
  it('builds a previous exact period and a plain-language delta', () => {
    const query = { kind: 'trend', metric: 'active', interval: 'day', date_from: '2026-08-01T00:00:00Z', date_to: '2026-08-08T00:00:00Z', env: 'prod', filters: [] } as import('./visualization').AnalysisQueryInput;
    expect(previousPeriodQuery(query)).toMatchObject({ date_from: '2026-07-25T00:00:00.000Z', date_to: '2026-08-01T00:00:00.000Z' });
    const meta = { computed_at: '2026-08-08T00:00:00Z', date_range: { from: '2026-08-01T00:00:00Z', to: '2026-08-08T00:00:00Z' }, sampling: null, source: 'native' as const };
    const summary = summarizeAnswer('Active accounts',
      { kind: 'trend', series: [{ bucket: '2026-08-06', value: 5 }, { bucket: '2026-08-07', value: 7 }], meta },
      { kind: 'trend', series: [{ bucket: '2026-07-30', value: 4 }, { bucket: '2026-07-31', value: 6 }], meta },
      { metric: { type: 'count', source: { event: 'active' } } });
    expect(summary).toMatchObject({ currentValue: 12, previousValue: 10, deltaPercent: 0.2 });
    expect(summary.takeaway).toContain('Up 20%');
    const unsafe = summarizeAnswer('People',
      { kind: 'trend', series: [{ bucket: '2026-08-07', value: 8, breakdown_value: 'pro' }, { bucket: '2026-08-07', value: 7, breakdown_value: 'free' }], meta },
      null,
      { metric: { type: 'unique_actors', source: { event: 'active' } }, breakdown: 'plan' });
    expect(unsafe).toMatchObject({ currentValue: null, delta: null, comparison: 'No safely comparable period headline' });
  });

  it('separates improvements from confirmed healthy data without inventing warning trends', () => {
    const now = new Date('2026-08-11T00:00:00Z');
    const health = buildDataHealth({
      now,
      observed: [{ event: 'checkout.done', count: 9, registered_share: 0.9, last_seen: now.toISOString() }],
      issues: [],
      checked: { terminal_event_specs: 1, evidence_rows: 2 },
      warnings: [{ kind: 'rejected', event: 'checkout.done', detail: 'invalid', sample: null, count: 5, first_seen: '2026-01-01T00:00:00Z', last_seen: '2026-08-10T00:00:00Z' }],
      metrics: [{ key: 'checkout', source: { event: 'checkout.done' } } as never],
    });
    expect(health.improvements.map((item) => item.code)).toEqual(['recent_rejections', 'off_standard']);
    expect(health.improvements[0]?.detail).toContain('lifetime counts');
    expect(health.doingGreat.map((item) => item.code)).toContain('entity_consistency');
  });

  it('does not claim entity consistency without a configured terminal rule and matched evidence', () => {
    const health = buildDataHealth({
      observed: [], issues: [], checked: { terminal_event_specs: 0, evidence_rows: 0 }, warnings: [], metrics: [],
    });
    expect(health.improvements.map((item) => item.code)).toContain('terminal_specs_missing');
    expect(health.doingGreat.map((item) => item.code)).not.toContain('entity_consistency');
  });

  it('reports saved usage separately from generic answer availability', () => {
    const metric = { key: 'active', status: 'active', type: 'count', source: { event: 'active' } } as never;
    const health = buildRegistryHealth([metric], [], new Map([['active', {
      observed_events: [{ event: 'active', count: 4 }],
      used_by: { funnels: [], insights: [] },
    } as never]]));
    expect(health.unused).toBe(1);
    expect(health.rows[0]?.usedByAnswers).toContain('Product answer');
  });

  it('does not call a metric unused when saved-consumer evidence is unavailable', () => {
    const metric = { key: 'active', status: 'active', type: 'count', source: { event: 'active' } } as never;
    const health = buildRegistryHealth([metric], [], new Map([['active', null]]), null);
    expect(health).toMatchObject({ unused: 0, usageUnavailable: 1 });
    expect(health.rows[0]?.unused).toBeNull();
  });

  it('makes rotation replacement-first and reserves revoked for actual revocation', () => {
    const result = credentialHealth({ created_at: '2025-01-01T00:00:00Z', last_used_at: '2026-08-10T00:00:00Z', revoked_at: null }, new Date('2026-08-11T00:00:00Z'));
    expect(result.status).toBe('review');
    expect(result.label).toBe('Review age');
    expect(result.recommendation).toContain('No server rotation deadline');
  });
});
