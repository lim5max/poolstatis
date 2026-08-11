import type pg from 'pg';
import type { QueryService } from './query.js';
import type { AutomationWorkerOptions, WorkerRunResult } from './automationWorkerShared.js';
import { errorCode, retryDelay, stableHash } from './automationWorkerShared.js';
import { enqueueNotifications } from './notificationWorker.js';
import { nextZonedOccurrence } from './timezoneSchedule.js';

interface ScheduleRevision {
  project_id: string; schedule_id: string; schedule_version: number; env: string; metric_key: string;
  window_days: number; timezone: string; frequency: 'daily' | 'weekly'; local_time: string;
  weekday: number | null; destination_ids: string[]; next_run_at: Date | string;
}
interface ClaimedRun extends ScheduleRevision {
  id: string; scheduled_for: Date | string; attempt_count: number; local_run_key: string;
}
export interface FeedEvaluation { value: number; events: number; definitionFingerprint: string }
export type FeedEvaluator = (
  query: QueryService, projectId: string, revision: ScheduleRevision, from: Date, to: Date,
) => Promise<FeedEvaluation>;

export class InsightFeedWorker {
  constructor(private readonly pool: pg.Pool, private readonly query: QueryService,
    private readonly options: AutomationWorkerOptions, private readonly evaluator: FeedEvaluator = defaultEvaluator) {}

  async runOnce(now = new Date()): Promise<WorkerRunResult> {
    await this.seedDue(now);
    const runs = await this.claim(now);
    const result: WorkerRunResult = { claimed: runs.length, succeeded: 0, failed: 0, dead: 0 };
    for (const run of runs) {
      try {
        const to = new Date(run.scheduled_for);
        const from = new Date(to.getTime() - run.window_days * 86_400_000);
        const evaluation = await this.evaluator(this.query, run.project_id, run, from, to);
        await this.complete(run, evaluation, from, to, now);
        result.succeeded += 1;
      } catch (error) {
        const terminal = run.attempt_count >= this.options.maxAttempts;
        await this.pool.query(
          `UPDATE insight_feed_runs SET status = $3, error_code = $4, lease_until = NULL,
             next_attempt_at = $5, updated_at = now() WHERE project_id = $1 AND id = $2`,
          [run.project_id, run.id, terminal ? 'dead' : 'failed', errorCode(error, 'insight_feed_evaluation_failed'),
            new Date(now.getTime() + retryDelay(this.options, run.attempt_count))],
        );
        result[terminal ? 'dead' : 'failed'] += 1;
      }
    }
    return result;
  }

