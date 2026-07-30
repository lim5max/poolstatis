import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { ApiError, notFound } from '../errors.js';
import type { WebhookDestinationInput } from '../schemas.js';
import type { DecisionAction } from './actions.js';
import { getDecision } from './decisions.js';
import { OutboundPolicyError, requestOutbound, resolveOutboundTarget, sanitizedOutboundError, type OutboundPolicyOptions } from '../security/outbound.js';

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface WebhookDestination {
  id: string;
  name: string;
  masked_url: string;
  status: 'configured' | 'verified' | 'error' | 'disabled';
  last_error: string | null;
  verified_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  destination_id: string;
  action_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: 'pending' | 'delivering' | 'delivered' | 'failed' | 'dead';
  attempt_count: number;
  next_attempt_at: string;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  attempts?: Array<Record<string, unknown>>;
}

export interface WebhookOutboxOptions {
  batchSize: number;
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
  leaseMs: number;
  requestTimeoutMs: number;
  /** Test/ops scope; production omits this to deliver every tenant. */
  projectId?: string;
}

interface InternalDestination extends WebhookDestination {
  destination_ciphertext: Buffer;
  destination_iv: Buffer;
  destination_tag: Buffer;
}

interface ClaimedDelivery extends WebhookDelivery {
  project_id: string;
  destination: InternalDestination;
}

