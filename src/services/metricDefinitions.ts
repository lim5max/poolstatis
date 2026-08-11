import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import { metricSourceSchemas, type MetricDefinitionInput } from '../schemas.js';
import {
  appendMetricDefinitionRevision,
  ensureMetricDefinitionRevision,
  listMetricDefinitionRevisions,
  metricSemanticDefinition,
  metricSemanticFingerprint,
  type MetricDefinitionRevision,
  type MetricSemanticDefinition,
} from './metricSemantics.js';
import { assertMetricSourceConnection, type Metric } from './registry.js';

export interface MetricDefinitionImpactReference {
  kind: 'answer' | 'funnel' | 'measurement_contract' | 'release' | 'experiment';
  ref: string;
  label: string;
  status: string | null;
}

export interface MetricDefinitionImpact {
  severity: 'low' | 'medium' | 'high';
  summary: {
    answers: number;
    funnels: number;
    measurement_contracts: number;
    releases: number;
    experiments: number;
  };
  references: MetricDefinitionImpactReference[];
  truncated: boolean;
}

export interface MetricDefinitionCurrent {
  revision: number;
  fingerprint: string;
  aggregation: string;
  definition: MetricSemanticDefinition;
}

export interface MetricDefinitionPreview {
  schema_version: 1;
  state: 'ready' | 'empty';
  metric: Pick<Metric, 'key' | 'name' | 'type' | 'status'>;
  expected_revision: number;
  current: MetricDefinitionCurrent;
  proposed: Omit<MetricDefinitionCurrent, 'revision'>;
  changed_fields: Array<'purpose' | 'source'>;
  impact: MetricDefinitionImpact;
  requires_confirmation: boolean;
  primary_action:
    | { id: 'apply_metric_definition'; kind: 'open_confirmation'; label: string; impact: string }
    | { id: 'return_to_registry'; kind: 'navigate'; label: string; href: '/registry' };
}

