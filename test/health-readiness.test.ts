import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import { TEST_DB_URL } from './urls.js';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';

let pool: pg.Pool | undefined;
let app: FastifyInstance | undefined;

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

describe('database readiness', () => {
  it('reports ready only while the database dependency is reachable and sanitizes failures', async () => {
    pool = createPool(TEST_DB_URL);
    app = buildServer(pool);

    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', service: 'poolstatis' });

    await pool.end();
    pool = undefined;
    const unavailable = await app.inject({ method: 'GET', url: '/ready' });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      error: { code: 'dependencies_not_ready', message: 'dependencies are not ready' },
    });
    expect(unavailable.body).not.toContain(TEST_DB_URL);
  });
});
