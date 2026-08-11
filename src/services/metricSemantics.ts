import { createHash } from 'node:crypto';
import type pg from 'pg';

export type SemanticMetricType = 'count' | 'unique_actors' | 'value' | 'conversion' | 'state';

export interface SemanticMetricLike {
  id: string;
  key: string;
  purpose: string;
  type: SemanticMetricType;
  source: Record<string, unknown>;
  owner?: string | null;
}

export interface MetricSemanticDefinition {
  key: string;
  purpose: string;
  type: SemanticMetricType;
  aggregation: string;
  source: Record<string, unknown>;
}

export interface MetricDefinitionRevision {
  id: string;
  revision: number;
  action: 'created' | 'updated' | 'legacy_update';
  fingerprint: string;
  aggregation: string;
  definition: MetricSemanticDefinition;
  actor: string;
  created_at: string;
}

export function metricAggregation(
  type: SemanticMetricType,
  source: Record<string, unknown>,
): string {
  if (type === 'count') return 'count';
  if (type === 'unique_actors') return 'unique_actors';
  if (type === 'value') return `value:${String(source.agg ?? 'sum')}`;
  if (type === 'conversion') return `conversion:${String(source.window_seconds ?? 3600)}`;
  return `state:${String(source.agg ?? 'count')}`;
}

export function metricSemanticDefinition(metric: SemanticMetricLike): MetricSemanticDefinition {
  return {
    key: metric.key,
    purpose: metric.purpose.trim(),
    type: metric.type,
    aggregation: metricAggregation(metric.type, metric.source),
    source: canonicalize(metric.source) as Record<string, unknown>,
  };
}

export function metricSemanticFingerprint(definition: MetricSemanticDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(definition)))
    .digest('hex');
}

export async function ensureMetricDefinitionRevision(
  db: pg.PoolClient,
  projectId: string,
  metric: SemanticMetricLike,
  actor = metric.owner ?? 'compatibility:existing_metric',
): Promise<MetricDefinitionRevision> {
  const latest = await latestMetricDefinitionRevision(db, projectId, metric.key);
  const definition = metricSemanticDefinition(metric);
  const fingerprint = metricSemanticFingerprint(definition);
  if (latest && latest.metricId === metric.id && latest.revision.fingerprint === fingerprint) {
    return latest.revision;
  }
  const sameMetric = latest?.metricId === metric.id;
  return appendMetricDefinitionRevision(
    db,
    projectId,
    metric,
    latest ? latest.revision.revision + 1 : 1,
    sameMetric ? 'legacy_update' : 'created',
    definition,
    fingerprint,
    sameMetric ? 'compatibility:detected_semantic_update' : actor,
  );
}

export async function nextMetricDefinitionRevision(
  db: pg.PoolClient,
  projectId: string,
  metricKey: string,
): Promise<number> {
  const { rows } = await db.query(
    `SELECT COALESCE(max(revision), 0)::int + 1 AS revision
     FROM metric_definition_revisions
     WHERE project_id = $1 AND metric_key = $2`,
    [projectId, metricKey],
  );
  return Number(rows[0]!.revision);
}

export async function appendMetricDefinitionRevision(
  db: pg.PoolClient,
  projectId: string,
  metric: SemanticMetricLike,
  revision: number,
  action: MetricDefinitionRevision['action'],
  definition: MetricSemanticDefinition,
  fingerprint: string,
  actor: string,
): Promise<MetricDefinitionRevision> {
  const { rows } = await db.query(
    `INSERT INTO metric_definition_revisions (
       project_id, metric_id, metric_key, revision, action,
       semantic_fingerprint, aggregation, snapshot, actor
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, revision, action, semantic_fingerprint, aggregation,
       snapshot, actor, created_at`,
    [
      projectId,
      metric.id,
      metric.key,
      revision,
      action,
      fingerprint,
      definition.aggregation,
      JSON.stringify(definition),
      actor.slice(0, 200),
    ],
  );
  return rowToRevision(rows[0]!);
}

export async function listMetricDefinitionRevisions(
  db: pg.PoolClient,
  projectId: string,
  metricKey: string,
): Promise<MetricDefinitionRevision[]> {
  const { rows } = await db.query(
    `SELECT id, revision, action, semantic_fingerprint, aggregation,
       snapshot, actor, created_at
     FROM metric_definition_revisions
     WHERE project_id = $1 AND metric_key = $2
     ORDER BY revision`,
    [projectId, metricKey],
  );
  return rows.map(rowToRevision);
}

async function latestMetricDefinitionRevision(
  db: pg.PoolClient,
  projectId: string,
  metricKey: string,
): Promise<{ revision: MetricDefinitionRevision; metricId: string } | null> {
  const { rows } = await db.query(
    `SELECT id, metric_id, revision, action, semantic_fingerprint, aggregation,
       snapshot, actor, created_at
     FROM metric_definition_revisions
     WHERE project_id = $1 AND metric_key = $2
     ORDER BY revision DESC LIMIT 1`,
    [projectId, metricKey],
  );
  return rows[0]
    ? { revision: rowToRevision(rows[0]), metricId: String(rows[0].metric_id) }
    : null;
}

function rowToRevision(row: Record<string, unknown>): MetricDefinitionRevision {
  return {
    id: String(row.id),
    revision: Number(row.revision),
    action: row.action as MetricDefinitionRevision['action'],
    fingerprint: String(row.semantic_fingerprint),
    aggregation: String(row.aggregation),
    definition: row.snapshot as MetricSemanticDefinition,
    actor: String(row.actor),
    created_at: toIso(row.created_at as Date | string),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
