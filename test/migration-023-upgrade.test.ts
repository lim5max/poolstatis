import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { TEST_DB_URL } from './urls.js';
import { applyMigration023Cleanup, inspectMigration023 } from '../src/services/migration023Preflight.js';

async function waitUntil(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

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
      await client.query(`INSERT INTO api_keys
        SELECT gen_random_uuid(), '00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'secret', '00000000-0000-0000-0000-000000000011'
        FROM generate_series(1, 105)`);
      const report = await inspectMigration023(client);
      expect(report.non_personal_owner_count).toBe(107);
      expect(report.non_personal_owner_sample_ids).toHaveLength(100);
      expect((await inspectMigration023(client)).digest).toBe(report.digest);
      await client.query('COMMIT');
      await expect(applyMigration023Cleanup(pool, { acknowledgement: report.digest, backupAttestation: '', searchPath: schema })).rejects.toThrow('safe 8-120');
      await expect(applyMigration023Cleanup(pool, { acknowledgement: 'stale', backupAttestation: 'operator-confirmed', searchPath: schema })).rejects.toThrow('stale or incorrect');
      await applyMigration023Cleanup(pool, { acknowledgement: report.digest, backupAttestation: 'operator-confirmed', searchPath: schema });
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${schema}, public`);
      await client.query(`CREATE TABLE schema_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const migration = await readFile(resolve('migrations/023_personal_token_owner_membership.sql'), 'utf8');
      await client.query(migration);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ('023_personal_token_owner_membership.sql')`);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  });

  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await pool.end(); });

  it('keeps same-org personal ownership and cleans legacy non-personal/stale owner fields before constraints', async () => {
    const rows = await pool.query(`SELECT id::text, issued_by_user_id::text FROM ${schema}.api_keys
      WHERE id IN ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000103') ORDER BY id`);
    expect(rows.rows).toEqual([
      { id: '00000000-0000-0000-0000-000000000101', issued_by_user_id: '00000000-0000-0000-0000-000000000011' },
      { id: '00000000-0000-0000-0000-000000000102', issued_by_user_id: null },
      { id: '00000000-0000-0000-0000-000000000103', issued_by_user_id: null },
    ]);
    const recorded = await pool.query(
      `SELECT name FROM ${schema}.schema_migrations WHERE name = '023_personal_token_owner_membership.sql'`,
    );
    expect(recorded.rows).toEqual([{ name: '023_personal_token_owner_membership.sql' }]);
  });

  it('blocks late stale-token writers until the acknowledged cleanup installs constraints', async () => {
    const raceSchema = `m023_race_${Date.now()}`;
    const pauseLockKey = 2_023_000_000 + Math.floor(Math.random() * 100_000);
    const setup = await pool.connect();
    const blocker = await pool.connect();
    const writer = await pool.connect();
    let cleanup: Promise<Awaited<ReturnType<typeof applyMigration023Cleanup>>> | undefined;
    let lateInsert: Promise<unknown> | undefined;
    try {
      await setup.query(`CREATE SCHEMA ${raceSchema}`);
      await setup.query(`SET search_path TO ${raceSchema}, public`);
      await setup.query(`CREATE TABLE organization_members (
        org_id uuid NOT NULL, user_id uuid NOT NULL, PRIMARY KEY (org_id, user_id)
      )`);
      await setup.query(`CREATE TABLE api_keys (
        id uuid PRIMARY KEY, org_id uuid NOT NULL, project_id uuid, kind text NOT NULL,
        issued_by_user_id uuid
      )`);
      await setup.query(`INSERT INTO organization_members VALUES
        ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000011')`);
      await setup.query(`INSERT INTO api_keys VALUES
        ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000001',
         '00000000-0000-0000-0000-000000000201', 'secret', '00000000-0000-0000-0000-000000000011')`);
      await setup.query(`CREATE FUNCTION pause_m023_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(${pauseLockKey});
          RETURN NEW;
        END
      $$`);
      await setup.query(`CREATE TRIGGER pause_m023_cleanup
        BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION pause_m023_cleanup()`);

      const acknowledged = await inspectMigration023(setup);
      await blocker.query('SELECT pg_advisory_lock($1)', [pauseLockKey]);
      cleanup = applyMigration023Cleanup(pool, {
        acknowledgement: acknowledged.digest,
        backupAttestation: 'operator-confirmed',
        searchPath: raceSchema,
      });
      await waitUntil(async () => {
        const waiting = await setup.query<{ waiting: boolean }>(
          `SELECT EXISTS (
            SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND classid = 0 AND objid = $1 AND NOT granted
          ) AS waiting`,
          [pauseLockKey],
        );
        return waiting.rows[0]?.waiting === true;
      }, 'cleanup did not reach the post-acknowledgement update barrier');

      await writer.query(`SET search_path TO ${raceSchema}, public`);
      const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      lateInsert = writer.query(`INSERT INTO api_keys VALUES
        ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000001',
         NULL, 'personal', '00000000-0000-0000-0000-000000000099')`);
      const writerState = await Promise.race([
        lateInsert.then(() => 'settled', () => 'settled'),
        waitUntil(async () => {
          const activity = await setup.query<{ waiting: boolean }>(
            `SELECT COALESCE(wait_event_type = 'Lock', false) AS waiting
             FROM pg_stat_activity WHERE pid = $1`,
            [writerPid],
          );
          return activity.rows[0]?.waiting === true;
        }, 'late writer neither settled nor waited on the cutover lock').then(() => 'blocked'),
      ]);
      expect(writerState).toBe('blocked');

      await blocker.query('SELECT pg_advisory_unlock($1)', [pauseLockKey]);
      const receipt = await cleanup;
      expect(receipt.digest).toBe(acknowledged.digest);
      await expect(lateInsert).rejects.toThrow(/api_keys_personal_owner_membership_fk/);

      const constraints = await setup.query<{ name: string }>(
        `SELECT conname AS name FROM pg_constraint
         WHERE conrelid = '${raceSchema}.api_keys'::regclass ORDER BY conname`,
      );
      expect(constraints.rows.map((row) => row.name)).toEqual([
        'api_keys_issued_owner_personal_check',
        'api_keys_personal_owner_membership_fk',
        'api_keys_pkey',
      ]);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock($1)', [pauseLockKey]).catch(() => {});
      await Promise.allSettled([cleanup, lateInsert].filter((value): value is Promise<unknown> => value !== undefined));
      setup.release();
      blocker.release();
      writer.release();
      await pool.query(`DROP SCHEMA IF EXISTS ${raceSchema} CASCADE`);
    }
  });
});
