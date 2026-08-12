import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  activeMetric, api, createHumanReviewTestEnv,
  type HumanReviewTestEnv, type TestEnv,
} from '../helpers.js';

const DAY = 86_400_000;

describe('Milestone B product decision loop E2E', () => {
  let native: HumanReviewTestEnv;
  let external: HumanReviewTestEnv;
  let anchor: Date;
  let posthogHost: string;
  const posthog = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : null;
    routePostHog(req, res, body);
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => posthog.listen(0, '127.0.0.1', resolve));
    posthogHost = `http://127.0.0.1:${(posthog.address() as AddressInfo).port}`;
    native = await createHumanReviewTestEnv();
    external = await createHumanReviewTestEnv({ connectorEncryptionKey: 'decision-loop-b-e2e-encryption-key', outboundPolicy: { allowLocalHttp: true } });
    anchor = new Date(Date.now() - 4 * DAY);
  });

  afterAll(async () => {
    await native.close();
    await external.close();
    await new Promise<void>((resolve, reject) => posthog.close((error) => error ? reject(error) : resolve()));
  });

  test('native contract, release, evidence, query and human approval survive read-back and close onboarding', async () => {
    await observeAgent(native);
    await activeMetric(native, {
      key: 'activation_completed', type: 'unique_actors',
      purpose: 'Measures whether signed-up actors reach the first product value moment.',
      source: { event: 'activation.completed', filters: [] },
    });
    await ingestNativeEvidence(native, anchor);
    const declaration = contractDeclaration('native_activation_change', 'activation_completed');
    const contract = await applyContract(native, declaration);

    const query = await api(native, native.secretToken, 'POST', path(native, '/query'), {
      kind: 'trend', metric: 'activation_completed',
      date_from: new Date(anchor.getTime() - 3 * DAY).toISOString(),
      date_to: new Date(anchor.getTime() + 3 * DAY).toISOString(),
      interval: 'day', env: 'prod',
    });
    expect(query.status).toBe(200);
    expect(query.body.meta.source).toBe('native');

    const release = await registerRelease(native, 'native-release-e2e', 'native_activation_change', anchor);
    expect(release.contract_snapshot).toMatchObject({ key: contract.key });
    expect(release.contract_snapshot).not.toHaveProperty('revision');
    expect(release.contract_revision).toBe(1);
    const evaluated = await api(native, native.secretToken, 'POST', path(native, `/releases/${release.id}/evaluate`), {});
    expect(evaluated.status).toBe(201);
    expect(evaluated.body).toMatchObject({
      evidence: {
        source: 'native', ready: true, sample_size: 15,
        primary_evidence: { baseline: { value: 10 }, observed: { value: 15 }, change: { relative: 0.5 } },
        query_specs: { primary: { observed: { query: { kind: 'trend', metric: 'activation_completed' } } } },
      },
      decision: { proposed_outcome: 'keep', status: 'proposed' },
    });
    const approved = await approve(native, evaluated.body.decision.id);
    expect(approved).toMatchObject({
      decision: { accepted_outcome: 'keep', status: 'approved' },
      release: { status: 'decided' },
      revisions: [{ action: 'proposed' }, { action: 'approved' }],
    });

    const contractRead = await api(native, native.secretToken, 'GET', path(native, '/contracts/native_activation_change'));
    const releaseRead = await api(native, native.secretToken, 'GET', path(native, `/releases/${release.id}`));
    const decisionRead = await api(native, native.secretToken, 'GET', path(native, `/decisions/${evaluated.body.decision.id}`));
    const exported = await api(native, native.secretToken, 'GET', path(native, '/contracts/export'));
    expect(contractRead.body.revisions).toHaveLength(1);
    expect(releaseRead.body.revisions.map((revision: { action: string }) => revision.action)).toEqual(['registered', 'transitioned', 'transitioned']);
    expect(decisionRead.body.evidence.id).toBe(evaluated.body.evidence.id);
    expect(exported.body.yaml).toContain('native_activation_change');
    await expectOnboardingComplete(native, 'native', 'activation_completed', 'The measured activation improvement clears');
  });

  test('controlled PostHog follows the same loop without importing raw events', async () => {
    await observeAgent(external);
    const configured = await api(external, external.secretToken, 'POST', path(external, '/sources/posthog'), {
      name: 'controlled_product', host: posthogHost, project_id: '42', personal_api_key: 'phx_decision_loop_b_secret',
    });
    expect(configured.status).toBe(201);
    const sourceId = configured.body.id as string;
    const verified = await api(external, external.secretToken, 'POST', path(external, `/sources/posthog/${sourceId}/verify`), {});
    expect(verified.body.status).toBe('verified');
    await activeMetric(external, {
      key: 'external_activation', type: 'unique_actors',
      purpose: 'Measures activation in the existing product without importing raw PostHog events.',
      source: { data_source: 'posthog', source_connection_id: sourceId, event: 'activation.completed', filters: [] },
    });
    const declaration = contractDeclaration('external_activation_change', 'external_activation');
    await applyContract(external, declaration);
    const query = await api(external, external.secretToken, 'POST', path(external, '/query'), {
      kind: 'trend', metric: 'external_activation', date_from: '-7d', interval: 'day', env: 'prod',
    });
    expect(query.status).toBe(200);
    expect(query.body).toMatchObject({ meta: { source: 'posthog' }, series: [expect.objectContaining({ value: 15 })] });

    const release = await registerRelease(external, 'external-release-e2e', 'external_activation_change', anchor);
    const evaluated = await api(external, external.secretToken, 'POST', path(external, `/releases/${release.id}/evaluate`), {});
    expect(evaluated.status).toBe(201);
    expect(evaluated.body).toMatchObject({
      evidence: {
        source: 'posthog', ready: true, sample_size: 15,
        primary_evidence: { source: 'posthog', baseline: { value: 10 }, observed: { value: 15 }, change: { relative: 0.5 } },
      },
      decision: { proposed_outcome: 'keep' },
    });
    await approve(external, evaluated.body.decision.id);
    const local = await external.pool.query(
      `SELECT count(*)::int AS count FROM events
       WHERE project_id = (SELECT id FROM projects WHERE slug = $1)`,
      [external.projectSlug],
    );
    expect(local.rows[0].count).toBe(0);
    const detail = await api(external, external.secretToken, 'GET', path(external, `/decisions/${evaluated.body.decision.id}`));
    expect(detail.body.evidence.query_specs.primary.observed.query).toMatchObject({ metric: 'external_activation' });
    expect(JSON.stringify(detail.body)).not.toContain('phx_decision_loop_b_secret');
    await expectOnboardingComplete(external, 'posthog', 'external_activation', 'The measured activation improvement clears');
  });
});

