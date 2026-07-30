import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createPool } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import { TEST_DB_URL } from './urls.js';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';

let pool: pg.Pool;
let app: FastifyInstance;
let privateKey: CryptoKey | Uint8Array;
let jwks: { keys: JWK[] };

const issuer = 'https://auth.poolstatis.test/';
const audience = 'https://api.poolstatis.test/';

async function authToken(sub: string, email: string, name: string): Promise<string> {
  return new SignJWT({ email, email_verified: true, name })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function authApi(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const token = await authToken('auth0|user-1', 'ada@example.com', 'Ada Lovelace');
  return authApiAs(token, method, url, payload);
}

async function authApiAs(token: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] };
  pool = createPool(TEST_DB_URL);
  app = buildServer(pool, {
    auth: {
      issuer,
      audience,
      jwks: async () => jwks,
    },
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('hosted auth onboarding', () => {
  it('creates a hosted user, default org, and exposes only the generic events_stored meter on first /me', async () => {
    const res = await authApi('GET', '/api/v1/me');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      subject: 'auth0|user-1',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
    });
    expect(res.body.organization.name).toBe("Ada Lovelace's workspace");
    expect(res.body.billing.plan).toMatchObject({
      id: 'free',
      price_cents: 0,
      currency: 'USD',
    });
    expect(res.body.billing.meters.map((m: any) => m.key)).toEqual(['events_stored']);
    expect(res.body.onboarding.completed).toBe(false);
  });

  it('creates the first project and one-time MCP tokens', async () => {
    const before = await authApi('GET', '/api/v1/me');
    const res = await authApi('POST', '/api/v1/onboarding', {
      workspace_name: 'Attacker-controlled replacement name',
      project_slug: 'agent-product',
      project_name: 'Agent Product',
    });

    expect(res.status).toBe(201);
    expect(res.body.organization.id).toBe(before.body.organization.id);
    expect(res.body.organization.name).toBe(before.body.organization.name);
    expect(res.body.project).toMatchObject({
      slug: 'agent-product',
      name: 'Agent Product',
    });
    expect(res.body.tokens.personal).toMatch(/^pt_/);
    expect(res.body.tokens.ingest_prod).toMatch(/^pk_/);
    expect(res.body.mcp.env.POOLSTATIS_TOKEN).toBe(res.body.tokens.personal);
    expect(res.body.mcp.package_status).toBe('publish_pending');
    expect(res.body.mcp.env.POOLSTATIS_URL).not.toContain('127.0.0.1');
    expect(res.body.mcp.env.POOLSTATIS_URL).not.toContain('localhost');

    const projects = await authApi('GET', '/api/v1/projects');
    expect(projects.status).toBe(200);
    expect(projects.body.projects.map((p: any) => p.slug)).toContain('agent-product');
  });

  it('blocks repeat hosted onboarding after the first project exists', async () => {
    const res = await authApi('POST', '/api/v1/onboarding', {
      workspace_name: 'Analytical Engines',
      project_slug: 'second-product',
      project_name: 'Second Product',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('onboarding_complete');
  });

  it('lets hosted owners issue a replacement personal MCP token', async () => {
    const res = await authApi('POST', '/api/v1/me/tokens', { label: 'Codex laptop' });

    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^pt_/);
  });

  it('does not allow read-only members to manage platform routes', async () => {
    const owner = await authApi('GET', '/api/v1/me');
    const { rows } = await pool.query(
      `INSERT INTO auth_users (
         identity_issuer, subject, email, email_verified, display_name, name
       ) VALUES ($1, $2, $3, true, $4, $4)
       RETURNING id`,
      [issuer, 'auth0|member-1', 'member@example.com', 'Member User'],
    );
    await pool.query(
      'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
      [owner.body.organization.id, rows[0].id, 'member'],
    );

    const memberToken = await authToken('auth0|member-1', 'member@example.com', 'Member User');
    const res = await authApiAs(memberToken, 'GET', '/api/v1/projects');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('insufficient_role');
    const usage = await authApiAs(memberToken, 'GET', `/api/v1/me/usage?period=${new Date().toISOString().slice(0, 7)}`);
    expect(usage.status).toBe(403);
    expect(usage.body.error.code).toBe('insufficient_role');
  });
});
