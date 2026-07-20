import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { QueryService } from './query.js';
import { evaluateRelease, type EvidenceSet, type ProposedDecision } from './evaluation.js';

export interface ReleaseMonitorOptions {
  batchSize: number;
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  leaseMs: number;
  actor: string;
  /** Test/ops scope; production omits this to monitor every tenant. */
  projectId?: string;
}

export interface MonitorRunResult {
  claimed: number;
  waiting: number;
  succeeded: number;
  failed: number;
}

type EvaluationFn = (
  pool: pg.Pool,
  query: QueryService,
  projectId: string,
  releaseId: string,
  actor: string,
  now: Date,
) => Promise<{ evidence: EvidenceSet; decision: ProposedDecision; idempotent: boolean }>;

interface ClaimedRelease {
  id: string;
  project_id: string;
  contract_revision: number;
  contract_snapshot: { observation_window_days: number };
  deployed_at: Date | string;
}

interface AttemptClaim {
  id: string;
  attemptCount: number;
  windowKey: string;
  observationTo: Date;
}

export class ReleaseMonitor {
  constructor(
    private readonly pool: pg.Pool,
    private readonly query: QueryService,
    private readonly options: ReleaseMonitorOptions,
    private readonly evaluator: EvaluationFn = evaluateRelease,
  ) {}

  async runOnce(now: Date = new Date()): Promise<MonitorRunResult> {
    const releases = await this.claimDue(now);
    const result: MonitorRunResult = { claimed: releases.length, waiting: 0, succeeded: 0, failed: 0 };
    for (const release of releases) {
      const attempt = await this.beginAttempt(release, now);
      if (now.getTime() < attempt.observationTo.getTime()) {
        await this.finishAttempt(release, attempt, {
          status: 'waiting', reason: 'observation_window_incomplete',
          scheduledAt: attempt.observationTo,
        }, now);
        result.waiting += 1;
        continue;
      }
      try {
        const evaluated = await this.evaluator(
          this.pool, this.query, release.project_id, release.id, this.options.actor, now,
        );
        if (evaluated.evidence.ready) {
          await this.finishAttempt(release, attempt, {
            status: 'succeeded', reason: null, scheduledAt: null,
            evidenceId: evaluated.evidence.id, decisionId: evaluated.decision.id,
          }, now);
          result.succeeded += 1;
        } else {
          const reason = evaluated.evidence.blockers[0]?.code ?? 'evidence_not_ready';
          await this.finishAttempt(release, attempt, {
            status: attempt.attemptCount >= this.options.maxAttempts ? 'failed' : 'waiting',
            reason,
            scheduledAt: attempt.attemptCount >= this.options.maxAttempts
              ? null
              : new Date(now.getTime() + this.retryDelay(attempt.attemptCount)),
            evidenceId: evaluated.evidence.id,
            decisionId: evaluated.decision.id,
          }, now);
          if (attempt.attemptCount >= this.options.maxAttempts) result.failed += 1;
          else result.waiting += 1;
        }
      } catch (error) {
        const terminal = attempt.attemptCount >= this.options.maxAttempts;
        await this.finishAttempt(release, attempt, {
          status: 'failed',
          reason: 'evaluation_failed',
          errorCode: errorCode(error),
          scheduledAt: terminal ? null : new Date(now.getTime() + this.retryDelay(attempt.attemptCount)),
        }, now);
        result.failed += 1;
      }
    }
    return result;
  }

