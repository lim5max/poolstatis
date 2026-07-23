import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
let packedDir: string;
let alphaJwtToken: string;
let personalTokenId: string;
let sharedSlug: string;

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

async function request(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.json() };
}

async function connectMcp(token: string, name: string, packed = false): Promise<Client> {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  const transport = new StdioClientTransport({
    command: packed ? 'node' : 'pnpm',
    args: packed ? [resolve(packedDir, 'package/dist/cli.js')] : ['--silent', '--dir', repoDir, 'mcp'],
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
  alphaJwtToken = alphaJwt;
  const betaJwt = await jwt(`auth0|mcp-beta-${Date.now()}`, `mcp-beta-${Date.now()}@example.test`);
  expect((await request(alphaJwt, 'GET', '/api/v1/me')).status).toBe(200);
  expect((await request(betaJwt, 'GET', '/api/v1/me')).status).toBe(200);

  const projectA = `mcp-a-${Date.now()}`;
  sharedSlug = projectA;
  const projectB = `mcp-b-${Date.now()}`;
  const betaProject = projectA;
  expect((await request(alphaJwt, 'POST', '/api/v1/projects', { slug: projectA, name: 'MCP A' })).status).toBe(201);
  expect((await request(alphaJwt, 'POST', '/api/v1/projects', { slug: projectB, name: 'MCP B' })).status).toBe(201);
  expect((await request(betaJwt, 'POST', '/api/v1/projects', { slug: betaProject, name: 'MCP Beta same slug' })).status).toBe(201);

  const secret = await request(alphaJwt, 'POST', `/api/v1/projects/${projectA}/keys`, { kind: 'secret' });
  const personal = await request(alphaJwt, 'POST', '/api/v1/me/tokens', { label: 'MCP tenant test' });
  expect(secret.status).toBe(201);
  expect(personal.status).toBe(201);
  personalTokenId = personal.body.id;

  for (const [token, slug] of [[alphaJwt, projectA], [betaJwt, betaProject]]) {
    for (const key of ['shared_started', 'shared_completed']) {
      expect((await request(token, 'POST', `/api/v1/projects/${slug}/metrics`, {
        key, name: key, type: 'unique_actors', purpose: `Measures ${key} for the isolated MCP process test.`,
        source: { event: key.replace('_', '.'), filters: [] },
      })).status).toBe(201);
      expect((await request(token, 'PATCH', `/api/v1/projects/${slug}/metrics/${key}`, { status: 'active' })).status).toBe(200);
    }
    expect((await request(token, 'POST', `/api/v1/projects/${slug}/funnels`, {
      key: 'shared_activation', name: 'Shared activation', goal: 'Measures isolated completion after the shared start event.',
      steps: [{ metric_key: 'shared_started', label: 'Started' }, { metric_key: 'shared_completed', label: 'Completed' }],
    })).status).toBe(201);
    const ingest = await request(token, 'POST', `/api/v1/projects/${slug}/keys`, { kind: 'ingest' });
    const alpha = token === alphaJwt;
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const completedAt = new Date(Date.now() - 60_000).toISOString();
    const events = alpha ? [
      { event: 'shared.started', distinct_id: 'same-actor', timestamp: startedAt, properties: { marker: 'alpha-only' } },
      { event: 'shared.completed', distinct_id: 'same-actor', timestamp: completedAt, properties: { marker: 'alpha-only' } },
      { event: 'shared.started', distinct_id: 'alpha-extra', timestamp: startedAt, properties: { marker: 'alpha-only' } },
    ] : [
      { event: 'shared.started', distinct_id: 'same-actor', timestamp: startedAt, properties: { marker: 'beta-only' } },
      { event: 'shared.completed', distinct_id: 'same-actor', timestamp: completedAt, properties: { marker: 'beta-only' } },
      { event: 'shared.started', distinct_id: 'beta-extra', timestamp: startedAt, properties: { marker: 'beta-only' } },
      { event: 'shared.completed', distinct_id: 'beta-extra', timestamp: completedAt, properties: { marker: 'beta-only' } },
    ];
    expect((await request(ingest.body.token, 'POST', '/i/v1/events', { batch_id: `shared-${alpha ? 'alpha' : 'beta'}`, events })).status).toBe(200);
  }

  await app.listen({ host: '127.0.0.1', port: 0 });
  packedDir = await mkdtemp(resolve(repoDir, '.poolstatis-mcp-packed-'));
  execFileSync('pnpm', ['--dir', resolve(repoDir, 'packages/mcp'), 'pack', '--pack-destination', packedDir]);
  execFileSync('tar', ['-xzf', resolve(packedDir, 'poolstatis-mcp-0.1.0.tgz'), '-C', packedDir]);
  secretClient = await connectMcp(secret.body.token, 'mcp-tenant-secret-test');
  personalClient = await connectMcp(personal.body.token, 'mcp-tenant-personal-test', true);

  (globalThis as { mcpTenantProjects?: { a: string; b: string; beta: string } }).mcpTenantProjects = {
    a: projectA, b: projectB, beta: betaProject,
  };
});

afterAll(async () => {
  await secretClient.close();
  await personalClient.close();
  await rm(packedDir, { recursive: true, force: true });
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
    expect((personalProjects.structuredContent as { projects: Array<{ name: string }> }).projects.map((project) => project.name))
      .not.toContain('MCP Beta same slug');

    const usageBefore = await pool.query("SELECT COALESCE(sum(quantity), 0)::int AS quantity, count(*)::int AS rows FROM usage_ledger WHERE meter_key = 'events_stored'");
    const schema = await personalClient.callTool({ name: 'get_project_schema', arguments: { project: sharedSlug, env: 'prod' } });
    expect(schema.isError).not.toBe(true);
    expect((schema.structuredContent as { metrics: Array<{ key: string }> }).metrics.map((metric) => metric.key))
      .toEqual(expect.arrayContaining(['shared_started', 'shared_completed']));
    const trend = await personalClient.callTool({ name: 'query_trend', arguments: { project: sharedSlug, query: { metric: 'shared_started', date_from: '-7d', env: 'prod' } } });
    const funnel = await personalClient.callTool({ name: 'query_funnel', arguments: { project: sharedSlug, query: { funnel: 'shared_activation', date_from: '-7d', env: 'prod' } } });
    expect(trend.isError).not.toBe(true);
    expect(funnel.isError).not.toBe(true);
    expect((trend.structuredContent as { series: Array<{ value: number }> }).series.reduce((sum, point) => sum + point.value, 0)).toBe(2);
    const steps = (funnel.structuredContent as { steps: Array<{ actors: number; conversion_from_start: number }> }).steps;
    expect(steps.map((step) => step.actors)).toEqual([2, 1]);
    expect(steps[1]?.conversion_from_start).toBe(0.5);
    expect(JSON.stringify({ schema, trend, funnel })).not.toContain('beta-only');
    expect(JSON.stringify({ schema, trend, funnel })).not.toContain('MCP Beta same slug');
    const usageAfter = await pool.query("SELECT COALESCE(sum(quantity), 0)::int AS quantity, count(*)::int AS rows FROM usage_ledger WHERE meter_key = 'events_stored'");
    expect(usageAfter.rows[0]).toEqual(usageBefore.rows[0]);
    expect((await pool.query("SELECT DISTINCT meter_key FROM usage_ledger WHERE meter_key <> 'events_stored'")).rows).toEqual([]);

    expect((await request(alphaJwtToken, 'DELETE', `/api/v1/me/tokens/${personalTokenId}`)).status).toBe(200);
    const revoked = await personalClient.callTool({ name: 'list_projects', arguments: {} });
    expect(revoked.isError).toBe(true);
    expect(JSON.stringify(revoked)).not.toContain('pt_');
    expect(JSON.stringify(revoked)).not.toContain('alpha-only');
    expect(JSON.stringify(revoked)).not.toContain(sharedSlug);
  });
});
