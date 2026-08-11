import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { ApiError, badRequest, notFound } from '../errors.js';

type Queryable = pg.Pool | pg.PoolClient;

const envSchema = z.string().trim().min(1).max(100);
const keySchema = z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/);
const timestampSchema = z.string().datetime({ offset: true });
const semanticLine = (maximum = 1000) => z.string().trim().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value), 'text must be one printable line');

const storedFilterSchema = z.object({
  property: z.string().trim().min(1).max(200),
  op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'is_set', 'is_not_set']),
  value: z.union([
    z.string().max(500),
    z.number().finite(),
    z.boolean(),
    z.array(z.union([z.string().max(500), z.number().finite()])).max(100),
  ]).optional(),
}).strict().superRefine((filter, ctx) => {
  const unary = filter.op === 'is_set' || filter.op === 'is_not_set';
  if (unary !== (filter.value === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: unary
      ? 'unary filters cannot contain a value'
      : 'filter value is required' });
  }
});

const queryBase = {
  date_from: timestampSchema,
  date_to: timestampSchema,
  env: envSchema,
};

const storedTrendQuerySchema = z.object({
  kind: z.literal('trend'),
  metric: keySchema,
  ...queryBase,
  interval: z.enum(['hour', 'day', 'week', 'month']),
  filters: z.array(storedFilterSchema).max(20),
  breakdown: z.object({ property: z.string().trim().min(1).max(200) }).strict().optional(),
}).strict();

const storedFunnelQuerySchema = z.object({
  kind: z.literal('funnel'),
  funnel: keySchema.optional(),
  steps: z.array(z.object({ metric: keySchema }).strict()).min(2).max(20).optional(),
  ...queryBase,
}).strict().superRefine((query, ctx) => {
  if ((query.funnel === undefined) === (query.steps === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'funnel query requires exactly one of funnel or steps' });
  }
});

const storedRetentionQuerySchema = z.object({
  kind: z.literal('retention'),
  start_metric: keySchema,
  return_metric: keySchema.optional(),
  ...queryBase,
  interval: z.enum(['day', 'week', 'month']),
  periods: z.number().int().min(2).max(31),
}).strict();

const storedLifecycleQuerySchema = z.object({
  kind: z.literal('lifecycle'),
  metric: keySchema,
  ...queryBase,
  interval: z.enum(['day', 'week', 'month']),
}).strict();

const storedStickinessQuerySchema = z.object({
  kind: z.literal('stickiness'),
  metric: keySchema,
  ...queryBase,
  interval: z.enum(['day', 'week', 'month']),
}).strict();

export const storedAnalysisQuerySchema = z.union([
  storedTrendQuerySchema,
  storedFunnelQuerySchema,
  storedRetentionQuerySchema,
  storedLifecycleQuerySchema,
  storedStickinessQuerySchema,
]);

export type StoredAnalysisQuery = z.infer<typeof storedAnalysisQuerySchema>;

const storedActorsQuerySchema = z.object({
  kind: z.literal('actors'),
  env: envSchema,
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  order: z.enum(['last_seen_desc', 'first_seen_desc', 'events_desc']).optional(),
  propertyFilters: z.array(storedFilterSchema).max(20).optional(),
  activityMetric: keySchema.optional(),
}).strict();

const visualizationActionSchema = z.union([
  z.object({ kind: z.literal('open_metric'), key: keySchema }).strict(),
  z.object({ kind: z.literal('open_funnel'), key: keySchema }).strict(),
  z.object({ kind: z.literal('open_query'), query: storedAnalysisQuerySchema }).strict(),
  z.object({ kind: z.literal('see_actors'), actorQuery: storedActorsQuerySchema }).strict(),
  z.object({
    kind: z.literal('compare_segment'),
    allowedProperties: z.array(z.string().trim().min(1).max(200)).max(20),
  }).strict(),
  z.object({ kind: z.literal('annotate_release'), releaseId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('open_decision'), decisionId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('save_view') }).strict(),
]);