  private async claimDue(now: Date): Promise<ClaimedRelease[]> {
    const leaseUntil = new Date(now.getTime() + this.options.leaseMs);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ClaimedRelease>(
        `WITH due AS (
           SELECT r.id
           FROM releases r
           WHERE r.status IN ('deployed', 'observing')
             AND ($5::uuid IS NULL OR r.project_id = $5)
             AND r.deployed_at IS NOT NULL
             AND COALESCE(r.next_evaluation_at, r.deployed_at) <= $1
             AND NOT EXISTS (
               SELECT 1 FROM evaluation_attempts a
               WHERE a.project_id = r.project_id AND a.release_id = r.id
                 AND (a.status = 'succeeded'
                   OR (a.status = 'failed' AND a.attempt_count >= $2))
             )
           ORDER BY COALESCE(r.next_evaluation_at, r.deployed_at), r.created_at, r.id
           FOR UPDATE OF r SKIP LOCKED
           LIMIT $3
         )
         UPDATE releases r
         SET next_evaluation_at = $4, updated_at = now()
         FROM due
         WHERE r.id = due.id
         RETURNING r.id, r.project_id, r.contract_revision, r.contract_snapshot,
                   r.deployed_at`,
        [now, this.options.maxAttempts, this.options.batchSize, leaseUntil, this.options.projectId ?? null],
      );
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  private async beginAttempt(release: ClaimedRelease, now: Date): Promise<AttemptClaim> {
    const deployedAt = new Date(release.deployed_at);
    const observationTo = new Date(
      deployedAt.getTime() + release.contract_snapshot.observation_window_days * 86_400_000,
    );
    const windowKey = createHash('sha256').update(JSON.stringify({
      release_id: release.id,
      contract_revision: release.contract_revision,
      deployed_at: deployedAt.toISOString(),
      observation_to: observationTo.toISOString(),
    })).digest('hex');
    const { rows } = await this.pool.query<{ id: string; attempt_count: number }>(
      `INSERT INTO evaluation_attempts (
         project_id, release_id, window_key, status, attempt_count,
         evidence_window, scheduled_at, started_at
       ) VALUES ($1, $2, $3, 'running', 1, $4, $5, $5)
       ON CONFLICT (project_id, release_id, window_key) DO UPDATE SET
         status = 'running', attempt_count = evaluation_attempts.attempt_count + 1,
         reason = NULL, error_code = NULL, started_at = EXCLUDED.started_at,
         completed_at = NULL, updated_at = now()
       RETURNING id, attempt_count`,
      [
        release.project_id, release.id, windowKey,
        JSON.stringify({ from: deployedAt.toISOString(), to: observationTo.toISOString() }), now,
      ],
    );
    return { id: rows[0]!.id, attemptCount: rows[0]!.attempt_count, windowKey, observationTo };
  }

  private async finishAttempt(
    release: ClaimedRelease,
    attempt: AttemptClaim,
    update: {
      status: 'waiting' | 'failed' | 'succeeded';
      reason: string | null;
      errorCode?: string;
      scheduledAt: Date | null;
      evidenceId?: string;
      decisionId?: string;
    },
    now: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE evaluation_attempts SET
           status = $3, reason = $4, error_code = $5,
           evidence_id = COALESCE($6, evidence_id),
           decision_id = COALESCE($7, decision_id),
           scheduled_at = COALESCE($8, scheduled_at),
           completed_at = $9, updated_at = now()
         WHERE project_id = $1 AND id = $2`,
        [
          release.project_id, attempt.id, update.status, update.reason,
          update.errorCode ?? null, update.evidenceId ?? null, update.decisionId ?? null,
          update.scheduledAt, now,
        ],
      );
      await client.query(
        `UPDATE releases SET
           evaluation_attempts = $3,
           next_evaluation_at = $4,
           retry_state = $5,
           updated_at = now()
         WHERE project_id = $1 AND id = $2`,
        [
          release.project_id, release.id, attempt.attemptCount, update.scheduledAt,
          JSON.stringify({ status: update.status, reason: update.reason, error_code: update.errorCode ?? null }),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  private retryDelay(attemptCount: number): number {
    return Math.min(this.options.maxRetryMs, this.options.baseRetryMs * (2 ** Math.max(0, attemptCount - 1)));
  }
}

export function startReleaseMonitor(
  monitor: ReleaseMonitor,
  options: { intervalMs: number; onResult?: (result: MonitorRunResult) => void; onError?: (error: unknown) => void },
): { stop: () => Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, options.intervalMs);
    timer.unref();
  };
  const run = () => {
    if (stopped || current) return;
    current = monitor.runOnce()
      .then((result) => options.onResult?.(result))
      .catch((error) => options.onError?.(error))
      .finally(() => { current = null; schedule(); });
  };
  run();
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'evaluation_failed';
}
