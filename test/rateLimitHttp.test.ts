import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createPool } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import { createApiKey, createOrganization, createProject } from '../src/services/projects.js';
import type { TenantRateLimitOptions } from '../src/services/rateLimiter.js';
import { TEST_DB_URL } from './urls.js';

const lowLimits: TenantRateLimitOptions = {
  ingest: {
    key: { ratePerSecond: 0.01, burst: 2 },
    project: { ratePerSecond: 0.01, burst: 3 },
  },
  api: {
    key: { ratePerSecond: 0.01, burst: 1 },
    project: { ratePerSecond: 0.01, burst: 3 },
  },
  maxEntries: 100,
  maxEntriesPerTenant: 100,
  idleTtlMs: 60_000,
};

let pool: pg.Pool;
let app: FastifyInstance;
let projectId: string;
let ingestA: string;
let ingestB: string;
let otherIngest: string;
let secret: string;
let canonicalSlug: string;
let canonicalIngest: string;
let personal: string;
let secretB: string;
let secretC: string;
let secretD: string;
let secretE: string;
let oversizedIngest: string;
let mixedIngest: string;
let lookupSlug: string;
let lookupBad: string;
let lookupBad2: string;
let lookupBad3: string;
let lookupGood: string;

beforeAll(async () => {
  pool = createPool(TEST_DB_URL);
  app = buildServer(pool, { rateLimit: lowLimits });
  const org = await createOrganization(pool, `rate-limit-org-${Date.now()}`);
  const project = await createProject(pool, org.id, `rate-limit-${Date.now()}`, 'Rate limited');
  const other = await createProject(pool, org.id, `rate-limit-other-${Date.now()}`, 'Other project');
  projectId = project.id;
  ingestA = (await createApiKey(pool, { orgId: org.id, projectId, kind: 'ingest' })).token;
  ingestB = (await createApiKey(pool, { orgId: org.id, projectId, kind: 'ingest' })).token;
  otherIngest = (await createApiKey(pool, { orgId: org.id, projectId: other.id, kind: 'ingest' })).token;
  secret = (await createApiKey(pool, { orgId: org.id, projectId, kind: 'secret' })).token;
  const canonical = await createProject(pool, org.id, `rate-limit-canonical-${Date.now()}`, 'Canonical project');
  canonicalSlug = canonical.slug;
  canonicalIngest = (await createApiKey(pool, { orgId: org.id, projectId: canonical.id, kind: 'ingest' })).token;
  secretB = (await createApiKey(pool, { orgId: org.id, projectId: canonical.id, kind: 'secret' })).token;
  secretC = (await createApiKey(pool, { orgId: org.id, projectId: canonical.id, kind: 'secret' })).token;
  secretD = (await createApiKey(pool, { orgId: org.id, projectId: canonical.id, kind: 'secret' })).token;
  secretE = (await createApiKey(pool, { orgId: org.id, projectId: canonical.id, kind: 'secret' })).token;
  personal = (await createApiKey(pool, { orgId: org.id, projectId: null, kind: 'personal', legacySelfHost: true })).token;
  const oversized = await createProject(pool, org.id, `rate-limit-oversized-${Date.now()}`, 'Oversized project');
  oversizedIngest = (await createApiKey(pool, { orgId: org.id, projectId: oversized.id, kind: 'ingest' })).token;
  const mixed = await createProject(pool, org.id, `rate-limit-mixed-${Date.now()}`, 'Mixed payload project');
  mixedIngest = (await createApiKey(pool, { orgId: org.id, projectId: mixed.id, kind: 'ingest' })).token;
  const lookupOrg = await createOrganization(pool, `rate-limit-lookup-org-${Date.now()}`);
  const lookup = await createProject(pool, lookupOrg.id, `rate-limit-lookup-${Date.now()}`, 'Lookup project');
  lookupSlug = lookup.slug;
  lookupBad = (await createApiKey(pool, { orgId: lookupOrg.id, projectId: lookup.id, kind: 'secret' })).token;
  lookupBad2 = (await createApiKey(pool, { orgId: lookupOrg.id, projectId: lookup.id, kind: 'secret' })).token;
  lookupBad3 = (await createApiKey(pool, { orgId: lookupOrg.id, projectId: lookup.id, kind: 'secret' })).token;
  lookupGood = (await createApiKey(pool, { orgId: lookupOrg.id, projectId: lookup.id, kind: 'secret' })).token;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('HTTP tenant rate limits', () => {
  it('enforces atomic per-key and per-project event budgets without affecting another project', async () => {
    const first = await event(ingestA, 'rate.first');
    expect(first.statusCode, first.body).toBe(200);
    expect((await event(ingestA, 'rate.second')).statusCode).toBe(200);
    const keyLimited = await event(ingestA, 'rate.key_rejected');
    expect(keyLimited.statusCode).toBe(429);
    expect(keyLimited.json().error).toEqual(expect.objectContaining({ code: 'rate_limited' }));
    expect(Number(keyLimited.headers['retry-after'])).toBeGreaterThan(0);

    expect((await event(ingestB, 'rate.project_last')).statusCode).toBe(200);
    const projectLimited = await event(ingestB, 'rate.project_rejected');
    expect(projectLimited.statusCode).toBe(429);
    expect(projectLimited.json().error.message).toContain('project');

    const isolated = await event(otherIngest, 'rate.other_project');
    expect(isolated.statusCode).toBe(200);
    expect(isolated.headers['x-ratelimit-remaining']).toBeDefined();

    const stored = await pool.query<{ event: string }>(
      `SELECT event FROM events WHERE project_id = $1 AND event LIKE 'rate.%' ORDER BY event`,
      [projectId],
    );
    expect(stored.rows.map((row) => row.event)).toEqual([
      'rate.first',
      'rate.project_last',
      'rate.second',
    ]);
  });

  it('also limits Platform API calls used by MCP clients', async () => {
    const first = await app.inject({
      method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${secret}` },
    });
    const second = await app.inject({
      method: 'GET', url: '/api/v1/projects', headers: { authorization: `Bearer ${secret}` },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('rate_limited');
  });

  it('does not charge wrong-key-kind requests and shares one canonical project budget across secret and personal tokens', async () => {
    for (let index = 0; index < 5; index += 1) {
      const wrongKind = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${canonicalSlug}/schema`,
        headers: { authorization: `Bearer ${canonicalIngest}` },
      });
      expect(wrongKind.statusCode).toBe(403);
    }

    for (let index = 0; index < 3; index += 1) {
      const wrongRouteAuth = await app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(wrongRouteAuth.statusCode).toBe(403);
    }

    for (const token of [secretC, secretD, personal]) {
      const accepted = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${canonicalSlug}/schema`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(accepted.statusCode).toBe(200);
    }
    const projectLimited = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${canonicalSlug}/schema`,
      headers: { authorization: `Bearer ${secretE}` },
    });
    expect(projectLimited.statusCode).toBe(429);
    expect(projectLimited.json().error.message).toContain('project');
  });

  it('bounds credential lookup attempts before project resolution without burning a real project budget', async () => {
    for (let index = 0; index < 10; index += 1) {
      const missing = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/missing-${index}/schema`,
        headers: { authorization: `Bearer ${lookupBad}` },
      });
      expect(missing.statusCode).toBe(404);
    }
    for (let index = 0; index < 10; index += 1) {
      const missing = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/also-missing-${index}/schema`,
        headers: { authorization: `Bearer ${lookupBad2}` },
      });
      expect(missing.statusCode).toBe(404);
    }

    const isolated = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${lookupSlug}/schema`,
      headers: { authorization: `Bearer ${lookupGood}` },
    });
    expect(isolated.statusCode).toBe(200);

    const limited = await app.inject({
      method: 'GET',
      url: '/api/v1/projects/missing-final/schema',
      headers: { authorization: `Bearer ${lookupBad3}` },
    });
    expect(limited.statusCode).toBe(429);
  });

  it('charges the matched ingest route and rejects mixed top-level payloads', async () => {
    const mixed = await app.inject({
      method: 'POST',
      url: '/i/v1/entities',
      headers: { authorization: `Bearer ${mixedIngest}` },
      payload: {
        events: [{ event: 'undercharged.event', distinct_id: 'actor' }],
        entities: [
          { entity_type: 'user', entity_id: 'one', properties: {} },
          { entity_type: 'user', entity_id: 'two', properties: {} },
        ],
      },
    });
    expect(mixed.statusCode).toBe(400);

    const lastAccepted = await app.inject({
      method: 'POST',
      url: '/i/v1/entities',
      headers: { authorization: `Bearer ${mixedIngest}` },
      payload: { entities: [{ entity_type: 'user', entity_id: 'three', properties: {} }] },
    });
    expect(lastAccepted.statusCode).toBe(429);
  });

  it('returns a permanent batch-too-large error without a misleading Retry-After header', async () => {
    const oversized = await app.inject({
      method: 'POST',
      url: '/i/v1/events',
      headers: { authorization: `Bearer ${oversizedIngest}` },
      payload: { events: [
        { event: 'oversized.one', distinct_id: 'actor' },
        { event: 'oversized.two', distinct_id: 'actor' },
        { event: 'oversized.three', distinct_id: 'actor' },
      ] },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.headers['retry-after']).toBeUndefined();
    expect(oversized.json().error.code).toBe('rate_limit_batch_too_large');

    expect((await event(oversizedIngest, 'oversized.valid')).statusCode).toBe(200);
  });
});

async function event(token: string, name: string) {
  return app.inject({
    method: 'POST',
    url: '/i/v1/events',
    headers: { authorization: `Bearer ${token}` },
    payload: { events: [{ event: name, distinct_id: 'rate-actor' }] },
  });
}
