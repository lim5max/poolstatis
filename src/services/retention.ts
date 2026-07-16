import type pg from 'pg';

const RETENTION_LOCK = 'poolstatis:retention:v2';
const QUERIES_PER_PROJECT = 4;

export interface RetentionRunOptions {
  now?: Date;
  /** Optional operational scope; the automatic worker leaves this unset. */
  projectId?: string;
  batchSize: number;
  /** Total DELETE statements allowed in one run, across every project/table. */
  maxBatchesPerRun: number;
  /** Hard row-delete budget across every table in one run. */
  maxRowsPerRun: number;
  /** Wall-clock budget checked between bounded statements. */
  maxRunMs: number;
}

export interface RetentionRunResult {
  lockAcquired: boolean;
  projectsScanned: number;
  batchesAttempted: number;
  eventsDeleted: number;
  ingestBatchesDeleted: number;
  experienceBatchesDeleted: number;
  warningsDeleted: number;
  projectErrors: number;
  hasMore: boolean;
}

export interface RetentionWorkerOptions extends Omit<RetentionRunOptions, 'now'> {
  intervalMs: number;
  continuationDelayMs: number;
  maxConsecutiveContinuations: number;
  onResult?: (result: RetentionRunResult) => void;
  onError?: (error: unknown) => void;
}

export interface RetentionWorker {
  stop(): Promise<void>;
}

interface ProjectRetention {
  id: string;
  retention_months: number;
}

