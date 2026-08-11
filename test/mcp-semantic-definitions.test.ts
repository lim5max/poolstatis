import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';
import { createProject } from '../src/services/projects.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env: TestEnv;
let client: Client;
let secondSlug: string;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  await activeMetric(env, {
    key: 'semantic_activation',
    purpose: 'Measures the shared activation moment for semantic MCP comparison.',
    source: { event: 'semantic.activation', filters: [] },
  });
  const org = await env.pool.query<{ org_id: string }>('SELECT org_id FROM projects WHERE id = $1', [env.projectId]);
  const second = await createProject(env.pool, org.rows[0]!.org_id, `mcp-compare-${Date.now()}`, 'MCP compare');
  secondSlug = second.slug;
  const registered = await api(env, env.personalToken, 'POST', `/api/v1/projects/${secondSlug}/metrics`, {
    key: 'semantic_activation',
    name: 'Semantic activation',
    purpose: 'Measures the shared activation moment for semantic MCP comparison.',
    type: 'count',
    source: { event: 'semantic.activation', filters: [] },
  });
  expect(registered.status).toBe(201);
  expect((await api(
    env,
    env.personalToken,
    'PATCH',
    `/api/v1/projects/${secondSlug}/metrics/semantic_activation`,
    { status: 'active' },
  )).status).toBe(200);

  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  client = new Client({ name: 'semantic-definition-mcp-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', repoDir, 'mcp'],
    env: {
      ...process.env,
      POOLSTATIS_URL: `http://127.0.0.1:${address.port}`,
      POOLSTATIS_TOKEN: env.personalToken,
    },
    stderr: 'pipe',
  }));
});

afterAll(async () => {
  await client.close();
  await env.close();
});

describe('semantic definition MCP parity', () => {
  it('exposes read/preview/comparison/account tools but keeps semantic apply human-controlled', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_metric_definition',
      'preview_metric_definition',
      'compare_projects',
      'get_account_mode',
    ]));
    expect(names).not.toContain('apply_metric_definition');

    const directSemanticMutation = await client.callTool({
      name: 'update_metric',
      arguments: {
        project: env.projectSlug,
        key: 'semantic_activation',
        patch: { purpose: 'This semantic mutation must not bypass human confirmation.' },
      },
    });
    expect(directSemanticMutation.isError).toBe(true);

    const restDefinition = await api(
      env,
      env.personalToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/metrics/semantic_activation/definition`,
    );
    const mcpDefinition = await client.callTool({
      name: 'get_metric_definition',
      arguments: { project: env.projectSlug, key: 'semantic_activation' },
    });
    expect(mcpDefinition.isError).not.toBe(true);
    expect(mcpDefinition.structuredContent).toMatchObject({
      current: restDefinition.body.current,
      revisions: restDefinition.body.revisions,
    });

    const preview = await client.callTool({
      name: 'preview_metric_definition',
      arguments: {
        project: env.projectSlug,
        key: 'semantic_activation',
        expected_revision: restDefinition.body.current.revision,
        definition: {
          purpose: 'Measures the reviewed shared activation moment after product setup.',
          source: { event: 'semantic.activation', filters: [] },
        },
      },
    });
    expect(preview.isError).not.toBe(true);
    expect(preview.structuredContent).toMatchObject({
      state: 'ready',
      requires_confirmation: true,
      primary_action: { kind: 'open_confirmation' },
    });

    const window = {
      from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    };
    const restComparison = await api(env, env.personalToken, 'POST', '/api/v1/projects/compare', {
      metric_key: 'semantic_activation',
      projects: [env.projectSlug, secondSlug],
      environment: 'prod',
      window,
    });
    const mcpComparison = await client.callTool({
      name: 'compare_projects',
      arguments: {
        metric_key: 'semantic_activation',
        projects: [env.projectSlug, secondSlug],
        environment: 'prod',
        window,
      },
    });
    expect(mcpComparison.isError).not.toBe(true);
    expect(mcpComparison.structuredContent).toMatchObject({
      state: restComparison.body.state,
      metric: restComparison.body.metric,
      projects: restComparison.body.projects,
    });

    const mode = await client.callTool({ name: 'get_account_mode', arguments: {} });
    expect(mode.isError).not.toBe(true);
    expect(mode.structuredContent).toMatchObject({
      deployment: { mode: 'self_host', hosted_account: 'not_configured' },
      capabilities: { portfolio: 'available', compare_projects: true },
    });
  });
});
