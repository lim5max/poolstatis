import { describe, expect, it } from 'vitest';
import { subtractUtcCalendarMonths } from '../src/services/retentionPolicy.js';

describe('calendar retention cutoff', () => {
  it('matches PostgreSQL month subtraction at month ends', () => {
    expect(subtractUtcCalendarMonths(
      new Date('2026-03-31T12:34:56.789Z'),
      1,
    ).toISOString()).toBe('2026-02-28T12:34:56.789Z');
    expect(subtractUtcCalendarMonths(
      new Date('2024-03-31T12:34:56.789Z'),
      1,
    ).toISOString()).toBe('2024-02-29T12:34:56.789Z');
    expect(subtractUtcCalendarMonths(
      new Date('2026-01-30T00:00:00.000Z'),
      2,
    ).toISOString()).toBe('2025-11-30T00:00:00.000Z');
  });
});