/** Run one bounded, singleton retention sweep against real Postgres rows. */
export async function runRetentionOnce(
  pool: pg.Pool,
  options: RetentionRunOptions,
): Promise<RetentionRunResult> {
  validateOptions(options);
  const now = options.now ?? new Date();
  const startedAt = Date.now();
  const deadline = startedAt + options.maxRunMs;
  const controlReserveMs = Math.max(25, Math.min(1_000, Math.floor(options.maxRunMs / 5)));
  const dataDeadline = Math.max(startedAt + 1, deadline - controlReserveMs);
  const client = await pool.connect();
  let locked = false;
  let failure: unknown;
  try {
    await client.query(`SELECT set_config('statement_timeout', $1, false)`, [`${options.maxRunMs}ms`]);
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
      [RETENTION_LOCK],
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return emptyResult(false);

    const maxProjects = Math.floor(options.maxBatchesPerRun / QUERIES_PER_PROJECT);
    const projects = await withStatementBudget(client, dataDeadline, () => client.query<ProjectRetention>(
      `SELECT id::text, retention_months
         FROM projects
         WHERE ($2::uuid IS NULL OR id = $2)
           AND (retention_retry_at IS NULL OR retention_retry_at <= clock_timestamp())
         ORDER BY retention_checked_at ASC NULLS FIRST, id
         LIMIT $1`,
      [maxProjects + 1, options.projectId ?? null],
    ));
    const selected = projects.rows.slice(0, maxProjects);
    const result = emptyResult(true);
    result.projectsScanned = selected.length;
    result.hasMore = projects.rows.length > maxProjects;

    for (const project of selected) {
      if (Date.now() >= dataDeadline || totalDeleted(result) >= options.maxRowsPerRun) {
        result.hasMore = true;
        break;
      }
      try {
        if (!Number.isInteger(project.retention_months) || project.retention_months < 1) {
          throw new Error(`unsafe retention_months for project ${project.id}`);
        }
        const operations: Array<{
          apply: (limit: number) => Promise<number>;
          record: (count: number) => void;
        }> = [
          {
            apply: (limit) => deletePolicyBatch(client, 'events', project.id, now, limit),
            record: (count) => { result.eventsDeleted += count; },
          },
          {
            apply: (limit) => deleteIngestBatch(client, project.id, now, limit),
            record: (count) => { result.ingestBatchesDeleted += count; },
          },
          {
            apply: (limit) => deletePolicyBatch(client, 'experience_batches', project.id, now, limit),
            record: (count) => { result.experienceBatchesDeleted += count; },
          },
          {
            apply: (limit) => deletePolicyBatch(client, 'ingest_warnings', project.id, now, limit),
            record: (count) => { result.warningsDeleted += count; },
          },
        ];
        let fullPass = true;
        for (const operation of operations) {
          const rowsRemaining = options.maxRowsPerRun - totalDeleted(result);
          if (result.batchesAttempted >= options.maxBatchesPerRun
            || rowsRemaining <= 0
            || Date.now() >= dataDeadline) {
            result.hasMore = true;
            fullPass = false;
            break;
          }
          const limit = Math.min(options.batchSize, rowsRemaining);
          const deleted = await withStatementBudget(client, dataDeadline, () => operation.apply(limit));
          result.batchesAttempted += 1;
          operation.record(deleted);
          if (deleted === limit) result.hasMore = true;
        }
        if (Date.now() >= dataDeadline) {
          result.hasMore = true;
          fullPass = false;
        }
        if (Date.now() < deadline) {
          await withStatementBudget(client, deadline, () => fullPass
            ? markProjectSuccess(client, project.id)
            : markProjectCursor(client, project.id));
        }
      } catch (error) {
        if (!isProjectLocalError(error)) throw error;
        result.projectErrors += 1;
        result.hasMore = true;
        if (Date.now() < deadline) {
          try {
            await withStatementBudget(client, deadline, () => markProjectFailure(client, project.id, error));
          } catch (markError) {
            if (!isProjectLocalError(markError)) throw markError;
          }
        }
      }
    }
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let releaseError: Error | undefined;
    if (locked && Date.now() < deadline) {
      try {
        await client.query(
          `SELECT set_config('statement_timeout', $1, false)`,
          [`${Math.max(1, deadline - Date.now())}ms`],
        );
        const unlocked = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
          [RETENTION_LOCK],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          releaseError = new Error('retention advisory lock could not be released');
        }
        await client.query(`SELECT set_config('statement_timeout', '0', false)`);
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    } else if (locked) {
      releaseError = new Error('retention deadline expired before advisory unlock');
    } else {
      try {
        await client.query(`SELECT set_config('statement_timeout', '0', false)`);
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    client.release(releaseError);
    if (releaseError && failure === undefined) throw releaseError;
  }
}

/**
 * Start a non-overlapping worker. Backlogs continue quickly; an empty sweep
 * waits for the normal interval. The advisory lock keeps it singleton across
 * API instances.
 */
export function startRetentionWorker(pool: pg.Pool, options: RetentionWorkerOptions): RetentionWorker {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('retention intervalMs must be a positive integer');
  }
  if (!Number.isInteger(options.continuationDelayMs) || options.continuationDelayMs <= 0) {
    throw new Error('retention continuationDelayMs must be a positive integer');
  }
  if (!Number.isInteger(options.maxConsecutiveContinuations) || options.maxConsecutiveContinuations <= 0) {
    throw new Error('retention maxConsecutiveContinuations must be a positive integer');
  }
  validateOptions(options);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let consecutiveContinuations = 0;

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    let delay = options.intervalMs;
    try {
      const result = await runRetentionOnce(pool, options);
      if (result.lockAcquired && result.hasMore
        && consecutiveContinuations < options.maxConsecutiveContinuations) {
        consecutiveContinuations += 1;
        delay = options.continuationDelayMs;
      } else {
        consecutiveContinuations = 0;
      }
      try {
        options.onResult?.(result);
      } catch (error) {
        options.onError?.(error);
      }
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = null;
      if (!stopped) {
        timer = setTimeout(() => {
          running = cycle();
        }, delay);
        timer.unref();
      }
    }
  };

  queueMicrotask(() => {
    if (!stopped) running = cycle();
  });

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

async function deletePolicyBatch(
  client: pg.PoolClient,
  table: 'events' | 'experience_batches' | 'ingest_warnings',
  projectId: string,
  now: Date,
  batchSize: number,
): Promise<number> {
  const timestampColumn = table === 'events' ? '"timestamp"' : table === 'experience_batches' ? 'received_at' : 'last_seen';
  const rowIdentity = table === 'events' ? 'tableoid, ctid' : 'ctid';
  const joinIdentity = table === 'events'
    ? 'target.tableoid = doomed.tableoid AND target.ctid = doomed.ctid'
    : 'target.ctid = doomed.ctid';
  // The policy row is locked and re-read inside every DELETE. A concurrent
  // retention increase therefore takes effect before rows are selected.
  const result = await client.query(
    `WITH policy AS MATERIALIZED (
       SELECT id, $2::timestamptz - make_interval(months => retention_months) AS cutoff
       FROM projects
       WHERE id = $1 AND retention_months >= 1
       FOR SHARE
     ), doomed AS MATERIALIZED (
       SELECT ${rowIdentity}
       FROM ${table}
       WHERE project_id = (SELECT id FROM policy)
         AND ${timestampColumn} < (SELECT cutoff FROM policy)
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM ${table} AS target
     USING doomed
     WHERE ${joinIdentity}`,
    [projectId, now, batchSize],
  );
  return result.rowCount ?? 0;
}

async function deleteIngestBatch(
  client: pg.PoolClient,
  projectId: string,
  now: Date,
  batchSize: number,
): Promise<number> {
  const result = await client.query(
    `WITH doomed AS MATERIALIZED (
       SELECT ctid FROM ingest_batches
       WHERE project_id = $1 AND received_at < $2::timestamptz - interval '24 hours'
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM ingest_batches AS target
     USING doomed
     WHERE target.ctid = doomed.ctid`,
    [projectId, now, batchSize],
  );
  return result.rowCount ?? 0;
}

function emptyResult(lockAcquired: boolean): RetentionRunResult {
  return {
    lockAcquired,
    projectsScanned: 0,
    batchesAttempted: 0,
    eventsDeleted: 0,
    ingestBatchesDeleted: 0,
    experienceBatchesDeleted: 0,
    warningsDeleted: 0,
    projectErrors: 0,
    hasMore: false,
  };
}

function validateOptions(options: RetentionRunOptions): void {
  if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
    throw new Error('retention batchSize must be a positive integer');
  }
  if (!Number.isInteger(options.maxBatchesPerRun) || options.maxBatchesPerRun < QUERIES_PER_PROJECT) {
    throw new Error(`retention maxBatchesPerRun must be an integer of at least ${QUERIES_PER_PROJECT}`);
  }
  if (!Number.isInteger(options.maxRowsPerRun) || options.maxRowsPerRun <= 0) {
    throw new Error('retention maxRowsPerRun must be a positive integer');
  }
  if (!Number.isInteger(options.maxRunMs) || options.maxRunMs <= 0) {
    throw new Error('retention maxRunMs must be a positive integer');
  }
}