function contractDeclaration(key: string, metricKey: string) {
  return { version: 1, contracts: [{
    key, name: key.replaceAll('_', ' '),
    business_hypothesis: 'Removing one setup step should increase first activation.',
    decision_owner: 'growth-team', primary_metric_key: metricKey,
    guardrail_metric_keys: [], target_filters: [], baseline_window_days: 3,
    observation_window_days: 3, minimum_sample_size: 5,
    expected_direction: 'increase', minimum_meaningful_effect: 0.1,
    references: { issue_url: 'https://example.com/issues/42' }, status: 'active',
  }] };
}

async function applyContract(env: TestEnv, declaration: ReturnType<typeof contractDeclaration>) {
  const validated = await api(env, env.secretToken, 'POST', path(env, '/contracts/validate'), declaration);
  expect(validated.body).toMatchObject({ valid: true, issues: [] });
  const diff = await api(env, env.secretToken, 'POST', path(env, '/contracts/diff'), declaration);
  const applied = await api(env, env.secretToken, 'POST', path(env, '/contracts/apply'), {
    declaration, expected_revision: diff.body.expected_revision,
  });
  expect(applied.status).toBe(200);
  return applied.body.contracts[0];
}

async function registerRelease(env: TestEnv, idempotencyKey: string, contractKey: string, deployedAt: Date) {
  const response = await api(env, env.secretToken, 'POST', path(env, '/releases'), {
    idempotency_key: idempotencyKey, contract_key: contractKey, env: 'prod',
    repository: 'acme/product', branch: 'main', commit_sha: 'd'.repeat(40),
    pr_url: 'https://example.com/acme/product/pull/42',
    deployed_at: deployedAt.toISOString(), status: 'deployed',
  });
  expect(response.status).toBe(201);
  return response.body;
}

