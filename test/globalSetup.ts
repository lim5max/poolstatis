import pg from 'pg';
import { createPool, migrate } from '../src/db.js';
import { ensureRetentionIndexes } from '../src/services/retentionIndexes.js';
import { ADMIN_URL, TEST_DB, TEST_DB_URL } from './urls.js';

export default async function setup(): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    const client = await admin.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended('poolstatis:test-database-create', 0))");
      const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB]);
      if (!rowCount) await client.query(`CREATE DATABASE ${TEST_DB}`);
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended('poolstatis:test-database-create', 0))").catch(() => {});
      client.release();
    }
  } finally {
    await admin.end();
  }

  const pool = createPool(TEST_DB_URL);
  const lockClient = await pool.connect();
  try {
    // Separate Vitest processes share TEST_DB_URL. Hold this session lock for
    // the whole suite so a second global setup cannot drop public mid-test.
    await lockClient.query("SELECT pg_advisory_lock(hashtextextended('poolstatis:test-suite-reset', 0))");
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(pool);
    const indexes = await ensureRetentionIndexes(pool);
    if (!indexes.ready) throw new Error('test operational indexes are not ready');
  } catch (error) {
    await lockClient.query("SELECT pg_advisory_unlock(hashtextextended('poolstatis:test-suite-reset', 0))").catch(() => {});
    lockClient.release();
    await pool.end();
    throw error;
  }

  return async () => {
    try {
      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended('poolstatis:test-suite-reset', 0))");
    } finally {
      lockClient.release();
      await pool.end();
    }
  };
}
