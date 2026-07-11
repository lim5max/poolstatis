import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type { CreateExperimentInput, UpdateExperimentInput } from '../schemas.js';
import type { PropertyFilter } from '../schemas.js';
import type { EventStore, ExperimentVariantOutcome } from '../stores/eventStore.js';
import { getMetric, type Metric } from './registry.js';
import { getFeatureFlag, type FeatureFlag } from './flags.js';
import { summarizeExperimentVariants, type VariantExperimentStats } from './experimentStats.js';

type Db = pg.Pool | pg.PoolClient;

export interface Experiment {
  id: string;
  key: string;
  name: string;
  hypothesis: string;
  flag_key: string;
  primary_metric_key: string;
  secondary_metric_keys: string[];
  status: 'draft' | 'running' | 'concluded';
  started_at: string | Date | null;
  concluded_at: string | Date | null;
  decision: { outcome: 'ship' | 'iterate' | 'stop' | 'inconclusive'; rationale: string } | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ExperimentResults {
  key: string;
  status: Experiment['status'];
  primary_metric: Pick<Metric, 'key' | 'name' | 'purpose'>;
  started_at: string;
  concluded_at: string | null;
  variants: VariantExperimentStats[];
  secondary_metrics: ExperimentMetricResults[];
}

export interface ExperimentMetricResults {
  metric: Pick<Metric, 'key' | 'name' | 'purpose'>;
  variants: VariantExperimentStats[];
}

const EXPERIMENT_COLS = `id, key, name, hypothesis, flag_key, primary_metric_key,
  secondary_metric_keys, status, started_at, concluded_at, decision, created_at, updated_at`;

function mapExperiment(row: Experiment): Experiment {
  return {
    ...row,
    secondary_metric_keys: row.secondary_metric_keys ?? [],
    started_at: isoOrNull(row.started_at),
    concluded_at: isoOrNull(row.concluded_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export async function createExperiment(pool: pg.Pool, projectId: string, input: CreateExperimentInput): Promise<Experiment> {
  await getFeatureFlag(pool, projectId, input.flag_key);
  await verifyMetricExists(pool, projectId, input.primary_metric_key);
  for (const key of input.secondary_metric_keys) await verifyMetricExists(pool, projectId, key);
  try {
    const { rows } = await pool.query<Experiment>(
      `INSERT INTO experiments (project_id, key, name, hypothesis, flag_key, primary_metric_key, secondary_metric_keys)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${EXPERIMENT_COLS}`,
      [projectId, input.key, input.name, input.hypothesis, input.flag_key, input.primary_metric_key, input.secondary_metric_keys],
    );
    return mapExperiment(rows[0]!);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'experiment_key_taken', `experiment "${input.key}" already exists`);
    }
    throw err;
  }
}

export async function getExperiment(pool: Db, projectId: string, key: string, lock = false): Promise<Experiment> {
  const { rows } = await pool.query<Experiment>(
    `SELECT ${EXPERIMENT_COLS} FROM experiments WHERE project_id = $1 AND key = $2${lock ? ' FOR UPDATE' : ''}`,
    [projectId, key],
  );
  if (!rows[0]) throw notFound('experiment', `no experiment "${key}" in this project — call list_experiments first`);
  return mapExperiment(rows[0]);
}

export async function listExperiments(pool: pg.Pool, projectId: string): Promise<Experiment[]> {
  const { rows } = await pool.query<Experiment>(
    `SELECT ${EXPERIMENT_COLS} FROM experiments WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows.map(mapExperiment);
}

export async function updateExperiment(
  pool: pg.Pool,
  projectId: string,
  key: string,
  patch: UpdateExperimentInput,
): Promise<Experiment> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const experiment = await getExperiment(db, projectId, key, true);
    if (experiment.status !== 'draft') {
      throw new ApiError(409, 'experiment_not_draft', `experiment "${key}" is ${experiment.status}`, 'only draft experiments may change their hypothesis or metric definitions');
    }
    if (patch.primary_metric_key) await verifyMetricExists(db, projectId, patch.primary_metric_key);
    if (patch.secondary_metric_keys) {
      for (const metricKey of patch.secondary_metric_keys) await verifyMetricExists(db, projectId, metricKey);
    }
    const { rows } = await db.query<Experiment>(
      `UPDATE experiments SET
         name = COALESCE($3, name),
         hypothesis = COALESCE($4, hypothesis),
         primary_metric_key = COALESCE($5, primary_metric_key),
         secondary_metric_keys = COALESCE($6, secondary_metric_keys),
         updated_at = now()
       WHERE project_id = $1 AND key = $2 AND status = 'draft'
       RETURNING ${EXPERIMENT_COLS}`,
      [projectId, key, patch.name ?? null, patch.hypothesis ?? null, patch.primary_metric_key ?? null,
        patch.secondary_metric_keys ?? null],
    );
    if (!rows[0]) {
      throw new ApiError(409, 'experiment_not_draft', `experiment "${key}" is no longer draft`, 'retry after reading the current experiment state');
    }
    await db.query('COMMIT');
    return mapExperiment(rows[0]);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export async function startExperiment(pool: pg.Pool, projectId: string, key: string, now = new Date()): Promise<Experiment> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const experiment = await getExperiment(db, projectId, key, true);
    if (experiment.status !== 'draft') {
      throw new ApiError(409, 'experiment_not_draft', `experiment "${key}" is ${experiment.status}`, 'only draft experiments can be started');
    }
    const flag = await getFeatureFlag(db, projectId, experiment.flag_key, true);
    validateExperimentFlag(flag);
    const metrics = [experiment.primary_metric_key, ...experiment.secondary_metric_keys];
    for (const metricKey of metrics) validateExperimentMetric(await getMetric(db, projectId, metricKey));
    const { rows } = await db.query<Experiment>(
      `UPDATE experiments SET status = 'running', started_at = $3, updated_at = now()
       WHERE project_id = $1 AND key = $2 AND status = 'draft'
       RETURNING ${EXPERIMENT_COLS}`,
      [projectId, key, now],
    );
    if (!rows[0]) {
      throw new ApiError(409, 'experiment_not_draft', `experiment "${key}" is no longer draft`, 'retry after reading the current experiment state');
    }
    await db.query('COMMIT');
    return mapExperiment(rows[0]);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export async function concludeExperiment(
  pool: pg.Pool,
  projectId: string,
  key: string,
  decision: Experiment['decision'],
  now = new Date(),
): Promise<Experiment> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const experiment = await getExperiment(db, projectId, key, true);
    if (experiment.status !== 'running') {
      throw new ApiError(409, 'experiment_not_running', `experiment "${key}" is ${experiment.status}`, 'only a running experiment can be concluded');
    }
    const { rows } = await db.query<Experiment>(
      `UPDATE experiments SET status = 'concluded', concluded_at = $3, decision = $4, updated_at = now()
       WHERE project_id = $1 AND key = $2 AND status = 'running'
       RETURNING ${EXPERIMENT_COLS}`,
      [projectId, key, now, decision ? JSON.stringify(decision) : null],
    );
    if (!rows[0]) {
      throw new ApiError(409, 'experiment_not_running', `experiment "${key}" is no longer running`, 'retry after reading the current experiment state');
    }
    await db.query('COMMIT');
    return mapExperiment(rows[0]);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export async function getExperimentResults(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  key: string,
  env: string,
  now = new Date(),
): Promise<ExperimentResults> {
  const experiment = await getExperiment(pool, projectId, key);
  if (experiment.status === 'draft' || !experiment.started_at) {
    throw new ApiError(409, 'experiment_not_started', `experiment "${key}" has not started`, 'start the experiment before requesting results');
  }
  const flag = await getFeatureFlag(pool, projectId, experiment.flag_key);
  const metric = await getMetric(pool, projectId, experiment.primary_metric_key);
  validateExperimentMetric(metric);
  const to = experiment.concluded_at ? new Date(experiment.concluded_at) : now;
  const from = new Date(experiment.started_at);
  const [variants, secondary_metrics] = await Promise.all([
    getMetricResults(eventStore, projectId, env, experiment.flag_key, flag, metric, from, to),
    Promise.all(experiment.secondary_metric_keys.map(async (metricKey) => {
      const secondary = await getMetric(pool, projectId, metricKey);
      validateExperimentMetric(secondary);
      return { metric: secondary, variants: await getMetricResults(eventStore, projectId, env, experiment.flag_key, flag, secondary, from, to) };
    })),
  ]);
  return {
    key: experiment.key,
    status: experiment.status,
    primary_metric: { key: metric.key, name: metric.name, purpose: metric.purpose },
    started_at: new Date(experiment.started_at).toISOString(),
    concluded_at: experiment.concluded_at ? new Date(experiment.concluded_at).toISOString() : null,
    variants,
    secondary_metrics,
  };
}

async function getMetricResults(
  eventStore: EventStore,
  projectId: string,
  env: string,
  flagKey: string,
  flag: FeatureFlag,
  metric: Metric,
  from: Date,
  to: Date,
): Promise<VariantExperimentStats[]> {
  const source = metric.source as { event: string; filters?: PropertyFilter[] };
  const observed = await eventStore.experimentResults({
    projectId,
    env,
    flagKey,
    metricEvent: source.event,
    metricFilters: source.filters ?? [],
    from,
    to,
  });
  return summarizeExperimentVariants(mergeVariantOutcomes(flag, observed));
}

function mergeVariantOutcomes(flag: FeatureFlag, observed: ExperimentVariantOutcome[]) {
  const byVariant = new Map(observed.map((outcome) => [outcome.variant, outcome]));
  return flag.variants.map((variant) => {
    const outcome = byVariant.get(variant.key);
    return { key: variant.key, exposed: outcome?.exposed ?? 0, converted: outcome?.converted ?? 0 };
  });
}

function validateExperimentFlag(flag: FeatureFlag): void {
  if (flag.status !== 'active') {
    throw new ApiError(409, 'experiment_flag_not_active', `flag "${flag.key}" is ${flag.status}`, 'activate the feature flag before starting an experiment');
  }
  const allocationBasisPoints = flag.variants.reduce(
    (total, variant) => total + Math.round(variant.rollout_percentage * 100), 0,
  );
  if (allocationBasisPoints !== 10_000) {
    throw new ApiError(409, 'experiment_flag_allocation_incomplete', `flag "${flag.key}" allocates ${allocationBasisPoints / 100}% of traffic`, 'an experiment requires exactly 100% allocation across its variants');
  }
}

function validateExperimentMetric(metric: Metric): void {
  if (metric.status !== 'active') {
    throw new ApiError(409, 'experiment_metric_not_active', `metric "${metric.key}" is ${metric.status}`, 'activate the outcome metric before starting an experiment');
  }
  if (metric.type !== 'count' && metric.type !== 'unique_actors') {
    throw new ApiError(400, 'experiment_metric_unsupported', `metric "${metric.key}" has type=${metric.type}`, 'v1 experiments require an active count or unique_actors metric');
  }
}

async function verifyMetricExists(pool: Db, projectId: string, key: string): Promise<void> {
  await getMetric(pool, projectId, key);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
