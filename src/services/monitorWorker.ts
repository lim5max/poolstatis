import type pg from 'pg';
import type { QueryService } from './query.js';
import type { AutomationWorkerOptions, WorkerRunResult } from './automationWorkerShared.js';
import { errorCode, retryDelay, stableHash } from './automationWorkerShared.js';
import { activeDestinationIds, enqueueNotifications } from './notificationWorker.js';
import { getFeatureFlag } from './flags.js';
import { requireSameMonitorEnvironment } from './monitorPolicies.js';

interface PolicyRevision {
  project_id: string; policy_id: string; policy_version: number; metric_key: string; env: string;
  comparison_rule: 'above' | 'below' | 'change_up_percent' | 'change_down_percent'; threshold: number;
  minimum_sample: number; window_minutes: number; cadence_minutes: number; cooldown_seconds: number;
  destination_ids: string[]; proposal_kind: 'pause' | 'rollback' | null;
  proposal_target: { flag_key: string; variants: Array<{ key: string; rollout_percentage: number }> } | null;
}
interface ClaimedRun extends PolicyRevision {
  id: string; window_from: Date | string; window_to: Date | string; attempt_count: number;
}
export interface MonitorEvaluation {
  current: { value: number; events: number };
  previous: { value: number; events: number };
  definitionFingerprint: string;
}
export type MonitorEvaluator = (
  query: QueryService, projectId: string, revision: PolicyRevision, windowFrom: Date, windowTo: Date,
) => Promise<MonitorEvaluation>;

export class MonitorWorker {
  constructor(private readonly pool: pg.Pool, private readonly query: QueryService,
    private readonly options: AutomationWorkerOptions, private readonly evaluator: MonitorEvaluator = defaultEvaluator) {}

