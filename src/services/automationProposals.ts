import type pg from 'pg';
import { ApiError } from '../errors.js';

export interface AutomationProposal {
  id: string; policy_id: string; finding_id: string; kind: 'pause' | 'rollback';
  status: 'proposed' | 'approved' | 'rejected'; target: Record<string, unknown>;
  payload: Record<string, unknown>; undo: Record<string, unknown>; confirmation_fingerprint: string;
  proposed_by: string; reviewed_by: string | null; reviewed_at: string | null;
  review_rationale: string | null; created_at: string; updated_at: string;
}

export async function listAutomationProposals(pool: pg.Pool, projectId: string): Promise<AutomationProposal[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM automation_proposals WHERE project_id = $1 ORDER BY created_at DESC, id', [projectId],
  );
  return rows.map(mapProposal);
}

export async function getAutomationProposal(pool: pg.Pool | pg.PoolClient, projectId: string, id: string): Promise<AutomationProposal> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM automation_proposals WHERE project_id = $1 AND id = $2', [projectId, id],
  );
  if (!rows[0]) throw new ApiError(404, 'automation_proposal_not_found', 'automation proposal not found');
  return mapProposal(rows[0]);
}

export async function reviewAutomationProposal(
  pool: pg.Pool, projectId: string, id: string, decision: 'approved' | 'rejected',
  fingerprint: string, rationale: string, actor: string, now = new Date(),
): Promise<{ proposal: AutomationProposal; execution: { state: 'requires_existing_human_approved_mutation'; mutation: 'feature_flag_update' } }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<Record<string, unknown>>(
      'SELECT * FROM automation_proposals WHERE project_id = $1 AND id = $2 FOR UPDATE', [projectId, id],
    );
    if (!selected.rows[0]) throw new ApiError(404, 'automation_proposal_not_found', 'automation proposal not found');
    if (selected.rows[0].status !== 'proposed') throw new ApiError(409, 'automation_proposal_already_reviewed', 'automation proposal was already reviewed');
    if (selected.rows[0].confirmation_fingerprint !== fingerprint) {
      throw new ApiError(409, 'automation_proposal_fingerprint_mismatch', 'frozen proposal fingerprint does not match');
    }
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE automation_proposals SET status = $3, reviewed_by = $4, reviewed_at = $5,
         review_rationale = $6, updated_at = now() WHERE project_id = $1 AND id = $2 RETURNING *`,
      [projectId, id, decision, actor, now, rationale],
    );
    const proposal = mapProposal(updated.rows[0]!);
    await client.query(
      `INSERT INTO automation_proposal_audit (project_id, proposal_id, event, actor, snapshot)
       VALUES ($1,$2,$3,$4,$5)`, [projectId, id, decision, actor, JSON.stringify(proposal)],
    );
    await client.query('COMMIT');
    return { proposal, execution: { state: 'requires_existing_human_approved_mutation', mutation: 'feature_flag_update' } };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

function mapProposal(row: Record<string, unknown>): AutomationProposal {
  return {
    id: String(row.id), policy_id: String(row.policy_id), finding_id: String(row.finding_id),
    kind: row.kind as AutomationProposal['kind'], status: row.status as AutomationProposal['status'],
    target: row.target as Record<string, unknown>, payload: row.payload as Record<string, unknown>,
    undo: row.undo as Record<string, unknown>, confirmation_fingerprint: String(row.confirmation_fingerprint),
    proposed_by: String(row.proposed_by), reviewed_by: row.reviewed_by ? String(row.reviewed_by) : null,
    reviewed_at: row.reviewed_at ? iso(row.reviewed_at) : null,
    review_rationale: row.review_rationale ? String(row.review_rationale) : null,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}
function iso(value: unknown): string { return new Date(value as string | Date).toISOString(); }
