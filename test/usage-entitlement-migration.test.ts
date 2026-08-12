import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPool, discoverMigrationFiles } from '../src/db.js';
import { ADMIN_URL } from './urls.js';

describe('usage entitlement migration upgrade', () => {
  it('backfills existing configuration across multiple organizations', async () => {
    const databaseName = `poolsatis_entitlement_upgrade_${randomUUID().replaceAll('-', '')}`;
    const admin = createPool(ADMIN_URL, { max: 1 });
    let database = undefined as ReturnType<typeof createPool> | undefined;

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const databaseUrl = new URL(ADMIN_URL);
      databaseUrl.pathname = `/${databaseName}`;
      database = createPool(databaseUrl.toString(), { max: 1 });

      const migrations = await discoverMigrationFiles();
      for (const migration of migrations.filter((name) => name < '041_')) {
        await database.query(await readFile(resolve('migrations', migration), 'utf8'));
      }

      const organizations = await database.query<{ id: string }>(
        `INSERT INTO organizations (name)
         VALUES ('Existing organization one'), ('Existing organization two')
         RETURNING id::text`,
      );
      for (const [index, organization] of organizations.rows.entries()) {
        await database.query(
          `INSERT INTO organization_entitlements
            (org_id, meter_key, hard_limit, warning_thresholds)
           VALUES ($1, 'events_stored', $2, $3::bigint[])`,
          [organization.id, 100 + index, [50 + index]],
        );
      }

      await expect(database.query(
        await readFile(resolve('migrations/041_usage_entitlement_control.sql'), 'utf8'),
      )).resolves.toBeDefined();
      expect((await database.query<{
        configured: number;
        revisions: number[];
        audit_rows: number;
      }>(
        `SELECT
           count(*)::int AS configured,
           array_agg(configuration_revision ORDER BY org_id)::int[] AS revisions,
           (SELECT count(*)::int FROM usage_entitlement_revisions) AS audit_rows
         FROM organization_entitlements`,
      )).rows).toEqual([{
        configured: 2,
        revisions: [1, 1],
        audit_rows: 0,
      }]);
      expect((await database.query<{ cleared: boolean }>(
        `SELECT NULLIF(
           current_setting('poolstatis.usage_entitlement_scope', true),
           ''
         ) IS NULL AS cleared`,
      )).rows).toEqual([{ cleared: true }]);

      const client = await database.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE organization_entitlements SET updated_at = now()
           WHERE org_id = $1 AND meter_key = 'events_stored'`,
          [organizations.rows[0]!.id],
        );
        await expect(client.query(
          `UPDATE organization_entitlements SET updated_at = now()
           WHERE org_id = $1 AND meter_key = 'events_stored'`,
          [organizations.rows[1]!.id],
        )).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    } finally {
      await database?.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch(() => undefined);
      await admin.end();
    }
  }, 90_000);
});
