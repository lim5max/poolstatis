import type pg from 'pg';
import type { MeasurementDeclaration } from '../schemas.js';
import { ApiError } from '../errors.js';
import { canonicalDeclaration } from './contracts.js';

export interface DecisionHistoryFilters {
  metric?: string;
  tag?: string;
  owner?: string;
  contract?: string;
  experiment?: string;
  status?: 'proposed' | 'approved' | 'rejected';
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface DecisionHistoryItem {
  decision_id: string;
  release_id: string;
  contract_key: string;
  contract_revision: number;
  primary_metric_key: string;
  guardrail_metric_keys: string[];
  decision_owner: string;
  hypothesis: string;
  proposed_outcome: string;
  proposed_rationale: string;
  accepted_outcome: string | null;
  accepted_rationale: string | null;
  status: string;
  proposal_disagreed: boolean;
  evidence_quality: { ready: boolean; trust: string; sample_size: number; blockers: number };
  stale: boolean;
  stale_reasons: string[];
  created_at: string;
}

export async function searchDecisionHistory(
  pool: pg.Pool,
  projectId: string,
  filters: DecisionHistoryFilters,
): Promise<{ items: DecisionHistoryItem[]; next_cursor: string | null }> {
  const limit = Math.max(1, Math.min(filters.limit ?? 50, 100));
  const params: unknown[] = [projectId];
  let where = 'd.project_id = $1';
  if (filters.metric) { params.push(filters.metric); where += ` AND (r.contract_snapshot->>'primary_metric_key' = $${params.length} OR r.contract_snapshot->'guardrail_metric_keys' ? $${params.length})`; }
  if (filters.owner) { params.push(filters.owner); where += ` AND r.contract_snapshot->>'decision_owner' = $${params.length}`; }
  if (filters.contract) { params.push(filters.contract); where += ` AND r.contract_key = $${params.length}`; }
  if (filters.experiment) { params.push(filters.experiment); where += ` AND r.experiment_key = $${params.length}`; }
  if (filters.status) { params.push(filters.status); where += ` AND d.status = $${params.length}`; }
  if (filters.from) { params.push(new Date(filters.from)); where += ` AND d.created_at >= $${params.length}`; }
  if (filters.to) { params.push(new Date(filters.to)); where += ` AND d.created_at < $${params.length}`; }
  if (filters.tag) {
    params.push(filters.tag.toLowerCase());
    where += ` AND m.tags @> ARRAY[$${params.length}]::text[]`;
  }
  if (filters.cursor) {
    const cursor = decodeCursor(filters.cursor);
    params.push(cursor.createdAt, cursor.id);
    where += ` AND (d.created_at, d.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);
  const { rows } = await pool.query<Record<string, any>>(
    `SELECT d.*, e.ready, e.trust, e.sample_size, e.blockers,
            e.created_at AS evidence_created_at,
            r.contract_key, r.contract_revision, r.contract_snapshot,
            m.updated_at AS metric_updated_at,
            mc.revision AS current_contract_revision
     FROM decisions d
     JOIN evidence_sets e ON e.id = d.evidence_id
     JOIN releases r ON r.id = d.release_id
     JOIN metrics m ON m.project_id = d.project_id
       AND m.key = r.contract_snapshot->>'primary_metric_key'
     LEFT JOIN measurement_contracts mc ON mc.project_id = d.project_id
       AND mc.key = r.contract_key
     WHERE ${where}
     ORDER BY d.created_at DESC, d.id DESC LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map(historyRow);
  const last = page[page.length - 1];
  return { items: page, next_cursor: hasMore && last ? encodeCursor(last.created_at, last.decision_id) : null };
}

export async function similarPastChanges(
  pool: pg.Pool,
  projectId: string,
  declarationInput: MeasurementDeclaration,
): Promise<Array<DecisionHistoryItem & { similarity_score: number; shared: string[] }>> {
  const declaration = canonicalDeclaration(declarationInput);
  if (declaration.contracts.length !== 1) {
    throw new ApiError(400, 'similar_contract_count_invalid', 'similar changes requires exactly one contract');
  }
  const target = declaration.contracts[0]!;
  const history = await searchDecisionHistory(pool, projectId, { limit: 100 });
  const targetMetric = await pool.query<{ tags: string[] }>(
    'SELECT tags FROM metrics WHERE project_id = $1 AND key = $2', [projectId, target.primary_metric_key],
  );
  const targetTags = new Set(targetMetric.rows[0]?.tags ?? []);
  const scored = await Promise.all(history.items.map(async (item) => {
    const shared: string[] = [];
    let score = 0;
    if (item.primary_metric_key === target.primary_metric_key) { score += 0.45; shared.push('primary_metric'); }
    const guardrails = item.guardrail_metric_keys.filter((key) => target.guardrail_metric_keys.includes(key));
    if (guardrails.length > 0) { score += 0.2; shared.push(`guardrails:${guardrails.join(',')}`); }
    if (item.decision_owner === target.decision_owner) { score += 0.1; shared.push('decision_owner'); }
    const metric = await pool.query<{ tags: string[] }>(
      'SELECT tags FROM metrics WHERE project_id = $1 AND key = $2', [projectId, item.primary_metric_key],
    );
    const tags = (metric.rows[0]?.tags ?? []).filter((tag) => targetTags.has(tag));
    if (tags.length > 0) { score += 0.15; shared.push(`tags:${tags.join(',')}`); }
    const targetProperties = new Set(target.target_filters.map((filter) => filter.property));
    const past = await pool.query<{ contract_snapshot: Record<string, any> }>(
      'SELECT contract_snapshot FROM releases WHERE project_id = $1 AND id = $2', [projectId, item.release_id],
    );
    const pastProperties = new Set((past.rows[0]?.contract_snapshot.target_filters ?? []).map((filter: { property: string }) => filter.property));
    if ([...pastProperties].some((property) => targetProperties.has(String(property)))) { score += 0.1; shared.push('target_property'); }
    return { ...item, similarity_score: Number(score.toFixed(4)), shared };
  }));
  return scored.filter((item) => item.similarity_score > 0)
    .sort((a, b) => b.similarity_score - a.similarity_score || b.created_at.localeCompare(a.created_at) || a.decision_id.localeCompare(b.decision_id))
    .slice(0, 20);
}

function historyRow(row: Record<string, any>): DecisionHistoryItem {
  const snapshot = row.contract_snapshot as Record<string, any>;
  const staleReasons: string[] = [];
  if (new Date(row.metric_updated_at).getTime() > new Date(row.evidence_created_at).getTime()) staleReasons.push('metric_definition_changed_after_evidence');
  if (row.current_contract_revision && row.current_contract_revision !== row.contract_revision) staleReasons.push('contract_fingerprint_changed');
  return {
    decision_id: row.id, release_id: row.release_id, contract_key: row.contract_key,
    contract_revision: row.contract_revision, primary_metric_key: snapshot.primary_metric_key,
    guardrail_metric_keys: snapshot.guardrail_metric_keys ?? [], decision_owner: snapshot.decision_owner,
    hypothesis: snapshot.business_hypothesis, proposed_outcome: row.proposed_outcome,
    proposed_rationale: row.proposed_rationale, accepted_outcome: row.accepted_outcome,
    accepted_rationale: row.accepted_rationale, status: row.status,
    proposal_disagreed: Boolean(row.accepted_outcome && row.accepted_outcome !== row.proposed_outcome),
    evidence_quality: { ready: row.ready, trust: row.trust.status, sample_size: row.sample_size, blockers: row.blockers.length },
    stale: staleReasons.length > 0, stale_reasons: staleReasons,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function encodeCursor(createdAt: string, id: string): string { return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url'); }
function decodeCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    const createdAt = new Date(String(parsed.createdAt ?? ''));
    if (Number.isNaN(createdAt.getTime()) || typeof parsed.id !== 'string' || parsed.id.length === 0) throw new Error('invalid cursor fields');
    return { createdAt, id: parsed.id };
  } catch {
    throw new ApiError(400, 'decision_history_cursor_invalid', 'invalid decision history cursor', 'start again without cursor');
  }
}