export class WebhookService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly encryptionKey?: string,
    private readonly outboundPolicy: OutboundPolicyOptions = {},
  ) {}

  async configure(projectId: string, input: WebhookDestinationInput, actor: string): Promise<WebhookDestination> {
    try { await resolveOutboundTarget(input.url, this.outboundPolicy); }
    catch (error) {
      if (error instanceof OutboundPolicyError) throw new ApiError(400, error.code, 'webhook destination is not permitted');
      throw error;
    }
    const encrypted = encryptSecret(JSON.stringify({
      url: input.url,
      authorization: input.authorization ?? null,
    }), this.requireKey());
    try {
      const { rows } = await this.pool.query<Record<string, any>>(
        `INSERT INTO webhook_destinations (
           project_id, name, destination_ciphertext, destination_iv,
           destination_tag, masked_url, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [projectId, input.name, encrypted.ciphertext, encrypted.iv, encrypted.tag, maskUrl(input.url), actor],
      );
      return publicDestination(rows[0]!);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new ApiError(409, 'webhook_destination_name_taken', `webhook destination "${input.name}" already exists`);
      }
      throw error;
    }
  }

  async list(projectId: string): Promise<WebhookDestination[]> {
    const { rows } = await this.pool.query<Record<string, any>>(
      'SELECT * FROM webhook_destinations WHERE project_id = $1 ORDER BY created_at, id', [projectId],
    );
    return rows.map(publicDestination);
  }

  async enqueueTest(projectId: string, destinationId: string, actor: string): Promise<WebhookDelivery> {
    await this.getInternal(projectId, destinationId, true);
    return this.enqueue({
      projectId, destinationId, actionId: null, eventType: 'poolstatis.webhook.test',
      idempotencyKey: `webhook-test:${randomUUID()}`,
      payload: {
        event: 'poolstatis.webhook.test',
        impact: { summary: 'Explicit test delivery; no product decision or raw event data is included.' },
        requested_by: actor,
      },
    });
  }

  async enqueueAction(input: { projectId: string; action: DecisionAction; actor: string }): Promise<Record<string, unknown>> {
    const destination = await this.pool.query<{ id: string }>(
      `SELECT id FROM webhook_destinations
       WHERE project_id = $1 AND status = 'verified'
       ORDER BY created_at, id LIMIT 1`,
      [input.projectId],
    );
    if (!destination.rows[0]) {
      throw new ApiError(409, 'webhook_destination_required', 'a verified webhook destination is required before approving this action', 'configure and test a destination first');
    }
    const decision = await getDecision(this.pool, input.projectId, input.action.decision_id);
    const primary = decision.evidence.primary_evidence;
    const payload = {
      event: 'poolstatis.decision.action',
      impact: {
        expected_effect: input.action.expected_effect,
        accepted_outcome: decision.decision.accepted_outcome,
        metric_key: primary.metric.key,
        metric_purpose: primary.metric.purpose,
        baseline: primary.baseline.value,
        observed: primary.observed.value,
        relative_change: primary.change.relative,
        evidence_ready: decision.evidence.ready,
        trust: decision.evidence.trust.status,
      },
      decision: { id: decision.decision.id, release_id: decision.release.id },
      action: { id: input.action.id, type: input.action.action_type },
    };
    const delivery = await this.enqueue({
      projectId: input.projectId,
      destinationId: destination.rows[0].id,
      actionId: input.action.id,
      eventType: 'poolstatis.decision.action',
      idempotencyKey: `decision-action:${input.action.id}`,
      payload,
    });
    return { queued: true, delivery_id: delivery.id, idempotency_key: delivery.idempotency_key };
  }

  async listDeliveries(projectId: string, limit = 100): Promise<WebhookDelivery[]> {
    const { rows } = await this.pool.query<Record<string, any>>(
      `SELECT * FROM webhook_outbox WHERE project_id = $1
       ORDER BY created_at DESC, id LIMIT $2`, [projectId, Math.max(1, Math.min(limit, 100))],
    );
    const deliveries: WebhookDelivery[] = [];
    for (const row of rows) {
      const attempts = await this.pool.query<Record<string, any>>(
        `SELECT attempt, status, response_status, error_code, error_message, created_at
         FROM webhook_delivery_attempts WHERE project_id = $1 AND outbox_id = $2
         ORDER BY attempt`, [projectId, row.id],
      );
      deliveries.push({
        ...rowToDelivery(row),
        attempts: attempts.rows.map((attempt) => ({ ...attempt, created_at: iso(attempt.created_at) })),
      });
    }
    return deliveries;
  }

  private async enqueue(input: {
    projectId: string; destinationId: string; actionId: string | null;
    eventType: string; idempotencyKey: string; payload: Record<string, unknown>;
  }): Promise<WebhookDelivery> {
    const serialized = JSON.stringify(input.payload);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new ApiError(400, 'webhook_payload_too_large', 'sanitized webhook payload exceeds 64 KiB');
    }
    const { rows } = await this.pool.query<Record<string, any>>(
      `INSERT INTO webhook_outbox (
         project_id, destination_id, action_id, event_type, payload, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, idempotency_key) DO UPDATE SET
         idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [input.projectId, input.destinationId, input.actionId, input.eventType, serialized, input.idempotencyKey],
    );
    return rowToDelivery(rows[0]!);
  }

  async getInternal(projectId: string, id: string, allowUnverified = false): Promise<InternalDestination> {
    const { rows } = await this.pool.query<Record<string, any>>(
      'SELECT * FROM webhook_destinations WHERE project_id = $1 AND id = $2', [projectId, id],
    );
    if (!rows[0]) throw notFound('webhook_destination');
    if (!allowUnverified && rows[0].status !== 'verified') throw new ApiError(409, 'webhook_destination_not_verified', 'webhook destination must pass an explicit test delivery first');
    return { ...publicDestination(rows[0]), destination_ciphertext: rows[0].destination_ciphertext, destination_iv: rows[0].destination_iv, destination_tag: rows[0].destination_tag };
  }

  decrypt(destination: InternalDestination): { url: string; authorization: string | null } {
    return JSON.parse(decryptSecret({
      ciphertext: destination.destination_ciphertext,
      iv: destination.destination_iv,
      tag: destination.destination_tag,
    }, this.requireKey())) as { url: string; authorization: string | null };
  }

  private requireKey(): string {
    if (!this.encryptionKey) throw new ApiError(503, 'connector_encryption_not_configured', 'webhook destinations require POOLSTATIS_CONNECTOR_ENCRYPTION_KEY');
    return this.encryptionKey;
  }
}

export class WebhookOutbox {
  private readonly service: WebhookService;
  constructor(
    private readonly pool: pg.Pool,
    encryptionKey: string,
    private readonly options: WebhookOutboxOptions,
    private readonly outboundPolicy: OutboundPolicyOptions = {},
  ) { this.service = new WebhookService(pool, encryptionKey, outboundPolicy); }

  async runOnce(now: Date = new Date()): Promise<{ claimed: number; delivered: number; failed: number; dead: number }> {
    const claimed = await this.claim(now);
    const result = { claimed: claimed.length, delivered: 0, failed: 0, dead: 0 };
    for (const delivery of claimed) {
      try {
        const destination = this.service.decrypt(delivery.destination);
        const response = await this.send(destination, delivery);
        await this.finishSuccess(delivery, response.status, now);
        result.delivered += 1;
      } catch (error) {
        const dead = delivery.attempt_count >= this.options.maxAttempts;
        await this.finishFailure(delivery, error, dead, now);
        if (dead) result.dead += 1; else result.failed += 1;
      }
    }
    return result;
  }

