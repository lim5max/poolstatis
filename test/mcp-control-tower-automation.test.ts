import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
  await activeMetric(env, { key: 'agent_activation', source: { event: 'agent.activation', filters: [] } });
  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  client = new Client({ name: 'control-tower-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: 'pnpm', args: ['--silent', '--dir', repoDir, 'mcp'], stderr: 'pipe',
    env: { ...process.env, POOLSTATIS_URL: `http://127.0.0.1:${address.port}`, POOLSTATIS_TOKEN: env.secretToken },
  }));
});
afterAll(async () => { await client.close(); await env.close(); });

describe('control tower automation MCP parity', () => {
  test('configures and reads server-backed monitors and feed schedules', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'get_automation_capabilities', 'create_notification_destination', 'list_notification_destinations', 'set_notification_destination_status',
      'create_monitor_policy', 'list_monitor_policies', 'update_monitor_policy', 'set_monitor_policy_status',
      'create_insight_feed_schedule', 'list_insight_feed_schedules', 'update_insight_feed_schedule',
      'set_insight_feed_schedule_status', 'list_monitor_findings', 'list_insight_feed_snapshots',
      'list_automation_proposals', 'approve_automation_proposal', 'reject_automation_proposal',
      'list_automation_inbox', 'list_notification_deliveries',
    ]));
    const destination = await client.callTool({
      name: 'create_notification_destination',
      arguments: { project: env.projectSlug, destination: { key: 'agent_outbox', name: 'Agent outbox', kind: 'outbox' } },
    });
    const destinationId = String((destination.structuredContent as { id: string }).id);
    const monitor = await client.callTool({
      name: 'create_monitor_policy',
      arguments: { project: env.projectSlug, policy: {
        policy_key: 'agent_activation_drop', name: 'Agent activation drop', env: 'prod',
        target_kind: 'project', target_id: null, metric_key: 'agent_activation',
        comparison_rule: 'change_down_percent', threshold: 20, minimum_sample: 10,
        window_minutes: 1440, cadence_minutes: 60, cooldown_seconds: 3600,
        owner: 'agent-ops', destination_ids: [destinationId], proposal_kind: null, proposal_target: null,
      } },
    });
    expect(monitor.isError).not.toBe(true);
    expect(monitor.structuredContent).toMatchObject({ policy_key: 'agent_activation_drop', current_version: 1 });
    const schedules = await client.callTool({ name: 'list_insight_feed_schedules', arguments: { project: env.projectSlug } });
    expect(schedules.structuredContent).toEqual({ schedules: [] });
  });
});
