import type pg from 'pg';
import { generateToken, type KeyKind } from '../keys.js';
import { notFound } from '../errors.js';

export interface Project {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  timezone: string;
  retention_months: number;
}

export type CreateApiKeyInput =
  | { orgId: string; projectId: null; kind: 'personal'; env?: string; label?: string; issuedByUserId: string; legacySelfHost?: never }
  | { orgId: string; projectId: null; kind: 'personal'; env?: string; label?: string; legacySelfHost: true; issuedByUserId?: never }
  | { orgId: string; projectId: string; kind: 'ingest' | 'secret'; env?: string; label?: string; issuedByUserId?: never };

export async function createOrganization(pool: pg.Pool, name: string): Promise<{ id: string }> {
  const { rows } = await pool.query(
    'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
    [name],
  );
  return { id: rows[0].id };
}

export async function createProject(
  pool: pg.Pool,
  orgId: string,
  slug: string,
  name: string,
): Promise<Project> {
  const { rows } = await pool.query(
    `INSERT INTO projects (org_id, slug, name) VALUES ($1, $2, $3)
     RETURNING id, org_id, slug, name, timezone, retention_months`,
    [orgId, slug, name],
  );
  return rows[0];
}

export async function deleteProject(
  pool: pg.Pool,
  orgId: string,
  slug: string,
): Promise<Project> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<Project>(
      `SELECT id, org_id, slug, name, timezone, retention_months
       FROM projects
       WHERE org_id = $1 AND slug = $2
       FOR UPDATE`,
      [orgId, slug],
    );
    const project = rows[0];
    if (!project) throw notFound('project', `no project with slug "${slug}" in this organization`);
    const deleted = await client.query(
      'DELETE FROM projects WHERE org_id = $1 AND id = $2',
      [orgId, project.id],
    );
    if (deleted.rowCount !== 1) throw notFound('project');
    await client.query('COMMIT');
    return project;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createApiKey(
  pool: pg.Pool,
  opts: CreateApiKeyInput,
): Promise<{ id: string; token: string }> {
  if (opts.kind !== 'personal' && 'issuedByUserId' in opts && opts.issuedByUserId !== undefined) {
    throw new Error('issuedByUserId is only valid for personal keys');
  }
  if (opts.kind === 'personal' && !opts.issuedByUserId && opts.legacySelfHost !== true) {
    throw new Error('personal keys require issuedByUserId unless legacySelfHost is explicitly enabled');
  }
  const { token, hash } = generateToken(opts.kind);
  const { rows } = await pool.query(
    `INSERT INTO api_keys (
       org_id, project_id, kind, env, token_hash, label,
       issued_by_user_id, token_prefix, token_suffix
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      opts.orgId, opts.projectId, opts.kind, opts.env ?? 'prod', hash, opts.label ?? null,
      opts.issuedByUserId ?? null, `${token.slice(0, 3)}`, token.slice(-4),
    ],
  );
  return { id: rows[0].id, token };
}

export interface ApiKeyRow {
  id: string;
  kind: KeyKind;
  env: string;
  label: string | null;
  masked_token: string;
  created_at: string;
  revoked_at: string | null;
}

export interface PersonalApiKeyRow {
  id: string;
  label: string | null;
  token: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Personal credentials are scoped to their issuing hosted user and never reveal plaintext. */
export async function listPersonalApiKeys(
  pool: pg.Pool,
  orgId: string,
  userId: string,
): Promise<PersonalApiKeyRow[]> {
  const { rows } = await pool.query(
    `SELECT id, label, token_prefix, token_suffix, created_at, last_used_at, revoked_at
     FROM api_keys
     WHERE org_id = $1 AND issued_by_user_id = $2 AND kind = 'personal'
     ORDER BY created_at DESC`,
    [orgId, userId],
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    token: row.token_suffix ? `${row.token_prefix ?? 'pt_'}...${row.token_suffix}` : `${row.token_prefix ?? 'pt_'}...`,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  }));
}

export async function revokePersonalApiKey(
  pool: pg.Pool,
  orgId: string,
  userId: string,
  id: string,
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND org_id = $2 AND issued_by_user_id = $3
       AND kind = 'personal' AND revoked_at IS NULL`,
    [id, orgId, userId],
  );
  if (!rowCount) throw notFound('api_key', 'no active personal token with that id in this organization');
}

/** Keys for a project, masked — the token itself is shown only once at creation. */
export async function listApiKeys(pool: pg.Pool, projectId: string): Promise<ApiKeyRow[]> {
  const { rows } = await pool.query(
    `SELECT id, kind, env, label, token_prefix, token_suffix, created_at, revoked_at
     FROM api_keys WHERE project_id = $1 ORDER BY created_at DESC`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    env: row.env,
    label: row.label,
    masked_token: row.token_suffix
      ? `${row.token_prefix ?? (row.kind === 'ingest' ? 'pk_' : 'sk_')}...${row.token_suffix}`
      : `${row.token_prefix ?? (row.kind === 'ingest' ? 'pk_' : 'sk_')}...`,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  }));
}

export async function revokeApiKey(
  pool: pg.Pool,
  orgId: string,
  id: string,
  projectId: string,
): Promise<void> {
  // Scope to project_id as well as org_id: a secret key pinned to one project
  // must not be able to revoke another project's key in the same org.
  const { rowCount } = await pool.query(
    `UPDATE api_keys SET revoked_at = now()
     WHERE id = $1 AND org_id = $2 AND project_id = $3 AND revoked_at IS NULL`,
    [id, orgId, projectId],
  );
  if (!rowCount) throw notFound('api_key', 'no active key with that id in this project');
}

export interface ProjectWithStats extends Pick<Project, 'slug' | 'name' | 'timezone'> {
  active_metrics: number;
  funnels: number;
  events_30d: number;
}

export async function listProjectsWithStats(pool: pg.Pool, orgId: string): Promise<ProjectWithStats[]> {
  const { rows } = await pool.query(
    `SELECT p.slug, p.name, p.timezone,
       (SELECT count(*) FROM metrics m WHERE m.project_id = p.id AND m.status = 'active')::int AS active_metrics,
       (SELECT count(*) FROM funnels f WHERE f.project_id = p.id)::int AS funnels,
       (SELECT count(*) FROM events e WHERE e.project_id = p.id
          AND e."timestamp" >= now() - interval '30 days')::int AS events_30d
     FROM projects p WHERE p.org_id = $1 ORDER BY p.created_at`,
    [orgId],
  );
  return rows;
}

export async function getProjectBySlug(
  pool: pg.Pool,
  orgId: string,
  slug: string,
): Promise<Project> {
  const { rows } = await pool.query(
    `SELECT id, org_id, slug, name, timezone, retention_months
     FROM projects WHERE org_id = $1 AND slug = $2`,
    [orgId, slug],
  );
  if (!rows[0]) {
    throw notFound('project', `no project with slug "${slug}" in this organization — call list_projects`);
  }
  return rows[0];
}

export async function listProjects(pool: pg.Pool, orgId: string): Promise<Project[]> {
  const { rows } = await pool.query(
    `SELECT id, org_id, slug, name, timezone, retention_months
     FROM projects WHERE org_id = $1 ORDER BY created_at`,
    [orgId],
  );
  return rows;
}