function totalDeleted(result: RetentionRunResult): number {
  return result.eventsDeleted + result.ingestBatchesDeleted
    + result.experienceBatchesDeleted + result.warningsDeleted;
}

async function markProjectSuccess(client: pg.PoolClient, projectId: string): Promise<void> {
  await client.query(
    `UPDATE projects
     SET retention_checked_at = clock_timestamp(), retention_failed_at = NULL,
         retention_retry_at = NULL, retention_last_error = NULL
     WHERE id = $1`,
    [projectId],
  );
}

async function markProjectCursor(client: pg.PoolClient, projectId: string): Promise<void> {
  await client.query('UPDATE projects SET retention_checked_at = clock_timestamp() WHERE id = $1', [projectId]);
}

async function markProjectFailure(client: pg.PoolClient, projectId: string, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  await client.query(
    `UPDATE projects
     SET retention_checked_at = clock_timestamp(), retention_failed_at = clock_timestamp(),
         retention_retry_at = clock_timestamp() + interval '15 minutes', retention_last_error = $2
     WHERE id = $1`,
    [projectId, message],
  );
}

function isProjectLocalError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '57014' || code === '55P03' || code === '40001' || code === '40P01';
}

async function withStatementBudget<T>(
  client: pg.PoolClient,
  deadline: number,
  action: () => Promise<T>,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    const error = new Error('retention run time budget exhausted') as Error & { code: string };
    error.code = '57014';
    throw error;
  }
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`,
      [`${remainingMs}ms`, `${Math.min(remainingMs, 1_000)}ms`],
    );
    const result = await action();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
