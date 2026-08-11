import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type { MonitorPolicyInput } from './automationSchemas.js';
import { requireDestinationIds } from './notifications.js';

export interface MonitorPolicy {
  id: string; policy_key: string; name: string; current_version: number;
  status: 'active' | 'paused' | 'archived'; next_evaluation_at: string;
  revision: MonitorPolicyInput & { version: number; created_at: string };
  created_by: string; created_at: string; updated_at: string;
}

export async function createMonitorPolicy(
  pool: pg.Pool, projectId: string, input: MonitorPolicyInput, actor: string,
): Promise<MonitorPolicy> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await validateRevision(client, projectId, input);
    const head = await client.query<Record<string, unknown>>(
      `INSERT INTO monitor_policies (project_id, policy_key, name, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`, [projectId, input.policy_key, input.name, actor],
    );
    await insertRevision(client, projectId, String(head.rows[0]!.id), 1, input, actor);
    const detail = await getMonitorPolicy(client, projectId, String(head.rows[0]!.id));
    await audit(client, projectId, detail, 'created', actor);
    await client.query('COMMIT');
    return detail;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (isUnique(error)) throw new ApiError(409, 'monitor_policy_key_taken', `monitor policy "${input.policy_key}" already exists`);
    throw error;
  } finally { client.release(); }
}

export async function reviseMonitorPolicy(
  pool: pg.Pool, projectId: string, id: string, expectedVersion: number, input: MonitorPolicyInput, actor: string,
): Promise<MonitorPolicy> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{ current_version: number; status: string }>(
      'SELECT current_version, status FROM monitor_policies WHERE project_id = $1 AND id = $2 FOR UPDATE', [projectId, id],
    );
    if (!selected.rows[0]) throw notFound('monitor_policy');
    if (selected.rows[0].status === 'archived') throw new ApiError(409, 'monitor_policy_archived', 'archived monitor policies cannot be revised');
    if (selected.rows[0].current_version !== expectedVersion) throw new ApiError(409, 'monitor_version_conflict', 'monitor policy version is stale');
    await validateRevision(client, projectId, input);
    const version = expectedVersion + 1;
    await insertRevision(client, projectId, id, version, input, actor);
    await client.query(
      `UPDATE monitor_policies SET policy_key = $3, name = $4, current_version = $5,
         next_evaluation_at = now(), updated_at = now() WHERE project_id = $1 AND id = $2`,
      [projectId, id, input.policy_key, input.name, version],
    );
    const detail = await getMonitorPolicy(client, projectId, id);
    await audit(client, projectId, detail, 'revised', actor);
    await client.query('COMMIT');
    return detail;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function listMonitorPolicies(pool: pg.Pool, projectId: string): Promise<MonitorPolicy[]> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM monitor_policies WHERE project_id = $1 ORDER BY created_at DESC, id', [projectId],
  );
  return Promise.all(rows.map((row) => getMonitorPolicy(pool, projectId, row.id)));
}

export async function transitionMonitorPolicy(
  pool: pg.Pool, projectId: string, id: string, expectedVersion: number,
  status: 'active' | 'paused' | 'archived', actor: string,
): Promise<MonitorPolicy> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{ current_version: number; status: MonitorPolicy['status'] }>(
      'SELECT current_version, status FROM monitor_policies WHERE project_id = $1 AND id = $2 FOR UPDATE', [projectId, id],
    );
    const current = selected.rows[0];
    if (!current) throw notFound('monitor_policy');
    if (current.current_version !== expectedVersion) throw new ApiError(409, 'monitor_version_conflict', 'monitor policy version is stale');
    if (current.status === 'archived' && status !== 'archived') throw new ApiError(409, 'monitor_policy_archived', 'archived monitor policies cannot be resumed');
    if (current.status !== status) {
      await client.query(
        `UPDATE monitor_policies SET status = $3,
           next_evaluation_at = CASE WHEN $3 = 'active' THEN now() ELSE next_evaluation_at END,
           updated_at = now() WHERE project_id = $1 AND id = $2`, [projectId, id, status],
      );
    }
    const detail = await getMonitorPolicy(client, projectId, id);
    if (current.status !== status) await audit(client, projectId, detail, status === 'active' ? 'resumed' : status, actor);
    await client.query('COMMIT');
    return detail;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function getMonitorPolicy(pool: pg.Pool | pg.PoolClient, projectId: string, id: string): Promise<MonitorPolicy> {
  const { rows } = await pool.query<Record<string, any>>(
    `SELECT p.*, r.version, r.env, r.target_kind, r.target_id, r.metric_key,
       r.comparison_rule, r.threshold, r.minimum_sample, r.window_minutes,
       r.cadence_minutes, r.cooldown_seconds, r.owner, r.destination_ids,
       r.proposal_kind, r.proposal_target, r.created_at AS revision_created_at
     FROM monitor_policies p
     JOIN monitor_policy_revisions r ON r.policy_id = p.id AND r.version = p.current_version
     WHERE p.project_id = $1 AND p.id = $2`, [projectId, id],
  );
  if (!rows[0]) throw notFound('monitor_policy');
  const row = rows[0];
  return {
    id: row.id, policy_key: row.policy_key, name: row.name, current_version: row.current_version,
    status: row.status, next_evaluation_at: iso(row.next_evaluation_at), created_by: row.created_by,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    revision: {
      policy_key: row.policy_key, name: row.name, env: row.env, target_kind: row.target_kind,
      target_id: row.target_id, metric_key: row.metric_key, comparison_rule: row.comparison_rule,
      threshold: Number(row.threshold), minimum_sample: row.minimum_sample, window_minutes: row.window_minutes,
      cadence_minutes: row.cadence_minutes, cooldown_seconds: row.cooldown_seconds, owner: row.owner,
      destination_ids: row.destination_ids, proposal_kind: row.proposal_kind, proposal_target: row.proposal_target,
      version: row.version, created_at: iso(row.revision_created_at),
    },
  };
}

