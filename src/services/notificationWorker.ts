import type pg from 'pg';
import type { AutomationWorkerOptions } from './automationWorkerShared.js';
import { errorCode, retryDelay } from './automationWorkerShared.js';

export interface NotificationEnvelope {
  schema_version: 1;
  kind: 'monitor_finding' | 'insight_feed';
  code: string;
  answer: { state: string; headline: string; takeaway: string };
  evidence: { state: string; as_of: string; [key: string]: unknown };
  action: { kind: 'open_control_tower'; resource_id: string };
}

export interface NotificationDeliveryAdapter {
  readonly kind: 'in_product' | 'outbox';
  deliver(client: pg.PoolClient, delivery: ClaimedDelivery): Promise<'delivered' | 'ready_for_extension'>;
}

interface ClaimedDelivery {
  id: string; project_id: string; destination_id: string; destination_kind: 'in_product' | 'outbox';
  payload: NotificationEnvelope; attempt_count: number;
}

export class NotificationWorker {
  private readonly adapters: Map<string, NotificationDeliveryAdapter>;

  constructor(private readonly pool: pg.Pool, private readonly options: AutomationWorkerOptions,
    adapters: NotificationDeliveryAdapter[] = [new InProductAdapter(), new OutboxAdapter()]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  async runOnce(now = new Date()): Promise<{ claimed: number; delivered: number; readyForExtension: number; failed: number; dead: number }> {
    const claimed = await this.claim(now);
    const result = { claimed: claimed.length, delivered: 0, readyForExtension: 0, failed: 0, dead: 0 };
    for (const delivery of claimed) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const adapter = this.adapters.get(delivery.destination_kind);
        if (!adapter) throw Object.assign(new Error('delivery adapter not configured'), { code: 'delivery_adapter_not_configured' });
        const status = await adapter.deliver(client, delivery);
        await client.query(
          `INSERT INTO notification_delivery_attempts (project_id, delivery_id, attempt, status)
           VALUES ($1,$2,$3,$4)`, [delivery.project_id, delivery.id, delivery.attempt_count, status],
        );
        await client.query(
          `UPDATE notification_deliveries SET status = $3, delivered_at = CASE WHEN $3 = 'delivered' THEN $4::timestamptz ELSE NULL END,
             lease_until = NULL, updated_at = now() WHERE project_id = $1 AND id = $2`,
          [delivery.project_id, delivery.id, status, now],
        );
        await client.query('COMMIT');
        if (status === 'delivered') result.delivered += 1; else result.readyForExtension += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const terminal = delivery.attempt_count >= this.options.maxAttempts;
        const code = errorCode(error, 'notification_delivery_failed');
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO notification_delivery_attempts (project_id, delivery_id, attempt, status, error_code)
             VALUES ($1,$2,$3,'failed',$4)`,
            [delivery.project_id, delivery.id, delivery.attempt_count, code],
          );
          await client.query(
            `UPDATE notification_deliveries SET status = $3, last_error_code = $4, lease_until = NULL,
               next_attempt_at = $5, updated_at = now() WHERE project_id = $1 AND id = $2`,
            [delivery.project_id, delivery.id, terminal ? 'dead' : 'failed', code,
              new Date(now.getTime() + retryDelay(this.options, delivery.attempt_count))],
          );
          await client.query('COMMIT');
        } catch (persistenceError) {
          await client.query('ROLLBACK').catch(() => {});
          throw persistenceError;
        }
        result[terminal ? 'dead' : 'failed'] += 1;
      } finally { client.release(); }
    }
    return result;
  }

  private async claim(now: Date): Promise<ClaimedDelivery[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ClaimedDelivery>(
        `WITH due AS (
           SELECT d.id FROM notification_deliveries d
           WHERE ($1::uuid IS NULL OR d.project_id = $1)
             AND d.next_attempt_at <= $2
             AND (d.status IN ('pending','failed') OR (d.status = 'delivering' AND d.lease_until <= $2))
           ORDER BY d.next_attempt_at, d.created_at, d.id FOR UPDATE OF d SKIP LOCKED LIMIT $3
         )
         UPDATE notification_deliveries d SET status = 'delivering', attempt_count = d.attempt_count + 1,
           lease_until = $4, updated_at = now()
         FROM due, notification_destinations n
         WHERE d.id = due.id AND n.project_id = d.project_id AND n.id = d.destination_id AND n.status = 'active'
         RETURNING d.id, d.project_id, d.destination_id, n.kind AS destination_kind, d.payload, d.attempt_count`,
        [this.options.projectId ?? null, now, this.options.batchSize, new Date(now.getTime() + this.options.leaseMs)],
      );
      await client.query('COMMIT');
      return rows;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}

export async function enqueueNotifications(
  client: pg.PoolClient, input: { projectId: string; destinationIds: string[]; findingId?: string; feedRunId?: string; payload: NotificationEnvelope; idempotencyKey: string },
): Promise<'queued' | 'not_configured'> {
  assertPrivacySafe(input.payload);
  const activeIds = await activeDestinationIds(client, input.projectId, input.destinationIds);
  if (activeIds.length === 0) {
    await client.query(
      `INSERT INTO notification_deliveries (project_id, finding_id, feed_run_id, payload, idempotency_key, status)
       VALUES ($1,$2,$3,$4,$5,'not_configured') ON CONFLICT (project_id, idempotency_key) DO NOTHING`,
      [input.projectId, input.findingId ?? null, input.feedRunId ?? null, JSON.stringify(input.payload), `${input.idempotencyKey}:not_configured`],
    );
    return 'not_configured';
  }
  for (const destinationId of activeIds) {
    await client.query(
      `INSERT INTO notification_deliveries (project_id, destination_id, finding_id, feed_run_id, payload, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (project_id, idempotency_key) DO NOTHING`,
      [input.projectId, destinationId, input.findingId ?? null, input.feedRunId ?? null,
        JSON.stringify(input.payload), `${input.idempotencyKey}:${destinationId}`],
    );
  }
  return 'queued';
}

export async function activeDestinationIds(client: pg.PoolClient, projectId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM notification_destinations
     WHERE project_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'`, [projectId, ids],
  );
  return rows.map((row) => row.id);
}

export function assertPrivacySafe(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) { value.forEach((item, index) => assertPrivacySafe(item, `${path}.${index}`)); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/actor|distinct|properties|credential|authorization|token|raw|url|path/i.test(key)) {
        throw Object.assign(new Error(`privacy excluded field at ${path}.${key}`), { code: 'notification_privacy_violation' });
      }
      assertPrivacySafe(item, `${path}.${key}`);
    }
  }
  if (typeof value === 'string' && /\b(?:pk|sk|pt)_[a-z0-9_-]{6,}\b/i.test(value)) {
    throw Object.assign(new Error(`token-like value at ${path}`), { code: 'notification_privacy_violation' });
  }
}

class InProductAdapter implements NotificationDeliveryAdapter {
  readonly kind = 'in_product' as const;
  async deliver(client: pg.PoolClient, delivery: ClaimedDelivery): Promise<'delivered'> {
    await client.query(
      `INSERT INTO notification_inbox (project_id, delivery_id, payload) VALUES ($1,$2,$3)
       ON CONFLICT (project_id, delivery_id) DO NOTHING`, [delivery.project_id, delivery.id, JSON.stringify(delivery.payload)],
    );
    return 'delivered';
  }
}

class OutboxAdapter implements NotificationDeliveryAdapter {
  readonly kind = 'outbox' as const;
  async deliver(): Promise<'ready_for_extension'> { return 'ready_for_extension'; }
}
