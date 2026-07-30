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
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', repoDir, 'mcp'],
    env: {
      ...process.env,
      COREPACK_ENABLE_PROJECT_SPEC: '0',
      POOLSTATIS_URL: `http://127.0.0.1:${address.port}`,
      POOLSTATIS_TOKEN: env.secretToken,
    },
    stderr: 'pipe',
  });
  client = new Client({ name: 'web-analytics-contract-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await env.close();
});

describe('Web analytics MCP parity', () => {
  it('exposes setup, overview, session and page tools plus the standard resource', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'propose_browser_analytics',
      'get_web_overview',
      'list_web_sessions',
      'get_web_session',
      'get_session_engagement',
      'get_page_engagement',
    ]));
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri))
      .toContain('poolstatis://standard/browser-analytics');

    const setup = await client.callTool({
      name: 'propose_browser_analytics',
      arguments: { project: env.projectSlug },
    });
    expect(setup.isError).not.toBe(true);
    expect(setup.structuredContent).toMatchObject({
      properties: expect.any(Array),
      metrics: expect.any(Array),
    });
    await api(
      env,
      env.secretToken,
      'PATCH',
      `/api/v1/projects/${env.projectSlug}/properties/event/$route_key`,
      { status: 'trusted' },
    );
    await api(
      env,
      env.secretToken,
      'PATCH',
      `/api/v1/projects/${env.projectSlug}/metrics/web_page_views`,
      { status: 'active' },
    );

    const overview = await client.callTool({
      name: 'get_web_overview',
      arguments: {
        project: env.projectSlug,
        query: {
          metric: 'web_page_views',
          date_from: '-1d',
          dimensions: ['route'],
        },
      },
    });
    expect(overview.isError).not.toBe(true);
    expect(overview.structuredContent).toMatchObject({
      kind: 'web_analytics',
      summary: {
        visitors: 0,
        sessions: 0,
        page_views: 0,
        average_session_duration_ms: null,
      },
      engagement: {
        measured_session_coverage: null,
        engaged_rate: null,
        bounce_rate: null,
      },
    });
  });
});
