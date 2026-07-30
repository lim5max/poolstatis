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
      'register_experience_route', 'list_visual_experience_versions',
      'get_visual_experience_map', 'compare_visual_experience',
      'get_click_map', 'get_scroll_map',
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
        { kind: 'section_exposed', distinct_id: 'actor-1', session_id: 'session-1', route: 'checkout', sequence: 3, section: 'payment', top: 0.4 },
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
    const versions = await client.callTool({
      name: 'list_visual_experience_versions',
      arguments: { project: env.projectSlug, surface: 'checkout', env: 'prod' },
    });
    expect(versions.isError).not.toBe(true);
    expect(versions.structuredContent).toMatchObject({
      routes: [expect.objectContaining({ surface_key: 'checkout', key: 'checkout' })],
      snapshots: [],
    });

    const visual = await client.callTool({
      name: 'get_visual_experience_map',
      arguments: {
        project: env.projectSlug,
        query: {
          surface: 'checkout', route: 'checkout', version: 'unversioned',
          device: 'desktop', date_from: '-1d', env: 'prod', grid: 8,
        },
      },
    });
    expect(visual.isError).not.toBe(true);
    expect(visual.structuredContent).toMatchObject({
      kind: 'visual_experience',
      summary: { page_views: 1, clicks: 1 },
      sections: [{ section: 'payment', percentage: 100 }],
      snapshot: null,
      agent_context: {
        scope: {
          surface: 'checkout',
          route: 'checkout',
          version: 'unversioned',
          device: 'desktop',
          purpose: 'Understand why buyers hesitate before payment.',
        },
        click_concentration: [{
          label: 'pay_now',
          count: 1,
          percentage_of_all_clicks: 100,
        }],
        snapshot_coverage: { status: 'missing', exact_viewport_match: false },
        evidence_refs: [],
        data_quality: { status: 'limited' },
      },
    });

    const clickMap = await client.callTool({
      name: 'get_click_map',
      arguments: {
        project: env.projectSlug,
        query: {
          surface: 'checkout', route: 'checkout', version: 'unversioned',
          device: 'desktop', date_from: '-1d', env: 'prod', grid: 8,
        },
      },
    });
    expect(clickMap.isError).not.toBe(true);
    expect(clickMap.structuredContent).toMatchObject({
      kind: 'click_map',
      aggregation: 'unique_sessions',
      sample_size: { sessions: 1, click_events: 1 },
      cells: [expect.objectContaining({ sessions: 1, click_events: 1 })],
      truncated: false,
      no_data_reason: null,
    });

    const scrollMap = await client.callTool({
      name: 'get_scroll_map',
      arguments: {
        project: env.projectSlug,
        query: {
          surface: 'checkout', route: 'checkout', version: 'unversioned',
          device: 'desktop', date_from: '-1d', env: 'prod', grid: 8,
        },
      },
    });
    expect(scrollMap.isError).not.toBe(true);
    expect(scrollMap.structuredContent).toMatchObject({
      kind: 'scroll_map',
      aggregation: 'unique_sessions',
      sample_size: { sessions: 1 },
      truncated: false,
      no_data_reason: null,
    });

    const compared = await client.callTool({
      name: 'compare_visual_experience',
      arguments: {
        project: env.projectSlug,
        query: {
          surface: 'checkout',
          route: 'checkout',
          env: 'prod',
          baseline: { version: 'unversioned', device: 'desktop', date_from: '-1d' },
          comparison: { version: 'unversioned', device: 'desktop', date_from: '-1d' },
        },
      },
    });
    expect(compared.isError).not.toBe(true);
    expect(compared.structuredContent).toMatchObject({
      kind: 'visual_experience_compare',
      delta: { events: 0, page_views: 0, sessions: 0, clicks: 0, actors: 0 },
      agent_context: {
        sample_sizes: {
          baseline: { page_views: 1, sessions: 1, actors: 1, clicks: 1 },
          comparison: { page_views: 1, sessions: 1, actors: 1, clicks: 1 },
        },
        largest_section_changes: [{ section: 'payment', percentage_points: 0 }],
        evidence_refs: [],
        data_quality: { status: 'limited' },
        suggested_next_actions: [
          expect.objectContaining({ action: 'inspect_baseline_map', tool: 'get_visual_experience_map' }),
          expect.objectContaining({ action: 'inspect_comparison_map', tool: 'get_visual_experience_map' }),
        ],
      },
    });
    const afterReads = await env.pool.query<{ quantity: string }>(
      `SELECT COALESCE(sum(quantity), 0)::bigint AS quantity FROM usage_ledger WHERE project_id = $1`, [env.projectId],
    );
    expect(afterReads.rows[0]?.quantity).toBe(beforeReads.rows[0]?.quantity);
  });
});
