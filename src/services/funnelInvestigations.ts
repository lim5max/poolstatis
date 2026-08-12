import type pg from 'pg';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { FunnelInvestigationCreateInput } from '../schemas.js';
import type { QueryService } from './query.js';
import { getFunnel, type Funnel } from './registry.js';
import { stableHash } from './automationWorkerShared.js';

type Queryable = pg.Pool | pg.PoolClient;

export interface FunnelInvestigation {
  id: string;
  env: string;
  saved_funnel: {
    id: string;
    key: string;
    name: string;
    goal: string;
    steps: Funnel['steps'];
    window_seconds: number;
  };
  transition: {
    from_step: number;
    to_step: number;
    from_metric: string;
    to_metric: string;
    from_label: string;
    to_label: string;
  };
  query_spec: Record<string, unknown>;
  query_result: Record<string, unknown>;
  evidence: Record<string, unknown>;
  lineage: {
    query_fingerprint: string;
    result_fingerprint: string;
  };
  idempotency_key: string;
  created_by: string;
  created_at: string;
}

export interface FunnelInvestigationListFilter {
  env?: string;
  funnel?: string;
  limit?: number;
}

export async function createFunnelInvestigation(
  pool: pg.Pool,
  queryService: QueryService,
  projectId: string,
  input: FunnelInvestigationCreateInput,
  actor: string,
): Promise<{ investigation: FunnelInvestigation; idempotent: boolean }> {
  const normalizedQuery = {
    kind: 'funnel' as const,
    funnel: input.funnel,
    env: input.env,
    date_from: new Date(input.date_from).toISOString(),
    date_to: new Date(input.date_to).toISOString(),
  };
  const durationMs = Date.parse(normalizedQuery.date_to) - Date.parse(normalizedQuery.date_from);
  if (durationMs > 366 * 24 * 60 * 60 * 1_000) {
    throw badRequest(
      'funnel_investigation_range_too_wide',
      'a funnel investigation is bounded to 366 days',
      'choose a narrower exact UTC range and persist a separate investigation for another period',
    );
  }

  const existing = await findByIdempotencyKey(pool, projectId, input.idempotency_key);
  if (existing) {
    assertSameRequest(existing, normalizedQuery, input);
    return { investigation: existing, idempotent: true };
  }

  const funnel = await getFunnel(pool, projectId, input.funnel);
  const from = funnel.steps[input.from_step];
  const to = funnel.steps[input.to_step];
  if (!from || !to) {
    throw badRequest(
      'funnel_investigation_transition_unavailable',
      'the requested transition is outside the saved funnel definition',
      'read the saved funnel and choose two adjacent step indexes',
    );
  }

  const result = await queryService.run(projectId, normalizedQuery, new Date());
  if (result.kind !== 'funnel' || !result.evidence) {
    throw new ApiError(
      409,
      'funnel_investigation_evidence_unavailable',
      'the saved funnel query did not return reproducible evidence',
      'repair the funnel measurement definition and run it again before persisting an investigation',
    );
  }
  const resultFrom = result.steps[input.from_step];
  const resultTo = result.steps[input.to_step];
  if (!resultFrom || !resultTo
    || resultFrom.metric_key !== from.metric_key
    || resultTo.metric_key !== to.metric_key) {
    throw new ApiError(
      409,
      'funnel_investigation_definition_changed',
      'the saved funnel changed while its evidence was being reproduced',
      'rerun the funnel and persist a new investigation against the current definition',
    );
  }

  const funnelSnapshot = {
    id: funnel.id,
    key: funnel.key,
    name: funnel.name,
    goal: funnel.goal,
    steps: funnel.steps,
    window_seconds: funnel.window_seconds,
  };
  const exactQuery = {
    ...normalizedQuery,
    date_from: result.meta.date_range?.from ?? normalizedQuery.date_from,
    date_to: result.meta.date_range?.to ?? normalizedQuery.date_to,
  };
  const queryResult = result as unknown as Record<string, unknown>;
  const evidence = result.evidence as unknown as Record<string, unknown>;
  const queryFingerprint = stableHash(exactQuery);
  const resultFingerprint = stableHash({ query_result: queryResult, evidence });

  const inserted = await pool.query(
    `INSERT INTO funnel_investigations (
       project_id, env, funnel_id, funnel_key, from_step, to_step,
       funnel_snapshot, query_spec, query_result, evidence,
       query_fingerprint, result_fingerprint, idempotency_key, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (project_id, idempotency_key) DO NOTHING
     RETURNING *`,
    [
      projectId,
      input.env,
      funnel.id,
      funnel.key,
      input.from_step,
      input.to_step,
      JSON.stringify(funnelSnapshot),
      JSON.stringify(exactQuery),
      JSON.stringify(queryResult),
      JSON.stringify(evidence),
      queryFingerprint,
      resultFingerprint,
      input.idempotency_key,
      actor,
    ],
  );
  if (inserted.rows[0]) {
    return { investigation: rowToInvestigation(inserted.rows[0]), idempotent: false };
  }
  const raced = await findByIdempotencyKey(pool, projectId, input.idempotency_key);
  if (!raced) throw new ApiError(409, 'funnel_investigation_conflict', 'the investigation could not be persisted');
  assertSameRequest(raced, exactQuery, input);
  return { investigation: raced, idempotent: true };
}

