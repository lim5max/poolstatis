import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface PoolOptions {
  max?: number;
  applicationName?: string;
}

export function createPool(databaseUrl: string, options: PoolOptions = {}): pg.Pool {
  // Timezone is pinned to UTC so date_trunc buckets are stable regardless of
  // where the server or the database happens to run.
  return new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    options: '-c timezone=UTC',
    ...(options.applicationName ? { application_name: options.applicationName } : {}),
  });
}

/** Apply pending .sql migrations in lexicographic order, tracked in schema_migrations. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  let locked = false;
  let failure: unknown;
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('poolstatis:schema-migrations', 0))");
    locked = true;
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query('BEGIN');
      try {
        const { rowCount } = await client.query(
          'SELECT 1 FROM schema_migrations WHERE name = $1',
          [file],
        );
        if (!rowCount) {
          const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          applied.push(file);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return applied;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let releaseError: Error | undefined;
    if (locked) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended('poolstatis:schema-migrations', 0)) AS unlocked",
        );
        if (unlocked.rows[0]?.unlocked !== true) releaseError = new Error('migration lock could not be released');
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    client.release(releaseError);
    if (releaseError && failure === undefined) throw releaseError;
  }
}
