import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildServer } from '../src/http/server.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const LANDING_ORIGIN = 'https://poolstatis.xyz';
const APP_ORIGIN = 'https://app.poolstatis.xyz';
const CUSTOMER_ORIGIN = 'https://customer.example';
const INSECURE_CUSTOMER_ORIGIN = 'http://customer.example';
const CORS_ORIGINS = [APP_ORIGIN, LANDING_ORIGIN];
const PUBLIC_BROWSER_WRITE_ROUTES = [
  '/i/v1/events',
  '/i/v1/experience/events',
  '/i/v1/flags/evaluate',
] as const;

let env: TestEnv;

function expectAllowedOrigin(
  response: { headers: Record<string, string | string[] | undefined> },
  origin: string,
): void {
  expect(response.headers['access-control-allow-origin']).toBe(origin);
  expect(response.headers.vary).toContain('Origin');
}

beforeAll(async () => {
  env = await createTestEnv({ corsOrigins: CORS_ORIGINS });
});

afterAll(async () => {
  await env.close();
});

describe('browser ingest CORS', () => {
  it('allows the configured hosted app to preflight project intent PUT', async () => {
    const response = await env.app.inject({
      method: 'OPTIONS',
      url: `/api/v1/projects/${env.projectSlug}/intent`,
      headers: {
        origin: APP_ORIGIN,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

    expect(response.statusCode).toBe(204);
    expectAllowedOrigin(response, APP_ORIGIN);
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    expect(response.headers['access-control-allow-headers']).toContain('content-type');
  });

  it.each([LANDING_ORIGIN, APP_ORIGIN])(
    'answers the %s ingest preflight with the exact CORS contract',
    async (origin) => {
      const response = await env.app.inject({
        method: 'OPTIONS',
        url: '/i/v1/events',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });

      expect(response.statusCode).toBe(204);
      expectAllowedOrigin(response, origin);
      expect(response.headers['access-control-allow-methods']).toContain('POST');
      expect(response.headers['access-control-allow-headers']).toContain('authorization');
      expect(response.headers['access-control-allow-headers']).toContain('content-type');
    },
  );

  it.each(PUBLIC_BROWSER_WRITE_ROUTES)(
    'allows a future HTTPS customer origin to preflight only %s',
    async (url) => {
      const response = await env.app.inject({
        method: 'OPTIONS',
        url,
        headers: {
          origin: CUSTOMER_ORIGIN,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type,x-poolstatis-client',
        },
      });

      expect(response.statusCode).toBe(204);
      expectAllowedOrigin(response, CUSTOMER_ORIGIN);
      expect(response.headers['access-control-allow-methods']).toBe('POST');
      expect(response.headers['access-control-allow-headers']).toContain('authorization');
      expect(response.headers['access-control-allow-headers']).toContain('content-type');
      expect(response.headers['access-control-allow-headers']).toContain('x-poolstatis-client');
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    },
  );

  it.each([
    ['/i/v1/replays', 'POST'],
    ['/i/v1/replays/11111111-1111-4111-8111-111111111111/chunks', 'PUT'],
    ['/i/v1/replays/11111111-1111-4111-8111-111111111111/complete', 'POST'],
    ['/i/v1/replays/11111111-1111-4111-8111-111111111111', 'DELETE'],
  ] as const)('allows only the required replay method for %s', async (url, method) => {
    const response = await env.app.inject({
      method: 'OPTIONS',
      url,
      headers: {
        origin: CUSTOMER_ORIGIN,
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(response.statusCode).toBe(204);
    expectAllowedOrigin(response, CUSTOMER_ORIGIN);
    expect(response.headers['access-control-allow-methods']).toBe(method);
  });

  it('reflects a future HTTPS customer origin only for an actual pk_ ingest request', async () => {
    const accepted = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        origin: CUSTOMER_ORIGIN,
        authorization: `Bearer ${env.ingestToken}`,
      },
      payload: {
        events: [{ event: 'customer.cors.accepted', distinct_id: 'cors-test-user' }],
      },
    });
    const secretKey = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        origin: CUSTOMER_ORIGIN,
        authorization: `Bearer ${env.secretToken}`,
      },
      payload: { events: [] },
    });
    const malformedIngestKey = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        origin: CUSTOMER_ORIGIN,
        authorization: 'Bearer invalid-token',
      },
      payload: { events: [] },
    });

    expect(accepted.statusCode).toBe(200);
    expectAllowedOrigin(accepted, CUSTOMER_ORIGIN);
    expect(secretKey.statusCode).toBe(403);
    expect(secretKey.headers['access-control-allow-origin']).toBeUndefined();
    expect(malformedIngestKey.statusCode).toBe(401);
    expect(malformedIngestKey.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(PUBLIC_BROWSER_WRITE_ROUTES)(
    'keeps a neutral auth error readable for a malformed pk_-shaped token on %s',
    async (url) => {
      const response = await env.app.inject({
        method: 'POST',
        url,
        headers: {
          origin: CUSTOMER_ORIGIN,
          authorization: 'Bearer pk_not-a-real-key',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      expectAllowedOrigin(response, CUSTOMER_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    },
  );

  it('keeps platform, entity, unknown, insecure, and null origins closed', async () => {
    const cases = [
      { url: '/api/v1/projects', origin: CUSTOMER_ORIGIN, method: 'GET' },
      { url: '/i/v1/entities', origin: CUSTOMER_ORIGIN, method: 'POST' },
      { url: '/i/v1/not-found', origin: CUSTOMER_ORIGIN, method: 'POST' },
      { url: '/i/v1/events', origin: INSECURE_CUSTOMER_ORIGIN, method: 'POST' },
      { url: '/i/v1/events', origin: 'null', method: 'POST' },
    ] as const;

    for (const item of cases) {
      const response = await env.app.inject({
        method: 'OPTIONS',
        url: item.url,
        headers: {
          origin: item.origin,
          'access-control-request-method': item.method,
          'access-control-request-headers': 'authorization,content-type',
        },
      });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('rejects cookie-bearing and credentialed customer-origin ingest without storing an event', async () => {
    const preflight = await env.app.inject({
      method: 'OPTIONS',
      url: '/i/v1/events',
      headers: {
        origin: CUSTOMER_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,cookie',
      },
    });
    const actuals = await Promise.all(PUBLIC_BROWSER_WRITE_ROUTES.map((url) => env.app.inject({
      method: 'POST',
      url,
      headers: {
        origin: CUSTOMER_ORIGIN,
        authorization: `Bearer ${env.ingestToken}`,
        cookie: 'session=must-not-cross-origin',
      },
      payload: url === '/i/v1/events'
        ? { events: [{ event: 'customer.cors.cookie_rejected', distinct_id: 'cors-test-user' }] }
        : {},
    })));
    const stored = await env.pool.query(
      `SELECT count(*)::int AS count
       FROM events
       WHERE project_id = $1 AND event = 'customer.cors.cookie_rejected'`,
      [env.projectId],
    );

    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    for (const actual of actuals) {
      expect(actual.statusCode).toBe(403);
      expect(actual.headers['access-control-allow-origin']).toBeUndefined();
      expect(actual.headers['access-control-allow-credentials']).toBeUndefined();
    }
    expect(stored.rows[0]?.count).toBe(0);
  });

  it('adds the landing origin to successful and partial ingest responses', async () => {
    const accepted = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        origin: LANDING_ORIGIN,
        authorization: `Bearer ${env.ingestToken}`,
      },
      payload: {
        events: [{ event: 'landing.cors.accepted', distinct_id: 'cors-test-user' }],
      },
    });
    const partial = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        origin: LANDING_ORIGIN,
        authorization: `Bearer ${env.ingestToken}`,
      },
      payload: {
        events: [
          { event: 'landing.cors.partial', distinct_id: 'cors-test-user' },
          { event: 'landing.cors.invalid' },
        ],
      },
    });

    expect(accepted.statusCode).toBe(200);
    expectAllowedOrigin(accepted, LANDING_ORIGIN);
    expect(partial.statusCode).toBe(207);
    expectAllowedOrigin(partial, LANDING_ORIGIN);
  });

  it('preserves CORS headers on 401, 403, and 404 responses', async () => {
    const unauthorized = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        origin: LANDING_ORIGIN,
        authorization: 'Bearer invalid-token',
      },
      payload: { events: [] },
    });
    const forbidden = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        origin: LANDING_ORIGIN,
        authorization: `Bearer ${env.secretToken}`,
      },
      payload: { events: [] },
    });
    const notFound = await env.app.inject({
      method: 'POST',
      url: '/i/v1/not-found',
      headers: {
        origin: LANDING_ORIGIN,
        authorization: `Bearer ${env.ingestToken}`,
      },
      payload: {},
    });

    expect(unauthorized.statusCode).toBe(401);
    expectAllowedOrigin(unauthorized, LANDING_ORIGIN);
    expect(forbidden.statusCode).toBe(403);
    expectAllowedOrigin(forbidden, LANDING_ORIGIN);
    expect(notFound.statusCode).toBe(404);
    expectAllowedOrigin(notFound, LANDING_ORIGIN);
  });

  it('preserves CORS headers on a 5xx dependency response', async () => {
    const unavailablePool = {
      query: async () => {
        throw new Error('test dependency failure');
      },
    } as unknown as pg.Pool;
    const app = buildServer(unavailablePool, { corsOrigins: CORS_ORIGINS });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ready',
        headers: { origin: LANDING_ORIGIN },
      });

      expect(response.statusCode).toBe(503);
      expectAllowedOrigin(response, LANDING_ORIGIN);
    } finally {
      await app.close();
    }
  });
});
