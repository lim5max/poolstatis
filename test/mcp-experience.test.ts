import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { api, createTestEnv, type TestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env: TestEnv;
let client: Client;

beforeAll(async () => {
  env = await createTestEnv();
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', repoDir, 'mcp'],
    env: { ...process.env, POOLSTATIS_URL: `http://127.0.0.1:${address.port}`, POOLSTATIS_TOKEN: env.secretToken },
    stderr: 'pipe',
  });
  client = new Client({ name: 'poolstatis-mcp-experience-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await env.close();
});

describe('browser experience MCP tools', () => {
  it('lets an agent declare a surface and read a product-captured map and session', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'create_experience_surface', 'list_experience_surfaces', 'archive_experience_surface',
      'query_interaction_map', 'get_experience_session',
    ]));

    const created = await client.callTool({
      name: 'create_experience_surface',
      arguments: {
        project: env.projectSlug,
        surface: { key: 'checkout', name: 'Checkout', purpose: 'Understand why buyers hesitate before payment.' },
      },
    });
    expect(created.isError).not.toBe(true);

    const captured = await api(env, env.ingestToken, 'POST', '/i/v1/experience/events', {
      surface: 'checkout',
      batch_id: 'mcp-experience-capture-1',
      events: [
        { kind: 'page_viewed', distinct_id: 'actor-1', session_id: 'session-1', route: 'checkout', sequence: 1 },
        { kind: 'element_clicked', distinct_id: 'actor-1', session_id: 'session-1', route: 'checkout', sequence: 2, label: 'pay_now', x: 0.5, y: 0.25 },
      ],
    });
    expect(captured.status).toBe(200);
    const beforeReads = await env.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::bigint AS quantity FROM usage_ledger WHERE project_id = $1`, [env.projectId],
    );

    const map = await client.callTool({
      name: 'query_interaction_map',
      arguments: { project: env.projectSlug, query: { surface: 'checkout', date_from: '-1d', env: 'prod', grid: 4 } },
    });
    expect(map.isError).not.toBe(true);
    expect(map.structuredContent).toMatchObject({ kind: 'interaction_map', cells: [{ x: 2, y: 1, count: 1 }] });

    const session = await client.callTool({
      name: 'get_experience_session',
      arguments: { project: env.projectSlug, query: { surface: 'checkout', session_id: 'session-1', date_from: '-1d', env: 'prod' } },
    });
    expect(session.isError).not.toBe(true);
    expect(session.structuredContent).toMatchObject({
      kind: 'experience_session', summary: { page_views: 1, clicks: 1 },
    });
    const afterReads = await env.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::bigint AS quantity FROM usage_ledger WHERE project_id = $1`, [env.projectId],
    );
    expect(afterReads.rows[0]?.quantity).toBe(beforeReads.rows[0]?.quantity);
  });
});
