import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebhookOutbox } from '../src/services/webhooks.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

const DAY = 86_400_000;
const ENCRYPTION_KEY = 'webhook-outbox-controlled-encryption-key';

describe('encrypted webhook outbox and decision inbox', () => {
  let env: TestEnv;
  let host: string;
  let decisionId: string;
  let releaseId: string;
  let failMode = true;
  const requests: Array<{ url: string; authorization?: string; idempotency?: string; body: Record<string, any> }> = [];
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
    requests.push({
      url: req.url ?? '', authorization: req.headers.authorization,
      idempotency: String(req.headers['x-poolstatis-idempotency-key'] ?? ''), body,
    });
    routeReceiver(req, res);
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    host = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    env = await createTestEnv({ connectorEncryptionKey: ENCRYPTION_KEY });
    const anchor = new Date(Date.now() - 3 * DAY);
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    const declaration = { version: 1, contracts: [{
      key: 'webhook_change', name: 'Webhook change',
      business_hypothesis: 'The deployed change should increase activation.',
      decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
      guardrail_metric_keys: [], target_filters: [], baseline_window_days: 1,
      observation_window_days: 1, minimum_sample_size: 2,
      expected_direction: 'increase', minimum_meaningful_effect: 0.1,
      references: {}, status: 'active',
    }] };
    const diff = await api(env, env.secretToken, 'POST', path('/contracts/diff'), declaration);
    await api(env, env.secretToken, 'POST', path('/contracts/apply'), { declaration, expected_revision: diff.body.expected_revision });
    await api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'webhook-evidence', events: [
      { event: 'activation.completed', distinct_id: 'base-1', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: { secret_note: 'never deliver this' } },
      { event: 'activation.completed', distinct_id: 'base-2', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-1', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-2', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-3', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
    ] });
    const release = await api(env, env.secretToken, 'POST', path('/releases'), {
      idempotency_key: 'webhook-release', contract_key: 'webhook_change', env: 'prod',
      repository: 'acme/product', commit_sha: 'f'.repeat(40), deployed_at: anchor.toISOString(), status: 'deployed',
    });
    releaseId = release.body.id;
    const evaluated = await api(env, env.secretToken, 'POST', path(`/releases/${releaseId}/evaluate`), {});
    decisionId = evaluated.body.decision.id;
  });

  afterAll(async () => {
    await env.close();
    await new Promise<void>((resolve, reject) => receiver.close((error) => error ? reject(error) : resolve()));
  });

  test('encrypts destination and explicit test delivery verifies it once', async () => {
    const configured = await api(env, env.secretToken, 'POST', path('/webhooks'), {
      name: 'product_ops', url: `${host}/ok`, authorization: 'Bearer outbound-secret',
    });
    expect(configured.status).toBe(201);
    expect(configured.body).toMatchObject({ name: 'product_ops', masked_url: expect.stringContaining('/…'), status: 'configured' });
    expect(JSON.stringify(configured.body)).not.toContain('outbound-secret');
    const stored = await env.pool.query(
      `SELECT encode(destination_ciphertext, 'hex') AS ciphertext
       FROM webhook_destinations WHERE id = $1`, [configured.body.id],
    );
    const ciphertext = stored.rows[0].ciphertext as string;
    expect(ciphertext).not.toContain(Buffer.from(`${host}/ok`).toString('hex'));
    expect(ciphertext).not.toContain(Buffer.from('outbound-secret').toString('hex'));

    const queued = await api(env, env.secretToken, 'POST', path(`/webhooks/${configured.body.id}/test`), {});
    expect(queued.status).toBe(202);
    expect(queued.body.status).toBe('pending');
    const outbox = worker();
    expect(await outbox.runOnce(new Date())).toEqual({ claimed: 1, delivered: 1, failed: 0, dead: 0 });
    expect(await outbox.runOnce(new Date())).toEqual({ claimed: 0, delivered: 0, failed: 0, dead: 0 });
    expect(requests[0]).toMatchObject({
      url: '/ok', authorization: 'Bearer outbound-secret',
      idempotency: queued.body.idempotency_key,
      body: { event: 'poolstatis.webhook.test', impact: expect.any(Object) },
    });
    const destinations = await api(env, env.secretToken, 'GET', path('/webhooks'));
    expect(destinations.body.destinations[0].status).toBe('verified');
  });

  test('queues impact-first sanitized decision payload only after approval and exposes delivery state', async () => {
    let inbox = await api(env, env.secretToken, 'GET', path('/decision-inbox'));
    expect(inbox.body.decisions[0]).toMatchObject({ state: 'needs_attention', requested_choice: expect.any(String) });
    await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/approve`), {
      rationale: 'The trusted activation evidence clears the declared threshold.',
    });
    inbox = await api(env, env.secretToken, 'GET', path('/decision-inbox'));
    expect(inbox.body.decisions[0].state).toBe('approved');

    const prepared = await api(env, env.secretToken, 'POST', path(`/decisions/${decisionId}/actions`), {
      action_type: 'generic_webhook', idempotency_key: 'notify-accepted-decision',
      target: { team: 'product-ops' }, payload: { internal_note: 'must not be delivered' },
      expected_effect: 'Notify product operations about the accepted measured impact and requested follow-up.',
    });
    expect((await api(env, env.secretToken, 'GET', path('/webhook-deliveries'))).body.deliveries).toHaveLength(1);
    const approved = await api(env, env.secretToken, 'POST', path(`/actions/${prepared.body.action.id}/approve`), {
      confirmation_fingerprint: prepared.body.action.confirmation_fingerprint,
    });
    expect(approved.body.action).toMatchObject({ status: 'executed', result: { queued: true } });
    const pending = await api(env, env.secretToken, 'GET', path('/webhook-deliveries'));
    expect(pending.body.deliveries[0]).toMatchObject({ status: 'pending', event_type: 'poolstatis.decision.action' });
    expect(JSON.stringify(pending.body.deliveries[0].payload)).not.toContain('internal_note');
    expect(JSON.stringify(pending.body.deliveries[0].payload)).not.toContain('secret_note');
    inbox = await api(env, env.secretToken, 'GET', path('/decision-inbox'));
    expect(inbox.body.decisions[0].state).toBe('approved');
    expect(await worker().runOnce(new Date())).toMatchObject({ claimed: 1, delivered: 1 });
    const decisionRequest = requests.find((request) => request.body.event === 'poolstatis.decision.action')!;
    expect(Object.keys(decisionRequest.body)[0]).toBe('event');
    expect(Object.keys(decisionRequest.body)[1]).toBe('impact');
    expect(decisionRequest.body).toMatchObject({
      impact: { accepted_outcome: 'keep', metric_key: 'activation_completed', evidence_ready: true, trust: 'trusted' },
      decision: { id: decisionId, release_id: releaseId },
      action: { id: prepared.body.action.id, type: 'generic_webhook' },
    });
    inbox = await api(env, env.secretToken, 'GET', path('/decision-inbox'));
    expect(inbox.body.decisions[0].state).toBe('resolved');
  });

  test('uses bounded exponential retry, sanitized errors and dead-letter state', async () => {
    const failedDestination = await api(env, env.secretToken, 'POST', path('/webhooks'), {
      name: 'failing_ops', url: `${host}/fail`, authorization: 'Bearer failing-secret',
    });
    const queued = await api(env, env.secretToken, 'POST', path(`/webhooks/${failedDestination.body.id}/test`), {});
    const now = new Date();
    const outbox = worker({ maxAttempts: 2, baseRetryMs: 1_000, maxRetryMs: 1_000 });
    expect(await outbox.runOnce(now)).toMatchObject({ claimed: 1, failed: 1 });
    let delivery = (await api(env, env.secretToken, 'GET', path('/webhook-deliveries'))).body.deliveries
      .find((item: { id: string }) => item.id === queued.body.id);
    expect(delivery).toMatchObject({ status: 'failed', attempt_count: 1, last_error: expect.stringContaining('webhook_http_error') });
    expect(delivery.last_error).not.toContain('failing-secret');
    failMode = false;
    expect(await outbox.runOnce(new Date(now.getTime() + 1_000))).toMatchObject({ claimed: 1, delivered: 1 });
    delivery = (await api(env, env.secretToken, 'GET', path('/webhook-deliveries'))).body.deliveries
      .find((item: { id: string }) => item.id === queued.body.id);
    expect(delivery).toMatchObject({ status: 'delivered', attempt_count: 2 });
    expect(delivery.attempts.map((attempt: { status: string }) => attempt.status)).toEqual(['failed', 'delivered']);
  });

  function worker(patch: Partial<{ batchSize: number; maxAttempts: number; baseRetryMs: number; maxRetryMs: number; leaseMs: number; requestTimeoutMs: number }> = {}) {
    return new WebhookOutbox(env.pool, ENCRYPTION_KEY, {
      batchSize: 10, maxAttempts: 5, baseRetryMs: 100, maxRetryMs: 1_000,
      leaseMs: 10_000, requestTimeoutMs: 2_000, projectId: env.projectId, ...patch,
    });
  }
  function path(suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
  function routeReceiver(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/fail' && failMode) { res.statusCode = 500; res.end(JSON.stringify({ error: 'controlled' })); return; }
    res.end(JSON.stringify({ ok: true }));
  }
});
