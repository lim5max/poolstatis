import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildServer } from '../../src/http/server.js';
import { activeMetric, api, createTestEnv, type TestEnv } from '../helpers.js';

describe('Milestone A decision-loop E2E', () => {
  let native: TestEnv;
  let external: TestEnv;
  let posthogHost: string;
  const posthog = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      : null;
    routePostHog(req, res, body);
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => posthog.listen(0, '127.0.0.1', resolve));
    posthogHost = `http://127.0.0.1:${(posthog.address() as AddressInfo).port}`;
    native = await createTestEnv();
    external = await createTestEnv({ connectorEncryptionKey: 'decision-loop-a-e2e-key', outboundPolicy: { allowLocalHttp: true } });
  });

  afterAll(async () => {
    await native.close();
    await external.close();
    await new Promise<void>((resolve, reject) => posthog.close((error) => error ? reject(error) : resolve()));
  });

  test('native ingest reaches a persisted real result with canonical identity and trusted property meaning', async () => {
    await observeMcp(native);
    await activeMetric(native, {
      key: 'activation_completed',
      name: 'Activation completed',
      type: 'unique_actors',
      purpose: 'Shows whether newly signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });

    const property = await api(native, native.secretToken, 'POST', projectPath(native, '/properties'), {
      key: 'plan',
      scope: 'event',
      value_type: 'string',
      purpose: 'Segments activation evidence by the commercial plan selected by the actor.',
      status: 'trusted',
    });
    expect(property.status).toBe(201);

    const identity = await api(native, native.secretToken, 'POST', projectPath(native, '/identity-links'), {
      source_distinct_id: 'anonymous-browser-1',
      target_distinct_id: 'user-1',
      env: 'prod',
    });
    expect(identity.status).toBe(201);

    const ingest = await api(native, native.ingestToken, 'POST', '/i/v1/events', {
      batch_id: 'milestone-a-native',
      events: [
        { event: 'activation.completed', distinct_id: 'anonymous-browser-1', properties: { plan: 'pro' } },
        { event: 'activation.completed', distinct_id: 'user-1', properties: { plan: 'pro' } },
      ],
    });
    expect(ingest.status).toBe(200);

    const query = {
      kind: 'trend',
      metric: 'activation_completed',
      date_from: '-7d',
      interval: 'day',
      env: 'prod',
    };
    const result = await api(native, native.secretToken, 'POST', projectPath(native, '/query'), query);
    expect(result.status).toBe(200);
    expect(result.body.series.reduce((sum: number, point: { value: number }) => sum + point.value, 0)).toBe(1);
    expect(result.body.meta.source).toBe('native');

    const trust = await api(native, native.secretToken, 'POST', projectPath(native, '/measurement/trust'), {
      metric_key: 'activation_completed',
      env: 'prod',
      target_filters: [{ property: 'plan', op: 'eq', value: 'pro' }],
    });
    expect(trust.status).toBe(200);
    expect(trust.body).toMatchObject({
      status: 'trusted',
      primary_metric: { observed_events: 2, observed_actors: 1, registered_coverage: 1 },
      identity: { raw_actors: 2, resolved_actors: 1, distinct_id_coverage: 1 },
      properties: [{ key: 'plan', status: 'trusted', coverage: 1 }],
    });

    const saved = await api(native, native.secretToken, 'POST', projectPath(native, '/insights'), {
      title: 'Activation evidence is available',
      body: 'Compare this activation result with the planned baseline before shipping the next change.',
      query,
    });
    expect(saved.status).toBe(201);

    const reloaded = buildServer(native.pool);
    const status = await inject(reloaded, native.secretToken, 'GET', projectPath(native, '/onboarding/status?env=prod'));
    expect(status.status).toBe(200);
    expect(status.body.complete).toBe(true);
    expect(status.body.final_result).toMatchObject({
      metric_key: 'activation_completed',
      metric_purpose: 'Shows whether newly signed-up actors reach the first product value moment.',
      source: 'native',
      next_action: 'Compare this activation result with the planned baseline before shipping the next change.',
    });
    expect(status.body.gates.every((gate: { complete: boolean }) => gate.complete)).toBe(true);
    await reloaded.close();

    const schema = await api(native, native.secretToken, 'GET', projectPath(native, '/schema?env=prod'));
    expect(schema.body).toMatchObject({
      properties: [expect.objectContaining({ key: 'plan', purpose: property.body.purpose, status: 'trusted' })],
      identity: { active_links: 1, linked_sources: 1, audit_entries: 1 },
    });
  });

  test('controlled PostHog data reaches the same proof gates without importing raw events', async () => {
    await observeMcp(external);
    const configured = await api(external, external.secretToken, 'POST', projectPath(external, '/sources/posthog'), {
      name: 'existing_product',
      host: posthogHost,
      project_id: '42',
      personal_api_key: 'phx_controlled_e2e_secret',
    });
    expect(configured.status).toBe(201);
    expect(JSON.stringify(configured.body)).not.toContain('phx_controlled_e2e_secret');
    const sourceId = configured.body.id as string;

    const verified = await api(external, external.secretToken, 'POST', projectPath(external, `/sources/posthog/${sourceId}/verify`), {});
    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe('verified');
    const schema = await api(external, external.secretToken, 'GET', projectPath(external, `/sources/posthog/${sourceId}/schema`));
    expect(schema.body.events).toContainEqual({ name: 'signup.completed' });

    await activeMetric(external, {
      key: 'posthog_signups',
      name: 'Existing product signups',
      type: 'unique_actors',
      purpose: 'Shows whether the existing PostHog product continues producing completed signups.',
      source: {
        data_source: 'posthog',
        source_connection_id: sourceId,
        event: 'signup.completed',
        filters: [],
      },
    });
    const query = {
      kind: 'trend', metric: 'posthog_signups',
      date_from: '2026-07-18T00:00:00.000Z',
      date_to: '2026-07-19T00:00:00.000Z',
      interval: 'day', env: 'prod',
    };
    const result = await api(external, external.secretToken, 'POST', projectPath(external, '/query'), query);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      kind: 'trend',
      series: [{ bucket: '2026-07-18T00:00:00.000Z', value: 3 }],
      meta: { source: 'posthog' },
    });
    const saved = await api(external, external.secretToken, 'POST', projectPath(external, '/insights'), {
      title: 'Existing signup evidence is connected',
      body: 'Define a measurement contract before evaluating the next deployed signup change.',
      query,
    });
    expect(saved.status).toBe(201);

    const status = await api(external, external.secretToken, 'GET', projectPath(external, '/onboarding/status?env=prod'));
    expect(status.status).toBe(200);
    expect(status.body.complete).toBe(true);
    expect(status.body.final_result).toMatchObject({ metric_key: 'posthog_signups', source: 'posthog' });

    const local = await external.pool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE project_id = (SELECT id FROM projects WHERE slug = $1)`,
      [external.projectSlug],
    );
    expect(local.rows[0].count).toBe(0);
    const projectSchema = await api(external, external.secretToken, 'GET', projectPath(external, '/schema?env=prod'));
    expect(projectSchema.body.sources).toEqual([
      expect.objectContaining({ id: sourceId, status: 'verified', capabilities: expect.objectContaining({ trend: true }) }),
    ]);
    expect(JSON.stringify(projectSchema.body)).not.toContain('phx_controlled_e2e_secret');
  });
});

async function observeMcp(env: TestEnv): Promise<void> {
  const response = await env.app.inject({
    method: 'POST',
    url: projectPath(env, '/onboarding/observe-agent'),
    headers: {
      authorization: `Bearer ${env.secretToken}`,
      'x-poolstatis-client': 'mcp',
    },
    payload: { client: 'e2e-mcp', env: 'prod' },
  });
  expect(response.statusCode).toBe(200);
}

function projectPath(env: TestEnv, suffix: string): string {
  return `/api/v1/projects/${env.projectSlug}${suffix}`;
}

async function inject(
  app: ReturnType<typeof buildServer>,
  token: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json() };
}

function routePostHog(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown> | null,
): void {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer phx_controlled_e2e_secret') {
    res.statusCode = 401;
    res.end(JSON.stringify({ detail: 'wrong credential' }));
    return;
  }
  if (req.url === '/api/projects/42/query/' && req.method === 'POST') {
    if (body?.name === 'poolstatis_connection_verify') {
      res.end(JSON.stringify({ columns: ['ok'], results: [[1]] }));
      return;
    }
    if (body?.name === 'poolstatis_trend_posthog_signups') {
      res.end(JSON.stringify({
        columns: ['bucket', 'value'],
        results: [['2026-07-18T00:00:00.000Z', 3]],
      }));
      return;
    }
  }
  if (req.url === '/api/projects/42/event_definitions/?limit=100') {
    res.end(JSON.stringify({ results: [{ name: 'signup.completed' }] }));
    return;
  }
  if (req.url === '/api/projects/42/property_definitions/?limit=100') {
    res.end(JSON.stringify({ results: [{ name: 'plan', property_type: 'String', type: 'event' }] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ detail: 'fixture route not found' }));
}
