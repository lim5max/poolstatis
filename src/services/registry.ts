import type pg from 'pg';
import {
  metricSourceSchemas,
  type DeprecateMetricInput,
  type DefineFunnelInput,
  type RegisterMetricInput,
  type UpdateMetricInput,
} from '../schemas.js';
import { ApiError, badRequest, notFound } from '../errors.js';

export interface Metric {
  id: string;
  key: string;
  name: string;
  purpose: string;
  category: string | null;
  tags: string[];
  type: 'count' | 'unique_actors' | 'value' | 'conversion' | 'state';
  source: Record<string, unknown>;
  status: 'proposed' | 'active' | 'deprecated';
  owner: string | null;
  deprecation_reason: string | null;
  deprecated_at: string | null;
}

const METRIC_COLS =
  'id, key, name, purpose, category, tags, type, source, status, owner, deprecation_reason, deprecated_at';

/** Free-form tags are an open facet alongside the curated AARRR category:
 *  lowercased, trimmed, de-duplicated, order-preserved. */
function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

export async function registerMetric(
  pool: pg.Pool,
  projectId: string,
  input: RegisterMetricInput,
  owner: string | null,
): Promise<Metric> {
  const source = metricSourceSchemas[input.type].parse(input.source);
  await assertMetricSourceConnection(pool, projectId, input.type, source);
  if (input.type === 'state') {
    const { entity_type } = source as { entity_type: string };
    const { rowCount } = await pool.query(
      'SELECT 1 FROM entity_types WHERE project_id = $1 AND name = $2',
      [projectId, entity_type],
    );
    if (!rowCount) {
      throw badRequest(
        'unknown_entity_type',
        `state metric references entity type "${entity_type}" which is not registered`,
        'register it first via register_entity_type, then register the metric',
      );
    }
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO metrics (project_id, key, name, purpose, category, tags, type, source, owner)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${METRIC_COLS}`,
      [projectId, input.key, input.name, input.purpose, input.category ?? null,
       normalizeTags(input.tags), input.type, JSON.stringify(source), owner],
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await getMetric(pool, projectId, input.key);
      throw new ApiError(
        409,
        'metric_key_taken',
        `metric "${input.key}" already exists (status: ${existing.status})`,
        'use update_metric to change it, or pick a different key',
      );
    }
    throw err;
  }
}

export async function updateMetric(
  pool: pg.Pool,
  projectId: string,
  key: string,
  patch: UpdateMetricInput,
): Promise<Metric> {
  const existing = await getMetric(pool, projectId, key);
  if ((patch as { status?: string }).status === 'deprecated') {
    throw badRequest(
      'use_deprecate_metric',
      'deprecated metrics must include a retirement reason',
      'call deprecate_metric or POST /metrics/{key}/deprecate with a reason so future agents understand why it was retired',
    );
  }
  const validatedSource = patch.source !== undefined
    ? metricSourceSchemas[existing.type].parse(patch.source)
    : undefined;
  if (validatedSource !== undefined) {
    await assertMetricSourceConnection(pool, projectId, existing.type, validatedSource);
  }
  const { rows } = await pool.query(
    `UPDATE metrics SET
       name = COALESCE($3, name),
       purpose = COALESCE($4, purpose),
       category = CASE WHEN $5::boolean THEN $6 ELSE category END,
       status = COALESCE($7, status),
       source = COALESCE($8, source),
       tags = COALESCE($9, tags),
       deprecation_reason = CASE WHEN $7 IN ('active', 'proposed') THEN NULL ELSE deprecation_reason END,
       deprecated_at = CASE WHEN $7 IN ('active', 'proposed') THEN NULL ELSE deprecated_at END,
       updated_at = now()
     WHERE project_id = $1 AND key = $2
     RETURNING ${METRIC_COLS}`,
    [projectId, key, patch.name ?? null, patch.purpose ?? null,
     patch.category !== undefined, patch.category ?? null,
     patch.status ?? null,
     validatedSource !== undefined ? JSON.stringify(validatedSource) : null,
     patch.tags !== undefined ? normalizeTags(patch.tags) : null],
  );
  // The metric can disappear between getMetric and the UPDATE.
  if (!rows[0]) throw notFound('metric');
  return rows[0];
}

async function assertMetricSourceConnection(
  pool: pg.Pool,
  projectId: string,
  type: Metric['type'],
  source: unknown,
): Promise<void> {
  if (type === 'state') return;
  const sources = type === 'conversion'
    ? [
        (source as { from: unknown }).from,
        (source as { to: unknown }).to,
      ]
    : [source];
  for (const item of sources) {
    const eventSource = item as {
      data_source?: 'native' | 'posthog';
      source_connection_id?: string;
    };
    if (eventSource.data_source !== 'posthog') continue;
    const { rowCount } = await pool.query(
      `SELECT 1 FROM source_connections
       WHERE project_id = $1 AND id = $2 AND provider = 'posthog'
         AND status = 'verified'`,
      [projectId, eventSource.source_connection_id],
    );
    if (!rowCount) {
      throw notFound(
        'source_connection',
        'configure and verify this PostHog connection in the same project first',
      );
    }
  }
}

export async function deprecateMetric(
  pool: pg.Pool,
  projectId: string,
  key: string,
  input: DeprecateMetricInput,
): Promise<Metric> {
  const { rows } = await pool.query(
    `UPDATE metrics SET
       status = 'deprecated',
       deprecation_reason = $3,
       deprecated_at = COALESCE(deprecated_at, now()),
       updated_at = now()
     WHERE project_id = $1 AND key = $2
     RETURNING ${METRIC_COLS}`,
    [projectId, key, input.reason],
  );
  if (!rows[0]) throw notFound('metric', `no metric "${key}" in the registry — call list_metrics first`);
  return rows[0];
}

export async function getMetric(pool: pg.Pool | pg.PoolClient, projectId: string, key: string): Promise<Metric> {
  const { rows } = await pool.query(
    `SELECT ${METRIC_COLS} FROM metrics WHERE project_id = $1 AND key = $2`,
    [projectId, key],
  );
  if (!rows[0]) {
    throw notFound('metric', `no metric "${key}" in the registry — call list_metrics, or register_metric first`);
  }
  return rows[0];
}

export async function listMetrics(
  pool: pg.Pool,
  projectId: string,
  filter: { status?: string; category?: string } = {},
): Promise<Metric[]> {
  const params: unknown[] = [projectId];
  let sql = `SELECT ${METRIC_COLS} FROM metrics WHERE project_id = $1`;
  if (filter.status) {
    params.push(filter.status);
    sql += ` AND status = $${params.length}`;
  }
  if (filter.category) {
    params.push(filter.category);
    sql += ` AND category = $${params.length}`;
  }
  const { rows } = await pool.query(`${sql} ORDER BY created_at`, params);
  return rows;
}

export async function registerEntityType(
  pool: pg.Pool,
  projectId: string,
  input: { name: string; description: string; prop_schema?: Record<string, unknown> | undefined },
): Promise<{ id: string; name: string }> {
  try {
    const { rows } = await pool.query(
      `INSERT INTO entity_types (project_id, name, description, prop_schema)
       VALUES ($1, $2, $3, $4) RETURNING id, name`,
      [projectId, input.name, input.description,
       input.prop_schema ? JSON.stringify(input.prop_schema) : null],
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'entity_type_taken', `entity type "${input.name}" already exists`);
    }
    throw err;
  }
}

export async function listEntityTypes(
  pool: pg.Pool,
  projectId: string,
): Promise<Array<{ name: string; description: string; prop_schema: unknown }>> {
  const { rows } = await pool.query(
    'SELECT name, description, prop_schema FROM entity_types WHERE project_id = $1 ORDER BY name',
    [projectId],
  );
  return rows;
}

export interface Funnel {
  id: string;
  key: string;
  name: string;
  goal: string;
  steps: Array<{ metric_key: string; label: string }>;
  window_seconds: number;
}

export async function defineFunnel(
  pool: pg.Pool,
  projectId: string,
  input: DefineFunnelInput,
): Promise<Funnel> {
  // Funnel steps reference registry metrics, never raw events: this is how
  // funnels inherit semantics. Validate every step resolves to an event-based metric.
  for (const step of input.steps) {
    const metric = await getMetric(pool, projectId, step.metric_key).catch(() => null);
    if (!metric) {
      throw badRequest(
        'unknown_step_metric',
        `funnel step references metric "${step.metric_key}" which is not in the registry`,
        'register the metric first with register_metric, then define the funnel',
      );
    }
    if (metric.type === 'conversion' || metric.type === 'state') {
      throw badRequest(
        'invalid_step_metric',
        `funnel step "${step.metric_key}" has type=${metric.type}; steps must be event-based (count, unique_actors, value)`,
      );
    }
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO funnels (project_id, key, name, goal, steps, window_seconds)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, key, name, goal, steps, window_seconds`,
      [projectId, input.key, input.name, input.goal, JSON.stringify(input.steps), input.window_seconds],
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'funnel_key_taken', `funnel "${input.key}" already exists`);
    }
    throw err;
  }
}

