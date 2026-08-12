import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { activeMetric, api, createTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let foreign: TestEnv;
let mcp: Client;

const path = (scope: TestEnv, suffix = '') =>
  `/api/v1/projects/${scope.projectSlug}/data-health${suffix}`;

beforeAll(async () => {
  env = await createTestEnv({ ingestBuffer: false, queryCache: false });
  foreign = await createTestEnv({ ingestBuffer: false, queryCache: false });

  await activeMetric(env, {
    key: 'checkout_failed',
    type: 'count',
    source: { event: 'checkout.failed', filters: [] },
    purpose: 'Detect rejected checkout failure evidence before it corrupts a product answer.',
  });

  const historical = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await env.pool.query(
    `INSERT INTO events (
       project_id, env, event, "timestamp", distinct_id, session_id, properties,
       registered, ingested_at
     ) VALUES ($1, 'prod', 'checkout.failed', $2, 'historical-actor', NULL, '{}', true, $2)`,
    [env.projectId, historical],
  );

  await api(env, env.ingestToken, 'POST', '/i/v1/events', {
    events: [
      { event: 'checkout.failed', distinct_id: 'accepted-checkout' },
      { event: 'wild.thing', distinct_id: 'accepted-unregistered' },
      { event: 'checkout.failed' },
    ],
  });
  await env.pool.query(
    `INSERT INTO events (
       project_id, env, event, "timestamp", distinct_id, session_id, properties,
       registered, is_system, event_source, ingested_at
     ) VALUES ($1, 'prod', '$feature_flag_called', now(), 'system-actor', NULL, '{}', true, true, 'system', now())`,
    [env.projectId],
  );
  const rejectedSignature = await env.pool.query<{ signature_id: string }>(
    `UPDATE ingest_warnings
     SET count = count + 2, first_seen = now() - interval '48 hours'
     WHERE project_id = $1 AND env = 'prod' AND kind = 'rejected'
     RETURNING signature_id`,
    [env.projectId],
  );
  await env.pool.query(
    `INSERT INTO ingest_warning_occurrences (signature_id, bucket, count)
     VALUES ($1, date_trunc('hour', now() - interval '24 hours'), 2)`,
    [rejectedSignature.rows[0]!.signature_id],
  );
  const historicalSignature = await env.pool.query<{ signature_id: string }>(
    `INSERT INTO ingest_warnings (
       project_id, env, kind, event, detail, count, first_seen, last_seen
     ) VALUES (
       $1, 'prod', 'clock_skew', 'historical.clock', 'historical fixture', 1,
       now() - interval '72 hours', now() - interval '72 hours'
     )
     RETURNING signature_id`,
    [env.projectId],
  );
  await env.pool.query(
    `INSERT INTO ingest_warning_occurrences (signature_id, bucket, count)
     VALUES ($1, date_trunc('hour', now() - interval '72 hours'), 1)`,
    [historicalSignature.rows[0]!.signature_id],
  );

  await env.app.listen({ host: '127.0.0.1', port: 0 });
  const address = env.app.server.address();
  if (!address || typeof address === 'string') throw new Error('data-health test server did not bind');
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['--silent', '--dir', resolve(import.meta.dirname, '..'), 'mcp'],
    env: {
      ...process.env,
      POOLSTATIS_URL: `http://127.0.0.1:${address.port}`,
      POOLSTATIS_TOKEN: env.secretToken,
    },
    stderr: 'pipe',
  });
  mcp = new Client({ name: 'data-health-contract-test', version: '0.1.0' }, { capabilities: {} });
  await mcp.connect(transport);
});

afterAll(async () => {
  await mcp.close();
  await env.close();
  await foreign.close();
});

