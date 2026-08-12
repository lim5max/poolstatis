import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './client';
import { decodeControlTowerResult } from './control-tower-decoder';

describe('PoolstatisClient usage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the legacy month request and sends encoded inclusive month-range bounds', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PoolstatisClient('https://core.example', 'pt_test');

    await client.usage('2026-08');
    await client.usageRange('2026-03', '2026-08');
    await client.usageControl('2026-08');
    await client.controlTower('alpha/beta', 'prod', '30d');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://core.example/api/v1/me/usage?period=2026-08',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://core.example/api/v1/me/usage/range?from=2026-03&to=2026-08',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://core.example/api/v1/me/usage/control?period=2026-08',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'https://core.example/api/v1/projects/alpha%2Fbeta/control-tower?env=prod&range=30d',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('fails closed when a future control-tower enum arrives', async () => {
    const future = {
      schema_version: 1,
      request_id: 'req-future',
      generated_at: '2026-08-12T00:00:00.000Z',
      scope: { window: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-12T00:00:00.000Z', timezone: 'UTC' } },
      answer: {
        state: 'future_ready',
        headline: 'Future state',
        takeaway: 'Do not render this as ready.',
        why_it_matters: 'Unknown state must fail closed.',
      },
      attention: [{
        id: 'future-item', rule_id: 'future.rule', rule_version: 2,
        severity: 'future_severity', state: 'future_state', title: 'Future item', reason: 'Unknown', impact: 'Unknown', affected: [],
        evidence: { state: 'future_trust', freshness: 'future_freshness', as_of: '2026-08-12T00:00:00.000Z', source_refs: [], warnings: [], unavailable_reasons: [] },
        primary_action: { id: 'future-action', kind: 'future_mutation', label: 'Run future mutation' },
      }],
      evidence: { state: 'future_trust', freshness: 'future_freshness', as_of: '2026-08-12T00:00:00.000Z', source_refs: [], warnings: [], unavailable_reasons: [] },
      primary_action: { id: 'future-action', kind: 'future_mutation', label: 'Run future mutation' },
      secondary_actions: [],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(future), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await new PoolstatisClient('https://core.example', 'pt_test').controlTower('alpha');

    expect(result.answer.state).toBe('unavailable');
    expect(result.evidence).toMatchObject({ state: 'unavailable', freshness: 'unknown' });
    expect(result.primary_action).toMatchObject({ kind: 'retry', label: 'Reload' });
    expect(result.attention).toEqual([]);
  });

  it('fails closed for future usage-specific enum values', async () => {
    const futureUsage = {
      schema_version: 1,
      request_id: 'req-usage-future',
      generated_at: '2026-08-12T00:00:00.000Z',
      scope: { window: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', timezone: 'UTC' } },
      answer: { state: 'ready', headline: 'Usage', takeaway: 'Usage', why_it_matters: 'Usage' },
      attention: [],
      evidence: { state: 'trusted', freshness: 'fresh', as_of: '2026-08-12T00:00:00.000Z', source_refs: [], warnings: [], unavailable_reasons: [] },
      primary_action: { id: 'review', kind: 'navigate', label: 'Review', href: '/usage' },
      secondary_actions: [],
      meter: 'events_stored',
      cycle: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', timezone: 'UTC' },
      cap: { state: 'future_cap', value: 100, remaining: 50, consequence_at_100_percent: 'Pause ingest.' },
      pace: { observed_days: 7, events_per_day_7d: 10, projected_cycle_end: 300, confidence: 'future_confidence' },
      threshold_forecasts: [{ percent: 75, state: 'future_threshold', reached_or_projected_at: null, configured_threshold: null, notification_state: 'future_notification', audit_source: 'usage_ledger' }],
      contributors: [],
      reconciliation: { metered_quantity: 50, attributed_quantity: 50, difference: 0, unattributed_quantity: 0, overattributed_quantity: 0, state: 'future_reconciliation' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(futureUsage), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await new PoolstatisClient('https://core.example', 'pt_test').usageControl('2026-08');

    expect(result.answer.state).toBe('unavailable');
    expect(result.cap).toMatchObject({ state: 'unavailable', value: null, remaining: null });
    expect(result.pace.confidence).toBe('insufficient');
    expect(result.threshold_forecasts[0]).toMatchObject({ state: 'not_applicable', notification_state: 'not_configured' });
    expect(result.reconciliation.state).toBe('partial');
  });

  it('returns a complete unavailable contract for malformed current-schema payloads', async () => {
    const malformed = {
      schema_version: 1,
      request_id: 'req-malformed',
      generated_at: '0',
      scope: { window: { from: '0', to: 'also-not-a-date', timezone: 'UTC' } },
      answer: { state: 'ready', headline: 'Unsafe success', takeaway: 'Unsafe', why_it_matters: 'Unsafe' },
      attention: [],
      evidence: { state: 'trusted', freshness: 'fresh', as_of: 'not-a-date', source_refs: [], warnings: [], unavailable_reasons: [] },
      primary_action: { id: 'unsafe', kind: 'navigate', label: 'Unsafe navigation' },
      secondary_actions: [],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(malformed), { status: 200 }));

    const result = await new PoolstatisClient('https://core.example', 'pt_test').controlTower('alpha');

    expect(result.answer).toMatchObject({ state: 'unavailable', headline: 'Answer unavailable' });
    expect(result.primary_action).toMatchObject({ kind: 'retry', label: 'Reload' });
    expect(Number.isFinite(Date.parse(result.generated_at))).toBe(true);
    expect(Number.isFinite(Date.parse(result.scope.window.from))).toBe(true);
  });

  it.each([
    '2026-02-30T00:00:00.000Z',
    '2026-04-31T00:00:00.000Z',
    '2026-08-12T24:00:00.000Z',
  ])('fails closed for calendar-invalid timestamps: %s', (generatedAt) => {
    const result = decodeControlTowerResult({
      schema_version: 1,
      request_id: 'req-invalid-calendar',
      generated_at: generatedAt,
      scope: { window: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-12T00:00:00.000Z', timezone: 'UTC' } },
      answer: { state: 'ready', headline: 'Unsafe success', takeaway: 'Unsafe', why_it_matters: 'Unsafe' },
      attention: [],
      evidence: { state: 'trusted', freshness: 'fresh', as_of: '2026-08-12T00:00:00.000Z', source_refs: [], warnings: [], unavailable_reasons: [] },
      primary_action: { id: 'review', kind: 'navigate', label: 'Review', href: '/' },
      secondary_actions: [],
    });

    expect(result.answer).toMatchObject({ state: 'unavailable', headline: 'Answer unavailable' });
  });

  it('accepts only a typed server-owned delta on attention items', () => {
    const base = {
      schema_version: 1,
      request_id: 'req-attention-delta',
      generated_at: '2026-08-12T00:00:00.000Z',
      scope: { window: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-12T00:00:00.000Z', timezone: 'UTC' } },
      answer: { state: 'ready', headline: 'Funnel', takeaway: 'Measured loss', why_it_matters: 'Review the goal.' },
      attention: [{
        id: 'funnel.biggest_loss.signup', rule_id: 'funnel.biggest_loss', rule_version: 1,
        severity: 'info', state: 'open', title: 'Biggest loss', reason: '12 actors were lost.', impact: 'Complete signup.', affected: [],
        delta: { value: -12.5, unit: 'percentage_point', direction: 'down', comparison_label: 'previous exact period' },
        evidence: { state: 'trusted', freshness: 'fresh', as_of: '2026-08-12T00:00:00.000Z', source_refs: [], warnings: [], unavailable_reasons: [] },
        primary_action: { id: 'investigate', kind: 'navigate', label: 'Investigate', href: '/analyze/funnels' },
      }],
      evidence: { state: 'trusted', freshness: 'fresh', as_of: '2026-08-12T00:00:00.000Z', source_refs: [], warnings: [], unavailable_reasons: [] },
      primary_action: { id: 'investigate', kind: 'navigate', label: 'Investigate', href: '/analyze/funnels' },
      secondary_actions: [],
    };

    const attention = base.attention[0]!;
    expect(decodeControlTowerResult(base).attention[0]?.delta).toEqual(attention.delta);
    expect(decodeControlTowerResult({
      ...base,
      attention: [{ ...attention, delta: { ...attention.delta, unit: 'future_unit' } }],
    }).attention).toEqual([]);
  });

  it('never leaks partial usage fields when the current-schema shape is malformed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schema_version: 1,
      request_id: 'req-malformed-usage',
      generated_at: '2026-08-12T00:00:00.000Z',
      scope: { window: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', timezone: 'UTC' } },
      answer: { state: 'ready', headline: 'Unsafe usage', takeaway: 'Unsafe', why_it_matters: 'Unsafe' },
      attention: [],
      evidence: { state: 'trusted', freshness: 'fresh', as_of: '2026-08-12T00:00:00.000Z', source_refs: [], warnings: [], unavailable_reasons: [] },
      primary_action: { id: 'review', kind: 'navigate', label: 'Review', href: '/usage' },
      secondary_actions: [],
      meter: 'events_stored',
      cap: { state: 'finite', value: 100, remaining: 99, consequence_at_100_percent: 'Pause ingest.' },
      pace: { observed_days: 7, events_per_day_7d: 1, projected_cycle_end: 31, confidence: 'sufficient' },
      threshold_forecasts: [{ percent: 75, state: 'projected', reached_or_projected_at: 'invalid-date', configured_threshold: null, notification_state: 'not_configured', audit_source: 'usage_ledger' }],
      contributors: [],
      reconciliation: { metered_quantity: 1, attributed_quantity: 1, difference: 0, unattributed_quantity: 0, overattributed_quantity: 0, state: 'reconciled' },
    }), { status: 200 }));

    const result = await new PoolstatisClient('https://core.example', 'pt_test').usageControl('2026-08');

    expect(result.answer).toMatchObject({ state: 'unavailable', headline: 'Usage unavailable' });
    expect(result.cycle).toEqual(result.scope.window);
    expect(result.cap).toMatchObject({ state: 'unavailable', value: null, remaining: null });
    expect(result.threshold_forecasts).toHaveLength(4);
    expect(result.threshold_forecasts.every((threshold) => threshold.state === 'not_applicable')).toBe(true);
  });

  it.each([
    ['negative observed days', (payload: any) => { payload.pace.observed_days = -2; }],
    ['negative ledger quantity', (payload: any) => { payload.reconciliation.metered_quantity = -1; }],
    ['string threshold percent', (payload: any) => { payload.threshold_forecasts[0].percent = '50'; }],
    ['negative contributor quantity', (payload: any) => { payload.contributors[0].accepted_events = -1; }],
    ['out-of-range contributor share', (payload: any) => { payload.contributors[0].share = 1.5; }],
  ])('fails closed for semantically invalid usage: %s', async (_name, mutate) => {
    const payload: any = {
      schema_version: 1,
      request_id: 'req-usage-semantics',
      generated_at: '2026-08-12T00:00:00.000Z',
      scope: { window: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z', timezone: 'UTC' } },
      answer: { state: 'ready', headline: 'Usage', takeaway: 'Usage', why_it_matters: 'Usage' },
      attention: [],
      evidence: { state: 'trusted', freshness: 'fresh', as_of: '2026-08-12T00:00:00.000Z', source_refs: [], warnings: [], unavailable_reasons: [] },
      primary_action: { id: 'review', kind: 'navigate', label: 'Review', href: '/usage' },
      secondary_actions: [],
      meter: 'events_stored',
      cycle: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z', timezone: 'UTC' },
      cap: { state: 'finite', value: 1_000, remaining: 900, consequence_at_100_percent: 'Pause ingest.' },
      pace: { observed_days: 7, events_per_day_7d: 10, projected_cycle_end: 310, confidence: 'sufficient' },
      threshold_forecasts: [50, 75, 90, 100].map((percent) => ({
        percent, state: 'not_projected', reached_or_projected_at: null,
        configured_threshold: null, notification_state: 'not_configured', audit_source: 'usage_ledger',
      })),
      contributors: [{
        project_slug: 'alpha', project_name: 'Alpha', environment: 'prod',
        accepted_events: 100, share: 1, change_7d: 0, last_ingest_at: '2026-08-12T00:00:00.000Z',
      }],
      reconciliation: {
        metered_quantity: 100, attributed_quantity: 100, difference: 0,
        unattributed_quantity: 0, overattributed_quantity: 0, state: 'reconciled',
      },
    };
    mutate(payload);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

    const result = await new PoolstatisClient('https://core.example', 'pt_test').usageControl('2026-08');

    expect(result.answer).toMatchObject({ state: 'unavailable', headline: 'Usage unavailable' });
    expect(result.reconciliation).toMatchObject({ metered_quantity: 0, attributed_quantity: 0, state: 'partial' });
  });
});
