import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createPool } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import { TEST_DB_URL } from './urls.js';
import type pg from 'pg';
import type { FastifyInstance } from 'fastify';

const issuer = 'https://issuer.cloud-auth.test/';
const audience = 'https://api.cloud-auth.test/';
const claims = {
  email: 'https://poolstatis.test/claims/email',
  emailVerified: 'https://poolstatis.test/claims/email_verified',
  displayName: 'https://poolstatis.test/claims/display_name',
  picture: 'https://poolstatis.test/claims/picture',
};

let pool: pg.Pool;
let app: FastifyInstance;
let privateKey: CryptoKey | Uint8Array;
let jwks: { keys: JWK[] };
let sequence = 0;

function uniqueSubject(label: string): string {
  sequence += 1;
  return `provider|${label}-${Date.now()}-${sequence}`;
}

async function token(input: {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  picture?: string;
}): Promise<string> {
  const payload: Record<string, string | boolean> = {};
  if (input.email !== undefined) payload[claims.email] = input.email;
  if (input.emailVerified !== undefined) payload[claims.emailVerified] = input.emailVerified;
  if (input.displayName !== undefined) payload[claims.displayName] = input.displayName;
  if (input.picture !== undefined) payload[claims.picture] = input.picture;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'cloud-auth-test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(input.sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function api(method: 'GET' | 'PATCH', url: string, authToken: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${authToken}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: response.statusCode, body: response.json() };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: 'cloud-auth-test-key', alg: 'RS256', use: 'sig' }] };
  pool = createPool(TEST_DB_URL);
  app = buildServer(pool, {
    auth: {
      issuer,
      audience,
      jwks: async () => jwks,
      claims,
      connectionStrategy: 'oidc-test',
    },
    corsOrigins: ['https://console.poolstatis.test'],
  });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('verified hosted JWT profile', () => {
  it('reads namespaced claims into a local profile, membership, and identity', async () => {
    const sub = uniqueSubject('profile');
    const result = await api('GET', '/api/v1/me', await token({
      sub,
      email: 'ada.profile@example.com',
      emailVerified: true,
      displayName: 'Ada Profile',
      picture: 'https://images.example.com/ada.png',
    }));

    expect(result.status).toBe(200);
    expect(result.body.user).toMatchObject({
      subject: sub,
      email: 'ada.profile@example.com',
      email_verified: true,
      display_name: 'Ada Profile',
      picture_url: 'https://images.example.com/ada.png',
      connection_strategy: 'oidc-test',
    });
    expect(result.body.membership).toMatchObject({ role: 'owner' });
    expect(result.body.identity).toEqual({ issuer, subject: sub });
  });

  it.each([undefined, false])('rejects an unverified email before provisioning (%s)', async (emailVerified) => {
    const sub = uniqueSubject('unverified');
    const result = await api('GET', '/api/v1/me', await token({
      sub,
      email: 'unverified@example.com',
      ...(emailVerified === undefined ? {} : { emailVerified }),
    }));

    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      error: expect.objectContaining({ code: 'email_verification_required' }),
    });
    expect(JSON.stringify(result.body)).not.toContain('unverified@example.com');
    const stored = await pool.query('SELECT 1 FROM auth_users WHERE subject = $1', [sub]);
    expect(stored.rowCount).toBe(0);
  });

  it('reuses one account and membership for concurrent first logins', async () => {
    const sub = uniqueSubject('concurrent');
    const authToken = await token({
      sub,
      email: 'concurrent@example.com',
      emailVerified: true,
      displayName: 'Concurrent User',
    });
    const [first, second] = await Promise.all([
      api('GET', '/api/v1/me', authToken),
      api('GET', '/api/v1/me', authToken),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.user.id).toBe(second.body.user.id);
    const counts = await pool.query(
      `SELECT count(*)::int AS users,
              (SELECT count(*)::int FROM organization_members om WHERE om.user_id = au.id) AS memberships
       FROM auth_users au
       WHERE au.subject = $1
       GROUP BY au.id`,
      [sub],
    );
    expect(counts.rows).toEqual([{ users: 1, memberships: 1 }]);
  });

  it('updates only the local display name and ignores forged identity fields', async () => {
    const sub = uniqueSubject('patch');
    const authToken = await token({
      sub,
      email: 'local-profile@example.com',
      emailVerified: true,
      displayName: 'Remote Name',
      picture: 'https://images.example.com/remote.png',
    });
    const initial = await api('GET', '/api/v1/me', authToken);
    expect(initial.status).toBe(200);

    const patched = await api('PATCH', '/api/v1/me', authToken, {
      display_name: 'Local Name',
      email: 'forged@example.com',
      email_verified: false,
      picture_url: 'https://attacker.example/forged.png',
      connection_strategy: 'forged',
      subject: 'forged-subject',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.user).toMatchObject({
      email: 'local-profile@example.com',
      email_verified: true,
      display_name: 'Local Name',
      picture_url: 'https://images.example.com/remote.png',
      connection_strategy: 'oidc-test',
      subject: sub,
    });

    const readBack = await api('GET', '/api/v1/me', authToken);
    expect(readBack.body.user.display_name).toBe('Local Name');
    expect(readBack.body.user.email).toBe('local-profile@example.com');
  });

  it('allows only the configured CORS origin', async () => {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/ready',
      headers: {
        origin: 'https://console.poolstatis.test',
        'access-control-request-method': 'GET',
      },
    });
    const rejected = await app.inject({
      method: 'OPTIONS',
      url: '/ready',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'GET',
      },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('https://console.poolstatis.test');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });
});
