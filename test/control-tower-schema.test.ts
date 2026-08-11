import { describe, expect, it } from 'vitest';
import { funnelControlBlocks, funnelSummarySchema } from '../src/services/controlTower.js';

describe('control tower serialization contracts', () => {
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
});
