import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type { PrepareDecisionActionInput } from '../schemas.js';
import { getDecision } from './decisions.js';
import { getFeatureFlag, updateFeatureFlag } from './flags.js';

type Queryable = pg.Pool | pg.PoolClient;

export type DecisionActionStatus = 'prepared' | 'approved' | 'executed' | 'rejected' | 'failed';

export interface DecisionAction {
  id: string;
  decision_id: string;
  release_id: string;
  evidence_id: string;
  decision_revision: number;
  action_type: PrepareDecisionActionInput['action_type'];
  status: DecisionActionStatus;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  expected_effect: string;
  undo: Record<string, unknown>;
  confirmation_fingerprint: string;
  idempotency_key: string;
  prepared_by: string;
  approved_by: string | null;
  approved_at: string | null;
  executed_at: string | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActionAudit {
  id: string;
  event: 'prepared' | 'approved' | 'executed' | 'rejected' | 'failed' | 'retried';
  actor: string;
  snapshot: DecisionAction;
  created_at: string;
}

export interface ActionDetail { action: DecisionAction; audit: ActionAudit[] }

export interface ActionHooks {
  enqueueWebhook?: (input: {
    projectId: string; action: DecisionAction; actor: string;
  }) => Promise<Record<string, unknown>>;
}

export async function prepareAction(
  pool: pg.Pool,
  projectId: string,
  decisionId: string,
  input: PrepareDecisionActionInput,
  actor: string,
): Promise<{ detail: ActionDetail; idempotent: boolean }> {
  const decision = await getDecision(pool, projectId, decisionId);
  const undo = await undoFor(pool, projectId, decision.release.id, input);
  const fingerprint = sha256({
    decision_id: decisionId,
    decision_revision: decision.decision.current_revision,
    evidence_id: decision.evidence.id,
    action_type: input.action_type,
    target: input.target,
    payload: input.payload,
    expected_effect: input.expected_effect,
    undo,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `decision-action:${projectId}:${input.idempotency_key}`,
    ]);
    const existing = await client.query<Record<string, any>>(
      'SELECT * FROM decision_actions WHERE project_id = $1 AND idempotency_key = $2',
      [projectId, input.idempotency_key],
    );
    if (existing.rows[0]) {
      const action = rowToAction(existing.rows[0]);
      if (action.confirmation_fingerprint !== fingerprint) {
        throw new ApiError(409, 'action_idempotency_conflict', 'this action idempotency key has a different frozen payload', 'use the exact prepared payload or choose a new idempotency_key');
      }
      await client.query('COMMIT');
      return { detail: await getAction(client, projectId, action.id), idempotent: true };
    }
    const inserted = await client.query<Record<string, any>>(
      `INSERT INTO decision_actions (
         project_id, decision_id, release_id, evidence_id, decision_revision,
         action_type, target, payload,
         expected_effect, undo, confirmation_fingerprint, idempotency_key, prepared_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        projectId, decisionId, decision.release.id, decision.evidence.id,
        decision.decision.current_revision, input.action_type,
        JSON.stringify(input.target), JSON.stringify(input.payload), input.expected_effect,
        JSON.stringify(undo), fingerprint, input.idempotency_key, actor,
      ],
    );
    const action = rowToAction(inserted.rows[0]!);
    await appendAudit(client, projectId, action, 'prepared', actor);
    await client.query('COMMIT');
    return { detail: await getAction(client, projectId, action.id), idempotent: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function listActions(
  pool: pg.Pool,
  projectId: string,
  filter: { decisionId?: string; status?: string } = {},
): Promise<DecisionAction[]> {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM decision_actions WHERE project_id = $1';
  if (filter.decisionId) { params.push(filter.decisionId); sql += ` AND decision_id = $${params.length}`; }
  if (filter.status) { params.push(filter.status); sql += ` AND status = $${params.length}`; }
  const { rows } = await pool.query<Record<string, any>>(`${sql} ORDER BY created_at DESC, id`, params);
  return rows.map(rowToAction);
}

export async function getAction(pool: Queryable, projectId: string, id: string): Promise<ActionDetail> {
  const action = await pool.query<Record<string, any>>(
    'SELECT * FROM decision_actions WHERE project_id = $1 AND id = $2', [projectId, id],
  );
  if (!action.rows[0]) throw notFound('decision_action');
  const audit = await pool.query<Record<string, any>>(
    `SELECT id, event, actor, snapshot, created_at FROM decision_action_audit
     WHERE project_id = $1 AND action_id = $2 ORDER BY created_at, id`,
    [projectId, id],
  );
  return {
    action: rowToAction(action.rows[0]),
    audit: audit.rows.map((row) => ({
      ...row,
      snapshot: rowToAction(row.snapshot),
      created_at: iso(row.created_at)!,
    })) as ActionAudit[],
  };
}

export async function approveAction(
  pool: pg.Pool,
  projectId: string,
  id: string,
  fingerprint: string,
  actor: string,
  hooks: ActionHooks = {},
): Promise<ActionDetail> {
  const client = await pool.connect();
  let action: DecisionAction;
  try {
    await client.query('BEGIN');
    const selected = await client.query<Record<string, any>>(
      'SELECT * FROM decision_actions WHERE project_id = $1 AND id = $2 FOR UPDATE', [projectId, id],
    );
    if (!selected.rows[0]) throw notFound('decision_action');
    action = rowToAction(selected.rows[0]);
    if (action.confirmation_fingerprint !== fingerprint) {
      throw new ApiError(409, 'action_confirmation_mismatch', 'the action payload changed or the confirmation fingerprint is stale', 'read the action again and approve its exact confirmation_fingerprint');
    }
    if (action.status === 'executed') { await client.query('COMMIT'); return getAction(client, projectId, id); }
    if (action.status !== 'prepared' && action.status !== 'approved' && action.status !== 'failed') {
      throw new ApiError(409, 'action_not_approvable', `action status=${action.status} cannot be approved`);
    }
    if (action.action_type === 'create_issue' || action.action_type === 'open_draft_pr') {
      throw new ApiError(400, 'action_capability_unsupported', `${action.action_type} requires a configured GitHub integration`, 'keep the prepared action as a draft or configure the integration first');
    }
    const decision = await client.query<{ status: string }>(
      'SELECT status FROM decisions WHERE project_id = $1 AND id = $2', [projectId, action.decision_id],
    );
    if (decision.rows[0]?.status !== 'approved') {
      throw new ApiError(409, 'decision_approval_required', 'an action cannot execute until its decision is approved by a human');
    }
    const approved = await client.query<Record<string, any>>(
      `UPDATE decision_actions SET status = 'approved', approved_by = $3,
         approved_at = COALESCE(approved_at, now()), error_code = NULL,
         error_message = NULL, updated_at = now()
       WHERE project_id = $1 AND id = $2 RETURNING *`,
      [projectId, id, actor],
    );
    action = rowToAction(approved.rows[0]!);
    await appendAudit(client, projectId, action, 'approved', actor);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  return executeApproved(pool, projectId, action!, actor, hooks);
}

export async function rejectAction(
  pool: pg.Pool,
  projectId: string,
  id: string,
  rationale: string,
  actor: string,
): Promise<ActionDetail> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<Record<string, any>>(
      'SELECT * FROM decision_actions WHERE project_id = $1 AND id = $2 FOR UPDATE', [projectId, id],
    );
    if (!selected.rows[0]) throw notFound('decision_action');
    const previous = rowToAction(selected.rows[0]);
    if (previous.status !== 'prepared') throw new ApiError(409, 'action_not_rejectable', `action status=${previous.status} cannot be rejected`);
    const updated = await client.query<Record<string, any>>(
      `UPDATE decision_actions SET status = 'rejected', result = $3, updated_at = now()
       WHERE project_id = $1 AND id = $2 RETURNING *`,
      [projectId, id, JSON.stringify({ rationale })],
    );
    const action = rowToAction(updated.rows[0]!);
    await appendAudit(client, projectId, action, 'rejected', actor);
    await client.query('COMMIT');
    return getAction(client, projectId, id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function retryAction(
  pool: pg.Pool,
  projectId: string,
  id: string,
  actor: string,
  hooks: ActionHooks = {},
): Promise<ActionDetail> {
  const selected = await pool.query<Record<string, any>>(
    'SELECT * FROM decision_actions WHERE project_id = $1 AND id = $2', [projectId, id],
  );
  if (!selected.rows[0]) throw notFound('decision_action');
  const action = rowToAction(selected.rows[0]);
  if (action.status !== 'failed') throw new ApiError(409, 'action_not_retryable', `action status=${action.status} cannot be retried`);
  await pool.query(
    `INSERT INTO decision_action_audit (project_id, action_id, event, actor, snapshot)
     VALUES ($1, $2, 'retried', $3, $4)`,
    [projectId, id, actor, JSON.stringify(action)],
  );
  return executeApproved(pool, projectId, action, actor, hooks);
}

async function executeApproved(
  pool: pg.Pool,
  projectId: string,
  action: DecisionAction,
  actor: string,
  hooks: ActionHooks,
): Promise<ActionDetail> {
  try {
    let result: Record<string, unknown>;
    if (action.action_type === 'draft_implementation_prompt') {
      result = { ready: true, prompt: action.payload.prompt, release_id: action.release_id };
    } else if (action.action_type === 'prepare_flag_rollback') {
      const flagKey = String(action.payload.flag_key);
      const flag = await updateFeatureFlag(pool, projectId, flagKey, {
        variants: action.payload.variants as Array<{ key: string; rollout_percentage: number; payload?: Record<string, unknown> }>,
      });
      result = { flag_key: flag.key, variants: flag.variants, release_id: action.release_id };
    } else if (action.action_type === 'schedule_observation') {
      const scheduled = new Date(String(action.payload.at));
      await pool.query(
        `UPDATE releases SET next_evaluation_at = $3, retry_state = $4, updated_at = now()
         WHERE project_id = $1 AND id = $2`,
        [projectId, action.release_id, scheduled, JSON.stringify({ status: 'scheduled_by_action', action_id: action.id })],
      );
      result = { scheduled_at: scheduled.toISOString(), release_id: action.release_id };
    } else if (action.action_type === 'request_more_data') {
      result = { requested: true, request: action.payload, release_id: action.release_id };
    } else if (action.action_type === 'generic_webhook') {
      if (!hooks.enqueueWebhook) throw new ApiError(409, 'webhook_destination_required', 'a generic webhook action needs a configured destination');
      result = await hooks.enqueueWebhook({ projectId, action, actor });
    } else {
      throw new ApiError(400, 'action_capability_unsupported', `${action.action_type} is not executable without an integration`);
    }
    const updated = await pool.query<Record<string, any>>(
      `UPDATE decision_actions SET status = 'executed', result = $3,
         executed_at = COALESCE(executed_at, now()), error_code = NULL,
         error_message = NULL, updated_at = now()
       WHERE project_id = $1 AND id = $2 RETURNING *`,
      [projectId, action.id, JSON.stringify(result)],
    );
    const executed = rowToAction(updated.rows[0]!);
    await pool.query(
      `INSERT INTO decision_action_audit (project_id, action_id, event, actor, snapshot)
       VALUES ($1, $2, 'executed', $3, $4)`,
      [projectId, action.id, actor, JSON.stringify(executed)],
    );
  } catch (error) {
    const code = errorCode(error);
    const message = error instanceof Error ? error.message.slice(0, 500) : 'action execution failed';
    const failed = await pool.query<Record<string, any>>(
      `UPDATE decision_actions SET status = 'failed', error_code = $3,
         error_message = $4, updated_at = now()
       WHERE project_id = $1 AND id = $2 RETURNING *`,
      [projectId, action.id, code, message],
    );
    await pool.query(
      `INSERT INTO decision_action_audit (project_id, action_id, event, actor, snapshot)
       VALUES ($1, $2, 'failed', $3, $4)`,
      [projectId, action.id, actor, JSON.stringify(rowToAction(failed.rows[0]!))],
    );
  }
  return getAction(pool, projectId, action.id);
}

async function undoFor(
  pool: pg.Pool,
  projectId: string,
  releaseId: string,
  input: PrepareDecisionActionInput,
): Promise<Record<string, unknown>> {
  if (input.action_type === 'prepare_flag_rollback') {
    const flag = await getFeatureFlag(pool, projectId, String(input.payload.flag_key));
    return { action: 'restore_feature_flag', flag_key: flag.key, status: flag.status, variants: flag.variants };
  }
  if (input.action_type === 'schedule_observation') {
    const release = await pool.query<{ next_evaluation_at: Date | null }>(
      'SELECT next_evaluation_at FROM releases WHERE project_id = $1 AND id = $2', [projectId, releaseId],
    );
    return { action: 'restore_observation_schedule', next_evaluation_at: iso(release.rows[0]?.next_evaluation_at ?? null) };
  }
  return { action: 'none', reason: 'no external state is changed by this action type' };
}

async function appendAudit(
  client: pg.PoolClient,
  projectId: string,
  action: DecisionAction,
  event: ActionAudit['event'],
  actor: string,
) {
  await client.query(
    `INSERT INTO decision_action_audit (project_id, action_id, event, actor, snapshot)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, action.id, event, actor, JSON.stringify(action)],
  );
}

function rowToAction(row: Record<string, any>): DecisionAction {
  return {
    id: row.id, decision_id: row.decision_id, release_id: row.release_id,
    evidence_id: row.evidence_id, decision_revision: row.decision_revision,
    action_type: row.action_type, status: row.status, target: row.target,
    payload: row.payload, expected_effect: row.expected_effect, undo: row.undo,
    confirmation_fingerprint: row.confirmation_fingerprint,
    idempotency_key: row.idempotency_key, prepared_by: row.prepared_by,
    approved_by: row.approved_by, approved_at: iso(row.approved_at),
    executed_at: iso(row.executed_at), result: row.result,
    error_code: row.error_code, error_message: row.error_message,
    created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)!,
  };
}
function sha256(value: unknown): string { return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex'); }
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}
function iso(value: Date | string | null | undefined): string | null { return value ? new Date(value).toISOString() : null; }
function errorCode(error: unknown): string { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'action_execution_failed'; }
