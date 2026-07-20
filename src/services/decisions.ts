import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type { DecisionOutcome, EvidenceSet, ProposedDecision } from './evaluation.js';
import { rowToDecision, rowToEvidence } from './evaluation.js';
import { getRelease, type Release } from './releases.js';

type Queryable = pg.Pool | pg.PoolClient;

export interface DecisionRevision {
  id: string;
  revision: number;
  action: 'proposed' | 'approved' | 'edited' | 'rejected';
  actor: string;
  previous_snapshot: ProposedDecision | null;
  snapshot: ProposedDecision;
  rationale: string;
  created_at: string;
}

export interface DecisionDetail {
  decision: ProposedDecision;
  evidence: EvidenceSet;
  revisions: DecisionRevision[];
  release: Release;
  contract: Release['contract_snapshot'] & { revision: number };
}

export async function listDecisions(
  pool: Queryable,
  projectId: string,
  filter: { status?: string; releaseId?: string } = {},
): Promise<ProposedDecision[]> {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM decisions WHERE project_id = $1';
  if (filter.status) {
    params.push(filter.status);
    sql += ` AND status = $${params.length}`;
  }
  if (filter.releaseId) {
    params.push(filter.releaseId);
    sql += ` AND release_id = $${params.length}`;
  }
  const { rows } = await pool.query(`${sql} ORDER BY created_at DESC, id`, params);
  return rows.map(rowToDecision);
}

export async function getDecision(
  pool: Queryable,
  projectId: string,
  id: string,
): Promise<DecisionDetail> {
  const decisionResult = await pool.query(
    'SELECT * FROM decisions WHERE project_id = $1 AND id = $2',
    [projectId, id],
  );
  if (!decisionResult.rows[0]) throw notFound('decision');
  const decision = rowToDecision(decisionResult.rows[0]);
  const evidenceResult = await pool.query(
    'SELECT * FROM evidence_sets WHERE project_id = $1 AND id = $2',
    [projectId, decision.evidence_id],
  );
  const revisionsResult = await pool.query<DecisionRevision>(
    `SELECT id, revision, action, actor, previous_snapshot, snapshot, rationale, created_at
     FROM decision_revisions
     WHERE project_id = $1 AND decision_id = $2 ORDER BY revision`,
    [projectId, id],
  );
  const releaseDetail = await getRelease(pool, projectId, decision.release_id);
  return {
    decision,
    evidence: rowToEvidence(evidenceResult.rows[0]!),
    revisions: revisionsResult.rows.map((revision) => ({
      ...revision,
      created_at: iso(revision.created_at),
    })),
    release: releaseDetail.release,
    contract: {
      ...releaseDetail.release.contract_snapshot,
      revision: releaseDetail.release.contract_revision,
    },
  };
}

export async function reviseDecision(
  pool: pg.Pool,
  projectId: string,
  id: string,
  command:
    | { action: 'approve'; rationale: string }
    | { action: 'reject'; rationale: string }
    | { action: 'edit'; outcome: DecisionOutcome; rationale: string },
  actor: string,
): Promise<DecisionDetail> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query(
      'SELECT * FROM decisions WHERE project_id = $1 AND id = $2 FOR UPDATE',
      [projectId, id],
    );
    if (!selected.rows[0]) throw notFound('decision');
    const previous = rowToDecision(selected.rows[0]);
    if (command.action !== 'edit' && previous.status !== 'proposed') {
      throw new ApiError(409, 'decision_already_reviewed', `decision status=${previous.status} cannot be ${command.action}d`);
    }
    if (command.action === 'edit' && previous.status === 'approved') {
      throw new ApiError(409, 'decision_already_approved', 'an approved decision is immutable; create a later revision from new evidence');
    }
    const evidenceResult = await client.query(
      'SELECT * FROM evidence_sets WHERE project_id = $1 AND id = $2',
      [projectId, previous.evidence_id],
    );
    const evidence = rowToEvidence(evidenceResult.rows[0]!);
    const outcome = command.action === 'approve'
      ? previous.proposed_outcome
      : command.action === 'edit'
        ? command.outcome
        : null;
    if (outcome && outcome !== 'inconclusive'
        && (!evidence.ready || evidence.trust.status !== 'trusted')) {
      throw new ApiError(
        409,
        'directional_decision_forbidden',
        'keep/fix/rollback are forbidden while evidence trust or readiness has blockers',
        'fix the evidence and re-evaluate, or accept an inconclusive decision',
      );
    }
    const revision = previous.current_revision + 1;
    const status = command.action === 'reject' ? 'rejected' : 'approved';
    const updated = await client.query(
      `UPDATE decisions SET
         status = $3,
         accepted_outcome = $4,
         accepted_rationale = $5,
         current_revision = $6,
         updated_at = now()
       WHERE project_id = $1 AND id = $2 AND current_revision = $7
       RETURNING *`,
      [
        projectId, id, status, outcome, command.rationale,
        revision, previous.current_revision,
      ],
    );
    if (!updated.rows[0]) throw new ApiError(409, 'decision_revision_conflict', 'decision changed during review');
    const decision = rowToDecision(updated.rows[0]);
    await client.query(
      `INSERT INTO decision_revisions (
         decision_id, project_id, revision, action, actor,
         previous_snapshot, snapshot, rationale
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id, projectId, revision,
        command.action === 'approve' ? 'approved' : command.action === 'edit' ? 'edited' : 'rejected',
        actor, JSON.stringify(previous), JSON.stringify(decision), command.rationale,
      ],
    );
    if (status === 'approved') {
      await finalizeObservedRelease(client, projectId, previous.release_id, actor);
    }
    await client.query('COMMIT');
    return getDecision(client, projectId, id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function finalizeObservedRelease(
  client: pg.PoolClient,
  projectId: string,
  releaseId: string,
  actor: string,
): Promise<void> {
  const selected = await client.query<{ status: string }>(
    'SELECT status FROM releases WHERE project_id = $1 AND id = $2 FOR UPDATE',
    [projectId, releaseId],
  );
  if (selected.rows[0]?.status !== 'observing') return;
  await client.query(
    `UPDATE releases SET status = 'decided', updated_at = now()
     WHERE project_id = $1 AND id = $2`,
    [projectId, releaseId],
  );
  await client.query(
    `INSERT INTO release_revisions (
       release_id, project_id, action, from_status, to_status, snapshot, actor
     ) SELECT id, project_id, 'transitioned', 'observing', 'decided',
              to_jsonb(releases.*) - 'project_id', $3
       FROM releases WHERE project_id = $1 AND id = $2`,
    [projectId, releaseId, actor],
  );
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
