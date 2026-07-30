import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env: TestEnv;
let client: Client;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  await activeMetric(env, {
    key: 'actor_activity',
    source: { event: 'activity.performed', filters: [] },
  });
  await api(env, env.ingestToken, 'POST', '/i/v1/events', {
    events: [
      {
        event: 'activity.performed',
        distinct_id: 'mcp-anon',
        timestamp: '2026-07-29T10:00:00.000Z',
      },
      {
        event: 'activity.performed',
        distinct_id: 'mcp-stable',
        timestamp: '2026-07-29T11:00:00.000Z',
      },
    ],
  });
  await api(
    env,
    env.secretToken,
    'POST',
    `/api/v1/projects/${env.projectSlug}/identity-links`,
    {
      source_distinct_id: 'mcp-anon',
      target_distinct_id: 'mcp-stable',
      env: 'prod',
    },
  );

  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  client = new Client(
    { name: 'actors-contract-test', version: '0.1.0' },
    { capabilities: {} },
  );
  await client.connect(new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', repoDir, 'mcp'],
    env: {
      ...process.env,
      COREPACK_ENABLE_PROJECT_SPEC: '0',
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

describe('Actors REST/MCP parity', () => {
  it('exposes list_actors, canonical get_person and the actors standard resource', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_actors',
      'get_person',
    ]));
    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri))
      .toContain('poolstatis://standard/actors');
    const standard = await client.readResource({ uri: 'poolstatis://standard/actors' });
    expect(standard.contents[0]).toMatchObject({
      mimeType: 'text/markdown',
      text: expect.stringContaining('expands to the canonical actor'),
    });

    const query = {
      env: 'prod',
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      activityMetric: 'actor_activity',
      search: { kind: 'exact_id', value: 'mcp-anon' },
    };
    const rest = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      { kind: 'actors', ...query },
    );
    const mcp = await client.callTool({
      name: 'list_actors',
      arguments: { project: env.projectSlug, query },
    });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.structuredContent).toMatchObject({
      actors: rest.body.actors,
      meta: {
        activity_metric: rest.body.meta.activity_metric,
        capabilities: rest.body.meta.capabilities,
      },
    });

    const restPerson = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/persons/mcp-anon`
        + '?env=prod&from=2026-07-01T00%3A00%3A00.000Z&to=2026-08-01T00%3A00%3A00.000Z',
    );
    const mcpPerson = await client.callTool({
      name: 'get_person',
      arguments: {
        project: env.projectSlug,
        distinct_id: 'mcp-anon',
        env: 'prod',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-08-01T00:00:00.000Z',
      },
    });
    expect(mcpPerson.isError).not.toBe(true);
    expect(mcpPerson.structuredContent).toMatchObject({
      distinct_id: restPerson.body.distinct_id,
      identity: restPerson.body.identity,
      summary: restPerson.body.summary,
      activity: restPerson.body.activity,
    });
  });
});