/**
 * Hard-delete a metric. Refuses if any funnel still references it, so the
 * delete can never silently orphan a funnel step. (Prefer `deprecated` for
 * routine retirement — delete is for genuine cleanup.)
 */
export async function deleteMetric(pool: pg.Pool, projectId: string, key: string): Promise<{ key: string }> {
  await getMetric(pool, projectId, key); // 404 if absent
  const { rows } = await pool.query(
    `SELECT key FROM funnels WHERE project_id = $1 AND steps @> $2::jsonb`,
    [projectId, JSON.stringify([{ metric_key: key }])],
  );
  if (rows.length > 0) {
    throw new ApiError(
      409,
      'metric_in_use',
      `metric "${key}" is referenced by funnel(s): ${rows.map((r) => r.key).join(', ')}`,
      'delete or edit those funnels first, or deprecate the metric instead of deleting it',
    );
  }
  await pool.query('DELETE FROM metrics WHERE project_id = $1 AND key = $2', [projectId, key]);
  return { key };
}

export async function deleteFunnel(pool: pg.Pool, projectId: string, key: string): Promise<{ key: string }> {
  const { rowCount } = await pool.query(
    'DELETE FROM funnels WHERE project_id = $1 AND key = $2',
    [projectId, key],
  );
  if (!rowCount) throw notFound('funnel', `no funnel "${key}"`);
  return { key };
}