  async runOnce(now = new Date()): Promise<WorkerRunResult> {
    await this.seedDue(now);
    const runs = await this.claim(now);
    const result: WorkerRunResult = { claimed: runs.length, succeeded: 0, failed: 0, dead: 0 };
    for (const run of runs) {
      try {
        const evaluated = await this.evaluator(this.query, run.project_id, run, new Date(run.window_from), new Date(run.window_to));
        await this.complete(run, evaluated, now);
        result.succeeded += 1;
      } catch (error) {
        const terminal = run.attempt_count >= this.options.maxAttempts;
        await this.pool.query(
          `UPDATE monitor_runs SET status = $3, error_code = $4, lease_until = NULL,
             next_attempt_at = $5, updated_at = now() WHERE project_id = $1 AND id = $2`,
          [run.project_id, run.id, terminal ? 'dead' : 'failed', errorCode(error, 'monitor_evaluation_failed'),
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
      const { rows } = await client.query<PolicyRevision>(
        `SELECT p.project_id, p.id AS policy_id, p.current_version AS policy_version,
           r.metric_key, r.env, r.comparison_rule, r.threshold, r.minimum_sample,
           r.window_minutes, r.cadence_minutes, r.cooldown_seconds, r.destination_ids,
           r.proposal_kind, r.proposal_target
         FROM monitor_policies p JOIN monitor_policy_revisions r
           ON r.policy_id = p.id AND r.version = p.current_version
         WHERE p.status = 'active' AND p.next_evaluation_at <= $1
           AND ($2::uuid IS NULL OR p.project_id = $2)
         ORDER BY p.next_evaluation_at, p.created_at, p.id
         FOR UPDATE OF p SKIP LOCKED LIMIT $3`, [now, this.options.projectId ?? null, this.options.batchSize],
      );
      for (const row of rows) {
        const cadenceMs = row.cadence_minutes * 60_000;
        const windowTo = new Date(Math.floor(now.getTime() / cadenceMs) * cadenceMs);
        const windowFrom = new Date(windowTo.getTime() - row.window_minutes * 60_000);
        const dedupe = stableHash({ policyId: row.policy_id, version: row.policy_version, windowTo: windowTo.toISOString() });
        await client.query(
          `INSERT INTO monitor_runs (project_id, policy_id, policy_version, deduplication_key, window_from, window_to, next_attempt_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id, deduplication_key) DO NOTHING`,
          [row.project_id, row.policy_id, row.policy_version, dedupe, windowFrom, windowTo, now],
        );
        await client.query(
          `UPDATE monitor_policies SET next_evaluation_at = $3, updated_at = now()
           WHERE project_id = $1 AND id = $2`, [row.project_id, row.policy_id, new Date(windowTo.getTime() + cadenceMs)],
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
           SELECT m.id FROM monitor_runs m
           WHERE ($1::uuid IS NULL OR m.project_id = $1) AND m.next_attempt_at <= $2
             AND (m.status IN ('pending','failed') OR (m.status = 'running' AND m.lease_until <= $2))
           ORDER BY m.next_attempt_at, m.created_at, m.id FOR UPDATE OF m SKIP LOCKED LIMIT $3
         )
         UPDATE monitor_runs m SET status = 'running', attempt_count = m.attempt_count + 1,
           lease_until = $4, updated_at = now()
         FROM due, monitor_policy_revisions r
         WHERE m.id = due.id AND r.policy_id = m.policy_id AND r.version = m.policy_version
         RETURNING m.id, m.project_id, m.policy_id, m.policy_version, m.window_from, m.window_to,
           m.attempt_count, r.metric_key, r.env, r.comparison_rule, r.threshold,
           r.minimum_sample, r.window_minutes, r.cadence_minutes, r.cooldown_seconds,
           r.destination_ids, r.proposal_kind, r.proposal_target`,
        [this.options.projectId ?? null, now, this.options.batchSize, new Date(now.getTime() + this.options.leaseMs)],
      );
      await client.query('COMMIT'); return rows;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async complete(run: ClaimedRun, evaluation: MonitorEvaluation, now: Date): Promise<void> {
    const threshold = evaluateMonitorThreshold(
      run.comparison_rule, evaluation.current.value, evaluation.previous.value, Number(run.threshold),
    );
    const comparison = threshold.comparison;
    const breached = evaluation.current.events >= run.minimum_sample && threshold.breached;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (breached) {
        if (comparison === null) throw new Error('breached monitor must have a numeric comparison');
        const recent = await client.query(
          `SELECT 1 FROM monitor_findings WHERE project_id = $1 AND policy_id = $2
             AND created_at > $3 LIMIT 1`, [run.project_id, run.policy_id, new Date(now.getTime() - run.cooldown_seconds * 1000)],
        );
        if (!recent.rows[0]) {
          const snapshot = {
            policy_version: run.policy_version, metric_key: run.metric_key, env: run.env, comparison_rule: run.comparison_rule,
            threshold: Number(run.threshold), observed_comparison: comparison,
          };
          const evidence = {
            state: 'trusted', window_from: new Date(run.window_from).toISOString(), window_to: new Date(run.window_to).toISOString(),
            env: run.env, current: evaluation.current, previous: evaluation.previous, definition_fingerprint: evaluation.definitionFingerprint,
          };
          const notificationState = (await activeDestinationIds(client, run.project_id, run.destination_ids)).length === 0
            ? 'not_configured' : 'queued';
          const finding = await client.query<{ id: string }>(
            `INSERT INTO monitor_findings (project_id, policy_id, run_id, policy_version, severity, snapshot, evidence, notification_state)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [run.project_id, run.policy_id, run.id, run.policy_version, run.proposal_kind ? 'high' : 'medium',
              JSON.stringify(snapshot), JSON.stringify(evidence), notificationState],
          );
          const findingId = finding.rows[0]!.id;
          if (run.proposal_kind && run.proposal_target) await this.freezeProposal(client, run, findingId);
          await enqueueNotifications(client, {
            projectId: run.project_id, destinationIds: run.destination_ids, findingId,
            idempotencyKey: `monitor:${run.id}`, payload: {
              schema_version: 1, kind: 'monitor_finding', code: 'monitor_threshold_breached',
              answer: { state: 'attention', headline: `${run.metric_key} breached its monitor threshold`,
                takeaway: `Observed comparison ${comparison.toFixed(2)} against threshold ${Number(run.threshold).toFixed(2)}.` },
              evidence: { state: 'trusted', as_of: new Date(run.window_to).toISOString(), policy_version: run.policy_version },
              action: { kind: 'open_control_tower', resource_id: findingId },
            },
          });
        }
      }
      await client.query(
        `UPDATE monitor_runs SET status = 'succeeded', completed_at = $3, lease_until = NULL,
           error_code = NULL, updated_at = now() WHERE project_id = $1 AND id = $2`, [run.project_id, run.id, now],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async freezeProposal(client: pg.PoolClient, run: ClaimedRun, findingId: string): Promise<void> {
    const target = run.proposal_target!;
    const flag = await getFeatureFlag(client, run.project_id, target.flag_key, true);
    requireSameMonitorEnvironment(run.env, flag.env, 'proposal feature flag');
    const frozenTarget = { kind: 'feature_flag', flag_key: flag.key, env: flag.env };
    const payload = { variants: target.variants };
    const undo = { status: flag.status, variants: flag.variants.map(({ key, rollout_percentage }) => ({ key, rollout_percentage })) };
    const fingerprint = stableHash({ project_id: run.project_id, kind: run.proposal_kind, target: frozenTarget, payload, undo });
    const proposal = await client.query<Record<string, unknown>>(
      `INSERT INTO automation_proposals (project_id, policy_id, finding_id, kind, target, payload, undo,
         confirmation_fingerprint, proposed_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [run.project_id, run.policy_id, findingId, run.proposal_kind, JSON.stringify(frozenTarget), JSON.stringify(payload),
        JSON.stringify(undo), fingerprint, this.options.actor],
    );
    await client.query(
      `INSERT INTO automation_proposal_audit (project_id, proposal_id, event, actor, snapshot)
       VALUES ($1,$2,'proposed',$3,$4)`, [run.project_id, proposal.rows[0]!.id, this.options.actor, JSON.stringify(proposal.rows[0])],
    );
  }
}

async function defaultEvaluator(query: QueryService, projectId: string, revision: PolicyRevision, from: Date, to: Date): Promise<MonitorEvaluation> {
  const previousFrom = new Date(from.getTime() - revision.window_minutes * 60_000);
  const [current, previous] = await Promise.all([
    query.aggregateMetricWindow(projectId, { metricKey: revision.metric_key, env: revision.env, filters: [], properties: [], from, to, windowName: 'observed' }),
    query.aggregateMetricWindow(projectId, { metricKey: revision.metric_key, env: revision.env, filters: [], properties: [], from: previousFrom, to: from, windowName: 'baseline' }),
  ]);
  return {
    current: { value: current.result.value, events: current.result.events },
    previous: { value: previous.result.value, events: previous.result.events },
    definitionFingerprint: stableHash({ metric: current.metric, source: current.source, query: current.query }),
  };
}

export function evaluateMonitorThreshold(
  rule: PolicyRevision['comparison_rule'], current: number, previous: number, threshold: number,
): { breached: boolean; comparison: number | null } {
  if (rule === 'above') return { breached: current >= threshold, comparison: current };
  if (rule === 'below') return { breached: current <= threshold, comparison: current };
  if (previous === 0) return { breached: false, comparison: null };
  const comparison = rule === 'change_up_percent'
    ? ((current - previous) / Math.abs(previous)) * 100
    : ((previous - current) / Math.abs(previous)) * 100;
  return { breached: comparison >= threshold, comparison };
}
