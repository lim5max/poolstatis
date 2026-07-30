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
  env = await createTestEnv({ ingestBuffer: false });
  await activeMetric(env, {
    key: 'legacy_feature_enabled',
    source: { event: 'feature.enabled' },
    purpose: 'Restores historical feature adoption from a trusted product database.',
  });
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  client = new Client(
    { name: 'poolstatis-event-management-test', version: '0.1.0' },
    { capabilities: {} },
  );
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

describe('event management MCP end to end', () => {
  it('exposes previewed backfill and audited revision tools', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'preview_event_backfill',
      'import_historical_events',
      'list_event_backfills',
      'preview_event_revision',
      'revise_event',
      'get_event_history',
    ]));

    const events = [{
      event: 'feature.enabled',
      timestamp: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      distinct_id: 'legacy-user-1',
      properties: { feature: 'automation' },
    }];
    const preview = await client.callTool({
      name: 'preview_event_backfill',
      arguments: { project: env.projectSlug, env: 'prod', events },
    });
    expect(preview.isError).not.toBe(true);
    const previewBody = preview.structuredContent as {
      valid: boolean;
      payload_sha256: string;
    };
    expect(previewBody.valid).toBe(true);

    const imported = await client.callTool({
      name: 'import_historical_events',
      arguments: {
        project: env.projectSlug,
        env: 'prod',
        batch_id: 'mcp-legacy-feature-part-001',
        reason: 'Backfill one trusted product database fixture through MCP.',
        expected_payload_sha256: previewBody.payload_sha256,
        events,
      },
    });
    expect(imported.isError).not.toBe(true);
    expect(imported.structuredContent).toMatchObject({ inserted: 1 });

    const sampled = await client.callTool({
      name: 'sample_events',
      arguments: { project: env.projectSlug, env: 'prod', event: 'feature.enabled' },
    });
    const event = (sampled.structuredContent as {
      events: Array<{ id: string; revision: number }>;
    }).events[0]!;
    expect(event.revision).toBe(1);

    const correctionPreview = await client.callTool({
      name: 'preview_event_revision',
      arguments: {
        project: env.projectSlug,
        env: 'prod',
        event_id: event.id,
        patch: { set_properties: { source: 'legacy_database' } },
      },
    });
    expect(correctionPreview.isError).not.toBe(true);
    expect(correctionPreview.structuredContent).toMatchObject({
      event_id: event.id,
      expected_revision: 1,
      preview_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      after: { revision: 2, properties: { feature: 'automation', source: 'legacy_database' } },
    });
    const correctionPreviewBody = correctionPreview.structuredContent as {
      expected_revision: number;
      preview_sha256: string;
    };

    const revised = await client.callTool({
      name: 'revise_event',
      arguments: {
        project: env.projectSlug,
        env: 'prod',
        event_id: event.id,
        expected_revision: correctionPreviewBody.expected_revision,
        expected_preview_sha256: correctionPreviewBody.preview_sha256,
        reason: 'Record the trusted source of the historical feature activation.',
        patch: { set_properties: { source: 'legacy_database' } },
      },
    });
    expect(revised.isError).not.toBe(true);
    expect(revised.structuredContent).toMatchObject({
      revision: { event_id: event.id, revision: 2 },
    });

    const history = await client.callTool({
      name: 'get_event_history',
      arguments: { project: env.projectSlug, env: 'prod', event_id: event.id },
    });
    expect(history.isError).not.toBe(true);
    expect(history.structuredContent).toMatchObject({
      event: { id: event.id, revision: 2 },
      revisions: [{ revision: 2 }],
    });
  });
});