const visualizationSourceSchema = z.union([
  z.object({ kind: z.literal('metric'), key: keySchema, query: storedAnalysisQuerySchema }).strict(),
  z.object({ kind: z.literal('funnel'), key: keySchema, query: storedAnalysisQuerySchema }).strict(),
  z.object({ kind: z.literal('release'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('experiment'), key: keySchema }).strict(),
  z.object({ kind: z.literal('trust_report'), key: keySchema }).strict(),
]);

export const visualizationSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().min(1).max(200),
  kind: z.enum([
    'metric_value', 'trend', 'breakdown', 'funnel', 'retention_matrix', 'retention_curve',
    'stickiness', 'lifecycle', 'release_impact', 'experiment_result', 'trust_summary', 'actor_timeline',
  ]),
  title: semanticLine(200),
  question: semanticLine(500),
  purpose: semanticLine(),
  project: z.string().trim().min(1).max(200),
  env: envSchema,
  range: z.object({ from: timestampSchema, to: timestampSchema, timezone: z.literal('UTC') }).strict(),
  source: visualizationSourceSchema,
  trust: z.object({
    status: z.enum(['trusted', 'partial', 'blocked', 'unavailable']),
    reason: semanticLine(),
    blockers: z.array(z.object({
      code: keySchema,
      message: semanticLine(),
      nextAction: semanticLine().optional(),
    }).strict()).max(50),
  }).strict(),
  evidence: z.object({
    aggregation: semanticLine(200),
    denominator: z.string().trim().max(200).nullable(),
    sampleSize: z.number().int().nonnegative().nullable(),
    coverage: semanticLine(200),
    source: z.enum(['native', 'posthog', 'registry', 'release', 'experiment']),
    computedAt: timestampSchema,
    comparisonBasis: semanticLine(200),
  }).strict(),
  display: z.object({
    valueFormat: z.enum(['number', 'percent', 'duration', 'currency']).optional(),
    granularity: z.enum(['hour', 'day', 'week', 'month']).optional(),
    compare: z.enum(['previous_period', 'none']).optional(),
    series: z.array(z.object({
      key: z.string().trim().min(1).max(100),
      label: z.string().trim().min(1).max(200),
      colorToken: z.enum(['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5']),
    }).strict()).max(20),
  }).strict(),
  actions: z.array(visualizationActionSchema).max(20),
}).strict().superRefine((spec, ctx) => {
  if (Date.parse(spec.range.from) > Date.parse(spec.range.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['range'], message: 'range must be ordered' });
  }
  if (spec.source.kind === 'metric' || spec.source.kind === 'funnel') {
    const query = spec.source.query;
    if (query.env !== spec.env || query.date_from !== spec.range.from || query.date_to !== spec.range.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'query'], message: 'query scope must match the view' });
    }
    if (spec.source.kind === 'metric' && query.kind === 'funnel') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'metric source cannot execute a funnel query' });
    }
    if (spec.source.kind === 'funnel' && query.kind !== 'funnel') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source'], message: 'funnel source requires a funnel query' });
    }
    if (spec.source.kind === 'metric' && metricKeyForQuery(query) !== spec.source.key) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'key'], message: 'source key must match query metric' });
    }
    if (spec.source.kind === 'funnel' && query.kind === 'funnel' && query.funnel !== spec.source.key) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'key'], message: 'source key must match query funnel' });
    }
    for (const [index, action] of spec.actions.entries()) {
      if (action.kind === 'open_query'
        && canonicalJson(action.query) !== canonicalJson(query)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actions', index], message: 'open_query must reproduce the source query' });
      }
    }
  }
  for (const [index, action] of spec.actions.entries()) {
    if (action.kind === 'open_query') {
      if (action.query.env !== spec.env
        || action.query.date_from !== spec.range.from
        || action.query.date_to !== spec.range.to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', index, 'query'],
          message: 'action query scope must match the saved view',
        });
      }
    }
    if (action.kind === 'see_actors' && action.actorQuery.env !== spec.env) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actions', index, 'actorQuery', 'env'],
        message: 'actor action environment must match the saved view',
      });
    }
  }
});

const answerStateSchema = z.enum(['ready', 'partial', 'empty', 'unavailable', 'not_configured', 'stale', 'error']);

export const answerSnapshotSchema = z.object({
  state: answerStateSchema,
  headline: semanticLine(300),
  takeaway: semanticLine(),
  primary_value: z.object({
    value: z.union([z.number().finite(), z.string().max(300), z.null()]),
    unit: z.enum(['count', 'percent', 'percentage_point', 'duration_ms', 'date', 'text']),
    formatted: z.string().trim().max(300),
  }).strict().optional(),
  delta: z.object({
    value: z.number().finite().nullable(),
    unit: z.enum(['count', 'percent', 'percentage_point']),
    direction: z.enum(['up', 'down', 'flat', 'unknown']),
    comparison_label: semanticLine(300),
  }).strict().optional(),
  why_it_matters: semanticLine(),
}).strict();

