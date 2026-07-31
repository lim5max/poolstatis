import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { ApiError, notFound } from '../errors.js';
import type {
  CreateExperienceSurfaceInput,
  ExperienceCaptureInput,
  ExperienceSnapshotMetaInput,
  RegisterExperienceRouteInput,
} from '../schemas.js';
import type { ArtifactStore } from '../stores/artifactStore.js';
import type { EventStore, StorableEvent } from '../stores/eventStore.js';

export interface ExperienceSurface {
  id: string;
  key: string;
  name: string;
  purpose: string;
  status: 'active' | 'archived';
  created_at: string | Date;
  updated_at: string | Date;
  last_capture_at?: string | Date | null;
}

export interface ExperienceRoute {
  id: string;
  surface_key: string;
  key: string;
  name: string;
  path_pattern: string;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ExperienceSnapshot {
  id: string;
  surface_key: string;
  route_key: string;
  env: string;
  version: string;
  device: 'desktop' | 'mobile';
  release_hash: string;
  mime_type: 'image/png' | 'image/webp';
  byte_size: number;
  width: number;
  height: number;
  viewport_width: number;
  viewport_height: number;
  document_width: number;
  document_height: number;
  captured_at: string | Date;
  expires_at: string | Date;
  created_at: string | Date;
  evidence_ref: string;
  stale: boolean;
}

const SURFACE_COLS = 'id, key, name, purpose, status, created_at, updated_at';
const SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;

export async function createExperienceSurface(
  pool: pg.Pool,
  projectId: string,
  input: CreateExperienceSurfaceInput,
): Promise<ExperienceSurface> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<ExperienceSurface>(
      `INSERT INTO experience_surfaces (project_id, key, name, purpose)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SURFACE_COLS}`,
      [projectId, input.key, input.name, input.purpose],
    );
    await client.query(
      `INSERT INTO experience_routes (project_id, surface_id, key, name, path_pattern)
       VALUES ($1, $2, $3, $4, $5)`,
      [projectId, rows[0]!.id, input.key, input.name, input.route_pattern ?? `/${input.key}`],
    );
    await client.query('COMMIT');
    return rows[0]!;
  } catch (err) {
    await client.query('ROLLBACK');
    if (isUniqueViolation(err)) {
      throw new ApiError(409, 'experience_surface_key_taken', `experience surface "${input.key}" already exists`);
    }
    throw err;
  } finally {
    client.release();
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

export async function listExperienceSurfaces(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  env: string,
): Promise<ExperienceSurface[]> {
  const { rows } = await pool.query<ExperienceSurface>(
    `SELECT ${SURFACE_COLS} FROM experience_surfaces WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  const lastCaptures = await eventStore.experienceLastCaptures(projectId, env, rows.map((surface) => surface.key));
  return rows.map((surface) => ({
    ...surface,
    last_capture_at: lastCaptures[surface.key] ?? null,
  }));
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

export async function registerExperienceRoute(
  pool: pg.Pool,
  projectId: string,
  surfaceKey: string,
  input: RegisterExperienceRouteInput,
): Promise<ExperienceRoute> {
  const surface = await getExperienceSurface(pool, projectId, surfaceKey);
  try {
    const { rows } = await pool.query<ExperienceRoute>(
      `INSERT INTO experience_routes (project_id, surface_id, key, name, path_pattern)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, $6::text AS surface_key, key, name, path_pattern, created_at, updated_at`,
      [projectId, surface.id, input.key, input.name, input.path_pattern, surface.key],
    );
    return rows[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, 'experience_route_key_taken', `route "${input.key}" already exists for surface "${surfaceKey}"`);
    }
    throw error;
  }
}

export async function listExperienceRoutes(
  pool: pg.Pool,
  projectId: string,
  surfaceKey?: string,
): Promise<ExperienceRoute[]> {
  const params: unknown[] = [projectId];
  const surfaceFilter = surfaceKey ? ' AND s.key = $2' : '';
  if (surfaceKey) params.push(surfaceKey);
  const { rows } = await pool.query<ExperienceRoute>(
    `SELECT r.id, s.key AS surface_key, r.key, r.name, r.path_pattern, r.created_at, r.updated_at
     FROM experience_routes r
     JOIN experience_surfaces s ON s.id = r.surface_id
     WHERE r.project_id = $1${surfaceFilter}
     ORDER BY s.key, r.created_at
     LIMIT 500`,
    params,
  );
  return rows;
}

export async function getExperienceRoute(
  pool: pg.Pool,
  projectId: string,
  surfaceKey: string,
  routeKey: string,
): Promise<ExperienceRoute> {
  const { rows } = await pool.query<ExperienceRoute>(
    `SELECT r.id, s.key AS surface_key, r.key, r.name, r.path_pattern, r.created_at, r.updated_at
     FROM experience_routes r
     JOIN experience_surfaces s ON s.id = r.surface_id
     WHERE r.project_id = $1 AND s.key = $2 AND r.key = $3`,
    [projectId, surfaceKey, routeKey],
  );
  if (!rows[0]) throw notFound('experience_route', `route "${routeKey}" is not registered for surface "${surfaceKey}"`);
  return rows[0];
}

export async function createExperienceSnapshot(
  pool: pg.Pool,
  artifacts: ArtifactStore,
  projectId: string,
  input: ExperienceSnapshotMetaInput,
  mimeType: string,
  bytes: Buffer,
): Promise<ExperienceSnapshot> {
  if (bytes.length === 0 || bytes.length > SNAPSHOT_MAX_BYTES) {
    throw new ApiError(413, 'snapshot_size_invalid', `snapshot must be between 1 byte and ${SNAPSHOT_MAX_BYTES} bytes`);
  }
  if (mimeType !== 'image/png' && mimeType !== 'image/webp') {
    throw new ApiError(415, 'snapshot_type_invalid', 'snapshot must be image/png or image/webp');
  }
  const dimensions = inspectImage(bytes, mimeType);
  const horizontalScale = dimensions.width / input.document_width;
  const verticalScale = dimensions.height / input.document_height;
  if (
    horizontalScale < 0.1
    || verticalScale < 0.1
    || Math.abs(horizontalScale - verticalScale) / Math.max(horizontalScale, verticalScale) > 0.02
  ) {
    throw new ApiError(
      400,
      'snapshot_layout_invalid',
      'physical image dimensions must use one consistent scale for the declared CSS document dimensions',
    );
  }
  const [surface, route] = await Promise.all([
    getExperienceSurface(pool, projectId, input.surface),
    getExperienceRoute(pool, projectId, input.surface, input.route),
  ]);
  const id = randomUUID();
  const extension = mimeType === 'image/png' ? 'png' : 'webp';
  const artifactKey = `${projectId}/${id}.${extension}`;
  const capturedAt = new Date(input.captured_at);
  const expiresAt = new Date(capturedAt.getTime() + input.retention_days * 86_400_000);
  await artifacts.put(artifactKey, bytes);
  try {
    await pool.query(
      `INSERT INTO experience_snapshots (
         id, project_id, surface_id, route_id, env, version, device, release_hash,
         artifact_key, mime_type, byte_size, width, height, viewport_width,
         viewport_height, document_width, document_height, captured_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id, projectId, surface.id, route.id, input.env, input.version, input.device, input.release_hash,
        artifactKey, mimeType, bytes.length, dimensions.width, dimensions.height,
        input.viewport_width, input.viewport_height, input.document_width,
        input.document_height, capturedAt, expiresAt,
      ],
    );
  } catch (error) {
    await artifacts.delete(artifactKey);
    throw error;
  }
  return getExperienceSnapshot(pool, projectId, id);
}

