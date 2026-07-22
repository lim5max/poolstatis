import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createPool } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import { createApiKey } from '../src/services/projects.js';
import { TEST_DB_URL } from './urls.js';

let pool: pg.Pool;
let app: FastifyInstance;
let privateKey: CryptoKey | Uint8Array;
let jwks: { keys: JWK[] };

const issuer = 'https://tenant-auth.poolstatis.test/';
const audience = 'https://tenant-api.poolstatis.test/';
let sequence = 0;

async function jwt(sub: string, email: string, name: string): Promise<string> {
  return new SignJWT({ email, email_verified: true, name })
    .setProtectedHeader({ alg: 'RS256', kid: 'tenant-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function request(
  token: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  mcp = false,
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(mcp ? { 'x-poolstatis-client': 'mcp' } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json() };
}

async function createHostedOrg(label: string) {
  const id = `${label}-${Date.now()}-${sequence++}`;
  const token = await jwt(`auth0|${id}`, `${id}@example.test`, label);
  const me = await request(token, 'GET', '/api/v1/me');
  expect(me.status).toBe(200);
  return { token, orgId: me.body.organization.id };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: 'tenant-key', alg: 'RS256', use: 'sig' }] };
  pool = createPool(TEST_DB_URL);
  app = buildServer(pool, { auth: { issuer, audience, jwks: async () => jwks } });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('cloud tenant boundaries', () => {
  it('keeps same project slug, metric key and actor ID isolated in REST and MCP contexts', async () => {
    const alpha = await createHostedOrg('alpha');
    const beta = await createHostedOrg('beta');
    const slug = `same-slug-${Date.now()}-${sequence++}`;

    for (const tenant of [alpha, beta]) {
      const project = await request(tenant.token, 'POST', '/api/v1/projects', { slug, name: 'Same slug' });
      expect(project.status).toBe(201);
    }

    const keys = await Promise.all([alpha, beta].map(async (tenant) => {
      const secret = await request(tenant.token, 'POST', `/api/v1/projects/${slug}/keys`, { kind: 'secret' });
      const ingest = await request(tenant.token, 'POST', `/api/v1/projects/${slug}/keys`, { kind: 'ingest' });
      expect(secret.status).toBe(201);
      expect(ingest.status).toBe(201);
      return { secret: secret.body.token as string, ingest: ingest.body.token as string };
    }));

    const metric = 'same_metric';
    for (const [index, tenant] of [alpha, beta].entries()) {
      const registered = await request(keys[index].secret, 'POST', `/api/v1/projects/${slug}/metrics`, {
        key: metric,
        name: 'Same metric',
        type: 'count',
        purpose: 'Proves tenant-specific events remain isolated.',
        source: { event: 'same.event' },
      });
      expect(registered.status).toBe(201);
      const ingested = await request(keys[index].ingest, 'POST', '/i/v1/events', {
        events: [{ event: 'same.event', distinct_id: 'same-actor', properties: { tenant: index === 0 ? 'alpha' : 'beta' } }],
      });
      expect(ingested.status).toBe(200);
    }

    const alphaSample = await request(keys[0].secret, 'GET', `/api/v1/projects/${slug}/events/sample?event=same.event`);
    const betaSample = await request(keys[1].secret, 'GET', `/api/v1/projects/${slug}/events/sample?event=same.event`);
    expect(alphaSample.body.events.map((event: any) => event.properties.tenant)).toEqual(['alpha']);
    expect(betaSample.body.events.map((event: any) => event.properties.tenant)).toEqual(['beta']);

    const alphaPersonal = await createApiKey(pool, { orgId: alpha.orgId, projectId: null, kind: 'personal' });
    const betaPersonal = await createApiKey(pool, { orgId: beta.orgId, projectId: null, kind: 'personal' });
    const alphaMcpProjects = await request(alphaPersonal.token, 'GET', '/api/v1/projects', undefined, true);
    const betaMcpProjects = await request(betaPersonal.token, 'GET', '/api/v1/projects', undefined, true);
    expect(alphaMcpProjects.body.projects.map((project: any) => project.slug)).toEqual([slug]);
    expect(betaMcpProjects.body.projects.map((project: any) => project.slug)).toEqual([slug]);
    expect((await request(alphaPersonal.token, 'GET', `/api/v1/projects/${slug}/metrics`, undefined, true)).body.metrics)
      .toHaveLength(1);
  });

  it('lets hosted owner/admin JWT and pt_ create only their own organization projects while sk_ is exact-project only', async () => {
    const owner = await createHostedOrg('owner');
    const other = await createHostedOrg('other');
    const baseSlug = `base-${Date.now()}-${sequence++}`;
    expect((await request(owner.token, 'POST', '/api/v1/projects', { slug: baseSlug, name: 'Base' })).status).toBe(201);

    const secret = await request(owner.token, 'POST', `/api/v1/projects/${baseSlug}/keys`, { kind: 'secret' });
    expect(secret.status).toBe(201);
    const secondSlug = `second-${Date.now()}-${sequence++}`;
    expect((await request(owner.token, 'POST', '/api/v1/projects', { slug: secondSlug, name: 'Second' })).status).toBe(201);
    const secretProjects = await request(secret.body.token, 'GET', '/api/v1/projects');
    expect(secretProjects.body).toMatchObject({ scope: 'project' });
    expect(secretProjects.body.projects.map((project: any) => project.slug)).toEqual([baseSlug]);
    const crossProjectRest = await request(secret.body.token, 'GET', `/api/v1/projects/${secondSlug}/metrics`);
    const crossProjectMcp = await request(secret.body.token, 'GET', `/api/v1/projects/${secondSlug}/metrics`, undefined, true);
    expect(crossProjectRest.status).toBe(403);
    expect(crossProjectRest.body.error.code).toBe('project_scope');
    expect(crossProjectMcp.status).toBe(403);
    expect(crossProjectMcp.body.error.code).toBe('project_scope');
    const denied = await request(secret.body.token, 'POST', '/api/v1/projects', {
      slug: `denied-${Date.now()}-${sequence++}`, name: 'Denied', orgId: other.orgId,
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('insufficient_scope');

    const { rows } = await pool.query(
      `INSERT INTO auth_users (identity_issuer, subject, email, email_verified, display_name, name)
       VALUES ($1, $2, $3, true, $4, $4) RETURNING id`,
      [issuer, `auth0|admin-${sequence}`, `admin-${sequence}@example.test`, 'Admin'],
    );
    await pool.query(
      'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
      [owner.orgId, rows[0].id, 'admin'],
    );
    const adminToken = await jwt(`auth0|admin-${sequence}`, `admin-${sequence}@example.test`, 'Admin');
    const adminCreated = await request(adminToken, 'POST', '/api/v1/projects', {
      slug: `admin-${Date.now()}-${sequence++}`, name: 'Admin project', orgId: other.orgId,
    });
    expect(adminCreated.status).toBe(201);

    const personal = await createApiKey(pool, { orgId: owner.orgId, projectId: null, kind: 'personal' });
    const personalCreated = await request(personal.token, 'POST', '/api/v1/projects', {
      slug: `personal-${Date.now()}-${sequence++}`, name: 'Personal project', orgId: other.orgId,
    });
    expect(personalCreated.status).toBe(201);

    const ownerProjects = await request(owner.token, 'GET', '/api/v1/projects');
    const otherProjects = await request(other.token, 'GET', '/api/v1/projects');
    expect(ownerProjects.body.projects).toHaveLength(4);
    expect(otherProjects.body.projects).toHaveLength(0);

    const baseProject = await pool.query(
      'SELECT id FROM projects WHERE org_id = $1 AND slug = $2', [owner.orgId, baseSlug],
    );
    await expect(pool.query(
      `INSERT INTO api_keys (org_id, project_id, kind, token_hash)
       VALUES ($1, $2, 'secret', $3)`,
      [other.orgId, baseProject.rows[0].id, `cross-org-${Date.now()}-${sequence++}`],
    )).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(
      `INSERT INTO api_keys (org_id, project_id, kind, token_hash)
       VALUES ($1, NULL, 'secret', $2)`,
      [owner.orgId, `unbound-secret-${Date.now()}-${sequence++}`],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO api_keys (org_id, project_id, kind, token_hash)
       VALUES ($1, $2, 'personal', $3)`,
      [owner.orgId, baseProject.rows[0].id, `bound-personal-${Date.now()}-${sequence++}`],
    )).rejects.toMatchObject({ code: '23514' });
  });
});