const evidenceSourceRefSchema = z.union([
  z.object({ kind: z.literal('metric'), key: keySchema, purpose: semanticLine() }).strict(),
  z.object({ kind: z.literal('funnel'), key: keySchema, goal: semanticLine() }).strict(),
  z.object({ kind: z.literal('release'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('experiment'), key: keySchema }).strict(),
  z.object({ kind: z.literal('usage_ledger'), meter: z.literal('events_stored') }).strict(),
  z.object({ kind: z.literal('operator_rule'), rule_id: keySchema, rule_version: z.number().int().positive() }).strict(),
]);

export const evidenceSnapshotSchema = z.object({
  state: z.enum(['trusted', 'partial', 'blocked', 'unavailable']),
  as_of: timestampSchema,
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  source_refs: z.array(evidenceSourceRefSchema).max(50),
  aggregation: semanticLine(300).optional(),
  denominator: z.object({ label: semanticLine(300), value: z.number().finite().nullable() }).strict().optional(),
  sample: z.object({
    eligible: z.number().int().nonnegative().nullable(),
    observed: z.number().int().nonnegative().nullable(),
    coverage: z.number().finite().min(0).max(1).nullable(),
  }).strict().optional(),
  warnings: z.array(z.object({
    code: keySchema,
    message: semanticLine(),
    remediation_action_id: keySchema.optional(),
  }).strict()).max(50),
  unavailable_reasons: z.array(z.object({
    code: keySchema,
    message: semanticLine(),
    prerequisite_action_id: keySchema.optional(),
  }).strict()).max(50),
  reproducible_query: storedAnalysisQuerySchema.optional(),
}).strict();

export const analysisViewCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  template_key: keySchema.nullable().optional(),
  schema_version: z.literal(1),
  visualization_spec: visualizationSpecSchema,
  answer: answerSnapshotSchema,
  evidence: evidenceSnapshotSchema,
}).strict();

export const analysisViewUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  template_key: keySchema.nullable().optional(),
  schema_version: z.literal(1).optional(),
  visualization_spec: visualizationSpecSchema.optional(),
  answer: answerSnapshotSchema.optional(),
  evidence: evidenceSnapshotSchema.optional(),
}).strict().superRefine((patch, ctx) => {
  if (Object.keys(patch).length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one field is required' });
  }
  const snapshots = [patch.visualization_spec, patch.answer, patch.evidence];
  if (snapshots.some((value) => value !== undefined) && !snapshots.every((value) => value !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'visualization_spec, answer and evidence must be updated together',
    });
  }
});

export const analysisViewOfficialSchema = z.object({ official: z.boolean() }).strict();

export type AnalysisViewCreateInput = z.infer<typeof analysisViewCreateSchema>;
export type AnalysisViewUpdateInput = z.infer<typeof analysisViewUpdateSchema>;

export interface AnalysisViewCredential {
  kind: 'secret' | 'personal' | 'user';
  role: 'owner' | 'admin' | null;
  canSetOfficial: boolean;
}

