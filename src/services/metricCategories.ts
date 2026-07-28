import type pg from 'pg';
import { ApiError, badRequest, notFound } from '../errors.js';
import type { CreateMetricCategoryInput, UpdateMetricCategoryInput } from '../schemas.js';

type Queryable = pg.Pool | pg.PoolClient;

export interface MetricCategory {
  id: string;
  key: string;
  name: string;
  description: string;
  domain: 'product' | 'business' | 'technical' | 'custom';
  color: string;
  is_system: boolean;
  metric_count: number;
}

const CATEGORY_COLS =
  'c.id, c.key, c.name, c.description, c.domain, c.color, c.is_system';

export async function listMetricCategories(
  pool: pg.Pool,
  projectId: string,
): Promise<MetricCategory[]> {
  const { rows } = await pool.query(
    `SELECT ${CATEGORY_COLS}, count(m.id)::int AS metric_count
     FROM metric_categories c
     LEFT JOIN metrics m
       ON m.project_id = c.project_id AND m.category = c.key
     WHERE c.project_id = $1
     GROUP BY c.id
     ORDER BY
       CASE c.domain WHEN 'product' THEN 1 WHEN 'business' THEN 2
         WHEN 'technical' THEN 3 ELSE 4 END,
       c.key`,
    [projectId],
  );
  return rows;
}

export async function assertMetricCategory(
  pool: Queryable,
  projectId: string,
  key: string | null | undefined,
): Promise<void> {
  if (key == null) return;
  const { rowCount } = await pool.query(
    'SELECT 1 FROM metric_categories WHERE project_id = $1 AND key = $2',
    [projectId, key],
  );
  if (!rowCount) {
    throw badRequest(
      'unknown_metric_category',
      `metric category "${key}" does not exist in this project`,
      'call list_metric_categories to choose a system category, or create_metric_category only when the system library cannot express the metric purpose',
    );
  }
}

export async function createMetricCategory(
  pool: pg.Pool,
  projectId: string,
  input: CreateMetricCategoryInput,
): Promise<MetricCategory> {
  try {
    const { rows } = await pool.query(
      `INSERT INTO metric_categories (
         project_id, key, name, description, domain, color, is_system
       ) VALUES ($1, $2, $3, $4, 'custom', $5, false)
       RETURNING id, key, name, description, domain, color, is_system,
         0::int AS metric_count`,
      [projectId, input.key, input.name, input.description, input.color],
    );
    return rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(
        409,
        'metric_category_taken',
        `metric category "${input.key}" already exists in this project`,
        'choose another key or update the existing custom category',
      );
    }
    throw error;
  }
}

export async function updateMetricCategory(
  pool: pg.Pool,
  projectId: string,
  key: string,
  patch: UpdateMetricCategoryInput,
): Promise<MetricCategory> {
  const existing = await getMetricCategory(pool, projectId, key);
  if (existing.is_system) throw systemCategoryConflict(key);
  const { rows } = await pool.query(
    `UPDATE metric_categories SET
       name = COALESCE($3, name),
       description = COALESCE($4, description),
       color = COALESCE($5, color)
     WHERE project_id = $1 AND key = $2
     RETURNING id, key, name, description, domain, color, is_system,
       (SELECT count(*)::int FROM metrics
        WHERE project_id = $1 AND category = $2) AS metric_count`,
    [projectId, key, patch.name ?? null, patch.description ?? null, patch.color ?? null],
  );
  if (!rows[0]) throw notFound('metric_category');
  return rows[0];
}

export async function deleteMetricCategory(
  pool: pg.Pool,
  projectId: string,
  key: string,
): Promise<{ key: string }> {
  const existing = await getMetricCategory(pool, projectId, key);
  if (existing.is_system) throw systemCategoryConflict(key);
  if (existing.metric_count > 0) {
    throw categoryInUse(key, existing.metric_count);
  }
  let rowCount: number | null;
  try {
    ({ rowCount } = await pool.query(
      'DELETE FROM metric_categories WHERE project_id = $1 AND key = $2 AND is_system = false',
      [projectId, key],
    ));
  } catch (error) {
    if (isForeignKeyViolation(error)) {
      const current = await getMetricCategory(pool, projectId, key);
      throw categoryInUse(key, current.metric_count);
    }
    throw error;
  }
  if (!rowCount) throw notFound('metric_category');
  return { key };
}

async function getMetricCategory(
  pool: pg.Pool,
  projectId: string,
  key: string,
): Promise<MetricCategory> {
  const { rows } = await pool.query(
    `SELECT ${CATEGORY_COLS},
       (SELECT count(*)::int FROM metrics m
        WHERE m.project_id = c.project_id AND m.category = c.key) AS metric_count
     FROM metric_categories c
     WHERE c.project_id = $1 AND c.key = $2`,
    [projectId, key],
  );
  if (!rows[0]) throw notFound('metric_category', 'call list_metric_categories for valid project categories');
  return rows[0];
}

function systemCategoryConflict(key: string): ApiError {
  return new ApiError(
    409,
    'system_metric_category',
    `system metric category "${key}" has immutable semantics`,
    'create a project custom category only when the system library cannot express the metric purpose',
  );
}

function categoryInUse(key: string, metricCount: number): ApiError {
  return new ApiError(
    409,
    'metric_category_in_use',
    `metric category "${key}" is referenced by ${metricCount} metric(s)`,
    'move or clear those metric categories before deleting this custom category',
    { metric_count: metricCount },
  );
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string }).code === '23505';
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string }).code === '23503';
}
