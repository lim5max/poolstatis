import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolstatisClient } from './client';

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
    expect(result.attention[0]).toMatchObject({ severity: 'info', state: 'unavailable' });
    expect(result.attention[0]?.primary_action).toMatchObject({ kind: 'retry', label: 'Reload' });
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
      threshold_forecasts: [{ percent: 75, state: 'future_threshold', reached_or_projected_at: null, notification_state: 'future_notification', audit_source: 'usage_ledger' }],
      contributors: [],
      reconciliation: { metered_quantity: 50, attributed_quantity: 50, difference: 0, unattributed_quantity: 0, overattributed_quantity: 0, state: 'future_reconciliation' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(futureUsage), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await new PoolstatisClient('https://core.example', 'pt_test').usageControl('2026-08');

    expect(result.answer.state).toBe('unavailable');
    expect(result.cap).toMatchObject({ state: 'not_configured', value: null, remaining: null });
    expect(result.pace.confidence).toBe('insufficient');
    expect(result.threshold_forecasts[0]).toMatchObject({ state: 'not_applicable', notification_state: 'not_configured' });
    expect(result.reconciliation.state).toBe('partial');
  });
});