export interface AnalysisView {
  id: string;
  project: string;
  env: string;
  title: string;
  description: string | null;
  template_key: string | null;
  schema_version: 1;
  visualization_spec: z.infer<typeof visualizationSpecSchema>;
  answer: z.infer<typeof answerSnapshotSchema>;
  evidence: z.infer<typeof evidenceSnapshotSchema>;
  status: 'active' | 'archived';
  official: boolean;
  created_by: { kind: AnalysisViewCredential['kind']; role: AnalysisViewCredential['role'] };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface AnalysisViewRow {
  id: string;
  env: string;
  title: string;
  description: string | null;
  template_key: string | null;
  schema_version: number;
  visualization_spec: unknown;
  answer_snapshot: unknown;
  evidence_snapshot: unknown;
  spec_fingerprint: string;
  status: 'active' | 'archived';
  official: boolean;
  created_by_kind: AnalysisViewCredential['kind'];
  created_by_role: AnalysisViewCredential['role'];
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
}

interface ProjectScope { id: string; slug: string }

const VIEW_COLUMNS = `id, env, title, description, template_key, schema_version,
  visualization_spec, answer_snapshot, evidence_snapshot, spec_fingerprint,
  status, official, created_by_kind, created_by_role, created_at, updated_at, archived_at`;

export async function createAnalysisView(
  pool: pg.Pool,
  project: ProjectScope,
  raw: unknown,
  credential: AnalysisViewCredential,
): Promise<AnalysisView> {
  const input = analysisViewCreateSchema.parse(raw);
  assertViewScope(project.slug, input.visualization_spec.env, input.visualization_spec);
  assertSnapshotConsistency(input.visualization_spec, input.answer, input.evidence);
  assertPrivacyBoundary(input);
  await assertCurrentReferences(pool, project.id, input.visualization_spec);
  const fingerprint = viewFingerprint(input.visualization_spec, input.answer, input.evidence);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<AnalysisViewRow>(
      `INSERT INTO analysis_views (
         project_id, env, title, description, template_key, schema_version,
         visualization_spec, answer_snapshot, evidence_snapshot, spec_fingerprint,
         created_by_kind, created_by_role
       ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11)
       RETURNING ${VIEW_COLUMNS}`,
      [
        project.id,
        input.visualization_spec.env,
        input.title,
        input.description ?? null,
        input.template_key ?? null,
        JSON.stringify(input.visualization_spec),
        JSON.stringify(input.answer),
        JSON.stringify(input.evidence),
        fingerprint,
        credential.kind,
        credential.role,
      ],
    );
    const row = inserted.rows[0]!;
    await appendAudit(client, project.id, row, credential, 'created', null, null);
    await client.query('COMMIT');
    return parseRow(project.slug, row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listAnalysisViews(
  pool: pg.Pool,
  project: ProjectScope,
  filter: { env: string; status?: 'active' | 'archived'; official?: boolean },
): Promise<AnalysisView[]> {
  const params: unknown[] = [project.id, envSchema.parse(filter.env)];
  let sql = `SELECT ${VIEW_COLUMNS} FROM analysis_views WHERE project_id = $1 AND env = $2`;
  if (filter.status) {
    params.push(filter.status);
    sql += ` AND status = $${params.length}`;
  }
  if (filter.official !== undefined) {
    params.push(filter.official);
    sql += ` AND official = $${params.length}`;
  }
  const rows = await pool.query<AnalysisViewRow>(`${sql} ORDER BY official DESC, updated_at DESC, id DESC`, params);
  return rows.rows.map((row) => parseRow(project.slug, row));
}

export async function getAnalysisView(
  pool: pg.Pool,
  project: ProjectScope,
  id: string,
): Promise<{ view: AnalysisView; audit: AnalysisViewAudit[] }> {
  const viewId = z.string().uuid().parse(id);
  const row = await selectView(pool, project.id, viewId);
  const audit = await pool.query<AnalysisViewAuditRow>(
    `SELECT id, action, performed_by_kind, performed_by_role, schema_version,
            spec_fingerprint, previous_status, next_status,
            previous_official, next_official, created_at
     FROM analysis_view_audit
     WHERE project_id = $1 AND analysis_view_id = $2
     ORDER BY created_at, id`,
    [project.id, viewId],
  );
  return { view: parseRow(project.slug, row), audit: audit.rows.map(parseAudit) };
}

export async function updateAnalysisView(
  pool: pg.Pool,
  project: ProjectScope,
  id: string,
  raw: unknown,
  credential: AnalysisViewCredential,
): Promise<AnalysisView> {
  const viewId = z.string().uuid().parse(id);
  const patch = analysisViewUpdateSchema.parse(raw);
  assertPrivacyBoundary(patch);
  if (patch.visualization_spec && patch.answer && patch.evidence) {
    assertViewScope(project.slug, patch.visualization_spec.env, patch.visualization_spec);
    await assertCurrentReferences(pool, project.id, patch.visualization_spec);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await selectView(client, project.id, viewId, true);
    if (current.status !== 'active') {
      throw new ApiError(409, 'analysis_view_archived', 'archived saved answers cannot be edited');
    }
    const spec = patch.visualization_spec ?? visualizationSpecSchema.parse(current.visualization_spec);
    const answer = patch.answer ?? answerSnapshotSchema.parse(current.answer_snapshot);
    const evidence = patch.evidence ?? evidenceSnapshotSchema.parse(current.evidence_snapshot);
    assertSnapshotConsistency(spec, answer, evidence);
    if (patch.schema_version !== undefined && patch.schema_version !== current.schema_version) {
      throw badRequest('analysis_view_schema_mismatch', 'schema_version must match the stored answer');
    }
    if (spec.env !== current.env) {
      throw badRequest('analysis_view_scope_mismatch', 'a saved answer cannot move between environments');
    }
    const fingerprint = viewFingerprint(spec, answer, evidence);
    const updated = await client.query<AnalysisViewRow>(
      `UPDATE analysis_views SET
         title = COALESCE($3, title),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         template_key = CASE WHEN $6::boolean THEN $7 ELSE template_key END,
         visualization_spec = $8,
         answer_snapshot = $9,
         evidence_snapshot = $10,
         spec_fingerprint = $11,
         updated_at = now()
       WHERE project_id = $1 AND id = $2
       RETURNING ${VIEW_COLUMNS}`,
      [
        project.id,
        viewId,
        patch.title ?? null,
        patch.description !== undefined,
        patch.description ?? null,
        patch.template_key !== undefined,
        patch.template_key ?? null,
        JSON.stringify(spec),
        JSON.stringify(answer),
        JSON.stringify(evidence),
        fingerprint,
      ],
    );
    const row = updated.rows[0]!;
    await appendAudit(client, project.id, row, credential, 'updated', current.status, current.official);
    await client.query('COMMIT');
    return parseRow(project.slug, row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function archiveAnalysisView(
  pool: pg.Pool,
  project: ProjectScope,
  id: string,
  credential: AnalysisViewCredential,
): Promise<AnalysisView> {
  const viewId = z.string().uuid().parse(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await selectView(client, project.id, viewId, true);
    if (current.status === 'archived') {
      await client.query('COMMIT');
      return parseRow(project.slug, current);
    }
    const updated = await client.query<AnalysisViewRow>(
      `UPDATE analysis_views SET
         status = 'archived', official = false, archived_at = now(), updated_at = now()
       WHERE project_id = $1 AND id = $2
       RETURNING ${VIEW_COLUMNS}`,
      [project.id, viewId],
    );
    const row = updated.rows[0]!;
    await appendAudit(client, project.id, row, credential, 'archived', current.status, current.official);
    await client.query('COMMIT');
    return parseRow(project.slug, row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function setAnalysisViewOfficial(
  pool: pg.Pool,
  project: ProjectScope,
  id: string,
  official: boolean,
  credential: AnalysisViewCredential,
): Promise<AnalysisView> {
  if (!credential.canSetOfficial) {
    throw new ApiError(
      403,
      'official_answer_role_required',
      'only a workspace owner or admin can change official answer status',
      'ask an owner or admin to review this saved answer',
    );
  }
  const viewId = z.string().uuid().parse(id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await selectView(client, project.id, viewId, true);
    if (official && current.status !== 'active') {
      throw new ApiError(409, 'analysis_view_archived', 'an archived saved answer cannot be official');
    }
    if (official) {
      assertSnapshotConsistency(
        visualizationSpecSchema.parse(current.visualization_spec),
        answerSnapshotSchema.parse(current.answer_snapshot),
        evidenceSnapshotSchema.parse(current.evidence_snapshot),
      );
    }
    if (current.official === official) {
      await client.query('COMMIT');
      return parseRow(project.slug, current);
    }
    const updated = await client.query<AnalysisViewRow>(
      `UPDATE analysis_views SET official = $3, updated_at = now()
       WHERE project_id = $1 AND id = $2
       RETURNING ${VIEW_COLUMNS}`,
      [project.id, viewId, official],
    );
    const row = updated.rows[0]!;
    await appendAudit(client, project.id, row, credential, 'official_changed', current.status, current.official);
    await client.query('COMMIT');
    return parseRow(project.slug, row);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function analysisViewMetricKeys(view: AnalysisView): string[] {
  const source = view.visualization_spec.source;
  const keys = new Set<string>();
  if (source.kind === 'metric' || source.kind === 'funnel') {
    metricKeysForQuery(source.query).forEach((key) => keys.add(key));
  }
  if (source.kind === 'trust_report') keys.add(source.key);
  for (const action of view.visualization_spec.actions) {
    if (action.kind === 'open_metric') keys.add(action.key);
    if (action.kind === 'open_query') metricKeysForQuery(action.query).forEach((key) => keys.add(key));
    if (action.kind === 'see_actors' && action.actorQuery.activityMetric) keys.add(action.actorQuery.activityMetric);
  }
  return [...keys].sort();
}

export function analysisViewPropertyKeys(view: AnalysisView): string[] {
  const source = view.visualization_spec.source;
  const keys = new Set<string>();
  if (source.kind === 'metric' || source.kind === 'funnel') {
    const query = source.query;
    if (query.kind === 'trend') {
      query.filters.forEach((filter) => keys.add(filter.property));
      if (query.breakdown) keys.add(query.breakdown.property);
    }
  }
  for (const action of view.visualization_spec.actions) {
    if (action.kind === 'compare_segment') action.allowedProperties.forEach((key) => keys.add(key));
    if (action.kind === 'open_query') addQueryPropertyKeys(action.query, keys);
    if (action.kind === 'see_actors') action.actorQuery.propertyFilters?.forEach((filter) => keys.add(filter.property));
  }
  return [...keys].sort();
}

async function assertCurrentReferences(
  pool: Queryable,
  projectId: string,
  spec: z.infer<typeof visualizationSpecSchema>,
): Promise<void> {
  const metricKeys = new Set<string>();
  const source = spec.source;
  if (source.kind === 'metric' || source.kind === 'funnel') {
    for (const key of metricKeysForQuery(source.query)) metricKeys.add(key);
    if (source.kind === 'funnel') {
      const funnel = await pool.query<{ steps: Array<{ metric_key?: string }> }>(
        'SELECT steps FROM funnels WHERE project_id = $1 AND key = $2',
        [projectId, source.key],
      );
      if (!funnel.rows[0]) throw notFound('funnel');
      for (const step of funnel.rows[0].steps) if (step.metric_key) metricKeys.add(step.metric_key);
    }
  } else if (source.kind === 'release') {
    if (!(await pool.query('SELECT 1 FROM releases WHERE project_id = $1 AND id = $2', [projectId, source.id])).rowCount) {
      throw notFound('release');
    }
  } else if (source.kind === 'experiment') {
    if (!(await pool.query('SELECT 1 FROM experiments WHERE project_id = $1 AND key = $2', [projectId, source.key])).rowCount) {
      throw notFound('experiment');
    }
  } else if (source.kind === 'trust_report') {
    metricKeys.add(source.key);
  }
  for (const action of spec.actions) {
    if (action.kind === 'open_metric') metricKeys.add(action.key);
    if (action.kind === 'open_query') {
      for (const key of metricKeysForQuery(action.query)) metricKeys.add(key);
      if (action.query.kind === 'funnel' && action.query.funnel) {
        await addFunnelMetricReferences(pool, projectId, action.query.funnel, metricKeys);
      }
    }
    if (action.kind === 'open_funnel') {
      await addFunnelMetricReferences(pool, projectId, action.key, metricKeys);
    }
    if (action.kind === 'see_actors' && action.actorQuery.activityMetric) {
      metricKeys.add(action.actorQuery.activityMetric);
    }
    if (action.kind === 'annotate_release'
      && !(await pool.query('SELECT 1 FROM releases WHERE project_id = $1 AND id = $2', [projectId, action.releaseId])).rowCount) {
      throw badRequest('analysis_view_release_unavailable', 'saved answer action references a missing release');
    }
    if (action.kind === 'open_decision'
      && !(await pool.query('SELECT 1 FROM decisions WHERE project_id = $1 AND id = $2', [projectId, action.decisionId])).rowCount) {
      throw badRequest('analysis_view_decision_unavailable', 'saved answer action references a missing decision');
    }
  }
  if (metricKeys.size > 0) {
    const metrics = await pool.query<{ key: string; status: string }>(
      'SELECT key, status FROM metrics WHERE project_id = $1 AND key = ANY($2::text[])',
      [projectId, [...metricKeys]],
    );
    const active = new Set(metrics.rows.filter((row) => row.status === 'active').map((row) => row.key));
    const unavailable = [...metricKeys].filter((key) => !active.has(key));
    if (unavailable.length > 0) {
      throw badRequest(
        'analysis_view_metric_unavailable',
        `saved answer references inactive or missing metrics: ${unavailable.join(', ')}`,
        'save only a registry-backed answer whose metric definitions are active',
      );
    }
  }
  const propertyKeys = propertyKeysForSpec(spec);
  if (propertyKeys.length > 0) {
    const properties = await pool.query<{ key: string; status: string }>(
      `SELECT key, status FROM property_definitions
       WHERE project_id = $1 AND scope = 'event' AND key = ANY($2::text[])`,
      [projectId, propertyKeys],
    );
    const trusted = new Set(properties.rows.filter((row) => row.status === 'trusted').map((row) => row.key));
    const unavailable = propertyKeys.filter((key) => !trusted.has(key));
    if (unavailable.length > 0) {
      throw badRequest(
        'analysis_view_property_unavailable',
        `saved answer references missing or untrusted properties: ${unavailable.join(', ')}`,
        'review the property meaning before saving this answer',
      );
    }
  }
}

function propertyKeysForSpec(spec: z.infer<typeof visualizationSpecSchema>): string[] {
  const keys = new Set<string>();
  const source = spec.source;
  if (source.kind === 'metric' || source.kind === 'funnel') addQueryPropertyKeys(source.query, keys);
  for (const action of spec.actions) {
    if (action.kind === 'open_query') addQueryPropertyKeys(action.query, keys);
    if (action.kind === 'compare_segment') action.allowedProperties.forEach((key) => keys.add(key));
    if (action.kind === 'see_actors') action.actorQuery.propertyFilters?.forEach((filter) => keys.add(filter.property));
  }
  return [...keys].sort();
}

function addQueryPropertyKeys(query: StoredAnalysisQuery, keys: Set<string>): void {
  if (query.kind !== 'trend') return;
  query.filters.forEach((filter) => keys.add(filter.property));
  if (query.breakdown) keys.add(query.breakdown.property);
}

async function addFunnelMetricReferences(
  pool: Queryable,
  projectId: string,
  funnelKey: string,
  metricKeys: Set<string>,
): Promise<void> {
  const funnel = await pool.query<{ steps: Array<{ metric_key?: string }> }>(
    'SELECT steps FROM funnels WHERE project_id = $1 AND key = $2',
    [projectId, funnelKey],
  );
  if (!funnel.rows[0]) {
    throw badRequest('analysis_view_funnel_unavailable', `saved answer references missing funnel: ${funnelKey}`);
  }
  for (const step of funnel.rows[0].steps) if (step.metric_key) metricKeys.add(step.metric_key);
}

function assertViewScope(
  projectSlug: string,
  expectedEnv: string,
  spec: z.infer<typeof visualizationSpecSchema>,
): void {
  if (spec.project !== projectSlug || spec.env !== expectedEnv) {
    throw badRequest(
      'analysis_view_scope_mismatch',
      'visualization project and environment must match the authenticated route scope',
    );
  }
}

function assertPrivacyBoundary(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 128 * 1024) {
    throw badRequest('analysis_view_too_large', 'saved answer content exceeds the 128 KiB limit');
  }
  const forbiddenKeys = new Set([
    'sql', 'raw_sql', 'prompt', 'raw_prompt', 'task', 'agent_task', 'token', 'credential',
    'actor_id', 'distinct_id', 'payload', 'event_payload', 'raw_properties', 'source_code', 'dom', 'url',
  ]);
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      if (/\b(?:pk|sk|pt)_[a-z0-9_-]{8,}\b/i.test(item)
        || /authorization\s*:\s*bearer/i.test(item)
        || /https?:\/\//i.test(item)
        || /```/.test(item)
        || /\b(?:select\s+.+\s+from|insert\s+into|update\s+\S+\s+set|delete\s+from|drop\s+table|alter\s+table|create\s+table)\b/i.test(item)) {
        throw badRequest('analysis_view_private_content', 'saved answer contains prohibited private material');
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (forbiddenKeys.has(key.toLowerCase())) {
        throw badRequest('analysis_view_private_content', `saved answer field "${key}" is prohibited`);
      }
      visit(child);
    }
  };
  visit(value);
}

async function selectView(
  pool: Queryable,
  projectId: string,
  id: string,
  forUpdate = false,
): Promise<AnalysisViewRow> {
  const result = await pool.query<AnalysisViewRow>(
    `SELECT ${VIEW_COLUMNS} FROM analysis_views
     WHERE project_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [projectId, id],
  );
  if (!result.rows[0]) throw notFound('analysis_view');
  return result.rows[0];
}

async function appendAudit(
  client: pg.PoolClient,
  projectId: string,
  row: AnalysisViewRow,
  credential: AnalysisViewCredential,
  action: 'created' | 'updated' | 'official_changed' | 'archived',
  previousStatus: AnalysisViewRow['status'] | null,
  previousOfficial: boolean | null,
): Promise<void> {
  await client.query(
    `INSERT INTO analysis_view_audit (
       analysis_view_id, project_id, env, action,
       performed_by_kind, performed_by_role, schema_version, spec_fingerprint,
       previous_status, next_status, previous_official, next_official
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11)`,
    [
      row.id,
      projectId,
      row.env,
      action,
      credential.kind,
      credential.role,
      row.spec_fingerprint,
      previousStatus,
      row.status,
      previousOfficial,
      row.official,
    ],
  );
}

function parseRow(projectSlug: string, row: AnalysisViewRow): AnalysisView {
  if (row.schema_version !== 1) {
    throw new ApiError(
      409,
      'analysis_view_schema_unsupported',
      `saved answer schema version ${row.schema_version} is not supported`,
      'upgrade Core before reading this saved answer',
    );
  }
  const visualization = visualizationSpecSchema.safeParse(row.visualization_spec);
  const answer = answerSnapshotSchema.safeParse(row.answer_snapshot);
  const evidence = evidenceSnapshotSchema.safeParse(row.evidence_snapshot);
  if (!visualization.success || !answer.success || !evidence.success
    || visualization.data.project !== projectSlug || visualization.data.env !== row.env
    || snapshotConsistencyIssue(visualization.data, answer.data, evidence.data)) {
    throw new ApiError(
      409,
      'analysis_view_schema_unsupported',
      'saved answer failed deterministic schema or scope validation',
      'inspect the migration and restore a validated v1 snapshot',
    );
  }
  assertPrivacyBoundary({
    visualization_spec: visualization.data,
    answer: answer.data,
    evidence: evidence.data,
  });
  const fingerprint = viewFingerprint(visualization.data, answer.data, evidence.data);
  if (fingerprint !== row.spec_fingerprint) {
    throw new ApiError(409, 'analysis_view_fingerprint_mismatch', 'saved answer fingerprint does not match its snapshots');
  }
  return {
    id: row.id,
    project: projectSlug,
    env: row.env,
    title: row.title,
    description: row.description,
    template_key: row.template_key,
    schema_version: 1,
    visualization_spec: visualization.data,
    answer: answer.data,
    evidence: evidence.data,
    status: row.status,
    official: row.official,
    created_by: { kind: row.created_by_kind, role: row.created_by_role },
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    archived_at: row.archived_at ? toIso(row.archived_at) : null,
  };
}

interface AnalysisViewAuditRow {
  id: string;
  action: 'created' | 'updated' | 'official_changed' | 'archived';
  performed_by_kind: AnalysisViewCredential['kind'];
  performed_by_role: AnalysisViewCredential['role'];
  schema_version: number;
  spec_fingerprint: string;
  previous_status: AnalysisViewRow['status'] | null;
  next_status: AnalysisViewRow['status'];
  previous_official: boolean | null;
  next_official: boolean;
  created_at: Date | string;
}

export interface AnalysisViewAudit {
  id: string;
  action: AnalysisViewAuditRow['action'];
  performed_by: { kind: AnalysisViewCredential['kind']; role: AnalysisViewCredential['role'] };
  schema_version: 1;
  spec_fingerprint: string;
  previous_status: AnalysisViewAuditRow['previous_status'];
  next_status: AnalysisViewAuditRow['next_status'];
  previous_official: boolean | null;
  next_official: boolean;
  created_at: string;
}

function parseAudit(row: AnalysisViewAuditRow): AnalysisViewAudit {
  if (row.schema_version !== 1) {
    throw new ApiError(409, 'analysis_view_schema_unsupported', 'saved answer audit schema is unsupported');
  }
  return {
    id: row.id,
    action: row.action,
    performed_by: { kind: row.performed_by_kind, role: row.performed_by_role },
    schema_version: 1,
    spec_fingerprint: row.spec_fingerprint,
    previous_status: row.previous_status,
    next_status: row.next_status,
    previous_official: row.previous_official,
    next_official: row.next_official,
    created_at: toIso(row.created_at),
  };
}

function metricKeyForQuery(query: StoredAnalysisQuery): string | null {
  if (query.kind === 'trend' || query.kind === 'lifecycle' || query.kind === 'stickiness') return query.metric;
  if (query.kind === 'retention') return query.start_metric;
  return null;
}

function metricKeysForQuery(query: StoredAnalysisQuery): string[] {
  if (query.kind === 'trend' || query.kind === 'lifecycle' || query.kind === 'stickiness') return [query.metric];
  if (query.kind === 'retention') return [...new Set([query.start_metric, query.return_metric ?? query.start_metric])];
  return query.steps?.map((step) => step.metric) ?? [];
}

function viewFingerprint(
  spec: z.infer<typeof visualizationSpecSchema>,
  answer: z.infer<typeof answerSnapshotSchema>,
  evidence: z.infer<typeof evidenceSnapshotSchema>,
): string {
  return createHash('sha256').update(canonicalJson({
    schema_version: 1,
    visualization_spec: spec,
    answer,
    evidence,
  })).digest('hex');
}

function assertSnapshotConsistency(
  spec: z.infer<typeof visualizationSpecSchema>,
  answer: z.infer<typeof answerSnapshotSchema>,
  evidence: z.infer<typeof evidenceSnapshotSchema>,
): void {
  const issue = snapshotConsistencyIssue(spec, answer, evidence);
  if (issue) throw badRequest('analysis_view_snapshot_mismatch', issue);
}

function snapshotConsistencyIssue(
  spec: z.infer<typeof visualizationSpecSchema>,
  answer: z.infer<typeof answerSnapshotSchema>,
  evidence: z.infer<typeof evidenceSnapshotSchema>,
): string | null {
  if (evidence.state !== spec.trust.status) {
    return 'evidence trust must match the visualization trust state';
  }
  if (evidence.as_of !== spec.evidence.computedAt) {
    return 'evidence as_of must match the visualization computation time';
  }
  if (answer.state === 'ready' && evidence.state !== 'trusted') {
    return 'ready answers require trusted evidence';
  }
  if (answer.state === 'partial' && evidence.state !== 'partial' && evidence.state !== 'blocked') {
    return 'partial answers require partial or blocked evidence';
  }
  if (answer.state === 'empty' && evidence.sample?.observed !== 0) {
    return 'empty answers require an observed sample of zero';
  }
  if ((answer.state === 'unavailable' || answer.state === 'not_configured' || answer.state === 'error')
    && evidence.state !== 'unavailable') {
    return `${answer.state} answers require unavailable evidence`;
  }
  if (answer.state === 'stale' && evidence.freshness !== 'stale') {
    return 'stale answers require stale evidence';
  }
  if ((spec.source.kind === 'metric' || spec.source.kind === 'funnel')
    && (!evidence.reproducible_query
      || canonicalJson(evidence.reproducible_query) !== canonicalJson(spec.source.query))) {
    return 'registry-backed answers require the exact reproducible source query';
  }
  return null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
