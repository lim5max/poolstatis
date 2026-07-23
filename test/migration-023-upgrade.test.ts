import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { TEST_DB_URL } from './urls.js';

describe('migration 023 populated legacy upgrade', () => {
  const schema = `m023_${Date.now()}`;
  const pool = createPool(TEST_DB_URL);

  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${schema}, public`);
      await client.query(`CREATE TABLE organization_members (org_id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY (org_id, user_id))`);
      await client.query(`CREATE TABLE api_keys (
      id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid, kind text NOT NULL,
      issued_by_user_id uuid
    )`);
      await client.query(`INSERT INTO organization_members VALUES
      ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011')`);
      await client.query(`INSERT INTO api_keys VALUES
      ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000001', NULL, 'personal', '00000000-0000-0000-0000-000000000011'),
      ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000201', 'secret', '00000000-0000-0000-0000-000000000011'),
      ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000202', 'ingest', '00000000-0000-0000-0000-000000000099')`);
      const migration = await readFile(resolve('migrations/023_personal_token_owner_membership.sql'), 'utf8');
      await client.query(migration);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  });

  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); });

  it('keeps same-org personal ownership and cleans legacy non-personal/stale owner fields before constraints', async () => {
    const rows = await pool.query(`SELECT id::text, issued_by_user_id::text FROM ${schema}.api_keys ORDER BY id`);
    expect(rows.rows).toEqual([
      { id: '00000000-0000-0000-0000-000000000101', issued_by_user_id: '00000000-0000-0000-0000-000000000011' },
      { id: '00000000-0000-0000-0000-000000000102', issued_by_user_id: null },
      { id: '00000000-0000-0000-0000-000000000103', issued_by_user_id: null },
    ]);
  });
});