export async function listExperienceSnapshots(
  pool: pg.Pool,
  projectId: string,
  filters: { surface?: string; route?: string; env?: string } = {},
  now = new Date(),
): Promise<ExperienceSnapshot[]> {
  const params: unknown[] = [projectId];
  const predicates = ['x.project_id = $1'];
  for (const [column, value] of [
    ['s.key', filters.surface],
    ['r.key', filters.route],
    ['x.env', filters.env],
  ] as const) {
    if (value) {
      params.push(value);
      predicates.push(`${column} = $${params.length}`);
    }
  }
  const { rows } = await pool.query<Omit<ExperienceSnapshot, 'evidence_ref' | 'stale'>>(
    `SELECT x.id, s.key AS surface_key, r.key AS route_key, x.env, x.version, x.device,
            x.release_hash, x.mime_type, x.byte_size, x.width, x.height,
            x.viewport_width, x.viewport_height, x.document_width, x.document_height,
            x.captured_at, x.expires_at, x.created_at
     FROM experience_snapshots x
     JOIN experience_surfaces s ON s.id = x.surface_id
     JOIN experience_routes r ON r.id = x.route_id
     WHERE ${predicates.join(' AND ')}
     ORDER BY x.captured_at DESC
     LIMIT 500`,
    params,
  );
  return rows.map((row) => snapshotPublic(row, now));
}

