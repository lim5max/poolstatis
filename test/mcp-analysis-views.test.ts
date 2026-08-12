import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';
import { analysisViewInput } from './analysis-view-fixtures.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env: TestEnv;
let secretClient: Client;
let personalClient: Client;

async function connect(token: string, name: string): Promise<Client> {
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const client = new Client({ name, version: '0.1.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', repoDir, 'mcp'],
    env: {
      ...process.env,
      POOLSTATIS_URL: `http://127.0.0.1:${address.port}`,
      POOLSTATIS_TOKEN: token,
    },
    stderr: 'pipe',
  }));
  return client;
}

beforeAll(async () => {
  env = await createTestEnv();
  await activeMetric(env, {
    key: 'activation_completed',
    source: { event: 'activation.completed', filters: [] },
    purpose: 'Measures the first meaningful activation completion outcome.',
  });
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  secretClient = await connect(env.secretToken, 'saved-answers-secret');
  personalClient = await connect(env.personalToken, 'saved-answers-personal');
});

afterAll(async () => {
  await secretClient?.close();
  await personalClient?.close();
  await env.close();
});

describe('saved answers and readiness MCP parity', () => {
  it('exposes structured CRUD/archive/official/readiness tools over the REST authorization boundary', async () => {
    const tools = await secretClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'create_saved_answer',
      'list_saved_answers',
      'get_saved_answer',
      'update_saved_answer',
      'archive_saved_answer',
      'set_saved_answer_official',
      'get_measurement_readiness',
    ]));

    const created = await secretClient.callTool({
      name: 'create_saved_answer',
      arguments: { project: env.projectSlug, view: analysisViewInput(env.projectSlug) },
    });
    expect(created.isError).not.toBe(true);
    const id = (created.structuredContent as { view: { id: string } }).view.id;
    expect(created.structuredContent).toMatchObject({
      view: { id, env: 'prod', status: 'active', official: false },
    });

    const listed = await secretClient.callTool({
      name: 'list_saved_answers',
      arguments: { project: env.projectSlug, env: 'prod', status: 'active' },
    });
    expect(listed.isError).not.toBe(true);
    expect((listed.structuredContent as { views: Array<{ id: string }> }).views.map((view) => view.id)).toContain(id);

    const detail = await secretClient.callTool({
      name: 'get_saved_answer',
      arguments: { project: env.projectSlug, id },
    });
    expect(detail.isError).not.toBe(true);
    const restDetail = await api(
      env,
      env.secretToken,
      'GET',
      `/api/v1/projects/${env.projectSlug}/analysis-views/${id}`,
    );
    expect(detail.structuredContent).toEqual(restDetail.body);

    const updated = await secretClient.callTool({
      name: 'update_saved_answer',
      arguments: { project: env.projectSlug, id, patch: { title: 'MCP weekly answer' } },
    });
    expect(updated.structuredContent).toMatchObject({ view: { id, title: 'MCP weekly answer' } });

    const denied = await secretClient.callTool({
      name: 'set_saved_answer_official',
      arguments: { project: env.projectSlug, id, official: true },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('official_answer_role_required');

    const official = await personalClient.callTool({
      name: 'set_saved_answer_official',
      arguments: { project: env.projectSlug, id, official: true },
    });
    expect(official.structuredContent).toMatchObject({ view: { id, official: true } });

    const readiness = await secretClient.callTool({
      name: 'get_measurement_readiness',
      arguments: { project: env.projectSlug, env: 'prod' },
    });
    expect(readiness.isError).not.toBe(true);
    expect(readiness.structuredContent).toMatchObject({
      schema_version: 1,
      project: env.projectSlug,
      env: 'prod',
      answer_dependencies: expect.arrayContaining([
        expect.objectContaining({ answer_id: 'home', surface: 'home', href: '/' }),
        expect.objectContaining({ answer_id: 'product:activation_completed', surface: 'product' }),
        expect.objectContaining({ answer_id: id, surface: 'saved' }),
      ]),
      groups: [
        { key: 'tracking_plan' },
        { key: 'properties' },
        { key: 'identity' },
        { key: 'data_sources' },
      ],
    });

    const archived = await secretClient.callTool({
      name: 'archive_saved_answer',
      arguments: { project: env.projectSlug, id },
    });
    expect(archived.structuredContent).toMatchObject({
      view: { id, status: 'archived', official: false },
    });
  });

  it('keeps a project secret pinned when new saved-answer tools receive another project slug', async () => {
    const secondSlug = `mcp-second-${Date.now()}`;
    expect((await api(env, env.personalToken, 'POST', '/api/v1/projects', {
      slug: secondSlug, name: 'MCP second project',
    })).status).toBe(201);
    const denied = await secretClient.callTool({
      name: 'list_saved_answers',
      arguments: { project: secondSlug, env: 'prod' },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('project_scope');
  });
});
