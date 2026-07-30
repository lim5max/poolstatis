import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env: TestEnv;
let client: Client;

beforeAll(async () => {
  env = await createTestEnv();
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  client = new Client(
    { name: 'poolstatis-metric-categories-test', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', repoDir, 'mcp'],
    env: {
      ...process.env,
      POOLSTATIS_URL: `http://127.0.0.1:${address.port}`,
      POOLSTATIS_TOKEN: env.secretToken,
    },
    stderr: 'pipe',
  }));
});

afterAll(async () => {
  await client.close();
  await env.close();
});

describe('metric category MCP parity', () => {
  it('exposes project category CRUD with purpose-axis guidance', async () => {
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()]).toEqual(expect.arrayContaining([
      'list_metric_categories',
      'create_metric_category',
      'update_metric_category',
      'delete_metric_category',
    ]));
    expect(byName.get('list_metric_categories')?.description).toContain('why');
    expect(byName.get('list_metric_categories')?.description).toContain('namespaced tags');
    expect(byName.get('list_metric_categories')?.description).toContain('funnels');

    const initial = await client.callTool({
      name: 'list_metric_categories',
      arguments: { project: env.projectSlug },
    });
    expect(initial.isError).not.toBe(true);
    expect((initial.structuredContent as { categories: Array<{ key: string }> }).categories)
      .toContainEqual(expect.objectContaining({ key: 'engagement' }));

    const created = await client.callTool({
      name: 'create_metric_category',
      arguments: {
        project: env.projectSlug,
        category: {
          key: 'governance',
          name: 'Governance',
          description: 'Measures policy outcomes outside the stable system library.',
          domain: 'custom',
          color: '#6D5BD0',
        },
      },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      key: 'governance',
      domain: 'custom',
      is_system: false,
    });

    const updated = await client.callTool({
      name: 'update_metric_category',
      arguments: {
        project: env.projectSlug,
        key: 'governance',
        patch: {
          name: 'Product governance',
          description: 'Measures product policy outcomes outside the stable system library.',
          color: '#2457C5',
        },
      },
    });
    expect(updated.isError).not.toBe(true);
    expect(updated.structuredContent).toMatchObject({
      key: 'governance',
      name: 'Product governance',
      color: '#2457C5',
    });

    const deleted = await client.callTool({
      name: 'delete_metric_category',
      arguments: { project: env.projectSlug, key: 'governance' },
    });
    expect(deleted.isError).not.toBe(true);
    expect(deleted.structuredContent).toEqual({ deleted: true, key: 'governance' });
  });

  it('returns category definitions through both schema tool and schema resource', async () => {
    const schemaTool = await client.callTool({
      name: 'get_project_schema',
      arguments: { project: env.projectSlug, env: 'prod' },
    });
    expect(schemaTool.isError).not.toBe(true);
    expect((schemaTool.structuredContent as {
      metric_categories: Array<{ key: string; description: string }>;
    }).metric_categories).toContainEqual(expect.objectContaining({
      key: 'reliability',
      description: expect.stringContaining('availability'),
    }));

    const resource = await client.readResource({
      uri: `poolstatis://${env.projectSlug}/schema`,
    });
    const text = resource.contents[0]?.text;
    expect(typeof text).toBe('string');
    const schema = JSON.parse(text as string) as {
      metric_categories: Array<{ key: string; domain: string; is_system: boolean }>;
    };
    expect(schema.metric_categories).toContainEqual(expect.objectContaining({
      key: 'cost',
      domain: 'business',
      is_system: true,
    }));
  });

  it('teaches agents the three independent taxonomy axes', async () => {
    const resource = await client.readResource({
      uri: 'poolstatis://standard/instrumentation',
    });
    const text = resource.contents[0]?.text;
    expect(text).toContain('Category answers **why**');
    expect(text).toContain('namespaced tags');
    expect(text).toContain('Funnels answer **which journey**');
    expect(text).toContain('data_quality');
    expect(text).not.toContain('one AARRR category');
  });
});