export async function getExperienceSnapshot(
  pool: pg.Pool,
  projectId: string,
  id: string,
  now = new Date(),
): Promise<ExperienceSnapshot> {
  const { rows } = await pool.query<Omit<ExperienceSnapshot, 'evidence_ref' | 'stale'>>(
    `SELECT x.id, s.key AS surface_key, r.key AS route_key, x.env, x.version, x.device,
            x.release_hash, x.mime_type, x.byte_size, x.width, x.height,
            x.viewport_width, x.viewport_height, x.document_width, x.document_height,
            x.captured_at, x.expires_at, x.created_at
     FROM experience_snapshots x
     JOIN experience_surfaces s ON s.id = x.surface_id
     JOIN experience_routes r ON r.id = x.route_id
     WHERE x.project_id = $1 AND x.id = $2`,
    [projectId, id],
  );
  if (!rows[0]) throw notFound('experience_snapshot');
  return snapshotPublic(rows[0], now);
}

export async function getExactExperienceSnapshot(
  pool: pg.Pool,
  projectId: string,
  filters: {
    surface: string;
    route: string;
    env: string;
    version: string;
    device: 'desktop' | 'mobile';
  },
  now = new Date(),
): Promise<ExperienceSnapshot | null> {
  const { rows } = await pool.query<Omit<ExperienceSnapshot, 'evidence_ref' | 'stale'>>(
    `SELECT x.id, s.key AS surface_key, r.key AS route_key, x.env, x.version, x.device,
            x.release_hash, x.mime_type, x.byte_size, x.width, x.height,
            x.viewport_width, x.viewport_height, x.document_width, x.document_height,
            x.captured_at, x.expires_at, x.created_at
     FROM experience_snapshots x
     JOIN experience_surfaces s ON s.id = x.surface_id
     JOIN experience_routes r ON r.id = x.route_id
     WHERE x.project_id = $1 AND s.key = $2 AND r.key = $3 AND x.env = $4
       AND x.version = $5 AND x.device = $6
     ORDER BY x.captured_at DESC
     LIMIT 1`,
    [projectId, filters.surface, filters.route, filters.env, filters.version, filters.device],
  );
  return rows[0] ? snapshotPublic(rows[0], now) : null;
}

export async function readExperienceSnapshot(
  pool: pg.Pool,
  artifacts: ArtifactStore,
  projectId: string,
  id: string,
): Promise<{ snapshot: ExperienceSnapshot; bytes: Buffer }> {
  const snapshot = await getExperienceSnapshot(pool, projectId, id);
  const { rows } = await pool.query<{ artifact_key: string }>(
    'SELECT artifact_key FROM experience_snapshots WHERE project_id = $1 AND id = $2',
    [projectId, id],
  );
  return { snapshot, bytes: await artifacts.get(rows[0]!.artifact_key) };
}

export async function deleteExperienceSnapshot(
  pool: pg.Pool,
  artifacts: ArtifactStore,
  projectId: string,
  id: string,
): Promise<void> {
  const { rows } = await pool.query<{ artifact_key: string }>(
    'SELECT artifact_key FROM experience_snapshots WHERE project_id = $1 AND id = $2',
    [projectId, id],
  );
  if (!rows[0]) throw notFound('experience_snapshot');
  await artifacts.delete(rows[0].artifact_key);
  const deleted = await pool.query(
    'DELETE FROM experience_snapshots WHERE project_id = $1 AND id = $2',
    [projectId, id],
  );
  if (!deleted.rowCount) throw notFound('experience_snapshot');
}

