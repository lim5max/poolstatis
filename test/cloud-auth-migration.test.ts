import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { TEST_DB_URL } from './urls.js';

describe('cloud identity migration compatibility', () => {
  it('keeps the legacy subject uniqueness constraint during the expand rollout', async () => {
    const pool = createPool(TEST_DB_URL);
    try {
      const nullable = await pool.query(
        `SELECT is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'auth_users' AND column_name = 'identity_issuer'`,
      );
      const subjectIndex = await pool.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'auth_users'
           AND indexdef LIKE 'CREATE UNIQUE INDEX% (subject)'`,
      );

      expect(nullable.rows).toEqual([{ is_nullable: 'YES' }]);
      expect(subjectIndex.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