export async function getMetricDefinition(
  pool: pg.Pool,
  projectId: string,
  key: string,
): Promise<{
  schema_version: 1;
  metric: Pick<Metric, 'key' | 'name' | 'type' | 'status'>;
  current: MetricDefinitionCurrent;
  revisions: MetricDefinitionRevision[];
  impact: MetricDefinitionImpact;
  primary_action: { id: 'preview_metric_definition'; kind: 'navigate'; label: string; href: '/registry' };
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const metric = await lockedMetric(client, projectId, key);
    const current = await ensureMetricDefinitionRevision(client, projectId, metric);
    const revisions = await listMetricDefinitionRevisions(client, projectId, metric.key);
    const impact = await metricDefinitionImpact(client, projectId, metric.key);
    await client.query('COMMIT');
    return {
      schema_version: 1,
      metric: metricIdentity(metric),
      current: currentShape(current),
      revisions,
      impact,
      primary_action: {
        id: 'preview_metric_definition',
        kind: 'navigate',
        label: 'Review a semantic change',
        href: '/registry',
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function previewMetricDefinition(
  pool: pg.Pool,
  projectId: string,
  key: string,
  input: { expected_revision?: number | undefined; definition: MetricDefinitionInput },
): Promise<MetricDefinitionPreview> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const metric = await lockedMetric(client, projectId, key);
    const preview = await previewWithClient(client, projectId, metric, input);
    await client.query('COMMIT');
    return preview;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function applyMetricDefinition(
  pool: pg.Pool,
  projectId: string,
  key: string,
  input: {
    expected_revision: number;
    expected_fingerprint: string;
    confirm_impact: true;
    definition: MetricDefinitionInput;
  },
  actor: string,
): Promise<{
  applied: true;
  previous_revision: number;
  revision: number;
  current: MetricDefinitionCurrent;
  impact: MetricDefinitionImpact;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const metric = await lockedMetric(client, projectId, key);
    const preview = await previewWithClient(client, projectId, metric, {
      expected_revision: input.expected_revision,
      definition: input.definition,
    });
    if (preview.current.fingerprint !== input.expected_fingerprint) {
      throw revisionConflict();
    }
    if (preview.changed_fields.length === 0) {
      throw new ApiError(
        409,
        'metric_definition_no_change',
        'the proposed semantic definition is identical to the current revision',
        'return to the registry or preview a different purpose/source change',
      );
    }
    await client.query(
      `UPDATE metrics SET purpose = $3, source = $4, updated_at = now()
       WHERE project_id = $1 AND id = $2`,
      [projectId, metric.id, input.definition.purpose, JSON.stringify(preview.proposed.definition.source)],
    );
    const nextRevision = preview.current.revision + 1;
    const revision = await appendMetricDefinitionRevision(
      client,
      projectId,
      { ...metric, purpose: input.definition.purpose, source: preview.proposed.definition.source },
      nextRevision,
      'updated',
      preview.proposed.definition,
      preview.proposed.fingerprint,
      actor,
    );
    await client.query('COMMIT');
    return {
      applied: true,
      previous_revision: preview.current.revision,
      revision: nextRevision,
      current: currentShape(revision),
      impact: preview.impact,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function previewWithClient(
  client: pg.PoolClient,
  projectId: string,
  metric: Metric,
  input: { expected_revision?: number | undefined; definition: MetricDefinitionInput },
): Promise<MetricDefinitionPreview> {
  const currentRevision = await ensureMetricDefinitionRevision(client, projectId, metric);
  if (input.expected_revision !== undefined && input.expected_revision !== currentRevision.revision) {
    throw revisionConflict();
  }
  const parsedSource = metricSourceSchemas[metric.type].parse(input.definition.source) as Record<string, unknown>;
  await assertMetricSourceConnection(client, projectId, metric.type, parsedSource);
  const proposedDefinition = metricSemanticDefinition({
    ...metric,
    purpose: input.definition.purpose,
    source: parsedSource,
  });
  const proposedFingerprint = metricSemanticFingerprint(proposedDefinition);
  const changedFields: MetricDefinitionPreview['changed_fields'] = [];
  if (currentRevision.definition.purpose !== proposedDefinition.purpose) changedFields.push('purpose');
  const currentWithProposedPurpose = {
    ...currentRevision.definition,
    purpose: proposedDefinition.purpose,
  };
  if (metricSemanticFingerprint(currentWithProposedPurpose) !== proposedFingerprint) changedFields.push('source');
  const impact = await metricDefinitionImpact(client, projectId, metric.key);
  const changed = changedFields.length > 0;
  return {
    schema_version: 1,
    state: changed ? 'ready' : 'empty',
    metric: metricIdentity(metric),
    expected_revision: currentRevision.revision,
    current: currentShape(currentRevision),
    proposed: {
      fingerprint: proposedFingerprint,
      aggregation: proposedDefinition.aggregation,
      definition: proposedDefinition,
    },
    changed_fields: changedFields,
    impact,
    requires_confirmation: changed,
    primary_action: changed
      ? {
          id: 'apply_metric_definition',
          kind: 'open_confirmation',
          label: `Apply revision ${currentRevision.revision + 1}`,
          impact: impactMessage(impact),
        }
      : {
          id: 'return_to_registry',
          kind: 'navigate',
          label: 'Return to registry',
          href: '/registry',
        },
  };
}

async function lockedMetric(
  client: pg.PoolClient,
  projectId: string,
  key: string,
): Promise<Metric> {
  const { rows } = await client.query(
    `SELECT id, key, name, purpose, category, tags, type, source, status, owner,
       deprecation_reason, deprecated_at
     FROM metrics WHERE project_id = $1 AND key = $2 FOR UPDATE`,
    [projectId, key],
  );
  if (!rows[0]) throw notFound('metric', `no metric "${key}" in the registry`);
  return rows[0] as Metric;
}

async function metricDefinitionImpact(
  client: pg.PoolClient,
  projectId: string,
  key: string,
): Promise<MetricDefinitionImpact> {
  // Keep impact bounded: exact totals remain available while reference detail
  // is capped to protect both the response and the admin UI.
  const limit = 25;
  const answers = await client.query(
      `SELECT id::text AS ref, title AS label, status, count(*) OVER()::int AS total
       FROM insights
       WHERE project_id = $1
         AND jsonb_path_exists(
           query,
           '$.** ? (@ == $metric)',
           jsonb_build_object('metric', to_jsonb($2::text))
         )
       ORDER BY created_at DESC LIMIT $3`,
      [projectId, key, limit],
    );
  const funnels = await client.query(
      `SELECT key AS ref, name AS label, NULL::text AS status, count(*) OVER()::int AS total
       FROM funnels WHERE project_id = $1 AND steps @> $2::jsonb
       ORDER BY created_at DESC LIMIT $3`,
      [projectId, JSON.stringify([{ metric_key: key }]), limit],
    );
  const contracts = await client.query(
      `SELECT key AS ref, name AS label, status, count(*) OVER()::int AS total
       FROM measurement_contracts
       WHERE project_id = $1
         AND (primary_metric_key = $2 OR guardrail_metric_keys ? $2)
       ORDER BY updated_at DESC LIMIT $3`,
      [projectId, key, limit],
    );
  const releases = await client.query(
      `SELECT id::text AS ref, contract_key AS label, status,
         count(*) OVER()::int AS total,
         bool_or(status IN ('deployed', 'observing')) OVER() AS active_risk
       FROM releases
       WHERE project_id = $1
         AND (contract_snapshot->>'primary_metric_key' = $2
           OR contract_snapshot->'guardrail_metric_keys' ? $2)
       ORDER BY created_at DESC LIMIT $3`,
      [projectId, key, limit],
    );
  const experiments = await client.query(
      `SELECT key AS ref, name AS label, status,
         count(*) OVER()::int AS total,
         bool_or(status = 'running') OVER() AS active_risk
       FROM experiments
       WHERE project_id = $1
         AND (primary_metric_key = $2 OR $2 = ANY(secondary_metric_keys))
       ORDER BY created_at DESC LIMIT $3`,
      [projectId, key, limit],
    );
  const groups = [
    ['answer', answers.rows],
    ['funnel', funnels.rows],
    ['measurement_contract', contracts.rows],
    ['release', releases.rows],
    ['experiment', experiments.rows],
  ] as const;
  const totals = groups.map(([, rows]) => Number(rows[0]?.total ?? 0));
  const references = groups.flatMap(([kind, rows]) => rows.map((row) => ({
    kind,
    ref: String(row.ref),
    label: String(row.label),
    status: row.status === null ? null : String(row.status),
  }))).slice(0, limit) as MetricDefinitionImpactReference[];
  const activeRisk = releases.rows[0]?.active_risk === true
    || experiments.rows[0]?.active_risk === true;
  const total = totals.reduce((sum, value) => sum + value, 0);
  return {
    severity: activeRisk ? 'high' : total > 0 ? 'medium' : 'low',
    summary: {
      answers: totals[0]!,
      funnels: totals[1]!,
      measurement_contracts: totals[2]!,
      releases: totals[3]!,
      experiments: totals[4]!,
    },
    references,
    truncated: total > references.length,
  };
}

function metricIdentity(metric: Metric): Pick<Metric, 'key' | 'name' | 'type' | 'status'> {
  return { key: metric.key, name: metric.name, type: metric.type, status: metric.status };
}

function currentShape(revision: MetricDefinitionRevision): MetricDefinitionCurrent {
  return {
    revision: revision.revision,
    fingerprint: revision.fingerprint,
    aggregation: revision.aggregation,
    definition: revision.definition,
  };
}

function impactMessage(impact: MetricDefinitionImpact): string {
  const total = Object.values(impact.summary).reduce((sum, value) => sum + value, 0);
  return total === 0
    ? 'Creates one immutable semantic revision; no current dependency was found.'
    : `Creates one immutable semantic revision and affects ${total} registered dependencies.`;
}

function revisionConflict(): ApiError {
  return new ApiError(
    409,
    'metric_definition_revision_conflict',
    'the metric semantic definition changed after this preview was produced',
    'read or preview the definition again, then apply with the new revision and fingerprint',
  );
}