async function approve(env: HumanReviewTestEnv, decisionId: string) {
  const response = await api(env, env.ownerToken, 'POST', path(env, `/decisions/${decisionId}/approve`), {
    rationale: 'The measured activation improvement clears the declared threshold with trusted evidence.',
  });
  expect(response.status).toBe(200);
  return response.body;
}

async function ingestNativeEvidence(env: TestEnv, anchor: Date) {
  const events: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 10; index++) events.push({
    event: 'activation.completed', distinct_id: `native-baseline-${index}`,
    timestamp: new Date(anchor.getTime() - DAY).toISOString(), properties: {},
  });
  for (let index = 0; index < 15; index++) events.push({
    event: 'activation.completed', distinct_id: `native-observed-${index}`,
    timestamp: new Date(anchor.getTime() + DAY).toISOString(), properties: {},
  });
  const response = await api(env, env.ingestToken, 'POST', '/i/v1/events', { batch_id: 'decision-loop-b-native', events });
  expect(response.status).toBe(200);
}

async function observeAgent(env: TestEnv) {
  const response = await env.app.inject({
    method: 'POST', url: path(env, '/onboarding/observe-agent'),
    headers: { authorization: `Bearer ${env.secretToken}`, 'x-poolstatis-client': 'mcp' },
    payload: { client: 'decision-loop-b-e2e', env: 'prod' },
  });
  expect(response.statusCode).toBe(200);
}

async function expectOnboardingComplete(env: TestEnv, source: 'native' | 'posthog', metricKey: string, rationale: string) {
  const status = await api(env, env.secretToken, 'GET', path(env, '/onboarding/status?env=prod'));
  expect(status.status).toBe(200);
  expect(status.body.complete).toBe(true);
  expect(status.body.gates.every((gate: { complete: boolean }) => gate.complete)).toBe(true);
  expect(status.body.final_result).toMatchObject({ metric_key: metricKey, source });
  expect(status.body.final_result.next_action).toContain(rationale);
}

function path(env: TestEnv, suffix: string) {
  return `/api/v1/projects/${env.projectSlug}${suffix}`;
}

function routePostHog(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown> | null) {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== 'Bearer phx_decision_loop_b_secret') {
    res.statusCode = 401; res.end(JSON.stringify({ detail: 'wrong credential' })); return;
  }
  if (req.url === '/api/projects/42/query/' && req.method === 'POST') {
    if (body?.name === 'poolstatis_connection_verify') {
      res.end(JSON.stringify({ columns: ['ok'], results: [[1]] })); return;
    }
    if (body?.name === 'poolstatis_trend_external_activation') {
      res.end(JSON.stringify({ columns: ['bucket', 'value'], results: [[new Date().toISOString(), 15]] })); return;
    }
    if (body?.name === 'poolstatis_evaluate_external_activation_baseline') {
      res.end(JSON.stringify({ columns: ['value', 'events', 'actors', 'raw_actors', 'identified_events'], results: [[10, 10, 10, 10, 10]] })); return;
    }
    if (body?.name === 'poolstatis_evaluate_external_activation_observed') {
      res.end(JSON.stringify({ columns: ['value', 'events', 'actors', 'raw_actors', 'identified_events'], results: [[15, 15, 15, 15, 15]] })); return;
    }
  }
  res.statusCode = 404; res.end(JSON.stringify({ detail: 'fixture route not found' }));
}
