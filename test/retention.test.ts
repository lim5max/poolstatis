import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRetentionOnce, startRetentionWorker } from '../src/services/retention.js';
import { createTestEnv, type TestEnv } from './helpers.js';

let short: TestEnv;
let long: TestEnv;

beforeAll(async () => {
  short = await createTestEnv();
  long = await createTestEnv();
});

afterAll(async () => {
  await long.close();
  await short.close();
});

describe('retention maintenance', () => {
  it('runs automatically on worker start and stops cleanly', async () => {
    const project = await projectId(short);
    await short.pool.query('UPDATE projects SET retention_months = 1 WHERE id = $1', [project]);
    await insertEvent(short, project, 'worker.old', '2025-01-01T00:00:00.000Z');

    let resolveRun!: (result: Awaited<ReturnType<typeof runRetentionOnce>>) => void;
    const firstRun = new Promise<Awaited<ReturnType<typeof runRetentionOnce>>>((resolve) => {
      resolveRun = resolve;
    });
    const worker = startRetentionWorker(short.pool, {
      intervalMs: 60_000,
      continuationDelayMs: 5,
      maxConsecutiveContinuations: 2,
      projectId: project,
      batchSize: 10,
      maxBatchesPerRun: 40,
      maxRowsPerRun: 100,
      maxRunMs: 5_000,
      onResult: resolveRun,
    });
    const result = await firstRun;
    await worker.stop();

    expect(result.lockAcquired).toBe(true);
    const stored = await short.pool.query(
      `SELECT count(*)::int AS count FROM events WHERE project_id = $1 AND event = 'worker.old'`,
      [project],
    );
    expect(stored.rows[0].count).toBe(0);
  });

  it('deletes only data older than each project retention and bounds every sweep', async () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    const shortProject = await projectId(short);
    const longProject = await projectId(long);
    await short.pool.query('UPDATE projects SET retention_months = 1 WHERE id = $1', [shortProject]);
    await short.pool.query('UPDATE projects SET retention_months = 12 WHERE id = $1', [longProject]);

    await insertEvent(short, shortProject, 'old.short', '2026-05-01T00:00:00.000Z');
    await insertEvent(short, shortProject, 'old.short.second', '2026-05-02T00:00:00.000Z');
    await insertEvent(short, shortProject, 'recent.short', '2026-07-01T00:00:00.000Z');
    await insertEvent(short, longProject, 'still.retained', '2026-05-01T00:00:00.000Z');

    const first = await runRetentionOnce(short.pool, {
      now,
      projectId: shortProject,
      batchSize: 1,
      maxBatchesPerRun: 4,
      maxRowsPerRun: 100,
      maxRunMs: 5_000,
    });
    expect(first).toEqual(expect.objectContaining({
      lockAcquired: true,
      eventsDeleted: 1,
      hasMore: true,
    }));

    const afterFirst = await storedEvents(short, [shortProject, longProject]);
    expect(afterFirst.filter((row) => row.project_id === shortProject)).toHaveLength(2);
    expect(afterFirst.find((row) => row.event === 'recent.short')).toBeTruthy();
    expect(afterFirst.find((row) => row.event === 'still.retained')).toBeTruthy();

    const second = await runRetentionOnce(short.pool, {
      now,
      projectId: shortProject,
      batchSize: 10,
      maxBatchesPerRun: 40,
      maxRowsPerRun: 100,
      maxRunMs: 5_000,
    });
    expect(second.eventsDeleted).toBe(1);
    expect(second.hasMore).toBe(false);
    const longPolicy = await runRetentionOnce(short.pool, {
      now,
      projectId: longProject,
      batchSize: 10,
      maxBatchesPerRun: 4,
      maxRowsPerRun: 100,
      maxRunMs: 5_000,
    });
    expect(longPolicy.eventsDeleted).toBe(0);
    expect((await storedEvents(short, [shortProject, longProject])).map((row) => row.event).sort())
      .toEqual(['recent.short', 'still.retained']);
  });

  it('cleans stale idempotency rows and warnings without deleting recent metadata', async () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    const project = await projectId(short);
    await short.pool.query('UPDATE projects SET retention_months = 1 WHERE id = $1', [project]);

    await short.pool.query(
      `INSERT INTO ingest_batches (project_id, env, batch_id, status, received_at)
       VALUES ($1, 'prod', 'stale-ingest', 'completed', $2),
              ($1, 'prod', 'recent-ingest', 'completed', $3)`,
      [project, '2026-05-01T00:00:00.000Z', '2026-07-16T11:30:00.000Z'],
    );
    await short.pool.query(
      `INSERT INTO experience_batches (project_id, env, batch_id, status, received_at)
       VALUES ($1, 'prod', 'expired-experience', 'completed', $2),
              ($1, 'prod', 'retryable-experience', 'completed', $3),
              ($1, 'prod', 'recent-experience', 'completed', $4)`,
      [project, '2026-05-01T00:00:00.000Z', '2026-07-14T00:00:00.000Z', '2026-07-16T11:30:00.000Z'],
    );
    await short.pool.query(
      `INSERT INTO ingest_warnings (project_id, env, kind, event, detail, last_seen)
       VALUES ($1, 'prod', 'unregistered', 'stale.warning', 'old', $2),
              ($1, 'prod', 'unregistered', 'recent.warning', 'new', $3)`,
      [project, '2026-05-01T00:00:00.000Z', '2026-07-16T11:30:00.000Z'],
    );

    const result = await runRetentionOnce(short.pool, {
      now,
      projectId: project,
      batchSize: 10,
      maxBatchesPerRun: 40,
      maxRowsPerRun: 100,
      maxRunMs: 5_000,
    });
    expect(result).toEqual(expect.objectContaining({
      ingestBatchesDeleted: 1,
      experienceBatchesDeleted: 1,
      warningsDeleted: 1,
    }));

    const ingest = await short.pool.query('SELECT batch_id FROM ingest_batches WHERE project_id = $1', [project]);
    const experience = await short.pool.query('SELECT batch_id FROM experience_batches WHERE project_id = $1', [project]);
    const warnings = await short.pool.query('SELECT event FROM ingest_warnings WHERE project_id = $1', [project]);
    expect(ingest.rows.map((row) => row.batch_id)).toContain('recent-ingest');
    expect(ingest.rows.map((row) => row.batch_id)).not.toContain('stale-ingest');
    expect(experience.rows.map((row) => row.batch_id).sort()).toEqual([
      'recent-experience',
      'retryable-experience',
    ]);
    expect(warnings.rows.map((row) => row.event)).toContain('recent.warning');
    expect(warnings.rows.map((row) => row.event)).not.toContain('stale.warning');
  });

  it('expires correction snapshots together with their event', async () => {
    const now = new Date('2026-07-16T12:00:00.000Z');
    const project = await projectId(short);
    await short.pool.query('UPDATE projects SET retention_months = 1 WHERE id = $1', [project]);
    const event = await short.pool.query<{ id: string }>(
      `INSERT INTO events (
         project_id, env, event, "timestamp", distinct_id, properties, registered, revision
       ) VALUES ($1, 'prod', 'revised.expired', '2026-05-01T00:00:00.000Z',
                 'expired-actor', '{"stage":"after"}', true, 2)
       RETURNING id`,
      [project],
    );
    const eventId = event.rows[0]!.id;
    await short.pool.query(
      `INSERT INTO event_revisions (
         event_id, project_id, env, revision, actor, reason,
         previous_snapshot, snapshot
       ) VALUES (
         $1, $2, 'prod', 2, 'test:retention',
         'Retention must remove personal correction evidence.',
         $3::jsonb, $4::jsonb
       )`,
      [
        eventId,
        project,
        JSON.stringify({ id: eventId, distinct_id: 'expired-actor', properties: { stage: 'before' } }),
        JSON.stringify({ id: eventId, distinct_id: 'expired-actor', properties: { stage: 'after' } }),
      ],
    );

    const result = await runRetentionOnce(short.pool, {
      now,
      projectId: project,
      batchSize: 10,
      maxBatchesPerRun: 40,
      maxRowsPerRun: 100,
      maxRunMs: 5_000,
    });
    expect(result.eventsDeleted).toBeGreaterThanOrEqual(1);
    const remaining = await short.pool.query<{ events: number; revisions: number }>(
      `SELECT
         (SELECT count(*)::int FROM events WHERE id = $1) AS events,
         (SELECT count(*)::int FROM event_revisions WHERE event_id = $1) AS revisions`,
      [eventId],
    );
    expect(remaining.rows[0]).toEqual({ events: 0, revisions: 0 });
  });

  it('rejects retention policies that could delete fresh data', async () => {
    const project = await projectId(short);
    await expect(short.pool.query(
      'UPDATE projects SET retention_months = 0 WHERE id = $1',
      [project],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('bounds all maintenance work and continues a backlog before the normal interval', async () => {
    const project = await projectId(short);
    await short.pool.query(
      `UPDATE projects SET retention_months = 1,
         retention_checked_at = CASE WHEN id = $1 THEN NULL ELSE clock_timestamp() END`,
      [project],
    );
    await insertEvent(short, project, 'continuation.old.one', '2025-01-01T00:00:00.000Z');
    await insertEvent(short, project, 'continuation.old.two', '2025-01-02T00:00:00.000Z');

    const results: Awaited<ReturnType<typeof runRetentionOnce>>[] = [];
    let resolveTwo!: () => void;
    const twoRuns = new Promise<void>((resolve) => { resolveTwo = resolve; });
    const worker = startRetentionWorker(short.pool, {
      intervalMs: 60_000,
      continuationDelayMs: 5,
      maxConsecutiveContinuations: 2,
      projectId: project,
      batchSize: 1,
      maxBatchesPerRun: 4,
      maxRowsPerRun: 100,
      maxRunMs: 5_000,
      onResult: (result) => {
        results.push(result);
        if (results.length === 2) resolveTwo();
      },
    });
    await twoRuns;
    await worker.stop();

    expect(results[0]).toEqual(expect.objectContaining({
      projectsScanned: 1,
      batchesAttempted: 4,
      eventsDeleted: 1,
      hasMore: true,
    }));
    expect(results[1]).toEqual(expect.objectContaining({ eventsDeleted: 1 }));
  });

  it('never exceeds the total row budget', async () => {
    // Earlier cases deliberately leave a continuation backlog on the shared
    // project. Use a fresh tenant so the row budget assertion measures only
    // the three rows created by this case, independent of statement ordering.
    const budget = await createTestEnv();
    try {
      const project = await projectId(budget);
      await budget.pool.query('UPDATE projects SET retention_months = 1 WHERE id = $1', [project]);
      for (const event of ['row-budget.one', 'row-budget.two', 'row-budget.three']) {
        await insertEvent(budget, project, event, '2025-01-01T00:00:00.000Z');
      }
      const result = await runRetentionOnce(budget.pool, {
        now: new Date('2026-07-16T12:00:00.000Z'),
        projectId: project,
        batchSize: 10,
        maxBatchesPerRun: 40,
        maxRowsPerRun: 2,
        maxRunMs: 5_000,
      });
      expect(result.eventsDeleted).toBe(2);
      expect(result.hasMore).toBe(true);
      expect(await eventCount(budget, project, 'row-budget.%')).toBe(1);
    } finally {
      await budget.close();
    }
  });

});

async function projectId(env: TestEnv): Promise<string> {
  const { rows } = await env.pool.query('SELECT id FROM projects WHERE slug = $1', [env.projectSlug]);
  return rows[0].id as string;
}

async function insertEvent(env: TestEnv, projectIdValue: string, event: string, timestamp: string): Promise<void> {
  await env.pool.query(
    `INSERT INTO events (project_id, env, event, "timestamp", distinct_id, properties, registered)
     VALUES ($1, 'prod', $2, $3, $4, '{}', true)`,
    [projectIdValue, event, timestamp, `${event}-actor`],
  );
}

async function storedEvents(env: TestEnv, projects: string[]): Promise<Array<{ project_id: string; event: string }>> {
  const { rows } = await env.pool.query(
    'SELECT project_id::text, event FROM events WHERE project_id = ANY($1::uuid[]) ORDER BY event',
    [projects],
  );
  return rows;
}

async function eventCount(env: TestEnv, project: string, eventPattern: string): Promise<number> {
  const result = await env.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM events WHERE project_id = $1 AND event LIKE $2',
    [project, eventPattern],
  );
  return result.rows[0]?.count ?? 0;
}
