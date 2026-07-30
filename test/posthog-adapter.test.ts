import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { api, createTestEnv, type TestEnv } from './helpers.js';

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown> | null;
}

describe('read-only PostHog adapter', () => {
  let env: TestEnv;
  let host: string;
  const requests: RecordedRequest[] = [];
  const upstream = createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      authorization: req.headers.authorization,
      body,
    });
    routeFixture(req, res, body);
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address() as AddressInfo;
    host = 'http://127.0.0.1:' + address.port;
    env = await createTestEnv({
      connectorEncryptionKey: 'test-only-posthog-encryption-key',
      outboundPolicy: { allowLocalHttp: true },
    });
  });

  afterAll(async () => {
    await env.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });

  test('encrypts credentials, discovers schema and runs supported queries without importing events', async () => {
    const configured = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/sources/posthog',
      {
        name: 'primary',
        host,
        project_id: '42',
        personal_api_key: 'phx_controlled_secret',
      },
    );
    expect(configured.status).toBe(201);
    expect(JSON.stringify(configured.body)).not.toContain('phx_controlled_secret');
    expect(configured.body).toMatchObject({
      provider: 'posthog',
      name: 'primary',
      host,
      external_project_id: '42',
      status: 'configured',
    });

    const stored = await env.pool.query<{
      ciphertext: string;
      secret_iv: Buffer;
      secret_tag: Buffer;
    }>(
      'SELECT encode(secret_ciphertext, \'hex\') AS ciphertext, secret_iv, secret_tag FROM source_connections WHERE id = $1',
      [configured.body.id],
    );
    expect(stored.rows[0]?.ciphertext).not.toContain(Buffer.from('phx_controlled_secret').toString('hex'));
    expect(stored.rows[0]?.secret_iv.length).toBe(12);
    expect(stored.rows[0]?.secret_tag.length).toBe(16);

    const beforeVerification = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/metrics',
      {
        key: 'unverified_external_metric',
        name: 'Unverified external metric',
        purpose: 'Must not become decision input before the external source is verified.',
        type: 'unique_actors',
        source: {
          data_source: 'posthog',
          source_connection_id: configured.body.id,
          event: 'signup.completed',
          filters: [],
        },
      },
    );
    expect(beforeVerification.status).toBe(404);
    expect(beforeVerification.body.error.hint).toContain('verify');

    const verified = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/sources/posthog/' + configured.body.id + '/verify',
      {},
    );
    expect(verified.status).toBe(200);
    expect(verified.body.status).toBe('verified');

    const schema = await api(
      env,
      env.secretToken,
      'GET',
      '/api/v1/projects/' + env.projectSlug + '/sources/posthog/' + configured.body.id + '/schema',
    );
    expect(schema.status).toBe(200);
    expect(schema.body).toMatchObject({
      events: [{ name: 'signup.completed' }],
      properties: [{ name: 'plan', scope: 'event', value_type: 'string' }],
    });

    const registered = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/metrics',
      {
        key: 'external_signups',
        name: 'External signups',
        purpose: 'Shows whether the connected PostHog signup outcome is improving.',
        type: 'unique_actors',
        source: {
          data_source: 'posthog',
          source_connection_id: configured.body.id,
          event: 'signup.completed',
          filters: [],
        },
      },
    );
    expect(registered.status).toBe(201);
    const activated = await api(
      env,
      env.secretToken,
      'PATCH',
      '/api/v1/projects/' + env.projectSlug + '/metrics/external_signups',
      { status: 'active' },
    );
    expect(activated.status).toBe(200);

    const trend = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/query',
      {
        kind: 'trend',
        metric: 'external_signups',
        date_from: '2026-07-18T00:00:00.000Z',
        date_to: '2026-07-19T00:00:00.000Z',
        interval: 'day',
        env: 'prod',
      },
    );
    expect(trend.status).toBe(200);
    expect(trend.body.series).toEqual([
      { bucket: '2026-07-18T00:00:00.000Z', value: 2 },
    ]);
    expect(trend.body.meta.source).toBe('posthog');

    const secondMetric = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/metrics',
      {
        key: 'external_activated',
        name: 'External activated',
        purpose: 'Shows whether connected PostHog users reach the first activation outcome.',
        type: 'unique_actors',
        source: {
          data_source: 'posthog',
          source_connection_id: configured.body.id,
          event: 'activation.completed',
          filters: [],
        },
      },
    );
    expect(secondMetric.status).toBe(201);
    await api(
      env,
      env.secretToken,
      'PATCH',
      '/api/v1/projects/' + env.projectSlug + '/metrics/external_activated',
      { status: 'active' },
    );
    const funnel = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/query',
      {
        kind: 'funnel',
        steps: [{ metric: 'external_signups' }, { metric: 'external_activated' }],
        date_from: '2026-07-18T00:00:00.000Z',
        date_to: '2026-07-21T00:00:00.000Z',
        env: 'prod',
      },
    );
    expect(funnel.status).toBe(200);
    expect(funnel.body.steps.map((step: { actors: number }) => step.actors)).toEqual([2, 1]);
    expect(funnel.body.meta.source).toBe('posthog');

    const retention = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/query',
      {
        kind: 'retention',
        start_metric: 'external_signups',
        return_metric: 'external_activated',
        date_from: '2026-07-18T00:00:00.000Z',
        date_to: '2026-07-21T00:00:00.000Z',
        interval: 'day',
        periods: 3,
        env: 'prod',
      },
    );
    expect(retention.status).toBe(200);
    expect(retention.body.cohorts[0]).toMatchObject({
      cohort: '2026-07-18T00:00:00.000Z',
      size: 2,
      retained: [2, 1, 0],
      retained_pct: [1, 0.5, 0],
    });
    expect(retention.body.meta.source).toBe('posthog');

    const sample = await api(
      env,
      env.secretToken,
      'GET',
      '/api/v1/projects/' + env.projectSlug
        + '/sources/posthog/' + configured.body.id
        + '/sample?event=signup.completed&limit=2',
    );
    expect(sample.status).toBe(200);
    expect(sample.body.events).toEqual([
      {
        event: 'signup.completed',
        timestamp: '2026-07-18T12:00:00.000Z',
        distinct_id: 'external-u1',
        properties: { plan: 'pro' },
      },
    ]);

    const localEvents = await env.pool.query(
      'SELECT count(*)::int AS count FROM events WHERE project_id = (SELECT id FROM projects WHERE slug = $1)',
      [env.projectSlug],
    );
    expect(localEvents.rows[0].count).toBe(0);

    const valueMetric = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/metrics',
      {
        key: 'external_revenue',
        name: 'External revenue',
        purpose: 'Shows whether connected PostHog revenue is improving after a release.',
        type: 'value',
        source: {
          data_source: 'posthog',
          source_connection_id: configured.body.id,
          event: 'invoice.paid',
          filters: [],
          value_property: 'amount',
          agg: 'sum',
        },
      },
    );
    expect(valueMetric.status).toBe(201);
    await api(
      env,
      env.secretToken,
      'PATCH',
      '/api/v1/projects/' + env.projectSlug + '/metrics/external_revenue',
      { status: 'active' },
    );
    const unsupported = await api(
      env,
      env.secretToken,
      'POST',
      '/api/v1/projects/' + env.projectSlug + '/query',
      {
        kind: 'trend',
        metric: 'external_revenue',
        date_from: '-7d',
        interval: 'day',
        env: 'prod',
      },
    );
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.error.code).toBe('posthog_capability_unsupported');

    expect(requests.every((request) => request.authorization === 'Bearer phx_controlled_secret')).toBe(true);
    expect(requests.every((request) => request.method === 'GET' || (
      request.method === 'POST' && request.url.endsWith('/query/')
    ))).toBe(true);
  });
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  if (req.method !== 'POST') return null;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function routeFixture(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown> | null,
): void {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/projects/42/event_definitions/?limit=100') {
    res.end(JSON.stringify({ results: [{ name: 'signup.completed' }] }));
    return;
  }
  if (req.url === '/api/projects/42/property_definitions/?limit=100') {
    res.end(JSON.stringify({
      results: [{ name: 'plan', property_type: 'String', type: 'event' }],
    }));
    return;
  }
  if (req.url === '/api/projects/42/query/' && req.method === 'POST') {
    const name = String(body?.name ?? '');
    if (name === 'poolstatis_connection_verify') {
      res.end(JSON.stringify({ columns: ['ok'], results: [[1]] }));
      return;
    }
    if (name === 'poolstatis_trend_external_signups') {
      res.end(JSON.stringify({
        columns: ['bucket', 'value'],
        results: [['2026-07-18T00:00:00.000Z', 2]],
      }));
      return;
    }
    if (name === 'poolstatis_funnel_external_signups_external_activated') {
      res.end(JSON.stringify({
        columns: ['step_0', 'step_1'],
        results: [[2, 1]],
      }));
      return;
    }
    if (name === 'poolstatis_retention_external_signups_external_activated') {
      res.end(JSON.stringify({
        columns: ['cohort', 'size', 'period', 'retained'],
        results: [
          ['2026-07-18T00:00:00.000Z', 2, 0, 2],
          ['2026-07-18T00:00:00.000Z', 2, 1, 1],
        ],
      }));
      return;
    }
  }
  if (req.url === '/api/projects/42/events/?event=signup.completed&limit=2') {
    res.end(JSON.stringify({
      results: [{
        event: 'signup.completed',
        timestamp: '2026-07-18T12:00:00.000Z',
        distinct_id: 'external-u1',
        properties: { plan: 'pro' },
      }],
    }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ detail: 'fixture route not found' }));
}