export async function getFunnel(pool: pg.Pool, projectId: string, key: string): Promise<Funnel> {
  const { rows } = await pool.query(
    'SELECT id, key, name, goal, steps, window_seconds FROM funnels WHERE project_id = $1 AND key = $2',
    [projectId, key],
  );
  if (!rows[0]) {
    throw notFound('funnel', `no funnel "${key}" — call list_funnels or define_funnel`);
  }
  return rows[0];
}

export async function listFunnels(pool: pg.Pool, projectId: string): Promise<Funnel[]> {
  const { rows } = await pool.query(
    'SELECT id, key, name, goal, steps, window_seconds FROM funnels WHERE project_id = $1 ORDER BY created_at',
    [projectId],
  );
  return rows;
}

/**
 * Event names covered by active metrics — the basis for the `registered`
 * flag at ingest. Conversion metrics register both their from and to events.
 */
export async function registeredEventNames(pool: pg.Pool, projectId: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT type, source FROM metrics WHERE project_id = $1 AND status = 'active'`,
    [projectId],
  );
  const names = new Set<string>();
  for (const row of rows) {
    if (row.type === 'conversion') {
      names.add(row.source.from.event);
      names.add(row.source.to.event);
    } else if (row.type !== 'state') {
      names.add(row.source.event);
    }
  }
  return names;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
