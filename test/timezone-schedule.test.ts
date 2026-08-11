import { describe, expect, test } from 'vitest';
import { nextZonedOccurrence } from '../src/services/timezoneSchedule.js';

describe('timezone-aware insight cadence', () => {
  test('resolves daily and weekly wall-clock schedules without using host timezone', () => {
    expect(nextZonedOccurrence(
      { timezone: 'UTC', frequency: 'daily', localTime: '09:15', weekday: null },
      new Date('2026-08-11T08:00:00.000Z'),
    )).toEqual({
      scheduledAt: new Date('2026-08-11T09:15:00.000Z'),
      localRunKey: '2026-08-11',
      resolution: 'exact',
    });
    expect(nextZonedOccurrence(
      { timezone: 'UTC', frequency: 'weekly', localTime: '09:15', weekday: 3 },
      new Date('2026-08-11T10:00:00.000Z'),
    )).toEqual({
      scheduledAt: new Date('2026-08-12T09:15:00.000Z'),
      localRunKey: '2026-08-12',
      resolution: 'exact',
    });
  });

  test('shifts a nonexistent spring-forward minute to the first valid local minute', () => {
    expect(nextZonedOccurrence(
      { timezone: 'America/New_York', frequency: 'daily', localTime: '02:30', weekday: null },
      new Date('2026-03-08T05:00:00.000Z'),
    )).toEqual({
      scheduledAt: new Date('2026-03-08T07:00:00.000Z'),
      localRunKey: '2026-03-08',
      resolution: 'dst_shifted',
    });
  });

  test('chooses the first repeated fall-back minute and keeps one local run key', () => {
    expect(nextZonedOccurrence(
      { timezone: 'America/New_York', frequency: 'daily', localTime: '01:30', weekday: null },
      new Date('2026-11-01T04:00:00.000Z'),
    )).toEqual({
      scheduledAt: new Date('2026-11-01T05:30:00.000Z'),
      localRunKey: '2026-11-01',
      resolution: 'exact',
    });
  });

  test('rejects invalid timezones instead of silently using UTC', () => {
    expect(() => nextZonedOccurrence(
      { timezone: 'Mars/Olympus', frequency: 'daily', localTime: '09:00', weekday: null },
      new Date('2026-08-11T00:00:00.000Z'),
    )).toThrow(/timezone/i);
  });
});