/** Project/env-scoped artifact purge used by the irreversible data purge API. */
export async function purgeExperienceSnapshots(
  pool: pg.Pool,
  artifacts: ArtifactStore,
  projectId: string,
  env: string,
): Promise<number> {
  let deleted = 0;
  while (true) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM experience_snapshots
       WHERE project_id = $1 AND env = $2
       ORDER BY id
       LIMIT 100`,
      [projectId, env],
    );
    if (rows.length === 0) return deleted;
    for (const row of rows) {
      await deleteExperienceSnapshot(pool, artifacts, projectId, row.id);
      deleted += 1;
    }
  }
}

/** Convert the narrow browser wire protocol into immutable analytics events. */
export async function captureExperienceEvents(
  pool: pg.Pool,
  eventStore: EventStore,
  projectId: string,
  env: string,
  input: ExperienceCaptureInput,
  now = new Date(),
): Promise<{ accepted: number; duplicate?: boolean; warnings?: import('../stores/eventStore.js').UsageWarning[] }> {
  const surface = await getExperienceSurface(pool, projectId, input.surface);
  if (surface.status !== 'active') {
    throw new ApiError(
      409,
      'experience_surface_not_active',
      `experience surface "${input.surface}" is ${surface.status}`,
      'create a new surface or reactivate this one through an explicit future migration',
    );
  }
  const routeKeys = [...new Set(input.events.map((item) => item.route))];
  const { rows: registeredRoutes } = await pool.query<{ key: string }>(
    `SELECT r.key FROM experience_routes r
     WHERE r.project_id = $1 AND r.surface_id = $2 AND r.key = ANY($3::text[])`,
    [projectId, surface.id, routeKeys],
  );
  if (registeredRoutes.length !== routeKeys.length) {
    throw new ApiError(400, 'experience_route_not_registered', 'every captured route must be registered for this surface');
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
      properties: {
        surface: input.surface,
        route: item.route,
        version: item.version,
        device: item.device,
        viewport_width: item.viewport_width,
        viewport_height: item.viewport_height,
        document_width: item.document_width,
        document_height: item.document_height,
        sequence: item.sequence,
      },
    };
    switch (item.kind) {
      case 'page_viewed':
        return { ...base, event: 'experience.page_viewed' };
      case 'element_clicked':
        return {
          ...base,
          event: 'experience.element_clicked',
          properties: {
            ...base.properties,
            label: item.label,
            x: item.x,
            y: item.y,
            viewport_x: item.viewport_x ?? item.x,
            viewport_y: item.viewport_y ?? item.y,
          },
        };
      case 'scroll_depth':
        return { ...base, event: 'experience.scroll_depth', properties: { ...base.properties, depth: item.depth } };
      case 'section_exposed':
        return {
          ...base,
          event: 'experience.section_exposed',
          properties: { ...base.properties, section: item.section, top: item.top },
        };
      case 'client_error':
        return { ...base, event: 'experience.client_error', properties: { ...base.properties, error_type: item.error_type } };
    }
  });
  const appended = await eventStore.appendIdempotent({
    dedupe: 'experience', projectId, env, batchId: input.batch_id, events,
  });
  return appended.duplicate ? { accepted: 0, duplicate: true } : {
    accepted: appended.inserted,
    ...(appended.warnings?.length ? { warnings: appended.warnings } : {}),
  };
}

function snapshotPublic(
  row: Omit<ExperienceSnapshot, 'evidence_ref' | 'stale'>,
  now: Date,
): ExperienceSnapshot {
  const captured = new Date(row.captured_at);
  const expires = new Date(row.expires_at);
  return {
    ...row,
    evidence_ref: `poolstatis://experience/snapshots/${row.id}`,
    stale: expires <= now || now.getTime() - captured.getTime() > 30 * 86_400_000,
  };
}

function inspectImage(bytes: Buffer, mimeType: string): { width: number; height: number } {
  if (mimeType === 'image/png') {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(png) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
      throw new ApiError(400, 'snapshot_content_invalid', 'body is not a valid PNG header');
    }
    return validateDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (
    bytes.length < 30
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    throw new ApiError(400, 'snapshot_content_invalid', 'body is not a valid WebP header');
  }
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    return validateDimensions(width, height);
  }
  if (
    chunk === 'VP8 '
    && bytes.length >= 30
    && bytes[23] === 0x9d
    && bytes[24] === 0x01
    && bytes[25] === 0x2a
  ) {
    return validateDimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const width = 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8);
    const height = 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10);
    return validateDimensions(width, height);
  }
  throw new ApiError(400, 'snapshot_content_invalid', 'body is not a supported WebP image');
}

function validateDimensions(width: number, height: number): { width: number; height: number } {
  if (width < 1 || width > 10_000 || height < 1 || height > 50_000) {
    throw new ApiError(400, 'snapshot_dimensions_invalid', 'snapshot dimensions exceed 10000 × 50000');
  }
  return { width, height };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
