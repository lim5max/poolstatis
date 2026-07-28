import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv, type TestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('decision-loop trust MCP tools', () => {
  let env: TestEnv;
  let client: Client;
  let upstreamHost: string;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    routePostHogFixture(req, res, chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      : null);
  });

  beforeAll(async () => {
    await new Promise<void>((resolveListen) => upstream.listen(0, '127.0.0.1', resolveListen));
    upstreamHost = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    env = await createTestEnv({ connectorEncryptionKey: 'mcp-decision-loop-test-key', outboundPolicy: { allowLocalHttp: true } });
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
    client = new Client({ name: 'decision-loop-e2e', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    await env.close();
    await new Promise<void>((resolveClose, reject) => upstream.close((error) => {
      if (error) reject(error);
      else resolveClose();
    }));
  });

  test('exposes and executes identity, property, source and proof-onboarding operations', async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'get_onboarding_status',
      'create_actor_link',
      'list_actor_links',
      'revoke_actor_link',
      'register_property',
      'list_properties',
      'propose_acquisition_properties',
      'propose_browser_analytics',
      'query_web_analytics',
      'get_web_overview',
      'list_web_sessions',
      'get_web_session',
      'get_session_engagement',
      'get_page_engagement',
      'assess_measurement_trust',
      'update_property',
      'configure_posthog',
      'verify_posthog',
      'get_posthog_schema',
    ]));
    const onboardingTool = tools.tools.find((tool) => tool.name === 'get_onboarding_status');
    expect(onboardingTool?.description).toContain('MCP-marked request');
    expect(onboardingTool?.description).not.toContain('proves');
    expect(onboardingTool?.description).not.toContain('connected');

    const onboarding = await client.callTool({
      name: 'get_onboarding_status',
      arguments: { project: env.projectSlug, env: 'prod' },
    });
    expect(onboarding.isError).not.toBe(true);
    expect(onboarding.structuredContent).toMatchObject({
      complete: false,
      gates: expect.arrayContaining([
        expect.objectContaining({ key: 'agent_connected', complete: true }),
      ]),
    });

    const createdLink = await client.callTool({
      name: 'create_actor_link',
      arguments: {
        project: env.projectSlug,
        link: { source_distinct_id: 'anonymous-1', target_distinct_id: 'user-1', env: 'prod' },
      },
    });
    expect(createdLink.isError).not.toBe(true);
    expect(createdLink.structuredContent).toMatchObject({ status: 'active' });
    const linkId = String((createdLink.structuredContent as { id: string }).id);

    const links = await client.callTool({
      name: 'list_actor_links',
      arguments: { project: env.projectSlug, env: 'prod' },
    });
    expect(links.structuredContent).toMatchObject({
      links: [expect.objectContaining({ id: linkId, target_distinct_id: 'user-1' })],
      audit: [expect.objectContaining({ action: 'created' })],
    });

    const revoked = await client.callTool({
      name: 'revoke_actor_link',
      arguments: { project: env.projectSlug, id: linkId },
    });
    expect(revoked.structuredContent).toMatchObject({ id: linkId, status: 'revoked' });

    const property = await client.callTool({
      name: 'register_property',
      arguments: {
        project: env.projectSlug,
        property: {
          key: 'plan', scope: 'event', value_type: 'string',
          purpose: 'Segments conversion evidence by the commercial plan selected.',
        },
      },
    });
    expect(property.isError).not.toBe(true);
    expect(property.structuredContent).toMatchObject({ key: 'plan', status: 'proposed' });

    const updatedProperty = await client.callTool({
      name: 'update_property',
      arguments: {
        project: env.projectSlug, scope: 'event', key: 'plan', patch: { status: 'trusted' },
      },
    });
    expect(updatedProperty.structuredContent).toMatchObject({ key: 'plan', status: 'trusted' });

    const properties = await client.callTool({
      name: 'list_properties',
      arguments: { project: env.projectSlug, status: 'trusted' },
    });
    expect(properties.structuredContent).toMatchObject({
      properties: [expect.objectContaining({ key: 'plan', status: 'trusted' })],
    });

    const acquisition = await client.callTool({
      name: 'propose_acquisition_properties',
      arguments: { project: env.projectSlug },
    });
    expect(acquisition.isError).not.toBe(true);
    expect(acquisition.structuredContent).toMatchObject({
      properties: expect.arrayContaining([expect.objectContaining({ key: '$utm_source', status: 'proposed' })]),
    });

    const browser = await client.callTool({
      name: 'propose_browser_analytics',
      arguments: { project: env.projectSlug },
    });
    expect(browser.isError).not.toBe(true);
    expect(browser.structuredContent).toMatchObject({
      properties: expect.arrayContaining([expect.objectContaining({ key: '$country', status: 'proposed' })]),
      metrics: expect.arrayContaining([expect.objectContaining({ key: 'web_page_views', status: 'proposed' })]),
    });
    const activatedBrowserMetric = await client.callTool({
      name: 'update_metric',
      arguments: {
        project: env.projectSlug,
        key: 'web_page_views',
        patch: { status: 'active' },
      },
    });
    expect(activatedBrowserMetric.isError).not.toBe(true);
    expect(activatedBrowserMetric.structuredContent).toMatchObject({
      key: 'web_page_views',
      status: 'active',
    });
    const traffic = await client.callTool({
      name: 'query_web_analytics',
      arguments: {
        project: env.projectSlug,
        query: { metric: 'web_page_views', date_from: '-1d', dimensions: ['country', 'device'] },
      },
    });
    expect(traffic.isError).not.toBe(true);
    expect(traffic.structuredContent).toMatchObject({
      kind: 'web_analytics',
      summary: { visitors: 0, sessions: 0, page_views: 0 },
      engagement: {
        measured_sessions: 0,
        incomplete_sessions: 0,
        unknown_sessions: 0,
        measured_session_coverage: null,
        engaged_rate: null,
        bounce_rate: null,
        timed_page_coverage: null,
      },
      meta: { definitions: expect.any(Object), privacy: expect.stringContaining('Raw IP') },
    });
    const overview = await client.callTool({
      name: 'get_web_overview',
      arguments: {
        project: env.projectSlug,
        query: { metric: 'web_page_views', date_from: '-1d', dimensions: ['country'] },
      },
    });
    expect(overview.isError).not.toBe(true);
    expect(overview.structuredContent).toMatchObject({
      kind: 'web_analytics',
      engagement: { measured_sessions: 0, incomplete_sessions: 0 },
    });

    const sessions = await client.callTool({
      name: 'list_web_sessions',
      arguments: {
        project: env.projectSlug,
        query: { metric: 'web_page_views', date_from: '-1d', limit: 10 },
      },
    });
    expect(sessions.isError).not.toBe(true);
    expect(sessions.structuredContent).toMatchObject({
      kind: 'web_sessions',
      sessions: [],
      meta: { total: 0, truncated: false },
    });

    for (const name of ['get_web_session', 'get_session_engagement'] as const) {
      const session = await client.callTool({
        name,
        arguments: {
          project: env.projectSlug,
          query: { metric: 'web_page_views', session_id: 'missing-session', date_from: '-1d' },
        },
      });
      expect(session.isError).not.toBe(true);
      expect(session.structuredContent).toMatchObject({
        kind: 'web_session',
        summary: null,
        pages: [],
        meta: { no_data_reason: expect.any(String) },
      });
    }

    const page = await client.callTool({
      name: 'get_page_engagement',
      arguments: {
        project: env.projectSlug,
        query: { metric: 'web_page_views', page_view_id: 'missing-page', date_from: '-1d' },
      },
    });
    expect(page.isError).not.toBe(true);
    expect(page.structuredContent).toMatchObject({
      kind: 'page_engagement',
      page: null,
      meta: { no_data_reason: expect.any(String) },
    });

    const browserStandard = await client.readResource({ uri: 'poolstatis://standard/browser-analytics' });
    expect(browserStandard.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect((browserStandard.contents[0] as { text: string }).text).toContain('Visitors: unique query-time resolved actors');

    const configured = await client.callTool({
      name: 'configure_posthog',
      arguments: {
        project: env.projectSlug,
        connection: {
          name: 'design_partner', host: upstreamHost, project_id: '42',
          personal_api_key: 'phx_controlled_secret',
        },
      },
    });
    expect(configured.isError).not.toBe(true);
    expect(JSON.stringify(configured.structuredContent)).not.toContain('phx_controlled_secret');
    const sourceId = String((configured.structuredContent as { id: string }).id);

    const verified = await client.callTool({
      name: 'verify_posthog',
      arguments: { project: env.projectSlug, id: sourceId },
    });
    expect(verified.structuredContent).toMatchObject({ id: sourceId, status: 'verified' });

    const schema = await client.callTool({
      name: 'get_posthog_schema',
      arguments: { project: env.projectSlug, id: sourceId },
    });
    expect(schema.structuredContent).toMatchObject({
      events: [{ name: 'signup.completed' }],
      properties: [{ name: 'plan', scope: 'event', value_type: 'string' }],
    });
  });
});

function routePostHogFixture(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown> | null,
): void {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/projects/42/query/' && req.method === 'POST'
      && body?.name === 'poolstatis_connection_verify') {
    res.end(JSON.stringify({ columns: ['ok'], results: [[1]] }));
    return;
  }
  if (req.url === '/api/projects/42/event_definitions/?limit=100') {
    res.end(JSON.stringify({ results: [{ name: 'signup.completed' }] }));
    return;
  }
  if (req.url === '/api/projects/42/property_definitions/?limit=100') {
    res.end(JSON.stringify({ results: [{ name: 'plan', property_type: 'String', type: 'event' }] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ detail: 'fixture route not found' }));
}
