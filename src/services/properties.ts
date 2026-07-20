import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import {
  propertyDefinitionSchema,
  type PropertyDefinitionInput,
  type UpdatePropertyDefinitionInput,
} from '../schemas.js';

export interface PropertyDefinition {
  id: string;
  key: string;
  scope: 'event' | 'actor' | 'entity';
  value_type: 'string' | 'number' | 'boolean' | 'datetime' | 'enum';
  purpose: string;
  status: 'proposed' | 'trusted' | 'untrusted';
  source: 'native' | 'posthog';
  source_connection_id: string | null;
  enum_values: string[] | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const COLS = `id, key, scope, value_type, purpose, status, source,
  source_connection_id, enum_values, created_by, created_at, updated_at`;

export async function createPropertyDefinition(
  pool: pg.Pool,
  projectId: string,
  input: PropertyDefinitionInput,
  actor: string,
): Promise<PropertyDefinition> {
  await assertSourceConnection(pool, projectId, input);
  try {
    const { rows } = await pool.query<PropertyDefinition>(
      `INSERT INTO property_definitions (
         project_id, key, scope, value_type, purpose, status, source,
         source_connection_id, enum_values, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLS}`,
      [
        projectId,
        input.key,
        input.scope,
        input.value_type,
        input.purpose,
        input.status,
        input.source,
        input.source_connection_id ?? null,
        input.enum_values ? JSON.stringify(input.enum_values) : null,
        actor,
      ],
    );
    return rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(
        409,
        'property_key_taken',
        `property "${input.scope}.${input.key}" already exists`,
        'update the existing definition instead of creating a second meaning',
      );
    }
    throw error;
  }
}

export async function listPropertyDefinitions(
  pool: pg.Pool,
  projectId: string,
  filter: { scope?: string; status?: string } = {},
): Promise<PropertyDefinition[]> {
  const params: unknown[] = [projectId];
  let sql = `SELECT ${COLS} FROM property_definitions WHERE project_id = $1`;
  if (filter.scope) {
    params.push(filter.scope);
    sql += ` AND scope = $${params.length}`;
  }
  if (filter.status) {
    params.push(filter.status);
    sql += ` AND status = $${params.length}`;
  }
  const { rows } = await pool.query<PropertyDefinition>(
    sql + ' ORDER BY scope, key',
    params,
  );
  return rows;
}

export async function updatePropertyDefinition(
  pool: pg.Pool,
  projectId: string,
  scope: PropertyDefinition['scope'],
  key: string,
  patch: UpdatePropertyDefinitionInput,
): Promise<PropertyDefinition> {
  const existing = await getPropertyDefinition(pool, projectId, scope, key);
  const merged = propertyDefinitionSchema.parse({
    key: existing.key,
    scope: existing.scope,
    value_type: patch.value_type ?? existing.value_type,
    purpose: patch.purpose ?? existing.purpose,
    status: patch.status ?? existing.status,
    source: existing.source,
    ...(existing.source_connection_id
      ? { source_connection_id: existing.source_connection_id }
      : {}),
    ...((patch.enum_values === null ? undefined : patch.enum_values) ?? existing.enum_values
      ? { enum_values: (patch.enum_values === null ? undefined : patch.enum_values) ?? existing.enum_values ?? undefined }
      : {}),
  });
  const { rows } = await pool.query<PropertyDefinition>(
    `UPDATE property_definitions SET
       value_type = $4,
       purpose = $5,
       status = $6,
       enum_values = $7,
       updated_at = now()
     WHERE project_id = $1 AND scope = $2 AND key = $3
     RETURNING ${COLS}`,
    [
      projectId,
      scope,
      key,
      merged.value_type,
      merged.purpose,
      merged.status,
      merged.enum_values ? JSON.stringify(merged.enum_values) : null,
    ],
  );
  if (!rows[0]) throw notFound('property_definition');
  return rows[0];
}

export async function getPropertyDefinition(
  pool: pg.Pool,
  projectId: string,
  scope: PropertyDefinition['scope'],
  key: string,
): Promise<PropertyDefinition> {
  const { rows } = await pool.query<PropertyDefinition>(
    `SELECT ${COLS} FROM property_definitions
     WHERE project_id = $1 AND scope = $2 AND key = $3`,
    [projectId, scope, key],
  );
  if (!rows[0]) throw notFound('property_definition');
  return rows[0];
}

async function assertSourceConnection(
  pool: pg.Pool,
  projectId: string,
  input: PropertyDefinitionInput,
): Promise<void> {
  if (input.source !== 'posthog') return;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM source_connections
     WHERE project_id = $1 AND id = $2 AND provider = 'posthog'`,
    [projectId, input.source_connection_id],
  );
  if (!rowCount) {
    throw notFound(
      'source_connection',
      'configure and verify the PostHog source in this project first',
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { code?: string }).code === '23505';
}
