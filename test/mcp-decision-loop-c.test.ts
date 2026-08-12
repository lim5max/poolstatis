import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { activeMetric, api, createHumanReviewTestEnv, type HumanReviewTestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

describe('continuous decision loop MCP parity', () => {
  let env: HumanReviewTestEnv;
  let client: Client;
  let decisionId: string;
  let declaration: Record<string, unknown>;

  beforeAll(async () => {
    env = await createHumanReviewTestEnv({ connectorEncryptionKey: 'mcp-c-encryption-key-controlled' });
    const anchor = new Date(Date.now() - 3 * DAY);
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    declaration = { version: 1, contracts: [{
      key: 'mcp_continuous_change', name: 'MCP continuous change',
      business_hypothesis: 'The deployed change should increase first activation.',
      decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
      guardrail_metric_keys: [], target_filters: [], baseline_window_days: 1,
      observation_window_days: 1, minimum_sample_size: 2,
      expected_direction: 'increase', minimum_meaningful_effect: 0.1,
      references: {}, status: 'active',
    }] };
    const diff = await api(env, env.secretToken, 'POST', path('/contracts/diff'), declaration);
    await api(env, env.secretToken, 'POST', path('/contracts/apply'), { declaration, expected_revision: diff.body.expected_revision });
    await api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'mcp-c-evidence', events: [
      { event: 'activation.completed', distinct_id: 'base-1', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'base-2', timestamp: new Date(anchor.getTime() - 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-1', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-2', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
      { event: 'activation.completed', distinct_id: 'obs-3', timestamp: new Date(anchor.getTime() + 12 * 3600_000).toISOString(), properties: {} },
    ] });
    const release = await api(env, env.secretToken, 'POST', path('/releases'), {
      idempotency_key: 'mcp-c-release', contract_key: 'mcp_continuous_change', env: 'prod',
      repository: 'acme/product', commit_sha: 'c'.repeat(40), deployed_at: anchor.toISOString(), status: 'deployed',
    });
    const evaluated = await api(env, env.secretToken, 'POST', path(`/releases/${release.body.id}/evaluate`), {});
    decisionId = evaluated.body.decision.id;
    await api(env, env.ownerToken, 'POST', path(`/decisions/${decisionId}/approve`), {
      rationale: 'The trusted activation evidence clears the declared threshold.',
    });
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    const address = env.app.server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const transport = new StdioClientTransport({
      command: 'pnpm', args: ['--silent', '--dir', repoDir, 'mcp'],
      env: { ...process.env, POOLSTATIS_URL: `http://127.0.0.1:${address.port}`, POOLSTATIS_TOKEN: env.secretToken },
      stderr: 'pipe',
    });
    client = new Client({ name: 'decision-loop-c-test', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => { await client.close(); await env.close(); });

  test('explain is action-free, reads equal REST, actions audit MCP actor, and memory stays scoped', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'explain_outcome', 'prepare_action', 'approve_action', 'get_decision_inbox',
      'configure_webhook', 'verify_webhook', 'search_decision_history', 'find_similar_changes',
    ]));
    const before = await env.pool.query('SELECT count(*)::int AS count FROM decision_actions');
    const explained = await client.callTool({ name: 'explain_outcome', arguments: { project: env.projectSlug, id: decisionId } });
    expect(explained.isError).not.toBe(true);
    expect(explained.structuredContent).toMatchObject({ label: 'hypothesis' });
    const after = await env.pool.query('SELECT count(*)::int AS count FROM decision_actions');
    expect(after.rows[0].count).toBe(before.rows[0].count);
    const restExplanation = await api(env, env.secretToken, 'GET', path(`/decisions/${decisionId}/explanations`));
    expect(explained.structuredContent).toMatchObject(restExplanation.body.explanations[0]);

    const prepared = await client.callTool({
      name: 'prepare_action', arguments: {
        project: env.projectSlug, decision_id: decisionId,
        action: {
          action_type: 'draft_implementation_prompt', idempotency_key: 'mcp-c-prompt',
          target: { repository: 'acme/product' },
          payload: { prompt: 'Draft the smallest measurable follow-up implementation from this evidence.' },
          expected_effect: 'Produce a reviewable implementation prompt without changing code or production state.',
        },
      },
    });
    const action = (prepared.structuredContent as { action: { id: string; confirmation_fingerprint: string } }).action;
    const denied = await client.callTool({
      name: 'approve_action', arguments: { project: env.projectSlug, id: action.id, confirmation_fingerprint: action.confirmation_fingerprint },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toContain('human_user_required');
    const unchangedAction = await api(env, env.secretToken, 'GET', path(`/actions/${action.id}`));
    expect(unchangedAction.body.action).toMatchObject({ status: 'prepared', approved_by: null });

    const inbox = await client.callTool({ name: 'get_decision_inbox', arguments: { project: env.projectSlug } });
    const restInbox = await api(env, env.secretToken, 'GET', path('/decision-inbox'));
    expect(inbox.structuredContent).toEqual(restInbox.body);
    const history = await client.callTool({ name: 'search_decision_history', arguments: { project: env.projectSlug, metric: 'activation_completed' } });
    expect(history.structuredContent).toMatchObject({ items: [expect.objectContaining({ decision_id: decisionId })] });
    const similar = await client.callTool({ name: 'find_similar_changes', arguments: { project: env.projectSlug, declaration } });
    expect(similar.structuredContent).toMatchObject({ changes: [expect.objectContaining({ decision_id: decisionId })] });
  });

  test('configures write-only webhook data and queues a distinct verification delivery', async () => {
    const configured = await client.callTool({
      name: 'configure_webhook', arguments: {
        project: env.projectSlug,
        destination: { name: 'mcp_ops', url: 'https://example.com/poolstatis-hook', authorization: 'Bearer mcp-secret' },
      },
    });
    expect(configured.isError).not.toBe(true);
    expect(JSON.stringify(configured.structuredContent)).not.toContain('mcp-secret');
    const id = String((configured.structuredContent as { id: string }).id);
    const verified = await client.callTool({ name: 'verify_webhook', arguments: { project: env.projectSlug, id } });
    expect(verified.structuredContent).toMatchObject({ status: 'pending', event_type: 'poolstatis.webhook.test' });
  });

  function path(suffix: string) { return `/api/v1/projects/${env.projectSlug}${suffix}`; }
});