  private async claim(now: Date): Promise<ClaimedDelivery[]> {
    const stale = new Date(now.getTime() - this.options.leaseMs);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<Record<string, any>>(
        `SELECT o.*, d.*,
                o.id AS outbox_id, o.status AS outbox_status,
                o.created_at AS outbox_created_at, o.updated_at AS outbox_updated_at
         FROM webhook_outbox o
         JOIN webhook_destinations d ON d.id = o.destination_id AND d.project_id = o.project_id
         WHERE o.next_attempt_at <= $1
           AND ($5::uuid IS NULL OR o.project_id = $5)
           AND (o.status IN ('pending', 'failed') OR (o.status = 'delivering' AND o.updated_at <= $2))
           AND o.attempt_count < $3
           AND d.status <> 'disabled'
         ORDER BY o.next_attempt_at, o.created_at, o.id
         FOR UPDATE OF o SKIP LOCKED LIMIT $4`,
        [now, stale, this.options.maxAttempts, this.options.batchSize, this.options.projectId ?? null],
      );
      const claims: ClaimedDelivery[] = [];
      for (const row of selected.rows) {
        const updated = await client.query<Record<string, any>>(
          `UPDATE webhook_outbox SET status = 'delivering', attempt_count = attempt_count + 1,
             updated_at = $3 WHERE project_id = $1 AND id = $2 RETURNING *`,
          [row.project_id, row.outbox_id, now],
        );
        claims.push({
          ...rowToDelivery(updated.rows[0]!),
          project_id: row.project_id,
          destination: {
            ...publicDestination(row),
            destination_ciphertext: row.destination_ciphertext,
            destination_iv: row.destination_iv,
            destination_tag: row.destination_tag,
          },
        });
      }
      await client.query('COMMIT');
      return claims;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  private async send(destination: { url: string; authorization: string | null }, delivery: ClaimedDelivery): Promise<Response> {
    try {
      const { event, impact, ...context } = delivery.payload;
      const orderedPayload = { event, impact, ...context };
      const headers = {
        'content-type': 'application/json',
        'x-poolstatis-idempotency-key': delivery.idempotency_key,
        ...(destination.authorization ? { authorization: destination.authorization } : {}),
      };
      const response = await requestOutbound(destination.url, {
        ...this.outboundPolicy, method: 'POST', headers, body: JSON.stringify(orderedPayload),
        timeoutMs: this.options.requestTimeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      if (response.status < 200 || response.status >= 300) throw new ApiError(502, 'webhook_http_error', `webhook returned HTTP ${response.status}`);
      return { status: response.status } as Response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new ApiError(504, 'webhook_timeout', 'webhook request timed out');
      throw error;
    } finally { /* requestOutbound owns the absolute delivery deadline. */ }
  }

  private async finishSuccess(delivery: ClaimedDelivery, responseStatus: number, now: Date) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE webhook_outbox SET status = 'delivered', delivered_at = $3,
           last_error = NULL, updated_at = $3 WHERE project_id = $1 AND id = $2`,
        [delivery.project_id, delivery.id, now],
      );
      await client.query(
        `INSERT INTO webhook_delivery_attempts (
           project_id, outbox_id, attempt, status, response_status
         ) VALUES ($1, $2, $3, 'delivered', $4) ON CONFLICT DO NOTHING`,
        [delivery.project_id, delivery.id, delivery.attempt_count, responseStatus],
      );
      if (delivery.event_type === 'poolstatis.webhook.test') {
        await client.query(
          `UPDATE webhook_destinations SET status = 'verified', verified_at = $3,
             last_error = NULL, updated_at = $3 WHERE project_id = $1 AND id = $2`,
          [delivery.project_id, delivery.destination_id, now],
        );
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  private async finishFailure(delivery: ClaimedDelivery, error: unknown, dead: boolean, now: Date) {
    const code = errorCode(error);
    const message = sanitizedError(error);
    const next = new Date(now.getTime() + Math.min(
      this.options.maxRetryMs,
      this.options.baseRetryMs * (2 ** Math.max(0, delivery.attempt_count - 1)),
    ));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE webhook_outbox SET status = $3, next_attempt_at = $4,
           last_error = $5, updated_at = $6 WHERE project_id = $1 AND id = $2`,
        [delivery.project_id, delivery.id, dead ? 'dead' : 'failed', next, message, now],
      );
      await client.query(
        `INSERT INTO webhook_delivery_attempts (
           project_id, outbox_id, attempt, status, error_code, error_message
         ) VALUES ($1, $2, $3, 'failed', $4, $5) ON CONFLICT DO NOTHING`,
        [delivery.project_id, delivery.id, delivery.attempt_count, code, message],
      );
      if (delivery.event_type === 'poolstatis.webhook.test') {
        await client.query(
          `UPDATE webhook_destinations SET status = 'error', last_error = $3,
             updated_at = $4 WHERE project_id = $1 AND id = $2`,
          [delivery.project_id, delivery.destination_id, message, now],
        );
      }
      await client.query('COMMIT');
    } catch (caught) { await client.query('ROLLBACK').catch(() => {}); throw caught; }
    finally { client.release(); }
  }
}

