import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createPool } from '../src/db.js';
import { buildServer, hasOrganizationManagementRole } from '../src/http/server.js';
import type { AuthContext } from '../src/http/auth.js';
import { createApiKey } from '../src/services/projects.js';
import { TEST_DB_URL } from './urls.js';

let pool: pg.Pool;
let app: FastifyInstance;
let privateKey: CryptoKey | Uint8Array;
let jwks: { keys: JWK[] };
let sequence = 0;
const issuer = 'https://token-auth.poolstatis.test/';
const audience = 'https://token-api.poolstatis.test/';

async function jwt(sub: string, email: string): Promise<string> {
  return new SignJWT({ email, email_verified: true, name: sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'token-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function request(
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json() };
}

async function hostedUser(label: string) {
  const id = `${label}-${Date.now()}-${sequence++}`;
  const token = await jwt(`auth0|${id}`, `${id}@example.test`);
  const me = await request(token, 'GET', '/api/v1/me');
  expect(me.status).toBe(200);
  return { token, orgId: me.body.organization.id };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: 'token-key', alg: 'RS256', use: 'sig' }] };
  pool = createPool(TEST_DB_URL);
  app = buildServer(pool, { auth: { issuer, audience, jwks: async () => jwks } });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('personal token lifecycle', () => {
  it('fails closed when hosted user contexts lack an owner/admin role, while legacy personal tokens remain compatible', () => {
    const base = { keyId: null, orgId: 'org', projectId: null, env: 'prod' };
    const missingUserRole: AuthContext = { ...base, kind: 'user', userId: 'user' };
    const missingBoundPersonalRole: AuthContext = { ...base, kind: 'personal', userId: 'user' };
    const legacyPersonal: AuthContext = { ...base, kind: 'personal' };

    expect(hasOrganizationManagementRole(missingUserRole)).toBe(false);
    expect(hasOrganizationManagementRole(missingBoundPersonalRole)).toBe(false);
    expect(hasOrganizationManagementRole(legacyPersonal)).toBe(true);
  });

  it('returns plaintext only at creation, lists a masked token, and records use without storing plaintext', async () => {
    const user = await hostedUser('lifecycle');
    const created = await request(user.token, 'POST', '/api/v1/me/tokens', { label: 'Codex laptop' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: expect.any(String), token: expect.stringMatching(/^pt_/) });

    const listed = await request(user.token, 'GET', '/api/v1/me/tokens');
    expect(listed.status).toBe(200);
    expect(listed.body.tokens).toContainEqual(expect.objectContaining({
      id: created.body.id,
      label: 'Codex laptop',
      token: expect.stringMatching(/^pt_.*\.\.\.[a-f0-9]{4}$/),
      created_at: expect.any(String),
      last_used_at: null,
      revoked_at: null,
    }));
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    const stored = await pool.query(
      'SELECT token_hash, last_used_at FROM api_keys WHERE id = $1', [created.body.id],
    );
    expect(stored.rows[0].token_hash).not.toBe(created.body.token);
    expect(stored.rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.rows[0].last_used_at).toBeNull();

    expect((await request(created.body.token, 'GET', '/api/v1/projects')).status).toBe(200);
    const used = await pool.query('SELECT last_used_at FROM api_keys WHERE id = $1', [created.body.id]);
    expect(used.rows[0].last_used_at).toBeTruthy();
  });

  it('revokes only a token owned by the authenticated user and invalidates it immediately', async () => {
    const owner = await hostedUser('token-owner');
    const created = await request(owner.token, 'POST', '/api/v1/me/tokens', { label: 'Disposable' });
    expect(created.status).toBe(201);

    const { rows } = await pool.query(
      `INSERT INTO auth_users (identity_issuer, subject, email, email_verified, display_name, name)
       VALUES ($1, $2, $3, true, $4, $4) RETURNING id`,
      [issuer, `auth0|same-org-${sequence}`, `same-org-${sequence}@example.test`, 'Same org'],
    );
    await pool.query(
      'INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, $3)',
      [owner.orgId, rows[0].id, 'admin'],
    );
    const other = await jwt(`auth0|same-org-${sequence}`, `same-org-${sequence}@example.test`);

    const foreign = await request(other, 'DELETE', `/api/v1/me/tokens/${created.body.id}`);
    expect(foreign.status).toBe(404);
    const foreignList = await request(other, 'GET', '/api/v1/me/tokens');
    expect(foreignList.status).toBe(200);
    expect(foreignList.body.tokens).toEqual([]);

    const revoked = await request(owner.token, 'DELETE', `/api/v1/me/tokens/${created.body.id}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: true });
    const after = await request(created.body.token, 'GET', '/api/v1/projects');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('unauthorized');
    const listedAfterRevoke = await request(owner.token, 'GET', '/api/v1/me/tokens');
    const revokedToken = listedAfterRevoke.body.tokens.find((token: any) => token.id === created.body.id);
    expect(revokedToken).toMatchObject({
      token: expect.stringMatching(/^pt_.*\.\.\.[a-f0-9]{4}$/),
      revoked_at: expect.any(String),
    });
    expect(JSON.stringify(listedAfterRevoke.body)).not.toContain(created.body.token);
  });

  it('rechecks membership for hosted user-bound tokens while preserving legacy ownerless pt_ compatibility', async () => {
    const member = await hostedUser('membership');
    const ownedToken = await request(member.token, 'POST', '/api/v1/me/tokens', { label: 'Member token' });
    expect(ownedToken.status).toBe(201);
    const managedSlug = `managed-${Date.now()}-${sequence++}`;
    expect((await request(member.token, 'POST', '/api/v1/projects', {
      slug: managedSlug, name: 'Managed before demotion',
    })).status).toBe(201);
    const profile = await request(member.token, 'GET', '/api/v1/me');

    await pool.query(
      "UPDATE organization_members SET role = 'member' WHERE org_id = $1 AND user_id = $2",
      [profile.body.organization.id, profile.body.user.id],
    );
    const deniedProject = await request(ownedToken.body.token, 'POST', '/api/v1/projects', {
      slug: `demoted-${Date.now()}-${sequence++}`, name: 'Denied after demotion',
    });
    expect(deniedProject.status).toBe(403);
    expect(deniedProject.body.error.code).toBe('insufficient_role');
    const deniedProjectMutation = await request(ownedToken.body.token, 'POST', `/api/v1/projects/${managedSlug}/keys`, {
      kind: 'ingest',
    });
    expect(deniedProjectMutation.status).toBe(403);
    expect(deniedProjectMutation.body.error.code).toBe('insufficient_role');
    const deniedIssuance = await request(member.token, 'POST', '/api/v1/me/tokens', { label: 'Denied issue' });
    expect(deniedIssuance.status).toBe(403);
    expect(deniedIssuance.body.error.code).toBe('insufficient_role');
    const ownList = await request(member.token, 'GET', '/api/v1/me/tokens');
    expect(ownList.status).toBe(200);
    expect(ownList.body.tokens.map((token: any) => token.id)).toContain(ownedToken.body.id);
    expect((await request(member.token, 'DELETE', `/api/v1/me/tokens/${ownedToken.body.id}`)).status).toBe(200);

    const removed = await hostedUser('membership-removed');
    const removedToken = await request(removed.token, 'POST', '/api/v1/me/tokens', { label: 'Removed membership' });
    const removedProfile = await request(removed.token, 'GET', '/api/v1/me');
    await pool.query(
      'DELETE FROM organization_members WHERE org_id = $1 AND user_id = $2',
      [removedProfile.body.organization.id, removedProfile.body.user.id],
    );
    const afterRemoval = await request(removedToken.body.token, 'GET', '/api/v1/projects');
    expect(afterRemoval.status).toBe(401);
    expect(afterRemoval.body.error.code).toBe('unauthorized');

    const legacy = await createApiKey(pool, { orgId: member.orgId, projectId: null, kind: 'personal' });
    expect((await request(legacy.token, 'GET', '/api/v1/projects')).status).toBe(200);
  });

  it('serializes concurrent onboarding and same-slug project creation without duplicate projects or tokens', async () => {
    const user = await hostedUser('concurrent-onboarding');
    const onboarding = {
      workspace_name: 'Concurrent workspace',
      project_slug: `onboard-${Date.now()}-${sequence++}`,
      project_name: 'Concurrent project',
    };
    const results = await Promise.all([
      request(user.token, 'POST', '/api/v1/onboarding', onboarding),
      request(user.token, 'POST', '/api/v1/onboarding', {
        ...onboarding,
        project_slug: `${onboarding.project_slug}-second`,
      }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);

    const personal = results.find((result) => result.status === 201)!.body.tokens.personal as string;
    const org = await request(user.token, 'GET', '/api/v1/me');
    const projects = await pool.query('SELECT count(*)::int AS count FROM projects WHERE org_id = $1', [org.body.organization.id]);
    const tokens = await pool.query(
      "SELECT count(*)::int AS count, (array_agg(issued_by_user_id::text))[1] AS issued_by_user_id FROM api_keys WHERE org_id = $1 AND kind = 'personal' AND label = 'hosted onboarding MCP'",
      [org.body.organization.id],
    );
    expect(projects.rows[0].count).toBe(1);
    expect(tokens.rows[0].count).toBe(1);
    expect(tokens.rows[0].issued_by_user_id).toBe(org.body.user.id);

    const slug = `parallel-${Date.now()}-${sequence++}`;
    const projectResults = await Promise.all([
      request(personal, 'POST', '/api/v1/projects', { slug, name: 'Parallel' }),
      request(personal, 'POST', '/api/v1/projects', { slug, name: 'Parallel' }),
    ]);
    expect(projectResults.map((result) => result.status).sort()).toEqual([201, 409]);
    const duplicates = await pool.query(
      'SELECT count(*)::int AS count FROM projects WHERE org_id = $1 AND slug = $2', [org.body.organization.id, slug],
    );
    expect(duplicates.rows[0].count).toBe(1);
  });
});
