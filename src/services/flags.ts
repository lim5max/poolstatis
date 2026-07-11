import { createHash } from 'node:crypto';
import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type {
  CreateFeatureFlagInput,
  FlagEvaluationInput,
  UpdateFeatureFlagInput,
} from '../schemas.js';
import type { EventStore } from '../stores/eventStore.js';

type Db = pg.Pool | pg.PoolClient;

export interface FeatureFlagVariant {
  key: string;
  rollout_percentage: number;
  payload?: Record<string, unknown>;
}

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  purpose: string;
  status: 'draft' | 'active' | 'archived';
  salt: string;
  variants: FeatureFlagVariant[];
  created_at: string;
  updated_at: string;
}

export interface FlagEvaluation {
  key: string;
  variant: { key: string; payload?: Record<string, unknown> } | null;
}

const FLAG_COLS = 'id, key, name, purpose, status, salt, variants, created_at, updated_at';

function mapFlag(row: FeatureFlag): FeatureFlag {
  return {
    ...row,
    variants: row.variants.map((variant) => ({
      key: variant.key,
      rollout_percentage: Number(variant.rollout_percentage),
      ...(variant.payload ? { payload: variant.payload } : {}),
    })),
  };
}

export async function createFeatureFlag(
  pool: pg.Pool,
  projectId: string,
  input: CreateFeatureFlagInput,
): Promise<FeatureFlag> {
  try {
    const { rows } = await pool.query<FeatureFlag>(
      `INSERT INTO feature_flags (project_id, key, name, purpose, status, variants)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${FLAG_COLS}`,
      [projectId, input.key, input.name, input.purpose, input.status, JSON.stringify(input.variants)],
    );
    return mapFlag(rows[0]!);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(
        409,
        'feature_flag_key_taken',
        `feature flag "${input.key}" already exists`,
        'use update_feature_flag to change it, or pick a new key',
      );
    }
    throw err;
  }
}

export async function getFeatureFlag(pool: Db, projectId: string, key: string, lock = false): Promise<FeatureFlag> {
  const { rows } = await pool.query<FeatureFlag>(
    `SELECT ${FLAG_COLS} FROM feature_flags WHERE project_id = $1 AND key = $2${lock ? ' FOR UPDATE' : ''}`,
    [projectId, key],
  );
  if (!rows[0]) {
    throw notFound(
      'feature_flag',
      `no feature flag "${key}" in this project — call list_feature_flags or create_feature_flag first`,
    );
  }
  return mapFlag(rows[0]);
}

export async function listFeatureFlags(pool: pg.Pool, projectId: string): Promise<FeatureFlag[]> {
  const { rows } = await pool.query<FeatureFlag>(
    `SELECT ${FLAG_COLS} FROM feature_flags WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows.map(mapFlag);
}

export async function updateFeatureFlag(
  pool: pg.Pool,
  projectId: string,
  key: string,
  patch: UpdateFeatureFlagInput,
): Promise<FeatureFlag> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const existing = await getFeatureFlag(db, projectId, key, true);
    if (existing.status === 'archived') {
      throw new ApiError(
        409,
        'feature_flag_archived',
        `feature flag "${key}" is archived`,
        'create a new flag instead of modifying historical delivery configuration',
      );
    }
    await ensureNoRunningExperiment(db, projectId, key);
    const { rows } = await db.query<FeatureFlag>(
      `UPDATE feature_flags SET
         name = COALESCE($3, name),
         purpose = COALESCE($4, purpose),
         variants = COALESCE($5, variants),
         status = COALESCE($6, status),
         updated_at = now()
       WHERE project_id = $1 AND key = $2
       RETURNING ${FLAG_COLS}`,
      [
        projectId,
        key,
        patch.name ?? null,
        patch.purpose ?? null,
        patch.variants === undefined ? null : JSON.stringify(patch.variants),
        patch.status ?? null,
      ],
    );
    if (!rows[0]) throw notFound('feature_flag');
    await db.query('COMMIT');
    return mapFlag(rows[0]);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

export async function archiveFeatureFlag(pool: pg.Pool, projectId: string, key: string): Promise<FeatureFlag> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await getFeatureFlag(db, projectId, key, true);
    await ensureNoRunningExperiment(db, projectId, key);
    const { rows } = await db.query<FeatureFlag>(
      `UPDATE feature_flags SET status = 'archived', updated_at = now()
       WHERE project_id = $1 AND key = $2
       RETURNING ${FLAG_COLS}`,
      [projectId, key],
    );
    if (!rows[0]) throw notFound('feature_flag');
    await db.query('COMMIT');
    return mapFlag(rows[0]);
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function ensureNoRunningExperiment(pool: Db, projectId: string, key: string): Promise<void> {
  const { rows: running } = await pool.query<{ key: string }>(
    `SELECT key FROM experiments WHERE project_id = $1 AND flag_key = $2 AND status = 'running' LIMIT 1`,
    [projectId, key],
  );
  if (running[0]) {
    throw new ApiError(
      409,
      'feature_flag_in_running_experiment',
      `feature flag "${key}" is used by running experiment "${running[0].key}"`,
      'conclude the experiment before archiving its flag so results stay interpretable',
    );
  }
}

export async function evaluateFeatureFlag(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  env: string,
  input: FlagEvaluationInput,
  options: { emitExposure?: boolean; now?: Date } = {},
): Promise<FlagEvaluation> {
  const flag = await getFeatureFlag(pool, projectId, input.key);
  if (flag.status !== 'active') {
    throw new ApiError(
      409,
      'feature_flag_not_active',
      `feature flag "${input.key}" is ${flag.status}`,
      'activate the flag before evaluating it in a product',
    );
  }

  const selected = selectVariant(flag, input.distinct_id);
  const variant = selected ? { key: selected.key, ...(selected.payload ? { payload: selected.payload } : {}) } : null;
  if (selected && options.emitExposure !== false) {
    await eventStore.append([{
      projectId,
      env,
      event: '$feature_flag_called',
      timestamp: options.now ?? new Date(),
      distinctId: input.distinct_id,
      sessionId: input.session_id ?? null,
      properties: {
        flag_key: flag.key,
        variant: selected.key,
        payload: selected.payload ?? null,
      },
      registered: true,
      isSystem: true,
    }]);
  }
  return { key: flag.key, variant };
}

export function selectVariant(flag: Pick<FeatureFlag, 'salt' | 'variants'>, distinctId: string): FeatureFlagVariant | null {
  const bucket = Number.parseInt(
    createHash('sha256').update(`${flag.salt}:${distinctId}`).digest('hex').slice(0, 8),
    16,
  ) % 10_000;
  let boundary = 0;
  for (const variant of flag.variants) {
    boundary += Math.round(variant.rollout_percentage * 100);
    if (bucket < boundary) return variant;
  }
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
