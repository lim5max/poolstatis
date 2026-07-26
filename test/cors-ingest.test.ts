import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { buildServer } from '../src/http/server.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const LANDING_ORIGIN = 'https://poolstatis.xyz';
const APP_ORIGIN = 'https://app.poolstatis.xyz';
const ATTACKER_ORIGIN = 'https://attacker.example';
const CORS_ORIGINS = [APP_ORIGIN, LANDING_ORIGIN];

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

  it('does not grant CORS access to an unlisted origin', async () => {
    const preflight = await env.app.inject({
      method: 'OPTIONS',
      url: '/i/v1/events',
      headers: {
        origin: ATTACKER_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    const actual = await env.app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: {
        origin: ATTACKER_ORIGIN,
        authorization: 'Bearer invalid-token',
      },
      payload: { events: [] },
    });

    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(actual.headers['access-control-allow-origin']).toBeUndefined();
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
