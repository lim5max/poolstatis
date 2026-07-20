import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createContext } from '../../src/http/context.js';
import { ReleaseMonitor } from '../../src/services/releaseMonitor.js';
import { WebhookOutbox } from '../../src/services/webhooks.js';
import { activeMetric, api, createTestEnv, type TestEnv } from '../helpers.js';

const DAY = 86_400_000;
const ENCRYPTION_KEY = 'decision-loop-c-e2e-encryption-key';

describe('full P0/P1 continuous product decision loop E2E', () => {
  let native: TestEnv;
  let external: TestEnv;
  let anchor: Date;
  let posthogHost: string;
  let webhookHost: string;
  const delivered: Array<{ idempotency: string; body: Record<string, any> }> = [];
  const posthog = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : null;
    routePostHog(req, res, body);
  });
  const webhook = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    delivered.push({
      idempotency: String(req.headers['x-poolstatis-idempotency-key'] ?? ''),
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>,
    });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ accepted: true }));
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => posthog.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => webhook.listen(0, '127.0.0.1', resolve));
    posthogHost = `http://127.0.0.1:${(posthog.address() as AddressInfo).port}`;
    webhookHost = `http://127.0.0.1:${(webhook.address() as AddressInfo).port}`;
    native = await createTestEnv({ connectorEncryptionKey: ENCRYPTION_KEY });
    external = await createTestEnv({ connectorEncryptionKey: ENCRYPTION_KEY });
    anchor = new Date(Date.now() - 3 * DAY);
  });

  afterAll(async () => {
    await native.close(); await external.close();
    await new Promise<void>((resolve, reject) => posthog.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => webhook.close((error) => error ? reject(error) : resolve()));
  });

  test('worker dedupes native evidence, human approval gates action, outbox delivers once, and memory finds it', async () => {
    await activeMetric(native, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    await activeMetric(native, {
      key: 'setup_completed', type: 'unique_actors',
      purpose: 'Measures whether actors complete setup during onboarding.',
      source: { event: 'setup.completed', filters: [] },
    });
    await api(native, native.secretToken, 'PATCH', path(native, '/metrics/activation_completed'), { tags: ['onboarding'], category: 'activation' });
    await api(native, native.secretToken, 'PATCH', path(native, '/metrics/setup_completed'), { tags: ['onboarding'], category: 'activation' });
    const declaration = makeDeclaration('continuous_native', 'activation_completed');
    await apply(native, declaration);
    await ingestNative(native);
    const release = await register(native, 'continuous-native-release', 'continuous_native');

    const destination = await api(native, native.secretToken, 'POST', path(native, '/webhooks'), {
      name: 'product_ops', url: `${webhookHost}/decision`, authorization: 'Bearer e2e-webhook-secret',
    });
    await api(native, native.secretToken, 'POST', path(native, `/webhooks/${destination.body.id}/test`), {});
    const outbox = webhookWorker(native);
    expect(await outbox.runOnce(new Date())).toMatchObject({ delivered: 1 });

    const monitor = releaseMonitor(native);
    expect(await monitor.runOnce(new Date())).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await monitor.runOnce(new Date())).toMatchObject({ claimed: 0 });
    const counts = await native.pool.query(
      `SELECT (SELECT count(*)::int FROM evidence_sets WHERE release_id = $1) AS evidence,
              (SELECT count(*)::int FROM decisions WHERE release_id = $1) AS decisions`, [release.id],
    );
    expect(counts.rows[0]).toEqual({ evidence: 1, decisions: 1 });
    const decision = (await api(native, native.secretToken, 'GET', path(native, `/decisions?release_id=${release.id}`))).body.decisions[0];
    expect(decision).toMatchObject({ proposed_outcome: 'keep', status: 'proposed' });

    const explained = await api(native, native.secretToken, 'POST', path(native, `/decisions/${decision.id}/explain`), {});
    expect(explained.body).toMatchObject({ label: 'hypothesis', candidates: [expect.objectContaining({ key: 'setup_completed', interpretation: 'hypothesis' })] });
    expect((await api(native, native.secretToken, 'GET', path(native, '/decision-inbox'))).body.decisions[0].state).toBe('needs_attention');
    await api(native, native.secretToken, 'POST', path(native, `/decisions/${decision.id}/approve`), {
      rationale: 'The measured activation lift is trusted and clears the declared threshold.',
    });
    const followUp = await api(native, native.secretToken, 'POST', path(native, '/releases'), {
      idempotency_key: 'continuous-native-follow-up', contract_key: 'continuous_native', env: 'prod',
      repository: 'acme/product', commit_sha: 'c'.repeat(40), status: 'deployed',
      originating_decision_id: decision.id,
    });
    expect(followUp.body).toMatchObject({ originating_decision_id: decision.id });
    expect((await api(native, native.secretToken, 'GET', path(native, `/releases/${followUp.body.id}`))).body.release)
      .toMatchObject({ originating_decision_id: decision.id });
    expect((await api(native, native.secretToken, 'GET', path(native, `/releases?originating_decision_id=${decision.id}`))).body.releases)
      .toEqual([expect.objectContaining({ id: followUp.body.id })]);
    const prepared = await api(native, native.secretToken, 'POST', path(native, `/decisions/${decision.id}/actions`), {
      action_type: 'generic_webhook', idempotency_key: 'continuous-native-notify',
      target: { team: 'product-ops' }, payload: { event: 'accepted-decision' },
      expected_effect: 'Notify product operations about the accepted measured impact and preserve a delivery audit.',
    });
    expect(delivered).toHaveLength(1);
    const action = await api(native, native.secretToken, 'POST', path(native, `/actions/${prepared.body.action.id}/approve`), {
      confirmation_fingerprint: prepared.body.action.confirmation_fingerprint,
    });
    expect(action.body.action).toMatchObject({ status: 'executed', result: { queued: true } });
    expect(delivered).toHaveLength(1);
    expect(await outbox.runOnce(new Date())).toMatchObject({ claimed: 1, delivered: 1 });
    expect(await outbox.runOnce(new Date())).toMatchObject({ claimed: 0 });
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.body).toMatchObject({
      impact: { accepted_outcome: 'keep', metric_key: 'activation_completed' },
      decision: { id: decision.id }, action: { id: prepared.body.action.id },
    });
    expect(JSON.stringify(delivered[1]!.body)).not.toContain('e2e-webhook-secret');

    const history = await api(native, native.secretToken, 'GET', path(native, '/decisions/search?tag=onboarding'));
    expect(history.body.items).toEqual([expect.objectContaining({ decision_id: decision.id, status: 'approved' })]);
    const similar = await api(native, native.secretToken, 'POST', path(native, '/contracts/similar'), declaration);
    expect(similar.body.changes[0]).toMatchObject({ decision_id: decision.id, shared: expect.arrayContaining(['primary_metric']) });
    expect((await api(native, native.secretToken, 'GET', path(native, '/decision-inbox'))).body.decisions[0].state).toBe('resolved');
  });

  test('monitor evaluates PostHog through the bounded adapter and stores no raw external events', async () => {
    const configured = await api(external, external.secretToken, 'POST', path(external, '/sources/posthog'), {
      name: 'existing_product', host: posthogHost, project_id: '42', personal_api_key: 'phx_c_e2e_secret',
    });
    await api(external, external.secretToken, 'POST', path(external, `/sources/posthog/${configured.body.id}/verify`), {});
    await activeMetric(external, {
      key: 'external_activation', type: 'unique_actors',
      purpose: 'Measures activation in PostHog without importing raw product events.',
      source: { data_source: 'posthog', source_connection_id: configured.body.id, event: 'activation.completed', filters: [] },
    });
    const declaration = makeDeclaration('continuous_external', 'external_activation');
    await apply(external, declaration);
    const release = await register(external, 'continuous-external-release', 'continuous_external');
    const monitor = releaseMonitor(external);
    expect(await monitor.runOnce(new Date())).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await monitor.runOnce(new Date())).toMatchObject({ claimed: 0 });
    const decision = (await api(external, external.secretToken, 'GET', path(external, `/decisions?release_id=${release.id}`))).body.decisions[0];
    const detail = await api(external, external.secretToken, 'GET', path(external, `/decisions/${decision.id}`));
    expect(detail.body.evidence).toMatchObject({
      source: 'posthog', ready: true,
      primary_evidence: { baseline: { value: 10 }, observed: { value: 15 } },
    });
    const local = await external.pool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE project_id = (SELECT id FROM projects WHERE slug = $1)`, [external.projectSlug],
    );
    expect(local.rows[0].count).toBe(0);
    const history = await api(external, external.secretToken, 'GET', path(external, '/decisions/search?metric=external_activation'));
    expect(history.body.items[0]).toMatchObject({ decision_id: decision.id, evidence_quality: { trust: 'trusted' } });
  });

  function releaseMonitor(env: TestEnv) {
    const context = createContext(env.pool, { ingestBuffer: false, queryCache: false, connectorEncryptionKey: ENCRYPTION_KEY });
    return new ReleaseMonitor(env.pool, context.query, {
      batchSize: 10, maxAttempts: 5, baseRetryMs: 100, maxRetryMs: 1_000,
      leaseMs: 10_000, actor: 'worker:e2e-release-monitor', projectId: env.projectId,
    });
  }
  function webhookWorker(env: TestEnv) {
    return new WebhookOutbox(env.pool, ENCRYPTION_KEY, {
      batchSize: 10, maxAttempts: 5, baseRetryMs: 100, maxRetryMs: 1_000,
      leaseMs: 10_000, requestTimeoutMs: 2_000, projectId: env.projectId,
    });
  }
  function makeDeclaration(key: string, metric: string) {
    return { version: 1 as const, contracts: [{
      key, name: key.replaceAll('_', ' '), business_hypothesis: 'The deployed onboarding change should increase activation.',
      decision_owner: 'growth-team', primary_metric_key: metric,
      guardrail_metric_keys: [], target_filters: [], baseline_window_days: 1,
      observation_window_days: 1, minimum_sample_size: 2,
      expected_direction: 'increase' as const, minimum_meaningful_effect: 0.1,
      references: {}, status: 'active' as const,
    }] };
  }
  async function apply(env: TestEnv, declaration: ReturnType<typeof makeDeclaration>) {
    const diff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), declaration);
    const result = await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), { declaration, expected_revision: diff.body.expected_revision });
    expect(result.status).toBe(200);
  }
  async function register(env: TestEnv, key: string, contract: string) {
    const result = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
      idempotency_key: key, contract_key: contract, env: 'prod', repository: 'acme/product',
      commit_sha: key.replace(/[^a-f0-9]/g, 'a').padEnd(40, 'a').slice(0, 40),
      deployed_at: anchor.toISOString(), status: 'deployed',
    });
    expect(result.status).toBe(201); return result.body;
  }
  async function ingestNative(env: TestEnv) {
    const events: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 5; index++) {
      events.push({ event: 'activation.completed', distinct_id: `base-a-${index}`, timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} });
      events.push({ event: 'setup.completed', distinct_id: `base-s-${index}`, timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} });
    }
    for (let index = 0; index < 8; index++) {
      events.push({ event: 'activation.completed', distinct_id: `obs-a-${index}`, timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} });
      events.push({ event: 'setup.completed', distinct_id: `obs-s-${index}`, timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} });
    }
    expect((await api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'continuous-native-events', events })).status).toBe(200);
  }
  function path(env: TestEnv, suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
  function routePostHog(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown> | null) {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer phx_c_e2e_secret') { res.statusCode = 401; res.end('{}'); return; }
    if (req.url === '/api/projects/42/query/' && req.method === 'POST') {
      if (body?.name === 'poolstatis_connection_verify') { res.end(JSON.stringify({ columns: ['ok'], results: [[1]] })); return; }
      if (body?.name === 'poolstatis_evaluate_external_activation_baseline') { res.end(JSON.stringify({ columns: [], results: [[10, 10, 10, 10, 10]] })); return; }
      if (body?.name === 'poolstatis_evaluate_external_activation_observed') { res.end(JSON.stringify({ columns: [], results: [[15, 15, 15, 15, 15]] })); return; }
    }
    res.statusCode = 404; res.end('{}');
  }
});
