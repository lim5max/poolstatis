import type pg from 'pg';
import { ApiError, notFound } from '../errors.js';
import type { CreateExperienceSurfaceInput, ExperienceCaptureInput } from '../schemas.js';
import type { EventStore, StorableEvent } from '../stores/eventStore.js';

export interface ExperienceSurface {
  id: string;
  key: string;
  name: string;
  purpose: string;
  status: 'active' | 'archived';
  created_at: string | Date;
  updated_at: string | Date;
}

const SURFACE_COLS = 'id, key, name, purpose, status, created_at, updated_at';

export async function createExperienceSurface(
  pool: pg.Pool,
  projectId: string,
  input: CreateExperienceSurfaceInput,
): Promise<ExperienceSurface> {
  try {
    const { rows } = await pool.query<ExperienceSurface>(
      `INSERT INTO experience_surfaces (project_id, key, name, purpose)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SURFACE_COLS}`,
      [projectId, input.key, input.name, input.purpose],
    );
    return rows[0]!;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'experience_surface_key_taken', `experience surface "${input.key}" already exists`);
    }
    throw err;
  }
}

export async function getExperienceSurface(
  pool: pg.Pool,
  projectId: string,
  key: string,
): Promise<ExperienceSurface> {
  const { rows } = await pool.query<ExperienceSurface>(
    `SELECT ${SURFACE_COLS} FROM experience_surfaces WHERE project_id = $1 AND key = $2`,
    [projectId, key],
  );
  if (!rows[0]) {
    throw notFound('experience_surface', `no experience surface "${key}" in this project — create it before enabling BrowserExperience`);
  }
  return rows[0];
}

export async function listExperienceSurfaces(pool: pg.Pool, projectId: string): Promise<ExperienceSurface[]> {
  const { rows } = await pool.query<ExperienceSurface>(
    `SELECT ${SURFACE_COLS} FROM experience_surfaces WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows;
}

export async function archiveExperienceSurface(pool: pg.Pool, projectId: string, key: string): Promise<ExperienceSurface> {
  const { rows } = await pool.query<ExperienceSurface>(
    `UPDATE experience_surfaces SET status = 'archived', updated_at = now()
     WHERE project_id = $1 AND key = $2
     RETURNING ${SURFACE_COLS}`,
    [projectId, key],
  );
  if (!rows[0]) throw notFound('experience_surface');
  return rows[0];
}

/** Convert the narrow consent-gated wire protocol into immutable analytics events. */
export async function captureExperienceEvents(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  env: string,
  input: ExperienceCaptureInput,
  now = new Date(),
): Promise<{ accepted: number; duplicate?: boolean }> {
  const surface = await getExperienceSurface(pool, projectId, input.surface);
  if (surface.status !== 'active') {
    throw new ApiError(
      409,
      'experience_surface_not_active',
      `experience surface "${input.surface}" is ${surface.status}`,
      'create a new surface or reactivate this one through an explicit future migration',
    );
  }
  const events: StorableEvent[] = input.events.map((item) => {
    const base = {
      projectId,
      env,
      timestamp: now,
      distinctId: item.distinct_id,
      sessionId: item.session_id,
      registered: true,
      eventSource: 'experience' as const,
      properties: { surface: input.surface, route: item.route, sequence: item.sequence },
    };
    switch (item.kind) {
      case 'page_viewed':
        return { ...base, event: 'experience.page_viewed' };
      case 'element_clicked':
        return { ...base, event: 'experience.element_clicked', properties: { ...base.properties, label: item.label, x: item.x, y: item.y } };
      case 'scroll_depth':
        return { ...base, event: 'experience.scroll_depth', properties: { ...base.properties, depth: item.depth } };
      case 'client_error':
        return { ...base, event: 'experience.client_error', properties: { ...base.properties, error_type: item.error_type } };
    }
  });
  const appended = await eventStore.appendIdempotent({
    dedupe: 'experience', projectId, env, batchId: input.batch_id, events,
  });
  return appended ? { accepted: events.length } : { accepted: 0, duplicate: true };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