  private async seedDue(now: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ScheduleRevision>(
        `SELECT s.project_id, s.id AS schedule_id, s.current_version AS schedule_version, s.next_run_at,
           r.env, r.metric_key, r.window_days, r.timezone, r.frequency, r.local_time::text,
           r.weekday, r.destination_ids
         FROM insight_feed_schedules s JOIN insight_feed_schedule_revisions r
           ON r.schedule_id = s.id AND r.version = s.current_version
         WHERE s.status = 'active' AND s.next_run_at <= $1
           AND ($2::uuid IS NULL OR s.project_id = $2)
         ORDER BY s.next_run_at, s.created_at, s.id FOR UPDATE OF s SKIP LOCKED LIMIT $3`,
        [now, this.options.projectId ?? null, this.options.batchSize],
      );
      for (const row of rows) {
        const scheduled = new Date(row.next_run_at);
        const cadence = { timezone: row.timezone, frequency: row.frequency, localTime: row.local_time.slice(0, 5), weekday: row.weekday };
        const occurrence = nextZonedOccurrence(cadence, new Date(scheduled.getTime() - 60_000));
        const dedupe = stableHash({ scheduleId: row.schedule_id, version: row.schedule_version, localRunKey: occurrence.localRunKey });
        await client.query(
          `INSERT INTO insight_feed_runs (project_id, schedule_id, schedule_version, local_run_key,
             deduplication_key, scheduled_for, next_attempt_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (schedule_id, local_run_key) DO NOTHING`,
          [row.project_id, row.schedule_id, row.schedule_version, occurrence.localRunKey, dedupe, scheduled, now],
        );
        const next = nextZonedOccurrence(cadence, scheduled);
        await client.query(
          `UPDATE insight_feed_schedules SET next_run_at = $3, updated_at = now()
           WHERE project_id = $1 AND id = $2`, [row.project_id, row.schedule_id, next.scheduledAt],
        );
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async claim(now: Date): Promise<ClaimedRun[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ClaimedRun>(
        `WITH due AS (
           SELECT f.id FROM insight_feed_runs f
           WHERE ($1::uuid IS NULL OR f.project_id = $1) AND f.next_attempt_at <= $2
             AND (f.status IN ('pending','failed') OR (f.status = 'running' AND f.lease_until <= $2))
           ORDER BY f.next_attempt_at, f.created_at, f.id FOR UPDATE OF f SKIP LOCKED LIMIT $3
         )
         UPDATE insight_feed_runs f SET status = 'running', attempt_count = f.attempt_count + 1,
           lease_until = $4, updated_at = now()
         FROM due, insight_feed_schedule_revisions r
         WHERE f.id = due.id AND r.schedule_id = f.schedule_id AND r.version = f.schedule_version
         RETURNING f.id, f.project_id, f.schedule_id, f.schedule_version, f.local_run_key,
           f.scheduled_for, f.attempt_count, r.env, r.metric_key, r.window_days, r.timezone,
           r.frequency, r.local_time::text, r.weekday, r.destination_ids`,
        [this.options.projectId ?? null, now, this.options.batchSize, new Date(now.getTime() + this.options.leaseMs)],
      );
      await client.query('COMMIT'); return rows;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async complete(run: ClaimedRun, evaluation: FeedEvaluation, from: Date, to: Date, now: Date): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const answer = {
        state: evaluation.events > 0 ? 'ready' : 'empty',
        headline: `${run.metric_key}: ${evaluation.value}`,
        takeaway: evaluation.events > 0 ? `Measured ${evaluation.events} events in the scheduled window.` : 'No events were measured in the scheduled window.',
        primary_value: evaluation.value,
      };
      const evidence = { state: 'trusted', as_of: to.toISOString(), metric_key: run.metric_key, events: evaluation.events };
      await client.query(
        `INSERT INTO insight_feed_snapshots (project_id, schedule_id, run_id, resolved_window,
           definition_fingerprint, answer, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [run.project_id, run.schedule_id, run.id, JSON.stringify({ from: from.toISOString(), to: to.toISOString() }),
          evaluation.definitionFingerprint, JSON.stringify(answer), JSON.stringify(evidence)],
      );
      await enqueueNotifications(client, {
        projectId: run.project_id, destinationIds: run.destination_ids, feedRunId: run.id,
        idempotencyKey: `feed:${run.id}`, payload: {
          schema_version: 1, kind: 'insight_feed', code: 'scheduled_metric_trend',
          answer: { state: answer.state, headline: answer.headline, takeaway: answer.takeaway },
          evidence, action: { kind: 'open_control_tower', resource_id: run.id },
        },
      });
      await client.query(
        `UPDATE insight_feed_runs SET status = 'succeeded', completed_at = $3, lease_until = NULL,
           error_code = NULL, updated_at = now() WHERE project_id = $1 AND id = $2`, [run.project_id, run.id, now],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}

async function defaultEvaluator(query: QueryService, projectId: string, revision: ScheduleRevision, from: Date, to: Date): Promise<FeedEvaluation> {
  const result = await query.aggregateMetricWindow(projectId, {
    metricKey: revision.metric_key, env: revision.env, filters: [], properties: [], from, to, windowName: 'observed',
  });
  return {
    value: result.result.value, events: result.result.events,
    definitionFingerprint: stableHash({ metric: result.metric, source: result.source, query: result.query }),
  };
}