describe('project data-health control contract', () => {
  it('returns project/env-scoped accepted and rejected trends plus bounded privacy-safe signatures', async () => {
    const response = await api(env, env.secretToken, 'GET', path(env, '?env=prod'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      schema_version: 1,
      project: env.projectSlug,
      env: 'prod',
      summary: {
        accepted_24h: 2,
        rejected_24h: 1,
        accepted_7d: 3,
        rejected_7d: 3,
      },
      windows: {
        last_24h: { interval: 'hour', accepted_total: 2, rejected_total: 1 },
        last_7d: { interval: 'day', accepted_total: 3, rejected_total: 3 },
      },
    });
    expect(response.body.windows.last_24h.points).toHaveLength(24);
    expect(response.body.windows.last_7d.points).toHaveLength(7);
    expect(response.body.issue_signatures.length).toBeGreaterThanOrEqual(2);
    expect(response.body.issue_signatures.length).toBeLessThanOrEqual(20);

    const rejected = response.body.issue_signatures.find((issue: any) => issue.kind === 'rejected');
    expect(rejected).toMatchObject({
      signature_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      kind: 'rejected',
      category: 'schema_rejection',
      remediation: 'fix_schema',
      registered_event_name: 'checkout.failed',
      affected_answer_ids: expect.arrayContaining(['home']),
      repair_action: {
        kind: 'navigate',
        label: 'Inspect registered event',
        href: '/data?tab=events&event=checkout.failed',
      },
      watermark: { count: 3, last_seen: expect.any(String) },
      novelty: {
        state: 'recurring',
        basis: 'privacy-safe warning occurrences',
        current_window: { count: 1, from: expect.any(String), to: expect.any(String) },
        comparison_baseline: { count: 2, from: expect.any(String), to: expect.any(String) },
      },
      verify_after_fix: {
        method: 'POST',
        href: `/api/v1/projects/${env.projectSlug}/data-health/verify`,
      },
    });
    const unregistered = response.body.issue_signatures.find((issue: any) => issue.kind === 'unregistered');
    expect(unregistered.registered_event_name).toBeNull();
    expect(unregistered.repair_action.href).toContain(`signature=${encodeURIComponent(unregistered.signature_id)}`);
    expect(unregistered.novelty).toMatchObject({
      state: 'new',
      current_window: { count: 1 },
      comparison_baseline: { count: 0 },
    });
    const historical = response.body.issue_signatures.find((issue: any) => issue.registered_event_name === null && issue.kind === 'clock_skew');
    expect(historical.novelty).toMatchObject({
      state: 'historical',
      current_window: { count: 0 },
      comparison_baseline: { count: 0 },
    });

    const serialized = JSON.stringify(response.body.issue_signatures);
    for (const prohibited of ['detail', 'sample', 'distinct_id', 'properties', 'accepted-checkout']) {
      expect(serialized).not.toContain(prohibited);
    }
    expect(response.body.improvements.map((finding: any) => finding.signature_id)).toContain(rejected.signature_id);
    expect(response.body.improvements.map((finding: any) => finding.signature_id)).not.toContain(historical.signature_id);
    expect(response.body.doing_well).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'accepted_events_flowing' }),
    ]));

    const foreignRead = await api(foreign, foreign.secretToken, 'GET', path(foreign, '?env=prod'));
    expect(foreignRead.status).toBe(200);
    expect(foreignRead.body.summary).toEqual({
      accepted_24h: 0,
      rejected_24h: 0,
      accepted_7d: 0,
      rejected_7d: 0,
    });
    expect(foreignRead.body.issue_signatures).toEqual([]);
  });

  it('verifies a fix against the exact signature watermark and detects a later recurrence', async () => {
    const before = await api(env, env.secretToken, 'GET', path(env, '?env=prod'));
    const issue = before.body.issue_signatures.find((candidate: any) => candidate.kind === 'rejected');

    const resolved = await api(env, env.secretToken, 'POST', path(env, '/verify'), {
      env: 'prod',
      signature_id: issue.signature_id,
      watermark: issue.watermark,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      signature_id: issue.signature_id,
      status: 'resolved',
      occurrences_since_watermark: 0,
      checked_at: expect.any(String),
    });

    const forged = await api(env, env.secretToken, 'POST', path(env, '/verify'), {
      env: 'prod',
      signature_id: issue.signature_id,
      watermark: { ...issue.watermark, count: issue.watermark.count + 100 },
    });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe('invalid_data_health_watermark');

    await api(env, env.ingestToken, 'POST', '/i/v1/events', {
      events: [{ event: 'checkout.failed' }],
    });

    const recurring = await api(env, env.secretToken, 'POST', path(env, '/verify'), {
      env: 'prod',
      signature_id: issue.signature_id,
      watermark: issue.watermark,
    });
    expect(recurring.status).toBe(200);
    expect(recurring.body).toMatchObject({
      signature_id: issue.signature_id,
      status: 'still_occurring',
      occurrences_since_watermark: 1,
      current_watermark: { count: 4, last_seen: expect.any(String) },
    });

    const foreignVerify = await api(foreign, foreign.secretToken, 'POST', path(foreign, '/verify'), {
      env: 'prod',
      signature_id: issue.signature_id,
      watermark: issue.watermark,
    });
    expect(foreignVerify.status).toBe(404);
  });

  it('returns the same structured contract and verify read-back through MCP', async () => {
    const rest = await api(env, env.secretToken, 'GET', path(env, '?env=prod'));
    const mcpRead = await mcp.callTool({
      name: 'get_data_health',
      arguments: { project: env.projectSlug, env: 'prod' },
    });
    expect(mcpRead.isError).not.toBe(true);
    expect(mcpRead.structuredContent).toMatchObject({
      schema_version: 1,
      project: env.projectSlug,
      env: 'prod',
      summary: rest.body.summary,
    });
    const structured = mcpRead.structuredContent as typeof rest.body;
    const issue = structured.issue_signatures.find((candidate: any) => candidate.kind === 'rejected');
    expect(JSON.stringify(structured.issue_signatures)).not.toContain('distinct_id');
    expect(JSON.stringify(structured.issue_signatures)).not.toContain('sample');

    const verified = await mcp.callTool({
      name: 'verify_data_health_fix',
      arguments: {
        project: env.projectSlug,
        env: 'prod',
        signature_id: issue.signature_id,
        watermark: issue.watermark,
      },
    });
    expect(verified.isError).not.toBe(true);
    expect(verified.structuredContent).toMatchObject({
      schema_version: 1,
      signature_id: issue.signature_id,
      status: 'resolved',
      occurrences_since_watermark: 0,
    });
  });
});
