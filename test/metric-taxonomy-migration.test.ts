import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { TEST_DB_URL } from './urls.js';

describe('migration 031 metric taxonomy upgrade', () => {
  const schema = `m031_${Date.now()}`;
  const pool = createPool(TEST_DB_URL);

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE projects (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          name text NOT NULL
        );
        CREATE TABLE metrics (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id uuid NOT NULL REFERENCES projects(id),
          key text NOT NULL,
          category text CHECK (category IN
            ('acquisition','activation','retention','revenue','referral','quality')),
          UNIQUE (project_id, key)
        );
        INSERT INTO projects (id, name)
        VALUES ('00000000-0000-0000-0000-000000000101', 'Existing project');
        INSERT INTO metrics (project_id, key, category)
        VALUES
          ('00000000-0000-0000-0000-000000000101', 'existing_quality', 'quality'),
          ('00000000-0000-0000-0000-000000000101', 'existing_uncategorized', NULL);
      `);
      const migration = await readFile(resolve('migrations/031_metric_taxonomy.sql'), 'utf8');
      await client.query(migration);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it('backfills the exact system library for existing projects and keeps legacy values valid', async () => {
    const categories = await pool.query<{ key: string; is_system: boolean }>(
      `SELECT key, is_system FROM ${schema}.metric_categories
       WHERE project_id = '00000000-0000-0000-0000-000000000101'
       ORDER BY key`,
    );
    expect(categories.rows).toHaveLength(16);
    expect(categories.rows).toContainEqual({ key: 'quality', is_system: true });
    expect(categories.rows).toContainEqual({ key: 'data_quality', is_system: true });

    const metrics = await pool.query<{ key: string; category: string | null }>(
      `SELECT key, category FROM ${schema}.metrics ORDER BY key`,
    );
    expect(metrics.rows).toEqual([
      { key: 'existing_quality', category: 'quality' },
      { key: 'existing_uncategorized', category: null },
    ]);

    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(
        `SELECT poolstatis_seed_system_metric_categories(
          '00000000-0000-0000-0000-000000000101'
        )`,
      );
      await client.query(
        `SELECT poolstatis_seed_system_metric_categories(
          '00000000-0000-0000-0000-000000000101'
        )`,
      );
      const seeded = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM metric_categories
         WHERE project_id = '00000000-0000-0000-0000-000000000101'`,
      );
      expect(seeded.rows[0]?.count).toBe(16);
    } finally {
      client.release();
    }
  });

  it('seeds new projects and enforces project-scoped metric references in the database', async () => {
    const projectId = '00000000-0000-0000-0000-000000000202';
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`INSERT INTO projects (id, name) VALUES ($1, 'New project')`, [projectId]);
      const count = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM metric_categories WHERE project_id = $1',
        [projectId],
      );
      expect(count.rows[0]?.count).toBe(16);

      await expect(client.query(
        `INSERT INTO metrics (project_id, key, category) VALUES ($1, 'unknown_metric', 'governance')`,
        [projectId],
      )).rejects.toMatchObject({ code: '23503' });
    } finally {
      client.release();
    }
  });

  it('enforces immutable system semantics below the API layer', async () => {
    await expect(pool.query(
      `UPDATE ${schema}.metric_categories SET description = 'Changed semantics'
       WHERE project_id = '00000000-0000-0000-0000-000000000101' AND key = 'quality'`,
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool.query(
      `DELETE FROM ${schema}.metric_categories
       WHERE project_id = '00000000-0000-0000-0000-000000000101' AND key = 'quality'`,
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('allows system categories to follow an intentional project cascade', async () => {
    const projectId = '00000000-0000-0000-0000-000000000303';
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`INSERT INTO projects (id, name) VALUES ($1, 'Deleted project')`, [projectId]);
      await expect(client.query('DELETE FROM projects WHERE id = $1', [projectId])).resolves.toMatchObject({
        rowCount: 1,
      });
      const categories = await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM metric_categories WHERE project_id = $1',
        [projectId],
      );
      expect(categories.rows[0]?.count).toBe(0);
    } finally {
      client.release();
    }
  });
});
