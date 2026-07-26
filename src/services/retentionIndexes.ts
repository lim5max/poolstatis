import type pg from 'pg';

const INDEX_LOCK = 'poolstatis:operational-indexes:v2';

interface PartitionIndexSpec {
  parent: string;
  childPrefix: string;
  definition: string;
}

const PARTITION_INDEXES: PartitionIndexSpec[] = [
  {
    parent: 'events_retention_idx',
    childPrefix: 'ev_ret',
    definition: '(project_id, "timestamp")',
  },
  {
    parent: 'events_experience_click_surface_time_idx',
    childPrefix: 'ev_exp_click',
    definition: `(project_id, env, (properties->>'surface'), "timestamp" DESC)
      WHERE event_source = 'experience' AND event = 'experience.element_clicked'`,
  },
  {
    parent: 'events_experience_session_surface_time_idx',
    childPrefix: 'ev_exp_session',
    definition: `(project_id, env, session_id, (properties->>'surface'), "timestamp")
      WHERE event_source = 'experience'`,
  },
  {
    parent: 'events_visual_experience_lookup_idx',
    childPrefix: 'ev_visual_exp',
    definition: `(project_id, env, (properties->>'surface'), (properties->>'route'),
      (properties->>'version'), (properties->>'device'), "timestamp" DESC)
      WHERE event_source = 'experience'`,
  },
];

export interface RetentionIndexResult {
  lockAcquired: boolean;
  ready: boolean;
  partitionsIndexed: number;
  metadataIndexed: boolean;
}

/** Build large indexes online. Safe to run as a background/predeploy job. */
export async function ensureRetentionIndexes(pool: pg.Pool): Promise<RetentionIndexResult> {
  const client = await pool.connect();
  let locked = false;
  let failure: unknown;
  try {
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [INDEX_LOCK],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) {
      return {
        lockAcquired: false,
        ready: await retentionIndexesReady(client),
        partitionsIndexed: 0,
        metadataIndexed: false,
      };
    }

    const partitions = await client.query<{ oid: number; schema_name: string; table_name: string }>(
      `SELECT child.oid::int, namespace.nspname AS schema_name, child.relname AS table_name
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = inhparent
       JOIN pg_class child ON child.oid = inhrelid
       JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
       WHERE parent.oid = 'events'::regclass
       ORDER BY child.oid`,
    );
    let partitionsIndexed = 0;
    for (const spec of PARTITION_INDEXES) {
      await client.query(
        `CREATE INDEX IF NOT EXISTS ${identifier(spec.parent)} ON ONLY events ${spec.definition}`,
      );
      for (const partition of partitions.rows) {
        const attached = await client.query(
          `SELECT 1
           FROM pg_inherits
           JOIN pg_index child_index ON child_index.indexrelid = inhrelid
           WHERE inhparent = $1::regclass AND child_index.indrelid = $2`,
          [spec.parent, partition.oid],
        );
        if (attached.rowCount) continue;
        const childName = `${spec.childPrefix}_${partition.oid}_idx`;
        await ensureChildIndex(client, partition, childName, spec.definition);
        await client.query(
          `ALTER INDEX ${identifier(spec.parent)} ATTACH PARTITION ${qualified(partition.schema_name, childName)}`,
        );
        partitionsIndexed += 1;
      }
    }

    const metadataBefore = await indexValidity(client, 'experience_batches_cleanup_idx');
    if (metadataBefore === false) {
      await client.query('DROP INDEX CONCURRENTLY experience_batches_cleanup_idx');
    }
    if (metadataBefore !== true) {
      await client.query(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS experience_batches_cleanup_idx ON experience_batches (project_id, received_at)',
      );
    }
    return {
      lockAcquired: true,
      ready: await retentionIndexesReady(client),
      partitionsIndexed,
      metadataIndexed: metadataBefore !== true,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let releaseError: Error | undefined;
    if (locked) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
          [INDEX_LOCK],
        );
        if (unlocked.rows[0]?.unlocked !== true) releaseError = new Error('operational index lock could not be released');
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    client.release(releaseError);
    if (releaseError && failure === undefined) throw releaseError;
  }
}

export async function retentionIndexesReady(client: pg.Pool | pg.PoolClient): Promise<boolean> {
  const partitions = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_inherits WHERE inhparent = 'events'::regclass`,
  );
  const partitionCount = partitions.rows[0]?.count ?? 0;
  for (const spec of PARTITION_INDEXES) {
    const state = await client.query<{ valid: boolean; attached: number }>(
      `SELECT index_state.indisvalid AS valid,
              (SELECT count(*)::int FROM pg_inherits WHERE inhparent = index_state.indexrelid) AS attached
       FROM pg_index index_state
       WHERE index_state.indexrelid = to_regclass($1)`,
      [spec.parent],
    );
    if (state.rows[0]?.valid !== true || state.rows[0]?.attached !== partitionCount) return false;
  }
  return (await indexValidity(client, 'experience_batches_cleanup_idx')) === true;
}

async function ensureChildIndex(
  client: pg.PoolClient,
  partition: { oid: number; schema_name: string; table_name: string },
  indexName: string,
  definition: string,
): Promise<void> {
  const existing = await client.query<{ valid: boolean }>(
    `SELECT index_state.indisvalid AS valid
     FROM pg_class index_class
     JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
     JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
     WHERE namespace.nspname = $1 AND index_class.relname = $2`,
    [partition.schema_name, indexName],
  );
  const index = qualified(partition.schema_name, indexName);
  if (existing.rows[0]?.valid === false) await client.query(`DROP INDEX CONCURRENTLY ${index}`);
  if (existing.rows[0]?.valid !== true) {
    await client.query(
      `CREATE INDEX CONCURRENTLY ${identifier(indexName)} ON ${qualified(partition.schema_name, partition.table_name)} ${definition}`,
    );
  }
}

async function indexValidity(client: pg.Pool | pg.PoolClient, name: string): Promise<boolean | null> {
  const result = await client.query<{ valid: boolean }>(
    `SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [name],
  );
  return result.rows[0]?.valid ?? null;
}

function qualified(schema: string, value: string): string {
  return `${identifier(schema)}.${identifier(value)}`;
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
