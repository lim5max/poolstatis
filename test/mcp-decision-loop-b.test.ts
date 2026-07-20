import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

describe('measurement contract to approved decision over MCP', () => {
  let env: TestEnv;
  let client: Client;
  let deployedAt: Date;

  beforeAll(async () => {
    env = await createTestEnv();
    deployedAt = new Date(Date.now() - 4 * DAY);
    await activeMetric(env, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    const events: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 10; index++) {
      events.push({
        event: 'activation.completed', distinct_id: `mcp-base-${index}`,
        timestamp: new Date(deployedAt.getTime() - DAY).toISOString(), properties: {},
      });
    }
    for (let index = 0; index < 15; index++) {
      events.push({
        event: 'activation.completed', distinct_id: `mcp-observed-${index}`,
        timestamp: new Date(deployedAt.getTime() + DAY).toISOString(), properties: {},
      });
    }
    await api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'mcp-b-evidence', events });
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    const address = env.app.server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const transport = new StdioClientTransport({
      command: 'pnpm', args: ['--silent', '--dir', repoDir, 'mcp'],
      env: {
        ...process.env,
        POOLSTATIS_URL: `http://127.0.0.1:${address.port}`,
        POOLSTATIS_TOKEN: env.secretToken,
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'decision-loop-b-e2e', version: '0.1.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    await env.close();
  });

  test('validates, diffs, applies, releases, evaluates and approves with REST-equivalent read-back', async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'validate_measurement_contracts', 'diff_measurement_contracts',
      'apply_measurement_contracts', 'export_measurement_contracts',
      'register_release', 'list_releases', 'get_release', 'evaluate_release',
      'list_decisions', 'get_decision', 'approve_decision', 'reject_decision',
    ]));
    const declaration = {
      version: 1,
      contracts: [{
        key: 'mcp_onboarding_change', name: 'MCP onboarding change',
        business_hypothesis: 'Removing one setup step should increase first activation.',
        decision_owner: 'growth-team', primary_metric_key: 'activation_completed',
        guardrail_metric_keys: [], target_filters: [], baseline_window_days: 3,
        observation_window_days: 3, minimum_sample_size: 5,
        expected_direction: 'increase', minimum_meaningful_effect: 0.1,
        references: { issue_url: 'https://example.com/issues/42' }, status: 'active',
      }],
    };
    const validated = await client.callTool({
      name: 'validate_measurement_contracts', arguments: { project: env.projectSlug, declaration },
    });
    expect(validated.structuredContent).toMatchObject({ valid: true, issues: [] });
    const diff = await client.callTool({
      name: 'diff_measurement_contracts', arguments: { project: env.projectSlug, declaration },
    });
    const expectedRevision = String((diff.structuredContent as { expected_revision: string }).expected_revision);
    expect(diff.structuredContent).toMatchObject({
      changes: [expect.objectContaining({ key: 'mcp_onboarding_change', operation: 'create' })],
    });
    const applied = await client.callTool({
      name: 'apply_measurement_contracts',
      arguments: { project: env.projectSlug, declaration, expected_revision: expectedRevision },
    });
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({ applied: true });

    const exported = await client.callTool({
      name: 'export_measurement_contracts', arguments: { project: env.projectSlug },
    });
    expect(exported.structuredContent).toMatchObject({ filename: 'poolstatis.yml' });
    expect(String((exported.structuredContent as { yaml: string }).yaml)).toContain('mcp_onboarding_change');

    const registered = await client.callTool({
      name: 'register_release',
      arguments: {
        project: env.projectSlug,
        release: {
          idempotency_key: 'mcp-deploy-1', contract_key: 'mcp_onboarding_change',
          env: 'prod', repository: 'acme/product', branch: 'main',
          commit_sha: 'c'.repeat(40), deployed_at: deployedAt.toISOString(), status: 'deployed',
        },
      },
    });
    expect(registered.isError).not.toBe(true);
    const releaseId = String((registered.structuredContent as { id: string }).id);
    const evaluated = await client.callTool({
      name: 'evaluate_release', arguments: { project: env.projectSlug, id: releaseId },
    });
    expect(evaluated.structuredContent).toMatchObject({
      evidence: { ready: true, sample_size: 15 },
      decision: { proposed_outcome: 'keep', status: 'proposed' },
    });
    const decisionId = String((evaluated.structuredContent as { decision: { id: string } }).decision.id);
    const approved = await client.callTool({
      name: 'approve_decision',
      arguments: {
        project: env.projectSlug, id: decisionId,
        rationale: 'The real activation lift clears the contract threshold with trusted evidence.',
      },
    });
    expect(approved.structuredContent).toMatchObject({
      decision: { id: decisionId, status: 'approved', accepted_outcome: 'keep' },
      release: { id: releaseId, status: 'decided' },
    });

    const releases = await client.callTool({
      name: 'list_releases', arguments: { project: env.projectSlug, env: 'prod' },
    });
    expect(releases.structuredContent).toMatchObject({
      releases: [expect.objectContaining({ id: releaseId, contract_revision: 1 })],
    });
    const decision = await client.callTool({
      name: 'get_decision', arguments: { project: env.projectSlug, id: decisionId },
    });
    const rest = await api(env, env.secretToken, 'GET', `/api/v1/projects/${env.projectSlug}/decisions/${decisionId}`);
    expect(decision.structuredContent).toMatchObject(rest.body);
  });
});
