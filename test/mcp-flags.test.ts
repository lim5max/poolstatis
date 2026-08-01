import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { activeMetric, createTestEnv, type TestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env: TestEnv;
let client: Client;

beforeAll(async () => {
  env = await createTestEnv();
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = env.app.server.address();
  if (!baseUrl || typeof baseUrl === 'string') throw new Error('test server did not bind a TCP port');
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', repoDir, 'mcp'],
    env: { ...process.env, POOLSTATIS_URL: `http://127.0.0.1:${baseUrl.port}`, POOLSTATIS_TOKEN: env.secretToken },
    stderr: 'pipe',
  });
  client = new Client({ name: 'poolstatis-mcp-flags-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await env.close();
});

describe('feature delivery MCP tools', () => {
  it('registers flag and experiment operations for an agent', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'create_feature_flag',
      'list_feature_flags',
      'update_feature_flag',
      'archive_feature_flag',
      'evaluate_feature_flag',
      'create_experiment',
      'prepare_experiment',
      'list_experiments',
      'start_experiment',
      'check_experiment_readiness',
      'launch_experiment',
      'conclude_experiment',
      'apply_experiment_decision',
      'get_experiment_results',
    ]));

    const created = await client.callTool({
      name: 'create_feature_flag',
      arguments: {
        project: env.projectSlug,
        flag: {
          key: 'mcp_checkout_copy',
          name: 'MCP checkout copy',
          purpose: 'Safely let an agent roll out checkout copy to users.',
          variants: [{ key: 'control', rollout_percentage: 100 }],
          status: 'active',
        },
      },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ key: 'mcp_checkout_copy', status: 'active' });

    await activeMetric(env, { key: 'mcp_prepared_outcome', source: { event: 'mcp.prepared.outcome' } });
    const prepared = await client.callTool({
      name: 'prepare_experiment',
      arguments: {
        project: env.projectSlug,
        setup: {
          env: 'prod',
          control_variant_key: 'control',
          flag: {
            key: 'mcp_prepared_flag',
            name: 'MCP prepared flag',
            purpose: 'Safely prepare an atomic MCP experiment launch.',
            variants: [
              { key: 'control', rollout_percentage: 50 },
              { key: 'test', rollout_percentage: 50 },
            ],
          },
          experiment: {
            key: 'mcp_prepared_experiment',
            name: 'MCP prepared experiment',
            hypothesis: 'The MCP prepared treatment will improve the declared outcome.',
            primary_metric_key: 'mcp_prepared_outcome',
          },
        },
      },
    });
    expect(prepared.isError).not.toBe(true);
    expect(prepared.structuredContent).toMatchObject({
      flag: { status: 'draft', env: 'prod' },
      experiment: { status: 'draft', snapshot_integrity: 'legacy_unfrozen' },
      readiness: { ready: true },
    });

    const readiness = await client.callTool({
      name: 'check_experiment_readiness',
      arguments: { project: env.projectSlug, key: 'mcp_prepared_experiment', env: 'prod' },
    });
    expect(readiness.isError).not.toBe(true);
    expect(readiness.structuredContent).toMatchObject({ ready: true, env: 'prod' });

    const launched = await client.callTool({
      name: 'launch_experiment',
      arguments: { project: env.projectSlug, key: 'mcp_prepared_experiment' },
    });
    expect(launched.isError).not.toBe(true);
    expect(launched.structuredContent).toMatchObject({
      flag: { status: 'active' },
      experiment: { status: 'running', snapshot_integrity: 'frozen_at_start' },
    });

    const applied = await client.callTool({
      name: 'apply_experiment_decision',
      arguments: {
        project: env.projectSlug,
        key: 'mcp_prepared_experiment',
        decision: { outcome: 'ship', rationale: 'Ship the explicit treatment after a reviewed MCP decision.' },
        ship_variant_key: 'test',
      },
    });
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      experiment: { status: 'concluded' },
      flag: { status: 'active' },
    });
  });
});
