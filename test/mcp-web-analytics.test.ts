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
      arguments: {
        project: env.projectSlug,
        route_keys: ['home', 'pricing'],
      },
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

    const ingested = await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        {
          event: 'page.viewed',
          distinct_id: 'mcp-actor',
          session_id: 'mcp-session',
          timestamp: '2026-07-30T12:00:00.000Z',
          properties: {
            $browser_context: '1', $route_key: 'home', $page_view_id: 'mcp-page',
          },
        },
        {
          event: 'page.engagement',
          distinct_id: 'mcp-actor',
          session_id: 'mcp-session',
          timestamp: '2026-07-30T12:00:10.000Z',
          properties: {
            $browser_context: '1', $route_key: 'home', $page_view_id: 'mcp-page',
            sequence: 1, foreground_ms: 10_000, elapsed_ms: 10_000,
            max_scroll_pct: 50, interaction_count: 1, reason: 'pagehide',
          },
        },
      ],
    });
    expect(ingested.body.accepted).toBe(2);
    const window = {
      metric: 'web_page_views',
      date_from: '2026-07-30T11:00:00.000Z',
      date_to: '2026-07-30T13:00:00.000Z',
    };
    const restSessions = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      { kind: 'web_sessions', ...window, limit: 10 },
    );
    const mcpSessions = await client.callTool({
      name: 'list_web_sessions',
      arguments: { project: env.projectSlug, query: { ...window, limit: 10 } },
    });
    expect(mcpSessions.structuredContent).toMatchObject({
      sessions: restSessions.body.sessions,
      meta: { total: restSessions.body.meta.total },
    });

    const restSession = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      {
        kind: 'web_session',
        ...window,
        session_id: 'mcp-session',
        actor_id: 'mcp-actor',
        page_limit: 10,
      },
    );
    const mcpSession = await client.callTool({
      name: 'get_web_session',
      arguments: {
        project: env.projectSlug,
        query: {
          ...window,
          session_id: 'mcp-session',
          actor_id: 'mcp-actor',
          page_limit: 10,
        },
      },
    });
    expect(mcpSession.structuredContent).toMatchObject({
      summary: restSession.body.summary,
      pages: restSession.body.pages,
    });
    const mcpEngagement = await client.callTool({
      name: 'get_session_engagement',
      arguments: {
        project: env.projectSlug,
        query: {
          ...window,
          session_id: 'mcp-session',
          actor_id: 'mcp-actor',
          page_limit: 10,
        },
      },
    });
    expect(mcpEngagement.structuredContent).toMatchObject({
      summary: restSession.body.summary,
      pages: restSession.body.pages,
    });

    const restPage = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      {
        kind: 'page_engagement',
        ...window,
        page_view_id: 'mcp-page',
        actor_id: 'mcp-actor',
        session_id: 'mcp-session',
      },
    );
    const mcpPage = await client.callTool({
      name: 'get_page_engagement',
      arguments: {
        project: env.projectSlug,
        query: {
          ...window,
          page_view_id: 'mcp-page',
          actor_id: 'mcp-actor',
          session_id: 'mcp-session',
        },
      },
    });
    expect(mcpPage.structuredContent).toMatchObject({ page: restPage.body.page });

    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [
        {
          event: 'page.viewed',
          distinct_id: 'mcp-other-actor',
          session_id: 'mcp-session',
          timestamp: '2026-07-30T12:01:00.000Z',
          properties: {
            $browser_context: '1', $route_key: 'pricing', $page_view_id: 'mcp-other-page',
          },
        },
        {
          event: 'page.viewed',
          distinct_id: 'mcp-other-actor',
          session_id: 'mcp-other-session',
          timestamp: '2026-07-30T12:02:00.000Z',
          properties: {
            $browser_context: '1', $route_key: 'pricing', $page_view_id: 'mcp-page',
          },
        },
      ],
    });
    const restAmbiguousSession = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      { kind: 'web_session', ...window, session_id: 'mcp-session' },
    );
    const mcpAmbiguousSession = await client.callTool({
      name: 'get_web_session',
      arguments: {
        project: env.projectSlug,
        query: { ...window, session_id: 'mcp-session' },
      },
    });
    expect(restAmbiguousSession.body.error.code).toBe('web_session_actor_ambiguous');
    expect(mcpAmbiguousSession.isError).toBe(true);
    expect(JSON.stringify(mcpAmbiguousSession.content)).toContain('web_session_actor_ambiguous');

    const restAmbiguousPage = await api(
      env,
      env.secretToken,
      'POST',
      `/api/v1/projects/${env.projectSlug}/query`,
      { kind: 'page_engagement', ...window, page_view_id: 'mcp-page' },
    );
    const mcpAmbiguousPage = await client.callTool({
      name: 'get_page_engagement',
      arguments: {
        project: env.projectSlug,
        query: { ...window, page_view_id: 'mcp-page' },
      },
    });
    expect(restAmbiguousPage.body.error.code).toBe('page_engagement_actor_ambiguous');
    expect(mcpAmbiguousPage.isError).toBe(true);
    expect(JSON.stringify(mcpAmbiguousPage.content)).toContain('page_engagement_actor_ambiguous');
  });
});
