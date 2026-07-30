import { describe, expect, it } from 'vitest';
import { chartSeriesStroke } from './chartTokens';

describe('chart series contrast', () => {
  it('gives the leading neon-lime series a dark boundary', () => {
    expect(chartSeriesStroke(0)).toBe('var(--chart-1-stroke)');
    expect(chartSeriesStroke(5)).toBe('var(--chart-1-stroke)');
    expect(chartSeriesStroke(1)).toBeUndefined();
  });
});
