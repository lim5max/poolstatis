import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type {
  ApplyExperimentDecisionInput,
  CreateExperimentInput,
  PrepareExperimentInput,
  PropertyFilter,
  UpdateExperimentInput,
} from '../schemas.js';
import type { EventStore, ExperimentVariantOutcome } from '../stores/eventStore.js';
import { createFeatureFlag, getFeatureFlag, type FeatureFlag, type FeatureFlagVariant } from './flags.js';
import { summarizeExperimentVariants, type VariantExperimentStats } from './experimentStats.js';
import { getMetric, type Metric } from './registry.js';

type Db = pg.Pool | pg.PoolClient;

export type SnapshotIntegrity = 'legacy_unfrozen' | 'backfilled_current' | 'frozen_at_start';

interface MetricSnapshot {
  key: string;
  name: string;
  purpose: string;
  type: Metric['type'];
  source: Record<string, unknown>;
}

interface FlagSnapshot {
  key: string;
  env: string | null;
  salt: string;
  variants: FeatureFlagVariant[];
}

interface ExperimentDecision {
  outcome: 'ship' | 'iterate' | 'stop' | 'inconclusive';
  rationale: string;
  ship_variant_key?: string;
}

export interface Experiment {
  id: string;
  key: string;
  name: string;
  hypothesis: string;
  flag_key: string;
  primary_metric_key: string;
  secondary_metric_keys: string[];
  status: 'draft' | 'running' | 'concluded';
  env: string | null;
  control_variant_key: string | null;
  flag_snapshot: FlagSnapshot | null;
  metric_snapshots: MetricSnapshot[] | null;
  snapshot_integrity: SnapshotIntegrity;
  started_at: string | Date | null;
  concluded_at: string | Date | null;
  decision: ExperimentDecision | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ExperimentResults {
  key: string;
  status: Experiment['status'];
  env: string;
  control_variant_key: string | null;
  snapshot_integrity: SnapshotIntegrity;
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

export type ExperimentReadinessCheckKey =
  | 'experiment_draft'
  | 'flag_draft'
  | 'environment_match'
  | 'variant_count'
  | 'allocation_complete'
  | 'control_variant'
  | 'primary_metric_distinct'
  | 'metrics_active'
  | 'no_running_experiment';

export interface ExperimentReadiness {
  key: string;
  env: string | null;
  ready: boolean;
  checks: Array<{ key: ExperimentReadinessCheckKey; ready: boolean; message: string }>;
}

export interface PreparedExperiment {
  flag: FeatureFlag;
  experiment: Experiment;
  readiness: ExperimentReadiness;
}

const EXPERIMENT_COLS = `id, key, name, hypothesis, flag_key, primary_metric_key,
  secondary_metric_keys, status, env, control_variant_key, flag_snapshot, metric_snapshots,
  snapshot_integrity, started_at, concluded_at, decision, created_at, updated_at`;

function mapExperiment(row: Experiment): Experiment {
  return {
    ...row,
    env: row.env ?? null,
    control_variant_key: row.control_variant_key ?? null,
    flag_snapshot: row.flag_snapshot ?? null,
    metric_snapshots: row.metric_snapshots ?? null,
    snapshot_integrity: row.snapshot_integrity ?? 'legacy_unfrozen',
    secondary_metric_keys: row.secondary_metric_keys ?? [],
    started_at: isoOrNull(row.started_at),
    concluded_at: isoOrNull(row.concluded_at),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export async function createExperiment(pool: Db, projectId: string, input: CreateExperimentInput): Promise<Experiment> {
  const flag = await getFeatureFlag(pool, projectId, input.flag_key);
  const secondaryMetricKeys = input.secondary_metric_keys ?? [];
  await verifyMetricExists(pool, projectId, input.primary_metric_key);
  for (const key of secondaryMetricKeys) await verifyMetricExists(pool, projectId, key);
  if (input.env && flag.env !== null && flag.env !== input.env) {
    throw new ApiError(409, 'experiment_environment_mismatch', `flag "${flag.key}" belongs to env=${flag.env}`, 'use a flag scoped to the same environment as the experiment');
  }
  if (input.control_variant_key && !flag.variants.some((variant) => variant.key === input.control_variant_key)) {
    throw new ApiError(400, 'experiment_control_variant_unknown', `flag "${flag.key}" has no variant "${input.control_variant_key}"`);
  }
  try {
    const { rows } = await pool.query<Experiment>(
      `INSERT INTO experiments (
         project_id, key, name, hypothesis, flag_key, primary_metric_key,
         secondary_metric_keys, env, control_variant_key
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${EXPERIMENT_COLS}`,
      [projectId, input.key, input.name, input.hypothesis, input.flag_key, input.primary_metric_key,
        secondaryMetricKeys, input.env ?? null, input.control_variant_key ?? null],
    );
    return mapExperiment(rows[0]!);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'experiment_key_taken', `experiment "${input.key}" already exists`);
    }
    throw err;
  }
}

export async function prepareExperiment(
  pool: pg.Pool,
  projectId: string,
  input: PrepareExperimentInput,
): Promise<PreparedExperiment> {
  if (!input.flag.variants.some((variant) => variant.key === input.control_variant_key)) {
    throw new ApiError(400, 'experiment_control_variant_unknown', `flag "${input.flag.key}" has no variant "${input.control_variant_key}"`);
  }
  if ((input.experiment.secondary_metric_keys ?? []).includes(input.experiment.primary_metric_key)) {
    throw new ApiError(400, 'experiment_primary_metric_repeated', 'the primary metric cannot also be a secondary metric');
  }
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const flag = await createFeatureFlag(db, projectId, {
      ...input.flag,
      status: 'draft',
      env: input.env,
    });
    const experiment = await createExperiment(db, projectId, {
      ...input.experiment,
      flag_key: flag.key,
      env: input.env,
      control_variant_key: input.control_variant_key,
      secondary_metric_keys: input.experiment.secondary_metric_keys ?? [],
    });
    const readiness = await buildExperimentReadiness(db, projectId, experiment, flag, input.env);
    await db.query('COMMIT');
    return { flag, experiment, readiness };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
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

/** Legacy start remains supported. It keeps the existing validation contract but
 * now freezes the exact flag and metric definitions used by the result query. */
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
    if (experiment.env !== null && flag.env !== null && experiment.env !== flag.env) {
      throw new ApiError(409, 'experiment_environment_mismatch', `experiment env=${experiment.env} does not match flag env=${flag.env}`);
    }
    const snapshots = await captureSnapshots(db, projectId, experiment, flag);
    const controlVariantKey = experiment.control_variant_key ?? flag.variants[0]!.key;
    const { rows } = await db.query<Experiment>(
      `UPDATE experiments SET
         status = 'running', started_at = $3, control_variant_key = $4,
         flag_snapshot = $5, metric_snapshots = $6,
         snapshot_integrity = 'frozen_at_start', updated_at = now()
       WHERE project_id = $1 AND key = $2 AND status = 'draft'
       RETURNING ${EXPERIMENT_COLS}`,
      [projectId, key, now, controlVariantKey, JSON.stringify(snapshots.flag), JSON.stringify(snapshots.metrics)],
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

export async function getExperimentReadiness(
  pool: Db,
  projectId: string,
  key: string,
  env?: string,
): Promise<ExperimentReadiness> {
  const experiment = await getExperiment(pool, projectId, key);
  const flag = await getFeatureFlag(pool, projectId, experiment.flag_key);
  return buildExperimentReadiness(pool, projectId, experiment, flag, env);
}

export async function launchExperiment(
  pool: pg.Pool,
  projectId: string,
  key: string,
  now = new Date(),
): Promise<PreparedExperiment> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const experiment = await getExperiment(db, projectId, key, true);
    const flag = await getFeatureFlag(db, projectId, experiment.flag_key, true);
    const readiness = await buildExperimentReadiness(db, projectId, experiment, flag, experiment.env ?? undefined);
    if (!readiness.ready) {
      const failed = readiness.checks.filter((check) => !check.ready).map((check) => check.message).join('; ');
      throw new ApiError(409, 'experiment_not_ready', `experiment "${key}" is not ready to launch`, failed);
    }
    const snapshots = await captureSnapshots(db, projectId, experiment, flag);
    const activated = await db.query(
      `UPDATE feature_flags SET status = 'active', updated_at = now()
       WHERE project_id = $1 AND key = $2 AND status = 'draft'`,
      [projectId, flag.key],
    );
    if (activated.rowCount !== 1) {
      throw new ApiError(409, 'experiment_flag_not_draft', `flag "${flag.key}" is no longer draft`);
    }
    const started = await db.query<Experiment>(
      `UPDATE experiments SET
         status = 'running', started_at = $3, flag_snapshot = $4,
         metric_snapshots = $5, snapshot_integrity = 'frozen_at_start', updated_at = now()
       WHERE project_id = $1 AND key = $2 AND status = 'draft'
       RETURNING ${EXPERIMENT_COLS}`,
      [projectId, key, now, JSON.stringify(snapshots.flag), JSON.stringify(snapshots.metrics)],
    );
    if (!started.rows[0]) {
      throw new ApiError(409, 'experiment_not_draft', `experiment "${key}" is no longer draft`);
    }
    const launchedExperiment = mapExperiment(started.rows[0]);
    const launchedFlag = await getFeatureFlag(db, projectId, flag.key);
    await db.query('COMMIT');
    return {
      flag: launchedFlag,
      experiment: launchedExperiment,
      readiness: { ...readiness, ready: true },
    };
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
    const experiment = await concludeExperimentInTransaction(db, projectId, key, decision, now);
    await db.query('COMMIT');
    return experiment;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export async function applyExperimentDecision(
  pool: pg.Pool,
  projectId: string,
  key: string,
  input: ApplyExperimentDecisionInput,
  now = new Date(),
): Promise<{ experiment: Experiment; flag: FeatureFlag }> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const current = await getExperiment(db, projectId, key, true);
    if (current.status !== 'running') {
      throw new ApiError(409, 'experiment_not_running', `experiment "${key}" is ${current.status}`, 'only a running experiment can be concluded');
    }
    const flag = await getFeatureFlag(db, projectId, current.flag_key, true);
    if (input.ship_variant_key && !flag.variants.some((variant) => variant.key === input.ship_variant_key)) {
      throw new ApiError(400, 'experiment_ship_variant_unknown', `flag "${flag.key}" has no variant "${input.ship_variant_key}"`);
    }
    const decision: ExperimentDecision = {
      ...input.decision,
      ...(input.ship_variant_key ? { ship_variant_key: input.ship_variant_key } : {}),
    };
    const experiment = await concludeExperimentInTransaction(db, projectId, key, decision, now);
    if (input.ship_variant_key) {
      const variants = flag.variants.map((variant) => ({
        ...variant,
        rollout_percentage: variant.key === input.ship_variant_key ? 100 : 0,
      }));
      const updated = await db.query(
        `UPDATE feature_flags SET variants = $3, status = 'active', updated_at = now()
         WHERE project_id = $1 AND key = $2`,
        [projectId, flag.key, JSON.stringify(variants)],
      );
      if (updated.rowCount !== 1) throw notFound('feature_flag');
    }
    const updatedFlag = await getFeatureFlag(db, projectId, flag.key);
    await db.query('COMMIT');
    return { experiment, flag: updatedFlag };
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
  if (experiment.env !== null && experiment.env !== env) {
    throw new ApiError(409, 'experiment_environment_mismatch', `experiment "${key}" belongs to env=${experiment.env}`, `request results with env=${experiment.env}`);
  }
  const resolved = await resolveSnapshots(pool, projectId, experiment);
  const primary = resolved.metrics.find((metric) => metric.key === experiment.primary_metric_key)!;
  const secondary = experiment.secondary_metric_keys
    .map((metricKey) => resolved.metrics.find((metric) => metric.key === metricKey))
    .filter((metric): metric is MetricSnapshot => metric !== undefined);
  const to = experiment.concluded_at ? new Date(experiment.concluded_at) : now;
  const from = new Date(experiment.started_at);
  const [variants, secondaryMetrics] = await Promise.all([
    getMetricResults(eventStore, projectId, env, experiment.flag_key, resolved.flag, primary, from, to, experiment.control_variant_key),
    Promise.all(secondary.map(async (metric) => ({
      metric,
      variants: await getMetricResults(eventStore, projectId, env, experiment.flag_key, resolved.flag, metric, from, to, experiment.control_variant_key),
    }))),
  ]);
  return {
    key: experiment.key,
    status: experiment.status,
    env,
    control_variant_key: experiment.control_variant_key,
    snapshot_integrity: resolved.integrity,
    primary_metric: { key: primary.key, name: primary.name, purpose: primary.purpose },
    started_at: new Date(experiment.started_at).toISOString(),
    concluded_at: experiment.concluded_at ? new Date(experiment.concluded_at).toISOString() : null,
    variants,
    secondary_metrics: secondaryMetrics.map(({ metric, variants: metricVariants }) => ({
      metric: { key: metric.key, name: metric.name, purpose: metric.purpose },
      variants: metricVariants,
    })),
  };
}

async function buildExperimentReadiness(
  pool: Db,
  projectId: string,
  experiment: Experiment,
  flag: FeatureFlag,
  requestedEnv?: string,
): Promise<ExperimentReadiness> {
  const env = requestedEnv ?? experiment.env;
  const positiveVariants = flag.variants.filter((variant) => variant.rollout_percentage > 0);
  const allocationBasisPoints = flag.variants.reduce(
    (total, variant) => total + Math.round(variant.rollout_percentage * 100),
    0,
  );
  const control = experiment.control_variant_key === null
    ? undefined
    : flag.variants.find((variant) => variant.key === experiment.control_variant_key);
  const metricKeys = [experiment.primary_metric_key, ...experiment.secondary_metric_keys];
  const metrics = await Promise.all(metricKeys.map(async (metricKey) => getMetric(pool, projectId, metricKey).catch(() => null)));
  const metricsReady = metrics.every((metric) => metric !== null
    && metric.status === 'active'
    && (metric.type === 'count' || metric.type === 'unique_actors')
    && isNativeExperimentMetric(metric));
  const running = await pool.query<{ key: string }>(
    `SELECT key FROM experiments
     WHERE project_id = $1 AND flag_key = $2 AND status = 'running' AND key <> $3
     LIMIT 1`,
    [projectId, flag.key, experiment.key],
  );
  const checks: ExperimentReadiness['checks'] = [
    check('experiment_draft', experiment.status === 'draft', experiment.status === 'draft' ? 'Experiment is a draft.' : `Experiment is ${experiment.status}.`),
    check('flag_draft', flag.status === 'draft', flag.status === 'draft' ? 'Flag is safely inactive until launch.' : `Flag is ${flag.status}; atomic launch requires a draft flag.`),
    check(
      'environment_match',
      env !== null && experiment.env === env && flag.env === env,
      env !== null && experiment.env === env && flag.env === env
        ? `Flag and experiment are scoped to env=${env}.`
        : 'Flag, experiment and requested environment must be the same explicit environment.',
    ),
    check('variant_count', positiveVariants.length >= 2, positiveVariants.length >= 2 ? 'At least two variants receive traffic.' : 'At least two variants must have positive allocation.'),
    check('allocation_complete', allocationBasisPoints === 10_000, allocationBasisPoints === 10_000 ? 'Variants allocate exactly 100%.' : `Variants allocate ${allocationBasisPoints / 100}%; launch requires 100%.`),
    check('control_variant', Boolean(control && control.rollout_percentage > 0), control && control.rollout_percentage > 0 ? `Control variant is ${control.key}.` : 'Control variant must exist and receive traffic.'),
    check('primary_metric_distinct', !experiment.secondary_metric_keys.includes(experiment.primary_metric_key), 'Primary metric must not also be secondary.'),
    check('metrics_active', metricsReady, metricsReady ? 'All outcome metrics are active native metrics.' : 'All outcome metrics must be active native count or unique_actors metrics.'),
    check('no_running_experiment', running.rows.length === 0, running.rows[0] ? `Flag is already used by running experiment ${running.rows[0].key}.` : 'No other running experiment uses this flag.'),
  ];
  return { key: experiment.key, env, ready: checks.every((entry) => entry.ready), checks };
}

async function captureSnapshots(
  pool: Db,
  projectId: string,
  experiment: Experiment,
  flag: FeatureFlag,
): Promise<{ flag: FlagSnapshot; metrics: MetricSnapshot[] }> {
  const metrics: MetricSnapshot[] = [];
  for (const metricKey of [experiment.primary_metric_key, ...experiment.secondary_metric_keys]) {
    const metric = await getMetric(pool, projectId, metricKey);
    validateExperimentMetric(metric);
    metrics.push(snapshotMetric(metric));
  }
  return {
    flag: {
      key: flag.key,
      env: flag.env,
      salt: flag.salt,
      variants: flag.variants.map((variant) => ({ ...variant })),
    },
    metrics,
  };
}

async function resolveSnapshots(
  pool: Db,
  projectId: string,
  experiment: Experiment,
): Promise<{ flag: FlagSnapshot; metrics: MetricSnapshot[]; integrity: SnapshotIntegrity }> {
  const metricKeys = [experiment.primary_metric_key, ...experiment.secondary_metric_keys];
  if (experiment.flag_snapshot && experiment.metric_snapshots
    && metricKeys.every((key) => experiment.metric_snapshots!.some((metric) => metric.key === key))) {
    return {
      flag: normalizeFlagSnapshot(experiment.flag_snapshot),
      metrics: experiment.metric_snapshots,
      integrity: experiment.snapshot_integrity,
    };
  }
  const flag = await getFeatureFlag(pool, projectId, experiment.flag_key);
  const metrics = await Promise.all(metricKeys.map(async (metricKey) => snapshotMetric(await getMetric(pool, projectId, metricKey))));
  return {
    flag: { key: flag.key, env: flag.env, salt: flag.salt, variants: flag.variants },
    metrics,
    integrity: 'legacy_unfrozen',
  };
}

async function concludeExperimentInTransaction(
  db: pg.PoolClient,
  projectId: string,
  key: string,
  decision: Experiment['decision'],
  now: Date,
): Promise<Experiment> {
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
  return mapExperiment(rows[0]);
}

async function getMetricResults(
  eventStore: EventStore,
  projectId: string,
  env: string,
  flagKey: string,
  flag: Pick<FlagSnapshot, 'variants'>,
  metric: MetricSnapshot,
  from: Date,
  to: Date,
  controlVariantKey: string | null,
): Promise<VariantExperimentStats[]> {
  if (!isNativeExperimentMetric(metric)) {
    throw new ApiError(409, 'experiment_metric_source_unsupported', `metric "${metric.key}" is not native`, 'v1 experiment results require native Poolstatis event metrics');
  }
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
  return summarizeExperimentVariants(mergeVariantOutcomes(flag.variants, observed, controlVariantKey));
}

function mergeVariantOutcomes(
  variants: FeatureFlagVariant[],
  observed: ExperimentVariantOutcome[],
  controlVariantKey: string | null,
) {
  const byVariant = new Map(observed.map((outcome) => [outcome.variant, outcome]));
  const ordered = controlVariantKey
    ? [...variants.filter((variant) => variant.key === controlVariantKey), ...variants.filter((variant) => variant.key !== controlVariantKey)]
    : variants;
  const declared = new Set(ordered.map((variant) => variant.key));
  return [
    ...ordered.map((variant) => {
      const outcome = byVariant.get(variant.key);
      return { key: variant.key, exposed: outcome?.exposed ?? 0, converted: outcome?.converted ?? 0 };
    }),
    ...observed.filter((outcome) => !declared.has(outcome.variant)).map((outcome) => ({
      key: outcome.variant,
      exposed: outcome.exposed,
      converted: outcome.converted,
    })),
  ];
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
  if (!isNativeExperimentMetric(metric)) {
    throw new ApiError(409, 'experiment_metric_source_unsupported', `metric "${metric.key}" is not native`, 'v1 experiments require a native Poolstatis event metric');
  }
}

function isNativeExperimentMetric(metric: Pick<Metric, 'source'> | MetricSnapshot): boolean {
  return metric.source.data_source === undefined || metric.source.data_source === 'native';
}

async function verifyMetricExists(pool: Db, projectId: string, key: string): Promise<void> {
  await getMetric(pool, projectId, key);
}

function snapshotMetric(metric: Metric): MetricSnapshot {
  return { key: metric.key, name: metric.name, purpose: metric.purpose, type: metric.type, source: metric.source };
}

function normalizeFlagSnapshot(snapshot: FlagSnapshot): FlagSnapshot {
  return {
    ...snapshot,
    env: snapshot.env ?? null,
    variants: snapshot.variants.map((variant) => ({
      ...variant,
      rollout_percentage: Number(variant.rollout_percentage),
    })),
  };
}

function check(key: ExperimentReadinessCheckKey, ready: boolean, message: string) {
  return { key, ready, message };
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