export async function getDecisionInbox(pool: pg.Pool, projectId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query<Record<string, any>>(
    `SELECT d.*, e.ready, e.blockers, e.primary_evidence, e.trust,
       r.contract_key, r.commit_sha, r.env,
       COALESCE((SELECT bool_or(
                   a.status = 'executed'
                   AND (
                     a.action_type <> 'generic_webhook'
                     OR EXISTS (
                       SELECT 1 FROM webhook_outbox o
                       WHERE o.project_id = a.project_id
                         AND o.action_id = a.id
                         AND o.status = 'delivered'
                     )
                   )
                 ) FROM decision_actions a
                 WHERE a.project_id = d.project_id AND a.decision_id = d.id), false) AS has_executed_action
     FROM decisions d
     JOIN evidence_sets e ON e.id = d.evidence_id
     JOIN releases r ON r.id = d.release_id
     WHERE d.project_id = $1
     ORDER BY d.created_at DESC, d.id`,
    [projectId],
  );
  return rows.map((row) => ({
    decision_id: row.id,
    release_id: row.release_id,
    state: inboxState(row),
    impact: {
      outcome: row.accepted_outcome ?? row.proposed_outcome,
      metric_key: row.primary_evidence.metric.key,
      metric_purpose: row.primary_evidence.metric.purpose,
      relative_change: row.primary_evidence.change.relative,
      trust: row.trust.status,
    },
    blocker: row.ready ? null : row.blockers[0] ?? null,
    requested_choice: row.status === 'proposed' ? 'approve, correct, or reject this proposal' : null,
    contract_key: row.contract_key,
    commit_sha: row.commit_sha,
    env: row.env,
    updated_at: iso(row.updated_at),
  }));
}

function inboxState(row: Record<string, any>): 'needs_attention' | 'waiting_for_data' | 'approved' | 'rejected' | 'resolved' {
  if (row.status === 'rejected') return 'rejected';
  if (row.status === 'approved') return row.has_executed_action ? 'resolved' : 'approved';
  if (!row.ready) return 'waiting_for_data';
  if (row.status === 'proposed') return 'needs_attention';
  return row.has_executed_action ? 'resolved' : 'approved';
}
function publicDestination(row: Record<string, any>): WebhookDestination { return { id: row.id, name: row.name, masked_url: row.masked_url, status: row.status, last_error: row.last_error, verified_at: iso(row.verified_at), created_by: row.created_by, created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)! }; }
function rowToDelivery(row: Record<string, any>): WebhookDelivery { return { id: row.id, destination_id: row.destination_id, action_id: row.action_id, event_type: row.event_type, payload: row.payload, idempotency_key: row.idempotency_key, status: row.status, attempt_count: row.attempt_count, next_attempt_at: iso(row.next_attempt_at)!, delivered_at: iso(row.delivered_at), last_error: row.last_error, created_at: iso(row.created_at)!, updated_at: iso(row.updated_at)! }; }
function maskUrl(value: string): string { const url = new URL(value); return `${url.protocol}//${url.host}/…`; }
function iso(value: Date | string | null | undefined): string | null { return value ? new Date(value).toISOString() : null; }
function errorCode(error: unknown): string { return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'webhook_delivery_failed'; }
function sanitizedError(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`.slice(0, 500);
  return sanitizedOutboundError(error);
}


export function startWebhookOutbox(
  outbox: WebhookOutbox,
  options: { intervalMs: number; onResult?: (result: Awaited<ReturnType<WebhookOutbox['runOnce']>>) => void; onError?: (error: unknown) => void },
): { stop: () => Promise<void> } {
  let stopped = false; let timer: NodeJS.Timeout | null = null; let current: Promise<void> | null = null;
  const schedule = () => { if (!stopped) { timer = setTimeout(run, options.intervalMs); timer.unref(); } };
  const run = () => { if (stopped || current) return; current = outbox.runOnce().then((result) => options.onResult?.(result)).catch((error) => options.onError?.(error)).finally(() => { current = null; schedule(); }); };
  run();
  return { stop: async () => { stopped = true; if (timer) clearTimeout(timer); await current; } };
}
