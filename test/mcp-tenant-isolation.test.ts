import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createPool } from '../src/db.js';
import { buildServer } from '../src/http/server.js';
import { TEST_DB_URL } from './urls.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const issuer = 'https://mcp-tenant-auth.poolstatis.test/';
const audience = 'https://mcp-tenant-api.poolstatis.test/';

let pool: pg.Pool;
let app: FastifyInstance;
let privateKey: CryptoKey | Uint8Array;
let jwks: { keys: JWK[] };
let secretClient: Client;
let personalClient: Client;

async function jwt(sub: string, email: string): Promise<string> {
  return new SignJWT({ email, email_verified: true, name: sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'mcp-tenant-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function request(token: string, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json() };
}

async function connectMcp(token: string, name: string): Promise<Client> {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', repoDir, 'mcp'],
    env: { ...process.env, POOLSTATIS_URL: `http://127.0.0.1:${address.port}`, POOLSTATIS_TOKEN: token },
    stderr: 'pipe',
  });
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: 'mcp-tenant-key', alg: 'RS256', use: 'sig' }] };
  pool = createPool(TEST_DB_URL);
  app = buildServer(pool, { auth: { issuer, audience, jwks: async () => jwks } });

  const alphaJwt = await jwt(`auth0|mcp-alpha-${Date.now()}`, `mcp-alpha-${Date.now()}@example.test`);
  const betaJwt = await jwt(`auth0|mcp-beta-${Date.now()}`, `mcp-beta-${Date.now()}@example.test`);
  expect((await request(alphaJwt, 'GET', '/api/v1/me')).status).toBe(200);
  expect((await request(betaJwt, 'GET', '/api/v1/me')).status).toBe(200);

  const projectA = `mcp-a-${Date.now()}`;
  const projectB = `mcp-b-${Date.now()}`;
  const betaProject = `mcp-beta-${Date.now()}`;
  expect((await request(alphaJwt, 'POST', '/api/v1/projects', { slug: projectA, name: 'MCP A' })).status).toBe(201);
  expect((await request(alphaJwt, 'POST', '/api/v1/projects', { slug: projectB, name: 'MCP B' })).status).toBe(201);
  expect((await request(betaJwt, 'POST', '/api/v1/projects', { slug: betaProject, name: 'MCP Beta' })).status).toBe(201);

  const secret = await request(alphaJwt, 'POST', `/api/v1/projects/${projectA}/keys`, { kind: 'secret' });
  const personal = await request(alphaJwt, 'POST', '/api/v1/me/tokens', { label: 'MCP tenant test' });
  expect(secret.status).toBe(201);
  expect(personal.status).toBe(201);

  await app.listen({ host: '127.0.0.1', port: 0 });
  secretClient = await connectMcp(secret.body.token, 'mcp-tenant-secret-test');
  personalClient = await connectMcp(personal.body.token, 'mcp-tenant-personal-test');

  (globalThis as { mcpTenantProjects?: { a: string; b: string; beta: string } }).mcpTenantProjects = {
    a: projectA, b: projectB, beta: betaProject,
  };
});

afterAll(async () => {
  await secretClient.close();
  await personalClient.close();
  await app.close();
  await pool.end();
});

describe('MCP tenant isolation over stdio transport', () => {
  it('keeps a secret key on its exact project and an owner-bound personal token inside its organization', async () => {
    const projects = (globalThis as { mcpTenantProjects: { a: string; b: string; beta: string } }).mcpTenantProjects;
    const denied = await secretClient.callTool({ name: 'list_metrics', arguments: { project: projects.b } });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('project_scope');

    const personalProjects = await personalClient.callTool({ name: 'list_projects', arguments: {} });
    expect(personalProjects.isError).not.toBe(true);
    expect((personalProjects.structuredContent as { projects: Array<{ slug: string }> }).projects.map((project) => project.slug))
      .toEqual(expect.arrayContaining([projects.a, projects.b]));
    expect((personalProjects.structuredContent as { projects: Array<{ slug: string }> }).projects.map((project) => project.slug))
      .not.toContain(projects.beta);
  });
});
