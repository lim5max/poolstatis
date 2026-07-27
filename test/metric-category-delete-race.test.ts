import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { deleteMetricCategory } from '../src/services/metricCategories.js';

describe('metric category deletion race', () => {
  it('converts a concurrent metric reference FK violation into the stable 409 contract', async () => {
    const category = {
      id: 'category-id',
      key: 'governance',
      name: 'Governance',
      description: 'Measures project-specific governance outcomes.',
      domain: 'custom',
      color: '#6D5BD0',
      is_system: false,
      metric_count: 0,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [category] })
      .mockRejectedValueOnce(Object.assign(new Error('foreign key violation'), { code: '23503' }))
      .mockResolvedValueOnce({ rows: [{ ...category, metric_count: 1 }] });
    const pool = { query } as unknown as pg.Pool;

    await expect(deleteMetricCategory(pool, 'project-id', 'governance')).rejects.toMatchObject({
      statusCode: 409,
      code: 'metric_category_in_use',
      details: { metric_count: 1 },
    });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
