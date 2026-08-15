import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { activeMetric, api, createTestEnv, hoursAgo, type TestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env: TestEnv;
let client: Client;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  await activeMetric(env, {
    key: 'mcp_journey_started', type: 'unique_actors',
    source: { event: 'mcp.journey_started', filters: [] },
  });
  await activeMetric(env, {
    key: 'mcp_journey_completed', type: 'unique_actors',
    source: { event: 'mcp.journey_completed', filters: [] },
  });
  expect((await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/funnels`, {
    key: 'mcp_journey', name: 'MCP journey',
    goal: 'Measure whether the agent-observed product journey completes.',
    steps: [
      { metric_key: 'mcp_journey_started', label: 'Started' },
      { metric_key: 'mcp_journey_completed', label: 'Completed' },
    ],
    window_seconds: 86_400,
  })).status).toBe(201);
  expect((await api(env, env.ingestToken, 'POST', '/i/v1/events', {
    batch_id: 'mcp-funnel-investigation',
    events: [
      { event: 'mcp.journey_started', distinct_id: 'actor', timestamp: hoursAgo(2) },
      { event: 'mcp.journey_completed', distinct_id: 'actor', timestamp: hoursAgo(1) },
    ],
  })).status).toBe(200);
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  client = new Client({ name: 'funnel-investigation-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: 'pnpm', args: ['--silent', '--dir', repoDir, 'mcp'], stderr: 'pipe',
    env: {
      ...process.env,
      POOLSTATIS_URL: `http://127.0.0.1:${address.port}`,
      POOLSTATIS_TOKEN: env.secretToken,
    },
  }));
}, 60_000);

afterAll(async () => {
  await client?.close();
  await env?.close();
});

describe('funnel investigation MCP parity', () => {
  it('creates, lists and reads the same immutable REST artifact', async () => {
    expect(client.getServerVersion()).toEqual({ name: 'poolstatis', version: '0.7.0-source' });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'create_funnel_investigation', 'list_funnel_investigations', 'get_funnel_investigation',
    ]));
    const created = await client.callTool({
      name: 'create_funnel_investigation',
      arguments: {
        project: env.projectSlug,
        investigation: {
          idempotency_key: 'mcp-funnel-investigation-1',
          funnel: 'mcp_journey', env: 'prod',
          date_from: hoursAgo(24), date_to: new Date().toISOString(),
          from_step: 0, to_step: 1,
        },
      },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      idempotent: false,
      investigation: {
        saved_funnel: { key: 'mcp_journey' },
        transition: { from_metric: 'mcp_journey_started', to_metric: 'mcp_journey_completed' },
        created_by: expect.stringMatching(/^key:/),
      },
    });
    const id = String((created.structuredContent as { investigation: { id: string } }).investigation.id);
    const listed = await client.callTool({
      name: 'list_funnel_investigations',
      arguments: { project: env.projectSlug, env: 'prod', funnel: 'mcp_journey', limit: 10 },
    });
    expect(listed.structuredContent).toMatchObject({ investigations: [{ id }] });
    const read = await client.callTool({
      name: 'get_funnel_investigation', arguments: { project: env.projectSlug, id },
    });
    expect(read.structuredContent).toMatchObject({ investigation: { id, lineage: {
      query_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      result_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifact_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    } } });
  });
});
