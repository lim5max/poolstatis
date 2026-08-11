import type pg from 'pg';
import { ApiError } from '../errors.js';
import type { InsightFeedScheduleInput } from './automationSchemas.js';
import { requireDestinationIds } from './notifications.js';
import { nextZonedOccurrence } from './timezoneSchedule.js';

export interface InsightFeedSchedule {
  id: string; schedule_key: string; name: string; current_version: number;
  status: 'active' | 'paused' | 'archived'; next_run_at: string;
  revision: InsightFeedScheduleInput & { version: number; created_at: string };
  created_by: string; created_at: string; updated_at: string;
}

export async function createInsightFeedSchedule(
  pool: pg.Pool, projectId: string, input: InsightFeedScheduleInput, actor: string, now = new Date(),
): Promise<InsightFeedSchedule> {
  const next = nextZonedOccurrence({ timezone: input.timezone, frequency: input.frequency, localTime: input.local_time, weekday: input.weekday }, now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const metric = await client.query<{ status: string }>('SELECT status FROM metrics WHERE project_id = $1 AND key = $2', [projectId, input.metric_key]);
    if (metric.rows[0]?.status !== 'active') throw new ApiError(400, 'insight_metric_invalid', 'insight feed metric must be active in this project');
    await requireDestinationIds(client, projectId, input.destination_ids);
    const head = await client.query<Record<string, any>>(
      `INSERT INTO insight_feed_schedules (project_id, schedule_key, name, next_run_at, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`, [projectId, input.schedule_key, input.name, next.scheduledAt, actor],
    );
    const id = head.rows[0]!.id;
    await client.query(
      `INSERT INTO insight_feed_schedule_revisions (
         project_id, schedule_id, version, env, metric_key, template_kind, window_days,
         timezone, frequency, local_time, weekday, destination_ids, owner, created_by
       ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [projectId, id, input.env, input.metric_key, input.template_kind, input.window_days,
        input.timezone, input.frequency, input.local_time, input.weekday, input.destination_ids, input.owner, actor],
    );
    const detail = await getInsightFeedSchedule(client, projectId, id);
    await client.query(
      `INSERT INTO insight_feed_schedule_audit (project_id, schedule_id, event, actor, snapshot)
       VALUES ($1,$2,'created',$3,$4)`, [projectId, id, actor, JSON.stringify(detail)],
    );
    await client.query('COMMIT');
    return detail;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (isUnique(error)) throw new ApiError(409, 'insight_schedule_key_taken', `insight schedule "${input.schedule_key}" already exists`);
    throw error;
  } finally { client.release(); }
}

export async function listInsightFeedSchedules(pool: pg.Pool, projectId: string): Promise<InsightFeedSchedule[]> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM insight_feed_schedules WHERE project_id = $1 ORDER BY created_at DESC, id', [projectId]);
  return Promise.all(rows.map((row) => getInsightFeedSchedule(pool, projectId, row.id)));
}

export async function reviseInsightFeedSchedule(
  pool: pg.Pool, projectId: string, id: string, expectedVersion: number,
  input: InsightFeedScheduleInput, actor: string, now = new Date(),
): Promise<InsightFeedSchedule> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{ current_version: number; status: string }>(
      'SELECT current_version, status FROM insight_feed_schedules WHERE project_id = $1 AND id = $2 FOR UPDATE', [projectId, id],
    );
    if (!selected.rows[0]) throw new ApiError(404, 'insight_schedule_not_found', 'insight feed schedule not found');
    if (selected.rows[0].status === 'archived') throw new ApiError(409, 'insight_schedule_archived', 'archived insight feed schedules cannot be revised');
    if (selected.rows[0].current_version !== expectedVersion) throw new ApiError(409, 'insight_schedule_version_conflict', 'insight feed schedule version is stale');
    await validateScheduleRevision(client, projectId, input);
    const version = expectedVersion + 1;
    await insertScheduleRevision(client, projectId, id, version, input, actor);
    const next = nextZonedOccurrence({ timezone: input.timezone, frequency: input.frequency, localTime: input.local_time, weekday: input.weekday }, now);
    await client.query(
      `UPDATE insight_feed_schedules SET schedule_key = $3, name = $4, current_version = $5,
         next_run_at = $6, updated_at = now() WHERE project_id = $1 AND id = $2`,
      [projectId, id, input.schedule_key, input.name, version, next.scheduledAt],
    );
    const detail = await getInsightFeedSchedule(client, projectId, id);
    await auditSchedule(client, projectId, detail, 'revised', actor);
    await client.query('COMMIT'); return detail;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function transitionInsightFeedSchedule(
  pool: pg.Pool, projectId: string, id: string, expectedVersion: number,
  status: 'active' | 'paused' | 'archived', actor: string, now = new Date(),
): Promise<InsightFeedSchedule> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{ current_version: number; status: InsightFeedSchedule['status'] }>(
      'SELECT current_version, status FROM insight_feed_schedules WHERE project_id = $1 AND id = $2 FOR UPDATE', [projectId, id],
    );
    const current = selected.rows[0];
    if (!current) throw new ApiError(404, 'insight_schedule_not_found', 'insight feed schedule not found');
    if (current.current_version !== expectedVersion) throw new ApiError(409, 'insight_schedule_version_conflict', 'insight feed schedule version is stale');
    if (current.status === 'archived' && status !== 'archived') throw new ApiError(409, 'insight_schedule_archived', 'archived insight feed schedules cannot be resumed');
    let next: Date | null = null;
    if (status === 'active' && current.status !== 'active') {
      const detail = await getInsightFeedSchedule(client, projectId, id);
      next = nextZonedOccurrence({ timezone: detail.revision.timezone, frequency: detail.revision.frequency,
        localTime: detail.revision.local_time.slice(0, 5), weekday: detail.revision.weekday }, now).scheduledAt;
    }
    if (current.status !== status) {
      await client.query(
        `UPDATE insight_feed_schedules SET status = $3, next_run_at = COALESCE($4, next_run_at),
           updated_at = now() WHERE project_id = $1 AND id = $2`, [projectId, id, status, next],
      );
    }
    const detail = await getInsightFeedSchedule(client, projectId, id);
    if (current.status !== status) await auditSchedule(client, projectId, detail, status === 'active' ? 'resumed' : status, actor);
    await client.query('COMMIT'); return detail;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function getInsightFeedSchedule(pool: pg.Pool | pg.PoolClient, projectId: string, id: string): Promise<InsightFeedSchedule> {
  const { rows } = await pool.query<Record<string, any>>(
    `SELECT s.*, r.version, r.env, r.metric_key, r.template_kind, r.window_days,
       r.timezone, r.frequency, r.local_time::text, r.weekday, r.destination_ids,
       r.owner, r.created_at AS revision_created_at
     FROM insight_feed_schedules s JOIN insight_feed_schedule_revisions r
       ON r.schedule_id = s.id AND r.version = s.current_version
     WHERE s.project_id = $1 AND s.id = $2`, [projectId, id],
  );
  if (!rows[0]) throw new ApiError(404, 'insight_schedule_not_found', 'insight feed schedule not found');
  const row = rows[0];
  return {
    id: row.id, schedule_key: row.schedule_key, name: row.name, current_version: row.current_version,
    status: row.status, next_run_at: iso(row.next_run_at), created_by: row.created_by,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    revision: {
      schedule_key: row.schedule_key, name: row.name, env: row.env, metric_key: row.metric_key,
      template_kind: row.template_kind, window_days: row.window_days, timezone: row.timezone,
      frequency: row.frequency, local_time: row.local_time, weekday: row.weekday,
      destination_ids: row.destination_ids, owner: row.owner,
      version: row.version, created_at: iso(row.revision_created_at),
    },
  };
}
function iso(value: Date | string): string { return new Date(value).toISOString(); }
function isUnique(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'); }

async function validateScheduleRevision(client: pg.PoolClient, projectId: string, input: InsightFeedScheduleInput) {
  const metric = await client.query<{ status: string }>('SELECT status FROM metrics WHERE project_id = $1 AND key = $2', [projectId, input.metric_key]);
  if (metric.rows[0]?.status !== 'active') throw new ApiError(400, 'insight_metric_invalid', 'insight feed metric must be active in this project');
  await requireDestinationIds(client, projectId, input.destination_ids);
}

async function insertScheduleRevision(client: pg.PoolClient, projectId: string, id: string, version: number, input: InsightFeedScheduleInput, actor: string) {
  await client.query(
    `INSERT INTO insight_feed_schedule_revisions (
       project_id, schedule_id, version, env, metric_key, template_kind, window_days,
       timezone, frequency, local_time, weekday, destination_ids, owner, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [projectId, id, version, input.env, input.metric_key, input.template_kind, input.window_days,
      input.timezone, input.frequency, input.local_time, input.weekday, input.destination_ids, input.owner, actor],
  );
}

async function auditSchedule(client: pg.PoolClient, projectId: string, detail: InsightFeedSchedule, event: string, actor: string) {
  await client.query(
    `INSERT INTO insight_feed_schedule_audit (project_id, schedule_id, event, actor, snapshot)
     VALUES ($1,$2,$3,$4,$5)`, [projectId, detail.id, event, actor, JSON.stringify(detail)],
  );
}
