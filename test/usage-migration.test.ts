import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { TEST_DB_URL } from './urls.js';

const migration024Url = new URL('../migrations/024_usage_ledger_entitlements.sql', import.meta.url);
const migration025Url = new URL('../migrations/025_usage_concurrency_invariants.sql', import.meta.url);
const migration026Url = new URL('../migrations/026_usage_config_lock_upgrade_validation.sql', import.meta.url);

async function withPre025Schema(
  run: (client: pg.PoolClient, migrations: { m024: string; m025: string; m026: string }) => Promise<void>,
): Promise<void> {
  const pool = createPool(TEST_DB_URL);
  const client = await pool.connect();
  const schema = `usage_upgrade_${Date.now()}`;
  const [m024, m025, m026] = await Promise.all([
    readFile(fileURLToPath(migration024Url), 'utf8'),
    readFile(fileURLToPath(migration025Url), 'utf8'),
    readFile(fileURLToPath(migration026Url), 'utf8'),
  ]);
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE projects (
        id uuid PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES organizations(id),
        slug text NOT NULL,
        name text NOT NULL,
        UNIQUE (org_id, id)
      );
    `);
    await client.query(m024);
    await run(client, { m024, m025, m026 });
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

describe('usage entitlement migration compatibility', () => {
  it('samples the UTC month only after acquiring the stable config lock', async () => {
    const source = await readFile(fileURLToPath(migration026Url), 'utf8');
    const lock = source.indexOf('PERFORM pg_advisory_xact_lock(poolstatis_usage_config_lock_key(scope_org, scope_meter));');
    const period = source.indexOf("period := date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date;");
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(period).toBeGreaterThan(lock);
  });

  it('fails safely when a pre-025 entitlement has invalid warning thresholds', async () => {
    await withPre025Schema(async (pool, { m025, m026 }) => {
      const orgId = '11111111-1111-4111-8111-111111111111';
      await pool.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Invalid upgrade org')`, [orgId]);
      await pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, warning_thresholds)
         VALUES ($1, 'events_stored', ARRAY[2, 1]::bigint[])`,
        [orgId],
      );
      await pool.query(m025);
      await expect(pool.query(m026)).rejects.toThrow('invalid existing warning_thresholds');
    });
  });

  it('fails safely when a pre-025 hard limit is below current-month usage', async () => {
    await withPre025Schema(async (pool, { m025, m026 }) => {
      const orgId = '33333333-3333-4333-8333-333333333333';
      await pool.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Invalid cap upgrade org')`, [orgId]);
      await pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit)
         VALUES ($1, 'events_stored', 0)`,
        [orgId],
      );
      await pool.query(
        `INSERT INTO organization_usage (org_id, meter_key, period_start, quantity)
         VALUES ($1, 'events_stored', date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date, 1)`,
        [orgId],
      );
      await pool.query(m025);
      await expect(pool.query(m026)).rejects.toThrow('existing hard_limit is below current UTC-month usage');
    });
  });

  it('upgrades valid pre-025 entitlement rows and enforces the invariant afterward', async () => {
    await withPre025Schema(async (pool, { m025, m026 }) => {
      const orgId = '22222222-2222-4222-8222-222222222222';
      await pool.query(`INSERT INTO organizations (id, name) VALUES ($1, 'Valid upgrade org')`, [orgId]);
      await pool.query(
        `INSERT INTO organization_entitlements (org_id, meter_key, hard_limit, warning_thresholds)
         VALUES ($1, 'events_stored', 5, ARRAY[1, 2]::bigint[])`,
        [orgId],
      );
      await pool.query(m025);
      await pool.query(m026);
      await expect(pool.query(
        `UPDATE organization_entitlements SET warning_thresholds = ARRAY[2, 1]::bigint[]
         WHERE org_id = $1 AND meter_key = 'events_stored'`,
        [orgId],
      )).rejects.toThrow();
    });
  });
});
