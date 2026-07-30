import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '../src/db.js';
import { ensureRetentionIndexes } from '../src/services/retentionIndexes.js';
import { TEST_DB_URL } from './urls.js';

let pool: pg.Pool;

beforeAll(() => {
  pool = createPool(TEST_DB_URL);
});

afterAll(async () => {
  await pool.end();
});

describe('retention indexes', () => {
  it('builds child indexes online and attaches every event partition', async () => {
    const result = await ensureRetentionIndexes(pool);
    expect(result.lockAcquired).toBe(true);
    expect(result.ready).toBe(true);

    const state = await pool.query<{
      valid: boolean;
      partitions: number;
      attached: number;
    }>(
      `SELECT parent.indisvalid AS valid,
              (SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'events'::regclass) AS partitions,
              (SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'events_retention_idx'::regclass) AS attached
       FROM pg_index parent
       WHERE parent.indexrelid = 'events_retention_idx'::regclass`,
    );
    expect(state.rows[0]).toEqual(expect.objectContaining({ valid: true }));
    expect(state.rows[0]?.attached).toBe(state.rows[0]?.partitions);

    const families = await pool.query<{ parent: string; valid: boolean; attached: number; partitions: number }>(
      `SELECT parent.relname AS parent, state.indisvalid AS valid,
              (SELECT count(*)::int FROM pg_inherits WHERE inhparent = parent.oid) AS attached,
              (SELECT count(*)::int FROM pg_inherits WHERE inhparent = 'events'::regclass) AS partitions
       FROM pg_class parent
       JOIN pg_index state ON state.indexrelid = parent.oid
       WHERE parent.relname IN (
         'events_retention_idx',
         'events_experience_click_surface_time_idx',
         'events_experience_session_surface_time_idx',
         'events_experience_surface_time_idx',
         'events_visual_experience_lookup_idx'
       )`,
    );
    expect(families.rows).toHaveLength(5);
    for (const family of families.rows) {
      expect(family.valid, family.parent).toBe(true);
      expect(family.attached, family.parent).toBe(family.partitions);
    }
  });
});