export async function getFunnelInvestigation(
  pool: Queryable,
  projectId: string,
  id: string,
): Promise<FunnelInvestigation> {
  const result = await pool.query(
    'SELECT * FROM funnel_investigations WHERE project_id = $1 AND id = $2',
    [projectId, id],
  );
  if (!result.rows[0]) throw notFound('funnel investigation');
  return rowToInvestigation(result.rows[0]);
}

export async function listFunnelInvestigations(
  pool: Queryable,
  projectId: string,
  filter: FunnelInvestigationListFilter = {},
): Promise<FunnelInvestigation[]> {
  const params: unknown[] = [projectId];
  const conditions = ['project_id = $1'];
  if (filter.env) {
    params.push(filter.env);
    conditions.push(`env = $${params.length}`);
  }
  if (filter.funnel) {
    params.push(filter.funnel);
    conditions.push(`funnel_key = $${params.length}`);
  }
  params.push(Math.min(Math.max(filter.limit ?? 50, 1), 100));
  const result = await pool.query(
    `SELECT * FROM funnel_investigations
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToInvestigation);
}

async function findByIdempotencyKey(
  pool: Queryable,
  projectId: string,
  idempotencyKey: string,
): Promise<FunnelInvestigation | null> {
  const result = await pool.query(
    'SELECT * FROM funnel_investigations WHERE project_id = $1 AND idempotency_key = $2',
    [projectId, idempotencyKey],
  );
  return result.rows[0] ? rowToInvestigation(result.rows[0]) : null;
}

function assertSameRequest(
  existing: FunnelInvestigation,
  query: { funnel: string; env: string; date_from: string; date_to: string },
  input: FunnelInvestigationCreateInput,
): void {
  if (existing.saved_funnel.key === query.funnel
    && existing.env === query.env
    && existing.query_spec.date_from === query.date_from
    && existing.query_spec.date_to === query.date_to
    && existing.transition.from_step === input.from_step
    && existing.transition.to_step === input.to_step) return;
  throw new ApiError(
    409,
    'idempotency_key_reused',
    'this idempotency key already identifies a different funnel investigation',
    'reuse it only for the exact same request or generate a new key',
  );
}

function rowToInvestigation(row: Record<string, any>): FunnelInvestigation {
  const snapshot = row.funnel_snapshot as FunnelInvestigation['saved_funnel'];
  const from = snapshot.steps[row.from_step];
  const to = snapshot.steps[row.to_step];
  return {
    id: row.id,
    env: row.env,
    saved_funnel: snapshot,
    transition: {
      from_step: row.from_step,
      to_step: row.to_step,
      from_metric: from?.metric_key ?? 'unavailable',
      to_metric: to?.metric_key ?? 'unavailable',
      from_label: from?.label ?? 'Unavailable step',
      to_label: to?.label ?? 'Unavailable step',
    },
    query_spec: row.query_spec,
    query_result: row.query_result,
    evidence: row.evidence,
    lineage: {
      query_fingerprint: row.query_fingerprint,
      result_fingerprint: row.result_fingerprint,
    },
    idempotency_key: row.idempotency_key,
    created_by: row.created_by,
    created_at: new Date(row.created_at).toISOString(),
  };
}
