import type pg from 'pg';
import { ApiError } from '../errors.js';
import type { z } from 'zod';
import type { notificationDestinationInputSchema } from './automationSchemas.js';

export type NotificationDestinationInput = z.infer<typeof notificationDestinationInputSchema>;

export interface NotificationDestination {
  id: string;
  key: string;
  name: string;
  kind: 'in_product' | 'outbox';
  status: 'active' | 'disabled';
  created_by: string;
  created_at: string;
  updated_at: string;
}

export const notificationCapabilities = Object.freeze({
  in_product: 'configured' as const,
  outbox: 'configured' as const,
  external: 'not_configured' as const,
});

export async function createNotificationDestination(
  pool: pg.Pool, projectId: string, input: NotificationDestinationInput, actor: string,
): Promise<NotificationDestination> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<Record<string, unknown>>(
      `INSERT INTO notification_destinations (project_id, key, name, kind, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [projectId, input.key, input.name, input.kind, actor],
    );
    const destination = mapDestination(rows[0]!);
    await auditDestination(client, projectId, destination, 'created', actor);
    await client.query('COMMIT');
    return destination;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (isUnique(error)) throw new ApiError(409, 'notification_destination_key_taken', `destination "${input.key}" already exists`);
    throw error;
  } finally { client.release(); }
}

export async function listNotificationDestinations(pool: pg.Pool, projectId: string): Promise<NotificationDestination[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT * FROM notification_destinations WHERE project_id = $1 ORDER BY created_at, id', [projectId],
  );
  return rows.map(mapDestination);
}

export async function requireDestinationIds(pool: pg.PoolClient, projectId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM notification_destinations
     WHERE project_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`, [projectId, ids],
  );
  if (rows.length !== ids.length) throw new ApiError(400, 'notification_destination_invalid', 'every destination must be active and belong to this project');
}

export async function transitionNotificationDestination(
  pool: pg.Pool, projectId: string, id: string, status: 'active' | 'disabled', actor: string,
): Promise<NotificationDestination> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE notification_destinations SET status = $3, updated_at = now()
       WHERE project_id = $1 AND id = $2 RETURNING *`, [projectId, id, status],
    );
    if (!rows[0]) throw new ApiError(404, 'notification_destination_not_found', 'notification destination not found');
    const destination = mapDestination(rows[0]);
    if (status === 'disabled') {
      await client.query(
        `UPDATE notification_deliveries SET status = 'not_configured', lease_until = NULL, updated_at = now()
         WHERE project_id = $1 AND destination_id = $2 AND status IN ('pending','failed')`, [projectId, id],
      );
    }
    await auditDestination(client, projectId, destination, status === 'active' ? 'enabled' : 'disabled', actor);
    await client.query('COMMIT'); return destination;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

function mapDestination(row: Record<string, unknown>): NotificationDestination {
  return {
    id: String(row.id), key: String(row.key), name: String(row.name),
    kind: row.kind as NotificationDestination['kind'], status: row.status as NotificationDestination['status'],
    created_by: String(row.created_by), created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}
function iso(value: unknown): string { return new Date(value as string | Date).toISOString(); }
function isUnique(error: unknown): boolean { return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505'); }
async function auditDestination(client: pg.PoolClient, projectId: string, destination: NotificationDestination, event: string, actor: string) {
  await client.query(
    `INSERT INTO notification_destination_audit (project_id, destination_id, event, actor, snapshot)
     VALUES ($1,$2,$3,$4,$5)`, [projectId, destination.id, event, actor, JSON.stringify(destination)],
  );
}
