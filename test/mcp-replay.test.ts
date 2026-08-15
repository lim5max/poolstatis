import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { api, createTestEnv, type TestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let env: TestEnv;
let client: Client;

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

beforeAll(async () => {
  env = await createTestEnv();
  await api(env, env.secretToken, 'POST', `/api/v1/projects/${env.projectSlug}/experience/surfaces`, {
    key: 'workspace', name: 'Workspace', purpose: 'Reproduce consented workspace interaction failures.',
  });
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  client = new Client({ name: 'poolstatis-mcp-replay-test', version: '0.1.0' });
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

describe('session replay MCP metadata parity', () => {
  it('searches and gets bounded metadata without returning recording events', async () => {
    const policy = { version: 'privacy-v1', text: 'masked', maskSelectors: [], blockSelectors: [] } as const;
    const created = await api(env, env.ingestToken, 'POST', '/i/v1/replays', {
      surface: 'workspace', route: 'workspace', session_id: 'mcp-replay-session',
      distinct_id: 'actor-1', host: 'app.example.test', version: 'release-1', device: 'desktop',
      consent_version: 'consent-v1', policy, policy_hash: sha(policy), retention_days: 7,
    });
    const replayId = created.body.replay.id as string;

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_session_replays', 'get_session_replay',
    ]));
    const listed = await client.callTool({
      name: 'list_session_replays',
      arguments: { project: env.projectSlug, env: 'prod', surface: 'workspace', limit: 10 },
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      replays: [expect.objectContaining({ id: replayId, surface: 'workspace', status: 'recording' })],
    });
    const detail = await client.callTool({
      name: 'get_session_replay',
      arguments: { project: env.projectSlug, replay_id: replayId, env: 'prod' },
    });
    expect(detail.isError).not.toBe(true);
    expect(detail.structuredContent).toMatchObject({ id: replayId, viewer_path: `/experience?replay=${replayId}` });
    const serialized = JSON.stringify({ list: listed.structuredContent, detail: detail.structuredContent });
    expect(serialized).not.toContain('upload_token');
    expect(serialized).not.toContain('object_key');
    expect(serialized).not.toContain('events');
  });
});