async function validateRevision(client: pg.PoolClient, projectId: string, input: MonitorPolicyInput) {
  const metric = await client.query<{ status: string }>('SELECT status FROM metrics WHERE project_id = $1 AND key = $2', [projectId, input.metric_key]);
  if (metric.rows[0]?.status !== 'active') throw new ApiError(400, 'monitor_metric_invalid', 'monitor metric must be active in this project');
  await requireDestinationIds(client, projectId, input.destination_ids);
  let linkedFlagKey: string | null = null;
  if (input.target_kind === 'release') {
    const target = await client.query<{ env: string; flag_key: string | null; experiment_key: string | null }>(
      'SELECT env, flag_key, experiment_key FROM releases WHERE project_id = $1 AND id = $2',
      [projectId, input.target_id],
    );
    if (!target.rows[0]) throw new ApiError(400, 'monitor_target_invalid', 'monitor target must belong to this project');
    requireSameMonitorEnvironment(input.env, target.rows[0].env, 'release target');
    linkedFlagKey = target.rows[0].flag_key;
    if (!linkedFlagKey && target.rows[0].experiment_key) {
      const experiment = await client.query<{ env: string | null; flag_key: string }>(
        'SELECT env, flag_key FROM experiments WHERE project_id = $1 AND key = $2',
        [projectId, target.rows[0].experiment_key],
      );
      if (!experiment.rows[0]) {
        throw new ApiError(400, 'monitor_target_invalid', 'release experiment target must belong to this project');
      }
      requireSameMonitorEnvironment(input.env, experiment.rows[0].env, 'release experiment target');
      linkedFlagKey = experiment.rows[0].flag_key;
    }
  } else if (input.target_kind === 'experiment') {
    const target = await client.query<{ env: string | null; flag_key: string }>(
      'SELECT env, flag_key FROM experiments WHERE project_id = $1 AND id = $2',
      [projectId, input.target_id],
    );
    if (!target.rows[0]) throw new ApiError(400, 'monitor_target_invalid', 'monitor target must belong to this project');
    requireSameMonitorEnvironment(input.env, target.rows[0].env, 'experiment target');
    linkedFlagKey = target.rows[0].flag_key;
  }
  if (input.proposal_target) {
    const flag = await client.query<{ env: string | null }>(
      'SELECT env FROM feature_flags WHERE project_id = $1 AND key = $2',
      [projectId, input.proposal_target.flag_key],
    );
    if (!flag.rows[0]) {
      throw new ApiError(400, 'monitor_target_invalid', 'proposal feature flag must belong to this project');
    }
    requireSameMonitorEnvironment(input.env, flag.rows[0].env, 'proposal feature flag');
    if (input.target_kind !== 'project' && !linkedFlagKey) {
      throw new ApiError(
        409,
        'monitor_proposal_target_mismatch',
        'the release or experiment target has no feature flag linked to the proposed mutation',
        'attach the environment-scoped feature flag to the target before enabling automatic proposals',
      );
    }
    if (linkedFlagKey && linkedFlagKey !== input.proposal_target.flag_key) {
      throw new ApiError(
        409,
        'monitor_proposal_target_mismatch',
        `proposal flag "${input.proposal_target.flag_key}" does not match target flag "${linkedFlagKey}"`,
        'use the feature flag attached to the same release or experiment',
      );
    }
  }
}

export function requireSameMonitorEnvironment(expected: string, actual: string | null, subject: string): void {
  if (actual === expected) return;
  throw new ApiError(
    409,
    'monitor_environment_mismatch',
    `${subject} belongs to env=${actual ?? 'unscoped'} while the monitor policy belongs to env=${expected}`,
    'use a policy, release or experiment, and feature flag scoped to the same environment',
  );
}

async function insertRevision(client: pg.PoolClient, projectId: string, id: string, version: number, input: MonitorPolicyInput, actor: string) {
  await client.query(
    `INSERT INTO monitor_policy_revisions (
       project_id, policy_id, version, env, target_kind, target_id, metric_key,
       comparison_rule, threshold, minimum_sample, window_minutes, cadence_minutes,
       cooldown_seconds, owner, destination_ids, proposal_kind, proposal_target, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [projectId, id, version, input.env, input.target_kind, input.target_id, input.metric_key,
      input.comparison_rule, input.threshold, input.minimum_sample, input.window_minutes,
      input.cadence_minutes, input.cooldown_seconds, input.owner, input.destination_ids,
      input.proposal_kind, input.proposal_target ? JSON.stringify(input.proposal_target) : null, actor],
  );
}
async function audit(client: pg.PoolClient, projectId: string, policy: MonitorPolicy, event: string, actor: string) {
  await client.query('INSERT INTO monitor_policy_audit (project_id, policy_id, event, actor, snapshot) VALUES ($1,$2,$3,$4,$5)', [projectId, policy.id, event, actor, JSON.stringify(policy)]);
}
function iso(value: Date | string): string { return new Date(value).toISOString(); }
function isUnique(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'); }
