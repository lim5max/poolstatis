import { describe, expect, it } from 'vitest';
import {
  previousAnalyticsRange,
  rangeFromSearchParams,
  rangeSearchParams,
  resolveAnalyticsRange,
} from './ranges';

const now = new Date('2026-08-18T11:49:00.000Z');

describe('analytics ranges', () => {
  it('resolves today as the current partial UTC calendar day', () => {
    expect(resolveAnalyticsRange({ kind: 'preset', preset: 'today' }, now, 'UTC')).toEqual({
      from: '2026-08-18T00:00:00.000Z',
      to: '2026-08-18T11:49:00.000Z',
      label: 'Today',
      days: 1,
      complete: false,
    });
  });

  it('resolves yesterday as one complete UTC calendar day', () => {
    expect(resolveAnalyticsRange({ kind: 'preset', preset: 'yesterday' }, now, 'UTC')).toEqual({
      from: '2026-08-17T00:00:00.000Z',
      to: '2026-08-18T00:00:00.000Z',
      label: 'Yesterday',
      days: 1,
      complete: true,
    });
  });

  it('keeps rolling presets anchored to the current instant', () => {
    expect(resolveAnalyticsRange({ kind: 'preset', preset: '7d' }, now, 'UTC')).toMatchObject({
      from: '2026-08-11T11:49:00.000Z',
      to: '2026-08-18T11:49:00.000Z',
      label: 'Last 7 days',
      days: 7,
      complete: false,
    });
  });

  it('converts inclusive custom calendar dates to a half-open interval', () => {
    expect(resolveAnalyticsRange({ kind: 'custom', from: '2026-08-01', to: '2026-08-03' }, now, 'UTC')).toEqual({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-04T00:00:00.000Z',
      label: 'Aug 1–3, 2026',
      days: 3,
      complete: true,
    });
  });

  it('rejects reversed or impossible custom dates', () => {
    expect(() => resolveAnalyticsRange({ kind: 'custom', from: '2026-08-04', to: '2026-08-03' }, now, 'UTC'))
      .toThrow('Custom range start must not be after its end');
    expect(() => resolveAnalyticsRange({ kind: 'custom', from: '2026-02-30', to: '2026-03-03' }, now, 'UTC'))
      .toThrow('Custom range dates must be valid calendar dates');
  });

  it('builds the previous equivalent half-open interval', () => {
    expect(previousAnalyticsRange({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-04T00:00:00.000Z',
      label: 'Aug 1–3, 2026',
      days: 3,
      complete: true,
    })).toEqual({
      from: '2026-07-29T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      label: 'Previous period',
      days: 3,
      complete: true,
    });
  });

  it('round-trips presets and custom ranges through URL search params', () => {
    const preset = { kind: 'preset', preset: 'today' } as const;
    expect(rangeFromSearchParams(rangeSearchParams(preset))).toEqual(preset);

    const custom = { kind: 'custom', from: '2026-08-01', to: '2026-08-03' } as const;
    expect(rangeFromSearchParams(rangeSearchParams(custom))).toEqual(custom);
    expect(rangeFromSearchParams(new URLSearchParams('range=unknown'))).toEqual({ kind: 'preset', preset: '30d' });
  });
});
