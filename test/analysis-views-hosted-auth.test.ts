import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

import { createPool } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import { analysisViewInput } from './analysis-view-fixtures.js';
import { TEST_DB_URL } from './urls.js';

let pool: pg.Pool;
let app: FastifyInstance;
let privateKey: CryptoKey | Uint8Array;
let jwks: { keys: JWK[] };
const issuer = 'https://saved-answer-auth.poolstatis.test/';
const audience = 'https://saved-answer-api.poolstatis.test/';

async function jwt(subject: string, role: string): Promise<string> {
  return new SignJWT({
    email: `${subject}@example.test`, email_verified: true, name: role,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'saved-answer-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function request(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  payload?: unknown,
) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json() };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: 'saved-answer-key', alg: 'RS256', use: 'sig' }] };
  pool = createPool(TEST_DB_URL);
  app = buildServer(pool, { auth: { issuer, audience, jwks: async () => jwks } });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('saved-answer hosted authorization', () => {
  it('allows owner/admin official state, lets sk_ create, and denies a workspace member', async () => {
    const suffix = `${Date.now()}-${process.pid}`;
    const ownerSubject = `owner-${suffix}`;
    const ownerToken = await jwt(ownerSubject, 'Owner');
    const me = await request(ownerToken, 'GET', '/api/v1/me');
    expect(me.status).toBe(200);
    const orgId = me.body.organization.id as string;
    const slug = `answer-auth-${suffix}`;
    expect((await request(ownerToken, 'POST', '/api/v1/projects', {
      slug, name: 'Saved answer auth',
    })).status).toBe(201);

    const key = await request(ownerToken, 'POST', `/api/v1/projects/${slug}/keys`, { kind: 'secret' });
    expect(key.status).toBe(201);
    const secret = key.body.token as string;
    expect((await request(secret, 'POST', `/api/v1/projects/${slug}/metrics`, {
      key: 'activation_completed',
      name: 'Activation completed',
      type: 'count',
      purpose: 'Measures the first meaningful activation completion outcome.',
      source: { event: 'activation.completed' },
    })).status).toBe(201);
    expect((await request(secret, 'PATCH', `/api/v1/projects/${slug}/metrics/activation_completed`, {
      status: 'active',
    })).status).toBe(200);

    const created = await request(secret, 'POST', `/api/v1/projects/${slug}/analysis-views`, analysisViewInput(slug));
    expect(created.status).toBe(201);
    const id = created.body.view.id as string;
    expect((await request(secret, 'PUT', `/api/v1/projects/${slug}/analysis-views/${id}/official`, {
      official: true,
    })).status).toBe(403);

    const tokens: Record<'admin' | 'member', string> = { admin: '', member: '' };
    for (const role of ['admin', 'member'] as const) {
      const subject = `${role}-${suffix}`;
      const user = await pool.query<{ id: string }>(
        `INSERT INTO auth_users (identity_issuer, subject, email, email_verified, display_name, name)
         VALUES ($1, $2, $3, true, $4, $4) RETURNING id`,
        [issuer, subject, `${subject}@example.test`, role],
      );
      await pool.query(
        'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
        [orgId, user.rows[0]!.id, role],
      );
      tokens[role] = await jwt(subject, role);
    }

    const adminOfficial = await request(
      tokens.admin,
      'PUT',
      `/api/v1/projects/${slug}/analysis-views/${id}/official`,
      { official: true },
    );
    expect(adminOfficial.status).toBe(200);
    expect(adminOfficial.body.view).toMatchObject({ official: true, created_by: { kind: 'secret', role: null } });

    const ownerOfficial = await request(
      ownerToken,
      'PUT',
      `/api/v1/projects/${slug}/analysis-views/${id}/official`,
      { official: false },
    );
    expect(ownerOfficial.status).toBe(200);
    expect(ownerOfficial.body.view.official).toBe(false);

    const memberDenied = await request(
      tokens.member,
      'PUT',
      `/api/v1/projects/${slug}/analysis-views/${id}/official`,
      { official: true },
    );
    expect(memberDenied.status).toBe(403);
    expect(memberDenied.body.error.code).toBe('insufficient_role');
  });
});
