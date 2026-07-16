import pg from 'pg';
import { createPool, migrate } from '../src/db.js';
import { ensureRetentionIndexes } from '../src/services/retentionIndexes.js';
import { ADMIN_URL, TEST_DB, TEST_DB_URL } from './urls.js';

export default async function setup(): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  const pool = createPool(TEST_DB_URL);
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    const indexes = await ensureRetentionIndexes(pool);
    if (!indexes.ready) throw new Error('test operational indexes are not ready');
  } finally {
    await pool.end();
  }
}
