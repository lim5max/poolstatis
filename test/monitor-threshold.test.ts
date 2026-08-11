import { describe, expect, test } from 'vitest';
import { evaluateMonitorThreshold } from '../src/services/monitorWorker.js';

describe('monitor threshold rules', () => {
  test.each([
    ['above', 21, 10, 20, true, 21],
    ['above', 19, 10, 20, false, 19],
    ['below', 19, 10, 20, true, 19],
    ['below', 21, 10, 20, false, 21],
    ['change_up_percent', 120, 100, 20, true, 20],
    ['change_down_percent', 80, 100, 20, true, 20],
  ] as const)('%s evaluates its threshold direction', (rule, current, previous, threshold, breached, comparison) => {
    expect(evaluateMonitorThreshold(rule, current, previous, threshold)).toEqual({ breached, comparison });
  });

  test('does not invent a percent change from a zero baseline', () => {
    expect(evaluateMonitorThreshold('change_up_percent', 10, 0, 20)).toEqual({ breached: false, comparison: null });
  });
});
