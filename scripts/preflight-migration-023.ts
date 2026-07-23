import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { createPool } from '../src/db.js';

export interface Migration023Report {
  non_personal_owner_count: number;
  stale_personal_count: number;
  non_personal_owner_sample_ids: string[];
  stale_personal_sample_ids: string[];
  digest: string;
}

export async function inspectMigration023(client: pg.Pool | pg.PoolClient): Promise<Migration023Report> {
  const rows = await client.query<Migration023Report>(`WITH affected AS (
    SELECT id::text, 'non_personal_owner' AS category FROM api_keys
    WHERE kind <> 'personal' AND issued_by_user_id IS NOT NULL
    UNION ALL
    SELECT k.id::text, 'stale_personal' AS category FROM api_keys k
    WHERE k.kind = 'personal' AND k.issued_by_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM organization_members om WHERE om.org_id = k.org_id AND om.user_id = k.issued_by_user_id)
  ), samples AS (
    SELECT category, array_agg(id ORDER BY id) AS ids FROM (
      SELECT category, id, row_number() OVER (PARTITION BY category ORDER BY id) AS rn FROM affected
    ) ranked WHERE rn <= 100 GROUP BY category
  ) SELECT
    count(*) FILTER (WHERE category = 'non_personal_owner')::int AS non_personal_owner_count,
    count(*) FILTER (WHERE category = 'stale_personal')::int AS stale_personal_count,
    COALESCE((SELECT ids FROM samples WHERE category = 'non_personal_owner'), ARRAY[]::text[]) AS non_personal_owner_sample_ids,
    COALESCE((SELECT ids FROM samples WHERE category = 'stale_personal'), ARRAY[]::text[]) AS stale_personal_sample_ids,
    encode(digest(COALESCE(string_agg(category || ':' || id, ',' ORDER BY category, id), ''), 'sha256'), 'hex') AS digest
  FROM affected`);
  return rows.rows[0]!;
}

export async function applyMigration023Cleanup(
  pool: pg.Pool,
  input: { acknowledgement: string; backupAttestation: string; searchPath?: string },
): Promise<Migration023Report> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,119}$/.test(input.backupAttestation)) {
    throw new Error('operator backup attestation must be a safe 8-120 character reference');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (input.searchPath) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.searchPath)) throw new Error('invalid search path');
      await client.query(`SET LOCAL search_path TO ${input.searchPath}, public`);
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('poolstatis:migration-023-preflight', 0))");
    const report = await inspectMigration023(client);
    if (input.acknowledgement !== report.digest) throw new Error('preflight acknowledgement is stale or incorrect');
    await client.query("UPDATE api_keys SET issued_by_user_id = NULL WHERE kind <> 'personal' AND issued_by_user_id IS NOT NULL");
    await client.query(`DELETE FROM api_keys k WHERE k.kind = 'personal' AND k.issued_by_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM organization_members om WHERE om.org_id = k.org_id AND om.user_id = k.issued_by_user_id)`);
    const post = await inspectMigration023(client);
    if (post.non_personal_owner_count || post.stale_personal_count) throw new Error('migration 023 cleanup post-check failed');
    await client.query('COMMIT');
    return report;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function main(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL ?? 'postgres://poolsatis:poolsatis@localhost:5444/poolsatis');
  try {
    const report = await inspectMigration023(pool);
    if (process.argv.includes('--apply')) {
      const ack = argument('--ack'); const backup = argument('--backup');
      if (!ack || !backup) throw new Error('--apply requires --ack <digest> and --backup <reference>');
      await applyMigration023Cleanup(pool, { acknowledgement: ack, backupAttestation: backup });
      console.log(JSON.stringify({ protocol: 'migration-023/v1', status: 'cleaned', backup_attestation: backup, ...report }));
    } else console.log(JSON.stringify({ status: 'report_only', ...report }));
  } finally { await pool.end(); }
}
function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { console.error(error instanceof Error ? error.message : 'preflight failed'); process.exitCode = 1; });
